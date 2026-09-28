"""007 Quickdraw backend.

Run:  .venv/Scripts/python -m server            (http://0.0.0.0:8000, docs at /docs)

Participants authenticate with the token they get from /api/register
(header "Authorization: Bearer <token>"). Admin endpoints need "X-Admin-Key".
"""
import asyncio
import collections
import json
import mimetypes
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from engine.botapi import MAX_SOURCE_CHARS, check_source

from . import ai, db, settings
from .matches import CFG, HOUSE_BOTS, VALIDATION_OPPONENTS, test_match, validate

SUBMIT_GRACE_S = 15  # submissions sent just before the deadline still count
PHASES = ("registration", "coding", "locked", "tournament")
ADMIN_KEY_FILE = db.DB_PATH.parent / "admin_key.txt"
WEB_DIR = settings.ROOT / "web"


def _admin_key():
    key = settings.ADMIN_KEY
    if key:
        return key
    if ADMIN_KEY_FILE.exists():
        return ADMIN_KEY_FILE.read_text().strip()
    ADMIN_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_urlsafe(18)
    ADMIN_KEY_FILE.write_text(key)
    return key


ADMIN_KEY = _admin_key()

app = FastAPI(title="007 Quickdraw", version="1")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- event phase ---------------------------------------------------------------------

def current_event():
    """The event state, with the coding phase closed automatically when time runs out."""
    ev = db.get_event()
    if ev["phase"] == "coding" and ev["ends_at"] and time.time() > ev["ends_at"] + SUBMIT_GRACE_S:
        db.set_event(phase="locked")
        ev["phase"] = "locked"
    return ev


def require_phase(*allowed):
    ev = current_event()
    if ev["phase"] not in allowed:
        raise HTTPException(403, f"not allowed during the {ev['phase']} phase")
    return ev


# --- auth ----------------------------------------------------------------------------

def participant(authorization: str = Header(default=""), x_roll: str = Header(default="")):
    roll = (authorization.removeprefix("Bearer ").strip() or x_roll.strip()).upper()
    row = db.participant_by_roll(roll) if roll else None
    if row is None:
        raise HTTPException(401, "not registered; please sign in with your roll number")
    return row


def admin(x_admin_key: str = Header(default="")):
    if not secrets.compare_digest(x_admin_key, ADMIN_KEY):
        raise HTTPException(401, "bad admin key")


# --- limits --------------------------------------------------------------------------
# Slow work (matches, AI calls) waits for a slot in the event loop, not in a thread, so a
# queue of 400 people can't use up the thread pool and freeze /api/status for everyone.

MATCH_QUEUE_WAIT_S = 20
AI_QUEUE_WAIT_S = 120
_match_slots = asyncio.Semaphore(settings.MAX_PARALLEL_MATCHES)
_ai_slots = asyncio.Semaphore(settings.AI_CONCURRENCY)


async def run_limited(slots, wait_s, busy_message, fn, *args):
    try:
        await asyncio.wait_for(slots.acquire(), wait_s)
    except TimeoutError:
        raise HTTPException(503, busy_message)
    try:
        return await run_in_threadpool(fn, *args)
    finally:
        slots.release()


class _OnePerParticipant:
    """One running job of each kind per participant, so nobody can hog the laptop."""
    _running = set()
    _lock = threading.Lock()

    def __init__(self, pid, kind):
        self.key = (pid, kind)

    def __enter__(self):
        with self._lock:
            if self.key in self._running:
                raise HTTPException(429, "your previous request is still running")
            self._running.add(self.key)

    def __exit__(self, *exc):
        with self._lock:
            self._running.discard(self.key)


_ai_recent = collections.defaultdict(collections.deque)  # participant id -> request times
_ai_recent_lock = threading.Lock()


