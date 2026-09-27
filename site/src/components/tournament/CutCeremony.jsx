import React from "react";

export default function CutCeremony({ tiers }) {
  const { tier1 = [], tier2 = [], tier3 = [] } = tiers || {};
  const all32 = [...tier1, ...tier2, ...tier3];

  return (
    <div className="cut-ceremony-container">
      <div className="cut-banner">
        THE CUT: TOP 32 CONTENDERS
      </div>
      <p className="faint" style={{ margin: "0 0 16px", fontSize: "15px" }}>
        6 Swiss rounds concluded. The following 32 agents advance to the Single Elimination Championship Bracket:
      </p>

      <div className="cut-grid">
        {all32.map((bot, idx) => (
          <div key={bot.participant_id || idx} className={`cut-bot-card ${bot.tier === 1 ? "elite" : ""}`}>
            <span style={{ fontWeight: 700, color: "var(--t-gold)" }}>#{idx + 1}</span>
            <span style={{ fontWeight: 600, fontSize: "14px" }}>{bot.bot_name}</span>
            <span style={{ fontSize: "11px", color: "var(--t-muted)" }}>
              {bot.tier === 1 ? "ELITE" : bot.tier === 2 ? "CONTENDER" : "BUBBLE"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
