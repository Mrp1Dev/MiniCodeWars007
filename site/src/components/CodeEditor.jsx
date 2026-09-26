// The one editor: participants type pseudocode or Python here, and "Clean with AI" replaces it.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
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
    "&": { height: "100%", fontSize: "15px", backgroundColor: "var(--editor-bg)", color: "var(--text)" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55", fontVariantLigatures: "none" },
    ".cm-content": { caretColor: "var(--accent)", padding: "10px 0" },
    ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--faint)", border: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.035)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(232, 184, 75, 0.25) !important",
    },
    ".cm-tooltip": { backgroundColor: "var(--panel-2)", border: "1px solid var(--line)", color: "var(--text)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "#111" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--panel-2)", border: "none", color: "var(--muted)" },
    ".cm-matchingBracket": { backgroundColor: "rgba(255,255,255,0.1) !important", outline: "none" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "#ff7b72" },
  { tag: [t.string], color: "#a5d6ff" },
  { tag: [t.number, t.bool, t.null], color: "#79c0ff" },
  { tag: [t.comment], color: "#7d8590", fontStyle: "italic" },
  { tag: [t.function(t.definition(t.variableName)), t.function(t.variableName)], color: "#d2a8ff" },
  { tag: [t.propertyName], color: "#7ee0b5" },
  { tag: [t.operator, t.compareOperator], color: "#ff9e64" },
  { tag: [t.variableName], color: "#e6edf3" },
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

// --- component --------------------------------------------------------------------------

const CodeEditor = forwardRef(function CodeEditor({ initialDoc, onChange }, ref) {
  const host = useRef(null);
  const view = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
          theme,
          syntaxHighlighting(highlight),
          lintGutter(),
          quoteField,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    getDoc: () => view.current.state.doc.toString(),
    // One transaction, so Ctrl+Z brings back what was there before.
    replaceDoc(text) {
      const v = view.current;
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: text },
        effects: setQuoteMarks.of(Decoration.none),
        userEvent: "input.replace",
        scrollIntoView: true,
      });
    },
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
