import React from "react";
import { useDynamicTiers } from "./useDynamicTiers";

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

  const { tier1 = [], tier2 = [], tier3 = [] } = dynamicTiers || {};

  const renderDelta = (delta) => {
    if (!delta || delta === 0) return <span className="tier-delta same">-</span>;
    if (delta > 0) return <span className="tier-delta up">▲+{delta}</span>;
    return <span className="tier-delta down">▼{Math.abs(delta)}</span>;
  };

  const renderBot = (b) => (
    <div
      key={b.participant_id}
      className={`tier-bot-item ${b.just_finished ? "just-updated" : ""} ${b.is_battling ? "in-battle" : ""}`}
      title={b.bot_name}
    >
      <span className="tier-bot-name">{b.bot_name}</span>
      {b.is_battling && <span className="battling-pulse" title="Duel in progress">● IN BATTLE</span>}
      {renderDelta(b.delta)}
    </div>
  );

  return (
    <div className="tier-board">
      <div className="tier-board-header">
        <div>
          <span className="tier-board-title">Top 32 Cut Line</span>
          <span className="tier-board-sub">Current Provisional Contenders</span>
        </div>
        <span className="tier-board-meta">
          {roundNumber > 0 ? `Swiss Round ${roundNumber}` : "Ready Room"}
        </span>
      </div>

      <div className="tier-board-scroll no-scroll">
        {/* Tier 1: Elite */}
        <div className="tier-group tier-group-1">
          <div className="tier-group-header">
            <span>Tier 1 · Elite</span>
            <span className="tier-badge-star">★ PROVISIONAL CUT</span>
          </div>
          <div className="tier-grid-2col">
            {tier1.length === 0 ? (
              <div className="faint center grid-span-2" style={{ padding: "6px", fontSize: "11px" }}>
                Pending Round 1 results
              </div>
            ) : (
              tier1.map((b) => renderBot(b))
            )}
          </div>
        </div>

        {/* Tier 2: Contenders */}
        <div className="tier-group tier-group-2">
          <div className="tier-group-header">
            <span>Tier 2 · Contenders</span>
            <span>◆ ACTIVE FIELD</span>
          </div>
          <div className="tier-grid-2col">
            {tier2.length === 0 ? (
              <div className="faint center grid-span-2" style={{ padding: "6px", fontSize: "11px" }}>
                Pending Round 1 results
              </div>
            ) : (
              tier2.map((b) => renderBot(b))
            )}
          </div>
        </div>

        {/* Tier 3: Challengers */}
        <div className="tier-group tier-group-3">
          <div className="tier-group-header">
            <span>Tier 3 · Challengers</span>
            <span>▲ THE BUBBLE</span>
          </div>
          <div className="tier-grid-2col">
            {tier3.length === 0 ? (
              <div className="faint center grid-span-2" style={{ padding: "6px", fontSize: "11px" }}>
                Pending Round 1 results
              </div>
            ) : (
              tier3.map((b) => renderBot(b))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
