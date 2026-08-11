const MAX_QUERY_RESULTS = 100;

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

self.onmessage = (event) => {
  const { id, mode, source, indent = "2", sortKeys = false, query = "$", applyOutput = false } = event.data;
  const startedAt = performance.now();
  try {
    if (!source.trim()) {
      self.postMessage({ id, mode, ok: false, validation: { valid: false, message: "尚未輸入 JSON" }, stats: { lines: 0, chars: 0, keys: 0 }, duration: 0 });
      return;
    }
    const parsed = JSON.parse(source);
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
      validation,
      stats: { lines: source ? source.split("\n").length : 0, chars: new TextEncoder().encode(source).length, keys: 0 },
      duration: performance.now() - startedAt,
    });
  }
};
