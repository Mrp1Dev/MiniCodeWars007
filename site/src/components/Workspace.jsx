// The participant's one screen: code editor | history of AI cleans | practice matches.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, storage } from "../api";
import { formatClock, useDebounced, useSecondsLeft } from "../hooks";
import { checkLocally, engineReady, EngineTimeout, testLocally, useEngineStatus } from "../local/engine";
import CodeEditor from "./CodeEditor";
import Replay, { Message, prettyBot } from "./Replay";
import RulesDrawer from "./RulesDrawer";
import {
  Barrel, IconAlert, IconBook, IconCheck, IconChevron, IconClose, IconCode, IconHistory, IconMegaphone,
  IconPlay, IconRedo, IconSend, IconSpark, IconUndo, IconUser,
} from "./icons";

const MAX_AI_CHARS = 2000; // server/ai.py MAX_PSEUDOCODE_CHARS
const MAX_HISTORY = 60;
const PHASES = {
  registration: { label: "Warm-up", note: "Coding hasn't started yet. Write and test all you like; submitting opens when coding starts." },
  coding: { label: "Live", note: "" },
  locked: { label: "Time's up", note: "Submissions are closed. You can still run practice matches." },
  tournament: { label: "Tournament", note: "The tournament is live! Follow your bot in the arena." },
};
const STATUS_LABEL = { ok: "Cleaned", same: "No changes", declined: "Needs changes", error: "AI error" };

const draftKey = (roll) => `mcw.draft.${roll}`;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sameCode = (a, b) => a.replace(/\s+$/gm, "").trim() === b.replace(/\s+$/gm, "").trim();
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const firstLine = (text) => (text.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) || text).trim();

export function stripStarterComments(text, starterComments) {
  if (!text) return "";
  let clean = text.replace(/\r\n/g, "\n");
  const normStarter = (starterComments || "").replace(/\r\n/g, "\n").trim();
  if (normStarter && clean.includes(normStarter)) {
    return clean.replace(normStarter, "").trim();
  }
  if (clean.includes("play() is called") || clean.includes("Write your bot")) {
    const playIdx = clean.indexOf("def play");
    if (playIdx !== -1) {
      const beforePlay = clean.slice(0, playIdx);
      if (beforePlay.includes("play() is called") || beforePlay.includes("Write your bot")) {
        return clean.slice(playIdx).trim();
      }
    }
    const marker = "opp.history[-1]";
    const mIdx = clean.indexOf(marker);
    if (mIdx !== -1) {
      const lineEnd = clean.indexOf("\n", mIdx);
      if (lineEnd !== -1) {
        return clean.slice(lineEnd + 1).trim();
      }
    }
    const lines = clean.split("\n");
    let i = 0;
    while (i < lines.length && (lines[i].trim().startsWith("#") || lines[i].trim() === "")) {
      i++;
    }
    const header = lines.slice(0, i).join("\n");
    if (header.includes("play() is called") || header.includes("Write your bot")) {
      return lines.slice(i).join("\n").trim();
    }
  }
  return clean.trim();
}

function loadDraft(roll) {
  try {
    const d = JSON.parse(storage.get(draftKey(roll)) || "null");
    if (d && !d.history && d.pseudo) d.history = [{ id: 1, at: d.pseudo.at, input: d.pseudo.text, status: "ok", code: "" }];
    return d;
  } catch {
    return null;
  }
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, kind = "info") => {
    const id = Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5000);
  }, []);
  return [toasts, push];
}

// Static check: in the browser once Pyodide is ready, otherwise on the server.
const checkCode = (code) =>
  engineReady() ? checkLocally(code) : api("/api/check", { body: { code } }).then((r) => r.problems);

