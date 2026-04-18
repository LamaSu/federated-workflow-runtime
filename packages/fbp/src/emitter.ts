// Serialize an FbpAst back to FBP text. The `fbp` package ships a
// serializer, but its edge-case behavior around non-string data and
// missing ports is underdocumented, so we own a small string-template
// implementation that matches the subset of FBP we round-trip.
//
// Grammar we emit (per flowbased/fbp README):
//   # @prop value            ← metadata comment lines
//   A(Component) OUT -> IN B(Component)
//   'data' -> IN Target
//   INPORT=Process.PORT:NAME
//   OUTPORT=Process.PORT:NAME

import type { FbpAst } from "./types.js";

/**
 * Emit FBP text for an AST. The output is normalized — one connection per
 * line, components declared on first mention, no indentation — so round-trip
 * diffs are whitespace-stable.
 */
export function emitFbp(ast: FbpAst): string {
  const lines: string[] = [];

  // @prop comments (from properties). Only string values and safe prop
  // names are emitted, matching the fbp package's serializer.
  if (ast.properties) {
    const env = (ast.properties as Record<string, unknown>)["environment"];
    if (env && typeof env === "object") {
      const type = (env as Record<string, unknown>)["type"];
      if (typeof type === "string") {
        lines.push(`# @runtime ${type}`);
      }
    }
    for (const [prop, raw] of Object.entries(ast.properties)) {
      if (prop === "environment") continue;
      if (!/^[a-zA-Z0-9\-_]+$/.test(prop)) continue;
      if (typeof raw !== "string") continue;
      if (!/^[a-zA-Z0-9\-_\s.]+$/.test(raw)) continue;
      lines.push(`# @${prop} ${raw}`);
    }
  }

  // INPORT / OUTPORT declarations
  for (const [name, p] of Object.entries(ast.inports ?? {})) {
    lines.push(`INPORT=${p.process}.${p.port.toUpperCase()}:${name.toUpperCase()}`);
  }
  for (const [name, p] of Object.entries(ast.outports ?? {})) {
    lines.push(`OUTPORT=${p.process}.${p.port.toUpperCase()}:${name.toUpperCase()}`);
  }
  if (lines.length > 0) {
    lines.push("");
  }

  // Connections — the meat of the graph. Track which process names have
  // already had their component declared so we don't repeat `A(Comp)` on
  // every line.
  const declared = new Set<string>();
  const declare = (name: string): string => {
    const proc = ast.processes[name];
    if (!proc) return name;
    if (declared.has(name)) return name;
    declared.add(name);
    return `${name}(${proc.component})`;
  };

  for (const conn of ast.connections) {
    const tgtPort = conn.tgt.port.toUpperCase();
    const tgt = declare(conn.tgt.process);
    if (conn.data !== undefined) {
      // IIP (initial information packet)
      const lit = formatLiteral(conn.data);
      lines.push(`${lit} -> ${tgtPort} ${tgt}`);
      continue;
    }
    if (!conn.src) {
      // Defensive — an AST without src or data is malformed. Skip rather
      // than throwing so callers can still emit partial graphs.
      continue;
    }
    const srcPort = conn.src.port.toUpperCase();
    const src = declare(conn.src.process);
    lines.push(`${src} ${srcPort} -> ${tgtPort} ${tgt}`);
  }

  // Any processes that never appeared in a connection — declare them
  // standalone so they're not silently dropped. FBP permits a dangling
  // node line like `A(Comp)`.
  for (const name of Object.keys(ast.processes)) {
    if (!declared.has(name)) {
      lines.push(declare(name));
    }
  }

  return lines.join("\n");
}

/**
 * Render a JS value as an FBP literal. The FBP grammar supports quoted
 * strings, numbers, and bracketed JSON-ish forms; we keep it narrow:
 * string → single-quoted with backslash escaping, number → decimal,
 * boolean/null → literal keyword, everything else → JSON.
 */
function formatLiteral(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  // Objects/arrays: JSON stringify then single-quote wrap to stay valid FBP.
  return `'${JSON.stringify(value).replace(/'/g, "\\'")}'`;
}
