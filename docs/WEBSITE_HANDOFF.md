# Website handoff: participant site for MiniCodeWars 007

Read this first if you're building the website. The game engine, sandbox, backend API and
AI "clean code" feature are done and tested (`.venv/Scripts/python -m unittest discover tests`).
The website is the missing piece.

## The event

- WnCC IITB orientation, **~400 first-year students**, many of whom have barely written a for loop.
- Each participant writes a bot for **007** (rules below) in **pseudocode**. The **"Clean code with AI"**
  button turns it into Python. They get **20–30 minutes**, then submit.
- After submissions close, bots play a 1v1 tournament bracket (not built yet; not the website's job for now).
- Everything runs on **one Windows gaming laptop** on the event network: the FastAPI server
  serves both the API (`/api/...`) and the website (static files from `web/`).

## Hosting: where the website goes

- Put the site in **`web/`** at the repo root. The server mounts it at `/` (`index.html` for `/`) if the folder
  exists when the server starts, so restart the server after creating it.
  Same origin as the API, so there's no CORS and paths are relative (`fetch("/api/status")`).
- There's no build step in the backend. Either write plain HTML/CSS/JS, or build with a bundler and output into `web/`.
- **Keep third-party assets local** (download editors/fonts into `web/vendor/`). 400 laptops pulling from a CDN over
  event Wi-Fi is a risk; the only thing that needs the internet is the server's AI call.
- Run the server: `.venv/Scripts/python -m server` (port 8000; interactive API docs at `/docs`). The admin key
  is printed at startup. Settings are in `.env` (see `.env.example`); `.env` holds the AI key, so never commit it.
- **AI calls cost real tokens.** When testing the UI, don't loop `/api/clean`; a handful of real calls is fine.

## Participant flow

1. **Register** with roll number + name, which returns a token. Store it in `localStorage`, and send it on every
   request as `Authorization: Bearer <token>`. There's no password or login: if they lose the token (cleared browser,
   switched laptop), an organiser resets it via the admin API and gives them the new token. Registering the same
   roll number twice gives a 409. The site needs a way to **paste a token** to restore a session.
2. **Write pseudocode.** Start from `GET /api/starter` (`pseudocode` + `code`).
3. **Clean code with AI**: `POST /api/clean`. It either returns code, or **declines** and quotes the parts of their
   pseudocode it can't translate, each with a reason. Show those next to the pseudocode so they can fix and retry.
   There's no chat or back-and-forth: it's one button that either works or says why not.
4. **Edit the code by hand** if they want (a real code editor; Python highlighting is enough). The code is what counts,
   and the pseudocode is just stored alongside it.
5. **Test** against house bots: `POST /api/test` returns a full replay. Show it turn by turn (see "Replays").
6. **Submit**: `POST /api/submit` runs 3 check matches and stores the code. Their **entry** is the latest submission
   whose status isn't `rejected`. They can resubmit until the timer runs out.
7. A **countdown** and an organiser **announcement** banner are always visible (poll `GET /api/status`).

Design for beginners: plain language, big obvious buttons, errors that say what to do next. Never show a raw
traceback or JSON. Participants know the game rules from a briefing, but a short rules/API panel on the page helps a lot.

## Phases and the timer

`GET /api/status` →
```json
{"phase": "registration", "ends_at": null, "announcement": "", "server_time": 1790419193.94, "submit_grace_s": 15}
```
- Phases: `registration` → `coding` → `locked` → `tournament`, set by organisers.
  - `registration`: register, clean, test (no submitting)
  - `coding`: everything. `ends_at` (unix seconds) may be set; coding switches to `locked` by itself 15 s after it.
  - `locked`: test only
  - `tournament`: nothing except viewing
- **Countdown = `ends_at - server_time`**, measured once per poll and then ticked down locally. Don't use the laptop's own
  clock against `ends_at`, since participants' clocks can be off. `ends_at` can change (organisers can extend time),
  so poll every ~5–10 s.
- Show the phase clearly and disable buttons the phase doesn't allow (the server enforces it anyway with a 403).

## API reference

Errors are always JSON with a `detail` field:
- **4xx/5xx**: `{"detail": "message for a human"}`. Show it as-is; the messages are written for participants.
- **422** (bad input): `{"detail": [{"loc": ["body", "roll"], "msg": "...", ...}]}`. Map `loc[-1]` to the form field.

| Status | Meaning | What the site should do |
|---|---|---|
| 401 | no or unknown token | send them to register / paste token |
| 403 | not allowed in this phase (or time is up) | show message, refresh status |
| 404 | unknown opponent or submission | shouldn't happen from the UI |
| 409 | roll number already registered | "ask an organiser to recover your session" |
| 429 | too many requests: one running job of a kind per person, AI per-minute and total limits | show message (it says when to retry) |
| 503 | server busy / AI busy or unreachable | show message, let them retry |

### Public

`GET /api/status`: see above.

`GET /api/rules` → `{"config": {...config.toml as JSON...}, "moves": ["RELOAD","SHIELD","SHOOT","SNIPE","COUNTER"]}`.
Use this for numbers in a rules panel (HP, costs, etc.) instead of hardcoding them.