export default function Workspace({ me, status, offline, refreshStatus, refreshMe, onSignOut, starter, houseBots, rules }) {
  const editor = useRef(null);
  const draft = useMemo(() => loadDraft(me.roll), [me.roll]);
  const initialDoc = useMemo(
    () => (draft && draft.code != null ? draft.code : me.entry ? me.entry.code : starter.code),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [code, setCode] = useState(initialDoc);
  const [history, setHistory] = useState((draft && draft.history) || []);
  const [selectedId, setSelectedId] = useState(null);
  const [panelOpen, setPanelOpen] = useState(draft ? draft.panelOpen !== false : true);
  const [panelWidth, setPanelWidth] = useState((draft && draft.panelWidth) || 290);
  const [syntaxCheck, setSyntaxCheck] = useState(!!(draft && draft.syntaxCheck));
  const [opponent, setOpponent] = useState((draft && draft.opponent) || "random_bot");

  const [canUndo, setCanUndo] = useState({ undo: false, redo: false });
  const [problems, setProblems] = useState([]);
  const [cleaning, setCleaning] = useState(false);
  const [issues, setIssues] = useState([]);
  const [cleanError, setCleanError] = useState("");
  const [remaining, setRemaining] = useState(null);
  const [test, setTest] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toasts, toast] = useToasts();

  const engine = useEngineStatus();
  const secondsLeft = useSecondsLeft(status);
  const phase = status ? status.phase : "registration";
  const canClean = ["registration", "coding"].includes(phase);
  const canTest = phase !== "tournament";
  const canSubmit = phase === "coding";

  // --- autosave: a refresh or a crashed browser mustn't lose anything -------------------------
  useEffect(() => {
    const t = setTimeout(() => storage.set(draftKey(me.roll),
      JSON.stringify({ code, history, panelOpen, panelWidth, opponent, syntaxCheck })), 400);
    return () => clearTimeout(t);
  }, [me.roll, code, history, panelOpen, panelWidth, opponent, syntaxCheck]);

  // --- live syntax check, only when switched on (pseudocode would be all red otherwise) --------
  const debouncedCode = useDebounced(code, engine.status === "ready" ? 500 : 1200);
  useEffect(() => {
    if (!syntaxCheck || !debouncedCode.trim()) {
      setProblems([]);
      return;
    }
    let cancelled = false;
    checkCode(debouncedCode).then((p) => !cancelled && setProblems(p), () => {});
    return () => { cancelled = true; };
  }, [debouncedCode, syntaxCheck, engine.status]);

  useEffect(() => {
    if (editor.current) editor.current.setProblems(syntaxCheck ? problems : []);
  }, [problems, syntaxCheck]);

  const starterComments = useMemo(() => {
    if (!starter || !starter.code) return "";
    const idx = starter.code.indexOf("def play");
    return idx !== -1 ? starter.code.slice(0, idx).trim() : "";
  }, [starter]);

  const strippedCode = useMemo(() => stripStarterComments(code, starterComments), [code, starterComments]);
  const effectiveLength = strippedCode.length;

  // --- clean with AI ------------------------------------------------------------------------
  async function clean() {
    const text = editor.current.getDoc();
    if (!text.trim()) return toast("Write something first: your bot's rules, in Python or plain English.", "bad");

    // Don't send starter comments to the LLM (saves characters and prompt tokens)
    const textToSend = stripStarterComments(text, starterComments);

    if (!textToSend.trim()) {
      return toast("Write your bot's rules in Python or plain English below the comments.", "bad");
    }
    if (textToSend.length > MAX_AI_CHARS) {
      return toast(`Too long for the AI: ${textToSend.length} of ${MAX_AI_CHARS} characters.`, "bad");
    }

    setCleaning(true);
    setIssues([]);
    setCleanError("");
    editor.current.clearQuotes();
    try {
      const r = await api("/api/clean", { body: { pseudocode: textToSend } });
      setRemaining(r.remaining);

      // Attach starter comments back to the LLM's response
      let finalCode = r.code || "";
      const commentsToAttach = starterComments || (starter && starter.code ? starter.code.split("def play")[0].trim() : "");
      if (r.status === "ok" && commentsToAttach) {
        const normFinal = finalCode.replace(/\r\n/g, "\n");
        const normComments = commentsToAttach.replace(/\r\n/g, "\n").trim();
        if (!normFinal.startsWith(normComments)) {
          finalCode = `${normComments}\n\n${normFinal.trimStart()}`;
        }
      }

      const same = r.status === "ok" && sameCode(finalCode, text);
      const entry = {
        id: Date.now(), at: Date.now(), input: text, status: same ? "same" : r.status,
        code: finalCode, issues: r.issues || [], message: r.message || "",
      };
      setHistory((h) => [entry, ...h].slice(0, MAX_HISTORY));
      setSelectedId(entry.id);
      if (r.status === "ok") {
        if (same) {
          toast("Looks right already. The AI didn't change anything.", "ok");
        } else {
          editor.current.replaceDoc(finalCode);
          setPanelOpen(true);
          toast("Cleaned. Ctrl+Z brings back what you wrote.", "ok");
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

  function openInEditor(text) {
    editor.current.replaceDoc(text); // an undo step of its own
    editor.current.focus();
    setIssues([]);
  }

  // --- checks before running or submitting ----------------------------------------------------
  async function preflight(src) {
    if (!src.trim()) return [{ line: null, message: "The editor is empty." }];
    try {
      return await checkCode(src);
    } catch {
      return []; // can't check; let the match or the server report it
    }
  }

  // --- practice match -------------------------------------------------------------------------
  async function runTest(seed = Math.floor(Math.random() * 1e9), opp = opponent) {
    const src = editor.current.getDoc();
    setTest((t) => ({ ...t, running: true, error: null, note: "" }));
    const found = await preflight(src);
    if (found.length) {
      setTest({ error: { problems: found } });
      return;
    }
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
            note = "Your bot got stuck (a loop that never ends?), so this game was replayed on the server, which stops slow moves. Look for “took longer than” below.";
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
      setTest({ error: { message: err.message } });
    }
  }

  const runRef = useRef(runTest);
  runRef.current = runTest;
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.defaultPrevented) {
        e.preventDefault();
        if (canTest) runRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canTest]);

  // --- submit ---------------------------------------------------------------------------------
  async function submit() {
    const src = editor.current.getDoc();
    setSubmitting(true);
    setSubmitResult(null);
    const found = await preflight(src);
    if (found.length) {
      setSubmitting(false);
      setSubmitResult({ local: true, problems: found });
      return;
    }
    const cleaned = history.find((h) => h.status === "ok" || h.status === "same");
    try {
      const r = await api("/api/submit", { body: { code: src, pseudocode: cleaned ? cleaned.input : null } });
      setSubmitResult(r);
      refreshMe();
    } catch (err) {
      setSubmitResult({ error: err.message });
      if (err.status === 403) refreshStatus();
    } finally {
      setSubmitting(false);
    }
  }

  // --- the draggable divider in front of the history panel -----------------------------------
  function startDrag(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const move = (ev) => setPanelWidth(clamp(startW - (ev.clientX - startX), 220, 560));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("dragging");
  }

  const gotoLine = (l) => editor.current.gotoLine(l);
  const phaseInfo = PHASES[phase] || { label: phase, note: "" };
  const urgent = secondsLeft !== null && secondsLeft < 120;
  const selected = history.find((h) => h.id === selectedId) || history[0];
  const oppInfo = houseBots.find((b) => b.name === opponent);

  return (
    <div className="app">
      {/* ================= top bar ================= */}
      <header className="topbar">
        <div className="brand">
          <img src="/logo.png" alt="WnCC" />
          <span className="brand-sep" />
          <span className="brand-007">007</span>
          <span className="brand-name">Code Wars</span>
        </div>

        <div className="mission">
          <span className={`phase phase-${phase}`}><i />{phaseInfo.label}</span>
          {secondsLeft !== null && (
            <span className={`timer ${urgent ? "timer-urgent" : ""}`} title="Time left to submit">
              {formatClock(secondsLeft)}
            </span>
          )}
        </div>

        <div className="topbar-right">
          <button className="entry" onClick={() => me.entry && openInEditor(me.entry.code)} disabled={!me.entry}
            title={me.entry ? "Open your submitted code in the editor" : "You haven't submitted yet"}>
            <span className={`dot dot-${me.entry ? me.entry.status : "none"}`} />
            <span className="entry-text">
              <small>Tournament entry</small>
              {me.entry ? `#${me.entry.id} · ${clock(me.entry.created_at * 1000)}` : "None yet"}
            </span>
          </button>
          <button className="btn btn-gold" onClick={submit} disabled={!canSubmit || submitting}
            title={canSubmit ? "Submit the code in the editor" : phase === "registration" ? "Submitting opens when coding starts" : "Submissions are closed"}>
            {submitting ? <span className="spinner" /> : <IconSend />} {submitting ? "Checking" : "Submit"}
          </button>
          <span className="topbar-rule" />
          <button className="icon-btn" onClick={() => setRulesOpen(true)} title="Rules & help"><IconBook size={18} /></button>
          <div className="menu">
            <button className="user" onClick={() => setMenuOpen((o) => !o)}>
              <IconUser size={15} /> <span>{me.name}</span>
            </button>
            {menuOpen && (
              <div className="menu-pop" onMouseLeave={() => setMenuOpen(false)}>
                <div className="menu-id">
                  <b>{me.name}</b>
                  <span>{me.bot_name ? `${me.bot_name} · ` : ""}{me.roll}</span>
                </div>
                <button className="menu-item" onClick={onSignOut}>Sign out</button>
              </div>
            )}
          </div>
        </div>

        {submitResult && (
          <SubmitResult result={submitResult} onGotoLine={gotoLine} onClose={() => setSubmitResult(null)} />
        )}
      </header>

      {status && status.announcement && (
        <div className="announce"><IconMegaphone /> <span>{status.announcement}</span></div>
      )}
      {offline && (
        <div className="announce announce-bad">
          <IconAlert /> Can't reach the server. Your work is saved in this browser{engine.status === "ready" ? ", and practice matches still work." : "."}
        </div>
      )}
      {phaseInfo.note && <div className="phase-note">{phaseInfo.note}</div>}

      {/* ================= workspace ================= */}
      <main className="stage">
        <section className="col col-editor">
          <div className="toolbar">
            <div className="file-tab"><IconCode size={14} /> bot.py</div>
            <div className="tool-group">
              <button className="icon-btn" onClick={() => editor.current.undo()} disabled={!canUndo.undo} title="Undo (Ctrl+Z)"><IconUndo /></button>
              <button className="icon-btn" onClick={() => editor.current.redo()} disabled={!canUndo.redo} title="Redo (Ctrl+Y)"><IconRedo /></button>
            </div>
            <div className="grow" />
            <label className="toggle" title="Underline Python errors as you type">
              <input type="checkbox" checked={syntaxCheck} onChange={(e) => setSyntaxCheck(e.target.checked)} />
              <span className="toggle-track"><span /></span>
              Syntax check
            </label>
            <button className={`btn btn-ai ${cleaning ? "is-busy" : ""}`} onClick={clean}
              disabled={!canClean || cleaning || effectiveLength > MAX_AI_CHARS}
              title={canClean ? "Turn plain English into Python, or fix small Python slips" : "The AI is closed in this phase"}>
              {cleaning ? <span className="spinner" /> : <IconSpark />}
              {cleaning ? "Cleaning" : "Clean with AI"}
            </button>
          </div>

          <div className="editor-wrap">
            <CodeEditor ref={editor} initialDoc={initialDoc} onChange={setCode} onHistory={setCanUndo}
              onRun={() => canTest && runRef.current()} />
          </div>

          {issues.length > 0 && (
            <div className="issues">
              <div className="issues-head">
                <IconAlert /> The AI couldn't translate {issues.length === 1 ? "this part" : "these parts"}. Change {issues.length === 1 ? "it" : "them"} and clean again.
                <button className="icon-btn icon-btn-sm" onClick={() => { setIssues([]); editor.current.clearQuotes(); }} title="Dismiss"><IconClose size={14} /></button>
              </div>
              {issues.map((i, n) => (
                <div key={n} className="issue">
                  {i.quote && (
                    <button className="issue-quote" onClick={() => editor.current.selectQuote(i.quote)} disabled={!i.found}>
                      “{i.quote}”
                    </button>
                  )}
                  <span>{i.reason}</span>
                </div>
              ))}
            </div>
          )}
          {cleanError && (
            <div className="issues">
              <div className="issues-head">
                <IconAlert /> {cleanError}
                <button className="icon-btn icon-btn-sm" onClick={() => setCleanError("")} title="Dismiss"><IconClose size={14} /></button>
              </div>
            </div>
          )}

          <div className="statusbar">
            <SyntaxStatus on={syntaxCheck} problems={problems} code={code} onGotoLine={gotoLine} />
            <div className="grow" />
            {remaining !== null && remaining <= 10 && <span className="warn">{remaining} AI cleans left</span>}
            <span className={effectiveLength > MAX_AI_CHARS ? "warn" : ""} title="The AI reads up to 2000 characters (starter comments excluded)">
              {effectiveLength} / {MAX_AI_CHARS}
            </span>
            <span>Python</span>
          </div>
        </section>

        {/* ---------- history of cleans ---------- */}
        {panelOpen ? (
          <>
            <div className="divider" onPointerDown={startDrag} title="Drag to resize" />
            <aside className="col col-history" style={{ width: panelWidth }}>
              <div className="toolbar">
                <span className="eyebrow"><IconHistory size={14} /> History</span>
                <span className="count">{history.length}</span>
                <div className="grow" />
                <button className="icon-btn" onClick={() => setPanelOpen(false)} title="Hide history"><IconChevron /></button>
              </div>
              {history.length === 0 ? (
                <div className="history-empty">
                  <p>Every time you press <b>Clean with AI</b>, what you wrote and what came back is saved here.</p>
                  <p className="faint">Open any version in the editor. It's one undo step, so you can always go back.</p>
                </div>
              ) : (
                <>
                  <ol className="history-list">
                    {history.map((h, n) => (
                      <li key={h.id}>
                        <button className={`hist ${selected && selected.id === h.id ? "active" : ""}`} onClick={() => setSelectedId(h.id)}>
                          <span className="hist-top">
                            <span className="hist-n">v{history.length - n}</span>
                            <span className={`hist-status hs-${h.status}`}>{STATUS_LABEL[h.status]}</span>
                            <span className="hist-time">{clock(h.at)}</span>
                          </span>
                          <span className="hist-line">{firstLine(h.input)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  {selected && <HistoryDetail key={selected.id} entry={selected} onOpen={openInEditor} />}
                </>
              )}
            </aside>
          </>
        ) : (
          <button className="rail" onClick={() => setPanelOpen(true)} title="Show history">
            <IconHistory size={15} />
            <span>History{history.length ? ` · ${history.length}` : ""}</span>
          </button>
        )}

        {/* ---------- practice ---------- */}
        <section className="col col-practice">
          <div className="toolbar">
            <span className="eyebrow">Practice</span>
            <div className="grow" />
            <span className={`runner runner-${engine.status}`} title={engine.status === "failed" ? engine.error : ""}>
              <i />{engine.status === "ready" ? "Runs on your laptop" : engine.status === "failed" ? "Runs on the server" : "Loading runner"}
            </span>
          </div>

          <div className="practice-controls">
            <div className="opponents" role="radiogroup" aria-label="Opponent">
              {[...houseBots.map((b) => b.name), "mirror"].map((name) => (
                <button key={name} role="radio" aria-checked={opponent === name}
                  className={`opp ${opponent === name ? "active" : ""}`} onClick={() => setOpponent(name)}>
                  {prettyBot(name)}
                </button>
              ))}
            </div>
            <p className="opp-desc">{oppInfo ? oppInfo.description : "Your bot plays against a copy of itself."}</p>
            <button className="btn btn-run" onClick={() => runTest()} disabled={!canTest || test.running}>
              {test.running ? <span className="spinner" /> : <IconPlay size={14} />}
              {test.running ? "Playing" : "Run match"}
              <kbd>Ctrl ↵</kbd>
            </button>
          </div>

          <div className="results">
            {test.error && test.error.problems && (
              <div className="callout callout-bad">
                <b>This can't run yet.</b>
                {test.error.problems.slice(0, 3).map((p, i) => (
                  <div key={i} className="problem">
                    {p.line && <button className="msg-line" onClick={() => gotoLine(p.line)}>line {p.line} →</button>} {p.message}
                  </div>
                ))}
                <span className="faint">If it's plain English, press Clean with AI first.</span>
              </div>
            )}
            {test.error && test.error.message && <div className="callout callout-bad">{test.error.message}</div>}
            {test.note && <div className="callout callout-warn">{test.note}</div>}
            {test.replay ? (
              <Replay replay={test.replay} source={test.source} onGotoLine={gotoLine}
                onReplaySame={() => runTest(test.replay.seed, test.replay.names[1])} />
            ) : (
              !test.error && (
                <div className="empty">
                  <Barrel size={64} />
                  <p>Pick an opponent and run a match.</p>
                  <p className="faint">Every turn shows up here: both moves, HP, ammo, and where your code went wrong.</p>
                </div>
              )
            )}
          </div>
        </section>
      </main>

      <RulesDrawer open={rulesOpen} onClose={() => setRulesOpen(false)} rules={rules} houseBots={houseBots} />

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === "ok" ? <IconCheck /> : t.kind === "bad" ? <IconAlert /> : null} {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryDetail({ entry, onOpen }) {
  const hasCode = entry.status === "ok" && entry.code;
  const [view, setView] = useState("input");
  const text = view === "code" && hasCode ? entry.code : entry.input;
  return (
    <div className="history-detail">
      <div className="seg">
        <button className={view === "input" ? "active" : ""} onClick={() => setView("input")}>You wrote</button>
        <button className={view === "code" ? "active" : ""} onClick={() => setView("code")} disabled={!hasCode}>AI code</button>
      </div>
      {entry.status === "declined" && view === "input" && (
        <ul className="hist-issues">
          {entry.issues.map((i, n) => <li key={n}>{i.quote && <q>{i.quote}</q>} {i.reason}</li>)}
        </ul>
      )}
      {entry.status === "error" && <div className="hist-issues">{entry.message}</div>}
      <pre className="history-text">{text}</pre>
      <button className="btn btn-quiet btn-sm btn-block" onClick={() => onOpen(text)}>
        Open {view === "code" && hasCode ? "AI code" : "this version"} in editor
      </button>
    </div>
  );
}

function SyntaxStatus({ on, problems, code, onGotoLine }) {
  if (!on) return <span className="faint">Syntax check off</span>;
  if (!code.trim()) return <span className="faint">Empty</span>;
  if (!problems.length) return <span className="ok"><IconCheck size={13} /> No syntax problems</span>;
  const p = problems[0];
  return (
    <span className="bad">
      {p.line ? <button className="msg-line" onClick={() => onGotoLine(p.line)}>line {p.line}</button> : null} {p.message}
      {problems.length > 1 && <span className="faint"> (+{problems.length - 1} more)</span>}
    </span>
  );
}

function SubmitResult({ result, onGotoLine, onClose }) {
  let tone = "bad";
  let head;
  let body = null;
  if (result.error) {
    head = "Couldn't submit";
    body = <p>{result.error}</p>;
  } else if (result.local) {
    head = "Not submitted: this code can't run yet";
    body = result.problems.slice(0, 3).map((p, i) => (
      <div key={i} className="problem">
        {p.line && <button className="msg-line" onClick={() => onGotoLine(p.line)}>line {p.line} →</button>} {p.message}
      </div>
    ));
  } else {
    const { status, report, id, entry_id } = result;
    tone = status === "ok" ? "ok" : status === "warning" ? "warn" : "bad";
    head = status === "ok" ? `Submitted. #${id} is your tournament entry`
      : status === "warning" ? `Submitted as #${id}, but it crashed during the checks`
      : `Not accepted: this code can't run. ${entry_id ? `#${entry_id} is still your entry.` : "You don't have an entry yet."}`;
    body = (
      <>
        {report.problems.map((p, i) => (
          <div key={i} className="problem">
            {p.line && <button className="msg-line" onClick={() => onGotoLine(p.line)}>line {p.line} →</button>} {p.message}
          </div>
        ))}
        {report.matches.length > 0 && (
          <ul className="check-list">
            {report.matches.map((m) => (
              <li key={m.opponent}>
                <span className={`res res-${m.outcome}`}>{m.outcome}</span>
                <span>vs {prettyBot(m.opponent)}</span>
                {m.crashes > 0 && <Message kind="error" text={m.first_error} onGotoLine={onGotoLine} />}
                {m.crashes === 0 && m.fumbles > 0 && <span className="faint">{m.fumbles} fumble{m.fumbles > 1 ? "s" : ""}</span>}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  return (
    <div className={`submit-pop tone-${tone}`} role="status">
      <div className="submit-head">
        {tone === "ok" ? <IconCheck /> : <IconAlert />} <b>{head}</b>
        <button className="icon-btn icon-btn-sm" onClick={onClose} title="Close"><IconClose size={14} /></button>
      </div>
      {body}
    </div>
  );
}
