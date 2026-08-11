const MAX_QUERY_RESULTS = 100;
const MAX_DIFF_RESULTS = 500;

function locateError(source, error) {
  const message = error instanceof Error ? error.message : "無法解析 JSON";
  const positionMatch = message.match(/position\s+(\d+)/i);
  const lineColumnMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  let position = positionMatch ? Number(positionMatch[1]) : undefined;
  let line = lineColumnMatch ? Number(lineColumnMatch[1]) : undefined;
  let column = lineColumnMatch ? Number(lineColumnMatch[2]) : undefined;

  if (position !== undefined && (line === undefined || column === undefined)) {
    const before = source.slice(0, position).split("\n");
    line = before.length;
    column = (before.at(-1)?.length ?? 0) + 1;
  }

  const sourceLines = source.split("\n");
  const context = line ? sourceLines[Math.max(0, line - 1)]?.slice(0, 240) : undefined;
  let hint = "檢查錯誤位置前後的逗號、引號與括號。";
  if (/unexpected end/i.test(message)) hint = "JSON 可能缺少結尾括號、引號或值。";
  if (/property name|double-quoted/i.test(message)) hint = "物件鍵名必須使用雙引號包住。";
  if (/after json|non-whitespace/i.test(message)) hint = "根節點結束後仍有多餘內容。";

  return { valid: false, message, position, line, column, context, hint };
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.keys(value).sort((a, b) => a.localeCompare(b)).reduce((result, key) => {
      result[key] = sortObject(value[key]);
      return result;
    }, {});
  }
  return value;
}

function countKeys(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countKeys(item), 0);
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((sum, [, item]) => sum + 1 + countKeys(item), 0);
  }
  return 0;
}

