"""MiniCodeWars 007 Tournament Engine.

Implements the tournament system specification (tournament.md):
- Swiss stage (6 rounds): score-bracket pairing, no rematches (backtracking), at most one bye each
- Best of 5 (Swiss, Ro32, Ro16, Ro8) and Best of 7 (Ro4, Finals), strictly capped at regulation length
- Game draw = no game win for either bot; a tied series is decided by the tiebreak chains below
- Merit-based 10-step tiebreaker hierarchy for the Top 32 cut
- Every stage can be re-run or undone; later stages are discarded so results never double count
- Participant code runs in sandboxed processes (the same runner that validated submissions)
- In-memory status caching for high-frequency polling by 500+ clients
"""
import functools
import hashlib
import json
import logging
import random
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from engine import BotRunner, load_config, run_match
from engine.rules import FUMBLE
from engine.sandbox import SandboxBot

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

STAGE_SWISS = [f"{STAGE_SWISS_PREFIX}{n}" for n in range(1, SWISS_ROUNDS + 1)]
SEQUENTIAL_STAGES = STAGE_RO8 + STAGE_RO4 + [STAGE_FINALS]
# The one true order of the show. Advancing moves one step along it; undo moves one step back.
STAGES = [STAGE_READY] + STAGE_SWISS + [STAGE_CUT_CEREMONY, STAGE_RO32, STAGE_RO16] + SEQUENTIAL_STAGES + [STAGE_CHAMPION]
ROUND_NUMBERS = {
    **{s: n for n, s in enumerate(STAGE_SWISS, start=1)},
    STAGE_CUT_CEREMONY: SWISS_ROUNDS,
    STAGE_RO32: 7, STAGE_RO16: 8,
    **{s: 9 + i for i, s in enumerate(STAGE_RO8)},
    **{s: 13 + i for i, s in enumerate(STAGE_RO4)},
    STAGE_FINALS: 15, STAGE_CHAMPION: 15,
}

# Standard 32-player seeding: 1 and 2 can only meet in the final.
SEED_PAIRS = [
    (1, 32), (16, 17), (8, 25), (9, 24),
    (4, 29), (13, 20), (5, 28), (12, 21),
    (2, 31), (15, 18), (7, 26), (10, 23),
    (3, 30), (14, 19), (6, 27), (11, 22),
]

# Timing constants for playback
TURN_MS = 750
GAME_PAUSE_MS = 2500
MATCH_END_PAUSE_MS = 5000
# Spec: a parallel round should take roughly 40-50s. The marquee duel sets the round's length,
# so prefer marquee candidates whose playback fits in this window.
ROUND_TARGET_MS = 50000

# Bots run in their own processes; a match keeps about one core busy, so don't oversubscribe
# the CPU or honest bots start missing the move deadline.
MATCH_WORKERS = max(2, settings.MAX_PARALLEL_MATCHES)

# In-Memory Cache for ultra-fast polling across 500+ laptops. Every write bumps _GEN, and a
# builder only stores its result if nothing was written while it was building. Swiss standings
# (expensive: they parse every Swiss replay) only change with Swiss results, so they have their
# own generation, _SGEN.
_cache_lock = threading.RLock()
_GEN = 0
_SGEN = 0
_CACHE: Dict[str, Any] = {"status": None, "screen": None, "screen_body": None, "standings": {}, "participant_matches": None}

# Only one stage computation at a time (double clicks, two admins).
_advance_lock = threading.Lock()


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
    opponents: List[int] = field(default_factory=list)
    defeated_opponents: List[int] = field(default_factory=list)
    had_bye: bool = False


def _tier_for_rank(rank: int) -> int:
    return 1 if rank <= 8 else (2 if rank <= 20 else 3)


def _stage_index(stage: str) -> int:
    try:
        return STAGES.index(stage)
    except ValueError:
        raise ValueError(f"unknown tournament stage {stage!r}")


def _playback_ms(games: List[Dict[str, Any]]) -> int:
    return sum(len(g.get("turns", [])) * TURN_MS + GAME_PAUSE_MS for g in games)


def _turn_fumbled(t: Dict[str, Any], side: int) -> bool:
    actions = t.get("actions") or []
    errors = t.get("errors") or []
    return (len(actions) > side and actions[side] == FUMBLE) or (len(errors) > side and bool(errors[side]))


# --- Database State ----------------------------------------------------------------------

def _init_tournament_state():
    """Ensures tournament_state row exists in DB."""
    with db.connect() as c:
        c.execute("""
            INSERT OR IGNORE INTO tournament_state(id, stage, round_number, started_at, paused, paused_at,
                                                   accumulated_pause, highlight_match_id, turn_step, updated_at)
            VALUES(1, ?, 0, NULL, 0, NULL, 0, NULL, -1, ?)
        """, (STAGE_READY, time.time()))


def get_raw_state() -> Dict[str, Any]:
    _init_tournament_state()
    with db.connect() as c:
        row = c.execute("SELECT * FROM tournament_state WHERE id = 1").fetchone()
        return dict(row)


def update_state(**kwargs):
    _init_tournament_state()
    with db.connect() as c:
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        vals = list(kwargs.values())
        vals.append(time.time())
        c.execute(f"UPDATE tournament_state SET {sets}, updated_at = ? WHERE id = 1", vals)
    invalidate_cache()


def _enter_stage(stage: str, started_at: Optional[float], highlight_match_id: Optional[int]):
    """Makes `stage` the live stage with a fresh, unpaused playback clock."""
    update_state(
        stage=stage,
        round_number=ROUND_NUMBERS.get(stage, 0),
        started_at=started_at,
        paused=0,
        paused_at=None,
        accumulated_pause=0,
        highlight_match_id=highlight_match_id,
        turn_step=-1,
    )


# --- Entries & Standings -----------------------------------------------------------------

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


def _tournament_entries() -> List[ParticipantEntry]:
    """The field: everyone entered, frozen to the Round 1 roster once Round 1 has been played,
    so a late registration can't join mid-Swiss and skew pairings or standings."""
    entries = get_all_tournament_entries()
    with db.connect() as c:
        rows = c.execute("SELECT p1_id, p2_id FROM tournament_matches WHERE stage = ?",
                         (STAGE_SWISS[0],)).fetchall()
    roster = {r["p1_id"] for r in rows} | {r["p2_id"] for r in rows if r["p2_id"]}
    return [e for e in entries if e.id in roster] if roster else entries


def calculate_seed_hash(bot_id: int, seed: int = 12345) -> str:
    return hashlib.sha256(f"{bot_id}:{seed}".encode()).hexdigest()


