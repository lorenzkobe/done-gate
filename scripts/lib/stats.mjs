import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { UsageError } from "./context.mjs";
import { loadLedger, runsDir } from "./ledger.mjs";
import { tierOf } from "./size.mjs";
import { flag } from "./verbs.mjs";

// `gate stats` reads past run records and writes nothing: no buildState, no report path, no
// crash that would log a gate error. What the records do not hold prints "missing", never 0.
const USAGE = "usage: gate stats [--days n] [--version x]";
const FLAGS = new Set(["--days", "--version"]);
const DAY_MS = 24 * 3600 * 1000;
const SIZES = ["tiny", "small", "standard", "large"];
const REVIEWERS = new Set(["reviewer", "reviewer-2"]);
// these rounds answer a finding or a packet: having no findings of their own says nothing
const NO_CLEAN = new Set(["arbiter", "worker"]);
const MISSING = "missing";

const ofRuns = (n, m) => `${n} of ${m} runs`;
const list = (value) => (Array.isArray(value) ? value : []);
const oneDecimal = (n) => Math.round(n * 10) / 10;

function parseArgs(args) {
  for (let i = 0; i < args.length; i += 2) {
    if (!FLAGS.has(args[i])) throw new UsageError(USAGE);
  }
  const days = flag(args, "--days");
  if (args.includes("--days") && !/^[1-9]\d*$/.test(days ?? "")) throw new UsageError(USAGE);
  const version = flag(args, "--version");
  if (args.includes("--version") && (!version || version.startsWith("--"))) throw new UsageError(USAGE);
  return { days: days ? Number(days) : 30, version };
}

// Only what stats reads: one repo's ledgers came to 189 MB, mostly baselines and review units.
function readFields(ledger) {
  return {
    status: ledger.status,
    version: ledger.version,
    openedAt: ledger.openedAt,
    closedAt: ledger.closedAt,
    closedLate: ledger.closedLate,
    size: tierOf(ledger).measured?.tier,
    repos: list(ledger.repos),
    changedAtClose: ledger.changedAtClose,
    waivers: list(ledger.waivers).filter(Boolean),
    huddles: list(ledger.huddles).filter(Boolean).map((h) => ({ role: h.role, file: h.file, actOn: list(h.actOn).filter(Boolean) })),
  };
}

// Each ledger on its own: openRuns would throw on the first bad one. A ledger with no usable
// open time cannot be placed in any window, so it is as unreadable as a torn one.
function readRuns(stateDir) {
  const root = runsDir(stateDir);
  if (!existsSync(root)) return null;
  const ledgers = [];
  let unreadable = 0;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    if (!existsSync(path.join(dir, "ledger.json"))) continue;
    try {
      const ledger = loadLedger(dir);
      if (!Number.isFinite(Date.parse(ledger.openedAt))) throw new Error("no open time");
      ledgers.push(readFields(ledger));
    } catch {
      unreadable += 1;
    }
  }
  return { ledgers, unreadable };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const outcomeOf = (ledger) => (ledger.status === "closed" || ledger.status === "abandoned" ? ledger.status : "open");

