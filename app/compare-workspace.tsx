"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JsonCodeEditor from "./json-code-editor";
import type { EditorValidation, JsonCodeEditorHandle } from "./json-code-editor";

type Theme = "light" | "dark";
type DiffOperation = "add" | "remove" | "replace" | "type-change";
type DiffEntry = { path: string; pointer: string; operation: DiffOperation; oldValue?: unknown; newValue?: unknown; oldType?: string; newType?: string; matchKey?: string };
type Filter = "all" | DiffOperation;
type ArrayMode = "index" | "set" | "key";
type MobilePane = "left" | "right" | "results";
type CompareResponse = { id: number; mode: "compare"; ok: boolean; diffs?: DiffEntry[]; limited?: boolean; duration: number; side?: "left" | "right"; validation?: EditorValidation };

const LEFT_SAMPLE = `{
  "project": "Aurora",
  "version": 4,
  "owner": { "id": 7, "name": "Lin" },
  "tags": ["design", "json"]
}`;
const RIGHT_SAMPLE = `{
  "project": "Aurora",
  "version": 5,
  "owner": { "id": 7, "name": "Owen", "active": true },
  "tags": ["json", "tools"]
}`;
const VALID: EditorValidation = { valid: true, message: "語法正確" };

function preview(value: unknown, limit = 150) {
  const text = typeof value === "string" ? `"${value}"` : JSON.stringify(value);
  if (text === undefined) return "—";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function parsePath(path: string): Array<string | number> {
  if (path === "$") return [];
  const parts: Array<string | number> = [];
  const matcher = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["((?:\\.|[^"\\])*)"\]/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(path))) parts.push(match[1] ?? (match[2] !== undefined ? Number(match[2]) : JSON.parse(`"${match[3]}"`)));
  return parts;
}

function safeKey(key: string | number) {
  return !["__proto__", "prototype", "constructor"].includes(String(key));
}

function applyEntry(source: string, entry: DiffEntry, direction: "forward" | "reverse") {
  const root = JSON.parse(source);
  const parts = parsePath(entry.path);
  const forward = direction === "forward";
  const operation = forward ? entry.operation : entry.operation === "add" ? "remove" : entry.operation === "remove" ? "add" : entry.operation;
  const value = forward ? entry.newValue : entry.oldValue;
  if (!parts.length) return JSON.stringify(value, null, 2);
  let parent: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (!safeKey(part) || !parent || typeof parent !== "object") throw new Error("差異路徑無法安全套用");
    parent = (parent as Record<string | number, unknown>)[part];
  }
  const key = parts.at(-1)!;
  if (!safeKey(key) || !parent || typeof parent !== "object") throw new Error("差異路徑無法安全套用");
  if (Array.isArray(parent) && typeof key === "number") {
    if (operation === "remove") parent.splice(key, 1);
    else if (operation === "add") parent.splice(key, 0, value);
    else parent[key] = value;
  } else {
    if (operation === "remove") delete (parent as Record<string, unknown>)[String(key)];
    else (parent as Record<string, unknown>)[String(key)] = value;
  }
  return JSON.stringify(root, null, 2);
}

