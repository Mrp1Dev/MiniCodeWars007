import React from "react";
import { useDynamicTiers } from "./useDynamicTiers";

const CUT = 32;
const ELITE = 8;

// Two columns, filled top-to-bottom first so ranks read down the left column, then the right.
const columnRows = (count) => Math.max(1, Math.ceil(count / 2));

export default function TierBoard({
  tiers,
  roundNumber,
  baseStandings,
  roundMatches,
  status,
}) {
  const dynamicTiers = useDynamicTiers({
    baseStandings,
    roundMatches,
    status,
    fallbackTiers: tiers,
  });

  const { tier1 = [], tier2 = [], tier3 = [], bubble = [] } = dynamicTiers || {};
  const top32 = [...tier1, ...tier2, ...tier3].sort((a, b) => a.rank - b.rank);

  const renderDelta = (delta) => {
    if (!delta) return null;
    if (delta > 0) return <span className="tier-delta up" title={`Up ${delta}`}>▲</span>;
    return <span className="tier-delta down" title={`Down ${Math.abs(delta)}`}>▼</span>;
  };

  const renderBot = (b) => (
    <div
      key={b.participant_id}
      className={`tier-bot-item ${b.rank <= ELITE ? "elite" : ""} ${b.just_finished ? "just-updated" : ""} ${b.is_battling ? "in-battle" : ""}`}
      title={b.is_battling ? `${b.bot_name} · duel in progress` : b.bot_name}
    >
      <span className="tier-bot-rank">{b.rank}</span>
      <span className="tier-bot-name">{b.bot_name}</span>
      {b.is_battling && <span className="battling-dot" aria-label="Duel in progress" />}
      <span className="tier-delta-slot">{renderDelta(b.delta)}</span>
    </div>
  );

  const renderGrid = (bots, rows) => (
    <div className="tier-grid-2col" style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
      {bots.map(renderBot)}
    </div>
  );

  return (
    <div className="tier-board">
      <div className="tier-board-header">
        <div>
          <span className="tier-board-title">Top 32 Cut Line</span>
          <span className="tier-board-sub">
            <span className="elite-key" /> Elite 8
          </span>
        </div>
        <span className="tier-board-meta">
          {roundNumber > 0 ? `Swiss Round ${roundNumber}` : "Ready Room"}
        </span>
      </div>

      <div className="tier-board-scroll no-scroll">
        <div className="tier-group" style={{ flexGrow: columnRows(CUT) }}>
          {top32.length === 0 ? (
            <div className="tier-empty">Pending Round 1 results</div>
          ) : (
            renderGrid(top32, columnRows(top32.length))
          )}
        </div>

        {bubble.length > 0 && (
          <div className="tier-group tier-group-bubble" style={{ flexGrow: columnRows(bubble.length) }}>
            <div className="tier-cut-line">
              <span>Cut · Top 32</span>
            </div>
            {renderGrid(bubble, columnRows(bubble.length))}
          </div>
        )}
      </div>
    </div>
  );
}
