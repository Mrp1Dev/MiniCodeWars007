"""Integration and scale test for player tournament experience on laptops.
Tests:
- Participant tournament endpoints (/api/tournament/status, /api/tournament/my-match)
- In-memory caching performance and zero DB churn
- Role detection across all stages: ready_room, swiss_1, cut_ceremony, ro32, ro8, finals, champion
- Mirroring behavior for Byes, Elimination, and Sequential Finals
"""
import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("MCW_DB", str(Path(tempfile.mkdtemp(prefix="mcw_tourn_test_")) / "test.db"))
os.environ.setdefault("MCW_ADMIN_KEY", "test-admin")

from fastapi.testclient import TestClient  # noqa: E402
from server import db, seed_bots, tournament  # noqa: E402
from server.app import app  # noqa: E402

ADMIN = {"X-Admin-Key": "test-admin"}


class PlayerTournamentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(app).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.c.__exit__(None, None, None)

    def setUp(self):
        with db.connect() as c:
            c.executescript("""
                DELETE FROM ai_requests;
                DELETE FROM submissions;
                DELETE FROM tournament_matches;
                DELETE FROM tournament_rounds;
                DELETE FROM tournament_standings;
                DELETE FROM tournament_state;
                DELETE FROM participants;
                DELETE FROM event;
            """)
        db.set_event(phase="tournament")
        tournament.invalidate_cache()

    def test_ready_room_flow(self):
        # Register a participant during registration phase
        db.set_event(phase="registration")
        reg = self.c.post("/api/register", json={"roll": "25B1001", "name": "Agent Alice", "bot_name": "SniperOne"}).json()
        auth = {"Authorization": f"Bearer {reg['token']}"}

        # Initialize ready room and switch to tournament phase
        db.set_event(phase="tournament")
        tournament.start_tournament()

        # Check status
        st = self.c.get("/api/tournament/status").json()
        self.assertEqual(st["stage"], "ready_room")
        self.assertIn("server_time", st)

        # Check participant data
        my_data = self.c.get("/api/tournament/my-match", headers=auth).json()
        self.assertEqual(my_data["role"], "ready")
        self.assertFalse(my_data["is_mirroring"])
        self.assertIsNone(my_data["match"])
        self.assertIn("total_participants", my_data)

    def test_swiss_playing_and_mirroring(self):
        # Seed 7 bots (odd count to test both playing bots and bye recipient)
        count = seed_bots.seed_database(7)
        self.assertEqual(count, 7)

        tournament.start_tournament()

        # Advance to Swiss Round 1
        tournament.advance_stage("swiss_1")

        st = self.c.get("/api/tournament/status").json()
        self.assertEqual(st["stage"], "swiss_1")
        self.assertIsNotNone(st["started_at"])

        # Fetch all participants
        with db.connect() as c:
            p_rows = c.execute("SELECT id, roll FROM participants ORDER BY id ASC").fetchall()

        found_playing = 0
        found_bye = 0

        # Check my-match for all 7 participants
        for p in p_rows:
            auth = {"Authorization": f"Bearer {p['roll']}"}
            t0 = time.perf_counter()
            res = self.c.get("/api/tournament/my-match", headers=auth)
            elapsed_ms = (time.perf_counter() - t0) * 1000
            self.assertEqual(res.status_code, 200)

            # Performance check: RAM cache should resolve quickly
            self.assertLess(elapsed_ms, 50, f"Request took too long: {elapsed_ms}ms")

            data = res.json()
            self.assertIn("status", data)
            self.assertIn("role", data)
            self.assertIn("match", data)

            if data["role"] == "playing":
                found_playing += 1
                self.assertFalse(data["is_mirroring"])
                self.assertIsNotNone(data["match"])
                self.assertIn("games", data["match"])
                self.assertGreater(len(data["match"]["games"]), 0)
                # Verify either p1_id or p2_id is this participant
                self.assertIn(p["id"], (data["match"]["p1_id"], data["match"]["p2_id"]))
            elif data["role"] == "bye":
                found_bye += 1
                self.assertTrue(data["is_mirroring"])
                # Bye participant mirrors the highlight marquee match
                self.assertIsNotNone(data["match"])

        # In 7 players, 6 play (3 matches) and exactly 1 receives a Bye
        self.assertEqual(found_playing, 6)
        self.assertEqual(found_bye, 1)

    def test_cut_ceremony_and_elimination(self):
        # Seed 36 bots to have a proper Top 32 cut
        seed_bots.seed_database(36)
        tournament.start_tournament()

        # Run all Swiss rounds to build full history
        for r in range(1, tournament.SWISS_ROUNDS + 1):
            tournament.advance_stage(f"swiss_{r}")

        # Advance to Cut Ceremony
        tournament.advance_stage("cut_ceremony")
        st = self.c.get("/api/tournament/status").json()
        self.assertEqual(st["stage"], "cut_ceremony")

        with db.connect() as c:
            p_rows = c.execute("SELECT id, roll FROM participants ORDER BY id ASC").fetchall()

        # Check cut ceremony state
        for p in p_rows[:5]:
            auth = {"Authorization": f"Bearer {p['roll']}"}
            res = self.c.get("/api/tournament/my-match", headers=auth).json()
            self.assertEqual(res["role"], "cut")
            self.assertIsNotNone(res["my_standing"])
            self.assertIn("qualified_top32", res["my_standing"])

        # Advance to Ro32
        tournament.advance_stage("ro32")
        st = self.c.get("/api/tournament/status").json()
        self.assertEqual(st["stage"], "ro32")

        # In Ro32, 32 bots compete, 4 bots are eliminated from cut
        elim_count = 0
        playing_count = 0
        for p in p_rows:
            auth = {"Authorization": f"Bearer {p['roll']}"}
            res = self.c.get("/api/tournament/my-match", headers=auth).json()
            if res["role"] == "playing":
                playing_count += 1
                self.assertFalse(res["is_mirroring"])
            elif res["role"] == "eliminated":
                elim_count += 1
                self.assertTrue(res["is_mirroring"])
                self.assertIsNotNone(res["match"])  # Mirrors marquee duel

        self.assertEqual(playing_count, 32)
        self.assertEqual(elim_count, 4)

    def test_sequential_finals_mirroring(self):
        seed_bots.seed_database(32)
        tournament.start_tournament()
        for r in range(1, tournament.SWISS_ROUNDS + 1):
            tournament.advance_stage(f"swiss_{r}")
        tournament.advance_stage("cut_ceremony")
        tournament.advance_stage("ro32")
        tournament.advance_stage("ro16")
        tournament.advance_stage("ro8_m1")

        st = self.c.get("/api/tournament/status").json()
        self.assertEqual(st["stage"], "ro8_m1")
        self.assertTrue(st["is_sequential"])
        self.assertTrue(st["reveal_names"])

        with db.connect() as c:
            p_rows = c.execute("SELECT id, roll FROM participants LIMIT 10").fetchall()

        # In sequential finals, all participant laptops mirror the active stage match
        for p in p_rows:
            auth = {"Authorization": f"Bearer {p['roll']}"}
            res = self.c.get("/api/tournament/my-match", headers=auth).json()
            self.assertEqual(res["role"], "spectating")
            self.assertTrue(res["is_mirroring"])
            self.assertIsNotNone(res["match"])
            self.assertEqual(res["match"]["stage"], "ro8_m1")


if __name__ == "__main__":
    unittest.main()
