import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { DEFAULT_POLICY, loadPolicy } from "../scripts/lib/size.mjs";
import { nextHint } from "../scripts/lib/next.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

// tests-by-the-lead: blind QA only at tier large, the lead writes the tests first below it;
// every helper runs on the session's model and no policy file names one. Cases C1–C9.

const MODELS = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
const LARGE_FILES = Array.from({ length: (MODELS.policy.tiers.standard.maxFiles ?? 10) + 1 }, (_, i) => `src/f${i}.ts`);
const STANDARD_FILES = LARGE_FILES.slice(0, 2);
const MODEL_NAME = /\b(sonnet|opus|haiku|fable)\b/i;

const envFor = (repo, session = "S1") => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session });
const REFUSAL = /^done-gate: /m;
function run(repo, verb, args = []) {
  return spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  return r.stderr;
}
function hook(repo, verb, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, verb], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const stop = (repo, id, type) => hook(repo, "log", { hook_event_name: "SubagentStop", agent_id: id, agent_type: type, stop_hook_active: false });

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));
const lineStarting = (text, prefix) => text.split("\n").find((l) => l.startsWith(prefix)) ?? "";

function opened(name, files, playbook = "feature") {
  const repo = makeRepo(name, Object.fromEntries(files.map((f) => [f, "export const x = 1;\n"])));
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, playbook]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["plan", "The plan.", "--files", files.join(",")]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1 happy — the policy names no model
// ---------------------------------------------------------------------------

test("C1 happy: models.json and DEFAULT_POLICY name no model, requires are per tier as designed, and an old models.json with roles and a model key still loads", () => {
  assert.ok(!("roles" in MODELS), "models.json still has a roles map");
  assert.deepEqual(MODELS.policy.tiers.small.requires, ["reviewer"]);
  assert.deepEqual(MODELS.policy.tiers.standard.requires, ["skeptic", "reviewer"]);
  assert.deepEqual(MODELS.policy.tiers.large.requires, ["skeptic", "qa", "worker", "reviewer", "reviewer-2"]);
  assert.deepEqual(MODELS.policy.escalate, { reviewerRound2: { whenActOnAtLeast: 2, orTier: "large" } });
  assert.doesNotMatch(JSON.stringify(MODELS), MODEL_NAME, "models.json names a model somewhere");

  assert.ok(!("roles" in DEFAULT_POLICY), "DEFAULT_POLICY still has roles");
  assert.deepEqual(DEFAULT_POLICY.tiers, MODELS.policy.tiers);
  assert.deepEqual(DEFAULT_POLICY.escalate, MODELS.policy.escalate);
  const p = loadPolicy();
  assert.ok(!("roles" in p));

  // an older models.json, as shipped before this task
  const old = makeRepo("tbl-c1-old", {
    "models.json": JSON.stringify({ roles: { qa: "opus" }, policy: { tiers: MODELS.policy.tiers, escalate: { reviewerRound2: { model: "opus", whenActOnAtLeast: 3, orTier: "large" } } } }),
  });
  const loaded = loadPolicy(path.join(old, "models.json"));
  assert.ok(!("roles" in loaded), "roles from an old file leaked into the policy");
  assert.equal(loaded.escalate.reviewerRound2.whenActOnAtLeast, 3, "the old file's own threshold is kept");
  assert.ok(!("model" in loaded.escalate.reviewerRound2), "the old model key leaked into the policy");
});

// ---------------------------------------------------------------------------
// C2 happy — every agent inherits the session's model
// ---------------------------------------------------------------------------

test("C2 happy: every agents/*.md says model: inherit, and no model name appears in agents/, models.json or scripts/lib outside a comment", () => {
  const agents = readdirSync(path.join(pluginRoot, "agents")).filter((f) => f.endsWith(".md"));
  assert.equal(agents.length, 6, `six agents expected: ${agents}`);
  for (const f of agents) {
    const text = readFileSync(path.join(pluginRoot, "agents", f), "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    assert.ok(fm, `${f}: no frontmatter`);
    assert.match(fm[1], /^model: inherit$/m, `${f}: model is not inherit`);
    assert.doesNotMatch(text, MODEL_NAME, `${f} names a model`);
  }
  const stripComments = (s) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const f of readdirSync(path.join(pluginRoot, "scripts", "lib")).filter((f) => f.endsWith(".mjs"))) {
    const code = stripComments(readFileSync(path.join(pluginRoot, "scripts", "lib", f), "utf8"));
    assert.doesNotMatch(code, MODEL_NAME, `scripts/lib/${f} names a model in code`);
  }
});

// ---------------------------------------------------------------------------
// C3 refused — gate brief qa below large
// ---------------------------------------------------------------------------

