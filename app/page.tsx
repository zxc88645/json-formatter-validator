"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import JsonCodeEditor from "./json-code-editor";
import type { JsonCodeEditorHandle } from "./json-code-editor";

const SAMPLE = `{
  "project": "Aurora",
  "version": 4,
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
type TreeSelection = { path: string; value: unknown };
type ContextMenuState = TreeSelection & { x: number; y: number };

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

function childPath(parent: string, key: string, isArray: boolean) {
  if (isArray) return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function Primitive({ value }: { value: unknown }) {
  const label = typeof value === "string" ? `"${value}"` : String(value);
  return <span className={primitiveClass(value)}>{label}</span>;
}

function JsonTree({
  value,
  name,
  path = "$",
  depth = 0,
  expansion,
  selectedPath,
  onSelect,
  onContextMenu,
}: {
  value: unknown;
  name?: string;
  path?: string;
  depth?: number;
  expansion: TreeExpansion;
  selectedPath: string;
  onSelect: (selection: TreeSelection) => void;
  onContextMenu: (event: ReactMouseEvent, selection: TreeSelection) => void;
}) {
  const isContainer = value !== null && typeof value === "object";
  const selected = selectedPath === path;
  if (!isContainer) {
    return (
      <div
        className={`tree-row tree-value-row ${selected ? "selected" : ""}`}
        style={{ "--depth": depth } as CSSProperties}
        role="button"
        tabIndex={0}
        onClick={() => onSelect({ path, value })}
        onContextMenu={(event) => onContextMenu(event, { path, value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onSelect({ path, value });
        }}
      >
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
      <summary
        className={`tree-row ${selected ? "selected" : ""}`}
        style={{ "--depth": depth } as CSSProperties}
        onClick={() => onSelect({ path, value })}
        onContextMenu={(event) => onContextMenu(event, { path, value })}
      >
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
          path={childPath(path, key, isArray)}
          depth={depth + 1}
          expansion={expansion}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
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
  const [treeExpansion, setTreeExpansion] = useState<TreeExpansion>("default");
  const [treeRevision, setTreeRevision] = useState(0);
  const [treeSelection, setTreeSelection] = useState<TreeSelection | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [restored, setRestored] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const editorRef = useRef<JsonCodeEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorsRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
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

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1700);
  }, []);

  const format = useCallback(() => {
    if (!result.valid) return;
    setOutput(formatJson(source, indent, sortKeys));
    setMobilePanel("output");
    showToast("JSON 已格式化");
  }, [indent, result.valid, showToast, sortKeys, source]);

  const newDocument = useCallback(() => {
    setSource("");
    setOutput("");
    setFileName("untitled.json");
    setMobilePanel("input");
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
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
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!autoSync || !result.valid) return;
    const timer = window.setTimeout(() => setOutput(formatJson(source, indent, sortKeys)), 0);
    return () => window.clearTimeout(timer);
  }, [autoSync, indent, result.valid, sortKeys, source]);

  useEffect(() => {
    const timer = window.setTimeout(() => setTreeSelection(null), 0);
    return () => window.clearTimeout(timer);
  }, [output]);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(AUTOSAVE_KEY, String(autoSave));
    if (!autoSave) {
      const offTimer = window.setTimeout(() => setSaveState("自動儲存已關閉"), 0);
      return () => window.clearTimeout(offTimer);
    }
    const savingTimer = window.setTimeout(() => setSaveState("儲存中…"), 0);
    const timer = window.setTimeout(() => {
      const workspace: SavedWorkspace = { source, fileName, indent, sortKeys, autoSync, viewMode, theme, paneWidth };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
        setSaveState("已儲存在本機");
      } catch {
        setSaveState("本機空間不足");
      }
    }, 450);
    return () => {
      window.clearTimeout(savingTimer);
      window.clearTimeout(timer);
    };
  }, [autoSave, autoSync, fileName, indent, paneWidth, restored, sortKeys, source, theme, viewMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        setCommandQuery("");
      }
      if (command && event.key === "/") {
        event.preventDefault();
        setShortcutsOpen(true);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setShortcutsOpen(false);
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (commandOpen) window.setTimeout(() => commandInputRef.current?.focus(), 0);
  }, [commandOpen]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, []);

  const minify = () => {
    if (!result.valid) return;
    const value = sortKeys ? sortObject(JSON.parse(source)) : JSON.parse(source);
    setOutput(JSON.stringify(value));
    setViewMode("code");
    setMobilePanel("output");
    showToast("JSON 已壓縮");
  };

  const copyText = async (text: string, message: string) => {
    await navigator.clipboard.writeText(text);
    showToast(message);
  };

  const copyOutput = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    showToast("已複製格式化結果");
    window.setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([output], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("JSON 檔案已下載");
  };

  const openFile = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    setSource(text);
    setFileName(file.name.toLowerCase().endsWith(".json") ? file.name : `${file.name}.json`);
    setMobilePanel("input");
    setDragActive(false);
    showToast(`已開啟 ${file.name}`);
  };

  const focusError = () => {
    if (result.position === undefined) return;
    editorRef.current?.jumpTo(result.position);
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

  const selectedPath = treeSelection?.path ?? "$";
  const selectedValue = treeSelection?.value ?? outputParsed;
  const selectedDisplayValue = typeof selectedValue === "string"
    ? selectedValue
    : selectedValue === undefined
      ? ""
      : JSON.stringify(selectedValue);
  const selectedJson = selectedValue === undefined ? "" : JSON.stringify(selectedValue, null, 2);
  const outputValidation = useMemo<Validation>(() => ({ valid: true, message: "唯讀結果" }), []);

  const handleCommandClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const action = event.currentTarget.dataset.action;
    setCommandOpen(false);
    setCommandQuery("");
    if (action === "format") format();
    if (action === "minify") minify();
    if (action === "search") editorRef.current?.openSearch();
    if (action === "open") fileInputRef.current?.click();
    if (action === "new") newDocument();
    if (action === "copy") copyOutput();
    if (action === "download") download();
    if (action === "theme") setTheme((current) => current === "light" ? "dark" : "light");
  };

  const commands = [
    { label: "格式化 JSON", hint: "⌘ Enter", action: "format", disabled: !result.valid },
    { label: "壓縮 JSON", hint: "", action: "minify", disabled: !result.valid },
    { label: "搜尋／取代", hint: "⌘ F", action: "search" },
    { label: "開啟 JSON 檔案", hint: "", action: "open" },
    { label: "建立新文件", hint: "", action: "new" },
    { label: "複製結果", hint: "", action: "copy", disabled: !output },
    { label: "下載結果", hint: "", action: "download", disabled: !output },
    { label: theme === "light" ? "切換深色模式" : "切換淺色模式", hint: "", action: "theme" },
  ];
  const filteredCommands = commands.filter((command) => command.label.toLowerCase().includes(commandQuery.trim().toLowerCase()));

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
          editorRef.current?.openSearch();
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
          <button className="command-trigger" type="button" onClick={() => setCommandOpen(true)} aria-label="開啟命令面板">命令 <kbd>⌘K</kbd></button>
          <button className="theme-button" type="button" onClick={() => setTheme((current) => current === "light" ? "dark" : "light")} aria-label={theme === "light" ? "切換深色模式" : "切換淺色模式"}>
            {theme === "light" ? "深色" : "淺色"}
          </button>
        </div>
      </header>

      <section className="tool-heading" aria-labelledby="page-title">
        <div><h1 id="page-title">JSON 工作區</h1><p>即時驗證、格式化與檢視 · 僅在本機處理</p></div>
        <div className={`document-status ${result.valid ? "is-valid" : "is-error"}`}><span>{result.valid ? "✓" : "!"}</span><strong>{result.valid ? "語法正確" : "語法錯誤"}</strong></div>
      </section>

      <section
        id="workspace"
        className={`workspace ${dragActive ? "is-dragging" : ""}`}
        aria-label="JSON 編輯工作區"
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          openFile(event.dataTransfer.files?.[0]);
        }}
      >
        {dragActive && <div className="drop-overlay"><strong>放開以開啟 JSON</strong><span>內容只會在瀏覽器本機讀取</span></div>}
        <nav className="toolbar" aria-label="編輯工具">
          <div className="toolbar-group file-tools">
            <button className="ghost-button" type="button" onClick={() => fileInputRef.current?.click()}>開啟檔案</button>
            <input ref={fileInputRef} className="visually-hidden" type="file" accept=".json,application/json,text/plain" onChange={(event) => openFile(event.target.files?.[0])} />
            <span className="file-name" title={fileName}>{fileName}</span>
          </div>
          <div className="toolbar-group format-tools">
            <label className="compact-field"><span>縮排</span>
              <select value={indent} onChange={(event) => setIndent(event.target.value)} aria-label="縮排方式"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tab</option></select>
            </label>
            <label className="check-label"><input type="checkbox" checked={sortKeys} onChange={(event) => setSortKeys(event.target.checked)} />排序鍵值</label>
            <label className="check-label"><input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} />即時同步</label>
          </div>
          <div className="toolbar-actions">
            <button className="ghost-button" type="button" onClick={minify} disabled={!result.valid}>壓縮</button>
            <details className="more-menu">
              <summary>更多</summary>
              <div className="more-menu-popover">
                <button type="button" onClick={() => editorRef.current?.openSearch()}>搜尋／取代 <span>⌘F</span></button>
                <button type="button" onClick={newDocument}>建立新文件</button>
                <button type="button" onClick={() => { setSource(SAMPLE); setOutput(SAMPLE); setFileName("sample.json"); }}>載入範例</button>
                <label><input type="checkbox" checked={autoSave} onChange={(event) => setAutoSave(event.target.checked)} />本機自動儲存</label>
                <button type="button" onClick={() => setShortcutsOpen(true)}>鍵盤快捷鍵 <span>⌘/</span></button>
              </div>
            </details>
            <button className="primary-button" type="button" onClick={format} disabled={!result.valid}>格式化 <kbd>⌘↵</kbd></button>
          </div>
        </nav>

        <div className="mobile-tabs" role="tablist" aria-label="編輯器面板">
          <button role="tab" aria-selected={mobilePanel === "input"} className={mobilePanel === "input" ? "active" : ""} type="button" onClick={() => setMobilePanel("input")}>輸入</button>
          <button role="tab" aria-selected={mobilePanel === "output"} className={mobilePanel === "output" ? "active" : ""} type="button" onClick={() => setMobilePanel("output")}>結果</button>
        </div>

        <div ref={editorsRef} className="editors" style={{ "--left-pane": `${paneWidth}fr`, "--right-pane": `${100 - paneWidth}fr` } as CSSProperties}>
          <article className={`editor-panel input-panel ${mobilePanel !== "input" ? "mobile-inactive" : ""}`}>
            <div className="panel-header">
              <div className="panel-title"><span className="panel-index">01</span><h2>輸入 JSON</h2></div>
              <div className="panel-actions">
                <span className="mini-stat">{stats.lines} lines</span>
                <button className="text-button" type="button" onClick={() => editorRef.current?.undo()} title="復原（⌘Z）">Undo</button>
                <button className="text-button" type="button" onClick={() => editorRef.current?.redo()} title="重做（⌘⇧Z）">Redo</button>
                <button className="text-button" type="button" onClick={() => setSource("")}>清除</button>
              </div>
            </div>
            <div className="code-wrap">
              <JsonCodeEditor ref={editorRef} value={source} onChange={setSource} validation={result} theme={theme} />
              {!source && <button className="empty-editor" type="button" onClick={() => fileInputRef.current?.click()}><strong>貼上或開啟 JSON</strong><span>也可以將 .json 檔案拖放到工作區</span></button>}
            </div>
            <button className={`validation ${result.valid ? "is-valid" : "is-error"}`} type="button" onClick={focusError} disabled={result.position === undefined}>
              <span className="status-icon">{result.valid ? "✓" : "!"}</span>
              <span><strong>{result.valid ? "JSON 語法正確" : result.message}</strong>{result.line && ` · 第 ${result.line} 行，第 ${result.column} 欄`}</span>
              {!result.valid && result.position !== undefined && <em>跳到錯誤</em>}
            </button>
          </article>

          <div className="pane-divider" role="separator" aria-label="調整編輯器面板寬度" aria-orientation="vertical" aria-valuemin={28} aria-valuemax={72} aria-valuenow={Math.round(paneWidth)} tabIndex={0} onPointerDown={beginResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setPaneWidth((width) => Math.max(28, width - 2));
              if (event.key === "ArrowRight") setPaneWidth((width) => Math.min(72, width + 2));
              if (event.key === "Home") setPaneWidth(28);
              if (event.key === "End") setPaneWidth(72);
            }}><span /></div>

          <article className={`editor-panel output-panel ${mobilePanel !== "output" ? "mobile-inactive" : ""}`}>
            <div className="panel-header">
              <div className="panel-title"><span className="panel-index">02</span><h2>格式化結果</h2></div>
              <div className="panel-actions">
                <div className="view-switch" aria-label="結果檢視模式"><button className={viewMode === "code" ? "active" : ""} type="button" onClick={() => setViewMode("code")}>程式碼</button><button className={viewMode === "tree" ? "active" : ""} type="button" onClick={() => setViewMode("tree")} disabled={outputParsed === null}>樹狀</button></div>
                <button className="text-button" type="button" onClick={copyOutput} disabled={!output}>{copied ? "已複製" : "複製"}</button>
                <details className="panel-menu">
                  <summary aria-label="更多結果操作">操作</summary>
                  <div className="panel-menu-popover">
                    {viewMode === "tree" && <><button type="button" onClick={() => changeTreeExpansion("all")}>全部展開</button><button type="button" onClick={() => changeTreeExpansion("none")}>全部收合</button></>}
                    <button type="button" onClick={download} disabled={!output}>下載 JSON</button>
                  </div>
                </details>
              </div>
            </div>
            {viewMode === "tree" && outputParsed !== null ? (
              <>
                <div className="tree-contextbar">
                  <code title={selectedPath}>{selectedPath}</code>
                  <button className="tree-copy-primary" type="button" onClick={() => copyText(selectedJson, "已複製節點 JSON")}>複製節點</button>
                  <details className="tree-node-menu">
                    <summary aria-label="更多節點操作">•••</summary>
                    <div className="tree-node-popover">
                      <button type="button" onClick={() => copyText(selectedPath, "已複製 JSONPath")}>複製 JSONPath</button>
                      <button type="button" onClick={() => copyText(selectedDisplayValue, "已複製節點值")}>複製值</button>
                      <button type="button" onClick={() => copyText(selectedJson, "已複製節點 JSON")}>複製格式化 JSON</button>
                    </div>
                  </details>
                </div>
                <div className="tree-view" key={`${treeExpansion}-${treeRevision}`}>
                  <JsonTree value={outputParsed} expansion={treeExpansion} selectedPath={selectedPath} onSelect={setTreeSelection} onContextMenu={(event, selection) => { event.preventDefault(); setTreeSelection(selection); setContextMenu({ ...selection, x: event.clientX, y: event.clientY }); }} />
                </div>
              </>
            ) : (
              <div className="output-code-editor">
                {output ? <JsonCodeEditor value={output} onChange={() => undefined} validation={outputValidation} theme={theme} readOnly /> : <div className="output-empty"><strong>尚無結果</strong><span>輸入有效 JSON 後，結果會自動顯示。</span></div>}
              </div>
            )}
            <div className="stats" aria-label="JSON 統計資訊"><span><strong>{stats.keys}</strong> keys</span><span><strong>{stats.chars.toLocaleString()}</strong> bytes</span><span>UTF-8</span><span className="stats-spacer" /><span>{autoSync ? "AUTO SYNC ON" : "MANUAL"}</span></div>
          </article>
        </div>
      </section>

      <footer><span>所有處理與儲存皆在本機完成</span><span>JSON TOOL · v4</span></footer>
      {commandOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setCommandOpen(false)}><section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-search"><span>⌘</span><input ref={commandInputRef} value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); document.querySelector<HTMLButtonElement>(".command-list button:not(:disabled)")?.click(); } }} placeholder="搜尋命令…" aria-label="搜尋命令" /></div>
        <div className="command-list">{filteredCommands.length ? filteredCommands.map((command) => <button key={command.label} type="button" data-action={command.action} disabled={command.disabled} onClick={handleCommandClick}><span>{command.label}</span><kbd>{command.hint}</kbd></button>) : <p>找不到符合的命令</p>}</div>
        <div className="command-footer"><span>Enter 執行</span><span>Esc 關閉</span></div>
      </section></div>}
      {shortcutsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShortcutsOpen(false)}><section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title" onMouseDown={(event) => event.stopPropagation()}><div className="dialog-heading"><div><span>REFERENCE</span><h2 id="shortcut-title">鍵盤快捷鍵</h2></div><button type="button" onClick={() => setShortcutsOpen(false)} aria-label="關閉">×</button></div><dl><div><dt>命令面板</dt><dd>⌘ K</dd></div><div><dt>格式化 JSON</dt><dd>⌘ Enter</dd></div><div><dt>搜尋／取代</dt><dd>⌘ F</dd></div><div><dt>復原</dt><dd>⌘ Z</dd></div><div><dt>重做</dt><dd>⌘ ⇧ Z</dd></div><div><dt>縮排</dt><dd>Tab</dd></div></dl><p>Windows / Linux 請使用 Ctrl 取代 ⌘。</p></section></div>}
      {contextMenu && <div className="tree-menu" style={{ left: Math.min(contextMenu.x, window.innerWidth - 190), top: Math.min(contextMenu.y, window.innerHeight - 150) }} role="menu" onClick={(event) => event.stopPropagation()}><strong title={contextMenu.path}>{contextMenu.path}</strong><button type="button" role="menuitem" onClick={() => { copyText(contextMenu.path, "已複製 JSONPath"); setContextMenu(null); }}>複製 JSONPath</button><button type="button" role="menuitem" onClick={() => { copyText(typeof contextMenu.value === "string" ? contextMenu.value : JSON.stringify(contextMenu.value), "已複製節點值"); setContextMenu(null); }}>複製值</button><button type="button" role="menuitem" onClick={() => { copyText(JSON.stringify(contextMenu.value, null, 2), "已複製節點 JSON"); setContextMenu(null); }}>複製節點 JSON</button></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
