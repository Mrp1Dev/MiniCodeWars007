"""SQLite storage: participants, submissions and event state (phase, timer, banner)."""
import hashlib
import json
import sqlite3
import threading
import time
from contextlib import contextmanager

from .settings import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS participants (
    id          INTEGER PRIMARY KEY,
    roll        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    token_hash  TEXT,
    created_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
    id              INTEGER PRIMARY KEY,
    participant_id  INTEGER NOT NULL REFERENCES participants(id),
    code            TEXT NOT NULL,
    pseudocode      TEXT,
    status          TEXT NOT NULL,          -- ok | warning | rejected
    report          TEXT NOT NULL,          -- JSON
    created_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_by_participant ON submissions(participant_id, id);
CREATE TABLE IF NOT EXISTS ai_requests (
    id                 INTEGER PRIMARY KEY,
    participant_id     INTEGER NOT NULL REFERENCES participants(id),
    pseudocode         TEXT NOT NULL,
    status             TEXT NOT NULL,       -- ok | declined | error | unavailable
    response           TEXT NOT NULL,       -- JSON sent to the participant
    raw                TEXT,                -- model output, for tuning the prompt
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    ms                 INTEGER NOT NULL DEFAULT 0,
    created_at         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_by_participant ON ai_requests(participant_id, id);
CREATE TABLE IF NOT EXISTS event (
    key    TEXT PRIMARY KEY,
    value  TEXT
);
"""

_init_lock = threading.Lock()
_initialised = False


@contextmanager
def connect():
    global _initialised
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        if not _initialised:
            with _init_lock:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(SCHEMA)
                conn.execute("DROP TABLE IF EXISTS sessions")
                _initialised = True
        with conn:  # commits, or rolls back on error
            yield conn
    finally:
        conn.close()


# --- event state -------------------------------------------------------------------

def get_event():
    with connect() as c:
        rows = dict(c.execute("SELECT key, value FROM event").fetchall())
    return {
        "phase": rows.get("phase", "registration"),
        "ends_at": float(rows["ends_at"]) if rows.get("ends_at") else None,
        "announcement": rows.get("announcement") or "",
    }


def set_event(**values):
    with connect() as c:
        for k, v in values.items():
            c.execute("INSERT INTO event(key, value) VALUES(?, ?) "
                      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                      (k, None if v is None else str(v)))


# --- participants ------------------------------------------------------------------

def create_participant(roll, name, token=None):
    with connect() as c:
        cur = c.execute("INSERT INTO participants(roll, name, token_hash, created_at) VALUES(?, ?, ?, ?)",
                        (roll, name, roll, time.time()))
        return cur.lastrowid


def participant_by_token(token):
    return participant_by_roll(token)


def participant_by_roll(roll):
    with connect() as c:
        return c.execute("SELECT * FROM participants WHERE roll = ?", (roll,)).fetchone()


def list_participants():
    with connect() as c:
        return c.execute("""
            SELECT p.id, p.roll, p.name, p.created_at,
                   COUNT(s.id) AS submissions,
                   (SELECT status FROM submissions WHERE participant_id = p.id ORDER BY id DESC LIMIT 1) AS last_status,
                   (SELECT MAX(id) FROM submissions WHERE participant_id = p.id AND status != 'rejected') AS entry_id
            FROM participants p LEFT JOIN submissions s ON s.participant_id = p.id
            GROUP BY p.id ORDER BY p.id
        """).fetchall()


# --- submissions -------------------------------------------------------------------

def add_submission(participant_id, code, pseudocode, status, report):
    with connect() as c:
        cur = c.execute("INSERT INTO submissions(participant_id, code, pseudocode, status, report, created_at) "
                        "VALUES(?, ?, ?, ?, ?, ?)",
                        (participant_id, code, pseudocode, status, json.dumps(report), time.time()))
        return cur.lastrowid


def submission(participant_id, submission_id):
    with connect() as c:
        return c.execute("SELECT * FROM submissions WHERE participant_id = ? AND id = ?",
                         (participant_id, submission_id)).fetchone()


def submissions_of(participant_id):
    with connect() as c:
        return c.execute("SELECT id, status, created_at FROM submissions WHERE participant_id = ? ORDER BY id DESC",
                         (participant_id,)).fetchall()


def entry_of(participant_id):
    """The submission that counts: the latest one that wasn't rejected."""
    with connect() as c:
        return c.execute("SELECT * FROM submissions WHERE participant_id = ? AND status != 'rejected' "
                         "ORDER BY id DESC LIMIT 1", (participant_id,)).fetchone()


def all_entries():
    with connect() as c:
        return c.execute("""
            SELECT p.roll, p.name, s.id AS submission_id, s.status, s.code, s.created_at
            FROM participants p JOIN submissions s ON s.id = (
                SELECT MAX(id) FROM submissions WHERE participant_id = p.id AND status != 'rejected')
            ORDER BY p.id
        """).fetchall()


# --- AI requests ---------------------------------------------------------------------

def add_ai_request(participant_id, pseudocode, status, response, raw, prompt_tokens, completion_tokens, ms):
    with connect() as c:
        c.execute("INSERT INTO ai_requests(participant_id, pseudocode, status, response, raw, prompt_tokens, "
                  "completion_tokens, ms, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  (participant_id, pseudocode, status, json.dumps(response), raw, prompt_tokens,
                   completion_tokens, ms, time.time()))


_COST = "COALESCE(SUM(completion_tokens + prompt_tokens / 2.0), 0)"


def ai_spent(participant_id=None):
    """Budget units used so far (see ai.cost), by everyone or by one participant."""
    with connect() as c:
        if participant_id is None:
            return c.execute(f"SELECT {_COST} FROM ai_requests").fetchone()[0]
        return c.execute(f"SELECT {_COST} FROM ai_requests WHERE participant_id = ?",
                         (participant_id,)).fetchone()[0]


def ai_request_count(participant_id):
    """Counts requests that reached the model (not ones refused before sending)."""
    with connect() as c:
        return c.execute("SELECT COUNT(*) FROM ai_requests WHERE participant_id = ? AND status != 'unavailable'",
                         (participant_id,)).fetchone()[0]


def ai_usage():
    with connect() as c:
        total = c.execute("SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, "
                          "COALESCE(SUM(completion_tokens), 0) AS completion_tokens, "
                          f"COALESCE(AVG(ms), 0) AS avg_ms, {_COST} AS spent FROM ai_requests").fetchone()
        by_status = c.execute("SELECT status, COUNT(*) AS n FROM ai_requests GROUP BY status").fetchall()
    return {**dict(total), "by_status": {r["status"]: r["n"] for r in by_status}}


def ai_requests(limit=100, status=None):
    with connect() as c:
        q = ("SELECT a.*, p.roll FROM ai_requests a JOIN participants p ON p.id = a.participant_id"
             + (" WHERE a.status = ?" if status else "") + " ORDER BY a.id DESC LIMIT ?")
        return c.execute(q, ((status,) if status else ()) + (limit,)).fetchall()