class _AIBudget:
    """Reserves a request's worst-case cost before calling the AI, so neither the event budget
    nor a participant's budget can be overshot, even with many requests in flight."""
    _lock = threading.Lock()
    _reserved = collections.Counter()  # participant id -> reserved units ("all" = everyone)

    def __init__(self, pid, pseudocode, spent_all, spent_mine):
        self.pid = pid
        self.amount = ai.worst_case_cost(pseudocode)
        self.spent_all, self.spent_mine = spent_all, spent_mine

    def __enter__(self):
        spent_all, spent_mine = self.spent_all, self.spent_mine
        with self._lock:
            if spent_all + self._reserved["all"] + self.amount > settings.AI_TOKEN_BUDGET:
                raise HTTPException(503, "the AI budget for this event is used up; "
                                         "you can still edit your code by hand")
            if spent_mine + self._reserved[self.pid] + self.amount > settings.AI_TOKENS_PER_PARTICIPANT:
                raise HTTPException(429, "you've used up your AI allowance; you can still edit your code by hand")
            self._reserved["all"] += self.amount
            self._reserved[self.pid] += self.amount

    def __exit__(self, *exc):
        with self._lock:
            self._reserved["all"] -= self.amount
            self._reserved[self.pid] -= self.amount


def _ai_rate_check(pid):
    now = time.time()
    with _ai_recent_lock:
        recent = _ai_recent[pid]
        while recent and now - recent[0] > 60:
            recent.popleft()
        if len(recent) >= settings.AI_PER_MINUTE:
            wait = int(60 - (now - recent[0])) + 1
            raise HTTPException(429, f"slow down: you can use the AI {settings.AI_PER_MINUTE} times a minute "
                                     f"(try again in {wait}s)")
        recent.append(now)


# --- request bodies ------------------------------------------------------------------

Code = Field(max_length=MAX_SOURCE_CHARS)


class RegisterBody(BaseModel):
    roll: str = Field(min_length=3, max_length=20)
    name: str = Field(min_length=1, max_length=60)
    bot_name: Optional[str] = Field(default=None, max_length=50)

    @field_validator("roll")
    @classmethod
    def clean_roll(cls, v):
        v = v.strip().upper()
        if not re.fullmatch(r"[A-Z0-9]+", v):
            raise ValueError("roll number should only have letters and digits")
        return v

    @field_validator("name")
    @classmethod
    def clean_name(cls, v):
        v = " ".join(v.split())
        if not v:
            raise ValueError("name can't be empty")
        return v

    @field_validator("bot_name")
    @classmethod
    def clean_bot_name(cls, v):
        if v is None:
            return None
        v = " ".join(v.split())
        return v or None


class CodeBody(BaseModel):
    code: str = Code


class TestBody(BaseModel):
    code: str = Code
    opponent: str = "random_bot"
    seed: Optional[int] = None


class CleanBody(BaseModel):
    pseudocode: str = Field(min_length=1, max_length=MAX_SOURCE_CHARS)


class SubmitBody(BaseModel):
    code: str = Code
    pseudocode: Optional[str] = Field(default=None, max_length=MAX_SOURCE_CHARS)


class PhaseBody(BaseModel):
    phase: Literal[PHASES]
    minutes: Optional[float] = Field(default=None, gt=0, le=600, description="timer length, for the coding phase")
    reset_tournament: bool = Field(default=False, description="with phase=tournament: start from a fresh Ready Room")


class ExtendBody(BaseModel):
    minutes: float = Field(gt=-120, le=120)


class AnnounceBody(BaseModel):
    message: str = Field(max_length=500)


class RollBody(BaseModel):
    roll: str


class TournAdvanceBody(BaseModel):
    target_stage: Optional[str] = None


class TournPauseBody(BaseModel):
    paused: Optional[bool] = None


class TournStepBody(BaseModel):
    step: int


class TournHighlightBody(BaseModel):
    match_id: int


class TournSeedBody(BaseModel):
    count: int = Field(default=64, ge=4, le=500)


# --- public ------------------------------------------------------------------------------

@app.get("/api/status")
def status():
    """Phase and timer. Clients should compute the countdown as ends_at - server_time,
    so a wrong laptop clock doesn't matter."""
    ev = current_event()
    return {**ev, "server_time": time.time(), "submit_grace_s": SUBMIT_GRACE_S}


