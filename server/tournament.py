"""MiniCodeWars 007 Tournament Engine.

Implements the tournament system specification (tournament.md):
- Swiss stage (6 rounds) with score bracket pairing, rematch avoidance & backtracking
- Best of 5 (Swiss, Ro32, Ro16, Ro8) and Best of 7 (Ro4, Finals)
- Strict regulation caps (max 5 games Bo5, max 7 games Bo7)
- Game draw = both get +1 game win; Swiss match tie = both get +1 match win
- Merit-based 10-step tiebreaker hierarchy for Top 32 Cut
- In-memory status caching for high-frequency polling by 500+ clients
"""
import copy
import hashlib
import json
import logging
import os
import random
import secrets
import sqlite3
import functools
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from engine import BotRunner, load_config, run_match
from engine.rules import FUMBLE

from . import db, settings

logger = logging.getLogger("tournament")
CFG = load_config(settings.CONFIG_PATH)

SWISS_ROUNDS = 6
TOP_CUT_COUNT = 32

# Stages
STAGE_READY = "ready_room"
STAGE_SWISS_PREFIX = "swiss_"
STAGE_CUT_CEREMONY = "cut_ceremony"
STAGE_RO32 = "ro32"
STAGE_RO16 = "ro16"
STAGE_RO8 = ["ro8_m1", "ro8_m2", "ro8_m3", "ro8_m4"]
STAGE_RO4 = ["ro4_m1", "ro4_m2"]
STAGE_FINALS = "finals"
STAGE_CHAMPION = "champion"

# Timing constants for playback
TURN_MS = 750
GAME_PAUSE_MS = 2500
MATCH_END_PAUSE_MS = 5000

# In-Memory Cache for ultra-fast polling across 500+ laptops
_cache_lock = threading.RLock()
_CACHE: Dict[str, Any] = {
    "status": None,
    "screen": None,
    "bracket": None,
    "highlight_replay": None,
}


@dataclass
class ParticipantEntry:
    id: int
    roll: str
    name: str
    bot_name: str
    code: str
    submission_id: int
    rank: int = 999


@dataclass
class Standing:
    participant_id: int
    roll: str
    name: str
    bot_name: str
    match_wins: int = 0
    match_losses: int = 0
    game_wins: int = 0
    game_losses: int = 0
    buchholz: float = 0.0
    sonneborn: float = 0.0
    damage_dealt: int = 0
    damage_taken: int = 0
    fumbles: int = 0
    knockout_turns: int = 0
    knockout_wins: int = 0
    tier: int = 3
    rank: int = 0
    prev_rank: int = 0
    opponents: List[int] = field(default_factory=list)
    defeated_opponents: List[int] = field(default_factory=list)
    had_bye: bool = False



# --- Database State & Snapshots --------------------------------------------------------

def _init_tournament_state():
    """Ensures tournament_state row exists in DB."""
    with db.connect() as c:
        row = c.execute("SELECT * FROM tournament_state WHERE id = 1").fetchone()
        if not row:
            now = time.time()
            c.execute("""
                INSERT INTO tournament_state(id, stage, round_number, started_at, paused, paused_at,
                                             accumulated_pause, highlight_match_id, turn_step, updated_at)
                VALUES(1, ?, 0, NULL, 0, NULL, 0, NULL, -1, ?)
            """, (STAGE_READY, now))


def get_raw_state() -> Dict[str, Any]:
    _init_tournament_state()
    with db.connect() as c:
        row = c.execute("SELECT * FROM tournament_state WHERE id = 1").fetchone()
        return dict(row)


def update_state(**kwargs):
    with db.connect() as c:
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        vals = list(kwargs.values())
        vals.append(time.time())
        c.execute(f"UPDATE tournament_state SET {sets}, updated_at = ? WHERE id = 1", vals)
    invalidate_cache()


# --- Standings & Statistics -------------------------------------------------------------

def get_latest_standings() -> List[Dict[str, Any]]:
    state = get_raw_state()
    rnd = state["round_number"]
    with db.connect() as c:
        target_rnd = min(rnd, SWISS_ROUNDS) if rnd > 0 else 0
        if target_rnd > 0:
            max_r_row = c.execute("SELECT MAX(round_number) as max_r FROM tournament_standings").fetchone()
            if max_r_row and max_r_row["max_r"]:
                target_rnd = min(target_rnd, max_r_row["max_r"])

        rows = c.execute("""
            SELECT s.*, p.roll, p.name, p.bot_name
            FROM tournament_standings s
            JOIN participants p ON p.id = s.participant_id
            WHERE s.round_number = ?
            ORDER BY s.rank ASC
        """, (target_rnd,)).fetchall()
        return [dict(r) for r in rows]


def calculate_seed_hash(bot_id: int, seed: int = 12345) -> str:
    return hashlib.sha256(f"{bot_id}:{seed}".encode()).hexdigest()


def compute_standings_from_history(round_num: int) -> List[Standing]:
    """Computes full 10-tier merit standings from all matches up to round_num."""
    entries = get_all_tournament_entries()
    standings: Dict[int, Standing] = {
        e.id: Standing(
            participant_id=e.id,
            roll=e.roll,
            name=e.name,
            bot_name=e.bot_name or e.name
        ) for e in entries
    }

    if not standings:
        return []

    with db.connect() as c:
        matches = c.execute("""
            SELECT m.*, r.round_number FROM tournament_matches m
            JOIN tournament_rounds r ON r.id = m.round_id
            WHERE r.round_number <= ? AND r.status != 'rolled_back'
            ORDER BY m.id ASC
        """, (round_num,)).fetchall()

    for m in matches:
        p1_id, p2_id = m["p1_id"], m["p2_id"]
        is_bye = bool(m["is_bye"])
        p1_s, p2_s = m["p1_score"], m["p2_score"]
        winner = m["winner_id"]

        if p1_id in standings:
            s1 = standings[p1_id]
            s1.game_wins += p1_s
            s1.game_losses += p2_s
            if is_bye:
                s1.match_wins += 1
                s1.had_bye = True
                s1.damage_dealt += 9
            else:
                if winner == p1_id:
                    s1.match_wins += 1
                    s1.defeated_opponents.append(p2_id)
                else:
                    s1.match_losses += 1
                s1.opponents.append(p2_id)

        if not is_bye and p2_id and p2_id in standings:
            s2 = standings[p2_id]
            s2.game_wins += p2_s
            s2.game_losses += p1_s
            if winner == p2_id:
                s2.match_wins += 1
                s2.defeated_opponents.append(p1_id)
            else:
                s2.match_losses += 1
            s2.opponents.append(p1_id)

        # Parse match replays to accumulate damage, fumbles, knockout speed
        try:
            games = json.loads(m["replay_json"])
            for g in games:
                final = g.get("result", {}).get("final", [{}, {}])
                turns = g.get("turns", [])
                g_winner = g.get("result", {}).get("winner")

                if p1_id in standings:
                    s1 = standings[p1_id]
                    s1.damage_dealt += final[0].get("damage_dealt", 0)
                    s1.damage_taken += (3 - final[0].get("hp", 3))
                    s1.fumbles += sum(1 for t in turns if t["actions"][0] == FUMBLE or bool(t.get("errors", [""])[0]))
                    if g_winner == 0:
                        s1.knockout_turns += len(turns)
                        s1.knockout_wins += 1

                if not is_bye and p2_id and p2_id in standings:
                    s2 = standings[p2_id]
                    s2.damage_dealt += final[1].get("damage_dealt", 0)
                    s2.damage_taken += (3 - final[1].get("hp", 3))
                    s2.fumbles += sum(1 for t in turns if len(t["actions"]) > 1 and (t["actions"][1] == FUMBLE or bool(t.get("errors", ["", ""])[1])))
                    if g_winner == 1:
                        s2.knockout_turns += len(turns)
                        s2.knockout_wins += 1
        except Exception:
            pass

    # Compute Buchholz (sum of opponents' match wins) & Sonneborn-Berger with Bye adjustment
    for s in standings.values():
        s.buchholz = sum(standings[opp].match_wins for opp in s.opponents if opp in standings)
        s.sonneborn = sum(standings[opp].match_wins for opp in s.defeated_opponents if opp in standings)
        if s.had_bye:
            bye_virt = max(1.0, round_num * 0.5)
            s.buchholz += bye_virt
            s.sonneborn += bye_virt

    # 10-Tier Merit Tiebreaker Comparator:
    # 1. Match Record (wins desc, losses asc)
    # 2. Buchholz Score desc
    # 3. Sonneborn-Berger desc
    # 4. Head-to-Head (if tied bots played each other)
    # 5. Game Differential desc
    # 6. Total Damage Dealt desc
    # 7. Net Damage Differential desc
    # 8. Fewest Fumbles asc
    # 9. Fastest Knockout Speed asc (average turns per knockout game)
    # 10. Deterministic Seed Hash asc
    def compare_standings(a: Standing, b: Standing) -> int:
        if a.match_wins != b.match_wins:
            return -1 if a.match_wins > b.match_wins else 1
        if a.match_losses != b.match_losses:
            return -1 if a.match_losses < b.match_losses else 1
        if abs(a.buchholz - b.buchholz) > 1e-6:
            return -1 if a.buchholz > b.buchholz else 1
        if abs(a.sonneborn - b.sonneborn) > 1e-6:
            return -1 if a.sonneborn > b.sonneborn else 1
        # 4. Head-to-Head
        if b.participant_id in a.defeated_opponents and a.participant_id not in b.defeated_opponents:
            return -1
        if a.participant_id in b.defeated_opponents and b.participant_id not in a.defeated_opponents:
            return 1
        # 5. Game Differential
        diff_a = a.game_wins - a.game_losses
        diff_b = b.game_wins - b.game_losses
        if diff_a != diff_b:
            return -1 if diff_a > diff_b else 1
        # 6. Total Damage Dealt
        if a.damage_dealt != b.damage_dealt:
            return -1 if a.damage_dealt > b.damage_dealt else 1
        # 7. Net Damage Differential
        net_a = a.damage_dealt - a.damage_taken
        net_b = b.damage_dealt - b.damage_taken
        if net_a != net_b:
            return -1 if net_a > net_b else 1
        # 8. Fewest Fumbles
        if a.fumbles != b.fumbles:
            return -1 if a.fumbles < b.fumbles else 1
        # 9. Fastest Knockout Speed (average turns per knockout game)
        speed_a = (a.knockout_turns / a.knockout_wins) if a.knockout_wins > 0 else 9999.0
        speed_b = (b.knockout_turns / b.knockout_wins) if b.knockout_wins > 0 else 9999.0
        if abs(speed_a - speed_b) > 1e-6:
            return -1 if speed_a < speed_b else 1
        # 10. Deterministic Seed Hash
        hash_a = calculate_seed_hash(a.participant_id)
        hash_b = calculate_seed_hash(b.participant_id)
        return -1 if hash_a < hash_b else (1 if hash_a > hash_b else 0)

    ranked = list(standings.values())
    ranked.sort(key=functools.cmp_to_key(compare_standings))

    # Assign ranks and tiers (Tier 1: 1-8, Tier 2: 9-20, Tier 3: 21-32)
    for idx, s in enumerate(ranked):
        s.rank = idx + 1
        if s.rank <= 8:
            s.tier = 1
        elif s.rank <= 20:
            s.tier = 2
        else:
            s.tier = 3

    return ranked


