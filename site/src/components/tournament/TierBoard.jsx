import React, { useLayoutEffect, useRef } from "react";
import { useDynamicTiers } from "./useDynamicTiers";

<<<<<<< Updated upstream
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
=======
const TIERS = [
  { key: "tier1", numeral: "I", name: "Elite", range: "Top 8" },
  { key: "tier2", numeral: "II", name: "Contenders", range: "9 – 20" },
  { key: "tier3", numeral: "III", name: "The bubble", range: "21 – 32" },
];

/**
 * Slides every row from where it was to where it is now, so a bot climbing or dropping (or
 * changing tier) is visible instead of teleporting. Uses offsets, which ignore running transforms.
 */
function useFlip(containerRef) {
  const last = useRef(new Map());
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const next = new Map();
    const hadLayout = last.current.size > 0;
    for (const node of el.querySelectorAll("[data-pid]")) {
      const pos = { x: node.offsetLeft, y: node.offsetTop };
      next.set(node.dataset.pid, pos);
      const prev = last.current.get(node.dataset.pid);
      if (prev) {
        const dx = prev.x - pos.x;
        const dy = prev.y - pos.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          node.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
            { duration: 750, easing: "cubic-bezier(0.22, 0.8, 0.2, 1)" }
          );
        }
      } else if (hadLayout) {
        // Just broke into the top 32.
        node.animate(
          [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
          { duration: 600, easing: "ease-out" }
        );
      }
    }
    last.current = next;
  });
}

export default function TierBoard({ tiers, baseStandings, roundMatches, status, totalParticipants = 0 }) {
>>>>>>> Stashed changes
  const dynamicTiers = useDynamicTiers({
    baseStandings,
    roundMatches,
    status,
    fallbackTiers: tiers,
  });
  const gridRef = useRef(null);
  useFlip(gridRef);

<<<<<<< Updated upstream
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
=======
  const groups = TIERS.map((t) => ({ ...t, bots: dynamicTiers?.[t.key] || [] }));
  const shown = groups.reduce((n, g) => n + g.bots.length, 0);
  const liveDuels = groups.reduce((n, g) => n + g.bots.filter((b) => b.is_battling).length, 0);

  // One grid for all three tiers: a header row per tier, then two names per row. Row heights
  // are capped, so a small field doesn't stretch and a full 32 fits without scrolling.
  const rowTracks = [];
  for (const g of groups) {
    rowTracks.push("auto");
    const rows = Math.ceil(g.bots.length / 2);
    if (rows) rowTracks.push(`repeat(${rows}, minmax(0, var(--tb-row-max)))`);
  }
>>>>>>> Stashed changes

  return (
    <section className="tier-board">
      <header className="tb-head">
        <div>
<<<<<<< Updated upstream
          <span className="tier-board-title">Top 32 Cut Line</span>
          <span className="tier-board-sub">
            <span className="elite-key" /> Elite 8
          </span>
=======
          <span className="bs-eyebrow">
            {totalParticipants > 32 ? `Top 32 of ${totalParticipants} advance` : "Provisional standings"}
          </span>
          <h2 className="tb-title">Road to the Top 32</h2>
>>>>>>> Stashed changes
        </div>
        <div className={`tb-live ${liveDuels ? "is-live" : ""}`}>
          {liveDuels ? (
            <>
              <span className="tb-live-dot" />
              {liveDuels} {liveDuels === 1 ? "agent" : "agents"} dueling
            </>
          ) : (
            "Round settled"
          )}
        </div>
      </header>

<<<<<<< Updated upstream
      <div className="tier-board-scroll no-scroll">
        <div className="tier-group" style={{ flexGrow: columnRows(CUT) }}>
          {top32.length === 0 ? (
            <div className="tier-empty">Pending Round 1 results</div>
          ) : (
            renderGrid(top32, columnRows(top32.length))
=======
      {shown === 0 ? (
        <div className="tb-empty">Standings appear once Round 1 is under way.</div>
      ) : (
        <div className="tb-grid" ref={gridRef} style={{ gridTemplateRows: rowTracks.join(" ") }}>
          {groups.map((g, gi) =>
            g.bots.length === 0 ? null : (
              <React.Fragment key={g.key}>
                <div className={`tb-tier-head tier-${gi + 1}`}>
                  <span className="tb-numeral">{g.numeral}</span>
                  <span className="tb-tier-name">{g.name}</span>
                  <span className="tb-tier-rule" />
                  <span className="tb-tier-range">{g.range}</span>
                </div>
                {g.bots.map((b) => (
                  <div
                    key={b.participant_id}
                    data-pid={b.participant_id}
                    className={`tb-row tier-${gi + 1} ${b.is_battling ? "is-live" : ""} ${b.just_finished && b.just_won ? "is-won" : ""}`}
                  >
                    <span className="tb-name" title={b.bot_name}>{b.bot_name}</span>
                    {b.is_battling ? (
                      <span className="tb-row-live" title="Duel in progress" />
                    ) : b.delta > 0 ? (
                      <span className="tb-delta up">▲{b.delta}</span>
                    ) : b.delta < 0 ? (
                      <span className="tb-delta down">▼{-b.delta}</span>
                    ) : null}
                  </div>
                ))}
              </React.Fragment>
            )
>>>>>>> Stashed changes
          )}
        </div>
      )}

<<<<<<< Updated upstream
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
=======
      <footer className="tb-foot">
        <span><span className="tb-row-live static" /> In a duel</span>
        <span><span className="tb-delta up">▲</span><span className="tb-delta down">▼</span> Moved</span>
      </footer>
    </section>
>>>>>>> Stashed changes
  );
}
