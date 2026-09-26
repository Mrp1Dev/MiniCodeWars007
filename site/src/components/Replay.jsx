// Turn-by-turn result of one test match. Errors, fumbles and print() output come first:
// that's how beginners debug. (The animated visualiser will read the same replay format.)
import { useState } from "react";

export const prettyBot = (name) => (name === "mirror" ? "your own bot" : name.replace(/_/g, " "));

// "line 5: NameError: ..." -> 5
const lineOf = (msg) => {
  const m = /^line (\d+):/.exec(msg || "");
  return m ? Number(m[1]) : null;
};

function Message({ kind, text, onGotoLine }) {
  const line = lineOf(text);
  return (
    <div className={`msg msg-${kind}`}>
      <span className="msg-label">{kind === "error" ? "Crashed" : kind === "fumble" ? "Fumble" : "print"}</span>
      {kind === "output" ? <pre>{text.replace(/\n$/, "")}</pre> : <span>{text}</span>}
      {line && onGotoLine && (
        <button className="link" onClick={() => onGotoLine(line)}>show line {line}</button>
      )}
    </div>
  );
}

function Pips({ n, max, full, empty, className }) {
  return (
    <span className={`pips ${className}`} title={`${n} of ${max}`}>
      {Array.from({ length: Math.max(max, n) }, (_, i) => (i < n ? full : empty)).join("")}
    </span>
  );
}

function PlayerCell({ requested, action, state, cfg, damage }) {
  const fumbled = action === "FUMBLE";
  return (
    <div className="pcell">
      <div className="pcell-move">
        <span className={`move move-${action}`}>{action}</span>
        {fumbled && requested != null && <span className="requested" title="what the bot returned">wanted {String(requested)}</span>}
        {damage > 0 && <span className="dmg">−{damage}</span>}
      </div>
      <div className="pcell-stats">
        <Pips n={state.hp} max={cfg.start_hp} full="♥" empty="♡" className="hp" />
        <Pips n={state.ammo} max={cfg.max_ammo} full="●" empty="○" className="ammo" />
        <span className="shields" title="shield charges">🛡{state.shields}</span>
      </div>
    </div>
  );
}

function describe(ev, opp) {
  const d = ev.damage ? ` (−${ev.damage})` : "";
  if (ev.type === "hit") return ev.by === 0 ? `Your ${ev.action} hit${d}` : `${opp}'s ${ev.action} hit you${d}`;
  if (ev.type === "blocked")
    return ev.by === 0 ? `Your ${ev.action} was stopped by their ${ev.with}` : `You stopped their ${ev.action} with ${ev.with}`;
  if (ev.type === "reflected")
    return ev.by === 0 ? `Your ${ev.action} bounced off their ${ev.with}${d}` : `You reflected their ${ev.action}${d}`;
  return "";
}

export default function Replay({ replay, source, onGotoLine, onReplaySame }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const cfg = replay.config.game;
  const opp = prettyBot(replay.names[1]);
  const { winner, reason } = replay.result;
  const outcome = winner === null ? "draw" : winner === 0 ? "win" : "loss";
  const turns = replay.turns;
  const crashes = turns.filter((t) => t.errors[0]);
  const fumbles = turns.filter((t) => t.actions[0] === "FUMBLE" && !t.errors[0]);
  const problemTurns = turns.filter((t) => t.errors[0] || t.actions[0] === "FUMBLE");
  const shown = onlyProblems ? problemTurns : turns;
  const start = { hp: cfg.start_hp, ammo: cfg.start_ammo, shields: cfg.shield_charges };

  return (
    <div className="replay">
      <div className={`verdict verdict-${outcome}`}>
        <div className="verdict-big">{outcome === "win" ? "You win" : outcome === "loss" ? "You lose" : "Draw"}</div>
        <div className="verdict-small">
          vs {opp} · {reason} · {turns.length} turns
          <span className="faint"> · game #{replay.seed}{source === "server" ? " · ran on server" : ""}</span>
        </div>
        <div className="verdict-actions">
          <button className="btn btn-small" onClick={onReplaySame} title="Same opponent, same random numbers">
            ↻ Same game again
          </button>
        </div>
      </div>

      {(crashes.length > 0 || fumbles.length > 0) && (
        <div className="problems">
          {crashes.length > 0 && (
            <div>
              <b>Your code crashed on {crashes.length} turn{crashes.length > 1 ? "s" : ""}.</b> First time, turn{" "}
              {crashes[0].turn}:
              <Message kind="error" text={crashes[0].errors[0]} onGotoLine={onGotoLine} />
            </div>
          )}
          {fumbles.length > 0 && (
            <div>
              <b>{fumbles.length} fumble{fumbles.length > 1 ? "s" : ""}</b> (moves that weren't allowed, so you did nothing). First
              one, turn {fumbles[0].turn}:
              <Message kind="fumble" text={fumbles[0].fumbles[0]} />
            </div>
          )}
        </div>
      )}

      <div className="turns-head">
        <span>Turn by turn</span>
        <label className="check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          only turns with problems ({problemTurns.length})
        </label>
      </div>

      <table className="turns">
        <thead>
          <tr>
            <th>#</th>
            <th>You</th>
            <th>{opp}</th>
          </tr>
        </thead>
        <tbody>
          {!onlyProblems && (
            <tr className="turn-start">
              <td>start</td>
              <td>
                <PlayerCell action="—" state={start} cfg={cfg} />
              </td>
              <td>
                <PlayerCell action="—" state={start} cfg={cfg} />
              </td>
            </tr>
          )}
          {shown.map((t) => {
            const bad = t.errors[0] || t.actions[0] === "FUMBLE";
            const what = t.events.map((e) => describe(e, opp)).filter(Boolean);
            return [
              <tr key={t.turn} className={bad ? "turn-bad" : ""}>
                <td className="turn-n">{t.turn}</td>
                {[0, 1].map((i) => (
                  <td key={i}>
                    <PlayerCell requested={t.requested[i]} action={t.actions[i]} state={t.state[i]} cfg={cfg} damage={t.damage[i]} />
                  </td>
                ))}
              </tr>,
              (what.length > 0 || t.errors[0] || t.fumbles[0] || t.output[0]) && (
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
      {onlyProblems && problemTurns.length === 0 && <p className="muted center">No problems. Nice!</p>}
    </div>
  );
}
