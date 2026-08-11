"use client";

import {
  Compartment,
  EditorState,
} from "@codemirror/state";
import {
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  bracketMatching,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import {
  closeSearchPanel,
  openSearchPanel,
  searchKeymap,
} from "@codemirror/search";
import {
  lintGutter,
  linter,
  setDiagnostics,
} from "@codemirror/lint";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export type EditorValidation = {
  valid: boolean;
  message: string;
  position?: number;
  line?: number;
  column?: number;
};

export type JsonCodeEditorHandle = {
  closeSearch: () => void;
  focus: () => void;
  jumpTo: (position: number) => void;
  openSearch: () => void;
  redo: () => void;
  scrollToRatio: (ratio: number) => void;
  undo: () => void;
};

export type EditorHighlight = { from: number; to: number; kind: string };

type JsonCodeEditorProps = {
  highlights?: EditorHighlight[];
  onChange: (value: string) => void;
  onScrollRatio?: (ratio: number) => void;
  readOnly?: boolean;
  theme: "light" | "dark";
  validation: EditorValidation;
  value: string;
};

const lightTheme = EditorView.theme({
  "&": { backgroundColor: "#ffffff", color: "#242830" },
  ".cm-content": { caretColor: "#3157c8" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#3157c8" },
  ".cm-activeLine": { backgroundColor: "#f3f6fc" },
  ".cm-activeLineGutter": { backgroundColor: "#eaf0fc", color: "#3157c8" },
  ".cm-gutters": { backgroundColor: "#f8f9fb", color: "#8a919b", border: "none" },
  ".cm-foldGutter": { width: "15px" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "#cbd8fb !important" },
  ".cm-searchMatch": { backgroundColor: "#ffe6a2", outline: "1px solid #dcae37" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#ffd368" },
});

const JsonCodeEditor = forwardRef<JsonCodeEditorHandle, JsonCodeEditorProps>(
  function JsonCodeEditor({ highlights = [], onChange, onScrollRatio, readOnly = false, theme, validation, value }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onScrollRatioRef = useRef(onScrollRatio);
    const initialValueRef = useRef(value);
    const initialThemeRef = useRef(theme);
    const initialReadOnlyRef = useRef(readOnly);
    const themeCompartmentRef = useRef(new Compartment());
    const highlightCompartmentRef = useRef(new Compartment());

    useEffect(() => {
      onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
      onScrollRatioRef.current = onScrollRatio;
    }, [onScrollRatio]);

    useEffect(() => {
      if (!hostRef.current) return;
      const themeCompartment = themeCompartmentRef.current;
      const state = EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          highlightActiveLine(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          json(),
          initialReadOnlyRef.current ? [] : [lintGutter(), linter(() => [])],
          EditorState.readOnly.of(initialReadOnlyRef.current),
          EditorView.editable.of(!initialReadOnlyRef.current),
          keymap.of([
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            scroll: (_event, view) => {
              const scroller = view.scrollDOM;
              const maximum = scroller.scrollHeight - scroller.clientHeight;
              onScrollRatioRef.current?.(maximum > 0 ? scroller.scrollTop / maximum : 0);
            },
          }),
          themeCompartment.of(initialThemeRef.current === "dark" ? oneDark : lightTheme),
          highlightCompartmentRef.current.of(EditorView.decorations.of(Decoration.none)),
        ],
      });
      const view = new EditorView({ state, parent: hostRef.current });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === value) return;
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }, [value]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartmentRef.current.reconfigure(theme === "dark" ? oneDark : lightTheme),
      });
    }, [theme]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const length = view.state.doc.length;
      const ranges = highlights
        .map((highlight) => ({ ...highlight, from: Math.min(Math.max(0, highlight.from), length), to: Math.min(Math.max(highlight.from + 1, highlight.to), length) }))
        .filter((highlight) => highlight.from < highlight.to)
        .sort((a, b) => a.from - b.from)
        .map((highlight) => Decoration.mark({ class: `cm-diff-${highlight.kind}` }).range(highlight.from, highlight.to));
      const decorations: DecorationSet = Decoration.set(ranges, true);
      view.dispatch({ effects: highlightCompartmentRef.current.reconfigure(EditorView.decorations.of(decorations)) });
    }, [highlights]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const length = view.state.doc.length;
      const position = Math.min(validation.position ?? 0, length);
      const diagnostics = readOnly || validation.valid
        ? []
        : [{
            from: position,
            to: Math.min(position + 1, length),
            severity: "error" as const,
            message: validation.line
              ? `${validation.message}（第 ${validation.line} 行，第 ${validation.column} 欄）`
              : validation.message,
          }];
      view.dispatch(setDiagnostics(view.state, diagnostics));
    }, [readOnly, validation]);

    useImperativeHandle(ref, () => ({
      closeSearch: () => {
        const view = viewRef.current;
        if (view) closeSearchPanel(view);
      },
      focus: () => viewRef.current?.focus(),
      jumpTo: (position: number) => {
        const view = viewRef.current;
        if (!view) return;
        const safePosition = Math.min(Math.max(0, position), view.state.doc.length);
        view.dispatch({
          selection: { anchor: safePosition, head: Math.min(safePosition + 1, view.state.doc.length) },
          effects: EditorView.scrollIntoView(safePosition, { y: "center" }),
        });
        view.focus();
      },
      openSearch: () => {
        const view = viewRef.current;
        if (view) openSearchPanel(view);
      },
      redo: () => {
        const view = viewRef.current;
        if (view) redo(view);
      },
      scrollToRatio: (ratio: number) => {
        const scroller = viewRef.current?.scrollDOM;
        if (!scroller) return;
        scroller.scrollTop = Math.max(0, Math.min(1, ratio)) * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      },
      undo: () => {
        const view = viewRef.current;
        if (view) undo(view);
      },
    }), []);

    return <div className={`code-editor ${readOnly ? "is-readonly" : ""}`} ref={hostRef} />;
  },
);

export default JsonCodeEditor;
