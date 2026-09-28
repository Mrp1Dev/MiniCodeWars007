"""Kicking participants out in the middle of a tournament (sandboxed bots)."""
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("MCW_DB", str(Path(tempfile.mkdtemp(prefix="mcw_test_")) / "test.db"))
os.environ.setdefault("MCW_ADMIN_KEY", "test-admin")  # settings load once; test_server relies on this key

from server import db, seed_bots, tournament as T  # noqa: E402

PLAYERS = 11


def ids_in(stage):
    with db.connect() as c:
        rows = c.execute("SELECT p1_id, p2_id FROM tournament_matches WHERE stage = ?", (stage,)).fetchall()
    return {x for r in rows for x in (r["p1_id"], r["p2_id"]) if x}


def advance_to(stage):
    while T.get_raw_state()["stage"] != stage:
        T.advance_stage()
        T.get_screen_json()  # every screen still builds


class Kick(unittest.TestCase):
    def test_kicked_players_leave_the_tournament(self):
        with db.connect() as c:
            c.executescript("DELETE FROM tournament_matches; DELETE FROM tournament_rounds; "
                            "DELETE FROM tournament_standings; DELETE FROM submissions; DELETE FROM participants;")
        seed_bots.seed_database(PLAYERS)
        T.start_tournament()
        try:
            advance_to(T.STAGE_SWISS[1])
            everyone = ids_in(T.STAGE_SWISS[0])
            swiss_kick = min(everyone)
            db.set_kicked(swiss_kick, True)
            T.invalidate_cache(standings=True)

            advance_to(T.STAGE_CUT_CEREMONY)
            for stage in T.STAGE_SWISS[2:]:
                self.assertNotIn(swiss_kick, ids_in(stage), f"kicked player paired in {stage}")
                self.assertEqual(ids_in(stage), everyone - {swiss_kick}, f"everyone else plays in {stage}")
            final = T._standings_rows(T.SWISS_ROUNDS)
            self.assertNotIn(swiss_kick, {r["participant_id"] for r in final})

            # Kicked after the cut: the bracket keeps its seeds and the opponent gets a bye.
            seeds = T._swiss_seeds()
            top = min(seeds, key=seeds.get)
            db.set_kicked(top, True)
            T.invalidate_cache(standings=True)
            self.assertEqual(T._swiss_seeds(), seeds, "seeding is frozen once Swiss is over")
            advance_to(T.STAGE_CHAMPION)
            for stage in [T.STAGE_RO32, T.STAGE_RO16] + T.SEQUENTIAL_STAGES:
                self.assertNotIn(top, ids_in(stage), f"kicked player plays in {stage}")
            self.assertIsNotNone(T.get_screen_data()["highlight"]["winner_id"])
        finally:
            with db.connect() as c:
                c.execute("UPDATE participants SET kicked = 0")
            T.invalidate_cache(standings=True)


if __name__ == "__main__":
    unittest.main()
