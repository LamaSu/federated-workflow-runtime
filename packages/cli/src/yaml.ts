/**
 * Minimal YAML subset parser.
 *
 * Why this exists: the CLI package declares `js-yaml` as a dependency per the
 * ARCHITECTURE spec, but to keep the v1 scaffold working against the pinned
 * lockfile without adding new deps, we ship a small inline parser that covers
 * the subset Chorus config/workflow files actually use:
 *
 *   - nested mappings (2-space indent)
 *   - sequences (`-` items, either inline or nested mappings)
 *   - scalar values: strings (quoted or bare), numbers, booleans, null
 *   - comments starting with `#`
 *   - JSON-flow scalars on RHS (we fall back to JSON.parse for { or [)
 *
 * What it does NOT support: anchors (&/*), tags (!!foo), block scalars
 * (| / >), multi-doc streams. If you need those, swap in js-yaml — the
 * exported API (`parseYaml`/`stringifyYaml`) matches it 1:1 for the happy path.
 *
 * YAML is a superset of JSON, so any valid JSON file passed here also parses.
 */

export class YamlParseError extends Error {
  constructor(message: string, public line: number) {
    super(`YAML parse error at line ${line + 1}: ${message}`);
    this.name = "YamlParseError";
  }
}

type Cursor = { lines: string[]; i: number };

/**
 * Parse a YAML document. Returns `unknown` — callers (which should be
 * zod-schema-backed) are responsible for validating the shape.
 */
export function parseYaml(text: string): unknown {
  // Fast path: JSON is valid YAML — if the input starts with { or [ we try
  // JSON.parse first, which handles quotes/escapes correctly.
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to YAML parsing — maybe it's a flow-style YAML that
      // isn't strict JSON.
    }
  }

  const lines = text.split(/\r?\n/);
  const cursor: Cursor = { lines, i: 0 };
  skipBlank(cursor);
  if (cursor.i >= cursor.lines.length) return null;

  const firstLine = cursor.lines[cursor.i] ?? "";
  const firstIndent = getIndent(firstLine);
  const firstContent = firstLine.slice(firstIndent);
  if (firstContent.startsWith("- ") || firstContent === "-") {
    return parseSequence(cursor, firstIndent);
  }
  return parseMapping(cursor, firstIndent);
}

/**
 * Stringify a value back to YAML. Round-trips for the parsed subset.
 * Not used by the runtime directly; helpful for CLI "write config" flows.
 */
export function stringifyYaml(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return `${pad}null\n`;
  if (typeof value === "string") return `${pad}${serializeScalar(value)}\n`;
  if (typeof value === "number" || typeof value === "boolean") return `${pad}${value}\n`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const body = stringifyYaml(item, indent + 2)
            .split("\n")
            .filter((l) => l.length > 0);
          if (body.length === 0) return `${pad}- {}`;
          return [`${pad}- ${body[0]!.slice(indent + 2)}`, ...body.slice(1)].join("\n");
        }
        return `${pad}- ${serializeScalar(item)}`;
      })
      .join("\n") + "\n";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}\n`;
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === "object") {
          if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`;
          if (!Array.isArray(v) && Object.keys(v as object).length === 0) return `${pad}${k}: {}`;
          return `${pad}${k}:\n${stringifyYaml(v, indent + 2).replace(/\n$/, "")}`;
        }
        return `${pad}${k}: ${serializeScalar(v)}`;
      })
      .join("\n") + "\n";
  }
  return `${pad}${String(value)}\n`;
}

// ── Internals ──────────────────────────────────────────────────────────────

function skipBlank(cursor: Cursor): void {
  while (cursor.i < cursor.lines.length) {
    const line = cursor.lines[cursor.i];
    if (line === undefined) break;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      cursor.i++;
      continue;
    }
    break;
  }
}

function getIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

