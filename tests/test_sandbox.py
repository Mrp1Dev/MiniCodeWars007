import unittest

from engine import BotRunner, load_config, run_match
from engine.botapi import check_source
from engine.rules import FUMBLE
from engine.sandbox import SandboxBot

CFG = load_config()
HEADER = "def play(me, opp, turn, memory):\n"


def body(code):
    return HEADER + "".join("    " + line + "\n" for line in code.splitlines())


class StaticCheck(unittest.TestCase):
    ESCAPES = {
        "import os": "import os\n" + body("return RELOAD"),
        "from os": "from os import system\n" + body("return RELOAD"),
        "import inside play": body("import subprocess\nreturn RELOAD"),
        "dunder chain": body("x = ().__class__.__bases__[0].__subclasses__()\nreturn RELOAD"),
        "random._os": "import random\n" + body("random._os.system('echo hi')\nreturn RELOAD"),
        "eval": body("return eval('RELOAD')"),
        "getattr": body("return getattr(me, 'ammo')"),
        "open": body("open('x.txt', 'w')\nreturn RELOAD"),
        "frame walk": body("g = (i for i in [])\nf = g.gi_frame.f_back\nreturn RELOAD"),
        "builtins": body("__builtins__['open']\nreturn RELOAD"),
        "statistics.sys": "import statistics\n" + body("return RELOAD"),
        "no play": "def plai(me, opp, turn, memory):\n    return RELOAD\n",
        "syntax": "def play(me, opp:\n",
    }

    def test_escapes_rejected(self):
        for name, src in self.ESCAPES.items():
            self.assertTrue(check_source(src), name)

    def test_normal_code_allowed(self):
        src = ("import random\nfrom collections import Counter\nimport math\n\n"
               "class Tracker:\n    def __init__(self):\n        self.seen = Counter()\n\n"
               + body("if 'tracker' not in memory:\n    memory['tracker'] = Tracker()\n"
                      "memory['tracker'].seen.update(opp.history[-1:])\n"
                      "return random.choice([RELOAD, SHIELD])")
               + "\nif __name__ == '__main__':\n    print('testing')\n")
        self.assertEqual(check_source(src), [])
        self.assertIsNone(BotRunner(src, safe=True).load_error)


def sandboxed_match(src_a, src_b, seed=0):
    with SandboxBot(src_a, CFG) as a, SandboxBot(src_b, CFG) as b:
        return run_match([a, b], CFG, seed=seed)


class Sandbox(unittest.TestCase):
    def test_same_result_as_in_process(self):
        src = "import random\n" + body("return random.choice(MOVES)")
        sandboxed = sandboxed_match(src, src, seed=11)
        local = run_match([BotRunner(src), BotRunner(src)], CFG, seed=11)
        self.assertEqual([t["actions"] for t in sandboxed["turns"]], [t["actions"] for t in local["turns"]])
        self.assertEqual(sandboxed["result"], local["result"])

    def test_infinite_loop_is_stopped_and_restarted(self):
        loop = body("memory['n'] = memory.get('n', 0) + 1\n"
                    "if turn == 2:\n    while True:\n        pass\n"
                    "print('calls so far', memory['n'])\nreturn RELOAD")
        rep = sandboxed_match(loop, body("return SHIELD"))
        t = rep["turns"]
        self.assertEqual(t[1]["actions"][0], FUMBLE)
        self.assertIn("took longer", t[1]["errors"][0])
        self.assertEqual(t[2]["actions"][0], "RELOAD")
        self.assertEqual(t[2]["output"][0], "calls so far 1\n", "memory resets after a restart")

    def test_gives_up_after_repeated_timeouts(self):
        rep = sandboxed_match(body("while True:\n    pass"), body("return RELOAD"))
        errors = [t["errors"][0] for t in rep["turns"]]
        self.assertTrue(all(t["actions"][0] == FUMBLE for t in rep["turns"]))
        self.assertIn("rest of the match", errors[CFG.max_timeouts_per_match - 1])

    def test_top_level_infinite_loop(self):
        with SandboxBot("while True:\n    pass\n" + body("return RELOAD"), CFG) as b:
            self.assertIn("too long to start", b.load_error)

    def test_memory_bomb(self):
        rep = sandboxed_match(body("x = [0] * (10 ** 9)\nreturn RELOAD"), body("return RELOAD"))
        self.assertEqual(rep["turns"][0]["actions"][0], FUMBLE)
        self.assertIn("Memory", rep["turns"][0]["errors"][0])

    def test_blocked_import_at_runtime(self):
        # Even if the static check were fooled, the runtime import hook refuses.
        with SandboxBot(body("return RELOAD"), CFG) as b:
            self.assertIsNone(b.load_error)
        r = BotRunner(body("return RELOAD"), safe=True)
        self.assertRaises(ImportError, r.play.__globals__["__builtins__"]["__import__"], "os")

    def test_bots_in_threads_dont_share_random_or_print(self):
        from concurrent.futures import ThreadPoolExecutor
        src = ("from random import choice\n"
               + body("print('turn', turn)\nreturn choice(MOVES)"))

        def one(seed):
            rep = run_match([BotRunner(src), BotRunner(src)], CFG, seed=seed)
            return [t["actions"] for t in rep["turns"]], [t["output"] for t in rep["turns"]]

        expected = [one(s) for s in range(20)]
        with ThreadPoolExecutor(8) as ex:
            self.assertEqual(list(ex.map(one, range(20))), expected)
        self.assertEqual(expected[0][1][2], ["turn 3\n", "turn 3\n"])

    def test_print_spam_is_capped(self):
        rep = sandboxed_match(body("print('x' * 10**6)\nreturn RELOAD"), body("return RELOAD"))
        self.assertEqual(len(rep["turns"][0]["output"][0]), CFG.print_chars_per_turn)

    def test_reuse_between_matches(self):
        src = body("memory['n'] = memory.get('n', 0) + 1\nprint(memory['n'])\nreturn RELOAD")
        with SandboxBot(src, CFG) as a, SandboxBot(src, CFG) as b:
            run_match([a, b], CFG)
            a.new_match()
            b.new_match()
            rep = run_match([a, b], CFG)
        self.assertEqual(rep["turns"][0]["output"][0], "1\n")


if __name__ == "__main__":
    unittest.main()
