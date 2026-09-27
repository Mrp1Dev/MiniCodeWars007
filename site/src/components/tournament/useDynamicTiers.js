import { useEffect, useRef, useState } from "react";

/**
 * useDynamicTiers
 *
 * Dynamically recalculates the 3-Tier Board standings in real-time as matches conclude,
 * synchronizing with deterministic playback so NO MATCH RESULTS ARE SPOILED AT t=0.
 *
 * - At t=0: Contenders show their pre-round record and tier placement.
 * - As t advances: When a match reaches its finish_ms, the results are credited,
 *   cards update (with a subtle victory flare), and the board dynamically re-sorts.
 * - When all matches conclude: Shows finalized round standings without CPU spin.
 */
export function useDynamicTiers({
  baseStandings,
  roundMatches,
  status,
  fallbackTiers,
}) {
  const {
    started_at: startedAt,
    server_time: serverTime,
    accumulated_pause: accumulatedPause = 0,
    stage = "",
  } = status || {};

  const clockOffsetRef = useRef(serverTime ? serverTime - Date.now() / 1000 : 0);
  useEffect(() => {
    if (serverTime) {
      clockOffsetRef.current = serverTime - Date.now() / 1000;
    }
  }, [serverTime]);

  const [liveTiers, setLiveTiers] = useState(null);

  useEffect(() => {
    if (!baseStandings || baseStandings.length === 0 || !roundMatches || roundMatches.length === 0 || stage === "ready_room") {
      setLiveTiers(null);
      return;
    }

    const isRoundComplete =
      stage === "cut_ceremony" ||
      stage.startsWith("ro") ||
      stage === "finals" ||
      stage === "champion";

    let timerId;

    const compute = () => {
      const effectiveNow = Date.now() / 1000 + clockOffsetRef.current;
      const elapsedMs = startedAt ? Math.max(0, (effectiveNow - startedAt - accumulatedPause) * 1000) : 0;

      // Initialize participants with their pre-round baseline stats
      const pMap = {};
      baseStandings.forEach((b) => {
        pMap[b.participant_id] = {
          ...b,
          match_wins: b.match_wins || 0,
          match_losses: b.match_losses || 0,
          game_wins: b.game_wins || 0,
          game_losses: b.game_losses || 0,
          damage_dealt: b.damage_dealt || 0,
          damage_taken: b.damage_taken || 0,
          fumbles: b.fumbles || 0,
          is_battling: false,
          just_finished: false,
        };
      });

      let allFinished = true;

      // Evaluate matches in the current round
      roundMatches.forEach((m) => {
        const finished = isRoundComplete || m.is_bye || elapsedMs >= m.finish_ms;
        if (!finished) allFinished = false;

        const p1 = pMap[m.p1_id];
        const p2 = m.p2_id ? pMap[m.p2_id] : null;

        if (finished) {
          if (m.is_bye) {
            if (p1) {
              p1.match_wins += 1;
              p1.game_wins += 3;
            }
          } else {
            // Apply completed game score and stats
            if (p1) {
              p1.game_wins += m.p1_score || 0;
              p1.game_losses += m.p2_score || 0;
              p1.damage_dealt += m.p1_damage || 0;
              p1.damage_taken += m.p2_damage || 0;
              p1.fumbles += m.p1_fumbles || 0;
            }
            if (p2) {
              p2.game_wins += m.p2_score || 0;
              p2.game_losses += m.p1_score || 0;
              p2.damage_dealt += m.p2_damage || 0;
              p2.damage_taken += m.p1_damage || 0;
              p2.fumbles += m.p2_fumbles || 0;
            }

            // Apply match result (every match has a decisive winner via regulation or tiebreaker)
            if (m.winner_id === m.p1_id) {
              if (p1) p1.match_wins += 1;
              if (p2) p2.match_losses += 1;
            } else if (m.winner_id === m.p2_id) {
              if (p2) p2.match_wins += 1;
              if (p1) p1.match_losses += 1;
            }

            // Flag recently finished matches for visual flare (within 4 seconds)
            const timeSinceFinish = elapsedMs - m.finish_ms;
            if (timeSinceFinish >= 0 && timeSinceFinish < 4000 && !isRoundComplete) {
              if (p1) p1.just_finished = true;
              if (p2) p2.just_finished = true;
            }
          }
        } else {
          // Still in battle!
          if (p1) p1.is_battling = true;
          if (p2) p2.is_battling = true;
        }
      });

      // If all matches have concluded or round is complete, use the backend's official 10-tier standings
      if (isRoundComplete || allFinished) {
        if (fallbackTiers && fallbackTiers.total_top32 > 0) {
          setLiveTiers(fallbackTiers);
          return;
        }
      }

      // Live In-Round Sorting:
      // Contenders are ranked by match wins and match losses.
      // Ties are resolved by the backend's official merit ranking (prev_rank)
      // so the frontend never diverges from backend 10-tier tiebreaker authority.
      const sorted = Object.values(pMap).sort((a, b) => {
        if (b.match_wins !== a.match_wins) return b.match_wins - a.match_wins;
        if (a.match_losses !== b.match_losses) return a.match_losses - b.match_losses;
        const aRank = a.prev_rank || a.rank || 999;
        const bRank = b.prev_rank || b.rank || 999;
        if (aRank !== bRank) return aRank - bRank;
        return (a.participant_id || 0) - (b.participant_id || 0);
      });

      // Assign Top 32 ranks, tiers, and movement deltas
      const top32 = sorted.slice(0, 32).map((bot, index) => {
        const currentRank = index + 1;
        const entryRank = bot.prev_rank || bot.rank || currentRank;
        const delta = entryRank - currentRank; // positive = climbed up
        let tier = 3;
        if (currentRank <= 8) tier = 1;
        else if (currentRank <= 20) tier = 2;

        return {
          ...bot,
          rank: currentRank,
          tier,
          delta,
        };
      });

      setLiveTiers({
        tier1: top32.filter((b) => b.tier === 1),
        tier2: top32.filter((b) => b.tier === 2),
        tier3: top32.filter((b) => b.tier === 3),
        total_top32: top32.length,
      });

      if (!isRoundComplete && !allFinished && !status?.paused) {
        timerId = setTimeout(compute, 500);
      }
    };

    compute();

    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, [baseStandings, roundMatches, startedAt, serverTime, accumulatedPause, stage, fallbackTiers, status?.paused]);

  return liveTiers || fallbackTiers;
}
