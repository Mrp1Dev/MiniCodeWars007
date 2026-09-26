# MiniCodeWars 007: Tournament Specification

This document outlines the requirements and architecture for the **MiniCodeWars 007 Tournament System**. It is designed to give the implementer clear constraints and high-level goals while leaving architectural and design freedom to build the best solution.

---

## 1. High-Level Vision & Context

* **Event**: Live WnCC IIT Bombay orientation event with **200 to 500 first-year students** in a hall with laptops open.
* **Infrastructure**: One host machine (Windows laptop) serving the FastAPI backend and React frontend, driving the main auditorium projector (Big Screen).
* **Target Runtime**: Total tournament playthrough should take **~20 minutes**, keeping hype high and avoiding audience fatigue.
* **Visual Aesthetic**: Retain the sleek, dark, gold/amber-accented 007 aesthetic already established across the site. (Pixel art animations are coming later; for now, prioritize clean, rhythmic, readable turn-by-turn visualization).

---

## 2. Tournament Format

The tournament runs in two distinct acts: **Swiss Stage** into **Single Elimination**.

### Act 1: The Swiss Stage (All Participants)
* **Structure**: **6 Swiss rounds**. Everyone plays every round—nobody is eliminated early.
* **Match Format**: Every 1v1 matchup is **Best of 5 (Bo5)** (first to 3 wins). Matches produce a strict Win or Loss (no match-level draws).
* **Execution**: **Parallel**. All matchups in a round run simultaneously so each round takes roughly 40–50 seconds of match time.
* **Pairing & Edge Cases**:
  * Participants are paired within their score bracket (e.g. 2-0 vs 2-0), strictly avoiding rematches from earlier rounds.
  * In later rounds (4–6), pairing logic must use backtracking fallback if greedy pairing hits a dead end.
* **Odd Participant Count (Byes)**:
  * If the participant count is odd, one participant receives a **Bye** (automatic 3-0 win).
  * No participant receives more than one Bye during Swiss.
  * During their Bye round, the student's screen **automatically mirrors the Big Screen** for that round's duration so they remain engaged.
* **Draw Handling within Matches**:
  * If a single game ends in an engine draw (`winner = None` with identical HP, ammo, and damage), no win is awarded; the match continues to the next game.
  * **Infinite Mirror Cap**: To prevent infinite loops between deterministic identical bots, Bo5 is capped at a maximum of **6 games** (Bo7 capped at **8 games**).
  * If the game cap is reached without a 3-win victor, the tie is broken deterministically by gameplay stats:
    1. Most game wins in that match
    2. Total cumulative damage dealt across that match
    3. Total cumulative remaining HP
    4. Fewest fumbles in that match
    5. Highest offensive move ratio (`SHOOT` + `SNIPE` vs `SHIELD` + `RELOAD`)
    6. Deterministic Seed Hash (Absolute final fallback)
