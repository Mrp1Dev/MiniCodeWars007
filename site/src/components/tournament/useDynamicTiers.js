import { useEffect, useMemo, useRef, useState } from "react";

const FLARE_MS = 4000;

function toTiers(list) {
  return {
    tier1: list.filter((b) => b.tier === 1),
    tier2: list.filter((b) => b.tier === 2),
    tier3: list.filter((b) => b.tier === 3),
    total_top32: list.length,
  };
}

/** Standings `elapsedMs` into the round: only matches whose replay has finished count. */
function liveTiers(baseStandings, roundMatches, elapsedMs) {
  const pMap = {};
  for (const b of baseStandings) {
    pMap[b.participant_id] = {
      ...b,
      match_wins: b.match_wins || 0,
      match_losses: b.match_losses || 0,
      is_battling: false,
      just_finished: false,
    };
  }

  let allFinished = true;
  for (const m of roundMatches) {
    const p1 = pMap[m.p1_id];
    const p2 = m.p2_id ? pMap[m.p2_id] : null;
    const finished = m.is_bye || elapsedMs >= m.finish_ms;
    if (!finished) {
      allFinished = false;
      if (p1) p1.is_battling = true;
      if (p2) p2.is_battling = true;
      continue;
    }
    // Every match has a decisive winner (regulation or tiebreak); a bye is a win.
    if (m.winner_id === m.p1_id) {
      if (p1) p1.match_wins += 1;
      if (p2) p2.match_losses += 1;
    } else if (m.winner_id === m.p2_id) {
      if (p2) p2.match_wins += 1;
      if (p1) p1.match_losses += 1;
    }
    if (!m.is_bye && elapsedMs - m.finish_ms < FLARE_MS) {
      if (p1) p1.just_finished = true;
      if (p2) p2.just_finished = true;
    }
  }

  // Ranked by record; ties keep the backend's official merit order from before the round,
  // so the board never contradicts the 10-tier tiebreak chain.
  const sorted = Object.values(pMap).sort((a, b) => {
    if (b.match_wins !== a.match_wins) return b.match_wins - a.match_wins;
    if (a.match_losses !== b.match_losses) return a.match_losses - b.match_losses;
    const aRank = a.prev_rank || 999999;
    const bRank = b.prev_rank || 999999;
    if (aRank !== bRank) return aRank - bRank;
    return (a.participant_id || 0) - (b.participant_id || 0);
  });

  const top32 = sorted.slice(0, 32).map((bot, index) => {
    const rank = index + 1;
    return {
      ...bot,
      rank,
      tier: rank <= 8 ? 1 : rank <= 20 ? 2 : 3,
      delta: bot.prev_rank ? bot.prev_rank - rank : 0, // positive = climbed; none before Round 1
    };
  });
  return { tiers: toTiers(top32), allFinished };
}

/**
 * The 3-Tier Board during a Swiss round, in step with the deterministic replay clock so
 * NO RESULT IS SHOWN BEFORE ITS MATCH HAS FINISHED PLAYING:
 * - At t=0: pre-round placement.
 * - As matches reach their finish_ms, their results are credited and the board re-sorts.
 * - Once every match has finished: the backend's official standings for the round.
 */
export function useDynamicTiers({ baseStandings, roundMatches, status, fallbackTiers }) {
  const {
    started_at: startedAt,
    server_time: serverTime,
    accumulated_pause: accumulatedPause = 0,
    paused = false,
    stage = "",
  } = status || {};

  const clockOffsetRef = useRef(serverTime ? serverTime - Date.now() / 1000 : 0);
  useEffect(() => {
    if (serverTime) clockOffsetRef.current = serverTime - Date.now() / 1000;
  }, [serverTime]);

  const live = stage.startsWith("swiss_") && baseStandings?.length > 0 && roundMatches?.length > 0;
  const lastFinishMs = useMemo(
    () => (roundMatches || []).reduce((mx, m) => Math.max(mx, m.finish_ms || 0), 0),
    [roundMatches]
  );

  const elapsedAt = () => {
    if (!startedAt) return 0;
    const now = Date.now() / 1000 + clockOffsetRef.current;
    return Math.max(0, (now - startedAt - (accumulatedPause || 0)) * 1000);
  };

  // Re-evaluate twice a second while matches are still playing.
  const [elapsedMs, setElapsedMs] = useState(elapsedAt);
  useEffect(() => {
    setElapsedMs(elapsedAt());
    if (!live || paused) return undefined;
    const id = setInterval(() => {
      const e = elapsedAt();
      setElapsedMs(e);
      if (e > lastFinishMs + FLARE_MS) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, [live, paused, startedAt, accumulatedPause, lastFinishMs]);

  return useMemo(() => {
    if (!live) return fallbackTiers;
    // Read the clock here rather than trusting elapsedMs (which only triggers re-renders): right
    // after a new round starts it still holds the previous round's time and would spoil results.
    // The official standings (fallbackTiers) already include this round, so they wait until the end.
    const e = elapsedAt();
    const { tiers, allFinished } = liveTiers(baseStandings, roundMatches, e);
    if (allFinished && fallbackTiers?.total_top32 > 0 && e > lastFinishMs + FLARE_MS) return fallbackTiers;
    return tiers;
  }, [live, baseStandings, roundMatches, fallbackTiers, elapsedMs, lastFinishMs]);
}