@app.get("/api/rules")
def rules():
    return {"config": CFG.raw, "moves": list(CFG.actions)}


@app.get("/api/house-bots")
def house_bots():
    """Opponents you can test against, with their code (the browser plays test matches itself)."""
    return [{"name": b["name"], "description": b["description"], "code": b["source"]} for b in HOUSE_BOTS.values()]


# The engine files the browser needs to run matches with Pyodide (no sandbox: it's their own laptop).
ENGINE_FILES = ("__init__.py", "botapi.py", "config.py", "match.py", "rules.py")
ENGINE_BUNDLE = {
    "files": {f"engine/{name}": (settings.ROOT / "engine" / name).read_text(encoding="utf-8")
              for name in ENGINE_FILES},
    "config": CFG.raw,
}


@app.get("/api/engine-bundle")
def engine_bundle():
    """Engine source and game config, for local test matches in the browser. House bots come from
    /api/house-bots."""
    return ENGINE_BUNDLE


STARTER_CODE = (settings.ROOT / "starter" / "bot.py").read_text(encoding="utf-8")
STARTER_COMMENTS = STARTER_CODE.split("def play", 1)[0].strip() if "def play" in STARTER_CODE else ""


def strip_starter_comments(text: str) -> str:
    if not text:
        return ""
    clean = text.replace("\r\n", "\n")
    norm_starter = STARTER_COMMENTS.replace("\r\n", "\n").strip()
    if norm_starter and norm_starter in clean:
        return clean.replace(norm_starter, "").strip()
    if "play() is called" in clean or "Write your bot" in clean:
        play_idx = clean.find("def play")
        if play_idx != -1:
            before_play = clean[:play_idx]
            if "play() is called" in before_play or "Write your bot" in before_play:
                return clean[play_idx:].strip()
        marker = "opp.history[-1]"
        m_idx = clean.find(marker)
        if m_idx != -1:
            line_end = clean.find("\n", m_idx)
            if line_end != -1:
                return clean[line_end + 1:].strip()
        lines = clean.split("\n")
        i = 0
        while i < len(lines) and (lines[i].strip().startswith("#") or not lines[i].strip()):
            i += 1
        header = "\n".join(lines[:i])
        if "play() is called" in header or "Write your bot" in header:
            return "\n".join(lines[i:]).strip()
    return clean.strip()

STARTER = {
    "code": STARTER_CODE,
    "pseudocode": (settings.ROOT / "starter" / "pseudocode.txt").read_text(encoding="utf-8"),
}


@app.get("/api/starter")
def starter():
    """What a participant's editor starts with."""
    return STARTER


@app.post("/api/register")
def register(body: RegisterBody):
    """Signs in with roll number + name + bot_name. Identified directly by roll number in local browser storage;
    no crypto tokens or multi-laptop session tracking."""
    bot_name = body.bot_name or body.name
    row = db.participant_by_roll(body.roll)
    if row is None:
        require_phase("registration", "coding")
        try:
            pid = db.create_participant(body.roll, body.name, bot_name)
            return {"token": body.roll, "id": pid, "roll": body.roll, "name": body.name, "bot_name": bot_name, "new": True}
        except sqlite3.IntegrityError:  # registered by a request that raced this one
            row = db.participant_by_roll(body.roll)
    else:
        if body.bot_name and not row["bot_name"]:
            db.update_participant(row["id"], bot_name=body.bot_name)
            row = db.participant_by_roll(body.roll)
    resolved_bot_name = row["bot_name"] if ("bot_name" in row.keys() and row["bot_name"]) else (row["name"] if "name" in row.keys() else bot_name)
    return {"token": row["roll"], "id": row["id"], "roll": row["roll"], "name": row["name"], "bot_name": resolved_bot_name, "new": False}


# --- participant -------------------------------------------------------------------------

