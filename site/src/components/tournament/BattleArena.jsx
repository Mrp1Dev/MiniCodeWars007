import React, { useEffect } from "react";
import { useDeterministicPlayback } from "./useDeterministicPlayback";
import PixelArena from "./PixelArena";
import { describeTiebreak } from "./tiebreak";

const EMPTY = [];

const STAGE_LABELS = {
  ro32: "Round of 32",
  ro16: "Round of 16",
  finals: "Grand final",
};

function stageLabel(stage) {
  if (stage.startsWith("swiss_")) return `Swiss round ${stage.slice(6)}`;
  if (stage.startsWith("ro8_")) return "Quarter-final";
  if (stage.startsWith("ro4_")) return "Semi-final";
  return STAGE_LABELS[stage] || "";
}

/** How a finished game was decided, from the engine's result.reason. */
function gameOutcome(game) {
  const reason = game?.result?.reason || "";
  const turns = game?.turns?.length || 0;
  if (reason === "knockout") return `Knockout on turn ${turns}`;
  if (reason.startsWith("double knockout")) {
    return game?.result?.winner == null ? "Double knockout" : `Double knockout · won on ${reason.split(", ")[1]?.replace("more ", "") || "tiebreak"}`;
  }
  if (reason.startsWith("time up")) {
    if (game?.result?.winner == null) return `Draw after ${turns} turns`;
    return `Out of turns · won on ${reason.split(", ")[1]?.replace("more ", "") || "points"}`;
  }
  return "";
}

function Pips({ n, max, kind }) {
  return (
    <span className={`hud-pips ${kind}`}>
      {Array.from({ length: max }).map((_, i) => (
        <i key={i} className={i < n ? "on" : ""} />
      ))}
    </span>
  );
}

function Fighter({ side, name, realName, hp, startHp, ammo, shields, isMe, result, took }) {
  return (
    <div className={`hud-fighter ${side} ${isMe ? "is-me" : ""} ${result ? `is-${result}` : ""}`}>
      <div className="hud-card">
        <div className="hud-id">
          {realName && <span className="hud-real">{realName}</span>}
          <span className="hud-name">
            <span className="hud-bot" title={name}>{name}</span>
            {isMe && <span className="you-pill">YOU</span>}
          </span>
        </div>

        <div className="hud-hp">
          <div className="hud-hp-bar">
            {Array.from({ length: startHp }).map((_, i) => (
              <i key={i} className={i < hp ? "on" : i < hp + took ? "lost-now" : ""} />
            ))}
          </div>
          <span className={`hud-hp-num ${hp <= 0 ? "is-out" : ""}`}>
            {Math.max(0, hp)}<small> / {startHp} HP</small>
          </span>
        </div>

        <div className="hud-res">
          <span className="hud-res-item"><span className="hud-res-label">Ammo</span><Pips n={ammo} max={3} kind="ammo" /></span>
          <span className="hud-res-item"><span className="hud-res-label">Shield</span><Pips n={shields} max={3} kind="shield" /></span>
          {result === "lost" && <span className="hud-lost">Defeated</span>}
        </div>
      </div>
    </div>
  );
}