function minutesOf(ledger) {
  const minutes = (Date.parse(ledger.closedAt) - Date.parse(ledger.openedAt)) / 60000;
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

function minuteLines(closed) {
  const bySize = Object.fromEntries(SIZES.map((size) => [size, []]));
  let late = 0;
  let unsized = 0;
  let untimed = 0;
  for (const ledger of closed) {
    if (ledger.closedLate) {
      late += 1;
      continue;
    }
    const minutes = minutesOf(ledger);
    if (!Object.hasOwn(bySize, ledger.size ?? "")) unsized += 1;
    else if (minutes === null) untimed += 1;
    else bySize[ledger.size].push(minutes);
  }
  const out = SIZES.map((size) => `  ${size}: ${bySize[size].length ? `${oneDecimal(median(bySize[size]))} min (${ofRuns(bySize[size].length, closed.length)})` : MISSING}`);
  if (unsized) out.push(`  no measured size: ${ofRuns(unsized, closed.length)}`);
  if (untimed) out.push(`  no usable close time: ${ofRuns(untimed, closed.length)}`);
  if (late) out.push(`  closed late, left out: ${ofRuns(late, closed.length)}`);
  return out;
}

// Only a lost dispute says a finding was wrong. One dismissed on a decision or a plan note may be
// wrong or may be handled, and the record cannot tell, so "wrong" is a floor beside that count.
const wrongVerdict = (item) => item.dispute?.verdict === "withdrawn" || item.dispute?.verdict === "arbiter:implementer";
const onNote = (closed) => /^(?:decisions#|ledger\.md#)/.test(closed);
// a pointer is `file:line`, `file:test name` or a run record (events#<seq>, withdrawn (file))
const pointerPath = (closed) => /^[^\s:]+/.exec(closed)?.[0] ?? "";

// Whether a run's closed findings can be judged at all: a closed-late run has an empty list that
// means "not recorded", and a bad gate.json leaves no way to know what a test is.
function testJudge(ledger, root, plain) {
  const repos = list(ledger.repos);
  let isTest = plain;
  if (repos.length && plain) {
    try {
      isTest = loadConfig(root, repos).isTest;
    } catch {
      isTest = null;
    }
  }
  if (!isTest || ledger.closedLate || !Array.isArray(ledger.changedAtClose)) return null;
  const changed = new Set(ledger.changedAtClose);
  return (closed) => {
    const file = pointerPath(closed);
    return isTest(file) && changed.has(file);
  };
}

const emptyRow = () => ({ rounds: 0, byHand: 0, clean: 0, findings: 0, wrong: 0, onNote: 0, onTest: 0, closed: 0, notJudged: 0 });

function addRound(row, huddle, onTest) {
  row.rounds += 1;
  if (!huddle.file) row.byHand += 1;
  else if (!huddle.actOn.length) row.clean += 1;
  row.findings += huddle.actOn.length;
  for (const item of huddle.actOn) {
    if (wrongVerdict(item)) row.wrong += 1;
    else if (typeof item.closed === "string" && item.closed) {
      if (onNote(item.closed)) {
        row.onNote += 1;
        continue;
      }
      row.closed += 1;
      if (!onTest) row.notJudged += 1;
      else if (onTest(item.closed)) row.onTest += 1;
    }
  }
}

function rowText(row, role) {
  const judged = row.closed - row.notJudged;
  const onTest = row.closed && !judged ? MISSING : `${row.onTest}${row.notJudged ? `, not judged ${row.notJudged} of ${row.closed}` : ""}`;
  const rounds = `rounds ${row.rounds}${row.byHand ? `, by hand ${row.byHand}` : ""}${NO_CLEAN.has(role) ? "" : `, clean ${row.clean}`}`;
  return `${rounds}, findings ${row.findings}, closed as wrong at least ${row.wrong}, closed on a note ${row.onNote}, closed on a test ${onTest}`;
}

function findingLines(closed, root) {
  let plain = null;
  try {
    plain = loadConfig(root).isTest;
  } catch {
    // a bad gate.json: rounds and findings still read, only "on a test" cannot be judged
  }
  const roles = new Map();
  const reviewers = emptyRow();
  let quiet = 0;
  let unseen = 0;
  for (const ledger of closed) {
    const onTest = testJudge(ledger, root, plain);
    if (!ledger.huddles.some((h) => h.actOn.length)) {
      if (ledger.huddles.some((h) => h.file)) quiet += 1;
      else unseen += 1;
    }
    for (const huddle of ledger.huddles) {
      const role = typeof huddle.role === "string" ? huddle.role : "unknown";
      if (!roles.has(role)) roles.set(role, emptyRow());
      addRound(roles.get(role), huddle, onTest);
      if (REVIEWERS.has(role)) addRound(reviewers, huddle, onTest);
    }
  }
  const out = [`findings: ${closed.length} closed runs`];
  for (const role of [...roles.keys()].sort()) out.push(`  ${role}: ${rowText(roles.get(role), role)}`);
  if (reviewers.rounds) out.push(`  both reviewers: ${rowText(reviewers)}`);
  out.push(`  runs with no findings: ${ofRuns(quiet, closed.length)}`);
  if (unseen) out.push(`  no helper round: ${ofRuns(unseen, closed.length)}`);
  return out;
}

function waiverLines(closed) {
  const byKey = new Map();
  for (const ledger of closed) {
    for (const waiver of ledger.waivers) {
      const key = typeof waiver.key === "string" ? waiver.key : "unknown";
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
  }
  const total = [...byKey.values()].reduce((sum, n) => sum + n, 0);
  const runs = `${closed.length} closed runs`;
  if (!total) return [`waivers: none in ${runs}`];
  const keys = [...byKey].sort(([a, m], [b, n]) => n - m || a.localeCompare(b)).map(([key, n]) => `${key} ${n}`);
  return [`waivers: ${total} in ${runs}, ${oneDecimal(total / closed.length)} per run`, `  by key: ${keys.join(", ")}`];
}

function report(ctx, { days, version }) {
  const heading = `done-gate stats: ${path.basename(ctx.root)}, last ${days} days, ${version ? `version ${version}` : "all versions"}`;
  const read = readRuns(ctx.stateDir);
  const cutoff = Date.now() - days * DAY_MS;
  const inWindow = (read?.ledgers ?? []).filter((l) => Date.parse(l.openedAt) >= cutoff);
  const runs = version ? inWindow.filter((l) => l.version === version) : inWindow;
  const closed = runs.filter((l) => outcomeOf(l) === "closed");
  const out = [heading];
  if (!read) out.push("runs: missing, this repo has no run records");
  else if (!runs.length) out.push(`runs: none in this window, ${read.ledgers.length} recorded`);
  else out.push(`runs: ${ofRuns(runs.length, read.ledgers.length)}`);
  if (read?.unreadable) out.push(`unreadable ledgers: ${read.unreadable}`);
  const unversioned = inWindow.filter((l) => !l.version).length;
  if (unversioned) out.push(`no version: ${ofRuns(unversioned, inWindow.length)}`);
  const outcomes = ["closed", "abandoned", "open"].map((o) => [o, runs.filter((l) => outcomeOf(l) === o).length]).filter(([, n]) => n);
  out.push(`outcome: ${outcomes.length ? outcomes.map(([o, n]) => `${n} ${o}`).join(", ") : MISSING}`);
  out.push("median minutes, closed runs:", ...minuteLines(closed));
  out.push(...(closed.length ? findingLines(closed, ctx.root) : [`findings: ${MISSING}`]));
  out.push(...(closed.length ? waiverLines(closed) : [`waivers: ${MISSING}`]));
  out.push("could-not-run waivers: not recorded", "lapsed waivers: not recorded");
  return out;
}

export const verbs = {
  stats(ctx) {
    for (const line of report(ctx, parseArgs(ctx.args))) ctx.out(line);
  },
};
