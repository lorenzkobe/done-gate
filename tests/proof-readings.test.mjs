import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { testTotals } from "../scripts/lib/verify.mjs";
import { eventsFromHookInput, readEvents } from "../scripts/lib/events.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// D1 Part A: the hook keeps what a test run, an API call or a browser call reached, and on a run
// under the new rules a close on such a run needs that reading to show it reached something.

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const env = (repo) => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
};
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: env(repo) });
const REFUSAL = /^done-gate: /m;
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.match(r.stderr, REFUSAL, `expected gate ${verb} ${args.join(" ")} to be refused:\n${r.stdout}`);
  return r.stderr;
}
const hook = (repo, payload) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: env(repo) });
const lastEvent = (repo, kind = "command") => readEvents(stateDir(repo), "S1").filter((e) => e.kind === kind).at(-1);
// a Bash call as the hook gets it: a clean one with its output, a failed one with the error text
function shell(repo, command, output = "", exit = 0) {
  hook(repo, exit
    ? { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error: `Exit code ${exit}\n${output}` }
    : { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: output, stderr: "", interrupted: false } });
  return lastEvent(repo);
}
function edited(repo, rel, content) {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_response: {} });
}
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
// the reply a Chrome call gets: text blocks, the last naming the tab it ran on
const tabReply = (url, text = `Navigated to ${url}`) => [
  { type: "text", text },
  { type: "text", text: `\n\nTab Context:\n- Executed on tabId: 11\n- Available tabs:\n  • tabId 10: "Other" ("http://localhost:3000/other")\n  • tabId 11: "App" ("${url}")` },
];
const NODE_RED = "✖ failing tests:\n\ntest at tests/a.test.ts:3:1\n✖ adds (1ms)\n\nℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\n";
const NODE_NONE = "ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ fail 0\n";
const VITEST_GREEN = " Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  650ms\n";

test("C1 testTotals reads node, vitest, rtk vitest, jest, mocha, pytest and cargo summaries", () => {
  const cases = [
    ["ℹ tests 5\nℹ suites 1\nℹ pass 4\nℹ fail 1\nℹ cancelled 0\n", 5, 4, 1],
    ["# tests 2\n# suites 0\n# pass 2\n# fail 0\n", 2, 2, 0],
    [" Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 35 passed (36)\n", 36, 35, 1],
    ["PASS (36) FAIL (0)\n", 36, 36, 0],
    ["Tests:       1 failed, 2 passed, 3 total\nSnapshots:   0 total\n", 3, 2, 1],
    ["  2 passing (5ms)\n  1 failing\n", 3, 2, 1],
    ["==================== 1 failed, 2 passed in 0.12s ====================\n", 3, 2, 1],
    ["3 passed in 0.01s\n", 3, 3, 0],
    ["test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\ntest result: ok. 1 passed; 1 failed; 0 ignored\n", 5, 4, 1],
  ];
  for (const [output, tests, passed, failed] of cases) {
    const read = testTotals(output);
    assert.ok(read, `no reading for ${JSON.stringify(output)}`);
    assert.deepEqual([read.tests, read.passed, read.failed, read.ran], [tests, passed, failed, true], JSON.stringify(output));
  }
  assert.equal(testTotals("\x1b[32m      Tests  3 passed (3)\x1b[0m\n").tests, 3, "colour codes are stripped");
});

test("C2 testTotals: a runner's no-tests line reads as nothing ran; output it cannot read gives null", () => {
  for (const output of ["No test files found, exiting with code 0\n", NODE_NONE, "PASS (0) FAIL (0)\n"]) {
    assert.deepEqual(testTotals(output), { tests: 0, passed: 0, failed: 0, ran: false }, output);
  }
  for (const output of ["hello world\n", "", "Done in 2.1s\n"]) assert.equal(testTotals(output), null, output);
});

test("C3 a test run logged by the hook carries its totals; a failed one its failing names, at most five", () => {
  const [green] = eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npx vitest run" }, tool_response: { stdout: "", stderr: VITEST_GREEN } }, "/repo");
  assert.deepEqual(green.tests, { tests: 3, passed: 3, failed: 0, ran: true });
  const [red] = eventsFromHookInput({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "node --test tests/a.test.ts" }, error: `Exit code 1\n${NODE_RED}` }, "/repo");
  assert.equal(red.exit, 1);
  assert.deepEqual(red.tests, { tests: 3, passed: 2, failed: 1, ran: true, names: ["tests/a.test.ts › adds"] });
  const many = Array.from({ length: 7 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`).join("\n");
  const [seven] = eventsFromHookInput({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "node --test" }, error: `Exit code 1\n${many}\n# tests 7\n# pass 0\n# fail 7\n` }, "/repo");
  assert.equal(seven.tests.names.length, 5);
  assert.equal(seven.tests.failed, 7);
});

test("C4 a command that is not a test run or a call carries no reading, nor does a background run", () => {
  const [ls] = eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, tool_response: { stdout: VITEST_GREEN } }, "/repo");
  assert.equal(ls.tests, undefined);
  assert.equal(ls.call, undefined);
  const [bg] = eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true }, tool_response: { stdout: VITEST_GREEN } }, "/repo");
  assert.equal(bg.tests, undefined);
});