def _submission_json(row, with_code=True):
    out = {"id": row["id"], "status": row["status"], "created_at": row["created_at"],
           "report": json.loads(row["report"])}
    if with_code:
        out["code"] = row["code"]
        out["pseudocode"] = row["pseudocode"]
    return out


@app.get("/api/me")
def me(p=Depends(participant)):
    entry = db.entry_of(p["id"])
    bot_name = p["bot_name"] if "bot_name" in p.keys() and p["bot_name"] else p["name"]
    return {
        "id": p["id"], "roll": p["roll"], "name": p["name"], "bot_name": bot_name,
        "entry": _submission_json(entry) if entry else None,
        "submissions": [dict(r) for r in db.submissions_of(p["id"])],
    }


@app.get("/api/submissions/{submission_id}")
def get_submission(submission_id: int, p=Depends(participant)):
    row = db.submission(p["id"], submission_id)
    if row is None:
        raise HTTPException(404, "no such submission")
    return _submission_json(row)


@app.post("/api/check")
def check(body: CodeBody, p=Depends(participant)):
    """Fast static check (no running), e.g. for underlining problems in the editor."""
    return {"problems": check_source(body.code)}


BUSY = "the server is busy, try again in a few seconds"


@app.post("/api/test")
async def test(body: TestBody, p=Depends(participant)):
    """Plays one match against a house bot (or "mirror": your bot vs itself) and returns the replay."""
    if body.opponent != "mirror" and body.opponent not in HOUSE_BOTS:
        raise HTTPException(404, f"unknown opponent; choose from {sorted(HOUSE_BOTS)} or 'mirror'")
    ev = await run_in_threadpool(current_event)
    if ev["phase"] == "tournament":
        raise HTTPException(403, "testing is closed during the tournament")
    seed = body.seed if body.seed is not None else secrets.randbelow(10**9)
    with _OnePerParticipant(p["id"], "match"):
        return await run_limited(_match_slots, MATCH_QUEUE_WAIT_S, BUSY, test_match, body.code, body.opponent, seed)


@app.post("/api/submit")
async def submit(body: SubmitBody, p=Depends(participant)):
    """Checks the code (static check + test matches against house bots) and stores it.
    The latest submission that isn't rejected is the one used in the tournament."""
    ev = await run_in_threadpool(require_phase, "coding")
    if ev["ends_at"] and time.time() > ev["ends_at"] + SUBMIT_GRACE_S:
        raise HTTPException(403, "time is up")
    with _OnePerParticipant(p["id"], "match"):
        status_, report = await run_limited(_match_slots, MATCH_QUEUE_WAIT_S, BUSY, validate, body.code)
    sid = await run_in_threadpool(db.add_submission, p["id"], body.code, body.pseudocode, status_, report)
    entry = await run_in_threadpool(db.entry_of, p["id"])
    return {"id": sid, "status": status_, "accepted": status_ != "rejected", "report": report,
            "entry_id": entry["id"] if entry else None, "checked_against": list(VALIDATION_OPPONENTS)}


