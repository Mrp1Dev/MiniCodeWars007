// The one editor: participants type pseudocode or Python here, and "Clean with AI" replaces it.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { indentWithTab, isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { completeFromList } from "@codemirror/autocomplete";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";

// --- highlighting the parts of their pseudocode the AI couldn't translate ------------------

const setQuoteMarks = StateEffect.define();
const quoteMark = Decoration.mark({ class: "cm-declined" });

const quoteField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects) if (e.is(setQuoteMarks)) marks = e.value;
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Where a quote appears in the text: exact match first, then ignoring case and spacing
// (the AI sometimes quotes with slightly different whitespace).
export function findQuote(text, quote) {
  const q = quote.trim();
  if (!q) return null;
  const i = text.indexOf(q);
  if (i >= 0) return { from: i, to: i + q.length };
  const re = new RegExp(q.split(/\s+/).map(escapeRe).join("\\s+"), "i");
  const m = re.exec(text);
  return m ? { from: m.index, to: m.index + m[0].length } : null;
}

// --- look -------------------------------------------------------------------------------

const theme = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "14.5px", backgroundColor: "transparent", color: "var(--text)" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65", fontVariantLigatures: "none" },
    ".cm-content": { caretColor: "var(--gold)", padding: "14px 0" },
    ".cm-cursor": { borderLeftColor: "var(--gold)", borderLeftWidth: "2px" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none", paddingLeft: "6px" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 8px" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.025)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(201, 169, 97, 0.22) !important",
    },
    ".cm-tooltip": { backgroundColor: "var(--raised)", border: "1px solid var(--line-2)", color: "var(--text)", borderRadius: "8px", overflow: "hidden" },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "13px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgba(201, 169, 97, 0.18)", color: "var(--text)" },
    ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "10px" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--raised)", border: "none", color: "var(--muted)" },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--faint)" },
    ".cm-matchingBracket": { backgroundColor: "rgba(255,255,255,0.08) !important", outline: "none" },
    ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "2px solid rgba(229, 72, 77, 0.8)" },
    ".cm-diagnostic-error": { borderLeftColor: "var(--red)" },
    ".cm-panels": { backgroundColor: "var(--raised)", color: "var(--text)" },
    ".cm-searchMatch": { backgroundColor: "rgba(201, 169, 97, 0.25)" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "#d4a574" },
  { tag: [t.string], color: "#9ccfa0" },
  { tag: [t.number, t.bool, t.null], color: "#e0b872" },
  { tag: [t.comment], color: "#5f6873", fontStyle: "italic" },
  { tag: [t.function(t.definition(t.variableName)), t.function(t.variableName)], color: "#8fb8e8" },
  { tag: [t.propertyName], color: "#b9c4cf" },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator], color: "#9aa4ae" },
  { tag: [t.variableName], color: "#e8e6e1" },
  { tag: [t.punctuation, t.paren, t.bracket], color: "#7c8590" },
]);

// The bot API, offered as autocompletions.
const MOVES = ["RELOAD", "SHIELD", "SHOOT", "SNIPE", "COUNTER"];
const apiWords = completeFromList([
  ...MOVES.map((label) => ({ label, type: "constant", detail: "move" })),
  ...["hp", "ammo", "shields", "history"].map((f) => ({ label: `me.${f}`, type: "property", detail: "you" })),
  ...["hp", "ammo", "history"].map((f) => ({ label: `opp.${f}`, type: "property", detail: "opponent" })),
  { label: "turn", type: "variable", detail: "1, 2, 3, ..." },
  { label: "memory", type: "variable", detail: "dict kept between turns" },
]);

// --- no pasting from outside ---------------------------------------------------------------
// So participants can't paste each other's code in, paste and drag-and-drop only accept text
// that was copied, cut or dragged out of this same editor. Moving your own code around still works.

const normalizeClip = (s) => (s || "").replace(/\r\n/g, "\n").replace(/\n+$/, "");

// What Ctrl+C / Ctrl+X / a drag takes from the editor: the selected text, or the whole line
// when nothing is selected (CodeMirror copies the line then).
function selectedText(state) {
  const ranges = state.selection.ranges;
  if (ranges.every((r) => r.empty)) {
    return ranges.map((r) => state.doc.lineAt(r.head).text).join("\n");
  }
  return ranges.filter((r) => !r.empty).map((r) => state.sliceDoc(r.from, r.to)).join("\n");
}

