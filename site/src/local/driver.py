"""Runs test matches in the browser (Pyodide), the same way the server's /api/test does,
minus the sandbox process. It's the participant's own laptop, so there's nothing to protect;
the static check and restricted builtins still run so results match the server's.

The worker sets CONFIG_JSON and BOTS_JSON before running this, and writes the engine
package (from /api/engine-bundle) to /mcw/engine.
"""
import json
import sys
import time

sys.path.insert(0, "/mcw")

from engine import BotRunner, run_match  # noqa: E402
from engine.botapi import check_source  # noqa: E402
from engine.config import config_from_dict  # noqa: E402

CFG = config_from_dict(json.loads(CONFIG_JSON))  # noqa: F821 (set by the worker)
HOUSE_BOTS = {b["name"]: b["code"] for b in json.loads(BOTS_JSON)}  # noqa: F821


class LocalBot:
    """A participant bot. A move over the time limit counts as a fumble, like on the server.
    (A move that never ends can't be stopped from in here; the page kills the whole worker.)"""

    def __init__(self, code, filename):
        self.runner = BotRunner(code, filename=filename, print_limit=CFG.print_chars_per_turn, safe=True)
        self.timeouts = 0
        self.gave_up = None

    def act(self, me, opp, turn, seed):
        if self.gave_up:
            return {"move": None, "output": "", "error": self.gave_up}
        start = time.perf_counter()
        reply = self.runner.act(me, opp, turn, seed)
        ms = (time.perf_counter() - start) * 1000
        if ms <= CFG.move_timeout_ms:
            return reply
        self.timeouts += 1
        error = f"took {ms:.0f} ms, longer than the {CFG.move_timeout_ms} ms limit"
        if self.timeouts >= CFG.max_timeouts_per_match:
            self.gave_up = f"stopped for the rest of the match after {self.timeouts} timeouts"
            error += f"; {self.gave_up}"
        return {"move": None, "output": reply["output"], "error": error}


def check_json(code):
    return json.dumps(check_source(code))


def test_json(code, opponent, seed):
    seed = int(seed)
    you = LocalBot(code, "your_bot.py")
    if opponent == "mirror":
        other = LocalBot(code, "mirror.py")
    else:
        other = BotRunner(HOUSE_BOTS[opponent], filename=f"{opponent}.py", print_limit=CFG.print_chars_per_turn)
    return json.dumps(run_match([you, other], CFG, seed=seed, names=("you", opponent)))
