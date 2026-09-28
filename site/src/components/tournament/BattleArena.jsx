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
            {hp <= 0 && <span className="hud-ko">KO</span>}
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
          {/* Once it's over only HP and the result matter */}
          {!result && (
            <>
              <span className="hud-res-item"><span className="hud-res-label">Ammo</span><Pips n={ammo} max={3} kind="ammo" /></span>
              <span className="hud-res-item"><span className="hud-res-label">Shield</span><Pips n={shields} max={3} kind="shield" /></span>
            </>
          )}
          {result === "won" && <span className="hud-won">Winner</span>}
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
  onMatchComplete = null, // called with the match id once its playback has reached the end
  sound = false,
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
    else if (p1Move === p2Move) ticker = <>Both {p1Move.toLowerCase()}.</>;
    else ticker = <>{match.p1_name} {p1Move.toLowerCase()}s, {match.p2_name} {p2Move.toLowerCase()}s.</>;
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

      <footer className={`arena-ticker ${isMatchComplete ? "is-final" : ""}`}>
        <span key={`${turnKey}-${isIntermission}-${isMatchComplete}`}>{ticker}</span>
      </footer>
    </section>
  );
}
