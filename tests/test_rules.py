import unittest

from engine import BotRunner, Player, load_config, resolve_turn, run_match
from engine.rules import FUMBLE

CFG = load_config()


def turn(a, b, ammo=(3, 3), hp=(3, 3), shields=None):
    shields = shields or (CFG.shield_charges, CFG.shield_charges)
    ps = [Player(hp=hp[i], ammo=ammo[i], shields=shields[i]) for i in (0, 1)]
    res = resolve_turn(ps, [a, b], CFG)
    return ps, res


class OutcomeTable(unittest.TestCase):
    # (my move, their move) -> (damage to me, damage to them)
    TABLE = {
        ("RELOAD", "RELOAD"): (0, 0),
        ("RELOAD", "SHIELD"): (0, 0),
        ("RELOAD", "SHOOT"): (1, 0),
        ("RELOAD", "SNIPE"): (1, 0),
        ("RELOAD", "COUNTER"): (0, 0),
        ("SHIELD", "SHIELD"): (0, 0),
        ("SHIELD", "SHOOT"): (0, 0),
        ("SHIELD", "SNIPE"): (1, 0),
        ("SHIELD", "COUNTER"): (0, 0),
        ("SHOOT", "SHOOT"): (1, 1),
        ("SHOOT", "SNIPE"): (1, 1),
        ("SHOOT", "COUNTER"): (1, 0),
        ("SNIPE", "SNIPE"): (0, 0),
        ("SNIPE", "COUNTER"): (0, 0),
        ("COUNTER", "COUNTER"): (0, 0),
        ("FUMBLE", "SHOOT"): (1, 0),
        ("FUMBLE", "SNIPE"): (1, 0),
    }

    def test_table_both_ways(self):
        for (a, b), (da, db) in self.TABLE.items():
            for (x, y, dx, dy) in ((a, b, da, db), (b, a, db, da)):
                _, res = turn(x, y)
                self.assertEqual(res["damage"], [dx, dy], f"{x} vs {y}")

    def test_costs(self):
        ps, _ = turn("SHOOT", "SNIPE")
        self.assertEqual([p.ammo for p in ps], [2, 1])
        ps, _ = turn("COUNTER", "SHIELD")
        self.assertEqual([p.ammo for p in ps], [2, 3])

    def test_counter_credits_damage_to_counterer(self):
        ps, _ = turn("COUNTER", "SHOOT")
        self.assertEqual((ps[0].damage_dealt, ps[1].damage_dealt), (1, 0))


class Validity(unittest.TestCase):
    def test_unaffordable_moves_fumble(self):
        for move, ammo in (("SHOOT", 0), ("COUNTER", 0), ("SNIPE", 1)):
            _, res = turn(move, "RELOAD", ammo=(ammo, 0))
            self.assertEqual(res["actions"][0], FUMBLE, move)
            self.assertIsNotNone(res["fumbles"][0])

    def test_junk_fumbles(self):
        for junk in (None, 5, "dance", ""):
            _, res = turn(junk, "RELOAD")
            self.assertEqual(res["actions"][0], FUMBLE)

    def test_case_and_whitespace_ok(self):
        _, res = turn(" shoot\n", "RELOAD")
        self.assertEqual(res["actions"][0], "SHOOT")

    def test_fumble_is_vulnerable_and_free(self):
        ps, res = turn("SNIPE", "SHOOT", ammo=(1, 1))
        self.assertEqual(res["actions"][0], FUMBLE)
        self.assertEqual(ps[0].ammo, 1)
        self.assertEqual(ps[0].hp, 2)


class AmmoAndShields(unittest.TestCase):
    def test_reload_caps(self):
        ps, _ = turn("RELOAD", "RELOAD", ammo=(2, 3))
        self.assertEqual([p.ammo for p in ps], [3, 3])

    def test_shield_charges(self):
        ps = [Player.new(CFG), Player.new(CFG)]
        for _ in range(CFG.shield_charges):
            res = resolve_turn(ps, ["SHIELD", "RELOAD"], CFG)
            self.assertEqual(res["actions"][0], "SHIELD")
        self.assertEqual(ps[0].shields, 0)
        res = resolve_turn(ps, ["SHIELD", "RELOAD"], CFG)
        self.assertEqual(res["actions"][0], FUMBLE)
        self.assertEqual(ps[0].shields, 0, "fumble must not refill shields")
        resolve_turn(ps, ["RELOAD", "RELOAD"], CFG)
        self.assertEqual(ps[0].shields, CFG.shield_charges)


def bot(src):
    return BotRunner(src)


class Matches(unittest.TestCase):
    def test_knockout(self):
        rep = run_match([bot("def play(me, opp, turn, memory):\n    return SNIPE if me.ammo >= 2 else RELOAD"),
                         bot("def play(me, opp, turn, memory):\n    return SHIELD if me.shields else RELOAD")],
                        CFG)
        self.assertEqual(rep["result"]["winner"], 0)
        self.assertEqual(rep["result"]["reason"], "knockout")

    def test_time_up_tiebreak_on_ammo(self):
        # The second bot shields 3 times, then fumbles forever (fumbles don't refill shields).
        rep = run_match([bot("def play(me, opp, turn, memory):\n    return RELOAD"),
                         bot("def play(me, opp, turn, memory):\n    return SHIELD")],
                        CFG)
        self.assertEqual(len(rep["turns"]), CFG.max_rounds)
        self.assertEqual(rep["result"]["winner"], 0)
        self.assertIn("ammo", rep["result"]["reason"])

    def test_crashing_and_broken_bots(self):
        crash = bot("def play(me, opp, turn, memory):\n    return 1/0")
        rep = run_match([crash, bot("def play(me, opp):\n    return RELOAD")], CFG)
        self.assertEqual(rep["turns"][0]["actions"], [FUMBLE, "RELOAD"])
        self.assertIn("line 2", rep["turns"][0]["errors"][0])
        self.assertIn("ZeroDivisionError", rep["turns"][0]["errors"][0])

        for src in ("def play(:", "x = 1", "print('hi'"):
            b = bot(src)
            self.assertIsNotNone(b.load_error, src)
            self.assertIsNone(b.act({}, {}, 1, "s")["move"])

    def test_memory_and_print(self):
        src = ("def play(me, opp, turn, memory):\n"
               "    memory['n'] = memory.get('n', 0) + 1\n"
               "    print('turn', memory['n'])\n"
               "    return RELOAD")
        rep = run_match([bot(src), bot(src)], CFG)
        self.assertEqual(rep["turns"][4]["output"][0], "turn 5\n")

    def test_deterministic_random(self):
        src = "import random\ndef play(me, opp, turn, memory):\n    return random.choice(MOVES)"
        a = run_match([bot(src), bot(src)], CFG, seed=7)
        b = run_match([bot(src), bot(src)], CFG, seed=7)
        self.assertEqual([t["actions"] for t in a["turns"]], [t["actions"] for t in b["turns"]])


if __name__ == "__main__":
    unittest.main()
