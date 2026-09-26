// Turn-by-turn result of one test match. Errors, fumbles and print() output come first:
// that's how beginners debug. (The animated visualiser will read the same replay format.)
import { useState } from "react";
import { IconRepeat } from "./icons";

export const prettyBot = (name) => (name === "mirror" ? "your own bot" : name.replace(/_/g, " "));

// "line 5: NameError: ..." -> 5
const lineOf = (msg) => {
  const m = /^line (\d+):/.exec(msg || "");
  return m ? Number(m[1]) : null;
};

const LABELS = { error: "Crash", fumble: "Fumble", output: "print" };

export function Message({ kind, text, onGotoLine }) {
  const line = lineOf(text);
  return (
    <div className={`msg msg-${kind}`}>
      <span className="msg-tag">{LABELS[kind]}</span>
      {kind === "output" ? <pre>{text.replace(/\n$/, "")}</pre> : <span className="msg-text">{text}</span>}
      {line && onGotoLine && <button className="msg-line" onClick={() => onGotoLine(line)}>line {line} →</button>}
    </div>
  );
}

function Meter({ n, max, kind, title }) {
  return (
    <span className={`meter meter-${kind}`} title={title}>
      {Array.from({ length: Math.max(max, n) }, (_, i) => <i key={i} className={i < n ? "on" : ""} />)}
    </span>
  );
}

function PlayerCell({ requested, action, state, cfg, damage }) {
  return (
    <div className="pcell">
      <div className="pcell-move">
        {action ? <span className={`move move-${action}`}>{action}</span> : <span className="move move-none">start</span>}
        {action === "FUMBLE" && requested != null && <span className="requested">tried {String(requested)}</span>}
        {damage > 0 && <span className="dmg">−{damage} HP</span>}
      </div>
      <div className="pcell-stats">
        <Meter n={state.hp} max={cfg.start_hp} kind="hp" title={`HP ${state.hp}`} />
        <Meter n={state.ammo} max={cfg.max_ammo} kind="ammo" title={`Ammo ${state.ammo}`} />
        <Meter n={state.shields} max={cfg.shield_charges} kind="shield" title={`Shield charges ${state.shields}`} />
      </div>
    </div>
  );
}

function describe(ev) {
  const d = ev.damage ? ` (−${ev.damage})` : "";
  if (ev.type === "hit") return ev.by === 0 ? `Your ${ev.action} hit${d}` : `Opponent's ${ev.action} hit you${d}`;
  if (ev.type === "blocked")
    return ev.by === 0 ? `Your ${ev.action} was stopped by their ${ev.with}` : `You stopped their ${ev.action} with ${ev.with}`;
  if (ev.type === "reflected")
    return ev.by === 0 ? `Your ${ev.action} bounced off their ${ev.with}${d}` : `You reflected their ${ev.action}${d}`;
  return "";
}

export default function Replay({ replay, source, onGotoLine, onReplaySame }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const cfg = replay.config.game;
  const { winner, reason } = replay.result;
  const outcome = winner === null ? "draw" : winner === 0 ? "win" : "loss";
  const turns = replay.turns;
  const crashes = turns.filter((t) => t.errors[0]);
  const fumbles = turns.filter((t) => t.actions[0] === "FUMBLE" && !t.errors[0]);
  const problemTurns = turns.filter((t) => t.errors[0] || t.actions[0] === "FUMBLE");
  const shown = onlyProblems ? problemTurns : turns;
  const start = { hp: cfg.start_hp, ammo: cfg.start_ammo, shields: cfg.shield_charges };
  const final = replay.result.final;

  return (
    <div className="replay">
      <div className={`verdict verdict-${outcome}`}>
        <div>
          <div className="verdict-word">{outcome === "win" ? "Victory" : outcome === "loss" ? "Defeat" : "Draw"}</div>
          <div className="verdict-meta">
            vs {prettyBot(replay.names[1])} · {reason} · {turns.length} turns
          </div>
        </div>
        <div className="verdict-score">
          <span>{final[0].hp}</span><i>HP</i><span className="faint">:</span><span>{final[1].hp}</span>
        </div>
      </div>
      <div className="verdict-bar">
        <span className="faint">
          Game #{replay.seed}{source === "server" ? " · played on the server" : ""}
        </span>
        <button className="btn btn-quiet btn-xs" onClick={onReplaySame} title="Same opponent, same random choices">
          <IconRepeat size={13} /> Replay this game
        </button>
      </div>

      {(crashes.length > 0 || fumbles.length > 0) && (
        <div className="diagnosis">
          {crashes.length > 0 && (
            <div>
              <div className="diagnosis-head">Your code crashed on {crashes.length} turn{crashes.length > 1 ? "s" : ""}, first on turn {crashes[0].turn}</div>
              <Message kind="error" text={crashes[0].errors[0]} onGotoLine={onGotoLine} />
            </div>
          )}
          {fumbles.length > 0 && (
            <div>
              <div className="diagnosis-head">
                {fumbles.length} fumble{fumbles.length > 1 ? "s" : ""}: moves that weren't allowed, so your bot did nothing. First on turn {fumbles[0].turn}
              </div>
              <Message kind="fumble" text={fumbles[0].fumbles[0]} />
            </div>
          )}
        </div>
      )}

      <div className="section-row">
        <span className="eyebrow">Turn by turn</span>
        <label className="switch-label">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Only problems ({problemTurns.length})
        </label>
      </div>

      <table className="turns">
        <thead>
          <tr><th /><th>You</th><th>Opponent</th></tr>
        </thead>
        <tbody>
          {!onlyProblems && (
            <tr className="turn-start">
              <td className="turn-n">0</td>
              <td><PlayerCell state={start} cfg={cfg} /></td>
              <td><PlayerCell state={start} cfg={cfg} /></td>
            </tr>
          )}
          {shown.map((t) => {
            const bad = t.errors[0] || t.actions[0] === "FUMBLE";
            const what = t.events.map(describe).filter(Boolean);
            const detail = what.length > 0 || t.errors[0] || t.fumbles[0] || t.output[0];
            return [
              <tr key={t.turn} className={`${bad ? "turn-bad" : ""} ${detail ? "has-detail" : ""}`}>
                <td className="turn-n">{t.turn}</td>
                {[0, 1].map((i) => (
                  <td key={i}>
                    <PlayerCell requested={t.requested[i]} action={t.actions[i]} state={t.state[i]} cfg={cfg} damage={t.damage[i]} />
                  </td>
                ))}
              </tr>,
              detail && (
                <tr key={`${t.turn}-d`} className={`turn-detail ${bad ? "turn-bad" : ""}`}>
                  <td />
                  <td colSpan={2}>
                    {what.length > 0 && <div className="events">{what.join(" · ")}</div>}
                    {t.errors[0] && <Message kind="error" text={t.errors[0]} onGotoLine={onGotoLine} />}
                    {!t.errors[0] && t.fumbles[0] && <Message kind="fumble" text={t.fumbles[0]} />}
                    {t.output[0] && <Message kind="output" text={t.output[0]} />}
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      {onlyProblems && problemTurns.length === 0 && <p className="muted center pad-y">No problems in this game.</p>}
    </div>
  );
}
