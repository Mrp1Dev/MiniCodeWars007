import React, { useEffect, useRef, useState } from "react";

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

export default function TournamentBracket({
  bracket = {},
  activeStage = "",
  revealNames = false,
  status = {},
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

  const ro32 = Array.isArray(bracket) ? bracket.slice(0, 16) : (bracket.ro32 || []);
  const ro16 = bracket.ro16 || [];
  const ro8 = bracket.ro8 || [];
  const ro4 = bracket.ro4 || [];
  const finals = bracket.finals || [];

  const currentStageIdx = STAGE_ORDER.indexOf(activeStage);

  const getStageIdx = (roundStage, matchIdx) => {
    if (roundStage === "ro32") return 0;
    if (roundStage === "ro16") return 1;
    if (roundStage === "ro8") return 2 + matchIdx;
    if (roundStage === "ro4") return 6 + matchIdx;
    if (roundStage === "finals") return 8;
    return -1;
  };

  const formatTiebreak = (reason) => {
    if (!reason) return { tag: "TB", desc: "Advanced via Elimination Tiebreak" };
    if (reason.includes("elim_damage") || reason.includes("damage")) return { tag: "TB:DMG", desc: "Tiebreak: Highest Total In-Match Damage Dealt" };
    if (reason.includes("elim_hp") || reason.includes("hp")) return { tag: "TB:HP", desc: "Tiebreak: Highest Total Remaining HP" };
    if (reason.includes("elim_fumbles") || reason.includes("fumble")) return { tag: "TB:FUM", desc: "Tiebreak: Fewest Fumbles" };
    if (reason.includes("swiss_seed")) return { tag: "TB:SEED", desc: "Tiebreak: Higher Swiss Final Seeding" };
    if (reason.includes("match_wins")) return { tag: "TB:WINS", desc: "Tiebreak: Swiss Stage Match Record" };
    if (reason.includes("buchholz")) return { tag: "TB:BUCH", desc: "Tiebreak: Buchholz Strength of Schedule" };
    if (reason.includes("sonneborn")) return { tag: "TB:SONN", desc: "Tiebreak: Sonneborn-Berger Score" };
    if (reason.includes("net_games")) return { tag: "TB:DIFF", desc: "Tiebreak: Net Game Differential" };
    if (reason.includes("game_wins")) return { tag: "TB:GWINS", desc: "Tiebreak: Total Game Wins" };
    if (reason.includes("h2h")) return { tag: "TB:H2H", desc: "Tiebreak: Head-to-Head Victor" };
    if (reason.includes("ko_turns")) return { tag: "TB:SPD", desc: "Tiebreak: Fastest Knockout Speed" };
    return { tag: "TB", desc: "Tiebreak: Deterministic Seed Hash" };
  };

  const renderSlot = (participant, score, isWinner, isLoser, defaultLabel, tbBadge, tbTitle) => {
    let name = defaultLabel;
    if (participant) {
      if (revealNames && participant.name) {
        name = `${participant.bot_name} (${participant.name})`;
      } else {
        name = participant.bot_name;
      }
    }

    const scoreDisplay = score !== undefined && score !== null ? score : "-";

    return (
      <div className={`bracket-slot ${isWinner ? "winner" : (isLoser ? "loser" : "")}`}>
        <span className="bracket-slot-name" title={name}>
          {participant?.seed ? <span className="bracket-seed">#{participant.seed} </span> : null}
          {name}
        </span>
        <span className="bracket-slot-score" title={tbTitle || undefined}>
          {scoreDisplay}
          {isWinner && tbBadge ? (
            <span className="bracket-tb-badge" title={tbTitle}>
              {tbBadge}
            </span>
          ) : null}
        </span>
      </div>
    );
  };

  const renderMatchNode = (m, roundStage, matchIdx, defaultP1, defaultP2) => {
    const p1 = m?.p1;
    const p2 = m?.p2;

    const roundStageIdx = getStageIdx(roundStage, matchIdx);
    const isPastRound = currentStageIdx > roundStageIdx;
    const isCurrentRound = currentStageIdx === roundStageIdx;
    const isFutureRound = currentStageIdx < roundStageIdx;

    let p1Score = "-";
    let p2Score = "-";
    let isCompleted = false;
    let p1Won = false;
    let p2Won = false;

    if (isPastRound || activeStage === "champion") {
      // Completed in an earlier stage or tournament finished
      isCompleted = Boolean(m?.is_complete || m?.winner_id);
      p1Score = m?.score?.[0] ?? "-";
      p2Score = m?.score?.[1] ?? "-";
      p1Won = isCompleted && m?.winner_id === p1?.participant_id;
      p2Won = isCompleted && m?.winner_id === p2?.participant_id;
    } else if (isCurrentRound && turnStep >= 0 && roundStage !== "ro32" && roundStage !== "ro16") {
      // The host is stepping this match turn by turn; the arena shows the score, the bracket waits.
      p1Score = "·";
      p2Score = "·";
    } else if (isCurrentRound) {
      // Actively playing! Calculate live progressive score from timeline without spoilers
      if (m?.timeline && m.timeline.length > 0) {
        const completedGames = m.timeline.filter((t) => t.finish_ms <= elapsedMs);
        if (completedGames.length === 0) {
          p1Score = 0;
          p2Score = 0;
          isCompleted = false;
        } else {
          const latest = completedGames[completedGames.length - 1];
          p1Score = latest.score[0];
          p2Score = latest.score[1];
          if (elapsedMs >= m.finish_ms) {
            isCompleted = true;
            p1Won = m.winner_id === p1?.participant_id;
            p2Won = m.winner_id === p2?.participant_id;
          }
        }
      } else if (m?.is_complete) {
        p1Score = m.score?.[0] ?? 0;
        p2Score = m.score?.[1] ?? 0;
        isCompleted = true;
        p1Won = m.winner_id === p1?.participant_id;
        p2Won = m.winner_id === p2?.participant_id;
      } else {
        p1Score = 0;
        p2Score = 0;
      }
    } else {
      // Future match
      p1Score = "-";
      p2Score = "-";
      isCompleted = false;
    }

    // Determine active match highlighting
    let isActive = false;
    if (roundStage === "ro32" && activeStage === "ro32") isActive = true;
    else if (roundStage === "ro16" && activeStage === "ro16") isActive = true;
    else if (roundStage === "ro8" && activeStage === `ro8_m${matchIdx + 1}`) isActive = true;
    else if (roundStage === "ro4" && activeStage === `ro4_m${matchIdx + 1}`) isActive = true;
    else if (roundStage === "finals" && activeStage === "finals") isActive = true;

    // Detect if match regulation ended tied and winner was determined via tiebreaker
    let tbInfo = null;
    if (isCompleted && p1Score === p2Score && m?.draw_reason) {
      tbInfo = formatTiebreak(m?.draw_reason);
    }

    return (
      <div
        key={`${roundStage}-${matchIdx}`}
        className={`bracket-match-node ${isActive ? "active-match" : ""} ${isCompleted ? "completed-match" : ""}`}
      >
        {renderSlot(
          p1,
          p1Score,
          p1Won,
          p2Won,
          defaultP1,
          p1Won && tbInfo ? tbInfo.tag : null,
          p1Won && tbInfo ? tbInfo.desc : null
        )}
        {renderSlot(
          p2,
          p2Score,
          p2Won,
          p1Won,
          m?.is_bye && isCompleted ? "BYE" : defaultP2,
          p2Won && tbInfo ? tbInfo.tag : null,
          p2Won && tbInfo ? tbInfo.desc : null
        )}
      </div>
    );
  };

  return (
    <div className="bracket-container">
      {/* Round of 32 */}
      <div className="bracket-round">
        <div className="bracket-round-title">ROUND OF 32</div>
        {ro32.map((m, idx) =>
          renderMatchNode(
            m,
            "ro32",
            idx,
            `Seed ${m.seed1 || idx * 2 + 1}`,
            `Seed ${m.seed2 || idx * 2 + 2}`
          )
        )}
      </div>

      {/* Round of 16 */}
      <div className="bracket-round">
        <div className="bracket-round-title">ROUND OF 16</div>
        {Array.from({ length: 8 }).map((_, idx) => {
          const m = ro16[idx];
          return renderMatchNode(
            m,
            "ro16",
            idx,
            `Winner M${idx * 2 + 1}`,
            `Winner M${idx * 2 + 2}`
          );
        })}
      </div>

      {/* Quarter-Finals (Elite 8) */}
      <div className="bracket-round">
        <div className="bracket-round-title gold-title">QUARTER-FINALS</div>
        {Array.from({ length: 4 }).map((_, idx) => {
          const m = ro8[idx];
          return renderMatchNode(
            m,
            "ro8",
            idx,
            `Winner R16-${idx * 2 + 1}`,
            `Winner R16-${idx * 2 + 2}`
          );
        })}
      </div>

      {/* Semi-Finals (Final 4) */}
      <div className="bracket-round">
        <div className="bracket-round-title gold-title">SEMI-FINALS</div>
        {Array.from({ length: 2 }).map((_, idx) => {
          const m = ro4[idx];
          return renderMatchNode(
            m,
            "ro4",
            idx,
            `Winner QF-${idx * 2 + 1}`,
            `Winner QF-${idx * 2 + 2}`
          );
        })}
      </div>

      {/* Grand Finale */}
      <div className="bracket-round">
        <div className="bracket-round-title finale-title">GRAND FINALE</div>
        {renderMatchNode(
          finals[0],
          "finals",
          0,
          "Winner SF-1",
          "Winner SF-2"
        )}
      </div>
    </div>
  );
}
