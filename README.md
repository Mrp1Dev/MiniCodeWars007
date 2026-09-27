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
python -m engine --round-robin bots/extra      # every bot in a folder vs every other
python -m engine mybot.py smart --sandbox      # run bots the way the server does
```

## Booting on event day (Windows)

Needs Python 3.11+ and Node.js 20+. One-time setup (needs internet: Python packages, the site's npm packages and Pyodide):

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env          # then put the AI key in .env
cd site
npm install
npm run build                   # builds the website into ..\web (rerun after changing anything in site\)
cd ..
```

Every time:

```powershell
.venv\Scripts\python -m server  # website + API on port 8000; prints the admin key
```

- Participants open `http://<laptop's IP>:8000` (find the IP with `ipconfig`, under the Wi-Fi adapter). The first time
  Windows asks, allow Python through the firewall on private networks.
- Check it works from another device before people arrive, and have participants open the site during the briefing:
  the in-browser tester (about 4 MB compressed, cached after the first visit) downloads in the background.
- Tests: `.venv\Scripts\python -m unittest discover tests`

Settings live in `.env` (copy `.env.example`); real environment variables override it. The admin key is printed at startup. If `MCW_ADMIN_KEY` is empty, a key is generated into `data/admin_key.txt`.

The target platform is Windows; the Linux parts of the sandbox exist but are untested.

## Website

The participant site is a React app in `site/` (Vite). `npm run build` writes it to `web/`, which the server serves at `/`
(same origin as the API, so no CORS). The laptop only needs Node to build; the server itself doesn't use it.
`web/` is build output and isn't committed.

- **Sign in** is roll number + name. A known roll number signs straight back in (another laptop, cleared browser),
  so there are no tokens for participants to keep.
- **One code editor**, starting from a `play()` template with the rules in comments. Participants write Python, or
  plain English and press *Clean with AI*. Every clean is kept in the **History** panel (what they wrote, and the AI's
  code), and any version opens back in the editor. Cleaning and opening a version are single undo steps, so Ctrl+Z /
  Ctrl+Y move between them. If the AI declines, the phrases it couldn't translate are highlighted in the editor.
  Drafts and history autosave in the browser.
- **Syntax check** underlines Python errors as you type. It's off by default, since plain English would be all red.
- **Run match** (or Ctrl+Enter) plays a practice match in the browser with [Pyodide](https://pyodide.org) (the real `engine/` files, served by
  `/api/engine-bundle`), so dry runs don't load the laptop or the Wi-Fi. Until Pyodide has loaded, or if it fails,
  tests go to `/api/test`. A bot that gets stuck is killed after 8 s and that game is replayed on the server,
  which shows the slow turn. Local and server replays are identical for the same seed.
- **Submit**, the phase and countdown, and the announcement banner work as described in
  [docs/WEBSITE_HANDOFF.md](docs/WEBSITE_HANDOFF.md).
- Pyodide is copied from npm into `web/pyodide/<version>/`, nothing loads from a CDN. The build writes gzipped copies
  of large files, which the server sends to browsers that accept gzip (Pyodide goes from 12 MB to 4 MB), and hashed or
  versioned files are cached for a year.
- Developing: run the server, then `npm run dev` in `site/` (http://localhost:5173, forwards `/api` to port 8000).

### Big Screen duel sprites

The two agents in the Big Screen duel are PNGs in `site/public/sprites/`, described by `sprites.json` there. Each agent
has three poses, and the move decides which one is shown:

| Pose | Used for |
|---|---|
| `pistol` | SHOOT and RELOAD (reloads always use the pistol) |
| `rifle` | SNIPE |
| `shield` | SHIELD and COUNTER (pistol held low behind the barrier) |

The `idle` entry says which pose is shown otherwise. Each pose is two images of the same size, drawn facing right
(agent 2 is mirrored automatically):

- `agentN-<pose>-body.png`: everything except the weapon.
- `agentN-<pose>-weapon.png`: the weapon plus the arm/hands holding it. It turns around the shoulder to animate recoil,
  the reload, hurt and victory.

For each pose `sprites.json` gives four points in those images' pixels: `feet` (on the ground between the feet; every
pose lines up on it), `pivot` (the shoulder the weapon turns around), `muzzle` (barrel tip: flashes and bullets start
here) and `grip` (where the reload magazine goes). To change an agent, edit or replace its PNGs in any pixel-art editor
(Aseprite, Piskel, even Paint), keep the same size or update the points, then rebuild (`npm run build`) or just reload
the page when using `npm run dev`. If the files are missing the duel falls back to built-in drawn agents.

COUNTER uses the shield pose too: the shield goes up, the agent swings the pistol up and shoots their own shield, which
jerks forward and turns red. An enemy pistol shot reaching the red shield flies back red into the shooter; a sniper shot
just stops. For the `shield` pose, `pivot` is the hand holding the pistol and `muzzle` its tip pointing down.

## API

| Endpoint | Who | What |
|---|---|---|
| `GET /api/status` | anyone | phase, `ends_at`, `server_time`, announcement |
| `GET /api/rules` | anyone | game config |
| `GET /api/house-bots` | anyone | test opponents: name, description and code |
| `GET /api/engine-bundle` | anyone | engine source and game config, for test matches in the browser |
| `GET /api/starter` | anyone | starter `code` and example `pseudocode` for the editor |
| `POST /api/register` `{roll, name}` | anyone | sign in: registers a new roll number or signs in as an existing one; returns a `token` (send it as `Authorization: Bearer ...`) |
| `GET /api/me` | participant | profile, current entry, submission list |
| `POST /api/check` `{code}` | participant | static check only (fast) |
| `POST /api/test` `{code, opponent, seed?}` | participant | one sandboxed match vs a house bot or `"mirror"`, returns the replay |
| `POST /api/clean` `{pseudocode}` | participant | AI translation: `ok` + `code`, or `declined` + `issues`, or `error` |
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

`server/ai.py` translates pseudocode into bot code, or declines and says which parts it can't translate. It declines goals ("play the best move") and anything that needs information the bot can't see without the participant saying how to work it out ("if the opponent has no shields left"). It never adds strategy or a fallback move the participant didn't write. Participants can also press it on Python they wrote themselves: it then only fixes obvious slips (a rule indented under another rule's `return`, `=` for `==`, `"shoot"` for `SHOOT`, misspelt names) and keeps working code as it is. Code that fails the submission safety check is declined too; there's no retry. The model thinks before answering, and the thinking counts towards `MCW_AI_MAX_TOKENS` (6000; the most seen in testing was ~1600).

Spending is capped in "output-equivalent" tokens (output + input/2):
- a typical call is about 1,300;
- `MCW_AI_TOKEN_BUDGET` (70M) caps the whole event;
- `MCW_AI_TOKENS_PER_PARTICIPANT` (100k) caps each person.

Before calling the model, each request reserves its worst case (a full-length answer plus its input), so neither cap can be overshot even with 10 calls in flight. Client retries are off, because a retried timeout gets paid twice. Pseudocode is limited to 2000 characters.

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
- `bots/`: house bots, the test opponents. Participants can read them (the browser runs them), so keep them simple.
  Submissions are checked against all of them.
- `bots/extra/`: stronger bots for us (the CLI finds them by name, e.g. `python -m engine smart turtle`)
- `site/`: the website's source (React + Vite); `web/`: its build output
