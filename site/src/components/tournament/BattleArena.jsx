import React, { useEffect } from "react";
import { useDeterministicPlayback } from "./useDeterministicPlayback";
import PixelArena from "./PixelArena";

const EMPTY = [];

export default function BattleArena({
  match,
  status,
  revealNames = false,
  myParticipantId = null,
  isMirroring = false,
  mirrorTag = null,
  onMatchComplete = null, // called with the match id once its playback has reached the end
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

  const matchId = match?.match_id ?? null;
  useEffect(() => {
    if (playback.isMatchComplete && matchId != null) onMatchComplete?.(matchId);
  }, [playback.isMatchComplete, matchId, onMatchComplete]);

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

  const tiebreakReason = match.draw_reason?.startsWith("tiebreak_")
    ? match.draw_reason.replace("tiebreak_", "").replace(/_/g, " ")
    : null;

  // One plain line describing the current turn (or the result once the match is over).
  const events = currentTurn?.events || [];
  const nameOf = (side) => (side === 0 ? match.p1_name : match.p2_name);
  const move = (m) => String(m).toLowerCase();
  let eventText = "";
  if (isMatchComplete) {
    eventText = winnerName
      ? `${winnerName} wins ${Math.max(p1Score, p2Score)}–${Math.min(p1Score, p2Score)}${tiebreakReason ? `, on tiebreak (${tiebreakReason})` : ""}`
      : "Match over";
  } else if (currentTurn) {
    let detail;
    const hits = events.filter((e) => e.type === "hit");
    const ev = events[0];
    if (hits.length > 1) {
      detail = "Both hit, −1 HP each";
    } else if (ev?.type === "hit") {
      detail = `${nameOf(ev.by)}'s ${move(ev.action)} hits, −${ev.damage} HP`;
    } else if (ev?.type === "blocked") {
      detail = `${nameOf(ev.by)}'s ${move(ev.action)} is blocked by ${move(ev.with)}`;
    } else if (ev?.type === "reflected") {
      detail = `${nameOf(ev.by)}'s ${move(ev.action)} is countered back`;
    } else if (p1Move === p2Move) {
      detail = `Both ${move(p1Move)}`;
    } else {
      detail = `${match.p1_name} ${move(p1Move)}s, ${match.p2_name} ${move(p2Move)}s`;
    }
    eventText = `Turn ${currentTurn.turn} · ${detail}`;
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

      {/* Pixel-art duel, driven by the same playback clock */}
      <PixelArena
        playback={playback}
        names={[match.p1_name, match.is_bye ? "" : match.p2_name]}
        winnerSide={match.winner_id == null ? null : match.winner_id === match.p1_id ? 0 : 1}
        matchId={match.match_id}
        isBye={Boolean(match.is_bye)}
      />

      {/* Stats and move badges */}
      <div className="arena-stage compact">
        {/* Player 1 Panel */}
        <div className={`combatant-panel p1 ${isP1Me ? "is-user-bot" : ""} ${isMatchComplete ? (p1Won ? "combatant-winner" : "combatant-loser") : ""}`}>
          <div className="combatant-header-line">
            <span className="combatant-side-tag">AGENT 001</span>
            {isMatchComplete && (
              <span className={`status-badge-pill ${p1Won ? "pill-winner" : "pill-loser"}`}>
                {p1Won ? "Won" : "Lost"}
              </span>
            )}
          </div>

          <div className="combatant-identity">
            {revealNames && match.p1_real_name && (
              <span className="combatant-real-name">{match.p1_real_name}</span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="combatant-bot-name">{match.p1_name}</span>
              {p1Hp <= 0 && <span className="ko-tag">KO</span>}
              {isP1Me && <span className="you-pill">YOU</span>}
            </div>
          </div>

          <div className="meter-row">
            <div className="meter-label">
              <span>HP</span>
              <span className={p1Hp <= 0 ? "hp-danger" : ""}>
                {Math.max(0, p1Hp)} / {startHp}
              </span>
            </div>
            <div className="hp-bar-segments">
              {Array.from({ length: startHp }).map((_, i) => (
                <div key={i} className={`hp-segment ${i < p1Hp ? "active" : ""}`} />
              ))}
            </div>
          </div>

          {!isMatchComplete && (
          <div className="meters-grid">
            <div className="meter-row">
              <span className="meter-label">Ammo</span>
              <div className="ammo-meter">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`bullet-pip ${i < p1Ammo ? "active" : ""}`} />
                ))}
              </div>
            </div>

            <div className="meter-row">
              <span className="meter-label">Shields</span>
              <div className="shield-meter">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`shield-pip ${i < p1Shields ? "active" : ""}`} />
                ))}
              </div>
            </div>
          </div>
          )}
        </div>

        {/* Center Clash HUD */}
        <div className="clash-center">
          {isMatchComplete ? (
            <div className="clash-final">
              <span className="final-label">Final</span>
              <div className="final-score">
                <span className={p1Won ? "lead" : ""}>{p1Score}</span>
                <span className="final-dash">–</span>
                <span className={p2Won ? "lead" : ""}>{p2Score}</span>
              </div>
              {tiebreakReason && <span className="final-note">Won on tiebreak: {tiebreakReason}</span>}
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
                    <span className="clash-dmg-mutual">Both −1 HP</span>
                  ) : p1Damage > 0 ? (
                    <span className="clash-dmg-p1">{match.p1_name} −{p1Damage} HP</span>
                  ) : (
                    <span className="clash-dmg-p2">{match.p2_name} −{p2Damage} HP</span>
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
                {p2Won ? "Won" : "Lost"}
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
              {p2Hp <= 0 && <span className="ko-tag">KO</span>}
              <span className="combatant-bot-name">{match.p2_name}</span>
            </div>
          </div>

          <div className="meter-row">
            <div className="meter-label">
              <span className={p2Hp <= 0 ? "hp-danger" : ""}>
                {Math.max(0, p2Hp)} / {startHp}
              </span>
              <span>HP</span>
            </div>
            <div className="hp-bar-segments">
              {Array.from({ length: startHp }).map((_, i) => (
                <div key={i} className={`hp-segment ${i < p2Hp ? "active" : ""}`} />
              ))}
            </div>
          </div>

          {!isMatchComplete && (
          <div className="meters-grid">
            <div className="meter-row">
              <span className="meter-label">Shields</span>
              <div className="shield-meter">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`shield-pip ${i < p2Shields ? "active" : ""}`} />
                ))}
              </div>
            </div>

            <div className="meter-row">
              <span className="meter-label">Ammo</span>
              <div className="ammo-meter">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`bullet-pip ${i < p2Ammo ? "active" : ""}`} />
                ))}
              </div>
            </div>
          </div>
          )}
        </div>
      </div>

      {/* Commentary Footer */}
      <div className="arena-commentary">
        <span className={isMatchComplete ? "commentary-final" : ""}>{eventText}</span>
      </div>
    </div>
  );
}
