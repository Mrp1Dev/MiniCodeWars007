import React, { useEffect, useRef, useState } from "react";
import { describeTiebreak } from "./tiebreak";

const STAGE_ORDER = [
  "ro32",
  "ro16",
  "ro8_m1",
  "ro8_m2",
  "ro8_m3",
  "ro8_m4",
  "ro4_m1",
  "ro4_m2",
  "finals",
  "champion",
];

const ROUNDS = [
  { key: "ro32", title: "Round of 32", count: 16 },
  { key: "ro16", title: "Round of 16", count: 8 },
  { key: "ro8", title: "Quarter-finals", count: 4 },
  { key: "ro4", title: "Semi-finals", count: 2 },
  { key: "finals", title: "Final", count: 1 },
];

function stageIdxOf(roundKey, matchIdx) {
  if (roundKey === "ro32") return 0;
  if (roundKey === "ro16") return 1;
  if (roundKey === "ro8") return 2 + matchIdx;
  if (roundKey === "ro4") return 6 + matchIdx;
  if (roundKey === "finals") return 8;
  return -1;
}

function isActiveNode(roundKey, matchIdx, activeStage) {
  if (roundKey === "ro32" || roundKey === "ro16" || roundKey === "finals") return activeStage === roundKey;
  return activeStage === `${roundKey}_m${matchIdx + 1}`;
}

