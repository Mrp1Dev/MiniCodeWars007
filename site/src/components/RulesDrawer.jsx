// Slide-over with the rules (numbers from /api/rules), the bot API and the test opponents.
import { useEffect, useState } from "react";
import { prettyBot } from "./Replay";
import { IconClose } from "./icons";

function moveRows(cfg) {
  const a = cfg.actions;
  const g = cfg.game;
  const list = (xs) => (xs && xs.length ? xs.join(" or ") : "nothing");
  const reflectedBy = (m) => (a[m].reflected_by || []);
  return [
    ["RELOAD", 0, `+${a.RELOAD.ammo_gain ?? 1} ammo (max ${g.max_ammo}). You're open to attacks.`],
    ["SHIELD", 0, `Blocks ${Object.keys(a).filter((m) => (a[m].blocked_by || []).includes("SHIELD")).join(", ")}. Uses 1 of your ${g.shield_charges} charges; any other move refills them.`],
    ["SHOOT", a.SHOOT.cost, `${a.SHOOT.damage} damage, unless blocked by ${list(a.SHOOT.blocked_by)}${reflectedBy("SHOOT").length ? `. ${list(reflectedBy("SHOOT"))} bounces it back at you` : ""}.`],
    ["SNIPE", a.SNIPE.cost, `${a.SNIPE.damage} damage, even through SHIELD. Stopped by ${list(a.SNIPE.blocked_by)}${reflectedBy("SNIPE").length ? `; ${list(reflectedBy("SNIPE"))} bounces it back` : ""}.`],
    ["COUNTER", a.COUNTER.cost, `If they SHOOT, they take the damage instead.${(a.SNIPE.blocked_by || []).includes("COUNTER") ? " Also stops SNIPE." : ""}`],
  ];
}

const API_EXAMPLE = `def play(me, opp, turn, memory):
    # me.hp  me.ammo  me.shields  me.history
    # opp.hp  opp.ammo  opp.history   (their shields are hidden!)
    # turn:   1, 2, 3, ...
    # memory: a dict kept between turns of one match
    if me.ammo == 0:
        return RELOAD
    if len(opp.history) > 0 and opp.history[-1] == RELOAD:
        return SHOOT
    return SHIELD`;

export default function RulesDrawer({ open, onClose, rules, houseBots }) {
  const [tab, setTab] = useState("rules");
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const cfg = rules && rules.config;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Rules and help">
        <div className="drawer-head">
          <div className="tabs">
            {[["rules", "Rules"], ["api", "Writing a bot"], ["bots", "Opponents"]].map(([k, label]) => (
              <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>

        <div className="drawer-body">
          {tab === "rules" && (cfg ? (
            <>
              <p>
                Both players start with <b>{cfg.game.start_hp} HP</b>, <b>{cfg.game.start_ammo} ammo</b> and{" "}
                <b>{cfg.game.shield_charges} shield charges</b>. Every turn, both bots secretly pick one move at the
                same time.
              </p>
              <table className="rules-table">
                <thead><tr><th>Move</th><th>Ammo</th><th>What it does</th></tr></thead>
                <tbody>
                  {moveRows(cfg).map(([m, cost, text]) => (
                    <tr key={m}><td><span className={`move move-${m}`}>{m}</span></td><td>{cost}</td><td>{text}</td></tr>
                  ))}
                </tbody>
              </table>
              <p>
                <span className="move move-FUMBLE">FUMBLE</span> An invalid move (not enough ammo, no shield charges left,
                a typo, a crash) does nothing and leaves you open. Your shields don't refill either.
              </p>
              <p>
                The game ends when someone hits 0 HP, or after <b>{cfg.game.max_rounds} turns</b>. Then more HP wins,
                then more ammo, then more damage dealt.
              </p>
            </>
          ) : <p className="muted">Loading…</p>)}

          {tab === "api" && (
            <>
              <h3>How it works</h3>
              <ol className="steps">
                <li>Write your bot's <code>play()</code> function in the editor. Python is best; if you'd rather describe it in
                  plain English, do that and press <b>Clean with AI</b>.</li>
                <li>The AI translates exactly what you wrote. It won't invent strategy: if something is vague, it points at
                  the part to fix. It also fixes small Python slips, like wrong indentation. Every version you clean is kept
                  in <b>History</b>, and Ctrl+Z / Ctrl+Y step through them too.</li>
                <li><b>Run</b> a practice match and read the turn-by-turn table to see what your bot did and where it went
                  wrong. Ctrl+Enter runs one too.</li>
                <li><b>Submit</b> when you're happy. You can submit again until time runs out; your latest working
                  submission is the one that plays in the tournament.</li>
              </ol>
              <h3>Writing it in plain English</h3>
              <ul>
                <li>Write rules like “if ___ then ___”. The first rule that matches decides the move.</li>
                <li>Say what to do when no rule matches, otherwise your bot fumbles.</li>
                <li>Your bot can't see the opponent's shield charges. It can see their HP, ammo and past moves.</li>
                <li>“Play the best move” or “outsmart them” isn't a rule. Say how.</li>
              </ul>
              <h3>What the Python looks like</h3>
              <pre className="code-block">{API_EXAMPLE}</pre>
              <ul>
                <li><code>opp.history[-1]</code> is their last move. Check the history isn't empty first (on turn 1 it is).</li>
                <li>You can import <code>random</code>, <code>math</code>, <code>collections</code>, <code>itertools</code> and{" "}
                  <code>functools</code>. <code>print()</code> works and shows up in the test results.</li>
                <li>Each move must take under {cfg ? cfg.limits?.move_timeout_ms ?? 100 : 100} ms.</li>
              </ul>
            </>
          )}

          {tab === "bots" && (
            <>
              <p className="muted">The practice opponents. They're simple on purpose: the real fight is the tournament.
                Every submission is checked against all of them.</p>
              {(houseBots || []).map((b) => (
                <details key={b.name} className="bot-card">
                  <summary><b>{prettyBot(b.name)}</b> <span className="muted">{b.description}</span></summary>
                  <pre className="code-block">{b.code}</pre>
                </details>
              ))}
              <details className="bot-card">
                <summary><b>your own bot</b> <span className="muted">Your bot plays against a copy of itself.</span></summary>
              </details>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
