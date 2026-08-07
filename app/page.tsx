"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

const SAMPLE = `{
  "project": "Aurora",
  "version": 3,
  "active": true,
  "tags": ["design", "tools", "json"],
  "owner": {
    "name": "Lin",
    "timezone": "Asia/Taipei"
  }
}`;

const STORAGE_KEY = "json-tool-workspace-v3";
const AUTOSAVE_KEY = "json-tool-autosave";

type Validation = {
  valid: boolean;
  message: string;
  position?: number;
  line?: number;
  column?: number;
};

type ViewMode = "code" | "tree";
type Theme = "light" | "dark";
type MobilePanel = "input" | "output";
type TreeExpansion = "default" | "all" | "none";

type SavedWorkspace = {
  source: string;
  fileName: string;
  indent: string;
  sortKeys: boolean;
  autoSync: boolean;
  viewMode: ViewMode;
  theme: Theme;
  paneWidth: number;
};

function locateError(source: string, error: unknown): Validation {
  const message = error instanceof Error ? error.message : "無法解析 JSON";
  const match = message.match(/position\s+(\d+)/i);
  if (!match) return { valid: false, message };
  const position = Number(match[1]);
  const lines = source.slice(0, position).split("\n");
  return {
    valid: false,
    message,
    position,
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function validate(source: string): Validation {
  if (!source.trim()) return { valid: false, message: "尚未輸入 JSON" };
  try {
    JSON.parse(source);
    return { valid: true, message: "語法正確" };
  } catch (error) {
    return locateError(source, error);
  }
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortObject((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

function countKeys(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countKeys(item), 0);
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((sum, [, item]) => sum + 1 + countKeys(item), 0);
  }
  return 0;
}

function formatJson(source: string, indent: string, sortKeys: boolean) {
  const parsed = JSON.parse(source);
  const value = sortKeys ? sortObject(parsed) : parsed;
  return JSON.stringify(value, null, indent === "tab" ? "\t" : Number(indent));
}

function primitiveClass(value: unknown) {
  if (value === null) return "tree-null";
  if (typeof value === "string") return "tree-string";
  if (typeof value === "number") return "tree-number";
  if (typeof value === "boolean") return "tree-boolean";
  return "";
}

function Primitive({ value }: { value: unknown }) {
  const label = typeof value === "string" ? `"${value}"` : String(value);
  return <span className={primitiveClass(value)}>{label}</span>;
}

function JsonTree({
  value,
  name,
  depth = 0,
  expansion,
}: {
  value: unknown;
  name?: string;
  depth?: number;
  expansion: TreeExpansion;
}) {
  const isContainer = value !== null && typeof value === "object";
  if (!isContainer) {
    return (
      <div className="tree-row" style={{ "--depth": depth } as CSSProperties}>
        {name !== undefined && <span className="tree-key">{name}</span>}
        {name !== undefined && <span className="tree-separator">:</span>}
        <Primitive value={value} />
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const isArray = Array.isArray(value);
  const defaultOpen = expansion === "all" || (expansion === "default" && depth < 2);

  return (
    <details className="tree-branch" open={defaultOpen}>
      <summary className="tree-row" style={{ "--depth": depth } as CSSProperties}>
        {name !== undefined && <span className="tree-key">{name}</span>}
        {name !== undefined && <span className="tree-separator">:</span>}
        <span className="tree-summary">
          {isArray ? "Array" : "Object"} <span>{entries.length} {isArray ? "items" : "keys"}</span>
        </span>
      </summary>
      {entries.map(([key, item]) => (
        <JsonTree
          key={key}
          name={isArray ? `[${key}]` : key}
          value={item}
          depth={depth + 1}
          expansion={expansion}
        />
      ))}
    </details>
  );
}

export default function Home() {
  const [source, setSource] = useState(SAMPLE);
  const [output, setOutput] = useState(SAMPLE);
  const [fileName, setFileName] = useState("untitled.json");
  const [indent, setIndent] = useState("2");
  const [sortKeys, setSortKeys] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [autoSave, setAutoSave] = useState(true);
  const [saveState, setSaveState] = useState("本機自動儲存");
  const [viewMode, setViewMode] = useState<ViewMode>("code");
  const [theme, setTheme] = useState<Theme>("light");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("input");
  const [paneWidth, setPaneWidth] = useState(50);
  const [searchOpen, setSearchOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceValue, setReplaceValue] = useState("");
  const [currentMatch, setCurrentMatch] = useState(-1);
  const [treeExpansion, setTreeExpansion] = useState<TreeExpansion>("default");
  const [treeRevision, setTreeRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const [restored, setRestored] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const editorsRef = useRef<HTMLDivElement>(null);
  const result = useMemo(() => validate(source), [source]);

  const parsed = useMemo(() => {
    try { return JSON.parse(source); } catch { return null; }
  }, [source]);

  const outputParsed = useMemo(() => {
    try { return JSON.parse(output); } catch { return null; }
  }, [output]);

  const stats = useMemo(() => ({
    lines: source ? source.split("\n").length : 0,
    chars: new Blob([source]).size,
    keys: parsed === null ? 0 : countKeys(parsed),
  }), [parsed, source]);

  const matchCount = useMemo(() => {
    if (!findQuery) return 0;
    let count = 0;
    let cursor = 0;
    const haystack = source.toLocaleLowerCase();
    const needle = findQuery.toLocaleLowerCase();
    while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
      count += 1;
      cursor += Math.max(needle.length, 1);
    }
    return count;
  }, [findQuery, source]);

  const format = useCallback(() => {
    if (!result.valid) return;
    setOutput(formatJson(source, indent, sortKeys));
    setMobilePanel("output");
  }, [indent, result.valid, sortKeys, source]);

  useEffect(() => {
    try {
      const autoSavePreference = localStorage.getItem(AUTOSAVE_KEY);
      if (autoSavePreference !== null) setAutoSave(autoSavePreference === "true");
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const workspace = JSON.parse(saved) as Partial<SavedWorkspace>;
        if (typeof workspace.source === "string") setSource(workspace.source);
        if (typeof workspace.fileName === "string") setFileName(workspace.fileName);
        if (["2", "4", "tab"].includes(workspace.indent ?? "")) setIndent(workspace.indent!);
        if (typeof workspace.sortKeys === "boolean") setSortKeys(workspace.sortKeys);
        if (typeof workspace.autoSync === "boolean") setAutoSync(workspace.autoSync);
        if (workspace.viewMode === "code" || workspace.viewMode === "tree") setViewMode(workspace.viewMode);
        if (workspace.theme === "light" || workspace.theme === "dark") setTheme(workspace.theme);
        if (typeof workspace.paneWidth === "number") setPaneWidth(Math.min(72, Math.max(28, workspace.paneWidth)));
        setSaveState("已還原本機內容");
      } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        setTheme("dark");
      }
    } catch {
      setSaveState("無法讀取本機內容");
    } finally {
      setRestored(true);
    }
  }, []);

  useEffect(() => {
    if (autoSync && result.valid) setOutput(formatJson(source, indent, sortKeys));
  }, [autoSync, indent, result.valid, sortKeys, source]);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(AUTOSAVE_KEY, String(autoSave));
    if (!autoSave) {
      setSaveState("自動儲存已關閉");
      return;
    }
    setSaveState("儲存中…");
    const timer = window.setTimeout(() => {
      const workspace: SavedWorkspace = {
        source,
        fileName,
        indent,
        sortKeys,
        autoSync,
        viewMode,
        theme,
        paneWidth,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
        setSaveState("已儲存在本機");
      } catch {
        setSaveState("本機空間不足");
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [autoSave, autoSync, fileName, indent, paneWidth, restored, sortKeys, source, theme, viewMode]);

  useEffect(() => {
    if (searchOpen) window.setTimeout(() => findInputRef.current?.focus(), 0);
  }, [searchOpen]);

  const findNext = useCallback((direction: 1 | -1 = 1) => {
    if (!findQuery || !source) return;
    const textarea = inputRef.current;
    const haystack = source.toLocaleLowerCase();
    const needle = findQuery.toLocaleLowerCase();
    const anchor = direction === 1
      ? (textarea?.selectionEnd ?? currentMatch + needle.length)
      : Math.max(0, (textarea?.selectionStart ?? currentMatch) - 1);
    let index = direction === 1
      ? haystack.indexOf(needle, anchor)
      : haystack.lastIndexOf(needle, anchor);
    if (index === -1) index = direction === 1 ? haystack.indexOf(needle) : haystack.lastIndexOf(needle);
    if (index === -1) return;
    setCurrentMatch(index);
    textarea?.focus();
    textarea?.setSelectionRange(index, index + findQuery.length);
  }, [currentMatch, findQuery, source]);

  const replaceCurrent = () => {
    const textarea = inputRef.current;
    if (!textarea || !findQuery) return;
    const { selectionStart, selectionEnd } = textarea;
    const selected = source.slice(selectionStart, selectionEnd);
    if (selected.toLocaleLowerCase() !== findQuery.toLocaleLowerCase()) {
      findNext(1);
      return;
    }
    const nextSource = `${source.slice(0, selectionStart)}${replaceValue}${source.slice(selectionEnd)}`;
    setSource(nextSource);
    window.requestAnimationFrame(() => {
      const nextPosition = selectionStart + replaceValue.length;
      textarea.focus();
      textarea.setSelectionRange(nextPosition, nextPosition);
    });
  };

  const replaceAll = () => {
    if (!findQuery) return;
    const escaped = findQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    setSource(source.replace(new RegExp(escaped, "gi"), replaceValue));
    setCurrentMatch(-1);
  };

  const minify = () => {
    if (!result.valid) return;
    const value = sortKeys ? sortObject(JSON.parse(source)) : JSON.parse(source);
    setOutput(JSON.stringify(value));
    setViewMode("code");
    setMobilePanel("output");
  };

  const copyOutput = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([output], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const openFile = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    setSource(text);
    setFileName(file.name.toLowerCase().endsWith(".json") ? file.name : `${file.name}.json`);
    setMobilePanel("input");
  };

  const focusError = () => {
    if (result.position === undefined) return;
    const textarea = inputRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(result.position, result.position + 1);
    if (textarea && result.line) {
      textarea.scrollTop = Math.max(0, (result.line - 1) * 19.8 - textarea.clientHeight / 2);
      if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = textarea.scrollTop;
    }
  };

  const changeTreeExpansion = (expansion: TreeExpansion) => {
    setTreeExpansion(expansion);
    setTreeRevision((revision) => revision + 1);
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editorsRef.current || window.matchMedia("(max-width: 760px)").matches) return;
    event.preventDefault();
    const bounds = editorsRef.current.getBoundingClientRect();
    const move = (pointerEvent: PointerEvent) => {
      const percentage = ((pointerEvent.clientX - bounds.left) / bounds.width) * 100;
      setPaneWidth(Math.min(72, Math.max(28, percentage)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("is-resizing");
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <main
      className="app-shell"
      data-theme={theme}
      onKeyDown={(event) => {
        const command = event.metaKey || event.ctrlKey;
        if (command && event.key === "Enter") {
          event.preventDefault();
          format();
        }
        if (command && event.key.toLocaleLowerCase() === "f") {
          event.preventDefault();
          setSearchOpen(true);
        }
        if (command && event.key.toLocaleLowerCase() === "h") {
          event.preventDefault();
          setSearchOpen(true);
        }
      }}
    >
      <header className="topbar">
        <a className="brand" href="#workspace" aria-label="JSON Formatter & Validator">
          <span className="brand-mark">{'{}'}</span>
          <span><strong>JSON Formatter</strong><small>Validate · Format · Inspect</small></span>
        </a>
        <div className="topbar-meta">
          <span className="save-indicator" title={saveState}><span />{saveState}</span>
          <span className="local-badge"><span />Local only</span>
          <button
            className="theme-button"
            type="button"
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
            aria-label={theme === "light" ? "切換深色模式" : "切換淺色模式"}
          >
            {theme === "light" ? "深色" : "淺色"}
          </button>
        </div>
      </header>

      <section className="tool-heading" aria-labelledby="page-title">
        <div><h1 id="page-title">JSON Formatter &amp; Validator</h1><p>格式化、驗證與檢視 JSON，資料不離開瀏覽器。</p></div>
        <div className={`document-status ${result.valid ? "is-valid" : "is-error"}`}>
          <span>{result.valid ? "✓" : "!"}</span><strong>{result.valid ? "VALID JSON" : "INVALID JSON"}</strong>
        </div>
      </section>

      <section id="workspace" className="workspace" aria-label="JSON 編輯工作區">
        <nav className="toolbar" aria-label="編輯工具">
          <div className="toolbar-group file-tools">
            <button className="ghost-button" type="button" onClick={() => { setSource(""); setOutput(""); setFileName("untitled.json"); setMobilePanel("input"); }}>新增</button>
            <button className="ghost-button" type="button" onClick={() => fileInputRef.current?.click()}>開啟檔案</button>
            <input ref={fileInputRef} className="visually-hidden" type="file" accept=".json,application/json,text/plain" onChange={(event) => openFile(event.target.files?.[0])} />
            <button className="ghost-button search-toggle" type="button" onClick={() => setSearchOpen((open) => !open)}>搜尋／取代</button>
            <span className="file-name" title={fileName}>{fileName}</span>
          </div>
          <div className="toolbar-group format-tools">
            <label className="compact-field"><span>縮排</span>
              <select value={indent} onChange={(event) => setIndent(event.target.value)} aria-label="縮排方式">
                <option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tab</option>
              </select>
            </label>
            <label className="check-label"><input type="checkbox" checked={sortKeys} onChange={(event) => setSortKeys(event.target.checked)} />排序鍵值</label>
            <label className="check-label"><input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} />即時同步</label>
            <label className="check-label"><input type="checkbox" checked={autoSave} onChange={(event) => setAutoSave(event.target.checked)} />自動儲存</label>
          </div>
          <div className="toolbar-actions">
            <button className="ghost-button" type="button" onClick={() => { setSource(SAMPLE); setOutput(SAMPLE); setFileName("sample.json"); }}>載入範例</button>
            <button className="ghost-button" type="button" onClick={minify} disabled={!result.valid}>壓縮</button>
            <button className="primary-button" type="button" onClick={format} disabled={!result.valid}>格式化 <kbd>⌘↵</kbd></button>
          </div>
        </nav>

        <div className="mobile-tabs" role="tablist" aria-label="編輯器面板">
          <button role="tab" aria-selected={mobilePanel === "input"} className={mobilePanel === "input" ? "active" : ""} type="button" onClick={() => setMobilePanel("input")}>輸入</button>
          <button role="tab" aria-selected={mobilePanel === "output"} className={mobilePanel === "output" ? "active" : ""} type="button" onClick={() => setMobilePanel("output")}>結果</button>
        </div>

        <div
          ref={editorsRef}
          className="editors"
          style={{ "--left-pane": `${paneWidth}fr`, "--right-pane": `${100 - paneWidth}fr` } as CSSProperties}
        >
          <article className={`editor-panel input-panel ${mobilePanel !== "input" ? "mobile-inactive" : ""}`}>
            <div className="panel-header">
              <div className="panel-title"><span className="panel-index">01</span><h2>文字編輯器</h2></div>
              <div className="panel-actions"><span className="mini-stat">{stats.lines} lines</span><button className="text-button" type="button" onClick={() => setSource("")}>清除</button></div>
            </div>
            {searchOpen && (
              <div className="search-panel">
                <div className="search-field">
                  <input
                    ref={findInputRef}
                    value={findQuery}
                    onChange={(event) => { setFindQuery(event.target.value); setCurrentMatch(-1); }}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); findNext(event.shiftKey ? -1 : 1); } }}
                    placeholder="搜尋"
                    aria-label="搜尋文字"
                  />
                  <span>{matchCount ? `${matchCount} 筆` : "無結果"}</span>
                </div>
                <input value={replaceValue} onChange={(event) => setReplaceValue(event.target.value)} placeholder="取代為" aria-label="取代文字" />
                <button type="button" onClick={() => findNext(-1)} disabled={!matchCount} aria-label="上一筆">↑</button>
                <button type="button" onClick={() => findNext(1)} disabled={!matchCount} aria-label="下一筆">↓</button>
                <button type="button" onClick={replaceCurrent} disabled={!matchCount}>取代</button>
                <button type="button" onClick={replaceAll} disabled={!matchCount}>全部</button>
                <button className="search-close" type="button" onClick={() => setSearchOpen(false)} aria-label="關閉搜尋">×</button>
              </div>
            )}
            <div className="code-wrap">
              <div ref={lineNumbersRef} className="line-numbers" aria-hidden="true">
                {source.split("\n").map((_, index) => (
                  <span key={index} className={result.line === index + 1 && !result.valid ? "error-line" : ""}>{index + 1}</span>
                ))}
              </div>
              <textarea
                ref={inputRef}
                aria-label="JSON 輸入"
                aria-invalid={!result.valid}
                value={source}
                onChange={(event) => setSource(event.target.value)}
                onScroll={(event) => { if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = event.currentTarget.scrollTop; }}
                spellCheck={false}
                placeholder={'貼上 JSON，例如 { "status": "ok" }'}
              />
            </div>
            <button className={`validation ${result.valid ? "is-valid" : "is-error"}`} type="button" onClick={focusError} disabled={result.position === undefined}>
              <span className="status-icon">{result.valid ? "✓" : "!"}</span>
              <span><strong>{result.valid ? "JSON 語法正確" : result.message}</strong>{result.line && ` · 第 ${result.line} 行，第 ${result.column} 欄`}</span>
              {!result.valid && result.position !== undefined && <em>跳到錯誤</em>}
            </button>
          </article>

          <div
            className="pane-divider"
            role="separator"
            aria-label="調整編輯器面板寬度"
            aria-orientation="vertical"
            aria-valuemin={28}
            aria-valuemax={72}
            aria-valuenow={Math.round(paneWidth)}
            tabIndex={0}
            onPointerDown={beginResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setPaneWidth((width) => Math.max(28, width - 2));
              if (event.key === "ArrowRight") setPaneWidth((width) => Math.min(72, width + 2));
              if (event.key === "Home") setPaneWidth(28);
              if (event.key === "End") setPaneWidth(72);
            }}
          ><span /></div>

          <article className={`editor-panel output-panel ${mobilePanel !== "output" ? "mobile-inactive" : ""}`}>
            <div className="panel-header">
              <div className="panel-title"><span className="panel-index">02</span><h2>結果</h2></div>
              <div className="panel-actions">
                {viewMode === "tree" && (
                  <div className="tree-actions">
                    <button type="button" onClick={() => changeTreeExpansion("all")}>全部展開</button>
                    <button type="button" onClick={() => changeTreeExpansion("none")}>全部收合</button>
                  </div>
                )}
                <div className="view-switch" aria-label="結果檢視模式">
                  <button className={viewMode === "code" ? "active" : ""} type="button" onClick={() => setViewMode("code")}>程式碼</button>
                  <button className={viewMode === "tree" ? "active" : ""} type="button" onClick={() => setViewMode("tree")} disabled={outputParsed === null}>樹狀</button>
                </div>
                <button className="text-button" type="button" onClick={copyOutput} disabled={!output}>{copied ? "已複製" : "複製"}</button>
                <button className="text-button" type="button" onClick={download} disabled={!output}>下載</button>
              </div>
            </div>
            {viewMode === "tree" && outputParsed !== null ? (
              <div className="tree-view" key={`${treeExpansion}-${treeRevision}`}><JsonTree value={outputParsed} expansion={treeExpansion} /></div>
            ) : (
              <pre className="output-code" tabIndex={0}><code>{output || "格式化後的 JSON 會顯示在這裡。"}</code></pre>
            )}
            <div className="stats" aria-label="JSON 統計資訊">
              <span><strong>{stats.keys}</strong> keys</span><span><strong>{stats.chars.toLocaleString()}</strong> bytes</span><span>UTF-8</span><span className="stats-spacer" /><span>{autoSync ? "AUTO SYNC ON" : "MANUAL"}</span>
            </div>
          </article>
        </div>
      </section>

      <footer><span>所有處理與儲存皆在本機完成</span><span>JSON TOOL · v3</span></footer>
    </main>
  );
}