def get_all_tournament_entries() -> List[ParticipantEntry]:
    """Returns the latest valid submission for each registered participant."""
    with db.connect() as c:
        rows = c.execute("""
            SELECT p.id, p.roll, p.name, p.bot_name, s.id as submission_id, s.code
            FROM participants p
            JOIN submissions s ON s.id = (
                SELECT MAX(id) FROM submissions
                WHERE participant_id = p.id AND status != 'rejected'
            )
            ORDER BY p.id ASC
        """).fetchall()
        return [
            ParticipantEntry(
                id=r["id"],
                roll=r["roll"],
                name=r["name"],
                bot_name=r["bot_name"] or f"Agent_{r['id']:03d}",
                code=r["code"],
                submission_id=r["submission_id"]
            )
            for r in rows
        ]


# --- Swiss Pairing with Backtracking Fallback -------------------------------------------

def pair_swiss_round(round_number: int) -> Tuple[List[Tuple[ParticipantEntry, Optional[ParticipantEntry]]], Optional[ParticipantEntry]]:
    """Pairs participants for a Swiss round avoiding rematches with backtracking fallback."""
    entries = get_all_tournament_entries()
    if not entries:
        return [], None

    # Load past matchups
    with db.connect() as c:
        matches = c.execute("""
            SELECT p1_id, p2_id, is_bye FROM tournament_matches m
            JOIN tournament_rounds r ON r.id = m.round_id
            WHERE r.status != 'rolled_back'
        """).fetchall()

    played_pairs: Set[Tuple[int, int]] = set()
    had_bye_ids: Set[int] = set()
    for m in matches:
        if m["is_bye"]:
            had_bye_ids.add(m["p1_id"])
        elif m["p2_id"]:
            played_pairs.add(tuple(sorted((m["p1_id"], m["p2_id"]))))

    entry_by_id = {e.id: e for e in entries}

    bye_entry: Optional[ParticipantEntry] = None
    order: List[ParticipantEntry] = []

    if round_number == 1:
        # Round 1: deterministic shuffle using seed hash
        order = list(entries)
        random.Random(42).shuffle(order)
        if len(order) % 2 != 0:
            bye_entry = order.pop(-1)
        paired: List[Tuple[ParticipantEntry, ParticipantEntry]] = []
        half = len(order) // 2
        for i in range(half):
            paired.append((order[i], order[i + half]))
    else:
        # Sort by current standings
        standings = compute_standings_from_history(round_number - 1)
        standings_by_id = {s.participant_id: s for s in standings}
        order = [entry_by_id[s.participant_id] for s in standings if s.participant_id in entry_by_id]

        if len(order) % 2 != 0:
            # Odd number of players: assign Bye to the lowest-standing player who hasn't had one
            for i in reversed(range(len(order))):
                cand = order[i]
                if cand.id not in had_bye_ids:
                    bye_entry = order.pop(i)
                    break
            if not bye_entry:
                bye_entry = order.pop(-1)

        # Partition into score brackets (match_wins descending)
        by_score: Dict[int, List[ParticipantEntry]] = defaultdict(list)
        for p in order:
            st = standings_by_id.get(p.id)
            score = st.match_wins if st else 0
            by_score[score].append(p)

        paired = []
        floated: List[ParticipantEntry] = []

        for score in sorted(by_score.keys(), reverse=True):
            group = floated + by_score[score]
            floated = []
            if len(group) % 2 != 0:
                # Float lowest player in this bracket down to next score bracket
                floated.append(group.pop(-1))

            # Bounded backtracking pairer for this bracket
            steps = 0
            def backtrack_bracket(unpaired: List[ParticipantEntry]) -> Optional[List[Tuple[ParticipantEntry, ParticipantEntry]]]:
                nonlocal steps
                steps += 1
                if steps > 1000:
                    return None
                if not unpaired:
                    return []
                p1 = unpaired[0]
                for i in range(1, len(unpaired)):
                    p2 = unpaired[i]
                    pair_key = tuple(sorted((p1.id, p2.id)))
                    if pair_key not in played_pairs:
                        remaining = [p for j, p in enumerate(unpaired) if j not in (0, i)]
                        res = backtrack_bracket(remaining)
                        if res is not None:
                            return [(p1, p2)] + res
                return None

            b_res = backtrack_bracket(group)
            if b_res is not None:
                paired.extend(b_res)
            else:
                # Greedy non-rematch fallback within bracket
                unp = list(group)
                while len(unp) >= 2:
                    p1 = unp.pop(0)
                    found = False
                    for idx, cand in enumerate(unp):
                        if tuple(sorted((p1.id, cand.id))) not in played_pairs:
                            p2 = unp.pop(idx)
                            paired.append((p1, p2))
                            found = True
                            break
                    if not found:
                        p2 = unp.pop(0)
                        paired.append((p1, p2))
                if unp:
                    floated.extend(unp)

        # In case any floated players remain
        if floated:
            while len(floated) >= 2:
                paired.append((floated.pop(0), floated.pop(0)))
            if floated:
                if not bye_entry:
                    bye_entry = floated.pop(0)
                else:
                    paired.append((floated.pop(0), order[0]))

    pairings: List[Tuple[ParticipantEntry, Optional[ParticipantEntry]]] = [(p1, p2) for p1, p2 in paired]
    if bye_entry:
        pairings.append((bye_entry, None))

    return pairings, bye_entry


# --- Match Series Execution (Bo5 & Bo7) ------------------------------------------------