test("C3 refused: gate brief qa below tier large is refused and says to write the tests yourself; at large it writes the packet", () => {
  const standard = opened("tbl-c3-standard", STANDARD_FILES);
  const err = refused(standard, "brief", ["qa"]);
  assert.match(err, /write the tests yourself/i);
  assert.match(err, /\blarge\b/);
  const small = opened("tbl-c3-small", ["src/a.ts"]);
  refused(small, "brief", ["qa"]);

  const large = opened("tbl-c3-large", LARGE_FILES);
  assert.match(cli(large, "brief", ["qa"]).stdout, /packet: .*brief-qa-1\.md/);
});

// ---------------------------------------------------------------------------
// C4 happy — the {tests} step
// ---------------------------------------------------------------------------

test("C4 happy: feature, bugfix and refactor have a {tests} step (tests before code, red first) and no {qa} step; gate open copies it; skipping it is refused", () => {
  const playbook = readFileSync(path.join(pluginRoot, "skills", "gate", "playbooks.md"), "utf8");
  for (const name of ["feature", "bugfix", "refactor"]) {
    const m = new RegExp(`^## ${name}\\s*$`, "m").exec(playbook);
    const rest = playbook.slice(m.index + m[0].length);
    const body = rest.slice(0, /^## /m.exec(rest)?.index ?? rest.length);
    const testsStep = body.split("\n").find((l) => /\{tests\}\s*$/.test(l));
    assert.ok(testsStep, `${name}: no {tests} step`);
    assert.doesNotMatch(body, /\{qa\}/, `${name}: still has a {qa} step`);
    assert.match(testsStep, /before/i, `${name}: the tests step does not say before the code: ${testsStep}`);
    // feature and bugfix tests start red (the code does not exist yet); refactor pins start green and stay green
    assert.match(testsStep, name === "refactor" ? /\bgreen\b/i : /\bred\b/i, `${name}: the tests step does not say ${name === "refactor" ? "green" : "red"}: ${testsStep}`);
    assert.match(testsStep, /large[^.]*QA|QA[^.]*large/i, `${name}: the tests step does not send large to QA: ${testsStep}`);
  }
  const repo = opened("tbl-c4-open", ["src/a.ts"]);
  const keys = ledgerOf(repo).steps.map((s) => s.key);
  assert.ok(keys.includes("tests"), `gate open did not copy the tests step: ${keys}`);
  assert.ok(!keys.includes("qa"), `gate open still copies a qa step: ${keys}`);
  assert.match(refused(repo, "step", ["tests", "skipped", "no time"]), /DONE or WAIVED|cannot be skipped|evidenced/i);
});

// ---------------------------------------------------------------------------
// C5 edge — R7 wording and waivers
// ---------------------------------------------------------------------------

test("C5 edge: R7 names writing the tests and gate waive tests; a tests waiver satisfies it; an old ledger's qa waiver still does", () => {
  const repo = opened("tbl-c5-r7", ["src/a.ts"]);
  write(repo, "src/a.ts", "export const x = 2;\n");
  const r7 = lineStarting(cli(repo, "check").stdout.replace(/^\d+\. /gm, ""), "R7");
  assert.ok(r7, "R7 expected with source changed and no test file");
  assert.match(r7, /write the tests/i, r7);
  assert.match(r7, /gate waive tests/, r7);
  assert.doesNotMatch(r7, /Have QA write/, r7);

  cli(repo, "waive", ["tests", "user said so"]);
  assert.doesNotMatch(cli(repo, "check").stdout, /\bR7\b/, "a tests waiver did not satisfy R7");

  // the pure rule, with a ledger from before this task
  const config = loadConfig(repo);
  const state = { config, root: repo, ledger: { ...ledgerOf(repo), waivers: [{ key: "qa", reason: "old" }], steps: [], cases: [], huddles: [] }, changed: ["src/a.ts"], now: { files: {} }, verify: null, events: [], reviews: [], dir: runDir(repo) };
  assert.ok(!evaluate(state).some((u) => u.rule === "R7"), "an old qa waiver no longer satisfies R7");
});

// ---------------------------------------------------------------------------
// C6 happy — the tier block without models, and the round 2 line
// ---------------------------------------------------------------------------

test("C6 happy: gate size and the report print helpers without model names; the round 2 line is required by Act-on count or tier and recorded by a second reviewer or a reviewer-2 stop", () => {
  const small = opened("tbl-c6-small", ["src/a.ts"]);
  const size = cli(small, "size").stdout;
  assert.match(lineStarting(size, "requires:"), /^requires: reviewer\b/, size);
  assert.doesNotMatch(size, MODEL_NAME, size);
  const report = cli(small, "report").stdout;
  assert.match(lineStarting(report, "helpers:"), /spawned 0 of 1 required \(reviewer\)/, report);
  assert.equal(lineStarting(report, "round 2:"), "round 2: not required", report);

  // two Act-on items from round 1 require a second round
  const dir = runDir(small);
  write(small, path.relative(small, path.join(dir, "review-1.md")), "# Review 1\n\n## Act on\n- a\n- b\n\n## Consider\n- none\n\n## Dismissed\n- none\n");
  cli(small, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.equal(lineStarting(cli(small, "report").stdout, "round 2:"), "round 2: required, not yet");
  stop(small, "R1", "done-gate:reviewer");
  stop(small, "R1", "done-gate:reviewer");
  assert.equal(lineStarting(cli(small, "report").stdout, "round 2:"), "round 2: required, recorded");

  // at large the tier itself requires it, and a reviewer-2 stop records it
  const large = opened("tbl-c6-large", LARGE_FILES);
  assert.match(lineStarting(cli(large, "size").stdout, "requires:"), /^requires: skeptic, qa, worker, reviewer, reviewer-2\b/);
  assert.equal(lineStarting(cli(large, "report").stdout, "round 2:"), "round 2: required, not yet");
  stop(large, "R2", "done-gate:reviewer-2");
  const out = cli(large, "report").stdout;
  assert.equal(lineStarting(out, "round 2:"), "round 2: required, recorded");
  assert.match(lineStarting(out, "helpers:"), /reviewer-2 ✓/);
  assert.doesNotMatch(out, /round 2 model/);
});

// ---------------------------------------------------------------------------
// C7 happy — the hints
// ---------------------------------------------------------------------------

test("C7 happy: the tests hint says to write the tests first from the case table and the implement hint never says QA's tests", () => {
  const steps = (key) => [{ n: 1, key, text: key, state: null, note: null, evidence: null, seq: 1 }];
  const base = { status: "open", playbook: "feature", taskSeq: 1, planSeq: 2, cases: [{ id: "C1", status: "closed" }], huddles: [], waivers: [] };
  const tests = nextHint({ ...base, steps: steps("tests") });
  assert.match(tests, /write the tests/i, tests);
  assert.match(tests, /case table/, tests);
  assert.match(tests, /\bred\b/i, tests);
  assert.match(tests, /gate step tests done/, tests);
  assert.match(tests, /large[^;]*gate brief qa/i, tests);
  const implement = nextHint({ ...base, steps: steps("implement") });
  assert.doesNotMatch(implement, /QA's tests/, implement);
  assert.match(implement, /the tests and the code disagree/i, implement);
});

// ---------------------------------------------------------------------------
// C8 happy — the prose
// ---------------------------------------------------------------------------

test("C8 happy: reviewer.md names weak tests as Act-on; README, SKILL.md and session-start say the lead writes the tests below large; SKILL.md stays under 4096 bytes", () => {
  const read = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");
  const reviewer = read("agents/reviewer.md");
  assert.match(reviewer, /asserts? on a mock/i, "reviewer.md: mock");
  assert.match(reviewer, /own constant/i, "reviewer.md: implementation's own constant");
  assert.match(reviewer, /cannot fail/i, "reviewer.md: cannot fail");
  assert.doesNotMatch(reviewer, /different model/i, "reviewer.md: old wording");
  const readme = read("README.md");
  assert.match(readme, /\| small \|[^\n]*\| reviewer \|/, "README tier table: small requires the reviewer only");
  assert.match(readme, /\| standard \|[^\n]*\| skeptic, reviewer \|/, "README tier table: standard");
  assert.match(readme, /\| large \|[^\n]*QA[^\n]*\|/, "README tier table: large has QA");
  assert.doesNotMatch(readme, /QA \(Opus\)|reviewer \(Sonnet\)|skeptic \(Sonnet\)/, "README tier table names models");
  const skill = read("skills/gate/SKILL.md");
  assert.ok(Buffer.byteLength(skill) < 4096, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  assert.match(skill, /tests first|write the tests/i, "SKILL: tests first");
  assert.match(skill, /large[^.]{0,80}QA|QA[^.]{0,80}large/i, "SKILL: QA at large");
  const start = read("hooks/session-start.md");
  assert.match(start, /tests? first|write(s)? the tests/i, "session-start: the lead writes the tests");
});

// ---------------------------------------------------------------------------
// C9 idempotent — large is unchanged
// ---------------------------------------------------------------------------

test("C9 idempotent: at tier large gate brief qa writes the packet, huddle add qa --summary is recorded, and the helpers line counts qa and worker", () => {
  const repo = opened("tbl-c9-large", LARGE_FILES);
  cli(repo, "brief", ["qa"]);
  cli(repo, "huddle", ["add", "qa", "--summary", "6 tests written"]);
  assert.equal(ledgerOf(repo).huddles[0].role, "qa");
  stop(repo, "Q1", "done-gate:qa");
  stop(repo, "W1", "done-gate:worker");
  const helpers = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.match(helpers, /qa ✓/);
  assert.match(helpers, /worker ✓/);
  assert.match(helpers, /spawned 2 of 5 required/);
});
