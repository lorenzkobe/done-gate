import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { effectiveTier, leadDelegates, policyFor, requires } from "./size.mjs";
import { baseCopy, changedUnits, fileDiff, gitTracked, hasReindent, indentMatters, sliceEnd } from "./tree.mjs";
import { scanDiff } from "./slop.mjs";
import { toPosixRel } from "./paths.mjs";

const SLOP_SHOWN = 12;

// Named repo checks, opted into via gate.json "checks" (slop runs on every open ledger
// unless gate.json says "slop": false; test files keep their separator style). Each
// returns an unmet text or null.
const CHECKS = {
  slop: (state) => {
    const { config, changed, diff } = state;
    const hits = [];
    for (const rel of changed) {
      if (!config.isSource(rel) || config.isDoc(rel) || config.isTest(rel) || diff?.deleted?.includes(rel)) continue;
      for (const h of scanDiff(diffTextOf(state, rel))) hits.push(`${rel}:${h.line} ${h.pattern} ${JSON.stringify(h.text)}`);
    }
    if (!hits.length) return null;
    const rest = hits.length - SLOP_SHOWN;
    return `${hits.length} slop line${hits.length === 1 ? "" : "s"} in this task's diff: ${hits.slice(0, SLOP_SHOWN).join(", ")}${rest > 0 ? `, and ${rest} more` : ""}. Fix them (a comment says why, or it goes), or for a true false positive get the user's waiver (\`gate waive slop "<reason>"\`).`;
  },
  "claude-md-budget": ({ root, changed }) => {
    const file = path.join(root, "CLAUDE.md");
    if (!existsSync(file)) return null;
    if (!changed.includes("CLAUDE.md")) return null;
    const size = statSync(file).size;
    return size > 150_000 ? `CLAUDE.md is ${size} chars, over the 150000 budget an assistant can load. Move detail into the linked docs before closing.` : null;
  },
  "migration-number": ({ root, changed }) => {
    const added = changed.filter((p) => /^supabase\/migrations\/\d{4}_.*\.sql$/.test(p));
    if (!added.length) return null;
    const dir = path.join(root, "supabase", "migrations");
    const max = Math.max(...readdirSync(dir).map((f) => Number(/^(\d{4})_/.exec(f)?.[1] ?? 0)));
    const claude = path.join(root, "CLAUDE.md");
    if (!existsSync(claude)) return null;
    const m = /Next number:\s*`?(\d{4})`?/.exec(readFileSync(claude, "utf8"));
    if (!m) return "CLAUDE.md has no `Next number:` line for migrations.";
    const expected = String(max + 1).padStart(4, "0");
    return m[1] === expected ? null : `migration ${String(max).padStart(4, "0")} was added but CLAUDE.md says the next number is ${m[1]}; it should say ${expected}.`;
  },
};

export function runChecks(state) {
  const { config, ledger } = state;
  const out = [];
  const names = new Set(config.checks ?? []);
  if (config.slop !== false && ledger && !waived(ledger, "slop")) names.add("slop");
  for (const name of names) {
    const fn = CHECKS[name];
    if (!fn) {
      out.push(`unknown check "${name}" in gate.json (have: ${Object.keys(CHECKS).join(", ")})`);
      continue;
    }
    try {
      const text = fn(state);
      if (text) out.push(`${name}: ${text}`);
    } catch (error) {
      out.push(`${name} could not run: ${error.message}`);
    }
  }
  return out;
}

// Readers for the files helpers write: a reviewer's or skeptic's findings, a reviewer's
// answers to disputes, and an arbiter's ruling. Bullets only; prose is ignored.

function sectionLines(text, heading) {
  const re = new RegExp(`^## ${heading}\\s*:?[ \\t]*$`, "m");
  const m = re.exec(String(text ?? "").replace(/\r/g, ""));
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length);
  const end = /^## /m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).split("\n");
}