`GET /api/house-bots` → the opponents for testing. **Their code is secret; only names and descriptions are sent.**
```json
[{"name": "always_reload", "description": "Just keeps reloading. The easiest bot to beat."},
 {"name": "turtle", "description": "Hides behind the shield whenever the opponent could shoot."}, ...]
```
Opponent `"mirror"` (your bot vs itself) is also accepted by `/api/test`.

`GET /api/starter` → `{"code": "...random-move bot...", "pseudocode": "every turn:\n    pick a random move ..."}`

`POST /api/register` `{"roll": "25b0001", "name": "Asha"}` →
```json
{"token": "K2ojO9VcCHLX0ujkFvtVNNyVLEIwpjqh", "id": 1, "roll": "25B0001", "name": "Asha"}
```
The roll number is uppercased and must be letters and digits only (3–20 characters); the name is 1–60 characters.

### Participant (need `Authorization: Bearer <token>`)

`GET /api/me` →
```json
{"id": 2, "roll": "25B0002", "name": "Ravi",
 "entry": {"id": 1, "status": "ok", "created_at": 1790419194.2, "report": {...}, "code": "...", "pseudocode": "..."},
 "submissions": [{"id": 1, "status": "ok", "created_at": 1790419194.2}]}
```
`entry` is `null` until they have a non-rejected submission. Use `/api/me` on page load to restore their state.

`GET /api/submissions/{id}` → one of their own submissions: `{id, status, created_at, report, code, pseudocode}`.

