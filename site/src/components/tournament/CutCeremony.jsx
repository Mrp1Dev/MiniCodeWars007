import React from "react";

const TIER_NAMES = { 1: "Elite", 2: "Contender", 3: "Bubble" };

export default function CutCeremony({ tiers, swissRounds = 8 }) {
  const { tier1 = [], tier2 = [], tier3 = [] } = tiers || {};
  const all32 = [...tier1, ...tier2, ...tier3];

  return (
    <section className="cut-ceremony">
      <header className="cut-head">
        <span className="bs-eyebrow">{swissRounds} Swiss rounds complete</span>
        <h1 className="cut-title">The Top {all32.length || 32}</h1>
        <p className="cut-sub">These agents advance to the single-elimination knockout. Seeds set the bracket.</p>
      </header>

      <ol className="cut-grid">
        {all32.map((bot, idx) => (
          <li
            key={bot.participant_id || idx}
            className={`cut-card tier-${bot.tier || 3}`}
            style={{ animationDelay: `${idx * 45}ms` }}
          >
            <span className="cut-seed">{idx + 1}</span>
            <span className="cut-name" title={bot.bot_name}>{bot.bot_name}</span>
            <span className="cut-tier">{TIER_NAMES[bot.tier] || ""}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
