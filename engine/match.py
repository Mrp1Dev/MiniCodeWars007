"""Runs one match between two bots and produces a JSON-serialisable replay.

A "bot" here is anything with act(me, opp, turn, seed) -> {"move", "output", "error"}.
BotRunner (in-process) is one; the sandboxed runner will provide another.
"""
import time

from .config import Config
from .rules import Player, decide_winner, resolve_turn

REPLAY_VERSION = 1


def _views(players, i):
    me, opp = players[i], players[1 - i]
    return (
        {"hp": me.hp, "ammo": me.ammo, "shields": me.shields, "history": list(me.history)},
        {"hp": opp.hp, "ammo": opp.ammo, "history": list(opp.history)},
    )


def run_match(bots, cfg: Config, seed=0, names=("A", "B")):
    players = [Player.new(cfg), Player.new(cfg)]
    turns = []

    for turn in range(1, cfg.max_rounds + 1):
        replies, times = [], []
        for i, bot in enumerate(bots):
            me, opp = _views(players, i)
            start = time.perf_counter()
            replies.append(bot.act(me, opp, turn, f"{seed}:{i}:{turn}"))
            times.append(round((time.perf_counter() - start) * 1000, 2))

        result = resolve_turn(players, [r["move"] for r in replies], cfg)
        turns.append({
            "turn": turn,
            "requested": [r["move"] for r in replies],
            **result,
            "state": [p.snapshot() for p in players],
            "output": [r["output"] for r in replies],
            "errors": [r["error"] for r in replies],
            "ms": times,
        })
        if any(p.hp <= 0 for p in players):
            break

    alive = [p.hp > 0 for p in players]
    if alive == [True, False]:
        winner, reason = 0, "knockout"
    elif alive == [False, True]:
        winner, reason = 1, "knockout"
    else:
        winner, reason = decide_winner(players)
        reason = ("double knockout, " if not any(alive) else "time up, ") + reason

    return {
        "version": REPLAY_VERSION,
        "seed": seed,
        "names": list(names),
        "config": cfg.raw,
        "turns": turns,
        "result": {
            "winner": winner,
            "reason": reason,
            "final": [{**p.snapshot(), "damage_dealt": p.damage_dealt} for p in players],
        },
    }