def run_match_series(
    p1: ParticipantEntry,
    p2: Optional[ParticipantEntry],
    max_games: int = 5,
    wins_required: int = 3,
    is_swiss: bool = True,
    seed_base: int = 1000,
    history: Optional[Dict[int, Any]] = None,
    round_number: int = 1
) -> Dict[str, Any]:
    """Runs a Best of 5 (max 5) or Best of 7 (max 7) series.
    - Engine game draw gives +1 game win to both
    - Swiss match tie gives +1 match win to both
    - Elimination match tie broken by 5-step match stat tiebreaker
    """
    if p2 is None:
        # Bye match
        return {
            "p1_id": p1.id,
            "p2_id": None,
            "is_bye": True,
            "p1_score": 3,
            "p2_score": 0,
            "winner_id": p1.id,
            "draw_reason": None,
            "games": [],
            "highlight_score": 0.0,
            "p1_damage": 9,
            "p2_damage": 0,
        }

    bot1 = BotRunner(p1.code, filename=f"{p1.bot_name}.py", print_limit=CFG.print_chars_per_turn)
    bot2 = BotRunner(p2.code, filename=f"{p2.bot_name}.py", print_limit=CFG.print_chars_per_turn)

    games = []
    p1_wins = 0
    p2_wins = 0
    p1_total_damage = 0
    p2_total_damage = 0
    p1_total_hp = 0
    p2_total_hp = 0
    p1_fumbles = 0
    p2_fumbles = 0
    lead_changes = 0
    prev_leader = None

    for game_idx in range(1, max_games + 1):
        game_seed = seed_base + game_idx
        replay = run_match([bot1, bot2], CFG, seed=game_seed, names=(p1.bot_name, p2.bot_name))
        games.append(replay)

        winner = replay["result"]["winner"]
        final = replay["result"]["final"]
        turns = replay["turns"]

        p1_total_damage += final[0]["damage_dealt"]
        p2_total_damage += final[1]["damage_dealt"]
        p1_total_hp += final[0]["hp"]
        p2_total_hp += final[1]["hp"]
        p1_fumbles += sum(1 for t in turns if t["actions"][0] == FUMBLE or bool(t.get("errors", [""])[0]))
        p2_fumbles += sum(1 for t in turns if len(t["actions"]) > 1 and (t["actions"][1] == FUMBLE or bool(t.get("errors", ["", ""])[1])))

        if winner == 0:
            p1_wins += 1
        elif winner == 1:
            p2_wins += 1
        # Game draw: neither bot receives a game win. Match continues to the next game.

        leader = 0 if p1_wins > p2_wins else (1 if p2_wins > p1_wins else None)
        if leader is not None and prev_leader is not None and leader != prev_leader:
            lead_changes += 1
        if leader is not None:
            prev_leader = leader

        # Series ends if either bot reached the required wins (3 in Bo5, 4 in Bo7)
        if p1_wins >= wins_required or p2_wins >= wins_required:
            break

    # Determine series outcome
    winner_id = None
    draw_reason = None

    if p1_wins > p2_wins:
        winner_id = p1.id
    elif p2_wins > p1_wins:
        winner_id = p2.id
    else:
        # Match ends in a tie after regulation games
        # Step 1: For Single Elimination, first evaluate in-match combat performance
        if not is_swiss:
            if p1_total_damage != p2_total_damage:
                winner_id = p1.id if p1_total_damage > p2_total_damage else p2.id
                draw_reason = "tiebreak_elim_damage"
            elif p1_total_hp != p2_total_hp:
                winner_id = p1.id if p1_total_hp > p2_total_hp else p2.id
                draw_reason = "tiebreak_elim_hp"
            elif p1_fumbles != p2_fumbles:
                winner_id = p1.id if p1_fumbles < p2_fumbles else p2.id
                draw_reason = "tiebreak_elim_fumbles"

        # Step 2: For Swiss and Single Elimination (if still tied), evaluate the 10-tier Tournament Merit History
        if winner_id is None:
            h1 = history.get(p1.id) if history else None
            h2 = history.get(p2.id) if history else None

            # 1. Match Wins in tournament so far
            p1_mw = getattr(h1, "match_wins", 0)
            p2_mw = getattr(h2, "match_wins", 0)
            if p1_mw != p2_mw:
                winner_id = p1.id if p1_mw > p2_mw else p2.id
                draw_reason = "tiebreak_match_wins"

            # 2. Buchholz Score so far (strength of schedule)
            elif abs(getattr(h1, "buchholz", 0.0) - getattr(h2, "buchholz", 0.0)) > 1e-6:
                winner_id = p1.id if getattr(h1, "buchholz", 0.0) > getattr(h2, "buchholz", 0.0) else p2.id
                draw_reason = "tiebreak_buchholz"

            # 3. Sonneborn-Berger Score so far (prestige wins)
            elif abs(getattr(h1, "sonneborn", 0.0) - getattr(h2, "sonneborn", 0.0)) > 1e-6:
                winner_id = p1.id if getattr(h1, "sonneborn", 0.0) > getattr(h2, "sonneborn", 0.0) else p2.id
                draw_reason = "tiebreak_sonneborn"

            # 4. Net Game Differential across tournament (including this match)
            elif (
                ((getattr(h1, "game_wins", 0) + p1_wins) - (getattr(h1, "game_losses", 0) + p2_wins))
                != ((getattr(h2, "game_wins", 0) + p2_wins) - (getattr(h2, "game_losses", 0) + p1_wins))
            ):
                net_g1 = (getattr(h1, "game_wins", 0) + p1_wins) - (getattr(h1, "game_losses", 0) + p2_wins)
                net_g2 = (getattr(h2, "game_wins", 0) + p2_wins) - (getattr(h2, "game_losses", 0) + p1_wins)
                winner_id = p1.id if net_g1 > net_g2 else p2.id
                draw_reason = "tiebreak_net_games"

            # 5. Total Game Wins across tournament (including this match)
            elif (getattr(h1, "game_wins", 0) + p1_wins) != (getattr(h2, "game_wins", 0) + p2_wins):
                tot_gw1 = getattr(h1, "game_wins", 0) + p1_wins
                tot_gw2 = getattr(h2, "game_wins", 0) + p2_wins
                winner_id = p1.id if tot_gw1 > tot_gw2 else p2.id
                draw_reason = "tiebreak_game_wins"

            # 6. Head-to-Head from earlier rounds
            elif h1 and h2 and p2.id in getattr(h1, "defeated_opponents", []) and p1.id not in getattr(h2, "defeated_opponents", []):
                winner_id = p1.id
                draw_reason = "tiebreak_h2h"
            elif h1 and h2 and p1.id in getattr(h2, "defeated_opponents", []) and p2.id not in getattr(h1, "defeated_opponents", []):
                winner_id = p2.id
                draw_reason = "tiebreak_h2h"

            # 7. Total Damage Dealt across tournament (including this match)
            elif (getattr(h1, "damage_dealt", 0) + p1_total_damage) != (getattr(h2, "damage_dealt", 0) + p2_total_damage):
                tot_dmg1 = getattr(h1, "damage_dealt", 0) + p1_total_damage
                tot_dmg2 = getattr(h2, "damage_dealt", 0) + p2_total_damage
                winner_id = p1.id if tot_dmg1 > tot_dmg2 else p2.id
                draw_reason = "tiebreak_damage"

            # 8. Cumulative Remaining HP in this match
            elif p1_total_hp != p2_total_hp:
                winner_id = p1.id if p1_total_hp > p2_total_hp else p2.id
                draw_reason = "tiebreak_hp"

            # 9. Fewest Fumbles across tournament (including this match)
            elif (getattr(h1, "fumbles", 0) + p1_fumbles) != (getattr(h2, "fumbles", 0) + p2_fumbles):
                tot_fum1 = getattr(h1, "fumbles", 0) + p1_fumbles
                tot_fum2 = getattr(h2, "fumbles", 0) + p2_fumbles
                winner_id = p1.id if tot_fum1 < tot_fum2 else p2.id
                draw_reason = "tiebreak_fumbles"

            # 10. Fastest Knockout Speed (average turns per knockout game)
            else:
                p1_match_ko = sum(len(g["turns"]) for g in games if g["result"]["winner"] == 0)
                p2_match_ko = sum(len(g["turns"]) for g in games if g["result"]["winner"] == 1)
                tot_ko1 = getattr(h1, "knockout_turns", 0) + p1_match_ko
                tot_ko2 = getattr(h2, "knockout_turns", 0) + p2_match_ko
                tot_w1 = getattr(h1, "knockout_wins", 0) + sum(1 for g in games if g["result"]["winner"] == 0)
                tot_w2 = getattr(h2, "knockout_wins", 0) + sum(1 for g in games if g["result"]["winner"] == 1)
                spd1 = (tot_ko1 / tot_w1) if tot_w1 > 0 else 9999.0
                spd2 = (tot_ko2 / tot_w2) if tot_w2 > 0 else 9999.0
                if abs(spd1 - spd2) > 1e-6:
                    winner_id = p1.id if spd1 < spd2 else p2.id
                    draw_reason = "tiebreak_ko_turns"
                # 11. Final Swiss Seeding rank fallback (if elimination or known ranks)
                elif getattr(p1, "rank", 999) != getattr(p2, "rank", 999):
                    winner_id = p1.id if getattr(p1, "rank", 999) < getattr(p2, "rank", 999) else p2.id
                    draw_reason = "tiebreak_swiss_seed"
                # 12. Deterministic Hash fallback
                else:
                    h1_hash = calculate_seed_hash(p1.id, round_number)
                    h2_hash = calculate_seed_hash(p2.id, round_number)
                    winner_id = p1.id if h1_hash < h2_hash else p2.id
                    draw_reason = "tiebreak_seed"

    # Calculate action variety and defensive highlights
    blocks = sum(sum(1 for ev in t.get("events", []) if ev.get("type") == "blocked") for g in games for t in g.get("turns", []))
    reflections = sum(sum(1 for ev in t.get("events", []) if ev.get("type") == "reflected") for g in games for t in g.get("turns", []))
    total_damage = p1_total_damage + p2_total_damage

    # Zero-damage stall games are never chosen as the marquee duel
    if total_damage == 0:
        highlight_score = 0.0
    else:
        highlight_score = (
            (total_damage * 10.0)
            + (lead_changes * 25.0)
            + (reflections * 12.0)
            + (blocks * 2.0)
            + (len(games) * 12.0)
            + (25.0 if any(g["result"]["winner"] is not None for g in games) else 0.0)
            - ((p1_fumbles + p2_fumbles) * 4.0)
        )

    return {
        "p1_id": p1.id,
        "p2_id": p2.id,
        "is_bye": False,
        "p1_score": p1_wins,
        "p2_score": p2_wins,
        "winner_id": winner_id,
        "draw_reason": draw_reason,
        "games": games,
        "highlight_score": round(highlight_score, 2),
        "p1_damage": p1_total_damage,
        "p2_damage": p2_total_damage,
    }