def compute_standings_from_history(round_num: int) -> List[Standing]:
    """Computes full 10-tier merit standings from all Swiss matches up to round_num."""
    with _cache_lock:
        gen = _SGEN
        memo = _CACHE["standings"].get(round_num)
    if memo is not None:
        return list(memo)

    entries = _tournament_entries()
    standings: Dict[int, Standing] = {
        e.id: Standing(participant_id=e.id, name=e.name, bot_name=e.bot_name or e.name)
        for e in entries
    }
    if not standings:
        return []

    with db.connect() as c:
        matches = c.execute("""
            SELECT m.* FROM tournament_matches m
            JOIN tournament_rounds r ON r.id = m.round_id
            WHERE r.round_number <= ? AND m.stage LIKE 'swiss_%' AND r.status != 'rolled_back'
            ORDER BY m.id ASC
        """, (min(round_num, SWISS_ROUNDS),)).fetchall()

    start_hp = CFG.start_hp
    for m in matches:
        p1_id, p2_id = m["p1_id"], m["p2_id"]
        is_bye = bool(m["is_bye"])
        p1_s, p2_s = m["p1_score"], m["p2_score"]
        winner = m["winner_id"]
        s1 = standings.get(p1_id)
        s2 = standings.get(p2_id) if (p2_id and not is_bye) else None

        if s1:
            s1.game_wins += p1_s
            s1.game_losses += p2_s
            if is_bye:
                s1.match_wins += 1
                s1.had_bye = True
                s1.damage_dealt += p1_s * start_hp  # a clean 3-0 sweep
            else:
                if winner == p1_id:
                    s1.match_wins += 1
                    s1.defeated_opponents.append(p2_id)
                else:
                    s1.match_losses += 1
                s1.opponents.append(p2_id)

        if s2:
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
            games = json.loads(m["replay_json"]) if m["replay_json"] else []
        except ValueError:
            games = []
        for g in games:
            result = g.get("result", {})
            final = result.get("final") or [{}, {}]
            turns = g.get("turns", [])
            g_winner = result.get("winner")
            for side, s in ((0, s1), (1, s2)):
                if not s:
                    continue
                s.damage_dealt += final[side].get("damage_dealt", 0)
                s.damage_taken += start_hp - final[side].get("hp", start_hp)
                s.fumbles += sum(1 for t in turns if _turn_fumbled(t, side))
                if g_winner == side:
                    s.knockout_turns += len(turns)
                    s.knockout_wins += 1

    # Compute Buchholz (sum of opponents' match wins) & Sonneborn-Berger with Bye adjustment
    for s in standings.values():
        s.buchholz = sum(standings[opp].match_wins for opp in s.opponents if opp in standings)
        s.sonneborn = sum(standings[opp].match_wins for opp in s.defeated_opponents if opp in standings)
        if s.had_bye:
            bye_virt = max(1.0, round_num * 0.5)  # a virtual opponent with an even record
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

    ranked = sorted(standings.values(), key=functools.cmp_to_key(compare_standings))
    for idx, s in enumerate(ranked):
        s.rank = idx + 1
        s.tier = _tier_for_rank(s.rank)

    with _cache_lock:
        if _SGEN == gen:
            _CACHE["standings"][round_num] = ranked
    return list(ranked)


def _standings_rows(round_number: int) -> List[Dict[str, Any]]:
    """Stored standings for a Swiss round, bot names only (roll numbers and real names stay private)."""
    with db.connect() as c:
        rows = c.execute("""
            SELECT s.participant_id, s.match_wins, s.match_losses, s.game_wins, s.game_losses,
                   s.damage_dealt, s.damage_taken, s.fumbles, s.tier, s.rank, p.bot_name
            FROM tournament_standings s
            JOIN participants p ON p.id = s.participant_id
            WHERE s.round_number = ?
            ORDER BY s.rank ASC
        """, (round_number,)).fetchall()
        return [dict(r) for r in rows]


def get_latest_standings() -> List[Dict[str, Any]]:
    rnd = min(get_raw_state()["round_number"], SWISS_ROUNDS)
    if rnd <= 0:
        return []
    with db.connect() as c:
        max_r = c.execute("SELECT MAX(round_number) AS r FROM tournament_standings").fetchone()["r"] or 0
    return _standings_rows(min(rnd, max_r))


# --- Swiss Pairing -------------------------------------------------------------------------

def _pair_players(players: List[int], score: Dict[int, int], played: set,
                  budget: int = 200_000) -> List[Tuple[int, int]]:
    """Pairs players (given best-first) inside their score bracket without rematches.

    Depth-first: the best unpaired player takes the nearest-ranked opponent with the closest score
    that they haven't met, backtracking when that leaves the rest unpairable. An odd bracket
    naturally floats its last player down to the top of the next bracket. If no rematch-free
    pairing is found within the budget, rematches are allowed as a last resort (never double
    booking anyone).
    """
    steps = 0

    def dfs(unpaired: List[int]) -> Optional[List[Tuple[int, int]]]:
        nonlocal steps
        if not unpaired:
            return []
        p, rest = unpaired[0], unpaired[1:]
        order = sorted(range(len(rest)), key=lambda j: (abs(score[p] - score[rest[j]]), j))
        for j in order:
            q = rest[j]
            if (min(p, q), max(p, q)) in played:
                continue
            steps += 1
            if steps > budget:
                return None
            sub = dfs(rest[:j] + rest[j + 1:])
            if sub is not None:
                return [(p, q)] + sub
        return None

    result = dfs(list(players))
    if result is not None:
        return result

    logger.warning("Swiss pairing: no rematch-free pairing found, allowing rematches")
    pairs, rest = [], list(players)
    while len(rest) >= 2:
        p = rest.pop(0)
        order = sorted(range(len(rest)), key=lambda j: (
            (min(p, rest[j]), max(p, rest[j])) in played, abs(score[p] - score[rest[j]]), j))
        pairs.append((p, rest.pop(order[0])))
    return pairs


def pair_swiss_round(round_number: int) -> Tuple[List[Tuple[ParticipantEntry, Optional[ParticipantEntry]]], Optional[ParticipantEntry]]:
    """Pairs participants for a Swiss round. Returns (pairings best-first, bye entry).
    The bye (if any) is the last pairing, as (entry, None)."""
    entries = _tournament_entries()
    if not entries:
        return [], None
    entry_by_id = {e.id: e for e in entries}

    with db.connect() as c:
        rows = c.execute("""
            SELECT p1_id, p2_id, is_bye FROM tournament_matches
            WHERE stage LIKE 'swiss_%'
        """).fetchall()
    played = set()
    had_bye = set()
    for m in rows:
        if m["is_bye"]:
            had_bye.add(m["p1_id"])
        elif m["p2_id"]:
            played.add((min(m["p1_id"], m["p2_id"]), max(m["p1_id"], m["p2_id"])))

    if round_number == 1:
        order = [e.id for e in entries]
        random.Random(42).shuffle(order)
        score = {pid: 0 for pid in order}
    else:
        standings = compute_standings_from_history(round_number - 1)
        order = [s.participant_id for s in standings if s.participant_id in entry_by_id]
        score = {s.participant_id: s.match_wins for s in standings}

    bye_id = None
    if len(order) % 2:
        # Lowest-placed player who hasn't had a bye yet (nobody gets two).
        bye_id = next((pid for pid in reversed(order) if pid not in had_bye), order[-1])
        order.remove(bye_id)

    if round_number == 1:
        half = len(order) // 2
        id_pairs = [(order[i], order[i + half]) for i in range(half)]
    else:
        id_pairs = _pair_players(order, score, played)

    pairings: List[Tuple[ParticipantEntry, Optional[ParticipantEntry]]] = [
        (entry_by_id[a], entry_by_id[b]) for a, b in id_pairs
    ]
    bye_entry = entry_by_id[bye_id] if bye_id is not None else None
    if bye_entry:
        pairings.append((bye_entry, None))
    return pairings, bye_entry


