import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { UsageError } from "./context.mjs";
import { appendEvents, HANDBACK, nextSeq, noticeCause, readEvents, UNRECORDED } from "./events.mjs";
import { loadLedger, runsDir } from "./ledger.mjs";
import { inRun, PLAIN_RULES, plural, RETIRED_RULES } from "./report.mjs";
import { GATE_VERBS } from "./guard.mjs";
import { NOT_THE_USER, saidAt } from "./rules.mjs";
import { outsidePlan, tierOf } from "./size.mjs";
import { flag } from "./verbs.mjs";

// `gate stats` reads past run records and writes nothing: no buildState, no report path, no
// crash that would log a gate error. What the records do not hold prints "missing", never 0.
const USAGE = "usage: gate stats [--days n] [--version x] [--save <file>]";
const WRONG_USAGE = 'usage: gate stats wrong <R#> "<the user\'s words, at least three>"';
const FLAGS = new Set(["--days", "--version", "--save"]);
// other agents' names are free text the user or a plugin chose, so a saved file says "other"
const GATE_ROLES = new Set(["skeptic", "qa", "worker", "reviewer", "reviewer-2", "arbiter"]);
const DAY_MS = 24 * 3600 * 1000;
const SIZES = ["tiny", "small", "standard", "large"];
const REVIEWERS = new Set(["reviewer", "reviewer-2"]);
// these rounds answer a finding or a packet: having no findings of their own says nothing
const NO_CLEAN = new Set(["arbiter", "worker"]);
const PLANNED_PLAYBOOKS = new Set(["feature", "bugfix", "refactor"]);
// a worker writes its file only on a review round; its packet shows it was given the work
const WORKER_FILE = /^(?:brief-)?worker-\d+\.md$/;
const AFTER_CLOSE_MS = 30 * DAY_MS;
const SESSION_ID = /^[\w-]+$/;
const REVIEWER_TYPE = /^(?:done-gate:)?reviewer(?:-2)?$/;
const WORKER_TYPE = /^(?:done-gate:)?worker$/;
const NOT_A_FAILURE = new Set(["finished", "waiting"]);
const REFUSAL_WORDS = 4;
const BESIDE = "read beside another command";
const GATE_FILE = /\.claude\/gate|(?:review2?|skeptic|arbiter|worker)-\d+\.md|ledger\.md/;
const NAMES_A_FILE = /\/|\w\.\w/;
const SEQ_PER_MINUTE = 6e7;
const RATE_MIN_TURNS = 20;
const PROBATION_AT = 0.1;
const ASK_AT = 0.25;
const MISSING = "missing";

const ofRuns = (n, m) => `${n} of ${m} runs`;
const ofTurns = (n) => `${n} turn${n === 1 ? "" : "s"}`;
const list = (value) => (Array.isArray(value) ? value : []);
const oneDecimal = (n) => Math.round(n * 10) / 10;

function parseArgs(args) {
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    if (!FLAGS.has(args[i]) || seen.has(args[i])) throw new UsageError(USAGE);
    seen.add(args[i]);
  }
  const days = flag(args, "--days");
  if (args.includes("--days") && !/^[1-9]\d*$/.test(days ?? "")) throw new UsageError(USAGE);
  const version = flag(args, "--version");
  if (args.includes("--version") && (!version || version.startsWith("--"))) throw new UsageError(USAGE);
  const save = flag(args, "--save");
  if (args.includes("--save") && (!save || save.startsWith("--"))) throw new UsageError(USAGE);
  return { days: days ? Number(days) : 30, version, save };
}