# --- Precomputation of Full Rounds -----------------------------------------------------

def precompute_round_matches(
    round_number: int,
    stage_name: str,
    pairings: List[Tuple[ParticipantEntry, Optional[ParticipantEntry]]],
    max_games: int = 5,
    wins_required: int = 3,
    is_swiss: bool = True,
    history: Optional[Dict[int, Any]] = None
) -> List[Dict[str, Any]]:
    """Runs all pairings in parallel across CPU threads."""
    results = []

    def task(item):
        idx, (p1, p2) = item
        seed = 10000 * round_number + idx * 10
        series = run_match_series(p1, p2, max_games, wins_required, is_swiss, seed, history, round_number)
        series["match_index"] = idx
        series["stage"] = stage_name
        return series

    with ThreadPoolExecutor(max_workers=min(16, (os.cpu_count() or 4) * 2)) as pool:
        results = list(pool.map(task, enumerate(pairings)))

    return results


# --- Tournament Progression & State Machine --------------------------------------------

def start_tournament() -> Dict[str, Any]:
    """Initializes tournament to ready_room, purging past matches, rounds, and standings."""
    _init_tournament_state()
    with db.connect() as c:
        c.execute("DELETE FROM tournament_matches")
        c.execute("DELETE FROM tournament_rounds")
        c.execute("DELETE FROM tournament_standings")
    update_state(
        stage=STAGE_READY,
        round_number=0,
        started_at=None,
        paused=0,
        paused_at=None,
        accumulated_pause=0,
        highlight_match_id=None,
        turn_step=-1
    )
    invalidate_cache()
    return get_screen_data()


