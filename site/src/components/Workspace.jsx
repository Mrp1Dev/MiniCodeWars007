// The participant's one screen: editor (pseudocode or Python) | pseudocode they cleaned | test & submit.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, storage } from "../api";
import { formatClock, useDebounced, useSecondsLeft } from "../hooks";
import { checkLocally, engineReady, EngineTimeout, testLocally, useEngineStatus } from "../local/engine";
import CodeEditor from "./CodeEditor";
import Replay, { prettyBot } from "./Replay";
import RulesDrawer from "./RulesDrawer";

const MAX_AI_CHARS = 2000; // server/ai.py MAX_PSEUDOCODE_CHARS
const PHASES = {
  registration: { label: "Warm-up", note: "Coding hasn't started yet. You can write, clean and test; submitting opens when coding starts." },
  coding: { label: "Coding", note: "" },
  locked: { label: "Time's up", note: "Submissions are closed. You can still test your bot." },
  tournament: { label: "Tournament", note: "The tournament is running. Watch the big screen!" },
};

const draftKey = (roll) => `mcw.draft.${roll}`;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sameCode = (a, b) => a.replace(/\s+$/gm, "").trim() === b.replace(/\s+$/gm, "").trim();
const timeOf = (unix) => new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function loadDraft(roll) {
  try {
    return JSON.parse(storage.get(draftKey(roll)) || "null");
  } catch {
    return null;
  }
}

// What the static check says about the editor contents.
function classify(code, problems) {
  if (!code.trim()) return "empty";
  if (problems === null) return "unknown";
  if (problems.length === 0) return "ok";
  if (/SyntaxError/.test(problems[0].message) && !/\bdef\s+play\b/.test(code)) return "pseudo";
  return "problems";
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, kind = "info") => {
    const id = Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6000);
  }, []);
  return [toasts, push];
}