const callOf = (command, stdout) => eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "" } }, "/repo")[0].call;

test("C5 a curl or httpie call carries its method, url and status", () => {
  assert.deepEqual(callOf("curl -si -X POST http://localhost:3000/api/bookings -d x=1", "HTTP/1.1 201 Created\ncontent-type: application/json\n\n{}"), { method: "POST", url: "http://localhost:3000/api/bookings", status: 201 });
  assert.deepEqual(callOf("rtk curl -si http://localhost:3000/api/bookings", "HTTP/1.1 200 OK\n\n[]"), { method: "GET", url: "http://localhost:3000/api/bookings", status: 200 });
  assert.equal(callOf("curl -s -d a=1 localhost:3000/api/x", "{}").method, "POST");
  assert.equal(callOf("curl -s localhost:3000/api/x", "{}").url, "localhost:3000/api/x");
  assert.equal(callOf("curl -sS -o /dev/null -w '%{http_code}' localhost:3000/api/x", "404").status, 404);
  assert.deepEqual(callOf("http POST localhost:3000/api/x name=a", "HTTP/1.1 201 Created\n\n{}"), { method: "POST", url: "localhost:3000/api/x", status: 201 });
});

test("C6 a call with no status line keeps its url with status null; a followed redirect takes the last status", () => {
  assert.deepEqual(callOf("curl -s http://localhost:3000/api/x", '{"ok":true}'), { method: "GET", url: "http://localhost:3000/api/x", status: null });
  assert.equal(callOf("curl -siL http://localhost:3000/a", "HTTP/1.1 302 Found\nLocation: /b\n\nHTTP/1.1 200 OK\n\n{}").status, 200);
  assert.equal(callOf("curl -s http://localhost:3000/api/x", "the body says HTTP/1.1 500 in a sentence").status, null, "a status mid-line is not the status line");
});

test("C7 a Chrome call carries the url of the tab its reply says it ran on", () => {
  const browse = (tool, tool_input, tool_response) => eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: `mcp__claude-in-chrome__${tool}`, tool_input, tool_response }, "/repo")[0];
  assert.equal(browse("navigate", { url: "http://localhost:3000/a" }, tabReply("http://localhost:3000/a")).page, "http://localhost:3000/a");
  assert.equal(browse("computer", { action: "left_click", ref: "ref_1" }, tabReply("http://localhost:3000/b", "Clicked on element ref_1")).page, "http://localhost:3000/b");
  assert.equal(browse("computer", { action: "left_click", ref: "ref_1" }, { content: tabReply("http://localhost:3000/c") }).page, "http://localhost:3000/c");
  assert.equal(browse("resize_window", { width: 500 }, [{ type: "text", text: "Successfully resized window" }]).page, undefined);
  assert.equal(browse("navigate", { url: "http://x" }, {}).page, undefined);
});

function bugfix(name) {
  const repo = makeRepo(name);
  cli(repo, "open", ["red-run", "bugfix"]);
  cli(repo, "note", ["task", "A bug. [inferred]"]);
  return repo;
}

test("C8 a repro --ran on a test run that ran no test is refused; one that ran a failing test closes and prints its totals", () => {
  const repo = bugfix("pr-c8");
  shell(repo, "node --test tests/a.test.ts", NODE_NONE);
  assert.match(refused(repo, "step", ["repro", "done", "fails (src/a.ts:1)", "--ran", "node --test tests/a.test.ts"]), /no test ran/);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "repro").state, null);
  shell(repo, "node --test tests/a.test.ts", NODE_RED, 1);
  const out = cli(repo, "step", ["repro", "done", "fails (src/a.ts:1)", "--ran", "node --test tests/a.test.ts"]);
  assert.match(out, /3 tests, 2 passed, 1 failed/);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "repro").state, "DONE");
});