function ownTextOnly(onBlocked) {
  let own = null; // the last text taken out of this editor
  const remember = (_e, view) => { own = normalizeClip(selectedText(view.state)); return false; };
  const isOwn = (text) => own !== null && normalizeClip(text) === own;
  const block = (e) => {
    e.preventDefault();
    if (onBlocked.current) onBlocked.current();
    return true;
  };
  return EditorView.domEventHandlers({
    copy: remember,
    cut: remember,
    dragstart: remember,
    paste: (e) => (isOwn(e.clipboardData?.getData("text/plain")) ? false : block(e)),
    drop: (e) => (isOwn(e.dataTransfer?.getData("text/plain")) ? false : block(e)),
  });
}

// --- component --------------------------------------------------------------------------

const CodeEditor = forwardRef(function CodeEditor({ initialDoc, onChange, onHistory, onRun, onPasteBlocked }, ref) {
  const host = useRef(null);
  const view = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onHistoryRef = useRef(onHistory);
  onHistoryRef.current = onHistory;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onPasteBlockedRef = useRef(onPasteBlocked);
  onPasteBlockedRef.current = onPasteBlocked;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          basicSetup,
          python(),
          pythonLanguage.data.of({ autocomplete: apiWords }),
          indentUnit.of("    "),
          EditorState.tabSize.of(4),
          keymap.of([indentWithTab]),
          // Ctrl+Y and Ctrl+Shift+Z both redo, whatever the platform guesses.
          Prec.highest(keymap.of([
            { key: "Mod-y", run: redo, preventDefault: true },
            { key: "Mod-Shift-z", run: redo, preventDefault: true },
            // Ctrl+Enter runs a match (instead of inserting a blank line).
            { key: "Mod-Enter", run: () => { if (onRunRef.current) onRunRef.current(); return true; } },
          ])),
          theme,
          syntaxHighlighting(highlight),
          lintGutter(),
          quoteField,
          ownTextOnly(onPasteBlockedRef),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            if (onHistoryRef.current) onHistoryRef.current({ undo: undoDepth(u.state) > 0, redo: redoDepth(u.state) > 0 });
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    getDoc: () => view.current.state.doc.toString(),
    // One undo step of its own, so Ctrl+Z / Ctrl+Y step between before and after.
    replaceDoc(text) {
      const v = view.current;
      if (v.state.doc.toString() === text) return;
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: text },
        effects: setQuoteMarks.of(Decoration.none),
        annotations: isolateHistory.of("full"),
        userEvent: "input.replace",
      });
    },
    undo: () => { undo(view.current); view.current.focus(); },
    redo: () => { redo(view.current); view.current.focus(); },
    focus: () => view.current.focus(),
    // problems: [{line, message}] from the static check; line may be null.
    setProblems(problems) {
      const v = view.current;
      const doc = v.state.doc;
      const diagnostics = problems
        .filter((p) => p.line && p.line <= doc.lines)
        .map((p) => {
          const line = doc.line(p.line);
          return { from: line.from, to: Math.max(line.from, line.to), severity: "error", message: p.message };
        });
      v.dispatch(setDiagnostics(v.state, diagnostics));
    },
    // Highlights each quote; returns which ones were found.
    markQuotes(quotes) {
      const v = view.current;
      const text = v.state.doc.toString();
      const ranges = quotes.map((q) => findQuote(text, q));
      const marks = ranges
        .filter(Boolean)
        .sort((a, b) => a.from - b.from)
        .filter((r, i, all) => i === 0 || r.from >= all[i - 1].to)
        .map((r) => quoteMark.range(r.from, r.to));
      v.dispatch({ effects: setQuoteMarks.of(Decoration.set(marks)) });
      return ranges.map(Boolean);
    },
    clearQuotes() {
      view.current.dispatch({ effects: setQuoteMarks.of(Decoration.none) });
    },
    selectQuote(quote) {
      const v = view.current;
      const r = findQuote(v.state.doc.toString(), quote);
      if (r) {
        v.dispatch({ selection: { anchor: r.from, head: r.to }, scrollIntoView: true });
        v.focus();
      }
    },
    gotoLine(n) {
      const v = view.current;
      if (!n || n > v.state.doc.lines) return;
      const line = v.state.doc.line(n);
      v.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
      v.focus();
    },
  }));

  return <div className="editor-host" ref={host} />;
});

export default CodeEditor;
