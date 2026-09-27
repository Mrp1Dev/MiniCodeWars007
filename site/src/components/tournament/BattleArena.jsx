import React from "react";
import { useDeterministicPlayback } from "./useDeterministicPlayback";

const EMPTY = [];

export default function BattleArena({
  match,
  status,
  revealNames = false,
  myParticipantId = null,
  isMirroring = false,
  mirrorTag = null,
}) {
  const {
    started_at: startedAt,
    server_time: serverTime,
    paused,
    accumulated_pause: accumulatedPause,
    turn_step: turnStep,
    turn_ms: turnMs,
    game_pause_ms: gamePauseMs,
  } = status || {};

  const stage = match?.stage || status?.stage || "";
  const startHp = match?.start_hp ||
    match?.games?.[0]?.start_hp ||
    match?.games?.[0]?.config?.game?.start_hp ||
    status?.start_hp ||
    (stage === "finals" ? 8 : (stage.startsWith("ro4") ? 7 : 5));

  // Hooks must run on every render, so the playback clock starts before the "no match" early return.
  const playback = useDeterministicPlayback({
    startedAt,
    serverTime,
    paused,
    accumulatedPause,
    turnStep: turnStep ?? -1,
    games: match?.games || EMPTY,
    matchId: match?.match_id ?? null,
    turnMs: turnMs || 750,
    gamePauseMs: gamePauseMs || 2500,
    startHp,
  });

  if (!match) {
    return (
      <div className="arena-card center muted" style={{ padding: "60px 20px" }}>
        <p>No active highlight duel selected for this round.</p>
      </div>
    );
  }

  const {
    gameIndex,
    turnIndex,
    isIntermission,
    isMatchComplete,
    currentTurn,
    p1Score,
    p2Score,
    p1Hp,
    p2Hp,
    p1Ammo,
    p2Ammo,
    p1Shields,
    p2Shields,
  } = playback;

  const totalGames = match.games ? match.games.length : 1;
  const maxPossibleGames = match.stage?.startsWith("ro4") || match.stage === "finals" ? 7 : 5;
  const winsRequired = maxPossibleGames === 7 ? 4 : 3;

  // Moves for the active turn
  const p1Move = currentTurn?.actions?.[0] || "RELOAD";
  const p2Move = currentTurn?.actions?.[1] || "RELOAD";
  const p1Damage = currentTurn?.damage?.[0] || 0;
  const p2Damage = currentTurn?.damage?.[1] || 0;

  // Outcome resolution
  const p1Won = match.winner_id ? match.winner_id === match.p1_id : (p1Score > p2Score && isMatchComplete);
  const p2Won = match.winner_id ? match.winner_id === match.p2_id : (p2Score > p1Score && isMatchComplete);
  const winnerName = p1Won ? match.p1_name : (p2Won ? match.p2_name : null);

  const isP1Me = myParticipantId != null && match && Number(match.p1_id) === Number(myParticipantId);
  const isP2Me = myParticipantId != null && match && Number(match.p2_id) === Number(myParticipantId);

  // Action event description
  const events = currentTurn?.events || [];
  let eventText = "";
  if (isMatchComplete) {
    if (winnerName) {
      const reasonText = match.draw_reason?.startsWith("tiebreak_")
        ? ` (Tiebreak: ${match.draw_reason.replace("tiebreak_", "").replace(/_/g, " ")})`
        : "";
      eventText = `🏆 Match complete! ${winnerName} claims victory${reasonText}.`;
    }
  } else if (events.length > 0) {
    const hits = events.filter((e) => e.type === "hit");
    if (hits.length > 1) {
      eventText = `💥 Mutual strike! Both agents trade blows for damage!`;
    } else {
      const ev = events[0];
      if (ev.type === "hit") {
        eventText = `${ev.by === 0 ? match.p1_name : match.p2_name}'s ${ev.action} connected for -${ev.damage} HP!`;
      } else if (ev.type === "blocked") {
        eventText = `${ev.by === 0 ? match.p1_name : match.p2_name}'s ${ev.action} was blocked by ${ev.with}!`;
      } else if (ev.type === "reflected") {
        eventText = `${ev.by === 0 ? match.p1_name : match.p2_name}'s ${ev.action} was COUNTERED and reflected back!`;
      }
    }
  } else if (currentTurn?.turn === 1) {
    eventText = "Match started! Agents engage in tactical combat.";
  } else if (p1Move === "RELOAD" && p2Move === "RELOAD") {
    eventText = "Both agents reload ammo and brace.";
  }

  return (
    <div className="arena-card">
      {/* Top Banner */}
      <div className="arena-top">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {isMirroring && (
            <span className="mirror-indicator-banner">
              <span className="live-dot" /> {mirrorTag || "MIRRORING CENTER SCREEN"}
            </span>
          )}
          <span className="arena-badge">
            {match.is_bye
              ? "AUTOMATIC ADVANCE (BYE)"
              : stage === "finals"
              ? `GRAND FINALE · 1V1 DUEL (${startHp} HP BOSS FIGHT)`
              : stage.startsWith("ro4")
              ? `SEMI-FINALS · 1V1 DUEL (${startHp} HP ENDURANCE)`
              : `1V1 MATCH (${startHp} HP)`}
          </span>
          {isMirroring ? (
            <span className="marquee-tag marquee-mirror">
              CENTER SCREEN BROADCAST
            </span>
          ) : (isP1Me || isP2Me) ? (
            <span className="marquee-tag marquee-you">
              ★ YOUR LIVE DUEL
            </span>
          ) : (
            <span className="marquee-tag" title="Excitement rating calculated from turns, damage & lead changes">
              ★ FEATURED MARQUEE DUEL
            </span>
          )}
        </div>

        {!match.is_bye && (
          <div className="series-tracker">
            <span style={{ fontSize: "11px", letterSpacing: "0.15em", color: "var(--t-muted)" }}>
              {isMatchComplete ? "DECISION:" : "MATCH STATUS:"}
            </span>
            <span style={{ fontWeight: 800, color: isMatchComplete ? "var(--t-gold-bright)" : "#fff", fontSize: "14px", fontFamily: "var(--mono)" }}>
              {isMatchComplete ? (p1Won ? `${match.p1_name} WINS` : (p2Won ? `${match.p2_name} WINS` : "DRAW")) : (currentTurn ? `TURN ${currentTurn.turn}` : "INITIALIZING")}
            </span>
          </div>
        )}
      </div>

      {/* Main Duel Stage */}
      <div className="arena-stage">
        {/* Player 1 Panel */}
        <div className={`combatant-panel p1 ${isP1Me ? "is-user-bot" : ""} ${isMatchComplete ? (p1Won ? "combatant-winner" : "combatant-loser") : ""}`}>
          <div className="combatant-header-line">
            <span className="combatant-side-tag">AGENT 001</span>
            {isMatchComplete && (
              <span className={`status-badge-pill ${p1Won ? "pill-winner" : "pill-loser"}`}>
                {p1Won ? "👑 WINNER" : "DEFEATED"}
              </span>
            )}
          </div>

          <div className="combatant-identity">
            {revealNames && match.p1_real_name && (
              <span className="combatant-real-name">{match.p1_real_name}</span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="combatant-bot-name">{match.p1_name}</span>
              {isP1Me && <span className="you-pill">YOU</span>}
            </div>
          </div>

          <div className="meter-row">
            <div className="meter-label">
              <span>Armor Integrity</span>
              <span className={p1Hp <= 0 ? "hp-danger" : ""}>
                {Math.max(0, p1Hp)} / {startHp} HP {p1Hp <= 0 ? "(KNOCKED OUT)" : ""}
              </span>
            </div>
            <div className="hp-bar-segments">
              {Array.from({ length: startHp }).map((_, i) => (
                <div key={i} className={`hp-segment ${i < p1Hp ? "active" : ""}`} />
              ))}
            </div>
          </div>

          <div className="meters-grid">
            <div className="meter-row">
              <span className="meter-label">Ammo ({p1Ammo}/3)</span>
              <div className="ammo-meter">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`bullet-pip ${i < p1Ammo ? "active" : ""}`} />
                ))}
              </div>
            </div>

            <div className="meter-row">
              <span className="meter-label">Shields ({p1Shields}/3)</span>
              <div className="shield-meter">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`shield-pip ${i < p1Shields ? "active" : ""}`} />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Center Clash HUD */}
        <div className="clash-center">
          {isMatchComplete ? (
            <div className="clash-outcome-card">
              <div className="outcome-icon">
                🏆
              </div>
              <div className="outcome-title">
                SERIES VICTORY
              </div>
              <div className="outcome-winner-name">
                {winnerName} WINS!
              </div>
              <div className="outcome-rule-explanation">
                {match.draw_reason?.startsWith("tiebreak_") ? (
                  <>
                    Regulation games tied ({p1Score} - {p2Score}).<br />
                    Victorious via <strong>Tournament Merit Tiebreak: {match.draw_reason.replace("tiebreak_", "").replace(/_/g, " ")}</strong>.
                  </>
                ) : (
                  <>
                    Advances with <strong>{Math.max(p1Score, p2Score)} wins</strong> in the series.
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="clash-turn-badge">
                {isIntermission ? `GAME ${gameIndex + 1} COMPLETE` : `TURN ${currentTurn?.turn || 1}`}
              </div>

              <div className="clash-duel">
                <div key={`p1-move-${gameIndex}-${turnIndex}`} className={`clash-move-card move-${p1Move}`}>
                  {p1Move}
                </div>
                <div className="clash-vs-symbol">VS</div>
                <div key={`p2-move-${gameIndex}-${turnIndex}`} className={`clash-move-card move-${p2Move}`}>
                  {p2Move}
                </div>
              </div>

              {(p1Damage > 0 || p2Damage > 0) && (
                <div className="clash-damage-flyout">
                  {p1Damage > 0 && p2Damage > 0 ? (
                    <span className="clash-dmg-mutual">💥 MUTUAL CLASH: Both took 1 DMG</span>
                  ) : p1Damage > 0 ? (
                    <span className="clash-dmg-p1">💥 {match.p1_name} took −{p1Damage} DMG</span>
                  ) : (
                    <span className="clash-dmg-p2">💥 {match.p2_name} took −{p2Damage} DMG</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Player 2 Panel */}
        <div className={`combatant-panel p2 ${isP2Me ? "is-user-bot" : ""} ${isMatchComplete ? (p2Won ? "combatant-winner" : "combatant-loser") : ""}`}>
          <div className="combatant-header-line">
            {isMatchComplete && (
              <span className={`status-badge-pill ${p2Won ? "pill-winner" : "pill-loser"}`}>
                {p2Won ? "👑 WINNER" : "DEFEATED"}
              </span>
            )}
            <span className="combatant-side-tag">AGENT 002</span>
          </div>

          <div className="combatant-identity">
            {revealNames && match.p2_real_name && (
              <span className="combatant-real-name">{match.p2_real_name}</span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
              {isP2Me && <span className="you-pill">YOU</span>}
              <span className="combatant-bot-name">{match.p2_name}</span>
            </div>
          </div>

          <div className="meter-row">
            <div className="meter-label">
              <span className={p2Hp <= 0 ? "hp-danger" : ""}>
                {p2Hp <= 0 ? "(KNOCKED OUT) " : ""}{Math.max(0, p2Hp)} / {startHp} HP
              </span>
              <span>Armor Integrity</span>
            </div>
            <div className="hp-bar-segments">
              {Array.from({ length: startHp }).map((_, i) => (
                <div key={i} className={`hp-segment ${i < p2Hp ? "active" : ""}`} />
              ))}
            </div>
          </div>

          <div className="meters-grid">
            <div className="meter-row">
              <span className="meter-label">Shields ({p2Shields}/3)</span>
              <div className="shield-meter">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`shield-pip ${i < p2Shields ? "active" : ""}`} />
                ))}
              </div>
            </div>

            <div className="meter-row">
              <span className="meter-label">Ammo ({p2Ammo}/3)</span>
              <div className="ammo-meter">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`bullet-pip ${i < p2Ammo ? "active" : ""}`} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Commentary Footer */}
      <div className="arena-commentary">
        <span style={{ fontWeight: 500, color: isMatchComplete ? "var(--t-gold-bright)" : undefined }}>
          {eventText || "Tactical clash in progress..."}
        </span>
        {currentTurn && (
          <span style={{ fontSize: "11px", color: "var(--t-faint)" }}>
            Turn resolved in {currentTurn.ms?.[0] || 0}ms / {currentTurn.ms?.[1] || 0}ms
          </span>
        )}
      </div>
    </div>
  );
}