export default function Workspace({ me, token, status, offline, refreshStatus, refreshMe, onSignOut, starter, houseBots, rules }) {
  const editor = useRef(null);
  const draft = useMemo(() => loadDraft(me.roll), [me.roll]);
  const initialDoc = useMemo(
    () => (draft && draft.code != null ? draft.code : me.entry ? me.entry.code : (starter && starter.pseudocode) || ""),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [code, setCode] = useState(initialDoc);
  const [pseudo, setPseudo] = useState(draft ? draft.pseudo : me.entry && me.entry.pseudocode ? { text: me.entry.pseudocode, at: me.entry.created_at * 1000 } : null);
  const [panelOpen, setPanelOpen] = useState(draft ? !!draft.panelOpen : false);
  const [panelWidth, setPanelWidth] = useState(draft && draft.panelWidth ? draft.panelWidth : 300);
  const [opponent, setOpponent] = useState((draft && draft.opponent) || "random_bot");

  const [problems, setProblems] = useState(null);
  const [cleaning, setCleaning] = useState(false);
  const [issues, setIssues] = useState([]);
  const [cleanError, setCleanError] = useState("");
  const [remaining, setRemaining] = useState(null);
  const [test, setTest] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [toasts, toast] = useToasts();

  const engine = useEngineStatus();
  const secondsLeft = useSecondsLeft(status);
  const phase = status ? status.phase : "registration";
  const canClean = ["registration", "coding"].includes(phase);
  const canTest = phase !== "tournament";
  const canSubmit = phase === "coding";
  const kind = classify(code, problems);

  // --- autosave (a refresh or a crashed browser mustn't lose their work) ---------------------
  useEffect(() => {
    const t = setTimeout(
      () => storage.set(draftKey(me.roll), JSON.stringify({ code, pseudo, panelOpen, panelWidth, opponent })),
      400,
    );
    return () => clearTimeout(t);
  }, [me.roll, code, pseudo, panelOpen, panelWidth, opponent]);

  // --- live static check: in the browser when Pyodide is ready, else on the server ------------
  const debouncedCode = useDebounced(code, engine.status === "ready" ? 500 : 1200);
  useEffect(() => {
    let cancelled = false;
    if (!debouncedCode.trim()) {
      setProblems([]);
      return;
    }
    const run = engineReady()
      ? checkLocally(debouncedCode)
      : api("/api/check", { body: { code: debouncedCode } }).then((r) => r.problems);
    run.then(
      (p) => !cancelled && setProblems(p),
      () => !cancelled && setProblems(null),
    );
    return () => { cancelled = true; };
  }, [debouncedCode, engine.status]);

  useEffect(() => {
    if (!editor.current) return;
    editor.current.setProblems(kind === "problems" ? problems : []);
  }, [kind, problems]);

  // --- clean with AI ------------------------------------------------------------------------
  async function clean() {
    const text = editor.current.getDoc();
    if (!text.trim()) return toast("Write something first: describe what your bot should do.", "error");
    if (text.length > MAX_AI_CHARS) return toast(`That's too long for the AI (${text.length} of ${MAX_AI_CHARS} characters). Make it shorter.`, "error");
    setCleaning(true);
    setIssues([]);
    setCleanError("");
    editor.current.clearQuotes();
    try {
      const r = await api("/api/clean", { body: { pseudocode: text } });
      setRemaining(r.remaining);
      if (r.status === "ok") {
        const current = editor.current.getDoc();
        if (current !== text && !window.confirm("You changed the editor while the AI was working. Replace it with the AI's code anyway? (Ctrl+Z undoes it.)")) return;
        if (sameCode(r.code, text)) {
          toast("Your code already looks right. The AI didn't need to change anything.", "ok");
        } else {
          editor.current.replaceDoc(r.code);
          setPseudo({ text, at: Date.now() });
          setPanelOpen(true);
          toast("Done! Your original text is on the right. Now press Test.", "ok");
        }
      } else if (r.status === "declined") {
        const found = editor.current.markQuotes(r.issues.map((i) => i.quote));
        setIssues(r.issues.map((i, n) => ({ ...i, found: found[n] })));
      } else {
        setCleanError(r.message || "The AI had a problem. Please try again.");
      }
    } catch (err) {
      setCleanError(err.message);
    } finally {
      setCleaning(false);
    }
  }

  function restorePseudo() {
    if (!pseudo) return;
    if (!sameCode(editor.current.getDoc(), pseudo.text) &&
        !window.confirm("Put your pseudocode back in the editor? It replaces what's there now (Ctrl+Z undoes it).")) return;
    editor.current.replaceDoc(pseudo.text);
    setIssues([]);
  }

  // --- test ---------------------------------------------------------------------------------
  async function runTest(seed = Math.floor(Math.random() * 1e9), opp = opponent) {
    if (kind === "pseudo") {
      setTest({ error: "The editor has pseudocode, not Python yet. Press ✨ Clean with AI first." });
      return;
    }
    if (kind === "empty") {
      setTest({ error: "The editor is empty. Write your bot first." });
      return;
    }
    const src = editor.current.getDoc();
    setTest((t) => ({ ...t, running: true, error: "", note: "" }));
    try {
      let replay = null;
      let source = "local";
      let note = "";
      if (engineReady()) {
        try {
          replay = await testLocally(src, opp, seed);
        } catch (e) {
          if (e instanceof EngineTimeout) {
            // The server can stop a single slow move, so its replay shows which turn got stuck.
            note = "Your bot got stuck (a loop that never ends?), so this game was played on the server, which stops slow moves. Look for “took longer than” below.";
          } else {
            console.warn("local test failed, using the server:", e);
          }
        }
      }
      if (!replay) {
        source = "server";
        replay = await api("/api/test", { body: { code: src, opponent: opp, seed } });
      }
      setTest({ replay, source, note });
    } catch (err) {
      setTest({ error: err.message });
    }
  }

  // --- submit -------------------------------------------------------------------------------
  async function submit() {
    if (kind === "pseudo") return toast("That's still pseudocode. Press ✨ Clean with AI first, then test it.", "error");
    if (kind === "empty") return toast("The editor is empty.", "error");
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const r = await api("/api/submit", { body: { code: editor.current.getDoc(), pseudocode: pseudo ? pseudo.text : null } });
      setSubmitResult(r);
      refreshMe();
    } catch (err) {
      setSubmitResult({ error: err.message });
      if (err.status === 403) refreshStatus();
    } finally {
      setSubmitting(false);
    }
  }

  function loadEntry() {
    if (!me.entry) return;
    if (!window.confirm("Replace the editor with your submitted code? (Ctrl+Z undoes it.)")) return;
    editor.current.replaceDoc(me.entry.code);
  }

  // --- the draggable divider between editor and pseudocode panel ------------------------------
  function startDrag(e) {
    const startX = e.clientX;
    const startW = panelWidth;
    const move = (ev) => setPanelWidth(clamp(startW - (ev.clientX - startX), 200, 640));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("dragging");
  }

  const phaseInfo = PHASES[phase] || { label: phase, note: "" };
  const urgent = secondsLeft !== null && secondsLeft < 120;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.png" alt="WnCC" />
          <span className="brand-name"><span className="accent">007</span> Code Wars</span>
        </div>
        <div className="topbar-mid">
          <span className={`phase phase-${phase}`}>{phaseInfo.label}</span>
          {secondsLeft !== null && (
            <span className={`clock ${urgent ? "clock-urgent" : ""}`} title="Time left to submit">
              {secondsLeft > 0 ? formatClock(secondsLeft) : "0:00"}
            </span>
          )}
        </div>
        <div className="topbar-right">
          <span className={`engine engine-${engine.status}`} title={engine.status === "failed" ? engine.error : ""}>
            {engine.status === "ready" ? "● Tests run on your laptop" : engine.status === "failed" ? "● Tests run on the server" : "◌ Loading local tester…"}
          </span>
          <button className="btn btn-ghost" onClick={() => setRulesOpen(true)}>📖 Rules & help</button>
          <div className="menu">
            <button className="btn btn-ghost" onClick={() => setMenuOpen((o) => !o)}>
              {me.name} <span className="faint">{me.roll}</span> ▾
            </button>
            {menuOpen && (
              <div className="menu-pop" onMouseLeave={() => setMenuOpen(false)}>
                <div className="small muted">Your token: you need it to continue on another laptop or browser.</div>
                <div className="token-row">
                  <code>{showToken ? token : "•".repeat(12)}</code>
                  <button className="btn btn-small" onClick={() => setShowToken((s) => !s)}>{showToken ? "hide" : "show"}</button>
                  <button className="btn btn-small" onClick={() => navigator.clipboard && navigator.clipboard.writeText(token).then(() => toast("Token copied.", "ok"))}>copy</button>
                </div>
                <button className="btn btn-small btn-danger" onClick={() => {
                  if (window.confirm("Sign out? Write down your token first: you need it to come back.")) onSignOut();
                }}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {status && status.announcement && <div className="banner">📢 {status.announcement}</div>}
      {offline && <div className="banner banner-warn">Can't reach the server right now. Your work is saved in this browser; {engine.status === "ready" ? "testing still works." : "we'll keep trying."}</div>}
      {phaseInfo.note && <div className="phase-note">{phaseInfo.note}</div>}

      <main className="workspace">
        {/* ---------------- editor ---------------- */}
        <section className="pane editor-pane">
          <div className="pane-head">
            <h2>Your bot</h2>
            <span className="muted small">Write pseudocode or Python, then press ✨ Clean with AI</span>
          </div>
          <div className="editor-wrap">
            <CodeEditor ref={editor} initialDoc={initialDoc} onChange={setCode} />
          </div>

          {issues.length > 0 && (
            <div className="issues">
              <div className="issues-title">The AI couldn't translate {issues.length === 1 ? "this part" : "these parts"}. Change {issues.length === 1 ? "it" : "them"} and try again:</div>
              {issues.map((i, n) => (
                <div key={n} className="issue">
                  {i.quote ? (
                    <button className="issue-quote" onClick={() => editor.current.selectQuote(i.quote)} disabled={!i.found} title={i.found ? "Show in editor" : ""}>
                      “{i.quote}”
                    </button>
                  ) : null}
                  <span>{i.reason}</span>
                </div>
              ))}
            </div>
          )}
          {cleanError && <div className="alert alert-error">{cleanError}</div>}

          <div className="editor-foot">
            <CheckStatus kind={kind} problems={problems} onGotoLine={(l) => editor.current.gotoLine(l)} />
            <div className="foot-actions">
              <span className={`counter ${code.length > MAX_AI_CHARS ? "over" : ""}`} title="The AI reads up to 2000 characters">
                {code.length}/{MAX_AI_CHARS}
              </span>
              {remaining !== null && remaining <= 10 && <span className="counter over">{remaining} AI uses left</span>}
              <button className="btn btn-ai" onClick={clean} disabled={!canClean || cleaning || code.length > MAX_AI_CHARS}
                title={canClean ? "Turn your pseudocode into Python" : "The AI is closed in this phase"}>
                {cleaning ? <><span className="spinner" /> Cleaning… (up to 20 s)</> : "✨ Clean with AI"}
              </button>
            </div>
          </div>
        </section>

        {/* ---------------- pseudocode they cleaned ---------------- */}
        {panelOpen && <div className="divider" onPointerDown={startDrag} title="Drag to resize" />}
        {panelOpen ? (
          <aside className="pane pseudo-pane" style={{ width: panelWidth }}>
            <div className="pane-head">
              <h2>What you wrote</h2>
              <button className="btn btn-ghost btn-small" onClick={() => setPanelOpen(false)} title="Hide">⟩</button>
            </div>
            {pseudo ? (
              <>
                <div className="small muted pad">Before your last clean, at {new Date(pseudo.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                <pre className="pseudo-text">{pseudo.text}</pre>
                <div className="pad">
                  <button className="btn btn-small" onClick={restorePseudo}>↩ Put back in the editor</button>
                </div>
              </>
            ) : (
              <p className="muted pad small">When you press ✨ Clean with AI, what you wrote shows up here, so you can compare it with the Python.</p>
            )}
          </aside>
        ) : (
          <button className="pseudo-tab" onClick={() => setPanelOpen(true)} title="Show what you wrote before cleaning">
            <span>What you wrote</span>
          </button>
        )}

        {/* ---------------- test & submit ---------------- */}
        <section className="pane test-pane">
          <div className="entry-card">
            <div>
              <div className="small muted">Your tournament entry</div>
              {me.entry ? (
                <div className="entry-line">
                  <span className={`badge badge-${me.entry.status}`}>{me.entry.status === "ok" ? "✓ OK" : "⚠ runs, with crashes"}</span>
                  submission #{me.entry.id} · {timeOf(me.entry.created_at)}
                  <button className="link" onClick={loadEntry}>open</button>
                </div>
              ) : (
                <div className="entry-line muted">Nothing submitted yet</div>
              )}
            </div>
            <button className="btn btn-primary" onClick={submit} disabled={!canSubmit || submitting}
              title={canSubmit ? "Submit the code in the editor" : phase === "registration" ? "Submitting opens when coding starts" : "Submissions are closed"}>
              {submitting ? <><span className="spinner" /> Checking…</> : "🚀 Submit"}
            </button>
          </div>
          {submitResult && <SubmitResult result={submitResult} onGotoLine={(l) => editor.current.gotoLine(l)} onClose={() => setSubmitResult(null)} />}

          <div className="test-controls">
            <h2>Test</h2>
            <select value={opponent} onChange={(e) => setOpponent(e.target.value)} aria-label="Opponent">
              {houseBots.map((b) => <option key={b.name} value={b.name}>vs {prettyBot(b.name)}</option>)}
              <option value="mirror">vs your own bot</option>
            </select>
            <button className="btn btn-test" onClick={() => runTest()} disabled={!canTest || test.running}>
              {test.running ? <><span className="spinner" /> Playing…</> : "▶ Test"}
            </button>
          </div>
          {houseBots.find((b) => b.name === opponent) && (
            <div className="small muted opp-desc">{houseBots.find((b) => b.name === opponent).description}</div>
          )}

          <div className="results">
            {test.error && <div className="alert alert-error">{test.error}</div>}
            {test.note && <div className="alert alert-error">{test.note}</div>}
            {test.replay ? (
              <Replay
                replay={test.replay}
                source={test.source}
                onGotoLine={(l) => editor.current.gotoLine(l)}
                onReplaySame={() => runTest(test.replay.seed, test.replay.names[1])}
              />
            ) : (
              !test.error && (
                <div className="empty-state">
                  <div className="empty-icon">🎯</div>
                  <p>Pick an opponent and press <b>Test</b> to play a practice game.</p>
                  <p className="small muted">You'll see every turn: what each bot did, HP, ammo, and where your code went wrong.</p>
                </div>
              )
            )}
          </div>
        </section>
      </main>

      <RulesDrawer open={rulesOpen} onClose={() => setRulesOpen(false)} rules={rules} houseBots={houseBots} />

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

function CheckStatus({ kind, problems, onGotoLine }) {
  if (kind === "empty") return <div className="checkline muted">Empty. Describe your bot, e.g. “if I have no ammo, reload”.</div>;
  if (kind === "unknown") return <div className="checkline muted">…</div>;
  if (kind === "pseudo") return <div className="checkline check-info">✎ This is pseudocode. Press ✨ Clean with AI to turn it into Python.</div>;
  if (kind === "ok") return <div className="checkline check-ok">✓ Valid Python. Press ▶ Test.</div>;
  const p = problems[0];
  return (
    <div className="checkline check-bad">
      ✗ {p.line ? <button className="link" onClick={() => onGotoLine(p.line)}>line {p.line}</button> : null} {p.message}
      {problems.length > 1 && <span className="faint"> (+{problems.length - 1} more)</span>}
    </div>
  );
}

function SubmitResult({ result, onGotoLine, onClose }) {
  if (result.error) {
    return (
      <div className="submit-result submit-rejected">
        <button className="close" onClick={onClose}>✕</button>
        <b>Couldn't submit.</b> {result.error}
      </div>
    );
  }
  const { status, report, id, entry_id } = result;
  return (
    <div className={`submit-result submit-${status}`}>
      <button className="close" onClick={onClose}>✕</button>
      {status === "ok" && <b>🎉 Submitted! Submission #{id} is now your tournament entry.</b>}
      {status === "warning" && <b>Submitted as #{id}, and it's your entry now, but your code crashed during the checks. Fix it and submit again if you can.</b>}
      {status === "rejected" && (
        <b>Not accepted: this code can't run. {entry_id ? `Your earlier submission #${entry_id} is still your entry.` : "You don't have an entry yet."}</b>
      )}
      {report.problems.map((p, i) => (
        <div key={i} className="msg msg-error">
          {p.line && <button className="link" onClick={() => onGotoLine(p.line)}>line {p.line}</button>} {p.message}
        </div>
      ))}
      {report.matches.length > 0 && (
        <ul className="check-matches">
          {report.matches.map((m) => (
            <li key={m.opponent}>
              <span className={`badge badge-${m.outcome}`}>{m.outcome}</span> vs {prettyBot(m.opponent)}
              {m.crashes > 0 && <span className="msg-inline error"> · crashed: {m.first_error}</span>}
              {m.fumbles > 0 && <span className="msg-inline"> · {m.fumbles} fumble{m.fumbles > 1 ? "s" : ""}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