test("C9 a test run the gate cannot read still closes a --ran step, and the close says the totals were not read", () => {
  const repo = bugfix("pr-c9");
  shell(repo, "npm test -- badge", "> x@1 test\n> custom-runner\nall good\n", 1);
  const out = cli(repo, "step", ["repro", "done", "fails (src/a.ts:1)", "--ran", "npm test -- badge"]);
  assert.match(out, /test totals not read/);
});

function feature(name, files = {}) {
  const repo = committed(name, files);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  return repo;
}

test("C10 a case --ran on a test run that names no test file is refused; one naming a test file that ran a test closes", () => {
  const repo = feature("pr-c10");
  cli(repo, "case", ["add", "the badge renders", "--kind", "happy"]);
  shell(repo, "npm test", VITEST_GREEN);
  assert.match(refused(repo, "case", ["close", "C1", "--ran", "npm test"]), /names no test file/);
  shell(repo, "npx vitest run tests/a.test.ts", NODE_NONE);
  assert.match(refused(repo, "case", ["close", "C1", "--ran", "vitest run tests/a.test.ts"]), /no test ran/);
  shell(repo, "npx vitest run tests/a.test.ts", VITEST_GREEN);
  cli(repo, "case", ["close", "C1", "--ran", "vitest run tests/a.test.ts"]);
  assert.equal(ledgerOf(repo).cases[0].status, "closed");
  assert.match(cli(repo, "report"), /\| C1 \|.*ran: .*vitest run tests\/a\.test\.ts.*\(3 tests, 3 passed\)/);
});

const API = (extra = {}) => ({ ".claude/gate.json": JSON.stringify({ testFiles: null, api: ["app/api/**"], ...extra }) });
const STATUS = (n, why = "OK") => `HTTP/1.1 ${n} ${why}\ncontent-type: application/json\n\n{}`;

test("C11 the driver step on an API change refuses a 500, a call with no status and a call to another route", () => {
  const repo = feature("pr-c11", API());
  edited(repo, "app/api/users/route.ts", "export const GET = 2;\n");
  shell(repo, "curl -si localhost:3000/api/users", STATUS(500, "Internal Server Error"));
  assert.match(refused(repo, "step", ["driver", "done", "no", "--ran", "curl -si localhost:3000/api/users"]), /500/);
  shell(repo, "curl -s localhost:3000/api/users", "{}");
  assert.match(refused(repo, "step", ["driver", "done", "no", "--ran", "curl -s localhost:3000/api/users"]), /status/);
  shell(repo, "curl -si localhost:3000/api/courts", STATUS(200));
  assert.match(refused(repo, "step", ["driver", "done", "no", "--ran", "api/courts"]), /app\/api\/users\/route\.ts/);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "driver").state, null);
});

test("C12 the driver step on an API change closes on a call to the changed route below 500, and on a cmd: driver run", () => {
  const repo = feature("pr-c12", API());
  edited(repo, "app/api/users/route.ts", "export const GET = 2;\n");
  shell(repo, "curl -si -X POST localhost:3000/api/users/7 -d a=1", STATUS(201, "Created"));
  assert.match(cli(repo, "step", ["driver", "done", "created", "--ran", "api/users/7"]), /POST localhost:3000\/api\/users\/7 201/);
  assert.match(cli(repo, "report"), /POST localhost:3000\/api\/users\/7 201/);

  const driven = feature("pr-c12b", API({ driver: "cmd:npm run e2e" }));
  edited(driven, "app/api/users/route.ts", "export const GET = 2;\n");
  shell(driven, "npm run e2e", "all green\n");
  cli(driven, "step", ["driver", "done", "e2e green", "--ran", "npm run e2e"]);
  assert.equal(ledgerOf(driven).steps.find((s) => s.key === "driver").state, "DONE");
});

test("C13 an API file named only with generic words lets any route close the driver; 499 closes, 500 does not", () => {
  const files = API({ api: ["src/api/**"] });
  const ok = feature("pr-c13", files);
  edited(ok, "src/api/route.ts", "export const r = 2;\n");
  shell(ok, "curl -si localhost:3000/health", STATUS(499, "Client Closed"));
  cli(ok, "step", ["driver", "done", "499", "--ran", "localhost:3000/health"]);
  const bad = feature("pr-c13b", files);
  edited(bad, "src/api/route.ts", "export const r = 2;\n");
  shell(bad, "curl -si localhost:3000/health", STATUS(500, "Internal Server Error"));
  assert.match(refused(bad, "step", ["driver", "done", "500", "--ran", "localhost:3000/health"]), /500/);
});