function childPath(parent, key, isArray = false) {
  if (isArray) return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function tokenizeJsonPath(query) {
  const input = query.trim();
  if (!input.startsWith("$")) throw new Error("JSONPath 必須從 $ 開始");
  const tokens = [];
  let index = 1;
  while (index < input.length) {
    if (input.startsWith("..", index)) {
      index += 2;
      const match = input.slice(index).match(/^(\*|[A-Za-z_$][\w$]*)/);
      if (!match) throw new Error("遞迴查詢 .. 後需要鍵名或 *");
      tokens.push({ type: "recursive", key: match[1] });
      index += match[1].length;
      continue;
    }
    if (input[index] === ".") {
      index += 1;
      const match = input.slice(index).match(/^(\*|[A-Za-z_$][\w$]*)/);
      if (!match) throw new Error("點號後需要鍵名或 *");
      tokens.push({ type: match[1] === "*" ? "wildcard" : "property", key: match[1] });
      index += match[1].length;
      continue;
    }
    if (input[index] === "[") {
      const end = input.indexOf("]", index);
      if (end === -1) throw new Error("缺少右方括號 ]");
      const content = input.slice(index + 1, end).trim();
      if (content === "*") tokens.push({ type: "wildcard" });
      else if (/^\d+$/.test(content)) tokens.push({ type: "index", index: Number(content) });
      else {
        const quoted = content.match(/^(["'])(.*)\1$/);
        if (!quoted) throw new Error("方括號僅支援索引、* 或引號鍵名");
        tokens.push({ type: "property", key: quoted[2] });
      }
      index = end + 1;
      continue;
    }
    throw new Error(`無法識別第 ${index + 1} 個字元附近的語法`);
  }
  return tokens;
}

function queryJsonPath(root, query) {
  const tokens = tokenizeJsonPath(query);
  let nodes = [{ path: "$", value: root }];
  for (const token of tokens) {
    const next = [];
    for (const node of nodes) {
      if (next.length >= MAX_QUERY_RESULTS) break;
      if (token.type === "property" && node.value && typeof node.value === "object" && token.key in node.value) {
        next.push({ path: childPath(node.path, token.key), value: node.value[token.key] });
      } else if (token.type === "index" && Array.isArray(node.value) && token.index < node.value.length) {
        next.push({ path: childPath(node.path, String(token.index), true), value: node.value[token.index] });
      } else if (token.type === "wildcard" && node.value && typeof node.value === "object") {
        const isArray = Array.isArray(node.value);
        for (const [key, value] of Object.entries(node.value)) {
          next.push({ path: childPath(node.path, key, isArray), value });
          if (next.length >= MAX_QUERY_RESULTS) break;
        }
      } else if (token.type === "recursive") {
        const visit = (value, path) => {
          if (!value || typeof value !== "object" || next.length >= MAX_QUERY_RESULTS) return;
          const isArray = Array.isArray(value);
          for (const [key, child] of Object.entries(value)) {
            const pathValue = childPath(path, key, isArray);
            if (token.key === "*" || key === token.key) next.push({ path: pathValue, value: child });
            visit(child, pathValue);
            if (next.length >= MAX_QUERY_RESULTS) break;
          }
        };
        visit(node.value, node.path);
      }
    }
    nodes = next;
  }
  return nodes;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pathIgnored(path, patterns) {
  return patterns.some((pattern) => {
    const clean = pattern.trim();
    if (!clean) return false;
    if (clean.endsWith(".*")) return path === clean.slice(0, -2) || path.startsWith(`${clean.slice(0, -2)}.`) || path.startsWith(`${clean.slice(0, -2)}[`);
    return path === clean || path.startsWith(`${clean}.`) || path.startsWith(`${clean}[`);
  });
}

function toPointer(path) {
  if (path === "$") return "";
  const parts = [];
  const matcher = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["((?:\\.|[^"\\])*)"\]/g;
  let match;
  while ((match = matcher.exec(path))) parts.push(match[1] ?? match[2] ?? JSON.parse(`"${match[3]}"`));
  return `/${parts.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function diffJson(left, right, options) {
  const results = [];
  const ignored = options.ignorePaths ?? [];
  const add = (entry) => {
    if (results.length < MAX_DIFF_RESULTS) results.push({ ...entry, pointer: toPointer(entry.path) });
  };
  const walk = (before, after, path) => {
    if (results.length >= MAX_DIFF_RESULTS || pathIgnored(path, ignored)) return;
    const beforeType = valueType(before);
    const afterType = valueType(after);
    if (beforeType !== afterType) {
      add({ path, operation: "type-change", oldValue: before, newValue: after, oldType: beforeType, newType: afterType });
      return;
    }
    if (Array.isArray(before)) {
      if (options.arrayMode === "set" || options.ignoreArrayOrder) {
        const leftMap = new Map(before.map((item, index) => [stableStringify(item), { item, index }]));
        const rightMap = new Map(after.map((item, index) => [stableStringify(item), { item, index }]));
        for (const [key, value] of leftMap) if (!rightMap.has(key)) add({ path: childPath(path, String(value.index), true), operation: "remove", oldValue: value.item, oldType: valueType(value.item) });
        for (const [key, value] of rightMap) if (!leftMap.has(key)) add({ path: childPath(path, String(value.index), true), operation: "add", newValue: value.item, newType: valueType(value.item) });
        return;
      }
      if (options.arrayMode === "key" && options.arrayKey && before.every((item) => item && typeof item === "object") && after.every((item) => item && typeof item === "object")) {
        const leftMap = new Map(before.map((item, index) => [String(item[options.arrayKey]), { item, index }]));
        const rightMap = new Map(after.map((item, index) => [String(item[options.arrayKey]), { item, index }]));
        for (const [key, value] of leftMap) {
          const target = rightMap.get(key);
          if (!target) add({ path: childPath(path, String(value.index), true), operation: "remove", oldValue: value.item, oldType: "object", matchKey: key });
          else walk(value.item, target.item, childPath(path, String(target.index), true));
        }
        for (const [key, value] of rightMap) if (!leftMap.has(key)) add({ path: childPath(path, String(value.index), true), operation: "add", newValue: value.item, newType: "object", matchKey: key });
        return;
      }
      const length = Math.max(before.length, after.length);
      for (let index = 0; index < length; index += 1) {
        const itemPath = childPath(path, String(index), true);
        if (index >= before.length) add({ path: itemPath, operation: "add", newValue: after[index], newType: valueType(after[index]) });
        else if (index >= after.length) add({ path: itemPath, operation: "remove", oldValue: before[index], oldType: valueType(before[index]) });
        else walk(before[index], after[index], itemPath);
      }
      return;
    }
    if (before && typeof before === "object") {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of keys) {
        const itemPath = childPath(path, key, false);
        if (!Object.prototype.hasOwnProperty.call(after, key)) add({ path: itemPath, operation: "remove", oldValue: before[key], oldType: valueType(before[key]) });
        else if (!Object.prototype.hasOwnProperty.call(before, key)) add({ path: itemPath, operation: "add", newValue: after[key], newType: valueType(after[key]) });
        else walk(before[key], after[key], itemPath);
      }
      return;
    }
    if (!Object.is(before, after)) add({ path, operation: "replace", oldValue: before, newValue: after, oldType: beforeType, newType: afterType });
  };
  walk(left, right, "$");
  return { results, limited: results.length >= MAX_DIFF_RESULTS };
}

self.onmessage = (event) => {
  const { id, mode, source, rightSource, indent = "2", sortKeys = false, query = "$", applyOutput = false, diffOptions = {} } = event.data;
  const startedAt = performance.now();
  try {
    if (!source.trim()) {
      self.postMessage({ id, mode, ok: false, validation: { valid: false, message: "尚未輸入 JSON" }, stats: { lines: 0, chars: 0, keys: 0 }, duration: 0 });
      return;
    }
    const parsed = JSON.parse(source);
    if (mode === "compare") {
      let right;
      try { right = JSON.parse(rightSource); }
      catch (error) {
        self.postMessage({ id, mode, ok: false, side: "right", validation: locateError(rightSource, error), duration: performance.now() - startedAt });
        return;
      }
      const comparison = diffJson(parsed, right, diffOptions);
      self.postMessage({ id, mode, ok: true, diffs: comparison.results, limited: comparison.limited, duration: performance.now() - startedAt });
      return;
    }
    const value = sortKeys ? sortObject(parsed) : parsed;
    const stats = {
      lines: source.split("\n").length,
      chars: new TextEncoder().encode(source).length,
      keys: countKeys(parsed),
    };
    if (mode === "query") {
      const matches = queryJsonPath(parsed, query);
      self.postMessage({ id, mode, ok: true, matches, limited: matches.length >= MAX_QUERY_RESULTS, duration: performance.now() - startedAt });
      return;
    }
    const output = mode === "minify"
      ? JSON.stringify(value)
      : JSON.stringify(value, null, indent === "tab" ? "\t" : Number(indent));
    self.postMessage({
      id,
      mode,
      ok: true,
      output,
      stats,
      validation: { valid: true, message: "語法正確" },
      applyOutput,
      duration: performance.now() - startedAt,
    });
  } catch (error) {
    const validation = mode === "query"
      ? { valid: false, message: error instanceof Error ? error.message : "JSONPath 查詢失敗" }
      : locateError(source, error);
    self.postMessage({
      id,
      mode,
      ok: false,
      ...(mode === "compare" ? { side: "left" } : {}),
      validation,
      stats: { lines: source ? source.split("\n").length : 0, chars: new TextEncoder().encode(source).length, keys: 0 },
      duration: performance.now() - startedAt,
    });
  }
};