@app.post("/api/clean")
async def clean(body: CleanBody, p=Depends(participant)):
    """Translates pseudocode into bot code. Returns one of:
      {"status": "ok", "code"}
      {"status": "declined", "issues": [{"quote", "reason"}]}   (no code; the pseudocode needs work)
      {"status": "error", "message"}                             (the AI misbehaved; try again)
    plus "remaining": how many cleanups this participant has left.
    """
    await run_in_threadpool(require_phase, "registration", "coding")
    used = await run_in_threadpool(db.ai_request_count, p["id"])
    if used >= settings.AI_MAX_PER_PARTICIPANT:
        raise HTTPException(429, f"you've used all {settings.AI_MAX_PER_PARTICIPANT} AI cleanups; "
                                 "you can still edit the code yourself")
    # Strip starter comments before sending to the LLM (saves characters and prompt tokens)
    pseudocode = strip_starter_comments(body.pseudocode)
    if len(pseudocode) > ai.MAX_PSEUDOCODE_CHARS:
        raise HTTPException(400, f"pseudocode is too long: {len(pseudocode)} of {ai.MAX_PSEUDOCODE_CHARS} characters")
    if not pseudocode:
        pseudocode = "return RELOAD"

    spent = await run_in_threadpool(lambda: (db.ai_spent(), db.ai_spent(p["id"])))
    budget = _AIBudget(p["id"], pseudocode, *spent)
    with _OnePerParticipant(p["id"], "ai"), budget:
        _ai_rate_check(p["id"])
        start = time.perf_counter()
        try:
            result = await run_limited(_ai_slots, AI_QUEUE_WAIT_S,
                                       "lots of people are using the AI right now, try again in a minute",
                                       ai.clean, pseudocode)
        except ai.AIUnavailable as e:
            await run_in_threadpool(db.add_ai_request, p["id"], body.pseudocode, "unavailable",
                                    {"message": str(e)}, None, 0, 0, 0)
            raise HTTPException(503, str(e))
        ms = int((time.perf_counter() - start) * 1000)

        # Attach starter comments back to the LLM's cleaned code
        if result.status == "ok" and result.code and STARTER_COMMENTS:
            norm_code = result.code.replace("\r\n", "\n")
            norm_starter = STARTER_COMMENTS.replace("\r\n", "\n").strip()
            if not norm_code.startswith(norm_starter):
                result.code = f"{norm_starter}\n\n{norm_code.lstrip()}"

        public = result.public()
        # Logged before the reservation is released, so the spend is never counted as free.
        await run_in_threadpool(db.add_ai_request, p["id"], body.pseudocode, result.status, public, result.raw,
                                result.prompt_tokens, result.completion_tokens, ms)
    return {**public, "remaining": settings.AI_MAX_PER_PARTICIPANT - used - 1}


# --- admin -------------------------------------------------------------------------------

@app.post("/api/admin/phase", dependencies=[Depends(admin)])
def set_phase(body: PhaseBody):
    ends_at = time.time() + body.minutes * 60 if body.phase == "coding" and body.minutes else None
    db.set_event(phase=body.phase, ends_at=ends_at)
    # The tournament keeps its own stage. Going back to registration starts the event over, so it
    # also clears every tournament result; otherwise a test run's Round 1 roster would stay frozen
    # in and lock real participants out of later rounds.
    if body.phase == "registration" or (body.phase == "tournament" and body.reset_tournament):
        tournament.start_tournament()
    return status()


@app.post("/api/admin/extend", dependencies=[Depends(admin)])
def extend(body: ExtendBody):
    ev = db.get_event()
    if ev["phase"] not in ("coding", "locked"):
        raise HTTPException(400, f"cannot adjust timer during {ev['phase']} phase")
    now = time.time()
    if body.minutes > 0:
        # If adding time, start from current ends_at (if still in future) or from now (if expired/locked/None)
        current_ends = ev["ends_at"] if (ev.get("ends_at") and ev["ends_at"] > now) else now
        new_ends = current_ends + body.minutes * 60
        db.set_event(phase="coding", ends_at=new_ends)
    else:
        # If reducing timer, ensure there is an active running timer
        if not ev.get("ends_at") or ev["ends_at"] <= now:
            raise HTTPException(400, "no running timer to reduce")
        new_ends = max(now + 10, ev["ends_at"] + body.minutes * 60)
        db.set_event(phase="coding", ends_at=new_ends)
    return status()



@app.post("/api/admin/announce", dependencies=[Depends(admin)])
def announce(body: AnnounceBody):
    db.set_event(announcement=body.message)
    return status()


@app.get("/api/admin/participants", dependencies=[Depends(admin)])
def participants():
    return [dict(r) for r in db.list_participants()]


@app.get("/api/admin/entries", dependencies=[Depends(admin)])
def entries():
    """Everyone's tournament entry (latest non-rejected submission), with code."""
    return [dict(r) for r in db.all_entries()]


