// Plain-language explanations for a match's `draw_reason` (server/tournament.py run_match_series).
// Every match is a single game, so a tiebreak only happens when that game ended in a draw.

const REASONS = {
  // Elimination only: how the two bots did in this match
  elim_damage: { tag: "Damage", text: "dealt more damage in this match" },
  elim_hp: { tag: "HP left", text: "finished this match with more HP" },
  elim_fumbles: { tag: "Fumbles", text: "fumbled fewer times in this match" },
  // Tournament merit history (in elimination: the Swiss stage)
  match_wins: { tag: "Record", swiss: "has the better match record so far", elim: "had the better Swiss match record" },
  buchholz: {
    tag: "Schedule",
    swiss: "faced tougher opponents so far (Buchholz: their opponents have more wins)",
    elim: "faced tougher opponents in the Swiss stage (Buchholz: their opponents had more wins)",
  },
  sonneborn: {
    tag: "Quality wins",
    swiss: "beat stronger opponents so far (Sonneborn-Berger)",
    elim: "beat stronger opponents in the Swiss stage (Sonneborn-Berger)",
  },
  net_games: { tag: "Game diff", text: "has the better game difference (games won minus games lost) across the tournament" },
  game_wins: { tag: "Game wins", text: "has won more games across the tournament" },
  h2h: { tag: "Head-to-head", text: "won when these two met earlier in the tournament" },
  damage: { tag: "Total damage", text: "has dealt more damage across the tournament" },
  hp: { tag: "HP left", text: "finished this match with more HP" },
  fumbles: { tag: "Fumbles", text: "has fumbled fewer times across the tournament" },
  ko_turns: { tag: "KO speed", text: "wins its games in fewer turns on average" },
  swiss_seed: { tag: "Seed", text: "finished higher in the Swiss standings" },
  seed: { tag: "Coin flip", text: "won the seeded coin flip: every other measure was identical" },
};

/**
 * null when the match was won outright. Otherwise:
 *   tag  - a word or two for tight spaces ("Record", "Schedule")
 *   text - completes "<winner> ..." ("had the better Swiss match record")
 */
export function describeTiebreak(drawReason, { isSwiss = false } = {}) {
  if (!drawReason || !drawReason.startsWith("tiebreak_")) return null;
  const r = REASONS[drawReason.slice("tiebreak_".length)];
  if (!r) return { tag: "Tiebreak", text: "won on tiebreak" };
  return { tag: r.tag, text: r.text || (isSwiss ? r.swiss : r.elim) };
}
