"""Command-line runner.

  python -m engine BOT_A BOT_B                 one match, turn by turn
  python -m engine BOT_A BOT_B --games 200     win/draw summary over many seeds
  python -m engine --round-robin bots          every bot in a folder vs every other

A bot is a path to a .py file, or the name of a file in bots/ (e.g. "turtle").
"""
import argparse
import json
import sys
from itertools import combinations
from pathlib import Path

from .botapi import BotRunner
from .config import ConfigError, load_config
from .match import run_match
from .sandbox import SandboxBot

BOTS_DIR = Path(__file__).resolve().parent.parent / "bots"


def resolve_bot_path(arg):
    p = Path(arg)
    if p.is_file():
        return p
    q = BOTS_DIR / (arg if arg.endswith(".py") else arg + ".py")
    if q.is_file():
        return q
    sys.exit(f"error: no bot file {arg!r} (also looked for {q})")


class BotSource:
    def __init__(self, path: Path):
        self.path = path
        self.name = path.stem
        self.source = path.read_text(encoding="utf-8")

    def runner(self, cfg):
        if SANDBOX:
            return SandboxBot(self.source, cfg, filename=str(self.path))
        return BotRunner(self.source, filename=str(self.path), print_limit=cfg.print_chars_per_turn)


SANDBOX = False


def play(a: BotSource, b: BotSource, cfg, seed):
    bots = [a.runner(cfg), b.runner(cfg)]
    try:
        return run_match(bots, cfg, seed=seed, names=(a.name, b.name))
    finally:
        for bot in bots:
            if hasattr(bot, "close"):
                bot.close()


def describe_event(ev, names):
    att, dfd = names[ev["by"]], names[1 - ev["by"]]
    if ev["type"] == "hit":
        return f"{att}'s {ev['action']} hits {dfd}"
    if ev["type"] == "reflected":
        return f"{dfd} COUNTERs {att}'s {ev['action']}, {att} takes {ev['damage']}"
    return f"{att}'s {ev['action']} blocked by {ev['with']}"


def print_match(replay, show_output):
    names = replay["names"]
    w = max(8, *(len(n) for n in names))
    print(f"{'turn':>4}  {names[0]:<{w}}  {names[1]:<{w}}  {'hp/ammo/shield':<18}  what happened")
    print("-" * (4 + 2 * w + 44))
    for t in replay["turns"]:
        s = t["state"]
        stats = f"{s[0]['hp']}/{s[0]['ammo']}/{s[0]['shields']} vs {s[1]['hp']}/{s[1]['ammo']}/{s[1]['shields']}"
        notes = [describe_event(e, names) for e in t["events"]]
        for i in (0, 1):
            if t["errors"][i]:
                notes.append(f"{names[i]} crashed: {t['errors'][i]}")
            elif t["fumbles"][i]:
                notes.append(f"{names[i]} fumbled: {t['fumbles'][i]}")
        print(f"{t['turn']:>4}  {t['actions'][0]:<{w}}  {t['actions'][1]:<{w}}  {stats:<18}  {'; '.join(notes)}")
        if show_output:
            for i in (0, 1):
                for line in t["output"][i].splitlines():
                    print(f"{'':>6}[{names[i]} print] {line}")
    r = replay["result"]
    who = "draw" if r["winner"] is None else f"{names[r['winner']]} wins"
    print(f"\nResult: {who} ({r['reason']}), seed {replay['seed']}")


def many(a, b, cfg, games, seed):
    tally = {0: 0, 1: 0, None: 0}
    crashes = [0, 0]
    for g in range(games):
        rep = play(a, b, cfg, seed + g)
        tally[rep["result"]["winner"]] += 1
        for t in rep["turns"]:
            for i in (0, 1):
                crashes[i] += bool(t["errors"][i])
    return tally, crashes


def round_robin(folder, cfg, games, seed):
    paths = sorted(Path(folder).glob("*.py"))
    if len(paths) < 2:
        sys.exit(f"error: need at least 2 .py bots in {folder}")
    bots = [BotSource(p) for p in paths]
    wins = {b.name: {} for b in bots}
    for a, b in combinations(bots, 2):
        tally, _ = many(a, b, cfg, games, seed)
        wins[a.name][b.name] = (tally[0] + tally[None] / 2) / games
        wins[b.name][a.name] = (tally[1] + tally[None] / 2) / games

    names = [b.name for b in bots]
    w = max(len(n) for n in names)
    print(f"Win rate of row vs column ({games} games each, draws count half)\n")
    print(" " * w + "  " + "".join(f"{n[:7]:>8}" for n in names) + "   overall")
    order = sorted(names, key=lambda n: -sum(wins[n].values()))
    for n in order:
        cells = "".join(f"{'-':>8}" if m == n else f"{wins[n][m]:>8.0%}" for m in names)
        print(f"{n:<{w}}  {cells}   {sum(wins[n].values()) / (len(names) - 1):>6.0%}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m engine", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bots", nargs="*", help="two bot files or names")
    ap.add_argument("--games", type=int, default=1, help="number of matches (seeds seed..seed+N-1)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--config", help="rules file (default: config.toml)")
    ap.add_argument("--replay", help="write the replay JSON of a single match here")
    ap.add_argument("--show-output", action="store_true", help="show what bots print()")
    ap.add_argument("--sandbox", action="store_true",
                    help="run bots in separate locked-down processes with time limits (slower)")
    ap.add_argument("--round-robin", metavar="FOLDER", help="play every bot in FOLDER against every other")
    args = ap.parse_args(argv)
    global SANDBOX
    SANDBOX = args.sandbox

    try:
        cfg = load_config(args.config)
    except (ConfigError, OSError) as e:
        sys.exit(f"config error: {e}")

    if args.round_robin:
        round_robin(args.round_robin, cfg, max(args.games, 1), args.seed)
        return
    if len(args.bots) != 2:
        ap.error("give exactly two bots (or use --round-robin)")

    a, b = (BotSource(resolve_bot_path(x)) for x in args.bots)
    if args.games == 1:
        rep = play(a, b, cfg, args.seed)
        print_match(rep, args.show_output)
        if args.replay:
            Path(args.replay).write_text(json.dumps(rep, indent=1), encoding="utf-8")
            print(f"Replay written to {args.replay}")
    else:
        tally, crashes = many(a, b, cfg, args.games, args.seed)
        print(f"{a.name}: {tally[0]} wins   {b.name}: {tally[1]} wins   draws: {tally[None]}   ({args.games} games)")
        for i, bot in enumerate((a, b)):
            if crashes[i]:
                print(f"warning: {bot.name} crashed on {crashes[i]} turns; run a single game to see why")