export default function TournamentBracket({
  bracket = {},
  activeStage = "",
  revealNames = false,
  status = {},
  className = "",
  collapsed = false,
  onToggle = null, // when given, the bracket can fold into a slim rail to give the duel the room
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const {
    started_at: startedAt = null,
    server_time: serverTime = null,
    accumulated_pause: accumulatedPause = 0,
    base_accumulated_pause: baseAccumulatedPause = 0,
    paused_at: pausedAt = null,
    paused = false,
    turn_step: turnStep = -1,
  } = status || {};

  // Measured once per poll: recomputing it on every tick would freeze the clock between polls.
  const clockOffsetRef = useRef(serverTime ? serverTime - Date.now() / 1000 : 0);
  useEffect(() => {
    if (serverTime) clockOffsetRef.current = serverTime - Date.now() / 1000;
  }, [serverTime]);

  let elapsedMs = 0;
  if (startedAt) {
    const playedSec = paused && pausedAt
      ? pausedAt - startedAt - baseAccumulatedPause // frozen exactly where the pause began
      : now / 1000 + clockOffsetRef.current - startedAt - accumulatedPause;
    elapsedMs = Math.max(0, playedSec * 1000);
  }

  const b = bracket || {};
  const matchesOf = {
    ro32: Array.isArray(b) ? b.slice(0, 16) : (b.ro32 || []),
    ro16: b.ro16 || [],
    ro8: b.ro8 || [],
    ro4: b.ro4 || [],
    finals: b.finals || [],
  };

  const currentStageIdx = STAGE_ORDER.indexOf(activeStage);

  /** What the audience may see of a match right now: never a result before it has played out. */
  const matchView = (m, roundKey, matchIdx) => {
    const roundStageIdx = stageIdxOf(roundKey, matchIdx);
    const isPast = currentStageIdx > roundStageIdx || activeStage === "champion";
    const isCurrent = currentStageIdx === roundStageIdx;
    const parallel = roundKey === "ro32" || roundKey === "ro16";
    const view = { scores: ["", ""], done: false, live: false, winner: null };

    if (isPast) {
      view.done = Boolean(m?.is_complete || m?.winner_id);
      view.scores = [m?.score?.[0] ?? "", m?.score?.[1] ?? ""];
    } else if (isCurrent && turnStep >= 0 && !parallel) {
      // The host is stepping this match turn by turn; the arena shows it, the bracket waits.
      view.live = true;
    } else if (isCurrent) {
      if (m?.timeline?.length) {
        const played = m.timeline.filter((t) => t.finish_ms <= elapsedMs);
        view.scores = played.length ? played[played.length - 1].score : [0, 0];
        view.done = elapsedMs >= m.finish_ms;
        view.live = !view.done;
      } else if (m?.is_complete) {
        view.scores = m.score || [0, 0];
        view.done = true;
      } else {
        view.live = Boolean(m?.p1 || m?.p2);
      }
    }
    if (view.done) {
      view.winner = m?.winner_id === m?.p1?.participant_id ? 0 : m?.winner_id === m?.p2?.participant_id ? 1 : null;
    }
    return view;
  };

  const renderSlot = (participant, side, view, placeholder, tb) => {
    const won = view.winner === side;
    const lost = view.winner === 1 - side;
    return (
      <div className={`bk-slot ${won ? "is-win" : ""} ${lost ? "is-lose" : ""} ${participant ? "" : "is-empty"}`}>
        <span className="bk-seed">{participant?.seed ?? ""}</span>
        <span className="bk-name">
          <span className="bk-bot" title={participant?.bot_name}>{participant ? participant.bot_name : placeholder}</span>
          {revealNames && participant?.name && <span className="bk-real">{participant.name}</span>}
        </span>
        {/* A drawn duel has no winning score to show; the winner gets a tiebreak mark instead. */}
        <span className="bk-score">{tb ? (won ? <span className="bk-tb">TB</span> : "") : view.scores[side]}</span>
      </div>
    );
  };

  const renderMatch = (m, round, matchIdx) => {
    const view = matchView(m, round.key, matchIdx);
    const active = isActiveNode(round.key, matchIdx, activeStage) && round.count <= 4;
    const tb = view.done && view.scores[0] === view.scores[1] ? describeTiebreak(m?.draw_reason) : null;
    const hasEntrants = Boolean(m?.p1 || m?.p2);
    // Later rounds stay blank until their entrants are known; the connectors show where they come from.
    const placeholder = (i) => (round.key === "ro32" ? `Seed ${i === 0 ? m?.seed1 ?? "" : m?.seed2 ?? ""}` : "");
    const byeLabel = m?.is_bye && view.done ? "Bye" : placeholder(1);

    return (
      <div
        key={`${round.key}-${matchIdx}`}
        className={`bk-cell ${view.done ? "is-done" : ""} ${hasEntrants ? "has-entrants" : ""}`}
      >
        <div
          className={`bk-match ${active ? "is-active" : ""} ${view.live ? "is-live" : ""} ${view.done ? "is-done" : ""}`}
          title={tb ? `Drawn duel, won on tiebreak: ${tb.text}` : undefined}
        >
          {renderSlot(m?.p1, 0, view, placeholder(0), tb)}
          {renderSlot(m?.p2, 1, view, byeLabel, tb)}
          {/* The later rounds have room to say which tiebreak decided it */}
          {tb && round.count <= 4 && <span className="bk-caption">Tiebreak · {tb.tag}</span>}
        </div>
      </div>
    );
  };

  const anyTiebreak = ROUNDS.some((r) =>
    matchesOf[r.key].some((m, i) => {
      const v = matchView(m, r.key, i);
      return v.done && v.scores[0] === v.scores[1] && m?.draw_reason;
    })
  );

  const currentRound = ROUNDS.find((r) => {
    const first = stageIdxOf(r.key, 0);
    return currentStageIdx >= first && currentStageIdx <= stageIdxOf(r.key, r.count - 1);
  });

  if (collapsed) {
    const decided = currentRound
      ? matchesOf[currentRound.key].filter((m, i) => matchView(m, currentRound.key, i).done).length
      : 0;
    return (
      <section className={`bracket is-collapsed ${className}`}>
        <button className="bk-toggle" onClick={onToggle} title="Show the bracket (B)">
          <span aria-hidden="true">›</span>
        </button>
        <div className="bk-rail">
          <span className="bk-rail-title">Bracket</span>
          {currentRound && (
            <>
              <span className="bk-rail-round">{currentRound.title}</span>
              {currentRound.count > 1 && (
                <span className="bk-rail-count"><b>{decided}</b>/{currentRound.count} decided</span>
              )}
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={`bracket ${revealNames ? "reveal-names" : ""} ${className}`}>
      {onToggle && (
        <button className="bk-toggle" onClick={onToggle} title="Fold the bracket away (B)">
          <span aria-hidden="true">‹</span>
        </button>
      )}
      <div className="bk-heads">
        {ROUNDS.map((r) => {
          const idx = stageIdxOf(r.key, 0);
          const lastIdx = stageIdxOf(r.key, r.count - 1);
          const now = currentStageIdx >= idx && currentStageIdx <= lastIdx;
          const done = currentStageIdx > lastIdx;
          return (
            <div key={r.key} className={`bk-head ${now ? "is-now" : ""} ${done ? "is-done" : ""}`}>
              {now && <span className="bk-head-dot" />}
              {r.title}
            </div>
          );
        })}
      </div>

      <div className="bk-body">
        {ROUNDS.map((r) => (
          <div key={r.key} className={`bk-col bk-col-${r.key}`}>
            {Array.from({ length: r.count }).map((_, i) => renderMatch(matchesOf[r.key][i], r, i))}
          </div>
        ))}
      </div>

      <footer className="bk-foot">
        {anyTiebreak ? (
          <span>
            <span className="bk-tb">TB</span> Drawn duel, decided by tiebreak: more damage in the duel → more HP left → fewer fumbles → Swiss-stage merit
          </span>
        ) : (
          <span>Single-game knockout · the winner advances</span>
        )}
      </footer>
    </section>
  );
}