# --- Match Series Execution (Bo5 & Bo7) ------------------------------------------------

class _Contestant:
    """One participant's bot for a whole series. Runs sandboxed (separate, limited process, the
    same runner that validated the submission) and gets fresh memory for every game."""

    def __init__(self, entry: ParticipantEntry):
        self.entry = entry
        self.filename = f"{entry.bot_name}.py"
        self.sandbox = None
        self._fresh = True
        try:
            self.sandbox = SandboxBot(entry.code, CFG, filename=self.filename)
        except OSError:
            logger.exception("could not start a sandbox for %s; running it in-process", entry.bot_name)

    def for_game(self):
        if self.sandbox is None:
            return BotRunner(self.entry.code, filename=self.filename, print_limit=CFG.print_chars_per_turn,
                             safe=True, timeout_ms=CFG.move_timeout_ms)
        if not self._fresh:
            self.sandbox.new_match()
        self._fresh = False
        return self.sandbox

    def close(self):
        if self.sandbox is not None:
            self.sandbox.close()


def _slim_replay(replay: Dict[str, Any]) -> Dict[str, Any]:
    """Keeps what playback and stats need; drops the config copy and bots' print output."""
    replay.pop("config", None)
    for t in replay.get("turns", []):
        t.pop("output", None)
    return replay


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
    - Engine game draw: neither bot gets a game win
    - Tied series (Swiss): 10-tier merit history decides the match point
    - Tied series (Elimination): in-match damage, HP, fumbles, then merit history, seed, hash
    """
    if p2 is None:
        # Bye: automatic clean sweep
        return {
            "p1_id": p1.id,
            "p2_id": None,
            "is_bye": True,
            "p1_score": wins_required,
            "p2_score": 0,
            "winner_id": p1.id,
            "draw_reason": None,
            "games": [],
            "highlight_score": 0.0,
            "p1_damage": wins_required * CFG.start_hp,
            "p2_damage": 0,
        }

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

    c1, c2 = _Contestant(p1), None
    try:
        c2 = _Contestant(p2)
        for game_idx in range(1, max_games + 1):
            replay = run_match([c1.for_game(), c2.for_game()], CFG, seed=seed_base + game_idx,
                               names=(p1.bot_name, p2.bot_name))
            games.append(_slim_replay(replay))

            winner = replay["result"]["winner"]
            final = replay["result"]["final"]
            turns = replay["turns"]

            p1_total_damage += final[0]["damage_dealt"]
            p2_total_damage += final[1]["damage_dealt"]
            p1_total_hp += final[0]["hp"]
            p2_total_hp += final[1]["hp"]
            p1_fumbles += sum(1 for t in turns if _turn_fumbled(t, 0))
            p2_fumbles += sum(1 for t in turns if _turn_fumbled(t, 1))

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
    finally:
        c1.close()
        if c2:
            c2.close()

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
    pairings: List[Tuple[int, ParticipantEntry, Optional[ParticipantEntry]]],
    max_games: int = 5,
    wins_required: int = 3,
    is_swiss: bool = True,
    history: Optional[Dict[int, Any]] = None,
    cancel: Optional[threading.Event] = None,
) -> List[Dict[str, Any]]:
    """Runs all (match_index, p1, p2) pairings in parallel. Results keep the pairings' order.
    Once `cancel` is set, matches that haven't started are skipped (their result is None)."""

    def task(item):
        if cancel is not None and cancel.is_set():
            return None
        idx, p1, p2 = item
        seed = 10000 * round_number + idx * 10
        series = run_match_series(p1, p2, max_games, wins_required, is_swiss, seed, history, round_number)
        series["match_index"] = idx
        series["stage"] = stage_name
        return series

    with ThreadPoolExecutor(max_workers=MATCH_WORKERS) as pool:
        return list(pool.map(task, pairings))


