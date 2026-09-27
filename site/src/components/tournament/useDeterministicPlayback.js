import { useEffect, useRef, useState } from "react";

function getFresh(game, fallbackHp = 5) {
  const hp = game?.start_hp ?? game?.config?.game?.start_hp ?? fallbackHp;
  return { hp, ammo: 0, shields: 3 };
}

function wins(games, upTo) {
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < upTo; i++) {
    const w = games[i]?.result?.winner;
    if (w === 0) p1++;
    else if (w === 1) p2++;
  }
  return [p1, p2];
}

function snapshot(games, gameIndex, turnIndex, { isIntermission = false, isMatchComplete = false, scoredGames, startHp = 5 }) {
  const currentGame = games[gameIndex] || null;
  const currentTurn = currentGame?.turns?.[turnIndex] || null;
  const [p1Score, p2Score] = wins(games, scoredGames);
  const fresh = getFresh(currentGame, startHp);
  const p1 = currentTurn?.state?.[0] || fresh;
  const p2 = currentTurn?.state?.[1] || fresh;
  return {
    gameIndex,
    turnIndex,
    isIntermission,
    isMatchComplete,
    currentGame,
    currentTurn,
    p1Score,
    p2Score,
    p1Hp: p1.hp ?? fresh.hp,
    p2Hp: p2.hp ?? fresh.hp,
    p1Ammo: p1.ammo ?? 0,
    p2Ammo: p2.ammo ?? 0,
    p1Shields: p1.shields ?? 3,
    p2Shields: p2.shields ?? 3,
  };
}

function lastTurnIndex(game) {
  return Math.max(0, (game?.turns?.length || 1) - 1);
}

/** Where a series stands `elapsedMs` after it started playing. */
function atElapsed(games, elapsedMs, turnMs, gamePauseMs, startHp = 5) {
  let t = 0;
  for (let i = 0; i < games.length; i++) {
    const turnCount = games[i].turns?.length || 0;
    const duration = turnCount * turnMs;
    if (elapsedMs < t + duration + gamePauseMs) {
      const inGame = elapsedMs - t;
      if (inGame >= duration) {
        // Between games: the finished game's result counts toward the series score.
        return snapshot(games, i, lastTurnIndex(games[i]), { isIntermission: true, scoredGames: i + 1, startHp });
      }
      return snapshot(games, i, Math.min(lastTurnIndex(games[i]), Math.floor(inGame / turnMs)), { scoredGames: i, startHp });
    }
    t += duration + gamePauseMs;
  }
  const last = games.length - 1;
  return snapshot(games, last, lastTurnIndex(games[last]), { isMatchComplete: true, scoredGames: games.length, startHp });
}

/** Host-controlled step: `step` counts turns across all games; stepping past the end completes the match. */
function atStep(games, step, startHp = 5) {
  let acc = 0;
  for (let i = 0; i < games.length; i++) {
    const turnCount = games[i].turns?.length || 0;
    if (step < acc + turnCount) {
      return snapshot(games, i, step - acc, { scoredGames: i, startHp });
    }
    acc += turnCount;
  }
  const last = games.length - 1;
  return snapshot(games, last, lastTurnIndex(games[last]), { isMatchComplete: true, scoredGames: games.length, startHp });
}

/**
 * Deterministic replay clock shared by every screen: the position in a series is a pure function of
 * (server time - started_at - accumulated pause), so a reload or a late joiner lands on the same turn.
 */
export function useDeterministicPlayback({
  startedAt,
  serverTime,
  paused,
  accumulatedPause = 0,
  turnStep = -1,
  games = [],
  matchId = null,
  turnMs = 750,
  gamePauseMs = 2500,
  startHp = 5,
  isCompleted = false,
}) {
  // Offset between the server clock and this device's clock, refreshed with every poll.
  const clockOffsetRef = useRef(serverTime ? serverTime - Date.now() / 1000 : 0);
  useEffect(() => {
    if (serverTime) clockOffsetRef.current = serverTime - Date.now() / 1000;
  }, [serverTime]);

  // Polling hands us a new games array every time; keep the latest in a ref so the loop isn't rebuilt.
  const gamesRef = useRef(games);
  gamesRef.current = games;
  const hasGames = games.length > 0;

  const [playback, setPlayback] = useState(() =>
    hasGames ? snapshot(games, 0, 0, { scoredGames: 0, startHp }) : { ...snapshot([], 0, 0, { scoredGames: 0, startHp }), isMatchComplete: true }
  );

  useEffect(() => {
    const list = gamesRef.current || [];
    if (list.length === 0) {
      setPlayback({ ...snapshot([], 0, 0, { scoredGames: 0, startHp }), isMatchComplete: true });
      return undefined;
    }
    if (isCompleted) {
      setPlayback(atElapsed(list, Number.MAX_SAFE_INTEGER, turnMs, gamePauseMs, startHp));
      return undefined;
    }
    if (turnStep >= 0) {
      setPlayback(atStep(list, turnStep, startHp));
      return undefined;
    }
    if (!startedAt) {
      setPlayback(snapshot(list, 0, 0, { scoredGames: 0, startHp }));
      return undefined;
    }

    let cancelled = false;
    let rafId = null;
    let lastKey = null;

    const tick = () => {
      if (cancelled) return;
      const current = gamesRef.current || [];
      let done = false;
      if (current.length > 0) {
        const now = Date.now() / 1000 + clockOffsetRef.current;
        const elapsedMs = Math.max(0, (now - startedAt - (accumulatedPause || 0)) * 1000);
        const next = atElapsed(current, elapsedMs, turnMs, gamePauseMs, startHp);
        const key = `${next.gameIndex}:${next.turnIndex}:${next.isIntermission}:${next.isMatchComplete}`;
        if (key !== lastKey) {
          lastKey = key;
          setPlayback(next);
        }
        done = next.isMatchComplete;
      }
      // One loop per effect run; it stops when paused (the next poll restarts it) or finished.
      if (!paused && !done) rafId = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [startedAt, paused, accumulatedPause, turnStep, matchId, hasGames, turnMs, gamePauseMs, startHp, isCompleted]);

  return playback;
}
