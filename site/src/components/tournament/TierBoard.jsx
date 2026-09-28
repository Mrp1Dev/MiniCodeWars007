import React, { useLayoutEffect, useRef } from "react";
import { useDynamicTiers } from "./useDynamicTiers";

const ELITE = 8;

/**
 * Slides every row from where it was to where it is now, so a bot climbing or dropping is
 * visible instead of teleporting. Uses offsets, which ignore running transforms.
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
        // Just appeared on the board.
        node.animate(
          [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
          { duration: 600, easing: "ease-out" }
        );
      }
    }
    last.current = next;
  });
}

// Grid cell for the i-th of n bots, filled down the left column first, then the right,
// starting at grid row `top`.
function cell(i, n, top) {
  const half = Math.max(1, Math.ceil(n / 2));
  return { gridColumn: i < half ? 1 : 2, gridRow: top + (i % half) };
}

export default function TierBoard({ tiers, baseStandings, roundMatches, status, totalParticipants = 0 }) {
  const dynamicTiers = useDynamicTiers({
    baseStandings,
    roundMatches,
    status,
    fallbackTiers: tiers,
  });
  const gridRef = useRef(null);
  useFlip(gridRef);

  const { tier1 = [], tier2 = [], tier3 = [], bubble = [] } = dynamicTiers || {};
  const top32 = [...tier1, ...tier2, ...tier3].sort((a, b) => a.rank - b.rank);
  const liveDuels = [...top32, ...bubble].filter((b) => b.is_battling).length;

  const topRows = Math.ceil(top32.length / 2);
  const bubbleRows = Math.ceil(bubble.length / 2);
  const rowTracks = [`repeat(${Math.max(1, topRows)}, minmax(0, var(--tb-row-max)))`];
  if (bubble.length) rowTracks.push("auto", `repeat(${bubbleRows}, minmax(0, var(--tb-row-max)))`);

  const renderRow = (b, style, extra = "") => (
    <div
      key={b.participant_id}
      data-pid={b.participant_id}
      style={style}
      className={`tb-row ${b.rank <= ELITE ? "elite" : ""} ${extra} ${b.just_finished && b.just_won ? "is-won" : ""}`}
    >
      <span className="tb-rank">{b.rank}</span>
      <span className="tb-name" title={b.bot_name}>{b.bot_name}</span>
      {b.is_battling && <span className="tb-row-live" title="Duel in progress" />}
      <span className="tb-delta-slot">
        {b.delta > 0 ? (
          <span className="tb-delta up" title={`Up ${b.delta}`}>▲</span>
        ) : b.delta < 0 ? (
          <span className="tb-delta down" title={`Down ${-b.delta}`}>▼</span>
        ) : null}
      </span>
    </div>
  );

  return (
    <section className="tier-board">
      <header className="tb-head">
        <div>
          <span className="bs-eyebrow">
            {totalParticipants > 32 ? `Top 32 of ${totalParticipants} advance` : "Provisional standings"}
          </span>
          <h2 className="tb-title">Road to the Top 32</h2>
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

      {top32.length === 0 ? (
        <div className="tb-empty">Standings appear once Round 1 is under way.</div>
      ) : (
        <div className="tb-grid" ref={gridRef} style={{ gridTemplateRows: rowTracks.join(" ") }}>
          {top32.map((b, i) => renderRow(b, cell(i, top32.length, 1)))}
          {bubble.length > 0 && (
            <div className="tb-cut-line" style={{ gridRow: topRows + 1 }}>
              <span>Cut · Top 32</span>
            </div>
          )}
          {bubble.map((b, i) => renderRow(b, cell(i, bubble.length, topRows + 2), "is-bubble"))}
        </div>
      )}

      <footer className="tb-foot">
        <span><span className="tb-elite-key" /> Elite 8</span>
        <span><span className="tb-row-live static" /> In a duel</span>
        <span><span className="tb-delta up">▲</span><span className="tb-delta down">▼</span> Moved</span>
      </footer>
    </section>
  );
}
