// steps-from-facts: on a run under the new rules the gate closes tests, implement, driver and
// review itself from what it recorded, so the lead types no `gate step` for them. Schema stays by
// hand, a closed step is never re-blanked, and the rules that judge the same facts still do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asOldRun, gate, makeRepo, planChecked, readyToEdit } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function envFor(repo) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}
const run = (repo, args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: envFor(repo), input: "" });
function cli(repo, ...args) {
  const r = run(repo, args);
  assert.equal(r.status, 0, `gate ${args.join(" ")}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}
const hook = (repo, payload) => execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), env: envFor(repo) });

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const stepOf = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key);

// a fast verify that runs a test command; ui, api and schema declared, so the surfaces are judged
const CONFIG = { testFiles: null, verify: ["npm test"], ui: ["src/app/**"], api: ["src/api/**"], schema: ["db/**"] };
function committed(name, config = CONFIG) {
  const repo = makeRepo(name, { "src/b.ts": "export const b = 1;\n", "src/api/route.ts": "export const r = 1;\n", ".claude/gate.json": JSON.stringify(config) });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
function planned(name, files = "src/a.ts,src/b.ts", { old = false, config } = {}) {
  const repo = committed(name, config);
  cli(repo, "open", name, "feature");
  if (old) asOldRun(repo);
  readyToEdit(repo, { plan: ["--files", files] });
  if (ledgerOf(repo).checkHold) planChecked(repo);
  return repo;
}
// an edit the PostToolUse hook saw; `at` sets the file's mtime (ms since the epoch)
function edited(repo, rel, content, at = null) {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), content);
  if (at) utimesSync(path.join(repo, rel), at / 1000, at / 1000);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_response: {} });
}
const ran = (repo, command, exit = 0) => hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { exit_code: exit } });
const PAST = () => Date.now() - 60_000;
const FUTURE = () => Date.now() + 60_000;

test("C1 happy: a test run after the test file closes the tests step, red or green, and the note keeps the first run", () => {
  const repo = planned("sff-c1");
  edited(repo, "tests/a.test.ts", "test('a0 is 2', () => {});\n", PAST());
  ran(repo, "npm test -- tests/a.test.ts", 1);
  ran(repo, "npm test -- tests/a.test.ts", 0);
  cli(repo, "check");
  const step = stepOf(repo, "tests");
  assert.equal(step.state, "DONE");
  assert.equal(step.auto, "fact");
  assert.match(step.note, /npm test -- tests\/a\.test\.ts/);
  assert.match(step.note, /exit 1/);
  assert.match(step.evidence, /^events#\d+$/);
});

test("C2 refused: a test run before the newest test file does not close the tests step", () => {
  const repo = planned("sff-c2");
  ran(repo, "npm test", 0);
  edited(repo, "tests/a.test.ts", "test('later', () => {});\n", FUTURE());
  cli(repo, "check");
  assert.equal(stepOf(repo, "tests").state, null);
});

test("C2 refused: a test run after the first code edit is not the tests-first run, so a fix's green run does not close the step", () => {
  const repo = planned("sff-c2-after");
  edited(repo, "tests/a.test.ts", "test('a is 2', () => {});\n", PAST());
  edited(repo, "src/a.ts", "export const a = 2;\n");
  ran(repo, "npm test", 0);
  cli(repo, "check");
  assert.equal(stepOf(repo, "tests").state, null);
});

test("C1 happy: QA's test run counts like the lead's", () => {
  const repo = planned("sff-c1-qa");
  edited(repo, "tests/a.test.ts", "test('a is 2', () => {});\n", PAST());
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 1 }, agent_id: "Q1", agent_type: "done-gate:qa" });
  cli(repo, "check");
  assert.equal(stepOf(repo, "tests").state, "DONE");
});

test("C10 reported-surface: right after a green gate verify the hint no longer names implement", () => {
  const repo = planned("sff-c10-verify");
  cli(repo, "step", "tests", "done", "red first", "--evidence", "tests/a.test.ts");
  edited(repo, "src/a.ts", "export const a = 2;\n");
  edited(repo, "tests/a.test.ts", "test('a', () => {});\n");
  const out = cli(repo, "verify");
  assert.equal(stepOf(repo, "implement").state, "DONE");
  assert.doesNotMatch(out.split("\n").find((l) => l.startsWith("next:")) ?? "", /implement/);
});

test("C3 happy: gate test, and a verify that ran a test command after the test file, close the tests step", () => {
  const viaGateTest = planned("sff-c3-test");
  edited(viaGateTest, "tests/a.test.ts", "test('a is 2', () => {});\n", PAST());
  ran(viaGateTest, `node ${gate} test tests/a.test.ts`, 0);
  cli(viaGateTest, "check");
  assert.equal(stepOf(viaGateTest, "tests").state, "DONE");

  const viaVerify = planned("sff-c3-verify");
  edited(viaVerify, "tests/a.test.ts", "test('a is 2', () => {});\n", PAST());
  cli(viaVerify, "verify");
  const step = stepOf(viaVerify, "tests");
  assert.equal(step.state, "DONE");
  assert.equal(step.evidence, "verify.json");
});

test("C4 happy: a green verify after a source change closes the implement step", () => {
  const repo = planned("sff-c4");
  edited(repo, "src/a.ts", "export const a = 2;\n");
  edited(repo, "tests/a.test.ts", "test('a', () => {});\n");
  cli(repo, "verify");
  const step = stepOf(repo, "implement");
  assert.equal(step.state, "DONE");
  assert.equal(step.auto, "fact");
  assert.equal(step.evidence, "verify.json");
});

test("C5 edge: a green verify with no source change leaves implement blank, and so does a red one; an owed final check does not hold it", () => {
  const none = planned("sff-c5-none");
  edited(none, "tests/a.test.ts", "test('a', () => {});\n");
  cli(none, "verify");
  assert.equal(stepOf(none, "implement").state, null);

  const red = planned("sff-c5-red", "src/a.ts,src/b.ts", { config: { ...CONFIG, verify: ["false"] } });
  edited(red, "src/a.ts", "export const a = 2;\n");
  run(red, ["verify"]);
  assert.equal(stepOf(red, "implement").state, null);

  const final = planned("sff-c5-final", "src/a.ts,src/b.ts", { config: { ...CONFIG, verify: [{ cmd: "true" }, { cmd: "npm test", when: "final" }] } });
  edited(final, "src/a.ts", "export const a = 2;\n");
  cli(final, "verify");
  assert.equal(stepOf(final, "implement").state, "DONE", "the final check is R3's, not implement's");
});

test("C6 happy: a drive recorded after the last UI edit closes the driver step; one before the edit does not", () => {
  const repo = planned("sff-c6", "src/a.ts,src/app/page.tsx");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "http://localhost:3000" }, tool_response: {} });
  edited(repo, "src/app/page.tsx", "export default () => 1;\n");
  cli(repo, "check");
  assert.equal(stepOf(repo, "driver").state, null, "a drive before the edit");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "http://localhost:3000" }, tool_response: {} });
  cli(repo, "check");
  const step = stepOf(repo, "driver");
  assert.equal(step.state, "DONE");
  assert.match(step.evidence, /^events#\d+$/);
  // a gate close is not a worked-out mark: checks and a green verify leave it, byte for byte
  const bytes = readFileSync(path.join(runDir(repo), "ledger.json"), "utf8");
  cli(repo, "check");
  assert.equal(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"), bytes);
  cli(repo, "verify");
  assert.equal(stepOf(repo, "driver").state, "DONE");
  assert.equal(stepOf(repo, "driver").evidence, step.evidence);
});

test("C7 edge: with an API file changed the driver step waits for the --ran close", () => {
  const repo = planned("sff-c7", "src/app/page.tsx,src/api/route.ts");
  edited(repo, "src/app/page.tsx", "export default () => 1;\n");
  edited(repo, "src/api/route.ts", "export const r = 2;\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "http://localhost:3000" }, tool_response: {} });
  cli(repo, "check");
  assert.equal(stepOf(repo, "driver").state, null);
});

function reviewRound(repo, n, actOn = "- none") {
  hook(repo, { hook_event_name: "SubagentStop", agent_id: `R${n}`, agent_type: "done-gate:reviewer", stop_hook_active: false });
  writeFileSync(path.join(runDir(repo), `review-${n}.md`), `# Review ${n}\n\n## Act on\n${actOn}\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: npm test exit 0 (ran it myself)\n`);
  return cli(repo, "huddle", "add", "reviewer", "--file", `review-${n}.md`);
}

test("C8 happy: a clean reviewer round closes review, an open item does not, and a later edit never reopens it while R5 asks again", () => {
  const open = planned("sff-c8-open");
  edited(open, "src/a.ts", Array.from({ length: 30 }, (_, i) => `export const a${i} = 2;`).join("\n") + "\n");
  cli(open, "brief", "reviewer");
  reviewRound(open, 1, "- a0 drops the null case — src/a.ts:1");
  assert.equal(stepOf(open, "review").state, null);

  const repo = planned("sff-c8");
  edited(repo, "src/a.ts", Array.from({ length: 30 }, (_, i) => `export const a${i} = 2;`).join("\n") + "\n");
  cli(repo, "brief", "reviewer");
  reviewRound(repo, 1);
  cli(repo, "check");
  const step = stepOf(repo, "review");
  assert.equal(step.state, "DONE");
  assert.equal(step.evidence, "review-1.md");
  edited(repo, "src/b.ts", "export const b = 2;\n");
  const after = cli(repo, "check");
  assert.equal(stepOf(repo, "review").state, "DONE", "never re-blanked");
  assert.match(after, /R5/, "R5 still asks for a round on the new lines");
});

test("C9 edge: schema stays by hand, an old run closes nothing by itself, and a hand-closed step keeps its note", () => {
  const schema = planned("sff-c9-schema", "src/a.ts,db/001.sql");
  edited(schema, "db/001.sql", "create table t (id int);\n");
  cli(schema, "verify");
  assert.equal(stepOf(schema, "schema").state, null);

  const old = planned("sff-c9-old", "src/a.ts,src/b.ts", { old: true });
  edited(old, "src/a.ts", "export const a = 2;\n");
  edited(old, "tests/a.test.ts", "test('a is 2', () => {});\n", PAST());
  ran(old, "npm test", 0);
  cli(old, "verify");
  assert.equal(stepOf(old, "tests").state, null);
  assert.equal(stepOf(old, "implement").state, null);

  const hand = planned("sff-c9-hand");
  edited(hand, "tests/a.test.ts", "test('a is 2', () => {});\n", PAST());
  cli(hand, "step", "tests", "done", "red first: 1 failing", "--evidence", "tests/a.test.ts");
  ran(hand, "npm test", 0);
  cli(hand, "check");
  assert.equal(stepOf(hand, "tests").note, "red first: 1 failing");
  assert.equal(stepOf(hand, "tests").auto, undefined);
});

test("C10 reported-surface: the hints on a run under the new rules say these steps close themselves; an old run's keep gate step", () => {
  const nextOf = (repo) => cli(repo, "next").split("\n").find((l) => l.startsWith("next:"));
  const repo = planned("sff-c10");
  const tests = nextOf(repo);
  assert.match(tests, /\{?tests\}?|step 5/);
  assert.match(tests, /closes itself/);
  assert.doesNotMatch(tests, /gate step tests done/);
  const old = planned("sff-c10-old", "src/a.ts,src/b.ts", { old: true });
  cli(old, "step", "skeptic", "na", "an old run");
  assert.match(nextOf(old), /gate step tests done/);
  const text = readFileSync(new URL("../scripts/lib/next.mjs", import.meta.url), "utf8");
  for (const key of ["implement", "driver", "review"]) assert.ok(text.includes(`${key}: `), key);
});

test("C11 reported-surface: gate open's short view leaves out the self-closing steps and says so; gate steps lists every step", () => {
  const repo = committed("sff-c11");
  const opened = cli(repo, "open", "sff-c11", "feature");
  for (const key of ["skeptic", "tests", "implement", "driver", "review"]) assert.doesNotMatch(opened, new RegExp(`\\{${key}\\}`), key);
  for (const key of ["context", "plan", "cases", "verify", "schema", "close"]) assert.match(opened, new RegExp(`\\{${key}\\}`), key);
  assert.match(opened, /the gate closes .*skeptic.*review.* itself/);
  const all = cli(repo, "steps");
  for (const key of ["skeptic", "tests", "implement", "driver", "review"]) assert.match(all, new RegExp(`\\{${key}\\}`), key);
});

test("C12 reported-surface: the report marks a step the gate closed", () => {
  const repo = planned("sff-c12");
  edited(repo, "src/a.ts", "export const a = 2;\n");
  edited(repo, "tests/a.test.ts", "test('a is 2', () => {});\n", PAST());
  cli(repo, "verify");
  const line = cli(repo, "report").split("\n").find((l) => /Implement/.test(l) && /DONE/.test(l));
  assert.match(line ?? "", /by the gate/, line);
});
