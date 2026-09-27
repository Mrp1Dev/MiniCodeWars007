import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("MCW_DB", str(Path(tempfile.mkdtemp(prefix="mcw_test_")) / "test.db"))
os.environ.setdefault("MCW_ADMIN_KEY", "test-admin")

from fastapi.testclient import TestClient  # noqa: E402

from server import db  # noqa: E402
from server.app import app  # noqa: E402

GOOD = ("def play(me, opp, turn, memory):\n"
        "    if me.ammo >= 2:\n        return SNIPE\n"
        "    return RELOAD\n")
CRASHY = "def play(me, opp, turn, memory):\n    if turn == 4:\n        return 1 / 0\n    return RELOAD\n"
ADMIN = {"X-Admin-Key": "test-admin"}


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(app).__enter__()  # one event loop for the whole class

    @classmethod
    def tearDownClass(cls):
        cls.c.__exit__(None, None, None)

    def setUp(self):
        with db.connect() as c:
            c.executescript("DELETE FROM ai_requests; DELETE FROM submissions; "
                            "DELETE FROM participants; DELETE FROM event;")

    def register(self, roll="25B0001", name="Test Person"):
        r = self.c.post("/api/register", json={"roll": roll, "name": name})
        self.assertEqual(r.status_code, 200, r.text)
        return {"Authorization": f"Bearer {r.json()['token']}"}

    def phase(self, phase, minutes=None):
        r = self.c.post("/api/admin/phase", json={"phase": phase, "minutes": minutes}, headers=ADMIN)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_register_and_me(self):
        auth = self.register(roll=" 25b0001 ")
        me = self.c.get("/api/me", headers=auth).json()
        self.assertEqual((me["roll"], me["entry"]), ("25B0001", None))
        again = self.c.post("/api/register", json={"roll": "25b0001", "name": "someone else"}).json()
        self.assertEqual((again["id"], again["name"], again["new"]), (me["id"], "Test Person", False))
        self.assertEqual(self.c.get("/api/me", headers=auth).status_code, 200, "the first session still works")
        self.assertEqual(self.c.get("/api/me", headers={"Authorization": f"Bearer {again['token']}"}).json()["id"], me["id"])
        self.assertEqual(self.c.get("/api/me", headers={"Authorization": "Bearer nope"}).status_code, 401)
        self.assertEqual(self.c.post("/api/register", json={"roll": "25B/01", "name": "X"}).status_code, 422)

    def test_timer_and_phases(self):
        auth = self.register()
        r = self.c.post("/api/submit", json={"code": GOOD}, headers=auth)
        self.assertEqual(r.status_code, 403, "no submitting before coding starts")

        st = self.phase("coding", minutes=30)
        self.assertAlmostEqual(st["ends_at"] - st["server_time"], 1800, delta=2)
        self.assertEqual(self.c.post("/api/submit", json={"code": GOOD}, headers=auth).status_code, 200)

        # Time runs out: the phase locks by itself.
        db.set_event(ends_at=time.time() - 60)
        self.assertEqual(self.c.get("/api/status").json()["phase"], "locked")
        self.assertEqual(self.c.post("/api/submit", json={"code": GOOD}, headers=auth).status_code, 403)

        st = self.c.post("/api/admin/extend", json={"minutes": 5}, headers=ADMIN).json()
        self.assertEqual(st["phase"], "coding")
        self.assertEqual(self.c.post("/api/submit", json={"code": GOOD}, headers=auth).status_code, 200)

    def test_submit_statuses_and_entry(self):
        self.phase("coding")
        auth = self.register()
        ok = self.c.post("/api/submit", json={"code": GOOD, "pseudocode": "reload then snipe"}, headers=auth).json()
        self.assertEqual(ok["status"], "ok")
        self.assertEqual([m["opponent"] for m in ok["report"]["matches"]], ["always_reload", "random_bot", "trigger_happy"])

        bad = self.c.post("/api/submit", json={"code": "import os\n" + GOOD}, headers=auth).json()
        self.assertEqual(bad["status"], "rejected")
        self.assertIn("os", bad["report"]["problems"][0]["message"])
        self.assertEqual(bad["entry_id"], ok["id"], "a rejected submission doesn't replace the entry")

        warn = self.c.post("/api/submit", json={"code": CRASHY}, headers=auth).json()
        self.assertEqual(warn["status"], "warning")
        self.assertIn("ZeroDivisionError", warn["report"]["matches"][0]["first_error"])
        self.assertEqual(warn["entry_id"], warn["id"])

        me = self.c.get("/api/me", headers=auth).json()
        self.assertEqual(me["entry"]["id"], warn["id"])
        self.assertEqual(len(me["submissions"]), 3)
        self.assertEqual(self.c.get(f"/api/submissions/{ok['id']}", headers=auth).json()["pseudocode"],
                         "reload then snipe")
        other = self.register(roll="25B0002")
        self.assertEqual(self.c.get(f"/api/submissions/{ok['id']}", headers=other).status_code, 404)

        entries = self.c.get("/api/admin/entries", headers=ADMIN).json()
        self.assertEqual([(e["roll"], e["submission_id"]) for e in entries], [("25B0001", warn["id"])])

    def test_test_match(self):
        auth = self.register()
        r = self.c.post("/api/test", json={"code": GOOD, "opponent": "random_bot", "seed": 5}, headers=auth)
        self.assertEqual(r.status_code, 200, r.text)
        rep = r.json()
        self.assertEqual(rep["names"], ["you", "random_bot"])
        again = self.c.post("/api/test", json={"code": GOOD, "opponent": "random_bot", "seed": 5}, headers=auth).json()
        self.assertEqual([t["actions"] for t in again["turns"]], [t["actions"] for t in rep["turns"]])
        mirror = self.c.post("/api/test", json={"code": GOOD, "opponent": "mirror"}, headers=auth).json()
        self.assertEqual(mirror["names"], ["you", "mirror"])
        self.assertEqual(self.c.post("/api/test", json={"code": GOOD, "opponent": "nobody"},
                                     headers=auth).status_code, 404)

    def test_check_and_limits(self):
        auth = self.register()
        probs = self.c.post("/api/check", json={"code": "import sys\n" + GOOD}, headers=auth).json()["problems"]
        self.assertEqual(probs[0]["line"], 1)
        self.assertEqual(self.c.post("/api/check", json={"code": "x" * 30000}, headers=auth).status_code, 422)

    def test_admin(self):
        self.assertEqual(self.c.get("/api/admin/participants").status_code, 401)
        self.register()
        self.c.post("/api/admin/announce", json={"message": "Lunch at 1"}, headers=ADMIN)
        self.assertEqual(self.c.get("/api/status").json()["announcement"], "Lunch at 1")
        rows = self.c.get("/api/admin/participants", headers=ADMIN).json()
        self.assertEqual(rows[0]["submissions"], 0)

    def test_public_info(self):
        bots = self.c.get("/api/house-bots").json()
        self.assertEqual([b["name"] for b in bots], ["always_reload", "random_bot", "trigger_happy"])
        self.assertTrue(all("def play" in b["code"] for b in bots))
        self.assertIn("SNIPE", self.c.get("/api/rules").json()["moves"])
        bundle = self.c.get("/api/engine-bundle").json()
        self.assertIn("engine/botapi.py", bundle["files"])
        self.assertEqual(bundle["config"]["game"]["start_hp"], 5)

    def test_tournament_my_match(self):
        auth = self.register(roll="25B9999", name="Tournament Tester")
        r = self.c.get("/api/tournament/my-match", headers=auth)
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("role", data)
        self.assertIn("status", data)
        self.assertIn("is_mirroring", data)
        self.assertIn("total_participants", data)


if __name__ == "__main__":
    unittest.main()