// "-", "*", "1." and "1)" all open a list item: a numbered finding is still a finding
const BULLET = /^(\s*)(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;
// A bullet that opens with "none" or "n/a" is an empty section, whatever follows ("none found
// for this piece", "none. I traced …"); so is "nothing" alone or "nothing found". "None of the
// callers …" and "Nothing tests …" are findings.
const EMPTY = /^(?:none(?!\s+of\b)\b|n\/a\b|nothing\s*(?:$|[.,;:!—–(-])|nothing\s+(?:found|to act on|here|so far)\b)/i;

// The bullets at the section's outermost indent; a deeper bullet is a sub-point of the
// finding above it.
function bullets(lines) {
  const found = lines.map((raw) => BULLET.exec(raw)).filter(Boolean).map((m) => ({ indent: m[1].length, text: m[2].trim() }));
  const top = Math.min(...found.map((b) => b.indent));
  return found.filter((b) => b.indent === top && !EMPTY.test(b.text)).map((b) => b.text);
}

// A helper cut off mid-write leaves its draft-first placeholder behind: every section reads
// "- unverified", or "- <label>: unverified" in a verdict section. Shape-agnostic (no heading
// lookup), so it also catches an arbiter's Ruling-only stub, which has no "## Act on" section
// at all. Built on bullets(), so a "- none" placeholder (agents/reviewer.md's Dismissed
// section) is dropped the same way parseFindings drops it.
export function isDraft(text) {
  const found = bullets(String(text ?? "").replace(/\r/g, "").split("\n"));
  return found.length > 0 && found.every((b) => /^(?:[^:]{1,40}:\s*)?unverified[\s.,;:!-]*$/i.test(b));
}

// Past the draft, but a section still reads the bare "- unverified": the helper was cut off.
// A verdict line ("tests: … unverified") is a finished line, not a placeholder.
export function isPartial(text) {
  if (isDraft(text)) return false;
  return bullets(String(text ?? "").replace(/\r/g, "").split("\n")).some((b) => /^unverified[\s.,;:!-]*$/i.test(b));
}

// Every Act-on bullet of a helper file. "none" and a missing section are empty.
export function parseFindings(text) {
  return bullets(sectionLines(text, "Act on")).map((t) => ({ text: t }));
}

const VERDICT = /^(H\d+\.\d+)\s*[—–-]+\s*(withdrawn|upheld)\s*:\s*(.*)$/i;

// A reviewer's answers to disputed items: `- H1.2 — withdrawn: reason` / `upheld: reason`.
export function parseDisputes(text) {
  const out = [];
  for (const b of bullets(sectionLines(text, "Disputes"))) {
    const m = VERDICT.exec(b);
    if (m) out.push({ id: m[1], verdict: m[2].toLowerCase(), reason: m[3].trim() });
  }
  return out;
}

const REPLY = /^(H\d+\.\d+)\s*[—–-]+\s*(fixed|disagree)\s*:\s*(.*)$/i;

// A worker's answers to review findings: `- H1.2 — fixed: <pointer>` or
// `- H1.2 — disagree: <why> — <pointer>`.
export function parseReplies(text) {
  const out = [];
  for (const b of bullets(sectionLines(text, "Replies"))) {
    const m = REPLY.exec(b);
    if (!m) continue;
    if (m[2].toLowerCase() === "fixed") {
      out.push({ id: m[1], kind: "fixed", pointer: m[3].trim() });
    } else {
      const parts = m[3].split(/\s+[—–-]+\s+/);
      const pointer = parts.length > 1 ? parts.pop().trim() : null;
      out.push({ id: m[1], kind: "disagree", why: parts.join(" — ").trim(), pointer });
    }
  }
  return out;
}

const RULING = /^(H\d+\.\d+)\s*[—–-]+\s*(implementer|reviewer)\s*:\s*(.*)$/i;

// An arbiter's ruling: `- H1.2 — implementer: reason` / `reviewer: reason`.
export function parseRuling(text) {
  const out = [];
  for (const b of bullets(sectionLines(text, "Ruling"))) {
    const m = RULING.exec(b);
    if (m) out.push({ id: m[1], side: m[2].toLowerCase(), reason: m[3].trim() });
  }
  return out;
}

// The Context note's three parts, each a line starting with its name.
export const CONTEXT_PARTS = ["Traced", "Related", "Research"];

const POINTER = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]+):(\d+)\b/gi;

// A part starts at a line start or after whitespace ("Traced: … · Related: …" on one line).
export function contextPart(text, name) {
  const m = new RegExp(`(?:^|\\s)${name}:\\s*([\\s\\S]*?)(?=(?:^|\\s)(?:${CONTEXT_PARTS.join("|")}):|$(?![\\s\\S]))`, "mi").exec(text);
  return m ? m[1].replace(/[\s·|]+$/, "").trim() : null;
}

// Every file:line pointer in a text, with whether it names a file inside root: a pointer
// that walks out of the repo (`../x.ts:1`) or names a directory does not resolve.
export function tracedPointers(text, root) {
  const out = [];
  for (const m of String(text ?? "").matchAll(POINTER)) {
    const abs = path.resolve(root, m[1]);
    const inside = !path.relative(root, abs).startsWith("..") && !path.isAbsolute(path.relative(root, abs));
    let exists = false;
    try {
      exists = inside && statSync(abs).isFile();
    } catch {
      exists = false;
    }
    out.push({ file: m[1], line: Number(m[2]), exists });
  }
  return out;
}