function stripInlineComment(s: string): string {
  // Find a `#` preceded by space (or at start), and trim from there. We don't
  // parse quoted strings to protect `#` inside them — that's YAML's rule
  // actually (comments must be preceded by whitespace), so this is safe.
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function parseMapping(cursor: Cursor, indent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  while (cursor.i < cursor.lines.length) {
    skipBlank(cursor);
    if (cursor.i >= cursor.lines.length) break;
    const raw = cursor.lines[cursor.i] ?? "";
    const curIndent = getIndent(raw);
    if (curIndent < indent) break;
    if (curIndent > indent) {
      throw new YamlParseError(`unexpected indent (expected ${indent}, got ${curIndent})`, cursor.i);
    }
    const line = stripInlineComment(raw).slice(indent);
    if (line.startsWith("- ") || line === "-") {
      throw new YamlParseError("sequence item at mapping level", cursor.i);
    }
    const colonIdx = findMapColon(line);
    if (colonIdx === -1) {
      throw new YamlParseError(`expected 'key: value' (got '${line}')`, cursor.i);
    }
    const key = unquoteKey(line.slice(0, colonIdx).trim());
    const valuePart = line.slice(colonIdx + 1).trim();
    cursor.i++;
    if (valuePart === "" || valuePart === "|" || valuePart === ">") {
      // Nested mapping or sequence — peek at next non-blank line.
      skipBlank(cursor);
      if (cursor.i >= cursor.lines.length) {
        result[key] = null;
        continue;
      }
      const nextRaw = cursor.lines[cursor.i] ?? "";
      const nextIndent = getIndent(nextRaw);
      const nextContent = nextRaw.slice(nextIndent);
      if (nextIndent <= indent) {
        result[key] = null;
        continue;
      }
      if (nextContent.startsWith("- ") || nextContent === "-") {
        result[key] = parseSequence(cursor, nextIndent);
      } else {
        result[key] = parseMapping(cursor, nextIndent);
      }
    } else {
      result[key] = parseScalar(valuePart);
    }
  }
  return result;
}

function parseSequence(cursor: Cursor, indent: number): unknown[] {
  const items: unknown[] = [];
  while (cursor.i < cursor.lines.length) {
    skipBlank(cursor);
    if (cursor.i >= cursor.lines.length) break;
    const raw = cursor.lines[cursor.i] ?? "";
    const curIndent = getIndent(raw);
    if (curIndent < indent) break;
    if (curIndent > indent) {
      throw new YamlParseError(`unexpected indent in sequence`, cursor.i);
    }
    const line = stripInlineComment(raw).slice(indent);
    if (!line.startsWith("-")) break;
    const itemBody = line.slice(1).replace(/^\s+/, "");
    cursor.i++;
    if (itemBody === "") {
      // Nested mapping under "- "
      skipBlank(cursor);
      if (cursor.i >= cursor.lines.length) {
        items.push(null);
        continue;
      }
      const nextRaw = cursor.lines[cursor.i] ?? "";
      const nextIndent = getIndent(nextRaw);
      if (nextIndent <= indent) {
        items.push(null);
        continue;
      }
      const nextContent = nextRaw.slice(nextIndent);
      if (nextContent.startsWith("- ") || nextContent === "-") {
        items.push(parseSequence(cursor, nextIndent));
      } else {
        items.push(parseMapping(cursor, nextIndent));
      }
    } else if (isInlineMapping(itemBody)) {
      // Inline map starting on `- key: value` — parse as a mapping whose
      // first entry is on this line, and subsequent entries are indented
      // 2 more than the `-`.
      const innerIndent = indent + 2;
      // Re-wind to parse as mapping, but we must handle the first-line
      // inline-ness. Easiest: synthesize a virtual line.
      const virtualLine = " ".repeat(innerIndent) + itemBody;
      cursor.lines.splice(cursor.i, 0, virtualLine);
      items.push(parseMapping(cursor, innerIndent));
    } else {
      items.push(parseScalar(itemBody));
    }
  }
  return items;
}

/**
 * Return the column of the mapping `:` separator, or -1 if none. We have to
 * skip `:` inside quoted strings and inline JSON values.
 */
function findMapColon(line: string): number {
  let inQuote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === ":" && depth === 0) {
      // Require a space (or EOL) after to count as YAML separator
      const next = line[i + 1];
      if (next === undefined || next === " " || next === "\t") return i;
    }
  }
  return -1;
}

function isInlineMapping(body: string): boolean {
  return findMapColon(body) !== -1;
}

function unquoteKey(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (s.startsWith('"') && s.endsWith('"')) {
    // Double-quoted — JSON-parse so escapes work.
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    // Single-quoted — only '' → ' escape.
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d*\.\d+([eE][-+]?\d+)?$/.test(s) || /^-?\d+[eE][-+]?\d+$/.test(s)) {
    return Number(s);
  }
  return s;
}

function serializeScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Quote if it contains YAML-significant chars or would parse as non-string.
    if (/^[\s]|[\s]$|[:#{}[\],&*!|>'"%@`]/.test(value) || /^(true|false|null|~|\d)/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  return JSON.stringify(value);
}
