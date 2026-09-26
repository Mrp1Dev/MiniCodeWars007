"""Runs matches for the server: participant code is sandboxed, house bots run in-process.
These functions block; the app limits how many run at once."""
from pathlib import Path

from engine import BotRunner, load_config, run_match
from engine.botapi import check_source
from engine.rules import FUMBLE
from engine.sandbox import SandboxBot

from . import settings

CFG = load_config(settings.CONFIG_PATH)
BOTS_DIR = Path(__file__).resolve().parent.parent / "bots"
# Opponents a submission is checked against, one match each.
VALIDATION_OPPONENTS = ("random_bot", "turtle", "smart")
VALIDATION_SEED = 12345


def _load_house_bots():
    bots = {}
    for path in sorted(BOTS_DIR.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        first = source.splitlines()[0] if source else ""
        bots[path.stem] = {
            "name": path.stem,
            "description": first.lstrip("# ").strip() if first.startswith("#") else "",
            "source": source,
        }
    return bots


HOUSE_BOTS = _load_house_bots()


def house_bot(name):
    return BotRunner(HOUSE_BOTS[name]["source"], filename=f"{name}.py", print_limit=CFG.print_chars_per_turn)


def test_match(code, opponent, seed):
    """One match: participant's code (sandboxed) vs a house bot, or vs itself."""
    with SandboxBot(code, CFG, filename="your_bot.py") as you:
        if opponent == "mirror":
            with SandboxBot(code, CFG, filename="mirror.py") as other:
                return run_match([you, other], CFG, seed=seed, names=("you", "mirror"))
        return run_match([you, house_bot(opponent)], CFG, seed=seed, names=("you", opponent))


def _summarise(replay):
    turns = replay["turns"]
    crashes = [t["errors"][0] for t in turns if t["errors"][0]]
    fumbles = [t["fumbles"][0] for t in turns if t["actions"][0] == FUMBLE and not t["errors"][0]]
    winner = replay["result"]["winner"]
    return {
        "opponent": replay["names"][1],
        "outcome": "draw" if winner is None else ("win" if winner == 0 else "loss"),
        "reason": replay["result"]["reason"],
        "turns": len(turns),
        "crashes": len(crashes),
        "fumbles": len(fumbles),
        "first_error": crashes[0] if crashes else None,
        "first_fumble": fumbles[0] if fumbles else None,
    }


def validate(code):
    """Checks a submission. Returns (status, report); status is ok, warning or rejected."""
    problems = check_source(code)
    if problems:
        return "rejected", {"problems": problems, "matches": [], "load_output": ""}

    with SandboxBot(code, CFG, filename="your_bot.py") as you:
        if you.load_error:
            return "rejected", {"problems": [{"line": None, "message": you.load_error}],
                                "matches": [], "load_output": you.load_output}
        matches = []
        for name in VALIDATION_OPPONENTS:
            you.new_match()
            rep = run_match([you, house_bot(name)], CFG, seed=VALIDATION_SEED, names=("you", name))
            matches.append(_summarise(rep))

    trouble = any(m["crashes"] for m in matches)
    return ("warning" if trouble else "ok"), {"problems": [], "matches": matches, "load_output": you.load_output}