@app.get("/api/admin/ai-usage", dependencies=[Depends(admin)])
def ai_usage():
    """Usage so far. "spent" and "budget" are in output-equivalent tokens (output + input/2)."""
    return {**db.ai_usage(), "budget": settings.AI_TOKEN_BUDGET,
            "per_participant_budget": settings.AI_TOKENS_PER_PARTICIPANT}


@app.get("/api/admin/ai-requests", dependencies=[Depends(admin)])
def ai_requests(status: Optional[str] = None, limit: int = 100):
    """Recent AI requests with the raw model output, for checking and tuning the prompt."""
    return [dict(r) for r in db.ai_requests(min(limit, 1000), status)]


# --- tournament ------------------------------------------------------------------------
from . import tournament


@app.get("/api/tournament/status")
def tournament_status():
    """Ultra-fast tournament status and clock offset, served from memory cache."""
    return tournament.get_tournament_status()


@app.get("/api/tournament/my-match")
def tournament_my_match(p=Depends(participant)):
    """Personalized tournament view for a participant's laptop, served from memory cache."""
    return tournament.get_participant_data(p["id"])


@app.get("/api/tournament/screen")
def tournament_screen():
    """Aggregated payload for the Big Screen projector (tiers, highlight replay, countdown)."""
    return Response(tournament.get_screen_json(), media_type="application/json")


@app.get("/api/tournament/bracket")
def tournament_bracket():
    """Current 32-player single-elimination bracket tree."""
    return tournament.build_elimination_bracket()


