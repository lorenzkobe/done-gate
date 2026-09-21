import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadPolicy } from "../scripts/lib/size.mjs";
import { nextHint } from "../scripts/lib/next.mjs";

// lead-implements: the lead edits source at small and standard; the worker hand-off, the
// fence and R16 apply at tier large only. Cases C1–C8 of the task's case table.

const MODELS = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
const STANDARD_FILES = Array.from({ length: MODELS.policy.tiers.small.maxFiles + 1 }, (_, i) => `src/f${i}.ts`);
const LARGE_FILES = Array.from({ length: MODELS.policy.tiers.standard.maxFiles + 1 }, (_, i) => `src/f${i}.ts`);

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
  return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null;
}
// null when allowed, else the deny reason
function fence(repo, tool, file, extra = {}) {
  const out = hook(repo, "fence", { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path.join(repo, file) }, ...extra });
  return out ? out.hookSpecificOutput.permissionDecisionReason : null;
}
const leadEdit = (repo, file) => hook(repo, "log", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, file) }, tool_output: "" });

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));
const r16 = (repo) => cli(repo, "check").stdout.split("\n").filter((l) => /\bR16\b/.test(l));

function opened(name, files) {
  const repo = makeRepo(name, Object.fromEntries(files.map((f) => [f, "export const x = 1;\n"])));
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["plan", "The plan.", "--files", files.join(",")]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1 happy — standard: the lead edits
// ---------------------------------------------------------------------------

test("C1 happy: at predicted standard the lead's Edit/Write on source and tests is allowed and R16 stays silent", () => {
  const repo = opened("li-c1-standard", STANDARD_FILES);
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  assert.equal(fence(repo, "Edit", "src/f0.ts"), null, "Edit on source at standard");
  assert.equal(fence(repo, "Write", "tests/a.test.ts"), null, "Write on tests at standard");
  write(repo, "src/f0.ts", "export const x = 2;\n");
  leadEdit(repo, "src/f0.ts");
  assert.deepEqual(r16(repo), [], "R16 at standard");
  assert.equal(ledgerOf(repo).tier.predictedSeq, null, "no delegation mark below large");
});

// ---------------------------------------------------------------------------
// C2 happy — large: still fenced and still R16
// ---------------------------------------------------------------------------

test("C2 happy: at predicted large the lead's source edit is denied by the fence and flagged by R16 naming size large", () => {
  const repo = opened("li-c2-large", LARGE_FILES);
  assert.equal(ledgerOf(repo).tier.predicted, "large");
  const reason = fence(repo, "Edit", "src/f0.ts");
  assert.ok(reason, "a lead Edit at large must be denied");
  assert.match(reason, /\blarge\b/);
  assert.match(reason, /gate brief worker/);
  write(repo, "src/f0.ts", "export const x = 2;\n");
  leadEdit(repo, "src/f0.ts");
  const found = r16(repo);
  assert.equal(found.length, 1, `one R16 expected:\n${found.join("\n")}`);
  assert.match(found[0], /\blarge\b/);
  assert.equal(typeof ledgerOf(repo).tier.predictedSeq, "number", "the delegation mark is stamped at large");
});

// ---------------------------------------------------------------------------
// C3 boundary — growth: only a measured large fences
// ---------------------------------------------------------------------------

test("C3 boundary: a small task that grows to a measured large fences the lead's next edit; one that grows only to standard does not", () => {
  const toStandard = opened("li-c3-standard", ["src/a.ts"]);
  write(toStandard, "src/a.ts", "export const a = 2;\n");
  write(toStandard, "src/b.ts", "export const b = 1;\n");
  write(toStandard, "src/c.ts", "export const c = 1;\n");
  cli(toStandard, "check");
  assert.equal(ledgerOf(toStandard).tier.measured.tier, "standard");
  assert.equal(fence(toStandard, "Edit", "src/d.ts"), null, "measured standard does not fence");

  const toLarge = opened("li-c3-large", ["src/a.ts"]);
  for (const f of LARGE_FILES) write(toLarge, f, "export const y = 2;\n");
  cli(toLarge, "check");
  assert.equal(ledgerOf(toLarge).tier.measured.tier, "large");
  const reason = fence(toLarge, "Edit", "src/z.ts");
  assert.ok(reason, "measured large fences the lead");
  assert.match(reason, /\blarge\b/);
});

// ---------------------------------------------------------------------------
// C4 refused — gate brief worker below large
// ---------------------------------------------------------------------------

test("C4 refused: gate brief worker below tier large is refused and says to implement yourself; at large it writes the packet", () => {
  const standard = opened("li-c4-standard", STANDARD_FILES);
  const err = refused(standard, "brief", ["worker"]);
  assert.match(err, /implement (it )?yourself/i);
  assert.match(err, /\blarge\b/);

  const large = opened("li-c4-large", LARGE_FILES);
  const r = cli(large, "brief", ["worker"]);
  assert.match(r.stdout, /packet: .*brief-worker-1\.md/);
});

// ---------------------------------------------------------------------------
// C5 happy — the policy knob
// ---------------------------------------------------------------------------

test("C5 happy: models.json carries delegatesAt: large, loadPolicy exposes it, and a models.json without it defaults to large", () => {
  assert.equal(MODELS.policy.delegatesAt, "large");
  assert.equal(loadPolicy().delegatesAt, "large");
  const repo = makeRepo("li-c5-policy", { "models.json": JSON.stringify({ policy: { tiers: MODELS.policy.tiers } }) });
  assert.equal(loadPolicy(path.join(repo, "models.json")).delegatesAt, "large");
  const custom = makeRepo("li-c5-custom", { "models.json": JSON.stringify({ policy: { delegatesAt: "standard" } }) });
  assert.equal(loadPolicy(path.join(custom, "models.json")).delegatesAt, "standard", "a repo may still delegate at standard");
});

// ---------------------------------------------------------------------------
// C6 idempotent — large is unchanged
// ---------------------------------------------------------------------------

test("C6 idempotent: at large a worker edits source and tests, another role does not, and a delegate waiver lifts the fence", () => {
  const repo = opened("li-c6-large", LARGE_FILES);
  const worker = { agent_id: "W1", agent_type: "done-gate:worker" };
  assert.equal(fence(repo, "Edit", "src/f0.ts", worker), null, "worker edits source");
  assert.equal(fence(repo, "Write", "tests/a.test.ts", worker), null, "worker edits tests");
  assert.ok(fence(repo, "Edit", "src/f0.ts", { agent_id: "R1", agent_type: "done-gate:reviewer" }), "a reviewer never edits source");
  assert.ok(fence(repo, "Edit", "src/f0.ts"), "the lead is fenced at large");
  cli(repo, "waive", ["delegate", "user said so"]);
  assert.equal(fence(repo, "Edit", "src/f0.ts"), null, "the waiver lifts the fence");
});

// ---------------------------------------------------------------------------
// C7 happy — the review hint
// ---------------------------------------------------------------------------

test("C7 happy: the review hint tells the lead to fix and resolve items itself below large and to brief the worker at large", () => {
  const steps = [{ n: 1, key: "review", text: "review", state: null, note: null, evidence: null, seq: 1 }];
  const h = nextHint({ status: "open", playbook: "feature", taskSeq: 1, planSeq: 2, cases: [{ id: "C1", status: "closed" }], steps, huddles: [], waivers: [] });
  assert.match(h, /below large|small and standard|small or standard/i, h);
  assert.match(h, /gate huddle resolve/, h);
  assert.match(h, /at (size )?large[^;]*gate brief worker/i, h);
  assert.match(h, /gate huddle reply/, h);
  assert.doesNotMatch(h, /at standard and up/, h);
});

// ---------------------------------------------------------------------------
// C8 happy — the prose
// ---------------------------------------------------------------------------

test("C8 happy: SKILL.md, hooks/session-start.md, README and agents/worker.md say the lead implements below large and the worker is for size large; SKILL.md stays under 4096 bytes", () => {
  const read = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");
  const skill = read("skills/gate/SKILL.md");
  assert.ok(Buffer.byteLength(skill) < 4096, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  assert.match(skill, /(small|standard)[^.]{0,80}(yourself|your own)/i, "SKILL: the lead implements below large");
  assert.match(skill, /large[^.]{0,120}worker/i, "SKILL: the worker is for large");
  assert.doesNotMatch(skill, /standard or large: never edit/i, "SKILL: old wording");
  const start = read("hooks/session-start.md");
  assert.match(start, /large[^.]{0,120}never edits? source|never edits? source[^.]{0,120}large/i, "session-start: fenced at large");
  assert.match(start, /standard[^.]{0,80}(edits? (it )?(itself|yourself)|lead edits)/i, "session-start: the lead edits at standard");
  const readme = read("README.md");
  assert.match(readme, /R16[^\n]*\blarge\b/, "README R16 row names large");
  assert.doesNotMatch(readme, /delegates at size standard and up/i, "README: old wording");
  const worker = read("agents/worker.md");
  assert.match(worker, /size large/i, "worker.md description");
  assert.doesNotMatch(worker, /standard and above/i, "worker.md old wording");
});