def _pick_highlight(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The most exciting match whose playback fits the round's time budget (else the shortest)."""
    pool = [m for m in candidates if not m["is_bye"]]
    if not pool:
        return candidates[0] if candidates else None
    fitting = [m for m in pool if _playback_ms(m["games"]) <= ROUND_TARGET_MS]
    if fitting:
        return max(fitting, key=lambda m: m["highlight_score"])
    return min(pool, key=lambda m: (_playback_ms(m["games"]), -m["highlight_score"]))


# Changes whenever stored results change, so a prefetched stage can tell whether it was
# computed from the results that are stored now.
_results_version = 0


def _bump_results_version():
    global _results_version
    with _cache_lock:
        _results_version += 1


def _store_round(stage_name: str, results: List[Dict[str, Any]], highlight: Optional[Dict[str, Any]],
                 started_at: float) -> Optional[int]:
    """Saves a round and its matches in one transaction. Returns the highlight's DB id."""
    highlight_db_id = None
    with db.connect() as c:
        cur = c.execute("""
            INSERT INTO tournament_rounds(stage, round_number, status, started_at)
            VALUES(?, ?, 'running', ?)
        """, (stage_name, ROUND_NUMBERS[stage_name], started_at))
        round_id = cur.lastrowid
        for m in results:
            cur_m = c.execute("""
                INSERT INTO tournament_matches(round_id, stage, match_index, p1_id, p2_id, is_bye,
                                              p1_score, p2_score, winner_id, draw_reason, replay_json, highlight_score)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                round_id, stage_name, m["match_index"], m["p1_id"], m["p2_id"], 1 if m["is_bye"] else 0,
                m["p1_score"], m["p2_score"], m["winner_id"], m["draw_reason"],
                json.dumps(m["games"], separators=(",", ":")), m["highlight_score"]
            ))
            if highlight is not None and m is highlight:
                highlight_db_id = cur_m.lastrowid
        # Remembered so Undo can restore this stage's marquee duel.
        c.execute("UPDATE tournament_rounds SET snapshot_json = ? WHERE id = ?",
                  (json.dumps({"highlight_match_id": highlight_db_id}), round_id))
    _bump_results_version()
    invalidate_cache(standings=stage_name in STAGE_SWISS)
    return highlight_db_id


def _rollback_from(stage: str):
    """Deletes every result of `stage` and all later stages."""
    later = STAGES[_stage_index(stage):]
    marks = ",".join("?" * len(later))
    with db.connect() as c:
        deleted = c.execute(f"DELETE FROM tournament_matches WHERE stage IN ({marks})", later).rowcount
        deleted += c.execute(f"DELETE FROM tournament_rounds WHERE stage IN ({marks})", later).rowcount
        if stage in STAGE_SWISS:
            c.execute("DELETE FROM tournament_standings WHERE round_number >= ?", (ROUND_NUMBERS[stage],))
    if deleted:
        _bump_results_version()
    invalidate_cache(standings=stage in STAGE_SWISS)


# --- Stage computation -----------------------------------------------------------------
# Computing a stage (pairing + playing every match) only reads the database; committing it
# stores the results and puts it live. That split lets the next stage be computed in the
# background while the current one plays on screen.

COMPUTED_STAGES = set(STAGE_SWISS) | {STAGE_RO32, STAGE_RO16} | set(SEQUENTIAL_STAGES)


class _Cancelled(Exception):
    pass


def _compute_stage(stage: str, cancel: Optional[threading.Event] = None) -> Dict[str, Any]:
    """Pairs and plays every match of `stage` from the results stored so far. Writes nothing."""
    rnd = ROUND_NUMBERS[stage]
    results: List[Dict[str, Any]] = []
    highlight = None
    if stage in STAGE_SWISS:
        pairings, _ = pair_swiss_round(rnd)
        if not pairings:
            raise ValueError("No eligible tournament entries found to pair.")
        history = {s.participant_id: s for s in compute_standings_from_history(rnd - 1)} if rnd > 1 else {}
        results = precompute_round_matches(rnd, stage, [(i, p1, p2) for i, (p1, p2) in enumerate(pairings)],
                                           5, 3, True, history, cancel)
        if cancel is not None and cancel.is_set():
            raise _Cancelled()
        # Marquee duel from the top of the field (pairings are best-first), without saying so on screen.
        non_bye = [m for m in results if not m["is_bye"]]
        highlight = _pick_highlight(non_bye[:max(4, len(non_bye) // 4)] or results)
    else:
        pairings = _elimination_pairings(stage)
        history = {s.participant_id: s for s in compute_standings_from_history(SWISS_ROUNDS)}
        if stage in (STAGE_RO32, STAGE_RO16):
            if not pairings:
                raise ValueError("No one qualified for the elimination bracket.")
            results = precompute_round_matches(rnd, stage, pairings, 5, 3, False, history, cancel)
            if cancel is not None and cancel.is_set():
                raise _Cancelled()
            highlight = _pick_highlight(results)
        elif pairings:  # one sequential match; Semi-Finals and the Grand Finale are Best of 7
            best_of_7 = stage in STAGE_RO4 or stage == STAGE_FINALS
            _, w1, w2 = pairings[0]
            series = run_match_series(w1, w2, 7 if best_of_7 else 5, 4 if best_of_7 else 3,
                                      is_swiss=False, seed_base=10000 * rnd, history=history, round_number=rnd)
            series.update(match_index=0, stage=stage, highlight_score=100.0)
            results, highlight = [series], series
    return {"results": results, "highlight": highlight}


def _commit_stage(stage: str, computed: Dict[str, Any]):
    """Stores a computed stage (and, for Swiss, the standings after it) and puts it live."""
    now = time.time()
    highlight_db_id = None
    if computed["results"]:
        highlight_db_id = _store_round(stage, computed["results"], computed["highlight"], now)
    if stage in STAGE_SWISS:
        rnd = ROUND_NUMBERS[stage]
        standings = compute_standings_from_history(rnd)
        with db.connect() as c:
            c.execute("DELETE FROM tournament_standings WHERE round_number = ?", (rnd,))
            c.executemany("""
                INSERT INTO tournament_standings(round_number, participant_id, match_wins, match_losses,
                                                game_wins, game_losses, buchholz, sonneborn, damage_dealt,
                                                damage_taken, fumbles, knockout_turns, tier, rank)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, [(
                rnd, s.participant_id, s.match_wins, s.match_losses,
                s.game_wins, s.game_losses, s.buchholz, s.sonneborn, s.damage_dealt,
                s.damage_taken, s.fumbles, s.knockout_turns, s.tier, s.rank
            ) for s in standings])
    _enter_stage(stage, now, highlight_db_id)


def _prefetch_key() -> Tuple[int, str]:
    """What a stage's computation depends on: the stored results and every entry's code."""
    with _cache_lock:
        version = _results_version
    entries = [(e.id, e.submission_id, e.bot_name) for e in get_all_tournament_entries()]
    return version, hashlib.sha256(repr(entries).encode()).hexdigest()


class _Prefetch:
    def __init__(self, stage: str, version: Tuple[int, str]):
        self.stage = stage
        self.version = version
        self.cancel = threading.Event()
        self.done = threading.Event()
        self.result: Optional[Dict[str, Any]] = None
        self.error: Optional[BaseException] = None


_prefetch: Optional[_Prefetch] = None
_prefetch_lock = threading.Lock()


def _cancel_prefetch():
    global _prefetch
    with _prefetch_lock:
        job, _prefetch = _prefetch, None
    if job:
        job.cancel.set()


def _start_prefetch():
    """Starts computing the stage after the live one, so advancing to it is instant."""
    global _prefetch
    _cancel_prefetch()
    idx = _stage_index(get_raw_state()["stage"])
    nxt = STAGES[idx + 1] if idx + 1 < len(STAGES) else None
    if nxt not in COMPUTED_STAGES:
        return
    job = _Prefetch(nxt, _prefetch_key())

    def run():
        try:
            job.result = _compute_stage(nxt, job.cancel)
        except _Cancelled as e:
            job.error = e
        except Exception as e:  # advancing computes it again and reports the error to the host
            logger.exception("prefetching %s failed", nxt)
            job.error = e
        finally:
            job.done.set()

    with _prefetch_lock:
        _prefetch = job
    threading.Thread(target=run, name=f"prefetch-{nxt}", daemon=True).start()


def _take_prefetch(stage: str) -> Optional[Dict[str, Any]]:
    """The prefetched computation of `stage` (waiting for it if needed), provided it was
    computed from the results stored now; otherwise None."""
    global _prefetch
    with _prefetch_lock:
        job, _prefetch = _prefetch, None
    if job is None:
        return None
    if job.stage != stage or job.version != _prefetch_key():
        job.cancel.set()
        return None
    job.done.wait()
    return job.result if job.error is None else None


# --- Tournament Progression & State Machine --------------------------------------------

def start_tournament() -> Dict[str, Any]:
    """Initializes tournament to ready_room, purging past matches, rounds, and standings."""
    _cancel_prefetch()
    _init_tournament_state()
    with db.connect() as c:
        c.execute("DELETE FROM tournament_matches")
        c.execute("DELETE FROM tournament_rounds")
        c.execute("DELETE FROM tournament_standings")
    _bump_results_version()
    invalidate_cache(standings=True)
    _enter_stage(STAGE_READY, None, None)
    _start_prefetch()
    return get_screen_data()


def advance_to_cut_ceremony():
    """Transitions from Swiss stage to the Top 32 Cut Ceremony."""
    with db.connect() as c:
        done = c.execute("SELECT 1 FROM tournament_rounds WHERE stage = ?", (STAGE_SWISS[-1],)).fetchone()
    if not done:
        raise ValueError(f"Swiss round {SWISS_ROUNDS} hasn't been played yet")
    _enter_stage(STAGE_CUT_CEREMONY, time.time(), None)


# --- Elimination bracket -------------------------------------------------------------------
# A bracket node is (stage, match_index). Ro32/Ro16 are parallel stages with 16/8 matches;
# every later match is its own sequential stage with match_index 0.

def _elim_nodes() -> List[Tuple[str, int]]:
    return ([(STAGE_RO32, i) for i in range(16)] + [(STAGE_RO16, i) for i in range(8)]
            + [(s, 0) for s in SEQUENTIAL_STAGES])


def _feeders(node: Tuple[str, int]) -> Optional[Tuple[Tuple[str, int], Tuple[str, int]]]:
    stage, idx = node
    if stage == STAGE_RO16:
        return (STAGE_RO32, 2 * idx), (STAGE_RO32, 2 * idx + 1)
    if stage in STAGE_RO8:
        k = STAGE_RO8.index(stage)
        return (STAGE_RO16, 2 * k), (STAGE_RO16, 2 * k + 1)
    if stage in STAGE_RO4:
        k = STAGE_RO4.index(stage)
        return (STAGE_RO8[2 * k], 0), (STAGE_RO8[2 * k + 1], 0)
    if stage == STAGE_FINALS:
        return (STAGE_RO4[0], 0), (STAGE_RO4[1], 0)
    return None


def _elim_rows() -> Dict[Tuple[str, int], Dict[str, Any]]:
    with db.connect() as c:
        rows = c.execute("""
            SELECT m.* FROM tournament_matches m
            WHERE m.stage IN ({})
            ORDER BY m.id ASC
        """.format(",".join("?" * (len(SEQUENTIAL_STAGES) + 2))),
            [STAGE_RO32, STAGE_RO16] + SEQUENTIAL_STAGES).fetchall()
    return {(r["stage"], r["match_index"]): dict(r) for r in rows}


def _swiss_seeds() -> Dict[int, int]:
    """participant_id -> final Swiss rank."""
    return {s.participant_id: s.rank for s in compute_standings_from_history(SWISS_ROUNDS)}


def _node_entrants(node, rows, seeds_by_rank) -> Tuple[Optional[int], Optional[int]]:
    """Who plays in a bracket node: seeds for Ro32, else the winners of the two feeder matches."""
    stage, idx = node
    if stage == STAGE_RO32:
        s1, s2 = SEED_PAIRS[idx]
        return seeds_by_rank.get(s1), seeds_by_rank.get(s2)
    f1, f2 = _feeders(node)
    return ((rows.get(f1) or {}).get("winner_id"), (rows.get(f2) or {}).get("winner_id"))


def _elimination_pairings(stage_name: str) -> List[Tuple[int, ParticipantEntry, Optional[ParticipantEntry]]]:
    """Pairings for an elimination stage, each carrying its Swiss seed for tiebreaks.
    advance_stage() guarantees the feeder stages have been played."""
    rows = _elim_rows()
    seeds = _swiss_seeds()
    seeds_by_rank = {rank: pid for pid, rank in seeds.items() if rank <= TOP_CUT_COUNT}
    entries = {e.id: e for e in _tournament_entries()}
    pairings = []
    for node in _elim_nodes():
        if node[0] != stage_name:
            continue
        a, b = _node_entrants(node, rows, seeds_by_rank)
        e1, e2 = entries.get(a), entries.get(b)
        if e1 is None:  # a lone entrant always sits in slot 1 and gets a bye
            e1, e2 = e2, None
        if e1 is None:
            continue
        for e in (e1, e2):
            if e:
                e.rank = seeds.get(e.id, 999)
        pairings.append((node[1], e1, e2))
    return pairings


def build_elimination_bracket() -> Dict[str, Any]:
    """The single elimination bracket (Ro32, Ro16, Ro8, Ro4, Finals) with results so far.

    Nothing about a match that is still playing leaks into later rounds: a slot only shows its
    entrant once the feeder match's stage is over. Real names appear only in the Elite 8 onwards.
    """
    state = get_raw_state()
    curr_idx = _stage_index(state["stage"])
    if curr_idx < _stage_index(STAGE_CUT_CEREMONY):
        return {"ro32": [], "ro16": [], "ro8": [], "ro4": [], "finals": []}

    entries = {e.id: e for e in _tournament_entries()}
    seeds = _swiss_seeds()
    seeds_by_rank = {rank: pid for pid, rank in seeds.items() if rank <= TOP_CUT_COUNT}
    rows = _elim_rows()
    names_revealed = curr_idx >= _stage_index(STAGE_RO8[0])

    # Background matches are compressed to finish before the marquee duel.
    hl_id = state.get("highlight_match_id")
    target_max_ms = 35000
    for r in rows.values():
        if r["id"] == hl_id:
            hl_ms = _playback_ms(json.loads(r["replay_json"] or "[]"))
            if hl_ms > 10000:
                target_max_ms = max(18000, hl_ms - 2000)
            break

    def participant(pid, with_name):
        e = entries.get(pid)
        if not e:
            return None
        info = {"participant_id": e.id, "bot_name": e.bot_name, "seed": seeds.get(e.id)}
        if with_name:
            info["name"] = e.name
        return info

    def timeline(m_row):
        try:
            games = json.loads(m_row["replay_json"] or "[]")
        except ValueError:
            return [], 0
        raw_total = _playback_ms(games)
        if m_row["id"] == hl_id or raw_total <= target_max_ms:
            scale = 1.0
        else:
            stagger = (m_row["id"] % 5) * 500
            scale = max(0.2, (target_max_ms - stagger) / raw_total)
        out, elapsed, score = [], 0, [0, 0]
        for g_idx, g in enumerate(games):
            w = g.get("result", {}).get("winner")
            if w in (0, 1):
                score[w] += 1
            # A game's result shows when its last turn lands, like the arena's series score.
            out.append({"game": g_idx + 1, "finish_ms": int((elapsed + len(g.get("turns", [])) * TURN_MS) * scale),
                        "score": list(score), "winner": w})
            elapsed += len(g.get("turns", [])) * TURN_MS + GAME_PAUSE_MS
        return out, int(raw_total * scale)

    def node_info(node):
        stage, idx = node
        with_name = names_revealed and stage in SEQUENTIAL_STAGES
        a, b = _node_entrants(node, rows, seeds_by_rank)
        feeders = _feeders(node)
        if feeders:
            # Hide an entrant whose feeder match is still being played (or not played yet).
            a = a if _stage_index(feeders[0][0]) < curr_idx else None
            b = b if _stage_index(feeders[1][0]) < curr_idx else None
        m_row = rows.get(node)
        info = {
            "match_id": idx,
            "stage": stage,
            "p1": participant(a, with_name),
            "p2": participant(b, with_name),
            "winner_id": None,
            "draw_reason": None,
            "score": [0, 0] if _stage_index(stage) <= curr_idx else ["-", "-"],
            "is_complete": False,
            "timeline": [],
            "finish_ms": 0,
        }
        if stage == STAGE_RO32:
            info["seed1"], info["seed2"] = SEED_PAIRS[idx]
        if m_row:
            info.update({
                "p1": participant(m_row["p1_id"], with_name),
                "p2": participant(m_row["p2_id"], with_name),
                "winner_id": m_row["winner_id"],
                "draw_reason": m_row["draw_reason"],
                "score": [m_row["p1_score"], m_row["p2_score"]],
                "is_complete": True,
                "is_bye": bool(m_row["is_bye"]),
            })
            info["timeline"], info["finish_ms"] = timeline(m_row)
        return info

    infos = {node: node_info(node) for node in _elim_nodes()}
    return {
        "ro32": [infos[(STAGE_RO32, i)] for i in range(16)],
        "ro16": [infos[(STAGE_RO16, i)] for i in range(8)],
        "ro8": [infos[(s, 0)] for s in STAGE_RO8],
        "ro4": [infos[(s, 0)] for s in STAGE_RO4],
        "finals": [infos[(STAGE_FINALS, 0)]],
    }


def advance_to_champion():
    with db.connect() as c:
        row = c.execute("SELECT id FROM tournament_matches WHERE stage = ?", (STAGE_FINALS,)).fetchone()
    if not row:
        raise ValueError("The Grand Finale hasn't been played yet")
    _enter_stage(STAGE_CHAMPION, time.time(), row["id"])


def advance_stage(target_stage: Optional[str] = None) -> Dict[str, Any]:
    """Advances to the next stage, or re-runs `target_stage` (the next stage or any earlier one).
    Re-running a stage discards its old results and everything after it first."""
    if not _advance_lock.acquire(blocking=False):
        raise ValueError("Still computing the previous stage; wait for it to finish.")
    try:
        curr_idx = _stage_index(get_raw_state()["stage"])
        if target_stage is None:
            if curr_idx + 1 >= len(STAGES):
                raise ValueError("The tournament is complete.")
            target_stage = STAGES[curr_idx + 1]
        target_idx = _stage_index(target_stage)
        if target_idx > curr_idx + 1:
            raise ValueError(f"Can't jump to {target_stage}: run {STAGES[curr_idx + 1]} first.")

        if target_stage == STAGE_READY:
            return start_tournament()
        _rollback_from(target_stage)  # nothing to delete when moving forward, so a prefetch stays valid
        if target_stage in COMPUTED_STAGES:
            computed = _take_prefetch(target_stage) or _compute_stage(target_stage)
            _commit_stage(target_stage, computed)
        elif target_stage == STAGE_CUT_CEREMONY:
            advance_to_cut_ceremony()
        else:
            advance_to_champion()
        _start_prefetch()
        return get_screen_data()
    finally:
        _advance_lock.release()


def undo_stage() -> Dict[str, Any]:
    """Undoes the current stage: its results are deleted and the previous stage is shown again,
    already finished. Advancing afterwards re-runs the undone stage from scratch."""
    if not _advance_lock.acquire(blocking=False):
        raise ValueError("Still computing a stage; wait for it to finish.")
    try:
        stage = get_raw_state()["stage"]
        curr_idx = _stage_index(stage)
        if curr_idx == 0:
            raise ValueError("Nothing to undo.")
        _rollback_from(stage)
        prev = STAGES[curr_idx - 1]
        started_at, highlight_id = time.time() - 3600, None
        with db.connect() as c:
            row = c.execute("SELECT started_at, snapshot_json FROM tournament_rounds WHERE stage = ? "
                            "ORDER BY id DESC LIMIT 1", (prev,)).fetchone()
        if row:
            started_at = row["started_at"]
            highlight_id = json.loads(row["snapshot_json"] or "{}").get("highlight_match_id")
        elif prev == STAGE_READY:
            started_at = None
        elif prev == STAGE_CUT_CEREMONY:
            started_at = time.time()
        _enter_stage(prev, started_at, highlight_id)
        _start_prefetch()
        return get_screen_data()
    finally:
        _advance_lock.release()


# --- Panic Pause & Turn Step Controller --------------------------------------------

def toggle_pause(paused_val: Optional[bool] = None) -> Dict[str, Any]:
    state = get_raw_state()
    is_paused = bool(state["paused"])
    new_paused = not is_paused if paused_val is None else paused_val

    now = time.time()
    if new_paused and not is_paused:
        update_state(paused=1, paused_at=now)
    elif not new_paused and is_paused:
        p_at = state["paused_at"] or now
        acc = state["accumulated_pause"] + (now - p_at)
        update_state(paused=0, paused_at=None, accumulated_pause=acc)

    return get_tournament_status()


def _highlight_games(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not state["highlight_match_id"]:
        return []
    with db.connect() as c:
        row = c.execute("SELECT replay_json FROM tournament_matches WHERE id = ?",
                        (state["highlight_match_id"],)).fetchone()
    return json.loads(row["replay_json"] or "[]") if row else []


def set_turn_step(step: int) -> Dict[str, Any]:
    """Steps the marquee duel to a specific turn (counted across all games), or -1 for auto-play.
    Stepping freezes the clock; returning to auto-play continues from the stepped turn."""
    state = get_raw_state()
    now = time.time()
    games = _highlight_games(state)
    total_turns = sum(len(g.get("turns", [])) for g in games)
    step = max(-1, min(step, total_turns))

    if step >= 0:
        if state["turn_step"] < 0 and not state["paused"]:
            update_state(turn_step=step, paused=1, paused_at=now)
        else:
            update_state(turn_step=step)
    elif state["turn_step"] >= 0:
        # Line the clock up with the stepped turn, so auto-play picks up exactly where the host left it.
        target_ms, remaining = 0, state["turn_step"]
        for g in games:
            n = len(g.get("turns", []))
            if remaining < n:
                target_ms += remaining * TURN_MS
                break
            remaining -= n
            target_ms += n * TURN_MS + GAME_PAUSE_MS
        # Negative when the host stepped ahead of the clock; playback maths handles that fine.
        started_at = state["started_at"] or now
        update_state(turn_step=-1, paused=0, paused_at=None,
                     accumulated_pause=now - started_at - target_ms / 1000)
    return get_tournament_status()


# --- In-Memory Caching & API Response Builders -----------------------------------------

def invalidate_cache(standings: bool = False):
    global _GEN, _SGEN
    with _cache_lock:
        _GEN += 1
        _CACHE["status"] = None
        _CACHE["screen"] = None
        _CACHE["screen_body"] = None
        _CACHE["participant_matches"] = None
        if standings:
            _SGEN += 1
            _CACHE["standings"] = {}


def get_tournament_status() -> Dict[str, Any]:
    """Ultra-fast, zero-DB response cached in memory for 500+ polling clients."""
    now = time.time()
    with _cache_lock:
        gen = _GEN
        if _CACHE["status"] is not None:
            cached = dict(_CACHE["status"])
            cached["server_time"] = now
            if cached.get("paused"):
                p_at = cached.get("paused_at") or now
                cached["accumulated_pause"] = cached.get("base_accumulated_pause", 0) + (now - p_at)
            return cached

    state = get_raw_state()
    stage = state["stage"]
    is_sequential = stage in SEQUENTIAL_STAGES

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
        "reveal_names": is_sequential or stage == STAGE_CHAMPION,
        "turn_step": state["turn_step"],
        "highlight_match_id": state["highlight_match_id"],
        "turn_ms": TURN_MS,
        "game_pause_ms": GAME_PAUSE_MS,
    }

    with _cache_lock:
        if _GEN == gen:
            _CACHE["status"] = status_data
    return status_data


def get_round_timeline_data(round_number: int, stage: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Returns (base_standings, round_matches) for dynamic in-round leaderboard progression.
    base_standings: standings before this round began (so nothing is spoiled at t=0).
    round_matches: list of matches with finish_ms offsets so the client can dynamically
                   apply results as each match's replay would have concluded.
    """
    if stage not in STAGE_SWISS:
        return [], []

    base_standings: List[Dict[str, Any]] = []
    if round_number <= 1:
        # Before Round 1 everyone is 0-0 with no rank yet (so no movement arrows either).
        for e in _tournament_entries():
            base_standings.append({
                "participant_id": e.id, "bot_name": e.bot_name,
                "match_wins": 0, "match_losses": 0, "game_wins": 0, "game_losses": 0,
                "damage_dealt": 0, "fumbles": 0, "rank": 0, "tier": 3, "prev_rank": 0, "delta": 0,
            })
    else:
        for r in _standings_rows(round_number - 1):
            base_standings.append({**r, "prev_rank": r["rank"], "delta": 0})

    round_matches: List[Dict[str, Any]] = []
    with db.connect() as c:
        m_rows = c.execute("""
            SELECT m.*, p1.bot_name as p1_bot, p2.bot_name as p2_bot
            FROM tournament_matches m
            JOIN participants p1 ON p1.id = m.p1_id
            LEFT JOIN participants p2 ON p2.id = m.p2_id
            WHERE m.stage = ?
        """, (stage,)).fetchall()
        hl_id = get_raw_state().get("highlight_match_id")

    marquee_finish_ms = 35000
    raw_matches = []
    for m in m_rows:
        games = json.loads(m["replay_json"]) if m["replay_json"] else []
        raw_ms = 0
        p1_dmg = p2_dmg = p1_fum = p2_fum = 0
        if not m["is_bye"]:
            raw_ms = _playback_ms(games)
            for g in games:
                turns = g.get("turns", [])
                final = g.get("result", {}).get("final") or [{}, {}]
                p1_dmg += final[0].get("damage_dealt", 0)
                p2_dmg += final[1].get("damage_dealt", 0)
                p1_fum += sum(1 for t in turns if _turn_fumbled(t, 0))
                p2_fum += sum(1 for t in turns if _turn_fumbled(t, 1))
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
        elif (hl_id and m["id"] == hl_id) or raw_ms <= max_bg_ms:
            finish_ms = raw_ms
        else:
            # Smoothly distribute long matches so they resolve right before the marquee climax
            stagger = (m["id"] % 5) * 600
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


def _build_screen_payload() -> Dict[str, Any]:
    state = get_raw_state()
    stage = state["stage"]
    rnd = state["round_number"]

    # 1. 3-Tier Board Standings (Top 32), with movement since the previous round
    top32 = get_latest_standings()[:TOP_CUT_COUNT]
    shown_rnd = min(rnd, SWISS_ROUNDS)
    prev_rows: Dict[int, int] = {}
    if shown_rnd > 1:
        prev_rows = {r["participant_id"]: r["rank"] for r in _standings_rows(shown_rnd - 1)}
    for s in top32:
        s["prev_rank"] = prev_rows.get(s["participant_id"], s["rank"])
        s["delta"] = s["prev_rank"] - s["rank"]

    # Dynamic in-round progression data
    base_standings, round_matches = get_round_timeline_data(rnd, stage)

    # 2. Highlight Match Replay. Real names only once the Elite 8 are unveiled.
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
            reveal = row["stage"] in SEQUENTIAL_STAGES and (stage in SEQUENTIAL_STAGES or stage == STAGE_CHAMPION)
            highlight_replay = {
                "match_id": row["id"],
                "stage": row["stage"],
                "is_bye": bool(row["is_bye"]),
                "p1_id": row["p1_id"],
                "p2_id": row["p2_id"],
                "p1_name": row["p1_bot"] or row["p1_real"],
                "p2_name": (row["p2_bot"] or row["p2_real"]) if row["p2_id"] else "BYE",
                "p1_real_name": row["p1_real"] if reveal else "",
                "p2_real_name": row["p2_real"] if (reveal and row["p2_id"]) else "",
                "p1_score": row["p1_score"],
                "p2_score": row["p2_score"],
                "winner_id": row["winner_id"],
                "draw_reason": row["draw_reason"],
                "games": json.loads(row["replay_json"] or "[]"),
            }

    # 3. Elimination Bracket Tree (empty before the cut)
    bracket = build_elimination_bracket()

    return {
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
        "total_participants": len(_tournament_entries()),
    }


def _cached_screen() -> Tuple[Dict[str, Any], str]:
    """(payload without status, its JSON body without the outer braces)."""
    with _cache_lock:
        gen = _GEN
        if _CACHE["screen"] is not None:
            return _CACHE["screen"], _CACHE["screen_body"]
    payload = _build_screen_payload()
    body = json.dumps(payload, separators=(",", ":"))[1:-1]
    with _cache_lock:
        if _GEN == gen:  # nothing changed while building; otherwise the next poll rebuilds
            _CACHE["screen"], _CACHE["screen_body"] = payload, body
    return payload, body


def get_screen_data() -> Dict[str, Any]:
    """Single aggregated response containing all data needed by the Big Screen."""
    payload, _ = _cached_screen()
    return {"status": get_tournament_status(), **payload}


def get_screen_json() -> str:
    """get_screen_data() as JSON, reusing the cached encoding (only the status is re-encoded)."""
    _, body = _cached_screen()
    return '{"status":' + json.dumps(get_tournament_status(), separators=(",", ":")) + "," + body + "}"


def _build_participant_cache():
    """Builds and caches personalized participant tournament payloads for all participants in RAM."""
    screen_data = get_screen_data()
    status = get_tournament_status()
    stage = status["stage"]
    rnd = status["round_number"]

    with db.connect() as c:
        p_rows = c.execute("SELECT id, roll, name, bot_name FROM participants").fetchall()
    registered_pids = {r["id"] for r in p_rows}

    entries = {e.id: e for e in get_all_tournament_entries()}
    all_pids = registered_pids | set(entries.keys())

    highlight = screen_data.get("highlight")
    tiers = screen_data.get("tiers")
    bracket = screen_data.get("bracket")
    total_p = screen_data.get("total_participants", len(entries))

    standings_list = get_latest_standings()
    standings_map = {s["participant_id"]: s for s in standings_list}

    cache_map: Dict[int, Dict[str, Any]] = {}

    def format_standing(s_dict):
        if not s_dict:
            return None
        return {
            "rank": s_dict.get("rank", 0),
            "match_wins": s_dict.get("match_wins", 0),
            "match_losses": s_dict.get("match_losses", 0),
            "game_wins": s_dict.get("game_wins", 0),
            "game_losses": s_dict.get("game_losses", 0),
            "damage_dealt": s_dict.get("damage_dealt", 0),
            "fumbles": s_dict.get("fumbles", 0),
            "tier": s_dict.get("tier", 3),
            "had_bye": bool(s_dict.get("had_bye", False)),
            "qualified_top32": bool(s_dict.get("rank", 999) <= TOP_CUT_COUNT),
        }

    if stage == STAGE_READY:
        for pid in all_pids:
            cache_map[pid] = {
                "role": "ready",
                "match": None,
                "is_mirroring": False,
                "my_standing": None,
                "tiers": tiers,
                "bracket": bracket,
                "total_participants": total_p,
            }

    elif stage == STAGE_CUT_CEREMONY:
        for pid in all_pids:
            s = standings_map.get(pid)
            cache_map[pid] = {
                "role": "cut",
                "match": None,
                "is_mirroring": False,
                "my_standing": format_standing(s),
                "tiers": tiers,
                "bracket": bracket,
                "total_participants": total_p,
            }

    elif stage == STAGE_CHAMPION:
        for pid in all_pids:
            s = standings_map.get(pid)
            cache_map[pid] = {
                "role": "champion",
                "match": highlight,
                "is_mirroring": True,
                "my_standing": format_standing(s),
                "tiers": tiers,
                "bracket": bracket,
                "total_participants": total_p,
            }

    elif status.get("is_sequential"):
        for pid in all_pids:
            s = standings_map.get(pid)
            cache_map[pid] = {
                "role": "spectating",
                "match": highlight,
                "is_mirroring": True,
                "my_standing": format_standing(s),
                "tiers": tiers,
                "bracket": bracket,
                "total_participants": total_p,
            }

    else:
        # Swiss (swiss_1..6) or parallel Elimination (ro32, ro16)
        is_elim = stage in (STAGE_RO32, STAGE_RO16)
        round_matches = []
        with db.connect() as c:
            cur_round = c.execute("""
                SELECT id FROM tournament_rounds
                WHERE stage = ?
                ORDER BY id DESC LIMIT 1
            """, (stage,)).fetchone()
            if cur_round:
                rows = c.execute("""
                    SELECT m.*, p1.bot_name as p1_bot, p1.name as p1_real,
                                p2.bot_name as p2_bot, p2.name as p2_real
                    FROM tournament_matches m
                    JOIN participants p1 ON p1.id = m.p1_id
                    LEFT JOIN participants p2 ON p2.id = m.p2_id
                    WHERE m.round_id = ?
                """, (cur_round["id"],)).fetchall()
                round_matches = [dict(r) for r in rows]

        match_by_pid: Dict[int, Dict[str, Any]] = {}
        bye_pids: Set[int] = set()

        reveal_names = bool(status.get("reveal_names", False))

        for m in round_matches:
            fmt_match = {
                "match_id": m["id"],
                "stage": m["stage"],
                "is_bye": bool(m["is_bye"]),
                "p1_id": m["p1_id"],
                "p2_id": m["p2_id"],
                "p1_name": m["p1_bot"] or m["p1_real"],
                "p2_name": (m["p2_bot"] or m["p2_real"]) if m["p2_id"] else "BYE",
                "p1_real_name": m["p1_real"] if reveal_names else "",
                "p2_real_name": (m["p2_real"] if (reveal_names and m["p2_id"]) else ""),
                "p1_score": m["p1_score"],
                "p2_score": m["p2_score"],
                "winner_id": m["winner_id"],
                "draw_reason": m["draw_reason"],
                "games": json.loads(m["replay_json"]) if m.get("replay_json") else []
            }
            if m["is_bye"]:
                bye_pids.add(m["p1_id"])
            else:
                match_by_pid[m["p1_id"]] = fmt_match
                if m["p2_id"]:
                    match_by_pid[m["p2_id"]] = fmt_match

        for pid in all_pids:
            s = standings_map.get(pid)
            if pid in match_by_pid:
                role = "playing"
                match_obj = match_by_pid[pid]
                is_mirroring = False
            elif pid in bye_pids:
                role = "bye"
                match_obj = highlight
                is_mirroring = True
            else:
                role = "eliminated" if is_elim else "spectating"
                match_obj = highlight
                is_mirroring = True

            cache_map[pid] = {
                "role": role,
                "match": match_obj,
                "is_mirroring": is_mirroring,
                "my_standing": format_standing(s),
                "tiers": tiers,
                "bracket": bracket,
                "total_participants": total_p,
            }

    with _cache_lock:
        _CACHE["participant_matches"] = cache_map


def get_participant_data(participant_id: int) -> Dict[str, Any]:
    """Ultra-fast, zero-DB participant view served from RAM for 400+ concurrent laptops."""
    with _cache_lock:
        cache_map = _CACHE.get("participant_matches")

    if cache_map is None:
        _build_participant_cache()
        with _cache_lock:
            cache_map = _CACHE.get("participant_matches")

    latest_status = get_tournament_status()

    if cache_map and participant_id in cache_map:
        cached = dict(cache_map[participant_id])
        cached["status"] = latest_status
        return cached

    # Stage-consistent fallback for spectators or unknown IDs
    screen = get_screen_data()
    stage = latest_status.get("stage", STAGE_READY)
    fallback_role = "ready" if stage == STAGE_READY else (
        "cut" if stage == STAGE_CUT_CEREMONY else (
            "champion" if stage == STAGE_CHAMPION else "spectating"
        )
    )
    fallback_match = None if stage in (STAGE_READY, STAGE_CUT_CEREMONY) else screen.get("highlight")
    fallback_mirror = stage not in (STAGE_READY, STAGE_CUT_CEREMONY)

    return {
        "status": latest_status,
        "role": fallback_role,
        "match": fallback_match,
        "is_mirroring": fallback_mirror,
        "my_standing": None,
        "tiers": screen.get("tiers"),
        "bracket": screen.get("bracket"),
        "total_participants": screen.get("total_participants", 0),
    }