// Builds the "does this pointer resolve" predicate from gate state; dispute and resolve
// evidence must point at something real.
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
    if (/^(?:review2?|skeptic|arbiter)-\d+\.md$/.test(ptr)) return (state.reviews ?? []).includes(ptr);
    if (/^worker-\d+\.md$/.test(ptr)) return Boolean(state.dir) && existsSync(path.join(state.dir, ptr));
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

// Hash of the SOURCE files in a snapshot. verify.json stores it, so a docs or ledger
// edit after `gate verify` does not force a re-run, but any source edit does.
export function sourceHash(snap, config) {
  const digest = createHash("sha1");
  for (const rel of Object.keys(snap?.files ?? {}).sort()) {
    if (config.isSource(rel)) digest.update(`${rel}\0${snap.files[rel].h}\n`);
  }
  return digest.digest("hex");
}

// Source minus tests: the freshness clock for R4/R5. QA's test files move the source hash
// (tests are source) but are agent work, which the "last edit" has always excluded.
export function implementationHash(snap, config) {
  const digest = createHash("sha1");
  for (const rel of Object.keys(snap?.files ?? {}).sort()) {
    if (config.isSource(rel) && !config.isTest(rel)) digest.update(`${rel}\0${snap.files[rel].h}\n`);
  }
  return digest.digest("hex");
}

