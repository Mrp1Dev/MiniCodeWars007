import { useEffect, useRef, useState } from "react";

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
  isSequential = false,
  isCompleted = false,
}) {
  // 1. Maintain clock offset smoothly without triggering animation loop rebuilds
  const clockOffsetRef = useRef(serverTime ? serverTime - Date.now() / 1000 : 0);
  useEffect(() => {
    if (serverTime) {
      clockOffsetRef.current = serverTime - Date.now() / 1000;
    }
  }, [serverTime]);

  // Keep latest games in ref so polling object reference churn doesn't break RAF
  const gamesRef = useRef(games);
  useEffect(() => {
    gamesRef.current = games;
  }, [games]);

  const getInitialState = () => {
    const firstGame = games[0] || null;
    const firstTurn = firstGame?.turns?.[0] || null;
    return {
      gameIndex: 0,
      turnIndex: 0,
      isIntermission: false,
      isMatchComplete: false,
      currentGame: firstGame,
      currentTurn: firstTurn,
      p1Score: 0,
      p2Score: 0,
      p1Hp: 3,
      p2Hp: 3,
      p1Ammo: 0,
      p2Ammo: 0,
      p1Shields: 3,
      p2Shields: 3,
    };
  };

  const [playback, setPlayback] = useState(getInitialState);
  const lastStateRef = useRef({});

  useEffect(() => {
    const currentGames = gamesRef.current || [];
    if (!currentGames || currentGames.length === 0) {
      setPlayback((prev) => ({ ...prev, isMatchComplete: true, currentGame: null, currentTurn: null }));
      return;
    }

    // Forced completed state
    if (isCompleted) {
      const lastGame = currentGames[currentGames.length - 1];
      const lastTurn = lastGame?.turns?.[lastGame.turns.length - 1] || null;
      let p1Wins = 0;
      let p2Wins = 0;
      for (const g of currentGames) {
        const w = g.result?.winner;
        if (w === 0) p1Wins++;
        else if (w === 1) p2Wins++;
      }
      const p1 = lastTurn?.state?.[0] || { hp: 0, ammo: 0, shields: 0 };
      const p2 = lastTurn?.state?.[1] || { hp: 0, ammo: 0, shields: 0 };

      setPlayback({
        gameIndex: currentGames.length - 1,
        turnIndex: (lastGame?.turns?.length || 1) - 1,
        isIntermission: false,
        isMatchComplete: true,
        currentGame: lastGame,
        currentTurn: lastTurn,
        p1Score: p1Wins,
        p2Score: p2Wins,
        p1Hp: p1.hp,
        p2Hp: p2.hp,
        p1Ammo: p1.ammo,
        p2Ammo: p2.ammo,
        p1Shields: p1.shields,
        p2Shields: p2.shields,
      });
      return;
    }

    // Grand Finale Manual Host Control mode (turnStep >= 0)
    if (turnStep >= 0) {
      let totalTurns = 0;
      for (const g of currentGames) {
        totalTurns += (g.turns?.length || 0);
      }

      let stepAcc = 0;
      let targetGIdx = 0;
      let targetTIdx = 0;
      let p1Wins = 0;
      let p2Wins = 0;

      for (let g = 0; g < currentGames.length; g++) {
        const turnCount = currentGames[g].turns.length;
        if (turnStep < stepAcc + turnCount) {
          targetGIdx = g;
          targetTIdx = turnStep - stepAcc;
          break;
        } else {
          stepAcc += turnCount;
          const w = currentGames[g].result?.winner;
          if (w === 0) p1Wins++;
          else if (w === 1) p2Wins++;
          if (g === currentGames.length - 1) {
            targetGIdx = currentGames.length - 1;
            targetTIdx = Math.max(0, turnCount - 1);
          }
        }
      }

      const activeGame = currentGames[targetGIdx] || currentGames[0];
      const activeTurn = activeGame?.turns?.[targetTIdx] || null;
      const p1 = activeTurn?.state?.[0] || { hp: 3, ammo: 0, shields: 3 };
      const p2 = activeTurn?.state?.[1] || { hp: 3, ammo: 0, shields: 3 };

      // In manual step mode, display the final turn clash; only mark complete when stepped beyond total turns
      const isPastFinal = turnStep >= totalTurns;

      setPlayback({
        gameIndex: targetGIdx,
        turnIndex: targetTIdx,
        isIntermission: false,
        isMatchComplete: isPastFinal,
        currentGame: activeGame,
        currentTurn: activeTurn,
        p1Score: p1Wins,
        p2Score: p2Wins,
        p1Hp: p1.hp,
        p2Hp: p2.hp,
        p1Ammo: p1.ammo,
        p2Ammo: p2.ammo,
        p1Shields: p1.shields,
        p2Shields: p2.shields,
      });
      return;
    }

    // Not started yet
    if (!startedAt) {
      setPlayback(getInitialState());
      return;
    }

    let rafId;

    const tick = () => {
      let isDone = false;
      try {
        const gList = gamesRef.current || games || [];
        if (!gList || gList.length === 0) return;

        let totalSeriesDurationMs = 0;
        for (const g of gList) {
          totalSeriesDurationMs += (g.turns?.length || 0) * turnMs + gamePauseMs;
        }

        const effectiveNow = Date.now() / 1000 + clockOffsetRef.current;
        const rawElapsedMs = Math.max(
          0,
          (effectiveNow - startedAt - (accumulatedPause || 0)) * 1000
        );

        // Cap elapsed time to the end of the series so completed matches remain finished without looping
        const effectiveElapsedMs = rawElapsedMs;

        let accumulatedTime = 0;
        let targetGameIndex = 0;
        let targetTurnIndex = 0;
        let isIntermission = false;
        let matchComplete = false;
        let p1Wins = 0;
        let p2Wins = 0;

        for (let i = 0; i < gList.length; i++) {
          const game = gList[i];
          const turnCount = game.turns?.length || 0;
          const gameDuration = turnCount * turnMs;
          const totalGameSlot = gameDuration + gamePauseMs;

          if (effectiveElapsedMs < accumulatedTime + totalGameSlot) {
            // Inside this game
            targetGameIndex = i;
            const gameElapsed = effectiveElapsedMs - accumulatedTime;

            if (gameElapsed >= gameDuration) {
              isIntermission = true;
              targetTurnIndex = Math.max(0, turnCount - 1);
              const winner = game.result?.winner;
              if (winner === 0) p1Wins++;
              else if (winner === 1) p2Wins++;
            } else {
              targetTurnIndex = Math.min(Math.max(0, turnCount - 1), Math.floor(gameElapsed / turnMs));
            }
            break;
          } else {
            // Past this game
            accumulatedTime += totalGameSlot;
            const winner = game.result?.winner;
            if (winner === 0) p1Wins++;
            else if (winner === 1) p2Wins++;

            if (i === gList.length - 1) {
              matchComplete = true;
              targetGameIndex = gList.length - 1;
              targetTurnIndex = Math.max(0, (gList[i]?.turns?.length || 1) - 1);
            }
          }
        }

        const activeGame = gList[targetGameIndex] || gList[0];
        const activeTurn = activeGame?.turns?.[targetTurnIndex] || null;

        let p1Hp = 3, p2Hp = 3, p1Ammo = 0, p2Ammo = 0, p1Shields = 3, p2Shields = 3;
        if (activeTurn && activeTurn.state) {
          p1Hp = activeTurn.state[0]?.hp ?? 3;
          p2Hp = activeTurn.state[1]?.hp ?? 3;
          p1Ammo = activeTurn.state[0]?.ammo ?? 0;
          p2Ammo = activeTurn.state[1]?.ammo ?? 0;
          p1Shields = activeTurn.state[0]?.shields ?? 3;
          p2Shields = activeTurn.state[1]?.shields ?? 3;
        }

        const last = lastStateRef.current;
        const turnChanged = last.turnIndex !== targetTurnIndex || last.gameIndex !== targetGameIndex;
        const stateChanged = turnChanged || last.isIntermission !== isIntermission || last.matchComplete !== matchComplete;

        if (stateChanged) {
          lastStateRef.current = {
            gameIndex: targetGameIndex,
            turnIndex: targetTurnIndex,
            isIntermission,
            matchComplete,
          };

          setPlayback({
            gameIndex: targetGameIndex,
            turnIndex: targetTurnIndex,
            isIntermission,
            isMatchComplete: matchComplete,
            currentGame: activeGame,
            currentTurn: activeTurn,
            p1Score: p1Wins,
            p2Score: p2Wins,
            p1Hp,
            p2Hp,
            p1Ammo,
            p2Ammo,
            p1Shields,
            p2Shields,
          });
        }

        if (matchComplete) {
          isDone = true;
        }
      } catch (err) {
        console.error("BattleArena playback loop error:", err);
      }

      if (!paused && !isDone) {
        rafId = requestAnimationFrame(tick);
      }
    };

    tick();
    if (!paused) {
      rafId = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(rafId);
  }, [startedAt, paused, accumulatedPause, turnStep, matchId, turnMs, gamePauseMs, isSequential, isCompleted]);

  return playback;
}