const FIND_FILE = "the empty list renders a stray comma — src/a.ts:1 — the join runs on an empty array";
const FIND_NONE = "the badge label reads oddly on narrow screens";
function reviewed(name) {
  const repo = feature(name);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  write(repo, "src/a.ts", "export const a = 2;\n");
  cli(repo, "brief", ["reviewer"]);
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "R1", agent_type: "done-gate:reviewer" });
  writeFileSync(path.join(runDir(repo), "review-1.md"), `# Review 1\n\n## Act on\n- ${FIND_FILE}\n- ${FIND_NONE}\n## Consider\n- none\n`);
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  return repo;
}

test("C14 a wrong close on a command must name the finding's file or its basename; a finding with no file closes on any clean run", () => {
  const repo = reviewed("pr-c14");
  const plain = shell(repo, "node probe.mjs", "fine\n");
  assert.match(refused(repo, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", `events#${plain.seq}`]), /src\/a\.ts/);
  const named = shell(repo, "node probe.mjs a.ts", "fine\n");
  cli(repo, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", `events#${named.seq}`]);
  cli(repo, "huddle", ["resolve", "H1.2", "--wrong", "--evidence", `events#${plain.seq}`]);
  assert.ok(ledgerOf(repo).huddles.flatMap((h) => h.actOn).every((a) => a.wrong));
});

test("C15 a wrong close on a test run of the finding's file that ran no test is refused; a browser call still closes it and the report shows its page", () => {
  const repo = reviewed("pr-c15");
  const none = shell(repo, "node --test tests/a.test.ts", NODE_NONE);
  assert.match(refused(repo, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", `events#${none.seq}`]), /no test ran/);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "http://localhost:3000/venues" }, tool_response: tabReply("http://localhost:3000/venues") });
  cli(repo, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", `events#${lastEvent(repo, "browser").seq}`]);
  const red = shell(repo, "node --test tests/a.test.ts", NODE_RED, 1);
  cli(repo, "huddle", ["resolve", "H1.2", "--wrong", "--evidence", `events#${red.seq}`]);
  const brief = cli(repo, "report", ["--brief"]);
  assert.match(brief, /closed as wrong: "the empty list[^\n]*page http:\/\/localhost:3000\/venues/, brief);
  assert.match(brief, /closed as wrong: "the badge label[^\n]*3 tests, 2 passed, 1 failed/, brief);
});

test("C16 the tests step skips a test run that ran nothing, and a red run that ran nothing does not resolve a finding on its test file", () => {
  const repo = feature("pr-c16");
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  edited(repo, "tests/a.test.ts", "test('b', () => {});\n");
  shell(repo, "node --test tests/a.test.ts", NODE_NONE);
  cli(repo, "check");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "tests").state, null);
  shell(repo, "node --test tests/a.test.ts", NODE_RED, 1);
  cli(repo, "check");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "tests").state, "DONE");

  const r = reviewed("pr-c16b");
  shell(r, "node --test tests/a.test.ts", `Could not find tests/a.test.ts\n${NODE_NONE}`, 1);
  refused(r, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:1"]);
  shell(r, "node --test tests/a.test.ts", NODE_RED, 1);
  cli(r, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:1"]);
});

test("C17 the report shows the reading beside a step's run pointer", () => {
  const repo = bugfix("pr-c17");
  shell(repo, "node --test tests/a.test.ts", NODE_RED, 1);
  cli(repo, "step", ["repro", "done", "fails (src/a.ts:1)", "--ran", "node --test tests/a.test.ts"]);
  assert.match(cli(repo, "report"), /\[events#\d+\] \(3 tests, 2 passed, 1 failed\)/);
});

test("C21 a command past the 200 characters an event keeps still has its test file and url read", () => {
  const long = `cd ${"/very/long/folder".repeat(12)} && npx vitest run tests/a.test.ts`;
  const [e] = eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: long }, tool_response: { stdout: VITEST_GREEN } }, "/repo");
  assert.ok(e.cmd.length <= 200);
  assert.ok(e.named.includes("tests/a.test.ts"), JSON.stringify(e.named));
  const call = callOf(`FOO=${"x".repeat(220)} curl -si localhost:3000/api/users`, STATUS(200));
  assert.equal(call.url, "localhost:3000/api/users");

  const repo = feature("pr-c21");
  cli(repo, "case", ["add", "the badge renders", "--kind", "happy"]);
  shell(repo, `${"true; ".repeat(40)}npx vitest run tests/a.test.ts`, VITEST_GREEN);
  cli(repo, "case", ["close", "C1", "--ran", "true; true"]);
});

test("C22 the newest passing match closes: a later match that ran nothing or got a 500 does not hide an earlier good one", () => {
  const repo = bugfix("pr-c22");
  shell(repo, "node --test tests/a.test.ts", NODE_RED, 1);
  shell(repo, "node --test tests/a.test.ts", NODE_NONE);
  const out = cli(repo, "step", ["repro", "done", "fails (src/a.ts:1)", "--ran", "node --test tests/a.test.ts"]);
  assert.match(out, /3 tests, 2 passed, 1 failed/);

  const api = feature("pr-c22b", API());
  edited(api, "app/api/users/route.ts", "export const GET = 2;\n");
  shell(api, "curl -si localhost:3000/api/users", STATUS(200));
  const bad = shell(api, "curl -si localhost:3000/api/users", STATUS(503, "Service Unavailable"));
  assert.match(refused(api, "step", ["driver", "done", "no", "--evidence", `events#${bad.seq}`]), /503/);
  assert.match(cli(api, "step", ["driver", "done", "ok", "--ran", "localhost:3000/api/users"]), /GET localhost:3000\/api\/users 200/);
  assert.doesNotMatch(cli(api, "check"), /\bR4\b/);
});

test("C23 route words drop [id], (group) and _private segments; a changed helper under _lib lets any url close", () => {
  const files = API({ api: ["app/**"] });
  const id = feature("pr-c23", files);
  edited(id, "app/(shop)/api/bookings/[id]/route.ts", "export const GET = 2;\n");
  shell(id, "curl -si localhost:3000/api/courts/7", STATUS(200));
  assert.match(refused(id, "step", ["driver", "done", "no", "--ran", "api/courts/7"]), /bookings/);
  shell(id, "curl -si localhost:3000/api/booking/7", STATUS(200));
  cli(id, "step", ["driver", "done", "ok", "--ran", "api/booking/7"]);

  const helper = feature("pr-c23b", files);
  edited(helper, "app/api/_lib/db.ts", "export const db = 2;\n");
  shell(helper, "curl -si localhost:3000/api/anything", STATUS(200));
  cli(helper, "step", ["driver", "done", "ok", "--ran", "api/anything"]);
});

test("C24 a test file that fails to load counts as a test that ran, so a red-first repro closes on it", () => {
  assert.equal(testTotals("Test Suites: 1 failed, 1 total\nTests:       0 total\n").ran, true);
  assert.equal(testTotals(" Test Files  1 failed (1)\n      Tests  no tests\n").ran, true);
  const repo = bugfix("pr-c24");
  shell(repo, "npx jest tests/a.test.ts", "FAIL tests/a.test.ts\n  ● Test suite failed to run\n\nTest Suites: 1 failed, 1 total\nTests:       0 total\n", 1);
  cli(repo, "step", ["repro", "done", "fails (src/a.ts:1)", "--ran", "jest tests/a.test.ts"]);
});

test("C25 a line of numbers with no pytest ending reads quickly (no backtracking blow-up)", () => {
  const line = Array.from({ length: 16 }, (_, i) => `${11 + i} ${22 + i}`).join(" ");
  const started = performance.now();
  assert.equal(testTotals(`${line}\n`), null);
  const ms = performance.now() - started;
  assert.ok(ms < 50, `reading took ${ms} ms`);
});

test("C19 a 2 MB test output is read from its last 256 KB only, quickly", () => {
  const filler = "x".repeat(1023) + "\n";
  const output = `ℹ tests 99\nℹ pass 99\nℹ fail 0\n${filler.repeat(2048)}ℹ tests 3\nℹ pass 3\nℹ fail 0\n`;
  const started = performance.now();
  const [e] = eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "node --test" }, tool_response: { stdout: output } }, "/repo");
  const ms = performance.now() - started;
  assert.equal(e.tests.tests, 3, "the summary at the start lies outside the read");
  assert.ok(ms < 200, `reading took ${ms} ms`);
});

// From the re-trial: the lead ran the test red through a pipe, so the exit was the pipe's
const PIPED = "npx vitest run tests/a.test.ts 2>&1 | grep -E \"Tests \"";
const VITEST_RED = "      Tests  4 failed | 34 passed (38)\n";

test("P1 a piped red test run, read as failed, closes a finding on its test file", () => {
  const repo = reviewed("pr-p1");
  shell(repo, PIPED, VITEST_RED);
  assert.equal(lastEvent(repo).exit, null, "premise: the pipe hid the exit");
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts"]);
});

test("P2 a case --ran on a piped test run read as failed is refused", () => {
  const repo = feature("pr-p2");
  cli(repo, "case", ["add", "the badge renders", "--kind", "happy"]);
  shell(repo, PIPED, VITEST_RED);
  assert.match(refused(repo, "case", ["close", "C1", "--ran", "vitest run tests/a.test.ts"]), /4 failed/);
});