@app.get("/api/tournament/match/{match_id}")
def tournament_match(match_id: int):
    with db.connect() as c:
        row = c.execute("""
            SELECT m.*, p1.bot_name as p1_bot, p1.name as p1_real,
                        p2.bot_name as p2_bot, p2.name as p2_real
            FROM tournament_matches m
            JOIN participants p1 ON p1.id = m.p1_id
            LEFT JOIN participants p2 ON p2.id = m.p2_id
            WHERE m.id = ?
        """, (match_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such match")
        reveal_names = row["stage"] in tournament.SEQUENTIAL_STAGES
        return {
            "match_id": row["id"],
            "stage": row["stage"],
            "start_hp": tournament.get_stage_cfg(row["stage"]).start_hp,
            "is_bye": bool(row["is_bye"]),
            "p1_id": row["p1_id"],
            "p2_id": row["p2_id"],
            "p1_name": row["p1_bot"] or row["p1_real"],
            "p2_name": (row["p2_bot"] or row["p2_real"]) if row["p2_id"] else "BYE",
            "p1_real_name": row["p1_real"] if reveal_names else "",
            "p2_real_name": row["p2_real"] if (reveal_names and row["p2_id"]) else "",
            "p1_score": row["p1_score"],
            "p2_score": row["p2_score"],
            "winner_id": row["winner_id"],
            "draw_reason": row["draw_reason"],
            "games": json.loads(row["replay_json"]),
            "highlight_score": row["highlight_score"],
        }


@app.post("/api/admin/tournament/start", dependencies=[Depends(admin)])
def admin_tournament_start():
    db.set_event(phase="tournament")
    return tournament.start_tournament()


@app.post("/api/admin/tournament/advance", dependencies=[Depends(admin)])
def admin_tournament_advance(body: TournAdvanceBody = TournAdvanceBody()):
    if db.get_event()["phase"] != "tournament":
        raise HTTPException(400, "Switch the event to the Tournament phase (Phase Management) before launching rounds.")
    try:
        return tournament.advance_stage(body.target_stage)
    except ValueError as e:
        raise HTTPException(400, str(e))



@app.post("/api/admin/tournament/undo", dependencies=[Depends(admin)])
def admin_tournament_undo():
    """Discards the current stage's results and shows the previous stage again."""
    try:
        return tournament.undo_stage()
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/admin/tournament/pause", dependencies=[Depends(admin)])
def admin_tournament_pause(body: TournPauseBody = TournPauseBody()):
    return tournament.toggle_pause(body.paused)


@app.post("/api/admin/tournament/step", dependencies=[Depends(admin)])
def admin_tournament_step(body: TournStepBody):
    return tournament.set_turn_step(body.step)


@app.post("/api/admin/tournament/highlight", dependencies=[Depends(admin)])
def admin_tournament_highlight(body: TournHighlightBody):
    tournament.update_state(highlight_match_id=body.match_id)
    return tournament.get_screen_data()


@app.post("/api/admin/tournament/seed", dependencies=[Depends(admin)])
def admin_tournament_seed(body: TournSeedBody = TournSeedBody()):
    from . import seed_bots
    count = seed_bots.seed_database(body.count)
    return tournament.start_tournament()


@app.api_route("/api/admin/tournament/clear-mock", methods=["GET", "POST"], dependencies=[Depends(admin)])
def admin_tournament_clear_mock():
    from . import seed_bots
    seed_bots.clear_mock_participants()
    return tournament.start_tournament()


def reset_in_memory_state():
    with _ai_recent_lock:
        _ai_recent.clear()
    with _AIBudget._lock:
        _AIBudget._reserved.clear()
    with _OnePerParticipant._lock:
        _OnePerParticipant._running.clear()


@app.api_route("/api/admin/clear-db", methods=["GET", "POST"], dependencies=[Depends(admin)])
@app.api_route("/api/admin/clear-database", methods=["GET", "POST"], dependencies=[Depends(admin)])
@app.api_route("/api/admin/clear-databases", methods=["GET", "POST"], dependencies=[Depends(admin)])
@app.api_route("/api/admin/database/clear", methods=["GET", "POST"], dependencies=[Depends(admin)])
def admin_clear_database():
    """Clears all participants, submissions, AI requests, tournament data, and event state across all databases."""
    db.clear_all_databases()
    tournament.reset_tournament()
    reset_in_memory_state()
    return {"status": "ok", "message": "All databases cleared successfully.", **status()}



# --- website ---------------------------------------------------------------------------
# Everything in web/ is served at /, so the site and the API share one origin.
# Mounted last so it never shadows /api or /docs.

# Windows takes MIME types from the registry, which often maps .js to text/plain and doesn't know
# .wasm; browsers then refuse to run the site's modules and Pyodide.
for _type, _ext in (("text/javascript", ".js"), ("text/javascript", ".mjs"), ("text/css", ".css"),
                    ("application/wasm", ".wasm"), ("application/json", ".json"), ("image/svg+xml", ".svg"),
                    ("application/zip", ".zip"), ("image/png", ".png")):
    mimetypes.add_type(_type, _ext)


class WebFiles(StaticFiles):
    """Serves the precompressed file.gz next to a file when the browser accepts gzip (the build
    writes them; Pyodide's wasm shrinks from ~10 MB to ~3 MB), and lets browsers cache files whose
    names never change for different content (Vite's hashed assets, the versioned Pyodide folder)."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code != 200 or not isinstance(response, FileResponse):
            return response
        immutable = path.replace("\\", "/").startswith(("assets/", "pyodide/"))  # Windows gives \ paths
        accepts = dict(scope["headers"]).get(b"accept-encoding", b"")
        gz = Path(response.path + ".gz")
        if b"gzip" in accepts and gz.is_file():
            response = FileResponse(gz, media_type=response.media_type,
                                    headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
        response.headers["Cache-Control"] = ("public, max-age=31536000, immutable" if immutable
                                             else "no-cache")
        return response


@app.get("/admin", response_class=FileResponse)
@app.get("/admin/{path:path}", response_class=FileResponse)
@app.get("/screen", response_class=FileResponse)
@app.get("/screen/{path:path}", response_class=FileResponse)
def spa_page():
    index_file = WEB_DIR / "index.html"
    if index_file.is_file():
        return FileResponse(index_file, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    raise HTTPException(404, "Website not built yet")


if WEB_DIR.is_dir():
    app.mount("/", WebFiles(directory=WEB_DIR, html=True), name="web")
