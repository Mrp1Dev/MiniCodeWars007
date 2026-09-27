"""Plays a whole small tournament (sandboxed bots) and checks the rules the event depends on."""
import json
import os
import tempfile
import unittest
from collections import Counter
from pathlib import Path

os.environ.setdefault("MCW_DB", str(Path(tempfile.mkdtemp(prefix="mcw_test_")) / "test.db"))

from server import db, seed_bots, tournament as T  # noqa: E402

PLAYERS = 11  # odd, so there is a bye every Swiss round; fewer than 32, so the bracket has byes too


def rows(stage):
    with db.connect() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM tournament_matches WHERE stage = ? ORDER BY match_index", (stage,))]


class Tournament(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with db.connect() as c:
            c.executescript("DELETE FROM tournament_matches; DELETE FROM tournament_rounds; "
                            "DELETE FROM tournament_standings; DELETE FROM submissions; DELETE FROM participants;")
        seed_bots.seed_database(PLAYERS)
        T.start_tournament()
        with db.connect() as c:
            cls.people = [dict(r) for r in c.execute("SELECT id, roll, name FROM participants")]
        cls.screens = {}
        while T.get_raw_state()["stage"] != T.STAGE_SWISS[-1]:
            scr = T.advance_stage()
            cls.screens[scr["status"]["stage"]] = T.get_screen_json()

    def test_swiss_pairings(self):
        played, byes = set(), Counter()
        for stage in T.STAGE_SWISS:
            seen = Counter()
            for m in rows(stage):
                seen[m["p1_id"]] += 1
                if m["p2_id"] is None:
                    byes[m["p1_id"]] += 1
                    self.assertEqual((m["p1_score"], m["p2_score"], m["winner_id"]), (1, 0, m["p1_id"]))
                    continue
                seen[m["p2_id"]] += 1
                pair = tuple(sorted((m["p1_id"], m["p2_id"])))
                self.assertNotIn(pair, played, f"rematch in {stage}")
                played.add(pair)
                self.assertIn(m["winner_id"], pair, "every Swiss match has a decisive winner")
                self.assertLessEqual(max(m["p1_score"], m["p2_score"]), 1)
                self.assertEqual(len(json.loads(m["replay_json"])), 1)
            self.assertEqual(set(seen.values()), {1}, f"everyone plays exactly once in {stage}")
            self.assertEqual(len(seen), PLAYERS)
        self.assertEqual(sum(byes.values()), T.SWISS_ROUNDS)
        self.assertEqual(max(byes.values()), 1, "nobody gets two byes")

    def test_public_payloads_hide_identities(self):
        for stage, blob in self.screens.items():
            for p in self.people:
                self.assertNotIn(p["roll"], blob, f"roll number on screen in {stage}")
                self.assertNotIn(f'"{p["name"]}"', blob, f"real name on screen in {stage}")

    def test_guards_undo_and_rerun(self):
        with self.assertRaises(ValueError):
            T.advance_stage(T.STAGE_FINALS)  # can't skip ahead
        before = T.get_raw_state()["stage"]
        n = len(rows(before))
        T.advance_stage(before)  # re-running the live stage replaces it, never duplicates it
        self.assertEqual(len(rows(before)), n)
        self.assertEqual(len(T._standings_rows(T.ROUND_NUMBERS[before])), PLAYERS)

        scr = T.undo_stage()
        prev = T.STAGES[T.STAGES.index(before) - 1]
        self.assertEqual(scr["status"]["stage"], prev)
        self.assertEqual(rows(before), [])
        self.assertEqual(T._standings_rows(T.ROUND_NUMBERS[before]), [])
        self.assertIsNotNone(scr["highlight"], "undo restores the previous marquee duel")
        T.advance_stage()
        self.assertEqual(len(rows(before)), n)

    def test_zz_elimination_and_finale(self):
        # Runs last (alphabetical): plays the rest of the tournament from the end of Swiss.
        while T.get_raw_state()["stage"] != T.STAGE_CHAMPION:
            T.advance_stage()
        top = [s.participant_id for s in T.compute_standings_from_history(T.SWISS_ROUNDS)]
        ro32 = rows(T.STAGE_RO32)
        self.assertEqual({x for m in ro32 for x in (m["p1_id"], m["p2_id"]) if x}, set(top[:32]))
        winners = {(m["stage"], m["match_index"]): m["winner_id"]
                   for s in [T.STAGE_RO32, T.STAGE_RO16] + T.SEQUENTIAL_STAGES for m in rows(s)}
        for node in T._elim_nodes():
            feeders, match = T._feeders(node), [m for m in rows(node[0]) if m["match_index"] == node[1]]
            if feeders and match:
                expected = {winners.get(feeders[0]), winners.get(feeders[1])} - {None}
                self.assertEqual({match[0]["p1_id"], match[0]["p2_id"]} - {None}, expected, node)
        for stage in T.STAGE_RO4 + [T.STAGE_FINALS]:
            for m in rows(stage):
                if m["p2_id"]:
                    self.assertEqual(len(json.loads(m["replay_json"])), 1)
                    self.assertLessEqual(max(m["p1_score"], m["p2_score"]), 1)
        champion = T.get_screen_data()["highlight"]
        self.assertEqual(champion["winner_id"], rows(T.STAGE_FINALS)[0]["winner_id"])
        self.assertTrue(champion["p1_real_name"], "names are unveiled for the finale")

    def test_step_mode_resumes_where_the_host_left_it(self):
        state = T.get_raw_state()
        if not state["highlight_match_id"]:
            self.skipTest("no marquee duel")
        T.set_turn_step(3)
        status = T.set_turn_step(-1)
        self.assertFalse(status["paused"])
        turns = [len(g["turns"]) for g in T._highlight_games(T.get_raw_state())]
        expected, left = 0, 3
        for n in turns:
            if left < n:
                expected += left * T.TURN_MS
                break
            left -= n
            expected += n * T.TURN_MS + T.GAME_PAUSE_MS
        elapsed = (status["server_time"] - status["started_at"] - status["accumulated_pause"]) * 1000
        self.assertAlmostEqual(elapsed, expected, delta=250)


if __name__ == "__main__":
    unittest.main()