function list(paths, max = 3) {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown}, +${paths.length - max} more` : shown;
}

export function isRole(agentType, role) {
  return agentType === `done-gate:${role}` || agentType === role;
}

// The last moment source changed: the newest Edit/Write event by the main session, or the
// moment the source hash moved (edits made with sed, perl or git apply leave no tool event).
// An implementation edit: a source edit by anyone but QA (the lead, a worker, or any other
// agent the lead spawned). QA's test edits and helper file writes are not implementation.
export function implementationEdit(e, config) {
  return e.kind === "edit" && Boolean(e.path) && config.isSource(e.path) && !isRole(e.agentType, "qa");
}

export function lastEditSeq(state, config, ledger) {
  const edits = (state.events ?? []).filter((e) => implementationEdit(e, config));
  const fromEvents = edits.length ? edits[edits.length - 1].seq : (ledger.baseline?.seq ?? 0);
  return Math.max(fromEvents, ledger.lastSourceChangeSeq ?? 0);
}

export function fileRole(name) {
  return name.startsWith("review2-") ? "reviewer-2" : name.startsWith("review-") ? "reviewer" : name.startsWith("skeptic-") ? "skeptic" : name.startsWith("arbiter-") ? "arbiter" : "worker";
}

// The brief that named a helper file: reviewer pieces under ledger.seen, the other roles
// under ledger.briefed (kept apart so a ledger with no seen map stays a legacy one).
export function briefOf(ledger, file) {
  return ledger.seen?.[file] ?? ledger.briefed?.[file] ?? null;
}

// A stop event at max turns is not proven to arrive, so a helper silent for longer than
// this counts as gone.
export const HELPER_MAX_MS = 45 * 60 * 1000;

// Who worked on a helper file since its brief, per agent id: the agents that wrote it, or
// with none, those of the role started since. Silence is measured from an agent's newest event.
export function helperRun(state, role, file, since, now = Date.now()) {
  const rel = toPosixRel(state.root, path.join(state.dir, file));
  const events = (state.events ?? []).filter((e) => e.seq > since && e.agent && isRole(e.agentType, role));
  const writers = events.filter((e) => e.kind === "edit" && e.path === rel).map((e) => e.agent);
  const ids = [...new Set(writers.length ? writers : events.filter((e) => e.kind === "subagent-start").map((e) => e.agent))];
  const running = ids.some((id) => {
    const own = events.filter((e) => e.agent === id);
    return now - Date.parse(own[own.length - 1].ts) < HELPER_MAX_MS && !own.some((e) => e.kind === "subagent-stop");
  });
  return { ran: ids.length > 0, running };
}

// Review rounds per reviewer role; past it a round is briefed only for a file no round saw.
export const REVIEW_CAP = 3;

// What a review round is judged against: the implementation files changed (tests excluded).
export function reviewScope(state) {
  return (state.changed ?? []).filter((p) => state.config.isSource(p) && !state.config.isTest(p));
}

// A piece entry is a file, or a slice of one: "path" or "path:from-to" (new-file lines).
export function parseEntry(entry) {
  const m = /^(.*):(\d+)-(\d+)$/.exec(String(entry));
  if (!m) return { path: String(entry), from: null, to: null };
  const from = Number(m[2]);
  const to = Number(m[3]);
  if (from < 1 || to < from) return { path: m[1], from: null, to: null };
  return { path: m[1], from, to };
}
export const pathOf = (entry) => parseEntry(entry).path;

function taskDiff(state, rel, { ignoreWhitespace = false } = {}) {
  const tracked = (state.tracked ??= gitTracked(state.root)).has(rel);
  return fileDiff(state.root, state.baseline?.head ?? "HEAD", rel, tracked, { base: baseCopy(state.dir, state.baseline, rel), ignoreWhitespace });
}

// One file's diff for this task (from open, for a file with a base copy), read once per
// assess: the slop check and the piece bookkeeping below share it.
export function diffTextOf(state, rel) {
  state.diffText ??= new Map();
  if (!state.diffText.has(rel)) state.diffText.set(rel, state.diff?.deleted?.includes(rel) ? "" : taskDiff(state, rel));
  return state.diffText.get(rel);
}

// The changed lines of one file as units (position + content key), only when a piece or a
// range round asks for them.
export function changedUnitsOf(state, rel) {
  state.changedUnits ??= new Map();
  if (!state.changedUnits.has(rel)) state.changedUnits.set(rel, changedUnits(diffTextOf(state, rel)));
  return state.changedUnits.get(rel);
}

// The changed lines the piece cap counts, for `gate brief` and nextPiece alike: those a
// whitespace-ignoring diff still holds. Use their positions only; coverage keys come from changedUnitsOf.
export function capUnitsOf(state, rel) {
  const full = changedUnitsOf(state, rel);
  if (indentMatters(rel) || state.diff?.deleted?.includes(rel) || !hasReindent(diffTextOf(state, rel))) return full;
  state.capUnits ??= new Map();
  if (!state.capUnits.has(rel)) state.capUnits.set(rel, changedUnits(taskDiff(state, rel, { ignoreWhitespace: true })));
  return state.capUnits.get(rel);
}
export const positionsOf = (units) => [...new Set(units.map((u) => u.pos))].sort((a, b) => a - b);

// Uncovered positions folded into "path:from-to" spans along the file's changed positions;
// every position uncovered is the bare path.
function spans(rel, open, all) {
  if (open.length === all.length) return [rel];
  const out = [];
  let start = null;
  let prev = null;
  for (const p of open) {
    if (start !== null && all[all.indexOf(prev) + 1] !== p) {
      out.push(`${rel}:${start}-${prev}`);
      start = null;
    }
    if (start === null) start = p;
    prev = p;
  }
  if (start !== null) out.push(`${rel}:${start}-${prev}`);
  return out;
}

// A change is reviewed in pieces when it is large; each round records what it saw: whole
// files, or slices of them as the content keys of the changed lines inside the range. A
// changed line is covered when the last round of this role that saw it really ran (the
// helper stopped after its brief) and came back clean, or was the last round the cap allows
// for that file, or had every item closed with no implementation edit since it stopped. An
// edit above a slice moves its lines but keeps them covered; an edit to a line uncovers that
// line. Returns the entries still uncovered ("path" or "path:from-to"), or null for a ledger
// from before seen sets, which keeps the old rule.
export function uncovered(state, role, after = lastEditSeq(state, state.config, state.ledger)) {
  const rounds = (state.ledger.huddles ?? []).filter((h) => h.role === role && h.file && Array.isArray(h.files));
  if (!rounds.length) return null;
  const stops = (state.events ?? []).filter((e) => e.kind === "subagent-stop" && isRole(e.agentType, role));
  const covered = (round, seenBy) => {
    const stop = stops.find((e) => e.seq > (round.briefSeq ?? Infinity));
    if (!stop) return false;
    if (!round.actOn.length || seenBy >= REVIEW_CAP) return true;
    return round.actOn.every((a) => a.closed) && after < stop.seq;
  };
  const out = [];
  for (const rel of reviewScope(state)) {
    const seeing = rounds.filter((h) => h.files.some((e) => pathOf(e) === rel));
    if (!seeing.length) {
      out.push(rel);
      continue;
    }
    const whole = (h) => h.files.includes(rel);
    if (seeing.every(whole)) {
      // whole-file rounds only: the last one judges the file, no diff is read
      if (!covered(seeing[seeing.length - 1], seeing.length)) out.push(rel);
      continue;
    }
    const units = changedUnitsOf(state, rel);
    const all = positionsOf(units);
    // with slices the cap counts the rounds that saw this line, not the file
    const saw = (h, u) => whole(h) || (h.units?.[rel] ?? []).includes(u.key);
    const open = positionsOf(units.filter((u) => {
      const rounds = seeing.filter((h) => saw(h, u));
      const last = rounds[rounds.length - 1];
      return !last || !covered(last, rounds.length);
    }));
    if (!units.length && !covered(seeing[seeing.length - 1], seeing.length)) out.push(rel);
    else if (open.length) out.push(...spans(rel, open, all));
  }
  return out;
}

// The first piece of the uncovered entries that fits the cap, so the command R5/R9 print can
// be run as printed; an entry over the cap is sliced from its first uncovered line.
export function nextPiece(state, entries) {
  const cap = (state.policy ?? policyFor(state.ledger)).reviewMaxLines;
  const piece = [];
  let lines = 0;
  for (const entry of entries) {
    const e = parseEntry(entry);
    const inRange = (u) => !e.from || (u.pos >= e.from && u.pos <= e.to);
    const counted = capUnitsOf(state, e.path).filter(inRange);
    const n = counted.length || 1;
    if (!piece.length && n > cap) {
      piece.push(`${e.path}:${changedUnitsOf(state, e.path).find(inRange).pos}-${sliceEnd(counted, cap)}`);
      break;
    }
    if (piece.length && lines + n > cap) break;
    piece.push(entry);
    lines += n;
  }
  return piece;
}

function reviewed(state, role, after) {
  const huddles = (state.ledger.huddles ?? []).filter((h) => h.role === role && h.file && (state.reviews ?? []).includes(h.file));
  const pending = uncovered(state, role, after);
  const stopped = pending === null
    ? (state.events ?? []).some((e) => e.kind === "subagent-stop" && isRole(e.agentType, role) && e.seq > after)
    : pending.length === 0;
  const openItems = huddles.flatMap((h) => h.actOn.filter((a) => !a.closed));
  return { stopped, hasFile: huddles.length > 0, openItems, pending: pending ?? [] };
}

// The command a `cmd:` driver names, or null for a skill driver or none.
export function driverCommand(config) {
  const m = /^cmd:\s*(\S.*)$/.exec(String(config.driver ?? ""));
  return m ? m[1].trim() : null;
}

// What drove the real surface after the last edit: a browser event, the /verify skill, or
// a foreground run of the cmd: driver by the lead that did not fail (a background run
// reports before it can fail). The driver run counts at `after` too, since a snapshot it
// writes is what dates the mark; browser and skill events count only past it. Returns the
// driving event or null; R4 and the report both read it, so they cannot disagree.
export function drivenAfter(state, after) {
  const ranDriver = driverRun(state, after);
  return (state.events ?? []).find((e) => !e.agent && (ranDriver(e) || (e.seq > after && (e.kind === "browser" || (e.kind === "skill" && e.skill === "verify"))))) ?? null;
}

function driverRun(state, after) {
  const driverCmd = driverCommand(state.config);
  return (e) => driverCmd !== null && e.kind === "command" && !e.background && String(e.cmd ?? "").includes(driverCmd) && e.seq >= after && (e.exit == null || e.exit === 0);
}

const CLICK_ACTIONS = new Set(["left_click", "double_click", "triple_click", "right_click", "form_input"]);

// What can close a click case, oldest first: a click or form_input by the lead (alone or in
// a batch) or a cmd: driver run as R4 counts it, after the last edit and after this run opened.
export function clickEvents(state, after) {
  const since = Math.max(after, state.ledger?.openedSeq ?? 0);
  const ranDriver = driverRun(state, since);
  const clicked = (e) => e.kind === "browser" && e.seq > since && (CLICK_ACTIONS.has(e.action) || (e.actions ?? []).some((a) => CLICK_ACTIONS.has(a.action)));
  return (state.events ?? []).filter((e) => !e.agent && (ranDriver(e) || clicked(e)));
}

// A click case reopens when source changed after its event: the control may have moved.
export function clickStale(c, after) {
  return c.kind === "click" && c.status === "closed" && Boolean(c.event) && Number(c.event.slice("events#".length)) < after;
}

export function caseOpen(c, after) {
  return c.status !== "closed" || (!c.test && !c.na && !c.event) || clickStale(c, after);
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// A verify.started.json with no verify.json after it: the run is still going (its process
// is alive) or the shell died under it. Null once verify.json landed.
export function unfinishedVerify(state) {
  const started = state.verifyStarted;
  if (!started) return null;
  if (state.verify && started.startedAt && String(state.verify.finishedAt ?? "") >= started.startedAt) return null;
  return { startedAt: started.startedAt ?? "an unknown time", pid: started.pid ?? null, running: processAlive(started.pid) };
}

export function unfinishedFile(full) {
  if (!existsSync(full)) return false;
  const text = readFileSync(full, "utf8");
  return isDraft(text) || isPartial(text);
}

function waived(ledger, key) {
  return (ledger.waivers ?? []).some((w) => w.key === key);
}

// A ledger opened before the Context step existed is never asked for one.
export function hasContextStep(ledger) {
  return (ledger?.steps ?? []).some((s) => s.key === "context");
}

// Which of Context, Plan and case table came after the first source edit of this task, if
// any: { late: ["Plan", "case table"], path: "<first edited file>" } or { late: [], path: null }.
export function lateOrder(state) {
  const { config, ledger } = state;
  const none = { late: [], path: null };
  if (!ledger) return none;
  const firstEdit = (state.events ?? []).find((e) => implementationEdit(e, config) && e.seq > (ledger.baseline?.seq ?? 0));
  if (!firstEdit) return none;
  const firstCase = ledger.cases?.[0]?.seq ?? Infinity;
  const late = [];
  if (hasContextStep(ledger) && !(ledger.contextSeq < firstEdit.seq)) late.push("Context");
  if (!(ledger.planSeq < firstEdit.seq)) late.push("Plan");
  if (!(firstCase < firstEdit.seq)) late.push("case table");
  return { late, path: firstEdit.path };
}

// Pure: state in, unmet rules out. Every item says what to do next.
export function evaluate(state) {
  const { config, ledger, changed, now, verify } = state;
  const unmet = [];
  const src = changed.filter((p) => config.isSource(p));

  const checkFailures = runChecks(state);
  for (const text of checkFailures) unmet.push({ rule: "R10", text });

  if (!ledger) {
    if (src.length) {
      unmet.push({
        rule: "R1",
        text: `source changed (${list(src)}) but no ledger is open for this session. Run \`gate open <slug> <feature|bugfix|refactor|plan>\` (or \`gate attach <slug>\`), write Task, Plan and the case table, then continue.`,
      });
    }
    return unmet;
  }

  if (src.length) {
    const unfinished = unfinishedVerify(state);
    if (unfinished) {
      unmet.push({ rule: "R3", text: unfinished.running
        ? `a \`gate verify\` started at ${unfinished.startedAt} is still running (pid ${unfinished.pid}); wait for it, do not start another. If that pid is not a verify of yours (a reboot reused it), \`gate verify\` again replaces it.`
        : `a \`gate verify\` started at ${unfinished.startedAt} never finished (the shell that ran it died). Run \`gate verify\` again.` });
    } else if (!verify) {
      unmet.push({ rule: "R3", text: "no verify.json for this run. Run `gate verify` after your last source edit." });
    } else {
      const red = (verify.commands ?? []).filter((c) => !c.skipped && (c.exit !== 0 || c.timedOut));
      if (red.length) {
        unmet.push({
          rule: "R3",
          text: `verify is red: ${red.map((c) => `\`${c.cmd}\` ${c.timedOut ? "timed out" : `exit ${c.exit}`}`).join("; ")}. Fix, then run \`gate verify\` again.`,
        });
      } else if (verify.sourceHash !== sourceHash(now, config)) {
        unmet.push({ rule: "R3", text: "verify.json is stale: source changed after the last `gate verify`. Run it again." });
      }
    }

    // "qa" is the waiver key older ledgers carry for the same step
    if (!changed.some((p) => config.isTest(p)) && !waived(ledger, "tests") && !waived(ledger, "qa")) {
      unmet.push({
        rule: "R7",
        text: `source changed (${list(src)}) but no test file changed. Write the tests for the case table (QA writes them at size large), or get the user's waiver (\`gate waive tests "<reason>"\`).`,
      });
    }
  }

  const after = lastEditSeq(state, config, ledger);

  // R4: UI changed → the real surface was driven after the last edit
  if (changed.some((p) => config.isUi(p)) && !waived(ledger, "driver")) {
    const driverCmd = driverCommand(config);
    if (!drivenAfter(state, after)) {
      unmet.push({ rule: "R4", text: driverCmd !== null
        ? `UI files changed but the real surface was not driven after the last edit. Run \`${driverCmd}\` (the driver in gate.json) yourself, or get the user's waiver (\`gate waive driver "<reason>"\`).`
        : config.driver
        ? "UI files changed but the real surface was not driven after the last edit. Run the project's /verify driver (phone viewport first), or get the user's waiver (`gate waive driver \"<reason>\"`)."
        : "UI files changed and this repo has no /verify driver. Run `/done-gate:verify-setup` once to create it, drive the surface, or get the user's waiver (`gate waive driver \"<reason>\"`)." });
    }
  }

  // R5: source changed → an independent reviewer looked after the last edit and every Act-on
  // item is closed. A tier that requires no reviewer (tiny) is exempt.
  const policy = state.policy ?? policyFor(ledger);
  const needsReviewer = requires(policy, effectiveTier(policy, ledger, state.tier?.measured ?? null)).includes("reviewer");
  if (src.length && needsReviewer && !waived(ledger, "review")) {
    const r = reviewed(state, "reviewer", after);
    if (!r.stopped || !r.hasFile) {
      unmet.push({ rule: "R5", text: r.pending.length && r.hasFile
        ? `no clean reviewer round yet for ${list(r.pending)}: \`gate brief reviewer --files ${nextPiece(state, r.pending).join(",")}\` (a piece of at most ${policy.reviewMaxLines} source lines), spawn \`done-gate:reviewer\`, then \`gate huddle add reviewer --file review-<n>.md\`.`
        : "no reviewer pass after the last edit. Spawn `done-gate:reviewer` (it writes review-<n>.md), then `gate huddle add reviewer --file review-<n>.md`." });
    } else if (r.openItems.length) {
      unmet.push({ rule: "R5", text: `reviewer Act-on item(s) still open: ${r.openItems.map((a) => a.id).join(", ")}. Fix, then \`gate huddle resolve <id> --evidence <pointer>\`.` });
    }
  }

  // R6: schema changed → the real-schema probe happened
  if (changed.some((p) => config.isSchema(p)) && !waived(ledger, "schema")) {
    const step = (ledger.steps ?? []).find((s) => s.key === "schema");
    if (!step || step.state !== "DONE" || !step.evidence) {
      unmet.push({ rule: "R6", text: "schema files changed: run the new/changed reader once against the real database (hit the endpoint in dev, or run the query) and close the schema step with `gate step schema done \"<what you ran>\" --evidence <pointer>`. N/A is not allowed here." });
    }
  }

  // R9: high-risk paths → a second reviewer on a stronger model
  if (changed.some((p) => config.isHighRisk(p)) && !waived(ledger, "review-2")) {
    const r = reviewed(state, "reviewer-2", after);
    if (r.stopped && r.hasFile && r.openItems.length) {
      unmet.push({ rule: "R9", text: `reviewer-2 Act-on item(s) still open: ${r.openItems.map((a) => a.id).join(", ")}. Fix, then \`gate huddle resolve <id> --evidence <pointer>\`.` });
    } else if (!r.stopped || !r.hasFile) {
      unmet.push({ rule: "R9", text: r.pending.length && r.hasFile
        ? `high-risk paths changed: no clean reviewer-2 round yet for ${list(r.pending)}: \`gate brief reviewer-2 --files ${nextPiece(state, r.pending).join(",")}\`, spawn \`done-gate:reviewer-2\`, then \`gate huddle add reviewer-2 --file review2-<n>.md\`.`
        : `high-risk paths changed (${list(changed.filter((p) => config.isHighRisk(p)))}): a second review by \`done-gate:reviewer-2\` is required after the last edit, with its review2-<n>.md recorded via \`gate huddle add reviewer-2 --file ...\` and every Act-on item closed.` });
    }
  }

  // R13: the gate's own config changed mid-task (a ledger from before hashed the file text)
  if (ledger.gateHash && ![config.hash, config.legacyHash].includes(ledger.gateHash) && !waived(ledger, "gate-config")) {
    unmet.push({ rule: "R13", text: ".claude/gate.json changed since this ledger opened. Restore it, or get the user's waiver (`gate waive gate-config \"<reason>\"`)." });
  }
  // a ledger with a pinned policy is judged by it; only one from before pinning can go stale
  if (!ledger.policy && ledger.policyHash && state.policy?.hash && state.policy.hash !== ledger.policyHash && !waived(ledger, "gate-config")) {
    unmet.push({ rule: "R13", text: "the plugin's models.json (tier policy) changed since this ledger opened. Restore it, or get the user's waiver (`gate waive gate-config \"<reason>\"`)." });
  }

  // R2: Context, plan and case table must predate the first source edit this task. Blocks only
  // while one is missing altogether; a late order is recorded (lateOrder) and shown in the
  // report, since the model cannot travel back to write them earlier.
  const { late, path: firstPath } = lateOrder(state);
  if (late.length) {
    const missing = [];
    if (hasContextStep(ledger) && !ledger.contextSeq) missing.push("Context");
    if (!ledger.planSeq) missing.push("Plan");
    if (!ledger.cases?.length) missing.push("case table");
    if (missing.length) {
      unmet.push({ rule: "R2", text: `${late.join(" and ")} written after the first source edit (${firstPath}). Write the ${missing.join(" and ")} now; the late order is recorded in the report.` });
    }
  }

  // R8: nothing blank
  const openCases = (ledger.cases ?? []).filter((c) => caseOpen(c, after));
  if (openCases.length) unmet.push({ rule: "R8", text: `case(s) not closed: ${openCases.map((c) => c.id).join(", ")}. \`gate case close <id> --test <file:name>\` or \`--na <reason>\`${openCases.some((c) => c.kind === "click") ? "; a click case: click the control in the real app after the last edit, then `gate case close <id> --click`" : ""}.` });
  const blankSteps = (ledger.steps ?? []).filter((s) => !s.state);
  if (blankSteps.length) unmet.push({ rule: "R8", text: `step(s) blank: ${blankSteps.map((s) => `${s.n}${s.key ? ` {${s.key}}` : ""}`).join(", ")}. Close each with \`gate step <n|key> done|skipped|na "<note>"\`.` });

  // R16: at a size where the lead delegates, the lead's own source edits after the plan are a
  // worker's job. The fence stops the edit tools; this catches what slipped past it.
  const delegated = waived(ledger, "delegate") ? null : leadDelegates(ledger, state.policy ?? undefined);
  if (delegated) {
    const since = ledger.tier?.predictedSeq ?? ledger.planSeq ?? 0;
    // the lead's own edit-tool calls, or those of any agent that is not a worker
    const own = (state.events ?? []).filter((e) => implementationEdit(e, config) && !isRole(e.agentType, "worker") && e.seq > since);
    if (own.length) {
      unmet.push({ rule: "R16", text: `the lead edited ${list([...new Set(own.map((e) => e.path))])} at size ${delegated}; hand that piece to a worker (\`gate brief worker\`, spawn done-gate:worker) and let it own the file from here.` });
    }
    // source changed with no edit-tool event to explain it: a shell edit, unless the last
    // shell command was a worker's, whose shell edits are its own business
    const shell = (ledger.unexplainedChanges ?? []).filter((c) => c.seq > since && !isRole(c.agentType, "worker"));
    if (shell.length) {
      const last = shell[shell.length - 1];
      unmet.push({ rule: "R16", text: `source changed with no worker edit behind it (${last.cmd ? `after \`${String(last.cmd).slice(0, 60)}\`` : "a shell edit"}) at size ${delegated}; at this size only workers edit source. Hand the piece to a worker (\`gate brief worker\`).` });
    }
  }

  // R15: every Act-on finding in a helper file is recorded from the file (hand-typed items do
  // not count), every helper file belongs to a huddle, and an unfinished one is handed on.
  for (const h of ledger.huddles ?? []) {
    if (!h.file || !state.dir) continue;
    const file = path.join(state.dir, h.file);
    if (!existsSync(file)) continue;
    const listed = parseFindings(readFileSync(file, "utf8")).length;
    const fromFile = h.actOn.filter((a) => typeof a.fileIndex === "number").length;
    if (listed > fromFile) {
      unmet.push({ rule: "R15", text: `${h.file} lists ${listed} Act-on finding(s) but ${h.id} records ${fromFile} from the file. Run \`gate huddle add ${h.role} --file ${h.file}\` again; it records every bullet.` });
    }
  }
  const recorded = new Set((ledger.huddles ?? []).map((h) => h.file).filter(Boolean));
  for (const f of state.reviews ?? []) {
    if (recorded.has(f)) continue;
    // a draft or partial file left by a cut-off helper is an unfinished round, not a
    // written-but-unrecorded file: brief re-briefs the same round instead
    if (state.dir && unfinishedFile(path.join(state.dir, f))) continue;
    unmet.push({ rule: "R15", text: `${f} was written but never recorded. Run \`gate huddle add ${fileRole(f)} --file ${f}\`.` });
  }
  for (const [f, brief] of Object.entries({ ...(ledger.briefed ?? {}), ...(ledger.seen ?? {}) })) {
    const role = fileRole(f);
    if (role === "worker" || !state.dir) continue;
    const full = path.join(state.dir, f);
    if (existsSync(full) && !unfinishedFile(full)) continue;
    const run = helperRun(state, role, f, brief.seq ?? 0);
    if (!run.ran || run.running) continue;
    const again = role === "arbiter" && brief.item ? ` --item ${brief.item}` : Array.isArray(brief.files) ? ` --files ${brief.files.join(",")}` : "";
    unmet.push({ rule: "R15", text: `the ${role} stopped before finishing ${f}: \`gate brief ${role}${again}\` and spawn a fresh one, its packet continues from the file.` });
  }

  return unmet;
}
