import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("MCW_DB", str(Path(tempfile.mkdtemp(prefix="mcw_test_")) / "test.db"))
os.environ.setdefault("MCW_ADMIN_KEY", "test-admin")

from fastapi.testclient import TestClient  # noqa: E402

from server import ai, db, settings  # noqa: E402
from server.app import app  # noqa: E402

OK_ANSWER = """<status>ok</status>
<code>
```python
def play(me, opp, turn, memory):
    # if i have no ammo reload
    if me.ammo == 0:
        return RELOAD
    # else shoot
    return SHOOT
```
</code>
<notes>
- Nothing to note.
- Second note.
</notes>"""

CLARIFY_ANSWER = """<think>They want hidden info.</think>
<status>clarify</status>
<issue><quote>if front guy has no shield left</quote><problem>Can't see their shields.</problem><hint>Use opp.history.</hint></issue>
<issue><quote>x</quote><problem></problem><hint>dropped: no problem given</hint></issue>"""

UNSAFE_ANSWER = """<status>ok</status>
<code>
import os
def play(me, opp, turn, memory):
    return RELOAD
</code>
<notes></notes>"""


class FakeClient:
    """Mimics openai.OpenAI().chat.completions.create, replying from a script."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=answer))],
                               usage=SimpleNamespace(prompt_tokens=100, completion_tokens=50))


class Parsing(unittest.TestCase):
    def test_ok_strips_fences(self):
        r = ai.parse(OK_ANSWER)
        self.assertEqual(r.status, "ok")
        self.assertTrue(r.code.startswith("def play"))
        self.assertNotIn("```", r.code)
        self.assertEqual(r.notes, ["Nothing to note.", "Second note."])

    def test_clarify_ignores_thinking_and_empty_issues(self):
        r = ai.parse(CLARIFY_ANSWER)
        self.assertEqual(r.status, "clarify")
        self.assertEqual(len(r.issues), 1)
        self.assertEqual(r.issues[0]["quote"], "if front guy has no shield left")
        self.assertEqual(r.code, "")

    def test_not_pseudocode_and_garbage(self):
        self.assertEqual(ai.parse("<status>not_pseudocode</status><problem>Hi!</problem>").message, "Hi!")
        self.assertEqual(ai.parse("Sure! Here's a great bot: ...").status, "error")
        self.assertEqual(ai.parse("<status>clarify</status>").status, "error", "clarify without issues")

    def test_prompt_mentions_current_rules(self):
        self.assertIn("NOT AVAILABLE", ai.SYSTEM_PROMPT)
        self.assertIn("stops SNIPE", ai.SYSTEM_PROMPT)


class Cleaning(unittest.TestCase):
    def test_ok(self):
        client = FakeClient(OK_ANSWER)
        r = ai.clean("if i have no ammo reload else shoot", client)
        self.assertEqual((r.status, r.prompt_tokens, r.completion_tokens), ("ok", 100, 50))
        self.assertEqual(client.calls[0]["messages"][0]["content"], ai.SYSTEM_PROMPT)
        self.assertIn("if i have no ammo", client.calls[0]["messages"][1]["content"])

    def test_unsafe_code_is_repaired_once(self):
        client = FakeClient(UNSAFE_ANSWER, OK_ANSWER)
        r = ai.clean("reload forever", client)
        self.assertEqual(r.status, "ok")
        self.assertEqual((r.prompt_tokens, len(client.calls)), (200, 2))
        self.assertIn("import 'os'", client.calls[1]["messages"][-1]["content"])

    def test_unsafe_code_twice_is_an_error(self):
        r = ai.clean("reload forever", FakeClient(UNSAFE_ANSWER, UNSAFE_ANSWER))
        self.assertEqual(r.status, "error")
        self.assertEqual(r.code, "")

    def test_service_failure(self):
        with self.assertRaises(ai.AIUnavailable):
            ai.clean("x", FakeClient(ConnectionError("down")))


class Endpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(app).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.c.__exit__(None, None, None)

    def setUp(self):
        with db.connect() as c:
            c.executescript("DELETE FROM ai_requests; DELETE FROM submissions; "
                            "DELETE FROM participants; DELETE FROM event;")
        from server import app as app_module
        app_module._ai_recent.clear()
        r = self.c.post("/api/register", json={"roll": "25B0009", "name": "AI Tester"})
        self.auth = {"Authorization": f"Bearer {r.json()['token']}"}
        self.saved = (ai._client, settings.AI_PER_MINUTE, settings.AI_MAX_PER_PARTICIPANT)

    def tearDown(self):
        ai._client, settings.AI_PER_MINUTE, settings.AI_MAX_PER_PARTICIPANT = self.saved

    def post(self, text="if i have no ammo reload else shoot"):
        return self.c.post("/api/clean", json={"pseudocode": text}, headers=self.auth)

    def test_ok_is_logged(self):
        ai._client = FakeClient(OK_ANSWER, CLARIFY_ANSWER)
        r = self.post()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["remaining"], settings.AI_MAX_PER_PARTICIPANT - 1)
        self.assertEqual(self.post().json()["status"], "clarify")

        usage = self.c.get("/api/admin/ai-usage", headers={"X-Admin-Key": "test-admin"}).json()
        self.assertEqual((usage["requests"], usage["completion_tokens"]), (2, 100))
        log = self.c.get("/api/admin/ai-requests?status=clarify", headers={"X-Admin-Key": "test-admin"}).json()
        self.assertEqual(len(log), 1)
        self.assertIn("<think>", log[0]["raw"])

    def test_limits(self):
        settings.AI_PER_MINUTE = 2
        ai._client = FakeClient(*[OK_ANSWER] * 5)
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.post().status_code, 200)
        r = self.post()
        self.assertEqual(r.status_code, 429)
        self.assertIn("times a minute", r.json()["detail"])

        settings.AI_PER_MINUTE = 100
        settings.AI_MAX_PER_PARTICIPANT = 3
        self.assertEqual(self.post().json()["remaining"], 0)
        self.assertEqual(self.post().status_code, 429)

    def test_unavailable(self):
        ai._client = FakeClient(ConnectionError("down"))
        r = self.post()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(db.ai_request_count(1), 0, "failed calls don't use up the allowance")

    def test_not_during_tournament(self):
        self.c.post("/api/admin/phase", json={"phase": "tournament"}, headers={"X-Admin-Key": "test-admin"})
        self.assertEqual(self.post().status_code, 403)

    def test_starter_and_hidden_house_bots(self):
        starter = self.c.get("/api/starter").json()
        self.assertIn("def play", starter["code"])
        bots = self.c.get("/api/house-bots").json()
        self.assertTrue(bots and all(set(b) == {"name", "description"} for b in bots))


if __name__ == "__main__":
    unittest.main()