// The strength check's total time in a run, or null when it never ran there.
function strengthMsOf(dir) {
  try {
    const ms = JSON.parse(readFileSync(path.join(dir, "strength.json"), "utf8")).ms;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

// Only what stats reads: one repo's ledgers came to 189 MB, mostly baselines and review units.
function readFields(ledger, dir) {
  const tier = tierOf(ledger);
  const size = tier.measured?.tier;
  return {
    name: path.basename(dir),
    playbook: ledger.playbook,
    status: ledger.status,
    version: ledger.version,
    openedAt: ledger.openedAt,
    openedSeq: ledger.openedSeq,
    closedAt: ledger.closedAt,
    abandonedAt: ledger.abandonedAt,
    sessions: list(ledger.sessions).filter((s) => typeof s === "string"),
    closedLate: ledger.closedLate,
    size,
    lines: tier.measured?.lines,
    named: tier.predictedFiles,
    // a run that never drifted keeps no record: whether the check ran at all is in its pinned policy
    driftSeen: ["shadow", "active"].includes(ledger.policy?.guards?.planDiff) && (ledger.rules ?? 0) >= 1 ? list(ledger.planDriftSeen) : null,
    added: list(ledger.planAdds).flatMap((a) => list(a?.files)),
    hadWorkers: size === "large" && readdirSync(dir).some((f) => WORKER_FILE.test(f)),
    strengthMs: strengthMsOf(dir),
    repos: list(ledger.repos),
    changedAtClose: ledger.changedAtClose,
    uiTrial: ledger.uiTrial === true,
    waivers: list(ledger.waivers).filter(Boolean),
    rules: ledger.rules,
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
      ledgers.push(readFields(ledger, dir));
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
const wrongVerdict = (item) => Boolean(item.closed && item.wrong) || item.dispute?.verdict === "withdrawn" || item.dispute?.verdict === "arbiter:implementer";
const onNote = (closed) => /^(?:decisions#|ledger\.md#)/.test(closed);
// a pointer is `file:line`, `file:test name` or a run record (events#<seq>, withdrawn (file))
const pointerPath = (closed) => /^[^\s:]+/.exec(closed)?.[0] ?? "";

// A closed-late run's empty list means "not recorded", so it says nothing about what changed.
const changedOf = (ledger) => (ledger.closedLate || !Array.isArray(ledger.changedAtClose) ? null : ledger.changedAtClose);

// One config per set of declared repos. A bad gate.json, the main one or a declared repo's, leaves
// null: what a test or a source file is cannot be known for the runs that use it.
function configReader(root) {
  const known = new Map();
  return (ledger) => {
    const key = JSON.stringify(ledger.repos);
    if (!known.has(key)) {
      try {
        known.set(key, loadConfig(root, ledger.repos));
      } catch {
        known.set(key, null);
      }
    }
    return known.get(key);
  };
}

function testJudge(ledger, configOf) {
  const config = configOf(ledger);
  const changed = changedOf(ledger);
  if (!config || !changed) return null;
  return (closed) => {
    const file = pointerPath(closed);
    return config.isTest(file) && changed.includes(file);
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

function findingLines(closed, configOf) {
  const roles = new Map();
  const reviewers = emptyRow();
  let quiet = 0;
  let unseen = 0;
  for (const ledger of closed) {
    const onTest = testJudge(ledger, configOf);
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

// A lead's own call (gate call) is counted on its own line, never among the user's waivers.
const isCall = (w) => w?.by === "lead";

function callLines(closed) {
  const calls = closed.flatMap((l) => l.waivers).filter(isCall);
  const runs = `${closed.length} closed runs`;
  if (!calls.length) return [`the lead's calls: none in ${runs}`];
  const byKey = new Map();
  for (const c of calls) byKey.set(c.key, (byKey.get(c.key) ?? 0) + 1);
  const keys = [...byKey].sort(([a, m], [b, n]) => n - m || String(a).localeCompare(String(b))).map(([key, n]) => `${key} ${n}`);
  return [`the lead's calls: ${calls.length} in ${runs}, ${oneDecimal(calls.length / closed.length)} per run (${keys.join(", ")}); could not run ${calls.filter((c) => c.could).length}, lapsed ${calls.filter((c) => c.lapsed).length}`];
}

function waiverLines(closed) {
  const byKey = new Map();
  for (const ledger of closed) {
    for (const waiver of ledger.waivers) {
      if (isCall(waiver)) continue;
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

function planLines(closed, configOf) {
  const scope = closed.filter((l) => PLANNED_PLAYBOOKS.has(l.playbook));
  const extras = [];
  let noChanged = 0;
  let noConfig = 0;
  let noList = 0;
  for (const ledger of scope) {
    const changed = changedOf(ledger);
    const config = configOf(ledger);
    if (!changed) noChanged += 1;
    else if (!config) noConfig += 1;
    else if (!ledger.named.length) noList += 1;
    else extras.push(outsidePlan(ledger.named, changed, config).length);
  }
  const affected = extras.filter(Boolean);
  const out = [`code outside the plan: ${extras.length ? ofRuns(affected.length, extras.length) : MISSING}`];
  if (affected.length) {
    out.push(`  median extra files: ${oneDecimal(median(affected))}`);
    out.push(`  one file only: ${ofRuns(affected.filter((n) => n === 1).length, affected.length)}`);
  }
  if (noList) out.push(`  no list: ${ofRuns(noList, scope.length)}`);
  if (noChanged) out.push(`  no changed list: ${ofRuns(noChanged, scope.length)}`);
  if (noConfig) out.push(`  no usable gate.json: ${ofRuns(noConfig, scope.length)}`);
  // every file the shadow diff check flagged, whatever became of it: the flip to active is judged on these
  const kept = scope.filter((l) => l.driftSeen);
  if (kept.length) {
    const flagged = kept.flatMap((l) => l.driftSeen);
    const added = kept.reduce((n, l) => n + l.driftSeen.filter((p) => l.added.includes(p)).length, 0);
    out.push(`plan drift: ${ofRuns(kept.filter((l) => l.driftSeen.length).length, kept.length)}, ${flagged.length} files flagged, ${added} later added to the plan`);
  }
  return out;
}

function largeGroupText(group, total) {
  if (!group.length) return MISSING;
  const minutes = group.map(minutesOf).filter((m) => m !== null);
  const counted = group.filter((l) => l.lines > 0);
  const findings = counted.flatMap((l) => l.huddles).filter((h) => REVIEWERS.has(h.role)).reduce((sum, h) => sum + h.actOn.length, 0);
  const lines = counted.reduce((sum, l) => sum + l.lines, 0);
  const time = minutes.length ? `median ${oneDecimal(median(minutes))} min` : `median minutes ${MISSING}`;
  const rate = lines ? `${oneDecimal((findings / lines) * 100)} findings per 100 lines` : `findings per 100 lines ${MISSING}`;
  return `${ofRuns(group.length, total)}, ${time}, ${rate}`;
}

function largeLines(closed) {
  const onTime = closed.filter((l) => !l.closedLate);
  const large = onTime.filter((l) => l.size === "large");
  if (!large.length) return [`large runs: ${MISSING}`];
  return [
    `large runs: ${ofRuns(large.length, onTime.length)}`,
    `  with workers: ${largeGroupText(large.filter((l) => l.hadWorkers), large.length)}`,
    `  without workers: ${largeGroupText(large.filter((l) => !l.hadWorkers), large.length)}`,
  ];
}

// How long the strength check took, over the runs that ran it.
function strengthLines(closed) {
  const onTime = closed.filter((l) => !l.closedLate);
  const ran = onTime.map((l) => l.strengthMs).filter((ms) => ms !== null && ms !== undefined);
  return [`strength check: ${ran.length ? `${ofRuns(ran.length, onTime.length)}, median ${(median(ran) / 1000).toFixed(1)} s` : MISSING}`];
}

// Runs closed under the UI trial, and how many a bugfix opened in the month after touched: the
// number the trial is judged on.
function trialLines(closed, every) {
  const onTime = closed.filter((l) => !l.closedLate);
  const trials = onTime.filter((l) => l.uiTrial && Array.isArray(l.changedAtClose));
  const fixes = every.filter((l) => l.playbook === "bugfix" && Array.isArray(l.changedAtClose));
  const touched = trials.filter((t) => fixes.some((f) => {
    const gap = Date.parse(f.openedAt) - Date.parse(t.closedAt);
    return gap > 0 && gap <= AFTER_CLOSE_MS && f.changedAtClose.some((p) => t.changedAtClose.includes(p));
  }));
  return [`ui trial runs: ${trials.length ? `${ofRuns(trials.length, onTime.length)}, a later bugfix touched ${touched.length}` : MISSING}`];
}

// An estimate: a bugfix touching code a run closed in the month before it. It misses a feature run
// that fixes a bug and counts a fix of an older bug, so the names are printed for a person to read.
function afterCloseLines(closed, every, configOf, forFile) {
  const label = "bugs after close (estimate):";
  const onTime = closed.filter((l) => !l.closedLate);
  const fixes = onTime.filter((l) => l.playbook === "bugfix");
  const earlier = every.filter((l) => l.status === "closed" && changedOf(l));
  const found = [];
  let notJudged = 0;
  for (const fix of fixes) {
    const changed = changedOf(fix);
    const config = configOf(fix);
    if (!changed || !config) {
      notJudged += 1;
      continue;
    }
    const code = new Set(outsidePlan([], changed, config));
    const opened = Date.parse(fix.openedAt);
    const overlaps = (l) => {
      const closedAt = Date.parse(l.closedAt);
      return closedAt < opened && closedAt >= opened - AFTER_CLOSE_MS && l.changedAtClose.some((p) => code.has(p));
    };
    if (earlier.some(overlaps)) found.push(fix.name);
  }
  if (!onTime.length || (fixes.length && notJudged === fixes.length)) return [`${label} ${MISSING}`];
  const out = [`${label} ${ofRuns(found.length, onTime.length)}${notJudged ? `, not judged ${notJudged} of ${fixes.length} bugfix runs` : ""}`];
  if (found.length && !forFile) out.push(`  named: ${found.sort().join(", ")}`);
  return out;
}

const startsTurn = (e) => !e.agent && !e.handback && !HANDBACK.test(e.text ?? "") && !NOT_THE_USER.test(e.text ?? "");

// One session's log in compact records, numbered by the user's turn: a session's log is far
// larger than what stats reads, and a prompt's words are never kept.
function sessionRecords(stateDir, session) {
  if (!SESSION_ID.test(session)) return [];
  let turn = 0;
  try {
    return readEvents(stateDir, session).map((e) => {
      if (e.kind === "prompt" && startsTurn(e)) turn += 1;
      return {
        seq: e.seq,
        kind: e.kind,
        session,
        turn,
        agent: e.agent,
        agentType: e.agentType,
        ...(e.kind === "deny" ? { reason: e.reason, delegate: e.delegate } : {}),
        ...(e.kind === "block" ? { rules: list(e.rules) } : {}),
        ...(e.kind === "prompt" ? { cause: noticeCause(e.text)?.cause } : {}),
        ...(e.kind === "rule-wrong" ? { rule: e.rule, saidSeq: e.saidSeq, blockSeq: e.blockSeq, blockSession: e.blockSession } : {}),
        ...(e.kind === "verb" ? { verb: e.verb, settings: e.settings } : {}),
      };
    });
  } catch {
    return [];
  }
}

function refusalGroup(reason) {
  const text = String(reason ?? "").replace(/^done-gate:\s*/, "");
  const quoted = /`([^`]*)` is not a plain read/.exec(text)?.[1];
  if (/^reading the gate folder beside/.test(text) || (quoted !== undefined && !GATE_FILE.test(quoted))) return BESIDE;
  return text.split(/\s+/).slice(0, REFUSAL_WORDS).map((word) => (NAMES_A_FILE.test(word) ? "<file>" : word)).join(" ").replace(/[:,.]+$/, "");
}

function refusalLines(counted, forFile) {
  const denies = counted.filter((e) => e.kind === "deny" && !e.delegate);
  if (!denies.length) return ["refusals: none, hand-offs left out"];
  const groups = new Map();
  for (const e of denies) {
    const group = refusalGroup(e.reason);
    if (!groups.has(group)) groups.set(group, { lead: 0, helper: 0 });
    groups.get(group)[e.agent ? "helper" : "lead"] += 1;
  }
  if (forFile) {
    const beside = groups.get(BESIDE) ?? { lead: 0, helper: 0 };
    return [`refusals: ${denies.length}, hand-offs left out`, `  ${BESIDE}: lead ${beside.lead}, helper ${beside.helper}`, `  all others: lead ${denies.filter((e) => !e.agent).length - beside.lead}, helper ${denies.filter((e) => e.agent).length - beside.helper}`];
  }
  const rows = [...groups].sort(([a, m], [b, n]) => n.lead + n.helper - m.lead - m.helper || a.localeCompare(b));
  return [`refusals: ${denies.length}, hand-offs left out`, ...rows.map(([group, n]) => `  ${group}: lead ${n.lead}, helper ${n.helper}`)];
}

function turnsByRule(blocks) {
  const byRule = new Map();
  for (const e of blocks) {
    for (const rule of e.rules) {
      if (!byRule.has(rule)) byRule.set(rule, new Set());
      byRule.get(rule).add(`${e.session}#${e.turn}`);
    }
  }
  return [...byRule].sort(([a, m], [b, n]) => n.size - m.size || String(a).localeCompare(String(b)));
}

const turnKeys = (rows) => new Set(rows.flatMap(([, keys]) => [...keys]));

function stoppedLines(counted, outside) {
  const turns = new Set(counted.map((e) => `${e.session}#${e.turn}`));
  const rows = turnsByRule(counted.filter((e) => e.kind === "block"));
  const out = [`turns stopped: ${turnKeys(rows).size} of ${ofTurns(turns.size)}`];
  for (const [rule, keys] of rows) out.push(`  ${rule}${PLAIN_RULES[rule] ? ` (${PLAIN_RULES[rule]})` : ""}: ${ofTurns(keys.size)}`);
  const beyond = turnsByRule(outside);
  if (beyond.length) out.push(`  outside any run: at least ${ofTurns(turnKeys(beyond).size)} (${beyond.map(([rule, keys]) => `${rule} ${keys.size}`).join(", ")})`);
  return out;
}

// One run's helpers of a type: each start paired with the same agent's next stop, whose agent type
// may be empty, so a resumed helper's gap is not work. A start with no stop has no known end.
function agentSpans(records, type) {
  const agents = new Set(records.filter((e) => e.kind === "subagent-start" && type.test(e.agentType ?? "")).map((e) => e.agent));
  const open = new Map();
  const spans = [];
  let noStop = 0;
  for (const e of records) {
    if (!agents.has(e.agent)) continue;
    if (e.kind === "subagent-start") {
      if (open.has(e.agent)) noStop += 1;
      open.set(e.agent, e.seq);
    } else if (e.kind === "subagent-stop" && open.has(e.agent)) {
      spans.push([open.get(e.agent), e.seq]);
      open.delete(e.agent);
    }
  }
  return { agents, spans, noStop: noStop + open.size };
}

// The minutes two or more spans ran at once.
function overlapMinutes(spans) {
  const edges = spans.flatMap(([from, to]) => [[from, 1], [to, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = 0;
  let total = 0;
  let last = null;
  for (const [at, step] of edges) {
    if (out >= 2) total += at - last;
    out += step;
    last = at;
  }
  return total / SEQ_PER_MINUTE;
}

// Closed runs by how their workers ran: two at once, one at a time, or none, with the pace and
// the reviewers' findings of each.
function workerLines(runRecords) {
  const timed = runRecords.filter(({ ledger, records }) => records.length && !ledger.closedLate);
  if (!timed.length) return [`workers by run: ${MISSING}`];
  const classes = { parallel: [], "single worker": [], "lead only": [] };
  for (const r of timed) {
    const { agents, spans } = agentSpans(r.records, WORKER_TYPE);
    const overlap = overlapMinutes(spans);
    classes[overlap > 0 ? "parallel" : agents.size ? "single worker" : "lead only"].push({ ...r, overlap });
  }
  const text = (name, group) => {
    if (!group.length) return `  ${name}: ${MISSING}`;
    const paced = group.filter(({ ledger }) => ledger.lines > 0 && minutesOf(ledger) !== null);
    const lines = paced.reduce((n, { ledger }) => n + ledger.lines, 0);
    const minutes = paced.reduce((n, { ledger }) => n + minutesOf(ledger), 0);
    const pace = lines ? `${((minutes / lines) * 100).toFixed(1)} min per 100 lines` : `min per 100 lines ${MISSING}`;
    const findings = group.flatMap(({ ledger }) => ledger.huddles).filter((h) => REVIEWERS.has(h.role)).reduce((n, h) => n + h.actOn.length, 0);
    const overlap = name === "parallel" ? `, ${group.reduce((n, g) => n + g.overlap, 0).toFixed(1)} overlap minutes` : "";
    return `  ${name}: ${ofRuns(group.length, timed.length)}, ${pace}, ${findings} finding${findings === 1 ? "" : "s"}${overlap}`;
  };
  return [`workers by run: ${ofRuns(timed.length, runRecords.length)}`, ...Object.entries(classes).map(([name, group]) => text(name, group))];
}

function unionMinutes(spans) {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (to > end) {
      total += to - Math.max(from, end);
      end = to;
    }
  }
  return total / SEQ_PER_MINUTE;
}

function waitMinutes(ledger, records, reviewers) {
  const theirs = records.filter((e) => reviewers.has(e.agent));
  const start = theirs.find((e) => e.kind === "subagent-start")?.seq;
  if (start === undefined) return null;
  const closedSeqs = ledger.huddles.filter((h) => REVIEWERS.has(h.role)).flatMap((h) => h.actOn.map((a) => a.closedSeq)).filter((seq) => typeof seq === "number");
  const stops = theirs.filter((e) => e.kind === "subagent-stop").map((e) => e.seq);
  const end = Math.max(...stops, ...closedSeqs);
  return end > start ? (end - start) / SEQ_PER_MINUTE : null;
}

function reviewTimeLines(runRecords) {
  const timed = runRecords.filter(({ ledger, records }) => records.length && !ledger.closedLate && minutesOf(ledger) !== null);
  if (!timed.length) return [`reviewer time: ${MISSING}`, `review wait: ${MISSING}`];
  const total = timed.reduce((sum, { ledger }) => sum + minutesOf(ledger), 0);
  const share = (minutes) => `${total ? Math.round((minutes / total) * 100) : 0}% of ${Math.round(total)} run minutes`;
  let running = 0;
  let noStop = 0;
  let withReviewer = 0;
  let waiting = 0;
  let withWait = 0;
  for (const { ledger, records } of timed) {
    const found = agentSpans(records, REVIEWER_TYPE);
    if (found.agents.size) withReviewer += 1;
    running += unionMinutes(found.spans);
    noStop += found.noStop;
    const wait = waitMinutes(ledger, records, found.agents);
    if (wait !== null) {
      waiting += wait;
      withWait += 1;
    }
  }
  return [
    `reviewer time: ${share(running)} (${ofRuns(withReviewer, timed.length)})${noStop ? `, no stop ${noStop}` : ""}`,
    `review wait: ${withWait ? `${share(waiting)} (${ofRuns(withWait, timed.length)})` : `none in ${ofRuns(timed.length, timed.length)}`}`,
  ];
}

function failureLines(counted) {
  const causes = new Map();
  for (const e of counted) {
    if (e.cause && !NOT_A_FAILURE.has(e.cause)) causes.set(e.cause, (causes.get(e.cause) ?? 0) + 1);
  }
  if (!causes.size) return ["helper failures: none in the notices"];
  return ["helper failures:", ...[...causes].sort(([a, m], [b, n]) => n - m || a.localeCompare(b)).map(([cause, n]) => `  ${cause}: at least ${n}`)];
}

// Each event counts once however many run stretches hold it: an event is judged against every run
// naming its session, not run by run, and a turn crossing a close is still one turn.
function eventLines(recordsOf, closed, every, { version, cutoff, forFile }) {
  const records = new Map();
  for (const session of new Set(closed.flatMap((l) => l.sessions))) records.set(session, recordsOf(session));
  const runRecords = closed.map((ledger) => ({ ledger, records: ledger.sessions.flatMap((s) => records.get(s) ?? []).filter(inRun(ledger)).sort((a, b) => a.seq - b.seq) }));
  const covered = runRecords.filter((r) => r.records.length).length;
  const end = "lead-turn failures: not recorded";
  if (!covered) return [`events: ${MISSING}`, `refusals: ${MISSING}`, `turns stopped: ${MISSING}`, `reviewer time: ${MISSING}`, `review wait: ${MISSING}`, `workers by run: ${MISSING}`, `helper failures: ${MISSING}`, end];
  const inSomeRun = (runs, e) => runs.some((l) => l.sessions.includes(e.session) && inRun(l)(e));
  const all = [...records.values()].flat();
  const counted = all.filter((e) => inSomeRun(closed, e));
  const outside = version ? [] : all.filter((e) => e.kind === "block" && e.seq / 1000 >= cutoff && !inSomeRun(every, e));
  return [`events: ${ofRuns(covered, closed.length)}`, ...refusalLines(counted, forFile), ...stoppedLines(counted, outside), ...reviewTimeLines(runRecords), ...workerLines(runRecords), ...failureLines(counted), end];
}

// Every stopped turn on disk per rule, with the verdicts that still have their block. Verdicts and
// blocks live in the same logs, so they are pruned together.
function ruleRecords(stateDir, recordsOf) {
  const dir = path.join(stateDir, "sessions");
  if (!existsSync(dir)) return null;
  const turns = new Map();
  const blockTurn = new Map();
  const verdicts = [];
  for (const session of readdirSync(dir)) {
    for (const e of recordsOf(session)) {
      if (e.kind === "rule-wrong") verdicts.push(e);
      if (e.kind !== "block") continue;
      const key = `${e.session}#${e.turn}`;
      blockTurn.set(`${e.session}#${e.seq}`, key);
      for (const rule of e.rules) {
        if (!turns.has(rule)) turns.set(rule, new Map());
        const ofRule = turns.get(rule);
        if (!ofRule.has(key)) ofRule.set(key, []);
        ofRule.get(key).push({ session: e.session, seq: e.seq });
      }
    }
  }
  const judged = new Map();
  for (const v of verdicts) {
    const key = blockTurn.get(`${v.blockSession}#${v.blockSeq}`);
    if (!key) continue;
    if (!judged.has(v.rule)) judged.set(v.rule, new Set());
    judged.get(v.rule).add(key);
  }
  return { turns, judged, verdicts };
}

function rateText(rule, turns, wrongTurns) {
  if (turns < RATE_MIN_TURNS) return `${rule}: ${ofTurns(turns)} stopped, too few${wrongTurns ? `, ${wrongTurns} judged wrong` : ""}`;
  const rate = wrongTurns / turns;
  const label = rate >= ASK_AT ? ", ask" : rate >= PROBATION_AT ? ", probation" : "";
  return `${rule}: ${wrongTurns} of ${turns} turns wrong, ${Math.round(rate * 100)}%${label}`;
}

function rateLines(stateDir, recordsOf) {
  const records = ruleRecords(stateDir, recordsOf);
  if (!records) return [`rule rates: ${MISSING}`];
  if (!records.turns.size) return ["rule rates: no stopped turns"];
  const rows = [...records.turns].map(([rule, keys]) => [rule, keys.size, records.judged.get(rule)?.size ?? 0]);
  rows.sort(([a, m], [b, n]) => n - m || String(a).localeCompare(String(b)));
  return ["rule rates: every record, ignoring --days", ...rows.map(([rule, turns, wrongTurns]) => `  ${rateText(rule, turns, wrongTurns)}`)];
}

const SETTINGS = Object.keys(JSON.parse(readFileSync(new URL("../../gate.schema.json", import.meta.url), "utf8")).properties).filter((k) => k !== "$schema");
const byRule = (a, b) => Number(a.slice(1)) - Number(b.slice(1));

// The gate verbs, gate.json settings and rules with no recorded use in the window, over every
// session this repo kept. Verbs are recorded from this version on, so the days that hold them
// are named apart from the window. --save writes counts, never the names.
function neverUsedLines(stateDir, recordsOf, { days, cutoff, forFile }) {
  const head = "never used, this repo's kept records only";
  const dir = path.join(stateDir, "sessions");
  const records = existsSync(dir) ? readdirSync(dir).flatMap((s) => recordsOf(s)).filter((e) => e.seq / 1000 >= cutoff) : [];
  if (!records.length) return [`${head}: ${MISSING}`];
  const verbs = records.filter((e) => e.kind === "verb");
  const opens = verbs.filter((e) => e.verb === "open" && Array.isArray(e.settings));
  const oldest = verbs.length ? Math.min(...verbs.map((e) => e.seq / 1000)) : null;
  const recorded = oldest === null ? "no verb recorded yet" : `verbs recorded for the last ${plural(Math.max(1, Math.round((Date.now() - oldest) / DAY_MS)), "day")}`;
  const list = (unused, all) => (forFile ? `${unused.length} of ${all.length}` : unused.length ? unused.join(", ") : "none");
  const notYet = "not recorded yet: the gate records each verb it runs from this version on";
  const used = new Set(verbs.map((e) => e.verb));
  const set = new Set(opens.flatMap((e) => e.settings));
  const stopped = new Set(records.filter((e) => e.kind === "block").flatMap((e) => e.rules));
  const live = Object.keys(PLAIN_RULES).filter((r) => !RETIRED_RULES.has(r)).sort(byRule);
  const commands = [...GATE_VERBS].filter((v) => !UNRECORDED.has(v)).sort();
  return [
    `${head}:`,
    `  covers: the last ${plural(days, "day")} of stopped turns, all versions; ${recorded}`,
    `  commands: ${verbs.length ? list(commands.filter((v) => !used.has(v)), commands) : notYet}`,
    `  settings: ${opens.length ? list(SETTINGS.filter((k) => !set.has(k)), SETTINGS) : notYet}`,
    `  rules that stopped no turn: ${list(live.filter((r) => !stopped.has(r)), live)}`,
  ];
}

function sessionReader(stateDir) {
  const known = new Map();
  return (session) => {
    if (!known.has(session)) known.set(session, sessionRecords(stateDir, session));
    return known.get(session);
  };
}

// The one write in stats. One message of the user's judges one turn per rule, and only a turn
// stopped before they said it; a phrase cut from that message is still that message.
function recordVerdict(ctx, [rule, words, ...rest]) {
  if (!/^R\d+$/.test(rule ?? "") || !words?.trim() || rest.length) throw new UsageError(WRONG_USAGE);
  if (!ctx.session) throw new UsageError("gate stats wrong: no session is known here, so nothing can show the user said it");
  const said = saidAt(readEvents(ctx.stateDir, ctx.session), 0, words);
  if (!said) throw new UsageError(`the user did not say "${words}" in this session; a verdict on a rule is theirs: ask them`);
  const { turns, judged, verdicts } = ruleRecords(ctx.stateDir, sessionReader(ctx.stateDir)) ?? { turns: new Map(), judged: new Map(), verdicts: [] };
  if (verdicts.some((v) => v.rule === rule && v.saidSeq === said.seq)) throw new UsageError(`that message of the user's was already used for ${rule}; one message judges one turn`);
  const unjudged = [...(turns.get(rule) ?? [])].filter(([key]) => !judged.get(rule)?.has(key));
  const before = unjudged.flatMap(([, blocks]) => blocks).filter((b) => b.seq < said.seq);
  if (!before.length) throw new UsageError(`no stopped turn naming ${rule} before the user's words is left without a verdict`);
  const block = before.reduce((newest, b) => (b.seq > newest.seq ? b : newest));
  const at = new Date().toISOString();
  appendEvents(ctx.stateDir, ctx.session, [{ seq: nextSeq(), ts: at, session: ctx.session, agent: null, agentType: null, kind: "rule-wrong", rule, words: words.trim(), saidSeq: said.seq, blockSeq: block.seq, blockSession: block.session }]);
  ctx.out(`${rule} marked wrong on the turn it stopped at ${new Date(block.seq / 1000).toISOString()}`);
  ctx.out(rateText(rule, turns.get(rule).size, (judged.get(rule)?.size ?? 0) + 1));
}

async function* fileLines(file) {
  let rest = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop();
    yield* lines;
  }
  if (rest) yield rest;
}

// Cache writes are priced by how long they are kept, so the two are counted apart; a line holding
// only their total counts as unsplit, and a count a line does not carry is left out.
const INPUT_KINDS = [["read", "cache read"], ["written1h", "cache written 1h"], ["written5m", "cache written 5m"], ["uncached", "uncached"]];
function inputOf(usage) {
  const kept = usage.cache_creation ?? {};
  const counts = { read: usage.cache_read_input_tokens, written1h: kept.ephemeral_1h_input_tokens, written5m: kept.ephemeral_5m_input_tokens, uncached: usage.input_tokens };
  if (typeof counts.written1h !== "number" && typeof counts.written5m !== "number") counts.unsplit = usage.cache_creation_input_tokens;
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => typeof n === "number"));
}
function addInput(sum, usage) {
  for (const key in usage) sum[key] = (sum[key] ?? 0) + usage[key];
}
function inputText(sum, show = compact) {
  const kinds = INPUT_KINDS.map(([key, name]) => (key in sum ? `${show(sum[key])} ${name}` : `${name} ${MISSING}`));
  return [...kinds, ...("unsplit" in sum ? [`${show(sum.unsplit)} cache written unsplit`] : [])].join(", ");
}
// a model name is text from a transcript (a provider ARN, a gateway's own name): a saved file keeps
// only the ones that read as a claude model id
const CLAUDE_MODEL = /^claude-[a-z0-9.-]+$/;

// Numbers only, each message at its largest count. A fork opens with a line copied from its parent,
// whose id `taken` holds; a file that cannot be read loses only itself.
async function usageOf(file, taken = new Map()) {
  const rows = new Map();
  let first = null;
  try {
    for await (const line of fileLines(file)) {
      if (first !== null && !line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const id = entry?.message?.id;
      const at = Date.parse(entry?.timestamp);
      if (!Number.isFinite(at) || taken.has(id)) continue;
      first ??= at;
      const output = entry.message?.usage?.output_tokens;
      if (typeof id !== "string" || typeof output !== "number" || entry.message.model === "<synthetic>") continue;
      if (output >= (rows.get(id)?.output ?? 0)) rows.set(id, { at, output, model: entry.message.model, usage: inputOf(entry.message.usage) });
    }
  } catch {
    // unreadable, or a folder named like a transcript
  }
  return { rows, first };
}

function helperFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return helperFiles(full);
      return /^agent-.*\.jsonl$/.test(entry.name) ? [full] : [];
    });
  } catch {
    return [];
  }
}

function roleOf(helperFile) {
  try {
    const type = JSON.parse(readFileSync(helperFile.replace(/\.jsonl$/, ".meta.json"), "utf8")).agentType;
    return typeof type === "string" && type ? type.replace(/^done-gate:/, "") : "other";
  } catch {
    return "other";
  }
}

function projectFolders() {
  const root = path.join(process.env.DONE_GATE_HOME || homedir(), ".claude", "projects");
  try {
    return readdirSync(root).map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${oneDecimal(n)}`);

// Each line or helper counts once, in the run opened first of those holding its time.
async function tokenLines(closed, forFile) {
  const runs = closed.filter((l) => !l.closedLate && minutesOf(l) !== null).sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  const folders = projectFolders();
  const tally = new Map(runs.map((l) => [l, { lead: 0, helpers: 0, input: {} }]));
  const roles = new Map();
  const models = new Map();
  const totalsOf = (map, key) => map.get(key) ?? map.set(key, { output: 0, input: {} }).get(key);
  const count = (run, row, role) => {
    addInput(tally.get(run).input, row.usage);
    const name = typeof row.model === "string" ? row.model : "unknown";
    const model = totalsOf(models, forFile && name !== "unknown" && !CLAUDE_MODEL.test(name) ? "other" : name);
    for (const sum of role ? [role, model] : [model]) {
      sum.output += row.output;
      addInput(sum.input, row.usage);
    }
  };
  for (const session of new Set(runs.flatMap((l) => l.sessions).filter((s) => SESSION_ID.test(s)))) {
    const own = runs.filter((l) => l.sessions.includes(session));
    const runAt = (at) => own.find((l) => at >= Date.parse(l.openedAt) && at <= Date.parse(l.closedAt));
    const lead = new Map();
    for (const folder of folders) {
      for (const [id, row] of (await usageOf(path.join(folder, `${session}.jsonl`))).rows) {
        if (row.output >= (lead.get(id)?.output ?? 0)) lead.set(id, row);
      }
    }
    for (const row of lead.values()) {
      const run = runAt(row.at);
      if (!run) continue;
      tally.get(run).lead += row.output;
      count(run, row);
    }
    const taken = new Map(lead);
    for (const folder of folders) {
      for (const file of helperFiles(path.join(folder, session, "subagents"))) {
        const { rows, first } = await usageOf(file, taken);
        const run = first === null ? null : runAt(first);
        for (const [id, row] of rows) taken.set(id, row);
        if (!run) continue;
        const named = roleOf(file);
        const role = forFile && !GATE_ROLES.has(named) ? "other" : named;
        for (const row of rows.values()) {
          tally.get(run).helpers += row.output;
          count(run, row, totalsOf(roles, role));
        }
      }
    }
  }
  const counted = runs.filter((l) => tally.get(l).lead + tally.get(l).helpers > 0);
  if (!counted.length) return [`tokens: ${MISSING}`];
  const sizeLine = (size) => {
    const group = counted.filter((l) => l.size === size);
    if (!group.length) return `  ${size}: ${MISSING}`;
    const totals = group.map((l) => tally.get(l).lead + tally.get(l).helpers);
    const helpers = group.reduce((sum, l) => sum + tally.get(l).helpers, 0);
    const medians = {};
    for (const key of [...INPUT_KINDS.map(([kind]) => kind), "unsplit"]) {
      const had = group.map((l) => tally.get(l).input[key]).filter((n) => n !== undefined);
      if (had.length) medians[key] = median(had);
    }
    return `  ${size}: median ${compact(median(totals))} output (${ofRuns(group.length, runs.length)}), helpers ${Math.round((helpers / totals.reduce((a, b) => a + b, 0)) * 100)}%; input per run: median ${inputText(medians)}`;
  };
  const helperTotal = [...roles.values()].reduce((sum, role) => sum + role.output, 0);
  const byOutput = (map) => [...map].filter(([, sum]) => sum.output > 0).sort(([a, m], [b, n]) => n.output - m.output || a.localeCompare(b));
  return [
    `tokens: ${ofRuns(counted.length, runs.length)}`,
    ...SIZES.map(sizeLine),
    ...byOutput(roles).map(([role, sum]) => `  ${role}: ${compact(sum.output)} output, ${Math.round((sum.output / helperTotal) * 100)}% of helper output; input: ${inputText(sum.input)}`),
    ...byOutput(models).map(([model, sum]) => `  model ${model}: ${sum.output} output, ${inputText(sum.input, String)}`),
  ];
}

// Where a saved file may go: a new file outside the repo, where it can never read as a change to
// the task or to the gate's own files. A failed write is the caller's to fix, not a gate error.
function saveTarget(ctx, file) {
  const target = path.resolve(file);
  let parent;
  try {
    parent = realpathSync.native(path.dirname(target));
  } catch {
    throw new UsageError(`gate stats --save: the folder of ${target} does not exist`);
  }
  const inside = (root) => {
    const rel = path.relative(realpathSync.native(root), parent);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if ([ctx.root, ...ctx.repos.map((r) => r.root).filter((r) => existsSync(r))].some(inside)) {
    throw new UsageError(`gate stats --save: ${target} is inside the repo, where it would count as a change; save it outside`);
  }
  return path.join(parent, path.basename(target));
}

function writeSaved(target, saved) {
  try {
    writeFileSync(target, `${JSON.stringify(saved, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    throw new UsageError(`gate stats --save: cannot write ${target} as a new file (${error.code ?? error.message})`);
  }
}

// The printed lines as a flat map, so saved and printed numbers cannot drift: a top line is its own
// label, and a line under it is "<top> / <label>". A top line with no value only names the section.
function numbersOf(lines) {
  const numbers = {};
  let section = "";
  for (const line of lines) {
    const row = line.trimStart();
    const at = row.indexOf(": ");
    const label = at < 0 ? row.replace(/:$/, "") : row.slice(0, at);
    const value = at < 0 ? null : row.slice(at + 2);
    if (row === line) section = label;
    if (value !== null) numbers[row === line ? label : `${section} / ${label}`] = value;
  }
  return numbers;
}

// A verify that ran a command again on a source hash the command already ran on. A normal run then
// the --final check share a hash but no command, so that pair is no re-run.
function reRunLines(closed, stateDir) {
  const histories = closed.map((l) => {
    try {
      return JSON.parse(readFileSync(path.join(runsDir(stateDir), l.name, "verify.json"), "utf8")).history ?? null;
    } catch {
      return null;
    }
  }).filter(Boolean);
  if (!histories.length) return [`verify re-runs: ${MISSING}`];
  let ran = 0;
  let again = 0;
  for (const history of histories) {
    const seen = new Map();
    for (const entry of history) {
      if (!entry.ran?.length) continue;
      ran += 1;
      const before = seen.get(entry.sourceHash) ?? new Set();
      if (entry.ran.some((cmd) => before.has(cmd))) again += 1;
      seen.set(entry.sourceHash, new Set([...before, ...entry.ran]));
    }
  }
  return [`verify re-runs: ${again} of ${ran} verifies that ran, in ${ofRuns(histories.length, closed.length)}`];
}

async function report(ctx, { days, version, forFile = false }) {
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
  const configOf = configReader(ctx.root);
  out.push(...(closed.length ? findingLines(closed, configOf) : [`findings: ${MISSING}`]));
  out.push(...(closed.length ? waiverLines(closed) : [`waivers: ${MISSING}`]));
  const recorded = closed.filter((l) => l.rules).flatMap((l) => l.waivers).filter((w) => !isCall(w));
  const countOf = (flag) => (closed.some((l) => l.rules) ? String(recorded.filter((w) => w[flag]).length) : "not recorded");
  out.push(`could-not-run waivers: ${countOf("could")}`, `lapsed waivers: ${countOf("lapsed")}`);
  if (closed.length) out.push(...callLines(closed));
  out.push(...reRunLines(closed, ctx.stateDir), ...planLines(closed, configOf), ...largeLines(closed), ...afterCloseLines(closed, read?.ledgers ?? [], configOf, forFile), ...trialLines(closed, read?.ledgers ?? []), ...strengthLines(closed));
  const recordsOf = sessionReader(ctx.stateDir);
  out.push(...eventLines(recordsOf, closed, read?.ledgers ?? [], { version, cutoff, forFile }), ...rateLines(ctx.stateDir, recordsOf), ...neverUsedLines(ctx.stateDir, recordsOf, { days, cutoff, forFile }), ...(await tokenLines(closed, forFile)));
  return out;
}

export const verbs = {
  async stats(ctx) {
    if (ctx.args[0] === "wrong") {
      recordVerdict(ctx, ctx.args.slice(1));
      return;
    }
    const options = parseArgs(ctx.args);
    if (options.save) {
      const target = saveTarget(ctx, options.save);
      const [, ...lines] = await report(ctx, { ...options, forFile: true });
      writeSaved(target, {
        format: 1,
        repo: path.basename(ctx.root),
        pluginVersion: ctx.version,
        savedAt: new Date().toISOString(),
        days: options.days,
        version: options.version ?? null,
        numbers: numbersOf(lines),
      });
      ctx.out(`saved ${target}: numbers only, nothing was sent`);
      return;
    }
    for (const line of await report(ctx, options)) ctx.out(line);
  },
};
