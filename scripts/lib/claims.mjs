import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// A deliberately narrow lexicon: sentences that assert a verification outcome. "done"
// alone is not a claim (it names the gate and appears in every ask); "tests pass" is.
const CLAIM_RE =
  /\b(?:tests? (?:pass|passes|passed|are green|all pass)|(?:build|lint|typecheck) (?:passes|passed|succeeds|succeeded|is (?:green|clean))|all green|everything passes|verified|works as expected|now works|is fixed|fixed it|confirmed working|no regressions?)\b/i;
const LABEL_RE = /\[(measured|inferred|guess)\](?:\s*\(([^)]+)\))?/g;

function skipLine(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#") || t.startsWith(">") || t.startsWith("PAUSED:") || t.startsWith("|") || t.startsWith("<!--");
}

export function lintClaims(text, resolves) {
  const findings = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "").replace(/`[^`]*`/g, ""); // inline code is never a claim
    if (skipLine(line)) continue;
    const labels = [...line.matchAll(LABEL_RE)];
    for (const m of labels) {
      if (m[1] === "measured" && (!m[2] || !resolves(m[2].trim()))) {
        findings.push({ kind: "unresolved", line: line.trim(), pointer: m[2]?.trim() ?? null });
      }
    }
    if (labels.length === 0 && CLAIM_RE.test(line)) findings.push({ kind: "unlabelled", line: line.trim() });
  }
  return findings;
}

// Builds the "does this pointer resolve" predicate from gate state.
export function pointerResolver(state) {
  return (ptr) => {
    if (!ptr) return false;
    if (ptr === "ledger.md" || ptr === "ledger.json" || ptr === "report.md" || ptr === "decisions.tsv") return true;
    if (/^ledger\.(md|json)#/.test(ptr)) return true;
    if (ptr === "verify.json" || /^verify#\d+$/.test(ptr)) return Boolean(state.verify);
    if (/^events#\d+$/.test(ptr)) {
      const seq = Number(ptr.slice(7));
      return (state.events ?? []).some((e) => e.seq === seq);
    }
    if (/^(?:review|skeptic|arbiter)-\d+\.md$/.test(ptr)) return (state.reviews ?? []).includes(ptr);
    if (/^decisions#\d+$/.test(ptr)) {
      // the row must exist: decisions.tsv has a header line, then one row per decision
      const file = state.dir ? path.join(state.dir, "decisions.tsv") : null;
      if (!file || !existsSync(file)) return false;
      const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length - 1;
      return Number(ptr.slice(10)) >= 1 && Number(ptr.slice(10)) <= rows;
    }
    const file = ptr.split(":")[0];
    return [state.dir, state.root].filter(Boolean).some((base) => existsSync(path.join(base, file)));
  };
}

function normalise(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

function userText(record) {
  const msg = record?.message ?? record;
  const isUser = record?.type === "user" || msg?.role === "user";
  if (!isUser) return "";
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

// true / false, or null when the transcript cannot be read (unknown, not a lie).
export function findQuoteInTranscript(file, quote) {
  if (!file || !existsSync(file)) return null;
  const needle = normalise(quote);
  if (needle.length < 4) return false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (normalise(userText(record)).includes(needle)) return true;
  }
  return false;
}