* **The Cut (Top 32)**:
  * After 6 rounds, the field cuts to the **Top 32**.
  * Standings ties (especially critical for the 4-2 cutoff bubble) are resolved through a strictly **merit-based tiebreaker chain** with an absolute deterministic fallback:
    1. **Match Record** (e.g., `5-1` > `4-2`)
    2. **Buchholz Score** (Sum of opponents' match wins — strength of schedule)
    3. **Sonneborn-Berger Score** (Sum of defeated opponents' match wins — prestige wins)
    4. **Head-to-Head** (if tied bots played each other)
    5. **Game Differential** (Total Game Wins minus Total Game Losses)
    6. **Total Damage Dealt** (across all 6 rounds — rewards aggressive play)
    7. **Net Damage Differential** (Total Damage Dealt minus Total Damage Taken)
    8. **Fewest Fumbles** (Fewest total fumbles across all rounds — rewards bots that tracked ammo and shield charges cleanly)
    9. **Fastest Knockout Speed** (Fewest turns taken in winning games)
    10. **Deterministic Seed Hash** (SHA-256 hash of bot/participant ID + tournament seed as an absolute final fallback)

### Act 2: Single Elimination (Top 32 to Champion)
* **Round of 32 & Round of 16**:
  * **Parallel execution**, Best of 5.
  * Fast-paced, trimming the contenders down to the final 8.
* **Round of 8 (Quarter-Finals)**:
  * **Sequential execution** (1 match at a time on the main screen). Best of 5.
* **Round of 4 (Semi-Finals) & Grand Finale**:
  * **Sequential execution**, upgraded to **Best of 7** (first to 4 wins).
  * **Grand Finale Feature**: The host must have the ability to step through games **turn-by-turn** to build maximum stadium suspense.

---

## 3. Screen Experiences & Privacy

### 3.1 Privacy Rules (Strict)
* **Roll numbers**: **NEVER displayed publicly** anywhere on the Big Screen or shared brackets.
* **Early Stages (Swiss, Ro32, Ro16)**: Display **Bot Names only** (e.g. `Agent-42`, `ShadowSniper`). Keep human identities anonymous to avoid early-round embarrassment.
* **Elite 8 Onwards (Ro8, Ro4, Finals)**: Unveil the human behind the bot! Display **Real Name + Bot Name**.

---

### 3.2 The Big Screen (Auditorium Projector)

The Big Screen serves as the centerpiece of the live show:

1. **During Swiss (Rounds 1–6)**:
   * **Left Side (The 3-Tier Board)**: Displays the **current 32 best-performing bots** grouped into 3 visual tiers (e.g., Tier 1, Tier 2, Tier 3). Bots move dynamically between tiers as rounds resolve. Show **Bot Names only**—do NOT display raw win/loss numbers or rankings.
   * **Center Stage (The Highlight Match)**: Features a marquee match between top performers in that round. **Crucial**: Present it as an exciting live clash, but do not leak that they are the highest-ranked bots.
2. **During Elimination Ro32 & Ro16**:
   * The Big Screen shows the **Tournament Bracket** with Bot Names and live match scores (e.g., `2 - 1`).
   * Center area features a secretly selected highlight match from that round.
3. **During Sequential Finals (Ro8, Ro4, Finals)**:
   * The full tournament bracket remains visible on the left, with the **active match prominently highlighted**.
   * Center stage features the live 1v1 battle with both Bot Names and Real Names displayed.

---

### 3.3 Participant Laptop ("Follow Your Bot")

Every student follows the tournament on their own device:

1. **Follow Your Bot**:
   * While their bot is still competing, the student sees their bot's current matchup playing out at regular, readable turn intervals.
2. **Bye Mirroring**:
   * If a student receives a Bye in an odd-player round, their screen indicates the Bye advance and **automatically mirrors the Big Screen** for that round's duration so they remain engaged.
3. **Auto-Mirroring on Elimination**:
   * As soon as a student's bot is eliminated, their screen **automatically mirrors the Big Screen**. They are never left on a dead screen and seamlessly become spectators.
4. **Sequential Finals Mirroring**:
   * In Ro8, Ro4, and Finals, since matches are sequential, **all participant laptops mirror the Big Screen match** in real time.
5. **Persistent Bracket**:
   * Participants should be able to view the tournament bracket at any time (e.g. in a side panel or drawer) to see overall tournament standing.

---

## 4. Synchronization & Wi-Fi Resilience

In an auditorium with 400 laptops on event Wi-Fi, high-frequency WebSockets will drop connections and crash the experience.

### The Deterministic Playback Principle
* When the host starts a round, the backend pre-computes the match replays in a few seconds and sets a `started_at` timestamp.
* **Clients render turns based on time elapsed since `started_at`** (with a fixed turn interval, e.g. ~700–800ms per turn + short pause between games).
* **Clock Drift Prevention**: The backend includes `server_time` in status responses. Clients compute `clock_offset = server_time - (Date.now() / 1000)` and synchronize against `started_at`. This prevents desync if a student's laptop system clock is ahead or behind.
* **Midway Reload Resilience**: If a student refreshes their browser 30 seconds into the round, the client calculates where the match should currently be based on elapsed time and **immediately resumes midway** matching everyone else. They never lag behind or restart from Turn 1.

---

## 5. Host Admin Controls (`/#admin`) & Leeway

The tournament host / MC runs the entire event from the admin panel and must have full control:

* **Stage Advancers**:
  * Dedicated controls to trigger each of the 6 Swiss rounds.
  * Trigger for cutting to Top 32 and generating the elimination bracket.
  * Controls to launch Ro32 and Ro16.
  * Controls to launch each individual sequential match in Ro8, Ro4, and Finals.
* **Finale Controls**:
  * Ability to pause, play, or advance **turn-by-turn** during the Grand Finale.
* **Leeway & Error Recovery**:
  * **Accidental Skip / Mistake Recovery**: If the host accidentally advances a round or triggers the wrong match, provide a safe **Undo / Rollback** or state-reset capability so a human slip does not corrupt the tournament.
  * **Pause Button**: A global freeze switch to pause playback across all screens if an organizer needs to make an announcement.

---

## 6. Implementation Notes & Suggestions

* **Engine & Replays**: The existing `engine.match.run_match` produces JSON replays with turns, actions, damage, and HP meters. Use this replay format as the source of truth for all playback.
* **Turn Visualization**: Without pixel art yet, create a bold, clean HUD: show bot names, animated HP bars, Ammo/Shield meters, and central badges for moves (`SHOOT`, `SHIELD`, `SNIPE`, `COUNTER`, `RELOAD`, `FUMBLE`).
* **Database & APIs**: Store tournament state, rounds, and match replay sets in SQLite. Design clean REST endpoints for status, participant matches, bracket trees, and admin actions.
* **Simplicity First**: Implementers have full freedom on exact component breakdown, CSS styling, and internal data structures, provided the user experience, pacing, and synchronization guarantees are met.