`POST /api/clean` `{"pseudocode": "..."}` (max 4000 characters; takes **2–20 s**, so show a spinner and disable the button) → one of:
```json
{"status": "ok", "code": "def play(me, opp, turn, memory):\n    if me.ammo == 0:\n        return RELOAD\n    return SHOOT\n",
 "issues": [], "message": "", "remaining": 59}

{"status": "declined", "code": "", "message": "", "remaining": 58,
 "issues": [{"quote": "if front guy has no shield left",
             "reason": "Your bot can't see how many shields the opponent has left, and you didn't say how to work it out."}]}

{"status": "error", "code": "", "issues": [], "message": "the AI gave an answer we couldn't read; please try again", "remaining": 57}
```
- `ok`: put `code` in the editor. If they had edited the code by hand since the last clean, ask before overwriting.
- `declined`: show each issue. Highlight `quote` inside their pseudocode if you can (it's their exact words; it may be
  empty when the whole text isn't a bot description).
- `error`: show `message`; retrying is fine.
- `remaining`: cleanups left (60 per person by default; 4 per minute). Show it when it gets low.

`POST /api/check` `{"code": "..."}` → instant static check, no running. Good for underlining lines in the editor as they type (debounce it):
```json
{"problems": [{"line": 1, "message": "can't import 'os' (allowed: collections, functools, itertools, math, random)"}]}
```
`line` can be `null`. An empty list means the code is allowed (it can still crash when run).

`POST /api/test` `{"code": "...", "opponent": "turtle", "seed": 1}` → a replay (below). `seed` is optional
(random if omitted; send the same seed again to replay the same game). Takes well under a second normally.

`POST /api/submit` `{"code": "...", "pseudocode": "..."}` (only in the `coding` phase) →
```json
{"id": 1, "status": "ok", "accepted": true, "entry_id": 1, "checked_against": ["random_bot", "turtle", "smart"],
 "report": {
   "problems": [],
   "load_output": "",
   "matches": [
     {"opponent": "random_bot", "outcome": "win", "reason": "knockout", "turns": 9,
      "crashes": 0, "fumbles": 0, "first_error": null, "first_fumble": null}, ...]}}
```
- `status`:
  - `ok`: good.
  - `warning`: the code runs but crashed during some turns (see `first_error`, e.g. `"line 5: ZeroDivisionError: division by zero"`).
    It still counts as their entry.
  - `rejected`: it can't run at all (see `report.problems`: `[{line, message}]`). It does **not** replace their entry.
- `outcome` is from their point of view: `win` / `loss` / `draw`. `fumbles` counts invalid moves, like SHOOT with 0 ammo.
- After submitting, make it very clear which submission is their current entry (`entry_id`).

### Admin (need header `X-Admin-Key: <key>`)

The website chat may want to build a small organiser page for these:

| Endpoint | Body | Does |
|---|---|---|
| `POST /api/admin/phase` | `{"phase": "coding", "minutes": 30}` | set phase (minutes only for coding; starts the timer) |
| `POST /api/admin/extend` | `{"minutes": 5}` | add time (negative removes; reopens a timed-out coding phase) |
| `POST /api/admin/announce` | `{"message": "Lunch at 1"}` | banner text in `/api/status` (empty string clears it) |
| `GET /api/admin/participants` | | everyone: `id, roll, name, created_at, submissions, last_status, entry_id` |
| `POST /api/admin/reset-token` | `{"roll": "25B0001"}` | new token for a participant who lost theirs |
| `GET /api/admin/entries` | | every current entry with code |
| `GET /api/admin/ai-usage` | | `{requests, prompt_tokens, completion_tokens, avg_ms, by_status}` |
| `GET /api/admin/ai-requests?status=declined&limit=50` | | recent AI calls with pseudocode, response and raw model output |

## Replays (from `/api/test`; the tournament will produce the same format)

```json
{"version": 1, "seed": 1, "names": ["you", "turtle"], "config": {...},
 "turns": [
   {"turn": 3,
    "requested": ["SNIPE", "SHIELD"],        // what each bot returned
    "actions":   ["SNIPE", "SHIELD"],        // what actually happened ("FUMBLE" if the move was invalid)
    "fumbles":   [null, null],                // why a move became FUMBLE, e.g. "SHOOT needs 1 ammo, you have 0"
    "errors":    [null, null],                // crash message, e.g. "line 4: NameError: name 'amo' is not defined"
    "damage":    [0, 1],                      // damage taken this turn by player 0 / 1
    "events":    [{"type": "hit", "by": 0, "action": "SNIPE", "damage": 1}],
    "state":     [{"hp": 3, "ammo": 0, "shields": 3}, {"hp": 2, "ammo": 1, "shields": 1}],  // AFTER the turn
    "output":    ["", ""],                    // what each bot print()ed this turn (max 500 chars)
    "ms":        [0.12, 0.02]}],
 "result": {"winner": 0, "reason": "knockout",
            "final": [{"hp": 3, "ammo": 0, "shields": 3, "damage_dealt": 3}, {...}]}}
```
- Player 0 is always the participant (`names[0] == "you"`).
- `events[].type`:
  - `hit`: `by`'s attack damaged the other player.
  - `blocked`: `by`'s attack was stopped; `with` says by what (SHIELD / SNIPE / COUNTER).
  - `reflected`: `by`'s SHOOT was COUNTERed; `by` takes the damage.
- `result.winner`: 0, 1 or `null` (draw). `reason`: `knockout`, `double knockout, ...`, or `time up, more HP` /
  `more ammo` / `more damage dealt`.
- Starting state (before turn 1) isn't in `turns`; take it from `config.game` (`start_hp`, `start_ammo`, `shield_charges`).
- **Show `errors`, `fumbles` and `output` prominently.** That's how beginners debug: "turn 4: your code crashed at
  line 5" or "turn 2: SHOOT needs 1 ammo, you have 0". A turn-by-turn table with HP/ammo bars is enough for now; a
  fancy animated visualiser is a later task (it will use this same format).

## Game rules (for the rules panel; numbers come from `/api/rules`)

Both players start with 3 HP, 0 ammo, 3 shield charges. Each turn both secretly pick one move:

| Move | Cost | Effect |
|---|---|---|
| RELOAD | 0 | +1 ammo (max 3). You're vulnerable. |
| SHIELD | 0 | Blocks SHOOT. Uses 1 charge; any other move refills all 3. |
| SHOOT | 1 | 1 damage unless the opponent SHIELDs or COUNTERs. |
| SNIPE | 2 | 1 damage even through SHIELD. Stopped by SNIPE or COUNTER. |
| COUNTER | 1 | If the opponent SHOOTs, they take the damage instead. Also stops SNIPE. |

An invalid move (can't afford it, no shield charges, crash, typo) is a **FUMBLE**: nothing happens and you're vulnerable.
The game ends at 0 HP or after 25 turns (then more HP wins, then more ammo, then more damage dealt).

## Bot API (what participants' code looks like; good for a help panel)

```python
def play(me, opp, turn, memory):
    # me.hp  me.ammo  me.shields  me.history
    # opp.hp opp.ammo opp.history          (the opponent's shields are hidden)
    # turn:   1, 2, 3, ...
    # memory: a dict that's kept between turns of one match
    return RELOAD   # or SHIELD, SHOOT, SNIPE, COUNTER
```
- `history` is a list of past moves, oldest first, e.g. `opp.history[-1]` is their last move (check it's not empty first).
- The code can only import `random`, `math`, `collections`, `itertools` and `functools`.
- It can't use `open`, `eval`, `exec` or `getattr`, or any name starting with `_`. `print()` works and shows up in replays.
- Each move must take under 100 ms.

## Load numbers (measured on the laptop)

- A burst of 100 submits + 200 tests at the same moment finished in 18 s, with 5–7 s per request during the burst.
  Normally a test takes well under a second.
- The AI takes 2–20 s per call; 10 calls run at once and the rest queue (up to 2 minutes, then 503).
- Polling `/api/status` every 5 s from 400 laptops is ~80 requests/s, which is trivial. Don't poll anything else.

## Repo map

- `engine/`: game rules, match runner, sandbox (don't need to touch)
- `server/app.py`: every endpoint above; `server/ai.py`: the AI prompt; `server/settings.py`: settings
- `starter/`: the starter bot and pseudocode served by `/api/starter`
- `bots/`: house bots (secret from participants)
- `config.toml`: game numbers
- `web/`: **the website goes here**
