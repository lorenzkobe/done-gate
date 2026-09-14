import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/tier-policy.test.mjs and tests/brief-report.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1", bin = gate } = {}) {
  return spawnSync(process.execPath, [bin, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session),
  });
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  return r;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const closedRunDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).lastClosed);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so tracked/clean files can be measured by `git diff --numstat`.
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// a Stop hook payload, exactly as tests/stop.test.mjs feeds one
function stopHook(repo, message = "report", session = "S1") {
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({
      session_id: session,
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: message,
    }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// hook payloads, fed to `gate log` exactly as Claude Code's hooks feed them
function hook(repo, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// the events file itself is the contract; parsed here rather than through the module
// the implementer is editing
function eventsOf(repo, session = "S1") {
  const file = path.join(stateDir(repo), "sessions", session, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .sort((a, b) => a.seq - b.seq);
}

const stdinFixture = (name) =>
  JSON.parse(readFileSync(path.join(here, "fixtures", "stdin", `${name}.json`), "utf8"));

const subagentStop = (repo, agentType, extra = {}) =>
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "A9", agent_type: agentType, stop_hook_active: false, ...extra });

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// Every mutating verb ends with a `next:` hint (tests/next-hints.test.mjs owns that line);
// assertions about a verb's own output ignore it.
const withoutHint = (s) => lines(s).filter((l) => !l.startsWith("next:"));

function sectionOf(md, heading) {
  const m = new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(md);
  return m ? m[1].trim() : null;
}

const tierLines = (md) => {
  const s = sectionOf(md, "Tier");
  return s === null ? null : lines(s);
};

const lineStarting = (text, prefix) => lines(text).find((l) => l.startsWith(prefix));

// ---------------------------------------------------------------------------
// source-of-truth anchors: models.json, never the implementation's constants
// ---------------------------------------------------------------------------

const POLICY = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8")).policy;
const TIER_NAMES = Object.keys(POLICY.tiers); // small, standard, large
const REQUIRES = (tier) => POLICY.tiers[tier].requires;
const ESC = POLICY.escalate.reviewerRound2; // { model, whenActOnAtLeast, orTier }
const LARGE_FILES = POLICY.tiers.standard.maxFiles + 1; // 11: the first file count that is large
const MODEL = "claude-opus-4";

const SIZE_RE = new RegExp(`^Size: (${TIER_NAMES.join("|")}) \\(\\d+ files?, \\d+ lines?\\)\\.$`);

// words that belong to the ledger's own vocabulary and must never reach the brief
const INTERNAL_WORDS = ["tier", "auto-N/A", "reopened", "predicted", "requires"];

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function openTiered(repo, { slug = "sized", playbook = "feature", files = null } = {}) {
  cli(repo, "open", [slug, playbook]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "One component, no data change.", ...(files ? ["--files", files] : [])]);
}

// predicted small (one file named in the plan), measured standard (three source files,
// one of them a .tsx, which forces the ui category) → auto-N/A keys and reopened keys.
function standardTier(name) {
  const repo = committed(name);
  openTiered(repo, { files: "src/a.ts" });
  write(repo, "src/a.ts", "export const a = 2;\nexport const b = 3;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/app/page.tsx", "export default () => null; // changed\n");
  return repo;
}

// 11 changed source files: one past standard.maxFiles, so the effective tier is large.
function largeTier(name) {
  const repo = committed(name);
  openTiered(repo);
  for (let i = 0; i < LARGE_FILES; i++) write(repo, `src/big/f${i}.ts`, `export const f${i} = ${i};\n`);
  return repo;
}

// A feature ledger the gate agrees is clean: nothing under source touched, every step
// closed, `gate close` run. The Stop hook then finalises it (tests/stop.test.mjs).
function closedTieredFixture(name, slug = "shipped") {
  const repo = committed(name);
  openTiered(repo, { slug, files: "src/a.ts,src/b.ts" });
  cli(repo, "case", ["add", "shows the size", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:shows the size"]);
  // DONE, not N/A: an optional step left N/A is reopened the moment the tier is reconciled
  const steps = loadLedger(runDir(repo)).steps;
  for (const s of steps) if (!s.state) cli(repo, "step", [String(s.n), "done", "nothing changed under source", "--evidence", "events#1"]);
  cli(repo, "close");
  return repo;
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 happy: subagent start and stop events carry the payload's model, and omit the key when the payload has none", () => {
  const repo = makeRepo("report-tier-c1");
  const start = stdinFixture("subagent-start");
  const stop = stdinFixture("subagent-stop");
  assert.equal(start.hook_event_name, "SubagentStart", "fixture anchor: tests/fixtures/stdin/subagent-start.json");
  assert.equal(stop.hook_event_name, "SubagentStop", "fixture anchor: tests/fixtures/stdin/subagent-stop.json");

  hook(repo, { ...start, cwd: repo, model: MODEL });
  hook(repo, { ...stop, cwd: repo, model: MODEL });
  hook(repo, { ...start, cwd: repo });
  hook(repo, { ...stop, cwd: repo });

  const evs = eventsOf(repo);
  assert.deepEqual(
    evs.map((e) => e.kind),
    ["subagent-start", "subagent-stop", "subagent-start", "subagent-stop"],
  );
  assert.equal(evs[0].model, MODEL, `SubagentStart dropped the model: ${JSON.stringify(evs[0])}`);
  assert.equal(evs[1].model, MODEL, `SubagentStop dropped the model: ${JSON.stringify(evs[1])}`);
  assert.ok(!("model" in evs[2]), `a payload with no model must leave the key off: ${JSON.stringify(evs[2])}`);
  assert.ok(!("model" in evs[3]), `a payload with no model must leave the key off: ${JSON.stringify(evs[3])}`);

  // the rest of the record is untouched
  assert.equal(evs[1].agent, stop.agent_id);
  assert.equal(evs[1].agentType, stop.agent_type);
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 happy: the full report's Tier block carries the predicted and measured tier, the forced category, and the auto-N/A and reopened keys", () => {
  const repo = standardTier("report-tier-c2");
  const report = cli(repo, "report").stdout;

  const block = tierLines(report);
  assert.ok(block, `no "## Tier" section in the full report:\n${report}`);
  assert.ok(block[0].startsWith("tier:"), `the Tier section must open with the tier line:\n${block.join("\n")}`);

  // the first three lines are the block `gate size` prints (minus its files detail line)
  const size = withoutHint(cli(repo, "size").stdout).filter((l) => !l.startsWith("files:"));
  assert.deepEqual(block.slice(0, size.length), size, "the report's Tier block disagrees with `gate size`");

  assert.ok(block[0].includes("predicted small (1 file)"), block[0]);
  assert.match(block[0], /measured standard: 3 files, \d+ lines/, block[0]);
  assert.ok(block[0].includes("forced: ui"), `a .tsx file forces the ui category:\n${block[0]}`);
  assert.ok(block[0].startsWith("tier: standard"), `small predicted + standard measured is standard:\n${block[0]}`);

  const keys = block.find((l) => l.startsWith("auto-N/A:"));
  assert.ok(keys, `no auto-N/A line:\n${block.join("\n")}`);
  assert.ok(keys.includes("auto-N/A: {skeptic}, {reconcile}"), keys);
  assert.ok(keys.includes("reopened: {skeptic}, {reconcile}"), keys);
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 happy: the Tier block counts helpers spawned against the required list, from subagent-stop events by role", () => {
  const repo = standardTier("report-tier-c3");
  const required = REQUIRES("standard");

  const none = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.ok(none, "no helpers line in the Tier block");
  assert.match(none, /^helpers: spawned 0 of\b/, none);
  for (const role of required) assert.ok(none.includes(role), `${role} is required for standard but is not named: ${none}`);

  subagentStop(repo, "done-gate:qa");
  subagentStop(repo, "reviewer"); // isRole accepts the bare role too
  subagentStop(repo, "general-purpose"); // not a gate helper: never counted

  const some = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.match(some, /^helpers: spawned 2 of\b/, some);
  for (const role of required) assert.ok(some.includes(role), `${role} missing from: ${some}`);
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

test("C4 edge: the round 2 model line is required by Act-on count or by a large tier, and names the recorded model", () => {
  const round2 = (repo) => lineStarting(cli(repo, "report").stdout, "round 2 model:");

  // one Act-on item, standard tier → below the threshold
  const one = standardTier("report-tier-c4-one");
  writeFileSync(path.join(runDir(one), "review-1.md"), "# Review 1\n\n## Act on\n- null venue crashes\n");
  cli(one, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(one, "huddle", ["acton", "H1", "null venue crashes"]);
  assert.equal(round2(one), "round 2 model: not required");

  // the threshold from models.json, with nothing recorded
  const many = standardTier("report-tier-c4-many");
  writeFileSync(path.join(runDir(many), "review-1.md"), "# Review 1\n\n## Act on\n- one\n- two\n");
  cli(many, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  for (let i = 0; i < ESC.whenActOnAtLeast; i++) cli(many, "huddle", ["acton", "H1", `finding ${i}`]);
  assert.equal(round2(many), `round 2 model: ${ESC.model} required, recorded: unrecorded`);

  // the second reviewer ran and the harness said on which model
  subagentStop(many, "done-gate:reviewer");
  subagentStop(many, "done-gate:reviewer", { model: MODEL });
  assert.equal(round2(many), `round 2 model: ${ESC.model} required, recorded: ${MODEL}`);

  // tier large on its own is enough, with no Act-on items at all
  const big = largeTier("report-tier-c4-large");
  assert.equal(ESC.orTier, "large", "anchor: models.json escalate.reviewerRound2.orTier");
  assert.equal(round2(big), `round 2 model: ${ESC.model} required, recorded: unrecorded`);
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 refused: the brief has exactly one plain Size line after the Changed line and none of the ledger's own words", () => {
  const repo = standardTier("report-tier-c5");
  const brief = cli(repo, "report", ["--brief"]).stdout;
  const all = lines(brief);

  const sizeLines = all.filter((l) => l.startsWith("Size:"));
  assert.equal(sizeLines.length, 1, `expected exactly one Size line:\n${brief}`);

  const changedAt = all.findIndex((l) => l.startsWith("Changed"));
  assert.ok(changedAt >= 0, `no Changed line in the brief:\n${brief}`);
  assert.equal(all[changedAt + 1], sizeLines[0], `the Size line must follow the Changed line:\n${brief}`);

  assert.match(sizeLines[0], SIZE_RE, `the Size line is not the plain sentence:\n${sizeLines[0]}`);
  for (const word of INTERNAL_WORDS) {
    assert.ok(!sizeLines[0].toLowerCase().includes(word.toLowerCase()), `"${word}" leaked into the brief: ${sizeLines[0]}`);
  }

  // the numbers are the measured ones and the word is the effective tier
  const tierLine = lines(cli(repo, "size").stdout)[0];
  const effective = /^tier: (\S+)/.exec(tierLine)[1];
  const measured = /measured \S+: (\d+) files?, (\d+) lines?/.exec(tierLine);
  assert.equal(sizeLines[0], `Size: ${effective} (${measured[1]} files, ${measured[2]} lines).`);
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 boundary: a closed ledger's report still shows the Tier block from the tier persisted at close", () => {
  const repo = closedTieredFixture("report-tier-c6");
  stopHook(repo); // the Stop hook finalises a clean, closing run
  assert.equal(loadSession(stateDir(repo), "S1").current, null, "no run is open any more");
  assert.ok(loadLedger(closedRunDir(repo)).tier, "the tier was not persisted at finalise");

  const report = cli(repo, "report").stdout;
  const block = tierLines(report);
  assert.ok(block, `a closed run's report lost the Tier section:\n${report}`);
  assert.equal(block[0], "tier: standard · predicted standard (2 files) · measured small: 0 files, 0 lines");
});

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

test("C7 boundary: an untiered playbook prints no Tier block and no Size line", () => {
  const repo = committed("report-tier-c7");
  cli(repo, "open", ["notes", "plan"]);
  cli(repo, "note", ["task", "Write the spec. [inferred]"]);
  cli(repo, "note", ["plan", "One document."]);
  write(repo, "src/a.ts", "export const a = 2;\n");

  const report = cli(repo, "report").stdout;
  assert.equal(tierLines(report), null, `the plan playbook is not tiered:\n${report}`);

  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.equal(lines(brief).filter((l) => l.startsWith("Size:")).length, 0, `no size is known for an untiered run:\n${brief}`);
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

// Volatile bits: the repo path, ISO timestamps, command durations, tree hashes and the
// run dir's date prefix. Everything else must match byte for byte.
function normalise(text, repo) {
  return text
    .split(repo)
    .join("<REPO>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TS>")
    .replace(/\b\d+\.\d+s\b/g, "<DUR>")
    .replace(/\b[0-9a-f]{12,40}\b/g, "<HASH>")
    .replace(/\b\d{4}-\d{2}-\d{2}-/g, "<DATE>-");
}

// drop the Tier section: from its heading up to the next "## " heading
function withoutTier(md) {
  const start = md.indexOf("\n## Tier\n");
  if (start < 0) return md;
  const next = md.indexOf("\n## ", start + 1);
  return next < 0 ? `${md.slice(0, start)}\n` : md.slice(0, start) + md.slice(next);
}

function c8Fixture(name, bin) {
  const repo = committed(name, {
    ".claude/gate.json": JSON.stringify({ verify: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`] }),
  });
  const go = (verb, args = []) => {
    const r = run(repo, verb, args, { bin });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  go("open", ["stable", "feature"]);
  go("note", ["task", "Add a badge. [inferred]"]);
  go("note", ["plan", "One component."]);
  go("case", ["add", "renders badge", "--kind", "happy"]);
  go("case", ["close", "C1", "--test", "tests/a.test.ts:renders"]);
  go("blast", ["add", "only one consumer", "--rung", "2", "--proof", "src/a.ts:1"]);
  go("step", ["read", "done", "read it", "--evidence", "events#1"]);
  go("decide", ["plan", "kept it simple", "one consumer", "src/a.ts", "open"]);
  write(repo, "src/a.ts", "changed\n");
  go("verify");
  return { repo, go };
}

test("C8 idempotent: apart from the Tier section the full report is byte-identical to the one HEAD renders", (t) => {
  const { repo, go } = c8Fixture("report-tier-c8", gate);
  const mine = go("report").stdout;
  assert.ok(tierLines(mine), `the fixture must have a Tier section to strip:\n${mine}`);

  // The Steps section quotes the playbook prose verbatim, so an edited playbook would
  // fail this comparison for a reason it was never meant to catch.
  const playbooksChanged =
    spawnSync("git", ["diff", "--quiet", "HEAD", "--", "skills/gate/playbooks"], { cwd: pluginRoot }).status !== 0;
  if (playbooksChanged) {
    t.diagnostic("skipping the HEAD comparison: skills/gate/playbooks differs from HEAD");
    return;
  }

  const headDir = path.join(here, ".tmp", "report-tier-c8-head");
  rmSync(headDir, { recursive: true, force: true });
  mkdirSync(headDir, { recursive: true });
  execSync(`git archive HEAD | tar -x -C ${JSON.stringify(headDir)}`, { cwd: pluginRoot });
  const headGate = path.join(headDir, "scripts", "gate.mjs");
  assert.ok(existsSync(headGate), "git archive HEAD did not produce scripts/gate.mjs");

  const head = c8Fixture("report-tier-c8-head-repo", headGate);
  const headReport = head.go("report").stdout;

  assert.equal(
    withoutTier(normalise(mine, repo)),
    withoutTier(normalise(headReport, head.repo)),
    "the full report changed outside the new Tier section",
  );
});

// ---------------------------------------------------------------------------
// C9
// ---------------------------------------------------------------------------

test("C9 edge: at tier large the helpers line counts all four required helpers, the second reviewer standing for reviewer:opus", () => {
  const repo = largeTier("report-tier-c9");
  const required = REQUIRES("large");
  assert.equal(required.length, 4, "anchor: models.json tiers.large.requires");
  assert.ok(required.includes("reviewer:opus"), "anchor: models.json tiers.large.requires");

  subagentStop(repo, "done-gate:skeptic");
  subagentStop(repo, "done-gate:qa");
  subagentStop(repo, "done-gate:reviewer");

  const three = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.match(three, /^helpers: spawned 3 of 4\b/, three);

  subagentStop(repo, "done-gate:reviewer", { model: MODEL }); // the round-2 reviewer

  const four = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.match(four, /^helpers: spawned 4 of 4 required\b/, four);
  for (const entry of required) {
    assert.match(four, new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^,]*✓`), `${entry} is not ticked: ${four}`);
  }
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

test("C10 boundary: a closed ledger with no tier field at all reports a Tier block that says the size was never measured", () => {
  const repo = closedTieredFixture("report-tier-c10", "untiered-close");
  stopHook(repo);
  const dir = closedRunDir(repo);

  // an older ledger, written before tiers existed: no tier key at all
  const ledger = loadLedger(dir);
  delete ledger.tier;
  saveLedger(dir, ledger);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8")).tier, undefined);

  const r = run(repo, "report");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const block = tierLines(r.stdout);
  assert.ok(block, `a tier-less closed ledger still gets a Tier section:\n${r.stdout}`);
  assert.ok(block[0].includes("measured: not yet"), block[0]);

  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.equal(lines(brief).filter((l) => l.startsWith("Size:")).length, 0, `nothing was measured, so no Size line:\n${brief}`);
});

// ---------------------------------------------------------------------------
// C11
// ---------------------------------------------------------------------------

test("C11 edge: a reviewer-2 stop satisfies reviewer:opus and records the round 2 model", () => {
  const repo = largeTier("report-tier-c11");
  const required = REQUIRES("large");
  assert.ok(required.includes("reviewer:opus"), "anchor: models.json tiers.large.requires");

  subagentStop(repo, "done-gate:skeptic");
  subagentStop(repo, "done-gate:qa");
  subagentStop(repo, "done-gate:reviewer");
  subagentStop(repo, "done-gate:reviewer-2", { model: MODEL });

  const report = cli(repo, "report").stdout;

  const helpers = lineStarting(report, "helpers:");
  assert.match(helpers, /^helpers: spawned 4 of 4 required\b/, helpers);
  for (const entry of required) {
    assert.match(helpers, new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^,]*✓`), `${entry} is not ticked: ${helpers}`);
  }

  assert.equal(lineStarting(report, "round 2 model:"), `round 2 model: ${ESC.model} required, recorded: ${MODEL}`);
});
