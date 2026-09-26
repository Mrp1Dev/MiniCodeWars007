"""MiniCodeWars backend.

Run:  .venv/Scripts/python -m server            (http://0.0.0.0:8000, docs at /docs)

Participants authenticate with the token they get from /api/register
(header "Authorization: Bearer <token>"). Admin endpoints need "X-Admin-Key".
"""
import asyncio
import collections
import json
import re
import secrets
import sqlite3
import threading
import time
from typing import Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
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

app = FastAPI(title="MiniCodeWars 007", version="1")
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

def participant(authorization: str = Header(default="")):
    token = authorization.removeprefix("Bearer ").strip()
    row = db.participant_by_token(token) if token else None
    if row is None:
        raise HTTPException(401, "not registered, or your session expired; ask an organiser")
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


class CodeBody(BaseModel):
    code: str = Code


class TestBody(BaseModel):
    code: str = Code
    opponent: str = "random_bot"
    seed: Optional[int] = None


class CleanBody(BaseModel):
    pseudocode: str = Field(min_length=1, max_length=ai.MAX_PSEUDOCODE_CHARS)


class SubmitBody(BaseModel):
    code: str = Code
    pseudocode: Optional[str] = Field(default=None, max_length=MAX_SOURCE_CHARS)


class PhaseBody(BaseModel):
    phase: Literal[PHASES]
    minutes: Optional[float] = Field(default=None, gt=0, le=600, description="timer length, for the coding phase")


class ExtendBody(BaseModel):
    minutes: float = Field(gt=-120, le=120)


class AnnounceBody(BaseModel):
    message: str = Field(max_length=500)


class RollBody(BaseModel):
    roll: str


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
    """Opponents you can test against. Their code stays secret."""
    return [{"name": b["name"], "description": b["description"]} for b in HOUSE_BOTS.values()]


STARTER = {
    "code": (settings.ROOT / "starter" / "bot.py").read_text(encoding="utf-8"),
    "pseudocode": (settings.ROOT / "starter" / "pseudocode.txt").read_text(encoding="utf-8"),
}


@app.get("/api/starter")
def starter():
    """What a participant's editor starts with."""
    return STARTER


@app.post("/api/register")
def register(body: RegisterBody):
    require_phase("registration", "coding")
    token = secrets.token_urlsafe(24)
    try:
        pid = db.create_participant(body.roll, body.name, token)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "this roll number is already registered; ask an organiser to recover your session")
    return {"token": token, "id": pid, "roll": body.roll, "name": body.name}


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
    return {
        "id": p["id"], "roll": p["roll"], "name": p["name"],
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
    spent = await run_in_threadpool(lambda: (db.ai_spent(), db.ai_spent(p["id"])))
    budget = _AIBudget(p["id"], body.pseudocode, *spent)
    with _OnePerParticipant(p["id"], "ai"), budget:
        _ai_rate_check(p["id"])
        start = time.perf_counter()
        try:
            result = await run_limited(_ai_slots, AI_QUEUE_WAIT_S,
                                       "lots of people are using the AI right now, try again in a minute",
                                       ai.clean, body.pseudocode)
        except ai.AIUnavailable as e:
            await run_in_threadpool(db.add_ai_request, p["id"], body.pseudocode, "unavailable",
                                    {"message": str(e)}, None, 0, 0, 0)
            raise HTTPException(503, str(e))
        ms = int((time.perf_counter() - start) * 1000)
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
    return status()


@app.post("/api/admin/extend", dependencies=[Depends(admin)])
def extend(body: ExtendBody):
    ev = db.get_event()
    if ev["phase"] not in ("coding", "locked") or not ev["ends_at"]:
        raise HTTPException(400, "no running timer to extend")
    db.set_event(phase="coding", ends_at=ev["ends_at"] + body.minutes * 60)
    return status()


@app.post("/api/admin/announce", dependencies=[Depends(admin)])
def announce(body: AnnounceBody):
    db.set_event(announcement=body.message)
    return status()


@app.get("/api/admin/participants", dependencies=[Depends(admin)])
def participants():
    return [dict(r) for r in db.list_participants()]


@app.post("/api/admin/reset-token", dependencies=[Depends(admin)])
def reset_token(body: RollBody):
    """For a participant who lost their session (cleared browser, switched laptop)."""
    row = db.participant_by_roll(body.roll.strip().upper())
    if row is None:
        raise HTTPException(404, "no participant with that roll number")
    token = secrets.token_urlsafe(24)
    db.set_token(row["id"], token)
    return {"roll": row["roll"], "name": row["name"], "token": token}


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


# --- website ---------------------------------------------------------------------------
# Everything in web/ is served at /, so the site and the API share one origin.
# Mounted last so it never shadows /api or /docs.
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
