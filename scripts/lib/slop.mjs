import { parseHunks } from "./tree.mjs";

// The greppable slop patterns from antislop-code, scanned over the added lines of a diff.
// Judgment calls (a comment that restates the code, a hedging name, comment length) stay
// with the reviewer.

const MARKERS = /\/\/|\/\*|<!--|--|#|^\s*\*(?!\/)/g;

// The quote char still open at index end, or null; a different quote inside an open string
// and a backslash-escaped quote do not count.
function openQuoteAt(line, end) {
  let open = null;
  for (let i = 0; i < end; i++) {
    const ch = line[i];
    if (ch === "\\" && open) i += 1;
    else if (open) open = ch === open ? null : open;
    else if (ch === "'" || ch === '"' || ch === "`") open = ch;
  }
  return open;
}

// The comment on one line as {body, before}, or null. A marker inside a string literal is
// text; // after a colon is a URL; # before a word char is a CSS id or a shebang.
function commentOf(line) {
  MARKERS.lastIndex = 0;
  let m;
  while ((m = MARKERS.exec(line))) {
    const marker = m[0].trim();
    const at = m.index + m[0].indexOf(marker);
    const before = line.slice(0, at);
    if (marker === "//" && before.endsWith(":")) continue;
    if (marker === "#" && /[\w!]/.test(line[at + 1] ?? "")) continue;
    if (marker === "--" && (line[at + 2] === "-" || before.endsWith("-") || /\w$/.test(before))) continue;
    if (openQuoteAt(line, at)) continue;
    const body = line.slice(at + marker.length).replace(/\*\/\s*$|-->\s*$/, "").trim();
    return { body, before: before.trim() };
  }
  return null;
}

const LABELS = new Set([
  "main logic", "core logic", "business logic", "logic", "helper", "helpers", "helper function", "helper functions", "utils", "utilities",
  "entry point", "error handling", "imports", "exports", "constants", "types", "variables", "initialization", "initialisation", "setup",
  "cleanup", "implementation", "main", "handlers", "config", "configuration", "validation", "processing",
]);

const PATTERNS = [
  ["banner", ({ body }) => /^([=\-*#~_])\1{4,}/.test(body) || /([=\-*#~_])\1{4,}\s*$/.test(body)],
  ["step narration", ({ body }) => /^step\s*\d+\s*[:.)-]/i.test(body)],
  ["empty label", ({ body }) => LABELS.has(body.replace(/[:.]\s*$/, "").toLowerCase())],
  ["end marker", ({ body, before }) => /^end of\b/i.test(body) || (/[})\]]\s*;?$/.test(before) && /^end\b/i.test(body))],
  ["emoji", ({ body }) => /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u203C\u2049]/u.test(body)],
  ["todo", ({ body }) => /^(?:todo|fixme|xxx)\b\s*:?\s*(?:|improve(?: this)?|fix(?: this)?|(?:fix )?later|clean ?up|refactor|optimi[sz]e|handle this|more validation|add more \w+)\s*\.?$/i.test(body)],
  ["signature echo", ({ body }) => {
    const m = /^@param\s+(?:\{[^}]*\}\s+)?(\w+)\s+-?\s*(?:the\s+)?(\w+)\s*\.?$/i.exec(body);
    return Boolean(m) && m[1].toLowerCase() === m[2].toLowerCase();
  }],
];

// Every slop hit on an added line: {line, pattern, text}, in file order.
export function scanDiff(text) {
  const out = [];
  for (const h of parseHunks(text).hunks) {
    for (const l of h.lines) {
      if (l.tag !== "+") continue;
      const raw = l.text.slice(1);
      const comment = commentOf(raw);
      if (!comment) continue;
      const found = PATTERNS.find(([, test]) => test(comment));
      if (found) out.push({ line: l.pos, pattern: found[0], text: raw.trim() });
    }
  }
  return out;
}