export default function BattleArena({
  match,
  status,
  revealNames = false,
  myParticipantId = null,
  isMirroring = false,
  mirrorTag = null,
<<<<<<< Updated upstream
  onMatchComplete = null, // called with the match id once its playback has reached the end
=======
  sound = false,
>>>>>>> Stashed changes
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
    turnMs: turnMs || 1400,
    gamePauseMs: gamePauseMs || 2500,
    startHp,
  });

  const matchId = match?.match_id ?? null;
  useEffect(() => {
    if (playback.isMatchComplete && matchId != null) onMatchComplete?.(matchId);
  }, [playback.isMatchComplete, matchId, onMatchComplete]);

  if (!match) {
    return (
      <section className="arena-card arena-empty">
        <span className="bs-eyebrow">Featured duel</span>
        <p>The next duel is being prepared.</p>
      </section>
    );
  }

  const {
    gameIndex,
    turnIndex,
    isIntermission,
    isMatchComplete,
    currentGame,
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

  const isSwiss = stage.startsWith("swiss_");
  const multiGame = (match.games?.length || 0) > 1;
  const inPlay = Boolean(currentTurn) && !isIntermission && !isMatchComplete;
  const p1Move = currentTurn?.actions?.[0] || "RELOAD";
  const p2Move = currentTurn?.actions?.[1] || "RELOAD";
  const p1Damage = inPlay ? currentTurn?.damage?.[0] || 0 : 0;
  const p2Damage = inPlay ? currentTurn?.damage?.[1] || 0 : 0;
  const turnKey = `${match.match_id}-${gameIndex}-${turnIndex}`;

  const p1Won = isMatchComplete && match.winner_id != null && match.winner_id === match.p1_id;
  const p2Won = isMatchComplete && match.winner_id != null && match.winner_id === match.p2_id;
  const winnerName = p1Won ? match.p1_name : p2Won ? match.p2_name : null;
  const loserName = p1Won ? match.p2_name : p2Won ? match.p1_name : null;
  const tiebreak = describeTiebreak(match.draw_reason, { isSwiss });
  const lastGame = match.games?.[match.games.length - 1];
  const howWon = tiebreak
    ? `Draw · won on tiebreak (${tiebreak.tag.toLowerCase()})`
    : multiGame
      ? `${Math.max(p1Score, p2Score)}–${Math.min(p1Score, p2Score)} in games`
      : gameOutcome(lastGame);

  const isP1Me = myParticipantId != null && Number(match.p1_id) === Number(myParticipantId);
  const isP2Me = myParticipantId != null && Number(match.p2_id) === Number(myParticipantId);
  const nameOf = (side) => (side === 0 ? match.p1_name : match.p2_name);

<<<<<<< Updated upstream
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
=======
  // One short line under the scene: what just happened, or how it was decided.
  let ticker = null;
  if (match.is_bye) {
    ticker = <>{match.p1_name} advances with a bye.</>;
  } else if (isMatchComplete && winnerName) {
    ticker = tiebreak
      ? <>Drawn duel. <strong>{winnerName}</strong> advances: it {tiebreak.text}.</>
      : <><strong>{winnerName}</strong> defeats {loserName}.</>;
  } else if (isIntermission) {
    const w = currentGame?.result?.winner;
    ticker = w === 0 || w === 1 ? <><strong>{nameOf(w)}</strong> takes the game.</> : <>Draw.</>;
  } else if (currentTurn) {
    const events = currentTurn.events || [];
    const hits = events.filter((e) => e.type === "hit");
    const ev = events[0];
    if (hits.length > 1) ticker = <>Both hit. −1 HP each.</>;
    else if (ev?.type === "hit") ticker = <><strong>{nameOf(ev.by)}</strong> hits with {ev.action}. −{ev.damage} HP</>;
    else if (ev?.type === "blocked") ticker = <>{nameOf(ev.by)}'s {ev.action} is blocked.</>;
    else if (ev?.type === "reflected") ticker = <><strong>{nameOf(1 - ev.by)}</strong> counters the {ev.action}.</>;
    else if (p1Move === "FUMBLE" || p2Move === "FUMBLE") ticker = <>Fumble: an invalid move, nothing happens.</>;
>>>>>>> Stashed changes
  }

  const headTag = isMirroring
    ? mirrorTag || "Big screen broadcast"
    : isP1Me || isP2Me
      ? "Your duel"
      : "Featured duel";

  return (
    <section className={`arena-card ${isMatchComplete ? "is-complete" : ""}`}>
      <div className="arena-hud">
        {!match.is_bye && (
          <Fighter
            side="p1"
            name={match.p1_name}
            realName={revealNames ? match.p1_real_name : ""}
            hp={p1Hp}
            startHp={startHp}
            ammo={p1Ammo}
            shields={p1Shields}
            isMe={isP1Me}
            took={p1Damage}
            result={isMatchComplete ? (p1Won ? "won" : p2Won ? "lost" : "") : ""}
          />
        )}

        <div className="hud-center">
          <div className="hud-context">
            {isMirroring && <span className="live-dot" />}
            <span className={`arena-tag ${isP1Me || isP2Me ? "is-you" : ""} ${isMirroring ? "is-mirror" : ""}`}>{headTag}</span>
            <span className="arena-meta">{[stageLabel(stage), `${startHp} HP`].filter(Boolean).join(" · ")}</span>
          </div>
          {!match.is_bye && (isMatchComplete && winnerName ? (
            <div className="hud-verdict" key="verdict">
              <span className="hud-verdict-label">Winner</span>
              <span className="hud-verdict-name">{winnerName}</span>
              <span className="hud-verdict-how">{howWon}</span>
            </div>
          ) : (
            <>
              <div className="hud-turn">
                {isIntermission ? "Game over" : currentTurn ? `Turn ${currentTurn.turn}` : "Get ready"}
                {multiGame && <span className="hud-series">{p1Score} – {p2Score}</span>}
              </div>
              <div className="hud-clash" key={turnKey}>
                <span className="clash-card">{p1Move}</span>
                <span className="clash-vs">vs</span>
                <span className="clash-card">{p2Move}</span>
              </div>
            </>
          ))}
        </div>

        {!match.is_bye && (
          <Fighter
            side="p2"
            name={match.p2_name}
            realName={revealNames ? match.p2_real_name : ""}
            hp={p2Hp}
            startHp={startHp}
            ammo={p2Ammo}
            shields={p2Shields}
            isMe={isP2Me}
            took={p2Damage}
            result={isMatchComplete ? (p2Won ? "won" : p1Won ? "lost" : "") : ""}
          />
        )}
      </div>

      <PixelArena
        playback={playback}
        names={[match.p1_name, match.is_bye ? "" : match.p2_name]}
        winnerSide={match.winner_id == null ? null : match.winner_id === match.p1_id ? 0 : 1}
        matchId={match.match_id}
        isBye={Boolean(match.is_bye)}
        turnMs={turnMs || 1400}
        sound={sound}
      />

<<<<<<< Updated upstream
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
=======
      <footer className={`arena-ticker ${isMatchComplete ? "is-final" : ""}`}>
        <span key={`${turnKey}-${isIntermission}-${isMatchComplete}`}>{ticker}</span>
      </footer>
    </section>
>>>>>>> Stashed changes
  );
}