def advance_to_swiss_round(round_number: int) -> Dict[str, Any]:
    """Runs Swiss round pairing, computes matches, saves snapshot, and updates cache."""
    stage_name = f"{STAGE_SWISS_PREFIX}{round_number}"
    pairings, bye_entry = pair_swiss_round(round_number)
    if not pairings:
        raise ValueError("No eligible tournament entries found to pair.")

    # Snapshot previous standings before running this round for instant Undo
    prev_standings_list = compute_standings_from_history(round_number - 1) if round_number > 1 else []
    prev_history = {s.participant_id: s for s in prev_standings_list}
    prev_standings = get_latest_standings() if round_number > 1 else []
    snapshot_json = json.dumps({"round_number": round_number - 1, "standings": prev_standings})

    # Execute all matches in parallel
    match_results = precompute_round_matches(
        round_number=round_number,
        stage_name=stage_name,
        pairings=pairings,
        max_games=5,
        wins_required=3,
        is_swiss=True,
        history=prev_history
    )

    # Pick the marquee match from the top contenders without leaking ratings
    non_bye_matches = [m for m in match_results if not m["is_bye"]]
    if non_bye_matches:
        # Match index 0..N are sorted by score bracket descending
        top_slice = non_bye_matches[:max(4, len(non_bye_matches) // 4)]
        highlight_match = max(top_slice, key=lambda m: m["highlight_score"])
    else:
        highlight_match = match_results[0]

    now = time.time()
    with db.connect() as c:
        # Create round ledger entry
        cur = c.execute("""
            INSERT INTO tournament_rounds(stage, round_number, status, started_at, snapshot_json)
            VALUES(?, ?, 'running', ?, ?)
        """, (stage_name, round_number, now, snapshot_json))
        round_id = cur.lastrowid

        # Insert matches
        highlight_db_id = None
        for m in match_results:
            cur_m = c.execute("""
                INSERT INTO tournament_matches(round_id, stage, match_index, p1_id, p2_id, is_bye,
                                              p1_score, p2_score, winner_id, draw_reason, replay_json, highlight_score)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                round_id, stage_name, m["match_index"], m["p1_id"], m["p2_id"], 1 if m["is_bye"] else 0,
                m["p1_score"], m["p2_score"], m["winner_id"], m["draw_reason"],
                json.dumps(m["games"]), m["highlight_score"]
            ))
            if m["match_index"] == highlight_match["match_index"]:
                highlight_db_id = cur_m.lastrowid

    # Compute updated standings and write to database
    standings = compute_standings_from_history(round_number)
    with db.connect() as c:
        for s in standings:
            c.execute("""
                INSERT INTO tournament_standings(round_number, participant_id, match_wins, match_losses,
                                                game_wins, game_losses, buchholz, sonneborn, damage_dealt,
                                                damage_taken, fumbles, knockout_turns, tier, rank)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                round_number, s.participant_id, s.match_wins, s.match_losses,
                s.game_wins, s.game_losses, s.buchholz, s.sonneborn, s.damage_dealt,
                s.damage_taken, s.fumbles, s.knockout_turns, s.tier, s.rank
            ))

    # Update tournament state
    update_state(
        stage=stage_name,
        round_number=round_number,
        started_at=now,
        paused=0,
        paused_at=None,
        accumulated_pause=0,
        highlight_match_id=highlight_db_id,
        turn_step=-1
    )

    return get_screen_data()


def advance_to_cut_ceremony() -> Dict[str, Any]:
    """Transitions from Swiss stage to the Top 32 Cut Ceremony."""
    now = time.time()
    update_state(
        stage=STAGE_CUT_CEREMONY,
        round_number=SWISS_ROUNDS,
        started_at=now,
        paused=0,
        paused_at=None,
        accumulated_pause=0,
        highlight_match_id=None,
        turn_step=-1
    )
    return get_screen_data()


def build_elimination_bracket() -> Dict[str, Any]:
    """Builds the complete single elimination bracket tree (Ro32, Ro16, Ro8, Ro4, Finals).
    Reads real match results, scores, and advancing winners directly from the database.
    """
    entries = {e.id: e for e in get_all_tournament_entries()}
    standings = compute_standings_from_history(SWISS_ROUNDS)
    top32 = standings[:TOP_CUT_COUNT] if len(standings) >= TOP_CUT_COUNT else standings
    by_rank = {s.rank: s for s in top32}

    SEED_PAIRS = [
        (1, 32), (16, 17), (8, 25), (9, 24),
        (4, 29), (13, 20), (5, 28), (12, 21),
        (2, 31), (15, 18), (7, 26), (10, 23),
        (3, 30), (14, 19), (6, 27), (11, 22),
    ]

    with db.connect() as c:
        raw_rows = c.execute("""
            SELECT m.*, p1.bot_name as p1_bot, p1.name as p1_real,
                        p2.bot_name as p2_bot, p2.name as p2_real
            FROM tournament_matches m
            JOIN participants p1 ON p1.id = m.p1_id
            LEFT JOIN participants p2 ON p2.id = m.p2_id
            WHERE m.stage LIKE 'ro%' OR m.stage = 'finals'
            ORDER BY m.id ASC
        """).fetchall()
        rows = [dict(r) for r in raw_rows]

    matches_by_stage: Dict[str, Dict[int, Dict[str, Any]]] = defaultdict(dict)
    for r in rows:
        matches_by_stage[r["stage"]][r["match_index"]] = r

    def format_participant(pid, seed=None):
        if not pid or pid not in entries:
            return None
        e = entries[pid]
        return {
            "participant_id": e.id,
            "bot_name": e.bot_name,
            "name": e.name,
            "seed": seed,
        }

    # Determine pacing based on the active marquee duel
    state = get_raw_state()
    hl_id = state.get("highlight_match_id")
    target_max_ms = 35000  # Default broadcast pace ~35s
    if hl_id:
        for r in rows:
            if r["id"] == hl_id and r.get("replay_json"):
                try:
                    hl_games = json.loads(r["replay_json"])
                    hl_ms = sum(len(g.get("turns", [])) * TURN_MS + GAME_PAUSE_MS for g in hl_games)
                    if hl_ms > 10000:
                        target_max_ms = max(18000, hl_ms - 2000)
                except Exception:
                    pass
                break

    def extract_match_timeline(m_row):
        if not m_row or not m_row.get("replay_json"):
            return [], 0
        try:
            games = json.loads(m_row["replay_json"])
        except Exception:
            return [], 0

        raw_game_times = []
        raw_cum = 0
        for g in games:
            turns = g.get("turns", [])
            raw_cum += len(turns) * TURN_MS + GAME_PAUSE_MS
            raw_game_times.append(raw_cum)

        is_highlight = bool(hl_id and m_row.get("id") == hl_id)
        if is_highlight or raw_cum <= target_max_ms:
            scale = 1.0
        else:
            stagger = ((m_row.get("id") or m_row.get("match_index", 0)) % 5) * 500
            scale = max(0.2, (target_max_ms - stagger) / raw_cum)

        timeline = []
        cum_p1, cum_p2 = 0, 0
        for g_idx, g in enumerate(games):
            w = g.get("result", {}).get("winner")
            if w == 0:
                cum_p1 += 1
            elif w == 1:
                cum_p2 += 1
            # draws: neither increments
            timeline.append({
                "game": g_idx + 1,
                "finish_ms": int(raw_game_times[g_idx] * scale),
                "score": [cum_p1, cum_p2],
                "winner": w
            })
        final_finish_ms = int(raw_cum * scale)
        return timeline, final_finish_ms

    # Determine which rounds may be revealed to prevent early spoilers on the Big Screen
    curr_stage = get_raw_state()["stage"]
    reveal_ro16 = curr_stage not in (STAGE_READY, STAGE_CUT_CEREMONY, STAGE_RO32) and not curr_stage.startswith(STAGE_SWISS_PREFIX)
    reveal_ro8 = reveal_ro16 and curr_stage != STAGE_RO16
    reveal_ro4 = reveal_ro8 and curr_stage not in STAGE_RO8
    reveal_finals = reveal_ro4 and curr_stage not in STAGE_RO4

    # 1. Round of 32 (16 matches)
    ro32_matches = []
    for idx, (s1, s2) in enumerate(SEED_PAIRS):
        p1_entry = by_rank.get(s1)
        p2_entry = by_rank.get(s2)
        p1_info = format_participant(p1_entry.participant_id, s1) if p1_entry else None
        p2_info = format_participant(p2_entry.participant_id, s2) if p2_entry else None

        m_row = matches_by_stage.get("ro32", {}).get(idx)
        if m_row:
            p1_info = format_participant(m_row["p1_id"], s1)
            p2_info = format_participant(m_row["p2_id"], s2)
            score = [m_row["p1_score"], m_row["p2_score"]]
            winner_id = m_row["winner_id"]
            draw_reason = m_row.get("draw_reason")
            is_complete = True
        else:
            score = [0, 0]
            winner_id = None
            draw_reason = None
            is_complete = False

        tl, f_ms = extract_match_timeline(m_row)
        ro32_matches.append({
            "match_id": idx,
            "stage": "ro32",
            "seed1": s1,
            "seed2": s2,
            "p1": p1_info,
            "p2": p2_info,
            "winner_id": winner_id,
            "draw_reason": draw_reason,
            "score": score,
            "is_complete": is_complete,
            "timeline": tl,
            "finish_ms": f_ms,
        })

    # 2. Round of 16 (8 matches)
    ro16_matches = []
    for k in range(8):
        m_row = matches_by_stage.get("ro16", {}).get(k)
        if not reveal_ro16:
            p1_info = None
            p2_info = None
            score = ["-", "-"]
            winner_id = None
            draw_reason = None
            is_complete = False
            tl, f_ms = [], 0
        elif m_row:
            p1_info = format_participant(m_row["p1_id"])
            p2_info = format_participant(m_row["p2_id"])
            score = [m_row["p1_score"], m_row["p2_score"]]
            winner_id = m_row["winner_id"]
            draw_reason = m_row.get("draw_reason")
            is_complete = True
            tl, f_ms = extract_match_timeline(m_row)
        else:
            w1_id = ro32_matches[2 * k]["winner_id"] if 2 * k < len(ro32_matches) else None
            w2_id = ro32_matches[2 * k + 1]["winner_id"] if 2 * k + 1 < len(ro32_matches) else None
            p1_info = format_participant(w1_id)
            p2_info = format_participant(w2_id)
            score = [0, 0]
            winner_id = None
            draw_reason = None
            is_complete = False
            tl, f_ms = [], 0

        ro16_matches.append({
            "match_id": k,
            "stage": "ro16",
            "p1": p1_info,
            "p2": p2_info,
            "winner_id": winner_id,
            "draw_reason": draw_reason,
            "score": score,
            "is_complete": is_complete,
            "timeline": tl,
            "finish_ms": f_ms,
        })

    # 3. Quarter-Finals / Elite 8 (4 matches: ro8_m1..ro8_m4)
    ro8_matches = []
    for k in range(4):
        stage_tag = f"ro8_m{k+1}"
        stage_dict = matches_by_stage.get(stage_tag, {})
        m_row = stage_dict.get(0) or (list(stage_dict.values())[0] if stage_dict else None)
        if not reveal_ro8:
            p1_info = None
            p2_info = None
            score = ["-", "-"]
            winner_id = None
            draw_reason = None
            is_complete = False
            tl, f_ms = [], 0
        elif m_row:
            p1_info = format_participant(m_row["p1_id"])
            p2_info = format_participant(m_row["p2_id"])
            score = [m_row["p1_score"], m_row["p2_score"]]
            winner_id = m_row["winner_id"]
            draw_reason = m_row.get("draw_reason")
            is_complete = True
            tl, f_ms = extract_match_timeline(m_row)
        else:
            w1_id = ro16_matches[2 * k]["winner_id"] if 2 * k < len(ro16_matches) else None
            w2_id = ro16_matches[2 * k + 1]["winner_id"] if 2 * k + 1 < len(ro16_matches) else None
            p1_info = format_participant(w1_id)
            p2_info = format_participant(w2_id)
            score = [0, 0]
            winner_id = None
            draw_reason = None
            is_complete = False
            tl, f_ms = [], 0

        ro8_matches.append({
            "match_id": k,
            "stage": stage_tag,
            "p1": p1_info,
            "p2": p2_info,
            "winner_id": winner_id,
            "draw_reason": draw_reason,
            "score": score,
            "is_complete": is_complete,
            "timeline": tl,
            "finish_ms": f_ms,
        })

    # 4. Semi-Finals / Final 4 (2 matches: ro4_m1..ro4_m2)
    ro4_matches = []
    for k in range(2):
        stage_tag = f"ro4_m{k+1}"
        stage_dict = matches_by_stage.get(stage_tag, {})
        m_row = stage_dict.get(0) or (list(stage_dict.values())[0] if stage_dict else None)
        if not reveal_ro4:
            p1_info = None
            p2_info = None
            score = ["-", "-"]
            winner_id = None
            draw_reason = None
            is_complete = False
            tl, f_ms = [], 0
        elif m_row:
            p1_info = format_participant(m_row["p1_id"])
            p2_info = format_participant(m_row["p2_id"])
            score = [m_row["p1_score"], m_row["p2_score"]]
            winner_id = m_row["winner_id"]
            draw_reason = m_row.get("draw_reason")
            is_complete = True
            tl, f_ms = extract_match_timeline(m_row)
        else:
            w1_id = ro8_matches[2 * k]["winner_id"] if 2 * k < len(ro8_matches) else None
            w2_id = ro8_matches[2 * k + 1]["winner_id"] if 2 * k + 1 < len(ro8_matches) else None
            p1_info = format_participant(w1_id)
            p2_info = format_participant(w2_id)
            score = [0, 0]
            winner_id = None
            draw_reason = None
            is_complete = False
            tl, f_ms = [], 0

        ro4_matches.append({
            "match_id": k,
            "stage": stage_tag,
            "p1": p1_info,
            "p2": p2_info,
            "winner_id": winner_id,
            "draw_reason": draw_reason,
            "score": score,
            "is_complete": is_complete,
            "timeline": tl,
            "finish_ms": f_ms,
        })

    # 5. Grand Finale (1 match: finals)
    stage_dict = matches_by_stage.get("finals", {})
    m_row = stage_dict.get(0) or (list(stage_dict.values())[0] if stage_dict else None)
    if not reveal_finals:
        p1_info = None
        p2_info = None
        score = ["-", "-"]
        winner_id = None
        draw_reason = None
        is_complete = False
        tl, f_ms = [], 0
    elif m_row:
        p1_info = format_participant(m_row["p1_id"])
        p2_info = format_participant(m_row["p2_id"])
        score = [m_row["p1_score"], m_row["p2_score"]]
        winner_id = m_row["winner_id"]
        draw_reason = m_row.get("draw_reason")
        is_complete = True
        tl, f_ms = extract_match_timeline(m_row)
    else:
        w1_id = ro4_matches[0]["winner_id"] if len(ro4_matches) > 0 else None
        w2_id = ro4_matches[1]["winner_id"] if len(ro4_matches) > 1 else None
        p1_info = format_participant(w1_id)
        p2_info = format_participant(w2_id)
        score = [0, 0]
        winner_id = None
        draw_reason = None
        is_complete = False
        tl, f_ms = [], 0

    finals_matches = [{
        "match_id": 0,
        "stage": "finals",
        "p1": p1_info,
        "p2": p2_info,
        "winner_id": winner_id,
        "draw_reason": draw_reason,
        "score": score,
        "is_complete": is_complete,
        "timeline": tl,
        "finish_ms": f_ms,
    }]

    return {
        "ro32": ro32_matches,
        "ro16": ro16_matches,
        "ro8": ro8_matches,
        "ro4": ro4_matches,
        "finals": finals_matches,
    }


def advance_stage(target_stage: Optional[str] = None) -> Dict[str, Any]:
    """Auto-advances to the next logical stage or specific requested stage."""
    state = get_raw_state()
    curr_stage = state["stage"]

    # 1. Direct target_stage request
    if target_stage:
        if target_stage == STAGE_READY:
            return start_tournament()
        elif target_stage.startswith(STAGE_SWISS_PREFIX):
            rnd = int(target_stage.replace(STAGE_SWISS_PREFIX, ""))
            return advance_to_swiss_round(rnd)
        elif target_stage == STAGE_CUT_CEREMONY:
            return advance_to_cut_ceremony()
        elif target_stage in (STAGE_RO32, STAGE_RO16):
            return advance_to_elimination_round(target_stage)
        elif target_stage in STAGE_RO8 or target_stage in STAGE_RO4 or target_stage == STAGE_FINALS:
            return advance_to_sequential_match(target_stage)
        elif target_stage == STAGE_CHAMPION:
            update_state(stage=STAGE_CHAMPION, started_at=time.time())
            invalidate_cache()
            return get_screen_data()

    # 2. Sequential flow without artificial intermissions
    if curr_stage == STAGE_READY:
        return advance_to_swiss_round(1)
    elif curr_stage.startswith(STAGE_SWISS_PREFIX):
        rnd = int(curr_stage.replace(STAGE_SWISS_PREFIX, ""))
        if rnd < SWISS_ROUNDS:
            return advance_to_swiss_round(rnd + 1)
        else:
            return advance_to_cut_ceremony()
    elif curr_stage == STAGE_CUT_CEREMONY:
        return advance_to_elimination_round(STAGE_RO32)
    elif curr_stage == STAGE_RO32:
        return advance_to_elimination_round(STAGE_RO16)
    elif curr_stage == STAGE_RO16:
        return advance_to_sequential_match(STAGE_RO8[0])
    elif curr_stage in STAGE_RO8:
        idx = STAGE_RO8.index(curr_stage)
        if idx < len(STAGE_RO8) - 1:
            return advance_to_sequential_match(STAGE_RO8[idx + 1])
        return advance_to_sequential_match(STAGE_RO4[0])
    elif curr_stage in STAGE_RO4:
        idx = STAGE_RO4.index(curr_stage)
        if idx < len(STAGE_RO4) - 1:
            return advance_to_sequential_match(STAGE_RO4[idx + 1])
        return advance_to_sequential_match(STAGE_FINALS)
    elif curr_stage == STAGE_FINALS:
        update_state(stage=STAGE_CHAMPION, started_at=time.time())
        invalidate_cache()
        return get_screen_data()

    return get_screen_data()


def advance_to_elimination_round(stage_name: str) -> Dict[str, Any]:
    """Generates pairings for Ro32 or Ro16, precomputes matches, and sets active stage."""
    now = time.time()
    entries = {e.id: e for e in get_all_tournament_entries()}

    with db.connect() as c:
        # Find winners from previous round
        if stage_name == STAGE_RO32:
            bracket_tree = build_elimination_bracket()
            ro32_matches = bracket_tree.get("ro32", []) if isinstance(bracket_tree, dict) else bracket_tree
            pairings = []
            for b in ro32_matches:
                p1 = entries.get(b["p1"]["participant_id"]) if b.get("p1") else None
                p2 = entries.get(b["p2"]["participant_id"]) if b.get("p2") else None
                if p1:
                    pairings.append((p1, p2))
        else:  # STAGE_RO16
            prev_matches = c.execute("""
                SELECT winner_id FROM tournament_matches
                WHERE stage = 'ro32' ORDER BY match_index ASC
            """).fetchall()
            winners = [entries.get(r["winner_id"]) for r in prev_matches if r["winner_id"] and r["winner_id"] in entries]
            pairings = [(winners[i], winners[i+1] if i + 1 < len(winners) else None) for i in range(0, len(winners), 2)]

    # Attach Swiss final cutoff seeding and tournament history to entries for elimination tiebreaker
    standings = compute_standings_from_history(SWISS_ROUNDS)
    swiss_ranks = {s.participant_id: s.rank for s in standings}
    elim_history = {s.participant_id: s for s in standings}
    for p1, p2 in pairings:
        if p1:
            p1.rank = swiss_ranks.get(p1.id, 999)
        if p2:
            p2.rank = swiss_ranks.get(p2.id, 999)

    # Compute matches
    match_results = precompute_round_matches(
        round_number=SWISS_ROUNDS + (1 if stage_name == STAGE_RO32 else 2),
        stage_name=stage_name,
        pairings=pairings,
        max_games=5,
        wins_required=3,
        is_swiss=False,
        history=elim_history
    )

    highlight_match = max(match_results, key=lambda m: m["highlight_score"])

    with db.connect() as c:
        cur = c.execute("""
            INSERT INTO tournament_rounds(stage, round_number, status, started_at)
            VALUES(?, ?, 'running', ?)
        """, (stage_name, 7 if stage_name == STAGE_RO32 else 8, now))
        round_id = cur.lastrowid

        highlight_db_id = None
        for m in match_results:
            cur_m = c.execute("""
                INSERT INTO tournament_matches(round_id, stage, match_index, p1_id, p2_id, is_bye,
                                              p1_score, p2_score, winner_id, draw_reason, replay_json, highlight_score)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                round_id, stage_name, m["match_index"], m["p1_id"], m["p2_id"], 0,
                m["p1_score"], m["p2_score"], m["winner_id"], m["draw_reason"],
                json.dumps(m["games"]), m["highlight_score"]
            ))
            if m["match_index"] == highlight_match["match_index"]:
                highlight_db_id = cur_m.lastrowid

    update_state(
        stage=stage_name,
        started_at=now,
        paused=0,
        paused_at=None,
        accumulated_pause=0,
        highlight_match_id=highlight_db_id,
        turn_step=-1
    )
    return get_screen_data()


def advance_to_sequential_match(stage_name: str) -> Dict[str, Any]:
    """Runs a single sequential match (Ro8 match 1..4, Ro4 match 1..2, or Grand Finale)."""
    now = time.time()
    entries = {e.id: e for e in get_all_tournament_entries()}
    max_games = 7 if (stage_name in STAGE_RO4 or stage_name == STAGE_FINALS) else 5
    wins_required = 4 if (stage_name in STAGE_RO4 or stage_name == STAGE_FINALS) else 3

    if stage_name in STAGE_RO8:
        round_number = 9 + STAGE_RO8.index(stage_name)
    elif stage_name in STAGE_RO4:
        round_number = 13 + STAGE_RO4.index(stage_name)
    elif stage_name == STAGE_FINALS:
        round_number = 15
    else:
        round_number = 16

    with db.connect() as c:
        if stage_name in STAGE_RO8:
            idx = STAGE_RO8.index(stage_name)
            prev_matches = c.execute("""
                SELECT winner_id FROM tournament_matches
                WHERE stage = 'ro16' ORDER BY match_index ASC
            """).fetchall()
            w1 = entries.get(prev_matches[idx * 2]["winner_id"]) if len(prev_matches) > idx * 2 and prev_matches[idx * 2]["winner_id"] else None
            w2 = entries.get(prev_matches[idx * 2 + 1]["winner_id"]) if len(prev_matches) > idx * 2 + 1 and prev_matches[idx * 2 + 1]["winner_id"] else None
        elif stage_name in STAGE_RO4:
            idx = STAGE_RO4.index(stage_name)
            prev_matches = c.execute("""
                SELECT winner_id FROM tournament_matches
                WHERE stage LIKE 'ro8_%' ORDER BY id ASC
            """).fetchall()
            w1 = entries.get(prev_matches[idx * 2]["winner_id"]) if len(prev_matches) > idx * 2 and prev_matches[idx * 2]["winner_id"] else None
            w2 = entries.get(prev_matches[idx * 2 + 1]["winner_id"]) if len(prev_matches) > idx * 2 + 1 and prev_matches[idx * 2 + 1]["winner_id"] else None
        else:  # Finals
            prev_matches = c.execute("""
                SELECT winner_id FROM tournament_matches
                WHERE stage LIKE 'ro4_%' ORDER BY id ASC
            """).fetchall()
            w1 = entries.get(prev_matches[0]["winner_id"]) if len(prev_matches) > 0 and prev_matches[0]["winner_id"] else None
            w2 = entries.get(prev_matches[1]["winner_id"]) if len(prev_matches) > 1 and prev_matches[1]["winner_id"] else None

    standings = compute_standings_from_history(SWISS_ROUNDS)
    swiss_ranks = {s.participant_id: s.rank for s in standings}
    elim_history = {s.participant_id: s for s in standings}
    if w1:
        w1.rank = swiss_ranks.get(w1.id, 999)
    if w2:
        w2.rank = swiss_ranks.get(w2.id, 999)

    series = run_match_series(
        w1, w2, max_games, wins_required,
        is_swiss=False, seed_base=10000 * round_number, history=elim_history, round_number=round_number
    )

    with db.connect() as c:
        cur = c.execute("""
            INSERT INTO tournament_rounds(stage, round_number, status, started_at)
            VALUES(?, ?, 'running', ?)
        """, (stage_name, round_number, now))
        round_id = cur.lastrowid

        cur_m = c.execute("""
            INSERT INTO tournament_matches(round_id, stage, match_index, p1_id, p2_id, is_bye,
                                          p1_score, p2_score, winner_id, draw_reason, replay_json, highlight_score)
            VALUES(?, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?, 100)
        """, (
            round_id, stage_name, series["p1_id"], series["p2_id"],
            series["p1_score"], series["p2_score"], series["winner_id"],
            series["draw_reason"], json.dumps(series["games"])
        ))
        match_id = cur_m.lastrowid

    update_state(
        stage=stage_name,
        round_number=round_number,
        started_at=now,
        paused=0,
        paused_at=None,
        accumulated_pause=0,
        highlight_match_id=match_id,
        turn_step=-1
    )
    invalidate_cache()
    return get_screen_data()


# --- Panic Pause & Turn Step Controller --------------------------------------------

def toggle_pause(paused_val: Optional[bool] = None) -> Dict[str, Any]:
    state = get_raw_state()
    is_paused = bool(state["paused"])
    new_paused = not is_paused if paused_val is None else paused_val

    now = time.time()
    if new_paused and not is_paused:
        # Pausing now
        update_state(paused=1, paused_at=now)
    elif not new_paused and is_paused:
        # Resuming now
        p_at = state["paused_at"] or now
        acc = state["accumulated_pause"] + (now - p_at)
        update_state(paused=0, paused_at=None, accumulated_pause=acc)

    invalidate_cache()
    return get_tournament_status()


def set_turn_step(step: int) -> Dict[str, Any]:
    """Steps to a specific turn in Grand Finale mode (-1 for auto-play)."""
    state = get_raw_state()
    curr_step = state["turn_step"]
    now = time.time()

    if step >= 0 and curr_step == -1:
        # Entering manual step mode: pause if not already paused so the clock doesn't keep running in the background
        if not state["paused"]:
            update_state(turn_step=step, paused=1, paused_at=now)
        else:
            update_state(turn_step=step)
    elif step == -1 and curr_step >= 0:
        # Returning to auto-play mode: if we were paused, resume and capture accumulated pause
        if state["paused"]:
            p_at = state["paused_at"] or now
            acc = state["accumulated_pause"] + (now - p_at)
            update_state(turn_step=-1, paused=0, paused_at=None, accumulated_pause=acc)
        else:
            update_state(turn_step=-1)
    else:
        update_state(turn_step=step)

    invalidate_cache()
    return get_tournament_status()


# --- In-Memory Caching & API Response Builders -----------------------------------------

def invalidate_cache():
    with _cache_lock:
        _CACHE["status"] = None
        _CACHE["screen"] = None
        _CACHE["bracket"] = None
        _CACHE["highlight_replay"] = None


def get_tournament_status() -> Dict[str, Any]:
    """Ultra-fast, zero-DB response cached in memory for 500+ polling clients."""
    now = time.time()
    with _cache_lock:
        if _CACHE["status"] is not None:
            # Just refresh server_time dynamically and calculate dynamic accumulated pause if paused
            cached = dict(_CACHE["status"])
            cached["server_time"] = now
            if cached.get("paused"):
                p_at = cached.get("paused_at") or now
                cached["accumulated_pause"] = cached.get("base_accumulated_pause", 0) + (now - p_at)
            return cached

    state = get_raw_state()
    stage = state["stage"]
    is_sequential = stage in STAGE_RO8 or stage in STAGE_RO4 or stage == STAGE_FINALS
    reveal_names = is_sequential or stage == STAGE_CHAMPION

    is_paused = bool(state["paused"])
    p_at = state["paused_at"]
    base_acc = state["accumulated_pause"]
    current_acc = base_acc + (now - p_at) if (is_paused and p_at) else base_acc

    status_data = {
        "stage": stage,
        "round_number": state["round_number"],
        "started_at": state["started_at"],
        "paused": is_paused,
        "paused_at": p_at,
        "base_accumulated_pause": base_acc,
        "accumulated_pause": current_acc,
        "server_time": now,
        "is_sequential": is_sequential,
        "reveal_names": reveal_names,
        "turn_step": state["turn_step"],
        "highlight_match_id": state["highlight_match_id"],
        "turn_ms": TURN_MS,
        "game_pause_ms": GAME_PAUSE_MS,
    }

    with _cache_lock:
        _CACHE["status"] = status_data

    return status_data


def get_round_timeline_data(round_number: int, stage: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Returns (base_standings, round_matches) for dynamic in-round leaderboard progression.
    base_standings: standings before this round began (so nothing is spoiled at t=0).
    round_matches: list of matches with finish_ms offsets so the client can dynamically
                   apply results as each match's replay would have concluded.
    """
    base_standings: List[Dict[str, Any]] = []
    if round_number <= 1:
        # Before Round 1: all participants start at 0-0
        entries = get_all_tournament_entries()
        for idx, e in enumerate(entries):
            r = idx + 1
            t = 1 if r <= 8 else (2 if r <= 20 else 3)
            base_standings.append({
                "participant_id": e.id,
                "bot_name": e.bot_name,
                "name": e.name,
                "match_wins": 0,
                "match_losses": 0,
                "game_wins": 0,
                "game_losses": 0,
                "damage_dealt": 0,
                "fumbles": 0,
                "rank": r,
                "tier": t,
                "prev_rank": r,
                "delta": 0,
            })
    else:
        # For Round R > 1: standings from round R - 1
        with db.connect() as c:
            rows = c.execute("""
                SELECT s.*, p.bot_name, p.name FROM tournament_standings s
                JOIN participants p ON p.id = s.participant_id
                WHERE s.round_number = ?
                ORDER BY s.rank ASC
            """, (round_number - 1,)).fetchall()
            for r in rows:
                base_standings.append({
                    "participant_id": r["participant_id"],
                    "bot_name": r["bot_name"],
                    "name": r["name"],
                    "match_wins": r["match_wins"],
                    "match_losses": r["match_losses"],
                    "game_wins": r["game_wins"],
                    "game_losses": r["game_losses"],
                    "damage_dealt": r["damage_dealt"],
                    "fumbles": r["fumbles"],
                    "rank": r["rank"],
                    "tier": r["tier"],
                    "prev_rank": r["rank"],
                    "delta": 0,
                })

    # 2. Matches for this round
    round_matches: List[Dict[str, Any]] = []
    with db.connect() as c:
        cur_round = c.execute("""
            SELECT id FROM tournament_rounds WHERE round_number = ? AND status != 'rolled_back' ORDER BY id DESC LIMIT 1
        """, (round_number,)).fetchone()

        if cur_round:
            m_rows = c.execute("""
                SELECT m.*, p1.bot_name as p1_bot, p2.bot_name as p2_bot
                FROM tournament_matches m
                JOIN participants p1 ON p1.id = m.p1_id
                LEFT JOIN participants p2 ON p2.id = m.p2_id
                WHERE m.round_id = ?
            """, (cur_round["id"],)).fetchall()

            state = get_raw_state()
            hl_id = state.get("highlight_match_id")
            marquee_finish_ms = 35000

            raw_matches = []
            for m in m_rows:
                games = json.loads(m["replay_json"]) if m["replay_json"] else []
                raw_ms = 0
                p1_dmg = 0
                p2_dmg = 0
                p1_fum = 0
                p2_fum = 0
                if not m["is_bye"]:
                    for g in games:
                        turns = g.get("turns", [])
                        raw_ms += len(turns) * TURN_MS + GAME_PAUSE_MS
                        res = g.get("result", {})
                        final = res.get("final", [{}, {}])
                        p1_dmg += final[0].get("damage_dealt", 0) if len(final) > 0 else 0
                        p2_dmg += final[1].get("damage_dealt", 0) if len(final) > 1 else 0
                        p1_fum += sum(1 for t in turns if t.get("actions", [None])[0] == FUMBLE or bool(t.get("errors", [""])[0]))
                        p2_fum += sum(1 for t in turns if len(t.get("actions", [])) > 1 and (t.get("actions")[1] == FUMBLE or bool(t.get("errors", ["", ""])[1])))

                if hl_id and m["id"] == hl_id:
                    marquee_finish_ms = raw_ms

                raw_matches.append((m, raw_ms, p1_dmg, p2_dmg, p1_fum, p2_fum))

            # The marquee duel on the center screen sets the broadcast pacing for the entire room.
            # All background matches conclude at or before the marquee duel finishes,
            # ensuring no bots are left battling after the marquee winner is crowned.
            max_bg_ms = max(15000, marquee_finish_ms - 2000)

            for m, raw_ms, p1_dmg, p2_dmg, p1_fum, p2_fum in raw_matches:
                if m["is_bye"]:
                    finish_ms = 0
                elif hl_id and m["id"] == hl_id:
                    finish_ms = raw_ms
                else:
                    if raw_ms <= max_bg_ms:
                        finish_ms = raw_ms
                    else:
                        # Smoothly distribute long matches so they resolve right before the marquee climax
                        stagger = ((m["id"] or m["match_index"]) % 5) * 600
                        finish_ms = max(8000, max_bg_ms - stagger)

                round_matches.append({
                    "match_id": m["id"],
                    "p1_id": m["p1_id"],
                    "p2_id": m["p2_id"],
                    "p1_name": m["p1_bot"],
                    "p2_name": m["p2_bot"] if m["p2_id"] else "BYE",
                    "is_bye": bool(m["is_bye"]),
                    "p1_score": m["p1_score"],
                    "p2_score": m["p2_score"],
                    "winner_id": m["winner_id"],
                    "finish_ms": finish_ms,
                    "p1_damage": p1_dmg,
                    "p2_damage": p2_dmg,
                    "p1_fumbles": p1_fum,
                    "p2_fumbles": p2_fum,
                })

    return base_standings, round_matches


def get_screen_data() -> Dict[str, Any]:
    """Single aggregated response containing all data needed by the Big Screen."""
    with _cache_lock:
        cached = _CACHE["screen"]
    if cached is not None:
        return {
            **cached,
            "status": get_tournament_status(),
        }

    status = get_tournament_status()
    state = get_raw_state()
    stage = status["stage"]
    rnd = status["round_number"]

    # 1. 3-Tier Board Standings (Top 32)
    standings = get_latest_standings()
    top32 = standings[:TOP_CUT_COUNT] if standings else []

    # Map previous ranks to show movement arrows
    if rnd > 1:
        prev_rnd = max(1, min(rnd - 1, SWISS_ROUNDS - 1))
        with db.connect() as c:
            prev_rows = dict(c.execute("""
                SELECT participant_id, rank FROM tournament_standings WHERE round_number = ?
            """, (prev_rnd,)).fetchall())
    elif rnd == 1:
        entries = get_all_tournament_entries()
        prev_rows = {e.id: idx + 1 for idx, e in enumerate(entries)}
    else:
        prev_rows = {}

    for s in top32:
        s["prev_rank"] = prev_rows.get(s["participant_id"], s["rank"])
        s["delta"] = s["prev_rank"] - s["rank"] if s["participant_id"] in prev_rows else 0

    # Dynamic in-round progression data
    base_standings, round_matches = get_round_timeline_data(rnd, stage)

    # 2. Highlight Match Replay
    highlight_replay = None
    if state["highlight_match_id"]:
        with db.connect() as c:
            row = c.execute("""
                SELECT m.*, p1.bot_name as p1_bot, p1.name as p1_real,
                            p2.bot_name as p2_bot, p2.name as p2_real
                FROM tournament_matches m
                JOIN participants p1 ON p1.id = m.p1_id
                LEFT JOIN participants p2 ON p2.id = m.p2_id
                WHERE m.id = ?
            """, (state["highlight_match_id"],)).fetchone()
            if row:
                highlight_replay = {
                    "match_id": row["id"],
                    "stage": row["stage"],
                    "is_bye": bool(row["is_bye"]),
                    "p1_id": row["p1_id"],
                    "p2_id": row["p2_id"],
                    "p1_name": row["p1_bot"] or row["p1_real"],
                    "p2_name": (row["p2_bot"] or row["p2_real"]) if row["p2_id"] else "BYE",
                    "p1_real_name": row["p1_real"],
                    "p2_real_name": row["p2_real"] if row["p2_id"] else "",
                    "p1_score": row["p1_score"],
                    "p2_score": row["p2_score"],
                    "winner_id": row["winner_id"],
                    "draw_reason": row["draw_reason"],
                    "games": json.loads(row["replay_json"])
                }

    # 3. Elimination Bracket Tree (if in elimination or cut ceremony)
    bracket = build_elimination_bracket() if (stage == STAGE_CUT_CEREMONY or stage.startswith("ro") or stage == STAGE_FINALS or stage == STAGE_CHAMPION) else []

    # 4. Total participant count for ready room
    total_participants = len(get_all_tournament_entries())

    screen_payload = {
        "status": status,
        "tiers": {
            "tier1": [s for s in top32 if s["tier"] == 1],
            "tier2": [s for s in top32 if s["tier"] == 2],
            "tier3": [s for s in top32 if s["tier"] == 3],
            "total_top32": len(top32),
        },
        "base_standings": base_standings,
        "round_matches": round_matches,
        "highlight": highlight_replay,
        "bracket": bracket,
        "total_participants": total_participants,
    }

    with _cache_lock:
        _CACHE["screen"] = screen_payload

    return screen_payload
