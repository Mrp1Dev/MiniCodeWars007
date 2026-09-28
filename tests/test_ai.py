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
</code>"""

DECLINED_ANSWER = """<think>They want hidden info.</think>
<status>declined</status>
<issue><quote>if front guy has no shield left</quote><reason>Can't see their shields.</reason></issue>
<issue><quote>x</quote><reason></reason></issue>"""

UNSAFE_ANSWER = """<status>ok</status>
<code>
import os
def play(me, opp, turn, memory):
    return RELOAD
</code>"""


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
        finish = "stop"
        if answer is None:  # a thinking model that ran out of tokens mid-thought
            answer, finish = "", "length"
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=answer), finish_reason=finish)],
            usage=SimpleNamespace(prompt_tokens=100, completion_tokens=50))


class Parsing(unittest.TestCase):
    def test_ok_strips_fences(self):
        r = ai.parse(OK_ANSWER)
        self.assertEqual(r.status, "ok")
        self.assertTrue(r.code.startswith("def play"))
        self.assertNotIn("```", r.code)

    def test_declined_ignores_thinking_and_empty_issues(self):
        r = ai.parse(DECLINED_ANSWER)
        self.assertEqual(r.status, "declined")
        self.assertEqual(len(r.issues), 1)
        self.assertEqual(r.issues[0]["quote"], "if front guy has no shield left")
        self.assertEqual(r.code, "")

    def test_declined_recovers_missing_reason_tags(self):
        raw = "<status>declined</status>\n<issue><quote></quote>This isn't an attempt at describing a bot.</issue>"
        r = ai.parse(raw)
        self.assertEqual(r.status, "declined")
        self.assertEqual(len(r.issues), 1)
        self.assertEqual(r.issues[0]["reason"], "This isn't an attempt at describing a bot.")

    def test_garbage(self):
        self.assertEqual(ai.parse("Sure! Here's a great bot: ...").status, "error")
        self.assertEqual(ai.parse("<status>declined</status>").status, "error", "declined without issues")
        self.assertEqual(ai.parse("<status>ok</status><code>\n</code>").status, "error", "ok without code")

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

    def test_unsafe_code_is_an_error_without_retry(self):
        client = FakeClient(UNSAFE_ANSWER, OK_ANSWER)
        r = ai.clean("reload forever", client)
        self.assertEqual((r.status, r.code, len(client.calls)), ("error", "", 1))
        self.assertIn("import 'os'", r.message)

    def test_ran_out_of_thinking_tokens(self):
        r = ai.clean("reload forever", FakeClient(None))
        self.assertEqual(r.status, "error")
        self.assertIn("ran out of room", r.message)

    def test_service_failure(self):
        with self.assertRaises(ai.AIUnavailable):
            ai.clean("x", FakeClient(ConnectionError("down")))


class Timeout(Exception):
    """Stands in for openai.APITimeoutError (matched by name)."""


class Refused(Exception):
    """Stands in for openai.AuthenticationError & co: carries the HTTP status."""
    status_code = 401


class BackupKey(unittest.TestCase):
    """clean() without a client: the main key first, the backup key when that call fails."""

    def setUp(self):
        self.saved = (ai._client, ai._backup_client, ai._main_down_until, settings.AI_API_KEY_BACKUP)
        ai._main_down_until = 0.0

    def tearDown(self):
        ai._client, ai._backup_client, ai._main_down_until, settings.AI_API_KEY_BACKUP = self.saved

    def keys(self, main, backup):
        ai._client, ai._backup_client = main, backup

    def test_main_key_answers_first(self):
        main, backup = FakeClient(OK_ANSWER), FakeClient(OK_ANSWER)
        self.keys(main, backup)
        r = ai.clean("reload forever")
        self.assertEqual((r.status, r.key, len(main.calls), len(backup.calls)), ("ok", "main", 1, 0))

    def test_backup_answers_when_main_fails(self):
        main, backup = FakeClient(ConnectionError("down")), FakeClient(OK_ANSWER)
        self.keys(main, backup)
        r = ai.clean("reload forever")
        self.assertEqual((r.status, r.key, len(main.calls), len(backup.calls)), ("ok", "backup", 1, 1))
        self.assertEqual(ai.main_key_down_for(), 0, "a network error doesn't bench the main key")

    def test_timeout_is_not_retried(self):
        main, backup = FakeClient(Timeout("slow")), FakeClient(OK_ANSWER)
        self.keys(main, backup)
        with self.assertRaises(ai.AIUnavailable):
            ai.clean("reload forever")
        self.assertEqual(len(backup.calls), 0)

    def test_both_keys_fail(self):
        self.keys(FakeClient(ConnectionError("down")), FakeClient(ConnectionError("down too")))
        with self.assertRaises(ai.AIUnavailable):
            ai.clean("reload forever")

    def test_no_backup_key(self):
        settings.AI_API_KEY_BACKUP = None
        self.keys(FakeClient(ConnectionError("down")), None)
        with self.assertRaises(ai.AIUnavailable):
            ai.clean("reload forever")

    def test_refused_main_key_is_skipped_for_a_while(self):
        main, backup = FakeClient(Refused("bad key"), OK_ANSWER), FakeClient(OK_ANSWER, OK_ANSWER)
        self.keys(main, backup)
        self.assertEqual(ai.clean("x").key, "backup")
        self.assertGreater(ai.main_key_down_for(), ai.KEY_LOCKOUT_S - 5)
        self.assertEqual(ai.clean("x").key, "backup", "goes straight to the backup")
        self.assertEqual(len(main.calls), 1)
        ai._main_down_until = 0.0  # the lockout has passed
        self.assertEqual(ai.clean("x").key, "main")


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
        self.saved = (ai._client, ai._backup_client, ai._main_down_until, settings.AI_API_KEY_BACKUP,
                      settings.AI_PER_MINUTE, settings.AI_MAX_PER_PARTICIPANT,
                      settings.AI_TOKEN_BUDGET, settings.AI_TOKENS_PER_PARTICIPANT)
        # No backup key unless a test sets one, so a real key in .env is never called.
        ai._backup_client, ai._main_down_until, settings.AI_API_KEY_BACKUP = None, 0.0, None

    def tearDown(self):
        (ai._client, ai._backup_client, ai._main_down_until, settings.AI_API_KEY_BACKUP,
         settings.AI_PER_MINUTE, settings.AI_MAX_PER_PARTICIPANT,
         settings.AI_TOKEN_BUDGET, settings.AI_TOKENS_PER_PARTICIPANT) = self.saved

    def post(self, text="if i have no ammo reload else shoot"):
        return self.c.post("/api/clean", json={"pseudocode": text}, headers=self.auth)

    def test_ok_is_logged(self):
        ai._client = FakeClient(OK_ANSWER, DECLINED_ANSWER)
        r = self.post()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["remaining"], settings.AI_MAX_PER_PARTICIPANT - 1)
        self.assertEqual(self.post().json()["status"], "declined")

        usage = self.c.get("/api/admin/ai-usage", headers={"X-Admin-Key": "test-admin"}).json()
        self.assertEqual((usage["requests"], usage["completion_tokens"]), (2, 100))
        log = self.c.get("/api/admin/ai-requests?status=declined", headers={"X-Admin-Key": "test-admin"}).json()
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

    def test_token_budgets_reserve_the_worst_case(self):
        worst = ai.worst_case_cost("x" * 30)
        self.assertGreater(worst, settings.AI_MAX_TOKENS)
        ai._client = FakeClient(*[OK_ANSWER] * 5)  # each call really costs 50 + 100/2 = 100 units

        # Room for exactly one worst case: the first call goes through, then there's no room left.
        settings.AI_TOKENS_PER_PARTICIPANT = int(worst) + 50
        self.assertEqual(self.post("x" * 30).status_code, 200)
        self.assertAlmostEqual(db.ai_spent(), 100)
        r = self.post("x" * 30)
        self.assertEqual(r.status_code, 429)
        self.assertIn("allowance", r.json()["detail"])

        settings.AI_TOKENS_PER_PARTICIPANT = 10**9
        settings.AI_TOKEN_BUDGET = int(worst) + 99  # 100 already spent
        r = self.post("x" * 30)
        self.assertEqual(r.status_code, 503)
        self.assertIn("budget", r.json()["detail"])
        usage = self.c.get("/api/admin/ai-usage", headers={"X-Admin-Key": "test-admin"}).json()
        self.assertEqual((usage["spent"], usage["budget"]), (100, settings.AI_TOKEN_BUDGET))

    def test_backup_answer_is_logged(self):
        ai._client, ai._backup_client = FakeClient(ConnectionError("down")), FakeClient(OK_ANSWER)
        settings.AI_API_KEY_BACKUP = "backup-key"
        r = self.post()
        self.assertEqual((r.status_code, r.json()["status"]), (200, "ok"))
        admin = {"X-Admin-Key": "test-admin"}
        log = self.c.get("/api/admin/ai-requests", headers=admin).json()
        self.assertEqual(log[0]["ai_key"], "backup")
        usage = self.c.get("/api/admin/ai-usage", headers=admin).json()
        self.assertEqual((usage["by_key"], usage["backup_key_configured"]), ({"backup": 1}, True))
        self.assertNotIn("backup-key", r.text + str(log) + str(usage), "the key itself is never shown")

    def test_unavailable(self):
        ai._client = FakeClient(ConnectionError("down"))
        r = self.post()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(db.ai_request_count(1), 0, "failed calls don't use up the allowance")

    def test_not_during_tournament(self):
        self.c.post("/api/admin/phase", json={"phase": "tournament"}, headers={"X-Admin-Key": "test-admin"})
        self.assertEqual(self.post().status_code, 403)

    def test_starter_and_house_bots(self):
        starter = self.c.get("/api/starter").json()
        self.assertIn("def play", starter["code"])
        bots = self.c.get("/api/house-bots").json()
        self.assertTrue(bots and all(set(b) == {"name", "description", "code"} for b in bots))

    def test_clean_strips_and_reattaches_starter_comments(self):
        from server.app import STARTER_CODE, STARTER_COMMENTS, strip_starter_comments
        # Test unit stripping
        self.assertEqual(strip_starter_comments(STARTER_CODE), "def play(me, opp, turn, memory):\n    return RELOAD")
        pseudo_with_comments = f"{STARTER_COMMENTS}\n\nevery turn reload"
        self.assertEqual(strip_starter_comments(pseudo_with_comments), "every turn reload")

        # Test endpoint
        client = FakeClient(OK_ANSWER)
        ai._client = client
        r = self.post(pseudo_with_comments)
        self.assertEqual(r.status_code, 200)
        # Verify LLM received pseudocode WITHOUT template comments
        llm_input = client.calls[0]["messages"][1]["content"]
        self.assertNotIn("play() is called once every turn", llm_input)
        self.assertIn("every turn reload", llm_input)
        # Verify response code HAS the starter comments re-attached
        body = r.json()
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["code"].startswith(STARTER_COMMENTS))
        self.assertIn("def play", body["code"])


if __name__ == "__main__":
    unittest.main()

