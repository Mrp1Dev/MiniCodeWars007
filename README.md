# MiniCodeWars: 007

Bot-vs-bot game engine for the WnCC IITB orientation code-wars event.

## Rules

Both players start with 3 HP, 0 ammo and 3 shield charges. Every turn, each player secretly picks one move:

| Move | Cost | Effect |
|---|---|---|
| `RELOAD` | 0 | +1 ammo (max 3). You're vulnerable. |
| `SHIELD` | 0 | Blocks SHOOT. Uses 1 charge; any other move refills all 3. |
| `SHOOT` | 1 | 1 damage unless the opponent SHIELDs or COUNTERs. |
| `SNIPE` | 2 | 1 damage, even through SHIELD. Stopped by another SNIPE or a COUNTER. |
| `COUNTER` | 1 | If the opponent SHOOTs, they take the damage instead. |

An invalid move (not enough ammo, no shield charges left, a typo, a crash) becomes a **FUMBLE**: you do nothing, you're vulnerable, and your shields don't refill.

The game ends at 0 HP, or after 25 turns. Tiebreaks, in order: HP → ammo → damage dealt → draw.

All numbers are in [config.toml](config.toml).

## Bot API

```python
def play(me, opp, turn, memory):
    # me.hp  me.ammo  me.shields  me.history
    # opp.hp opp.ammo opp.history          (the opponent's shield charges are hidden)
    # turn:   1, 2, 3, ...
    # memory: a dict kept between turns of the same match
    return RELOAD   # or SHIELD, SHOOT, SNIPE, COUNTER
```

`history` lists what actually happened, with the oldest move first (`FUMBLE` included). `random` and `print()` work, and the randomness is seeded per match, so every match can be replayed exactly.

Submitted code may only import `random`, `math`, `collections`, `itertools` and `functools`. It can't use `open`, `eval`, `exec`, `getattr` and similar, or any name starting with `_` (except `__init__` and `__name__`).

## Running

```bash
python -m engine smart turtle                  # one match, turn by turn
python -m engine smart turtle --show-output    # include the bots' print() output
python -m engine smart turtle --games 500      # win counts over many seeds
python -m engine smart turtle --replay r.json  # save the replay
python -m engine --round-robin bots            # every bot vs every other
python -m engine mybot.py smart --sandbox      # run bots the way the server does
```

## Server

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python -m server                 # port 8000, API docs at /docs
.venv/Scripts/python -m unittest discover tests
```

Settings live in `.env` (copy `.env.example`); real environment variables override it. The admin key is printed at startup. If `MCW_ADMIN_KEY` is empty, a key is generated into `data/admin_key.txt`.

On WSL: run the server as a normal user, not root, because root ignores the process limit on bot processes. Keep the project on the Linux filesystem (e.g. `~/MiniCodeWars`), not under `/mnt/c` or `/mnt/f`; starting processes from there is much slower.

| Endpoint | Who | What |
|---|---|---|
| `GET /api/status` | anyone | phase, `ends_at`, `server_time`, announcement |
| `GET /api/rules` | anyone | game config |
| `GET /api/house-bots` | anyone | test opponents (names and descriptions; code stays secret) |
| `GET /api/starter` | anyone | starter `code` and example `pseudocode` for the editor |
| `POST /api/register` `{roll, name}` | anyone | returns a `token` (send it as `Authorization: Bearer ...`) |
| `GET /api/me` | participant | profile, current entry, submission list |
| `POST /api/check` `{code}` | participant | static check only (fast) |
| `POST /api/test` `{code, opponent, seed?}` | participant | one sandboxed match vs a house bot or `"mirror"`, returns the replay |
| `POST /api/clean` `{pseudocode}` | participant | AI translation: `ok` + `code` + `notes`, or `clarify` + `issues`, or `not_pseudocode` / `error` |
| `POST /api/submit` `{code, pseudocode?}` | participant | validate (3 matches vs house bots) and store; only during `coding` |
| `GET /api/submissions/{id}` | participant | one of your own submissions |
| `POST /api/admin/phase` `{phase, minutes?}` | admin | `registration` / `coding` (+ timer) / `locked` / `tournament` |
| `POST /api/admin/extend` `{minutes}` | admin | add time (also reopens a timed-out coding phase) |
| `POST /api/admin/announce` `{message}` | admin | banner text shown in the status |
| `GET /api/admin/participants` | admin | everyone with submission counts |
| `POST /api/admin/reset-token` `{roll}` | admin | new token for someone who lost their session |
| `GET /api/admin/entries` | admin | every tournament entry with its code |
| `GET /api/admin/ai-usage` | admin | AI requests and tokens so far |
| `GET /api/admin/ai-requests?status=&limit=` | admin | recent AI requests with the raw model output |

A participant's entry is their latest submission that wasn't `rejected`. A `warning` status means the code loads but crashed during the check matches. Coding closes by itself 15 s after `ends_at`.

## Clean code with AI

`server/ai.py` translates pseudocode into bot code. It never writes strategy for the participant. It asks for clarification when a step is a goal ("play the best move"), or when it needs something the bot can't see and the participant didn't say how to work it out ("if the opponent has no shields left"). It also never adds a fallback move the participant didn't write. The returned code has to pass the same safety check as submissions, with one automatic repair attempt if it doesn't.

Limits: `MCW_AI_CONCURRENCY` (calls at once, queued beyond that), `MCW_AI_PER_MINUTE` and `MCW_AI_MAX_PER_PARTICIPANT`. Every request is logged with the raw model output (`/api/admin/ai-requests`).

```bash
.venv/Scripts/python -m server.ai --examples      # run sample pseudocode against the real model
.venv/Scripts/python -m server.ai my_pseudo.txt
```

## Sandbox

Each participant bot runs in its own process (`engine/sandbox.py`), with several layers of protection:
1. A static check of the source (import allowlist, no dunders or `_` attributes, no frame internals).
2. Restricted builtins at run time, including an import hook.
3. OS limits. On Windows, a Job Object limits memory (256 MB), forbids starting other processes, and kills the bot if the server dies. On Linux, rlimits cap memory and forbid new processes and file writes.
4. Each move has a deadline (100 ms). A bot that misses it is killed and restarted, up to 3 times per match, and after that it fumbles for the rest of the match.

## Layout

- `engine/config.py`: loads and validates `config.toml`
- `engine/rules.py`: pure turn resolution
- `engine/botapi.py`: loads and calls participant code. It has no engine imports, so it can run on its own in a sandbox or in Pyodide.
- `engine/match.py`: runs a match and produces a JSON replay
- `engine/cli.py`: command-line runner
- `engine/sandbox.py`, `engine/sandbox_worker.py`: running bots in separate processes
- `server/`: FastAPI app (`app.py`), SQLite (`db.py`), running matches (`matches.py`), AI translator (`ai.py`), settings (`settings.py`)
- `starter/`: what participants start with
- `bots/`: house bots