function applyPatch(source: string, patch: Array<{ op: string; path: string; value?: unknown }>) {
  let current = source;
  for (const item of patch) {
    const path = `$${item.path.split("/").slice(1).map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~")).map((part) => /^\d+$/.test(part) ? `[${part}]` : /^[A-Za-z_$][\w$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`).join("")}`;
    current = applyEntry(current, { path, pointer: item.path, operation: item.op === "remove" ? "remove" : item.op === "add" ? "add" : "replace", newValue: item.value }, "forward");
  }
  return current;
}

function downloadText(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export default function CompareWorkspace({ theme, onTheme, onBack, initialLeft }: { theme: Theme; onTheme: () => void; onBack: () => void; initialLeft: string }) {
  const [left, setLeft] = useState(initialLeft || LEFT_SAMPLE);
  const [right, setRight] = useState(RIGHT_SAMPLE);
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [arrayMode, setArrayMode] = useState<ArrayMode>("index");
  const [arrayKey, setArrayKey] = useState("id");
  const [ignoreArrayOrder, setIgnoreArrayOrder] = useState(false);
  const [ignorePaths, setIgnorePaths] = useState("");
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [syncScroll, setSyncScroll] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [limited, setLimited] = useState(false);
  const [duration, setDuration] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [leftValidation, setLeftValidation] = useState<EditorValidation>(VALID);
  const [rightValidation, setRightValidation] = useState<EditorValidation>(VALID);
  const [mobilePane, setMobilePane] = useState<MobilePane>("left");
  const [toast, setToast] = useState("");
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const leftRef = useRef<JsonCodeEditorHandle>(null);
  const rightRef = useRef<JsonCodeEditorHandle>(null);
  const leftFileRef = useRef<HTMLInputElement>(null);
  const rightFileRef = useRef<HTMLInputElement>(null);
  const patchFileRef = useRef<HTMLInputElement>(null);
  const syncingScrollRef = useRef(false);

  const showToast = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 1800); }, []);
  const runCompare = useCallback(() => {
    if (!workerRef.current) return;
    const id = ++requestRef.current;
    setProcessing(true);
    workerRef.current.postMessage({ id, mode: "compare", source: left, rightSource: right, diffOptions: { arrayMode, arrayKey, ignoreArrayOrder, ignorePaths: ignorePaths.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) } });
  }, [arrayKey, arrayMode, ignoreArrayOrder, ignorePaths, left, right]);

  useEffect(() => {
    const worker = new Worker("/json-worker.js");
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<CompareResponse>) => {
      const response = event.data;
      if (response.mode !== "compare" || response.id !== requestRef.current) return;
      setProcessing(false);
      setDuration(response.duration);
      if (response.ok) {
        setDiffs(response.diffs ?? []); setLimited(Boolean(response.limited)); setLeftValidation(VALID); setRightValidation(VALID); setActiveIndex(0);
      } else {
        setDiffs([]);
        if (response.side === "right") setRightValidation(response.validation ?? { valid: false, message: "JSON 語法錯誤" });
        else setLeftValidation(response.validation ?? { valid: false, message: "JSON 語法錯誤" });
      }
    };
    worker.onerror = () => { setProcessing(false); showToast("背景比較發生錯誤"); };
    return () => worker.terminate();
  }, [showToast]);

  useEffect(() => { const timer = window.setTimeout(runCompare, Math.max(left.length, right.length) > 1_000_000 ? 500 : 180); return () => window.clearTimeout(timer); }, [runCompare, left.length, right.length]);

  const filtered = useMemo(() => diffs.filter((entry) => (filter === "all" || entry.operation === filter) && (!query || entry.path.toLowerCase().includes(query.toLowerCase()))), [diffs, filter, query]);
  const counts = useMemo(() => diffs.reduce<Record<DiffOperation, number>>((result, item) => { result[item.operation] += 1; return result; }, { add: 0, remove: 0, replace: 0, "type-change": 0 }), [diffs]);
  const active = filtered[Math.min(activeIndex, Math.max(0, filtered.length - 1))];

  const locate = useCallback((entry: DiffEntry, index: number) => {
    setActiveIndex(index);
    const leaf = parsePath(entry.path).at(-1);
    const needle = typeof leaf === "number" ? "" : JSON.stringify(String(leaf));
    const leftPosition = needle ? Math.max(0, left.indexOf(needle)) : 0;
    const rightPosition = needle ? Math.max(0, right.indexOf(needle)) : 0;
    leftRef.current?.jumpTo(leftPosition); rightRef.current?.jumpTo(rightPosition);
  }, [left, right]);

  const applyOne = (entry: DiffEntry, direction: "forward" | "reverse") => {
    try {
      if (direction === "forward") setLeft(applyEntry(left, entry, "forward"));
      else setRight(applyEntry(right, entry, "reverse"));
      showToast(direction === "forward" ? "已將新版差異套用至 Baseline" : "已將 Baseline 差異套用至新版");
    } catch (error) { showToast(error instanceof Error ? error.message : "無法套用差異"); }
  };

  const patch = useMemo(() => diffs.map((entry) => ({ op: entry.operation === "type-change" ? "replace" : entry.operation, path: entry.pointer, ...(entry.operation !== "remove" ? { value: entry.newValue } : {}) })), [diffs]);
  const exportReport = (format: "json" | "md" | "html" | "patch") => {
    if (format === "patch") return downloadText("comparison.patch.json", JSON.stringify(patch, null, 2), "application/json");
    if (format === "json") return downloadText("comparison-report.json", JSON.stringify({ generatedAt: new Date().toISOString(), summary: counts, differences: diffs }, null, 2), "application/json");
    const rows = diffs.map((entry) => `| ${entry.operation} | \`${entry.path}\` | \`${preview(entry.oldValue, 60)}\` | \`${preview(entry.newValue, 60)}\` |`).join("\n");
    if (format === "md") return downloadText("comparison-report.md", `# JSON comparison\n\n${diffs.length} differences\n\n| Type | Path | Before | After |\n|---|---|---|---|\n${rows}`, "text/markdown");
    const escaped = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
    const htmlRows = diffs.map((entry) => `<tr><td>${entry.operation}</td><td><code>${escaped(entry.path)}</code></td><td><code>${escaped(preview(entry.oldValue))}</code></td><td><code>${escaped(preview(entry.newValue))}</code></td></tr>`).join("");
    downloadText("comparison-report.html", `<!doctype html><meta charset="utf-8"><title>JSON comparison</title><style>body{font:14px system-ui;padding:32px;color:#20242a}table{border-collapse:collapse;width:100%}th,td{padding:9px;border:1px solid #ccd1d8;text-align:left}code{white-space:pre-wrap}</style><h1>JSON comparison</h1><p>${diffs.length} differences</p><table><thead><tr><th>Type</th><th>Path</th><th>Before</th><th>After</th></tr></thead><tbody>${htmlRows}</tbody></table>`, "text/html");
  };

  const openFile = async (file: File | undefined, side: "left" | "right") => { if (!file) return; const content = await file.text(); if (side === "left") setLeft(content); else setRight(content); };
  const importPatch = async (file?: File) => { if (!file) return; try { const parsed = JSON.parse(await file.text()); if (!Array.isArray(parsed)) throw new Error("Patch 必須是陣列"); setRight(applyPatch(left, parsed)); showToast("已將 JSON Patch 套用至新版，可在送出前檢查差異"); } catch (error) { showToast(error instanceof Error ? error.message : "Patch 無效"); } };
  const markers = useCallback((entries: DiffEntry[], source: string) => entries.slice(0, 200).map((entry) => { const leaf = parsePath(entry.path).at(-1); const needle = typeof leaf === "number" ? "" : JSON.stringify(String(leaf)); const from = needle ? Math.max(0, source.indexOf(needle)) : 0; return { from, to: Math.min(source.length, from + Math.max(1, needle.length)), kind: entry.operation }; }), []);
  const syncOtherEditor = useCallback((side: "left" | "right", ratio: number) => {
    if (!syncScroll || syncingScrollRef.current) return;
    syncingScrollRef.current = true;
    if (side === "left") rightRef.current?.scrollToRatio(ratio); else leftRef.current?.scrollToRatio(ratio);
    window.requestAnimationFrame(() => { syncingScrollRef.current = false; });
  }, [syncScroll]);

  return <main className="app-shell compare-shell" data-theme={theme}>
    <header className="topbar"><button className="brand compare-brand" type="button" onClick={onBack}><span className="brand-mark">{'{}'}</span><span><strong>JSON Diff</strong><small>Compare · Patch · Merge</small></span></button><div className="topbar-meta"><span className="local-badge"><span />Local only</span><button className="theme-button" type="button" onClick={onTheme}>{theme === "light" ? "深色" : "淺色"}</button><button className="theme-button" type="button" onClick={onBack}>返回格式化</button></div></header>
    <section className="tool-heading"><div><h1>JSON 差異比較</h1><p>結構化比較、合併與 JSON Patch · 忽略縮排及鍵順序</p></div><div className={`document-status ${diffs.length ? "has-diffs" : "is-valid"}`}><span>{processing ? "…" : diffs.length}</span><strong>{processing ? "比較中" : diffs.length ? "個差異" : "內容一致"}</strong></div></section>
    <section className="workspace compare-workspace">
      <nav className="compare-toolbar" aria-label="比較設定">
        <div className="toolbar-group"><button type="button" onClick={() => { const current = left; setLeft(right); setRight(current); }}>交換兩側</button><button type="button" onClick={() => { setLeft(LEFT_SAMPLE); setRight(RIGHT_SAMPLE); }}>載入範例</button><label className="check-label"><input type="checkbox" checked={onlyDiffs} onChange={(event) => setOnlyDiffs(event.target.checked)} />僅顯示差異</label><label className="check-label"><input type="checkbox" checked={syncScroll} onChange={(event) => setSyncScroll(event.target.checked)} />同步捲動</label></div>
        <div className="toolbar-group compare-options"><label className="compact-field">陣列<select value={arrayMode} onChange={(event) => setArrayMode(event.target.value as ArrayMode)}><option value="index">依索引</option><option value="set">視為集合</option><option value="key">依唯一鍵</option></select></label>{arrayMode === "key" && <input value={arrayKey} onChange={(event) => setArrayKey(event.target.value)} aria-label="陣列唯一鍵" placeholder="id" />}<label className="check-label"><input type="checkbox" checked={ignoreArrayOrder} onChange={(event) => setIgnoreArrayOrder(event.target.checked)} />忽略順序</label><input value={ignorePaths} onChange={(event) => setIgnorePaths(event.target.value)} aria-label="忽略 JSONPath" placeholder="忽略路徑：$.meta.*" /></div>
        <details className="more-menu"><summary>匯入／匯出</summary><div className="more-menu-popover"><button type="button" onClick={() => patchFileRef.current?.click()}>匯入 JSON Patch</button><button type="button" onClick={() => exportReport("patch")}>匯出 JSON Patch</button><button type="button" onClick={() => exportReport("json")}>JSON 報告</button><button type="button" onClick={() => exportReport("md")}>Markdown 報告</button><button type="button" onClick={() => exportReport("html")}>HTML 報告</button></div></details>
        <input ref={patchFileRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={(event) => importPatch(event.target.files?.[0])} />
      </nav>
      {processing && <div className="worker-progress" role="status"><span className="worker-progress-track"><span /></span><strong>背景比較中</strong><span>{((left.length + right.length) / 1_000_000).toFixed(2)} MB</span><button type="button" onClick={() => { requestRef.current += 1; setProcessing(false); showToast("已取消比較"); }}>取消</button></div>}
      <div className="compare-mobile-tabs" role="tablist"><button className={mobilePane === "left" ? "active" : ""} onClick={() => setMobilePane("left")}>Baseline</button><button className={mobilePane === "right" ? "active" : ""} onClick={() => setMobilePane("right")}>新版</button><button className={mobilePane === "results" ? "active" : ""} onClick={() => setMobilePane("results")}>差異 {diffs.length}</button></div>
      <div className={`compare-grid ${onlyDiffs ? "only-diffs" : ""}`}>
        <article className={`compare-editor ${mobilePane !== "left" ? "compare-mobile-hidden" : ""}`}><header><div><span>A</span><strong>Baseline</strong></div><div><button type="button" onClick={() => leftFileRef.current?.click()}>開啟</button><button type="button" onClick={() => setLeft("")}>清除</button></div></header><input ref={leftFileRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={(event) => openFile(event.target.files?.[0], "left")} /><div className="code-wrap"><JsonCodeEditor ref={leftRef} value={left} onChange={setLeft} onScrollRatio={(ratio) => syncOtherEditor("left", ratio)} validation={leftValidation} theme={theme} highlights={markers(diffs.filter((item) => item.operation !== "add"), left)} /></div><div className={`compare-validation ${leftValidation.valid ? "valid" : "invalid"}`}>{leftValidation.valid ? "語法正確" : leftValidation.message}</div></article>
        <article className={`compare-editor ${mobilePane !== "right" ? "compare-mobile-hidden" : ""}`}><header><div><span>B</span><strong>新版</strong></div><div><button type="button" onClick={() => rightFileRef.current?.click()}>開啟</button><button type="button" onClick={() => setRight("")}>清除</button></div></header><input ref={rightFileRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={(event) => openFile(event.target.files?.[0], "right")} /><div className="code-wrap"><JsonCodeEditor ref={rightRef} value={right} onChange={setRight} onScrollRatio={(ratio) => syncOtherEditor("right", ratio)} validation={rightValidation} theme={theme} highlights={markers(diffs.filter((item) => item.operation !== "remove"), right)} /></div><div className={`compare-validation ${rightValidation.valid ? "valid" : "invalid"}`}>{rightValidation.valid ? "語法正確" : rightValidation.message}</div></article>
        <aside className={`diff-panel ${mobilePane !== "results" ? "compare-mobile-hidden" : ""}`}><header><div><strong>差異結果</strong><span>{duration.toFixed(1)} ms{limited ? " · 僅顯示前 500 筆" : ""}</span></div><div className="diff-nav"><button disabled={!filtered.length} onClick={() => { const index = (activeIndex - 1 + filtered.length) % filtered.length; locate(filtered[index], index); }}>↑</button><span>{filtered.length ? Math.min(activeIndex + 1, filtered.length) : 0}/{filtered.length}</span><button disabled={!filtered.length} onClick={() => { const index = (activeIndex + 1) % filtered.length; locate(filtered[index], index); }}>↓</button></div></header>
          <div className="diff-summary"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 <strong>{diffs.length}</strong></button><button className={filter === "add" ? "active add" : "add"} onClick={() => setFilter("add")}>新增 <strong>{counts.add}</strong></button><button className={filter === "remove" ? "active remove" : "remove"} onClick={() => setFilter("remove")}>刪除 <strong>{counts.remove}</strong></button><button className={filter === "replace" ? "active replace" : "replace"} onClick={() => setFilter("replace")}>修改 <strong>{counts.replace}</strong></button><button className={filter === "type-change" ? "active type-change" : "type-change"} onClick={() => setFilter("type-change")}>型別 <strong>{counts["type-change"]}</strong></button></div>
          {diffs.length > 0 && <div className="diff-bulk"><span>批次合併</span><button type="button" onClick={() => { setLeft(right); showToast("已將新版完整套用至 Baseline"); }}>全部 B → A</button><button type="button" onClick={() => { setRight(left); showToast("已將 Baseline 完整套用至新版"); }}>全部 A → B</button></div>}
          <div className="diff-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋 JSONPath…" /></div>
          <div className="diff-list">{filtered.length ? filtered.map((entry, index) => <article key={`${entry.path}-${index}`} className={`diff-entry ${entry.operation} ${active === entry ? "active" : ""}`}><button className="diff-entry-main" type="button" onClick={() => locate(entry, index)}><span className="diff-kind">{entry.operation === "add" ? "+ 新增" : entry.operation === "remove" ? "− 刪除" : entry.operation === "type-change" ? "T 型別" : "~ 修改"}</span><code title={entry.path}>{entry.path}</code><span className="diff-values"><del>{preview(entry.oldValue)}</del><ins>{preview(entry.newValue)}</ins></span></button><div className="diff-actions"><button type="button" onClick={() => navigator.clipboard.writeText(entry.path)}>路徑</button><button type="button" onClick={() => navigator.clipboard.writeText(JSON.stringify(entry.oldValue, null, 2) ?? "")}>舊值</button><button type="button" onClick={() => navigator.clipboard.writeText(JSON.stringify(entry.newValue, null, 2) ?? "")}>新值</button><button type="button" onClick={() => applyOne(entry, "forward")}>B → A</button><button type="button" onClick={() => applyOne(entry, "reverse")}>A → B</button></div></article>) : <div className="diff-empty"><strong>{processing ? "正在比較" : "沒有符合的差異"}</strong><span>{diffs.length ? "調整篩選條件以顯示結果。" : "兩份 JSON 的資料結構與內容相同。"}</span></div>}</div>
        </aside>
      </div>
    </section>
    <footer><span>比較、合併與報告皆在本機完成</span><span>JSON DIFF · v1</span></footer>{toast && <div className="toast" role="status">{toast}</div>}
  </main>;
}
