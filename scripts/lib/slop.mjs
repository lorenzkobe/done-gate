import { diffTextOf } from "./rules.mjs";
import { contentAt, parseHunks } from "./tree.mjs";

// The greppable slop patterns from antislop-code, scanned over the added lines of a diff.
// Judgment calls (a comment that restates the code, a hedging name, comment length) stay
// with the reviewer.

const MARKERS = /\/\/|\/\*|<!--|--|#|^\s*\*(?!\/)/g;

// The quote char still open at index end, or null; a different quote inside an open string
// and a backslash-escaped quote do not count.
export function openQuoteAt(line, end) {
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

const SKIP_ADDED = /\.skip\(|\bx(?:it|test|describe)\(|\bpytest\.mark\.skip|\bt\.Skip(?:Now|f)?\(|@Disabled\b/;
const SUPPRESSION = /\beslint-disable|@ts-ignore|\bnoqa\b|\bnolint\b/i;
const TEST_NAME = /^\s*(?:(it|test|describe|xit|xtest|xdescribe)((?:\.\w+)*)\s*\(\s*(["'`])(.+?)\3|def\s+(test_\w+)|func\s+(Test\w+))/;

// A test declared on this line: its name, and whether it runs. A line opening with a comment
// marker declares nothing, so a test commented out is a test gone.
function declared(line) {
  const m = TEST_NAME.exec(line);
  if (!m) return null;
  return { name: m[4] ?? m[5] ?? m[6], live: !/^x/.test(m[1] ?? "") && !/\.skip\b/.test(m[2] ?? "") };
}

const shown = (line) => (line.trim().length > 80 ? `${line.trim().slice(0, 77)}...` : line.trim());

function codeFinding(raw) {
  const comment = commentOf(raw);
  if (comment && SUPPRESSION.test(comment.body)) return `suppression added: ${shown(raw)}`;
  if (/#\s*noqa\b/i.test(raw)) return `suppression added: ${shown(raw)}`;
  const code = comment ? comment.before : raw;
  const at = code.search(SKIP_ADDED);
  return at >= 0 && !openQuoteAt(code, at) ? `skip added: ${shown(raw)}` : null;
}

// What this task did to its tests, as lines for the report: skips and suppressions added, test files
// deleted, tests removed. A test that reappears anywhere under its name was moved or skipped, not
// removed, and in one file a new running test offsets one that went, as a rename does. Advice only:
// no rule reads it.
export function weakened(state) {
  const { config, changed, diff, ledger } = state;
  const out = [];
  const addedNames = new Set();
  const files = [];
  for (const rel of changed.filter((p) => !config.isDoc(p))) {
    const isTest = config.isTest(rel);
    if (diff?.deleted?.includes(rel)) {
      if (isTest) files.push({ rel, deleted: true, removed: contentAt(state.root, ledger.baseline?.head, rel).split("\n").map(declared).filter(Boolean).map((d) => d.name), live: [] });
      continue;
    }
    const file = { rel, removed: [], live: [] };
    for (const hunk of parseHunks(diffTextOf(state, rel)).hunks) {
      for (const l of hunk.lines) {
        const raw = l.text.slice(1);
        if (l.tag === "+") {
          const finding = codeFinding(raw);
          if (finding) out.push(`${rel}: ${finding}`);
        }
        const decl = isTest && (l.tag === "+" || l.tag === "-") ? declared(raw) : null;
        if (!decl) continue;
        if (l.tag === "-") file.removed.push(decl.name);
        else {
          addedNames.add(decl.name);
          if (decl.live) file.live.push(decl.name);
        }
      }
    }
    if (isTest) files.push(file);
  }
  for (const { rel, deleted, removed, live } of files) {
    const gone = removed.filter((name) => !addedNames.has(name));
    if (deleted) {
      if (!removed.length || gone.length) out.push(`${rel}: test file deleted`);
      continue;
    }
    const renamedTo = live.filter((name) => !removed.includes(name)).length;
    for (const name of gone.slice(renamedTo)) out.push(`${rel}: test removed: ${name}`);
  }
  return out;
}
