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
  undo: () => void;
};

type JsonCodeEditorProps = {
  onChange: (value: string) => void;
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
  function JsonCodeEditor({ onChange, readOnly = false, theme, validation, value }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const initialValueRef = useRef(value);
    const initialThemeRef = useRef(theme);
    const initialReadOnlyRef = useRef(readOnly);
    const themeCompartmentRef = useRef(new Compartment());

    useEffect(() => {
      onChangeRef.current = onChange;
    }, [onChange]);

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
          themeCompartment.of(initialThemeRef.current === "dark" ? oneDark : lightTheme),
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
      undo: () => {
        const view = viewRef.current;
        if (view) undo(view);
      },
    }), []);

    return <div className={`code-editor ${readOnly ? "is-readonly" : ""}`} ref={hostRef} />;
  },
);

export default JsonCodeEditor;
