import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// Per-run verify (0.16.0 review, items 3.2 to 3.4): a run drops or adds verify commands for
// itself, verify must run every case's test file, a lint command can count only new findings,
// and the report lists what verify excludes. One test per case of the run's case table.

const NODE = JSON.stringify(process.execPath);
const REFUSAL = /^done-gate: /m;
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", (({ current, lastClosed }) => current ?? lastClosed)(loadSession(stateDir(repo), "S1")));
const ledgerOf = (repo) => loadLedger(runDir(repo));
const verifyJson = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8"));

function run(repo, verb, args = []) {
  return spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.notEqual(r.status, 0, `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.match(r.stderr, REFUSAL);
  return r.stderr;
}
const ruleLines = (out, rule) => out.split("\n").filter((l) => new RegExp(`^\\d+\\. ${rule} — `).test(l)).join("\n");

// a verify command run through a stand-in script named like the tool (bin/pytest, bin/lint),
// so the gate reads the command as it would read the real one; it prints its name and passes
const ok = (name, ...words) => `sh bin/${name} ${words.join(" ")}`.trim();
const STAND_IN = 'echo "$(basename "$0") $*"\n';
const binsFor = (verify) => Object.fromEntries([...JSON.stringify(verify).matchAll(/sh bin\/([\w.-]+)/g)].map((m) => [`bin/${m[1]}`, STAND_IN]));

function opened(name, verify, files = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ verify }), ...binsFor(verify), ...files });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature"]);
  return repo;
}
const ranCmds = (repo) => verifyJson(repo).commands.filter((c) => !c.skipped).map((c) => c.cmd);

test("C1 reported-surface: gate verify --drop of a gate.json command skips it on the next verify, raises no R13, and For you names it", () => {
  const stale = ok("stale-suite", "tests/old_test.py");
  const repo = opened("rv-c1", [ok("lint"), stale]);
  cli(repo, "verify", ["--drop", stale]);
  cli(repo, "verify");
  assert.deepEqual(ranCmds(repo), [ok("lint")]);
  assert.equal(ruleLines(cli(repo, "check"), "R13"), "");
  assert.match(cli(repo, "report", ["--brief"]), /For you:[^\n]*stale-suite/);
  assert.match(cli(repo, "doctor"), /verify dropped by this run: [^\n]*stale-suite/);
});

test("C2 happy: gate verify --add of a dropped gate.json command runs it again", () => {
  const stale = ok("stale-suite");
  const repo = opened("rv-c2", [ok("lint"), stale]);
  cli(repo, "verify", ["--drop", stale]);
  cli(repo, "verify", ["--add", stale]);
  cli(repo, "verify");
  assert.deepEqual(ranCmds(repo), [ok("lint"), stale]);
  assert.deepEqual(ledgerOf(repo).verifyDropped ?? [], []);
});

test("C23 refused: a gate.json command restored with --add after a green verify is owed a run until verify runs it", () => {
  const stale = ok("stale-suite");
  const repo = opened("rv-c23", [ok("lint"), stale]);
  write(repo, "src/a.ts", "export const changed = 1;\n");
  cli(repo, "verify", ["--drop", stale]);
  cli(repo, "verify");
  cli(repo, "verify", ["--add", stale]);
  assert.match(ruleLines(cli(repo, "check"), "R3"), /stale-suite[^\n]*has not run|has not run[^\n]*stale-suite/);
  cli(repo, "verify");
  assert.equal(ruleLines(cli(repo, "check"), "R3"), "");
});

test("C3 refused: gate verify --drop of a command in neither gate.json nor the run's added list is refused", () => {
  const repo = opened("rv-c3", [ok("lint")]);
  refused(repo, "verify", ["--drop", "npm run nothing"]);
  assert.deepEqual(ledgerOf(repo).verifyDropped ?? [], []);
});

const caseOn = (repo, ptr) => {
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", ptr]);
};

test("C4 reported-surface: a closed case whose test file no verify test command runs raises R18 naming the case, the file and gate verify --add", () => {
  const repo = opened("rv-c4", [ok("pytest", "tests/test_other.py", "tests/test_more.py")], { "tests/test_new.py": "def test_x(): pass\n", "tests/test_other.py": "", "tests/test_more.py": "" });
  caseOn(repo, "tests/test_new.py:test_x");
  cli(repo, "verify");
  const r18 = ruleLines(cli(repo, "check"), "R18");
  assert.match(r18, /C1/, r18);
  assert.match(r18, /tests\/test_new\.py/, r18);
  assert.match(r18, /gate verify --add/, r18);
});

test("C5 happy: a case test run by a whole-suite command, or by one naming its folder, file or a glob holding it, raises no R3", () => {
  const files = { "tests/unit/test_new.py": "def test_x(): pass\n" };
  for (const [name, cmd] of [["suite", "npm test"], ["folder", ok("pytest", "tests/unit")], ["file", ok("pytest", "tests/unit/test_new.py")], ["glob", ok("pytest", '"tests/**/*.py"')]]) {
    const repo = opened(`rv-c5-${name}`, [cmd], files);
    caseOn(repo, "tests/unit/test_new.py:test_x");
    cli(repo, "verify");
    assert.equal(ruleLines(cli(repo, "check"), "R18"), "", `${name}: ${cmd}`);
  }
});

test("C6 refused: a case test excluded by a command's --ignore is not covered by that command", () => {
  const repo = opened("rv-c6", [ok("pytest", "--ignore=tests/unit")], { "tests/unit/test_new.py": "def test_x(): pass\n" });
  caseOn(repo, "tests/unit/test_new.py:test_x");
  cli(repo, "verify");
  assert.match(ruleLines(cli(repo, "check"), "R18"), /tests\/unit\/test_new\.py/);
});

test("C7 edge: a case closed with --na needs no coverage; a red or skipped command covers nothing", () => {
  const na = opened("rv-c7-na", [ok("pytest", "tests/test_other.py")], { "tests/test_other.py": "" });
  cli(na, "case", ["add", "it works", "--kind", "happy"]);
  cli(na, "case", ["close", "C1", "--na", "covered by an existing fixture"]);
  cli(na, "verify");
  assert.equal(ruleLines(cli(na, "check"), "R18"), "");

  const red = opened("rv-c7-red", [ok("lint"), ok("pytest", "tests/test_new.py")], { "tests/test_new.py": "def test_x(): pass\n", "bin/pytest": "exit 1\n" });
  caseOn(red, "tests/test_new.py:test_x");
  cli(red, "verify");
  assert.match(ruleLines(cli(red, "check"), "R18"), /C1[^\n]*tests\/test_new\.py|tests\/test_new\.py[^\n]*C1/);

  // a test command that runs only when the implementation changed is skipped on a tests-only change
  const skipped = opened("rv-c7-skipped", [ok("lint"), { cmd: ok("pytest", "tests/test_new.py"), when: "source" }], { "tests/test_new.py": "def test_x(): pass\n" });
  write(skipped, "tests/test_new.py", "def test_x(): assert True\n");
  caseOn(skipped, "tests/test_new.py:test_x");
  cli(skipped, "verify");
  assert.ok(verifyJson(skipped).commands[1].skipped, "premise: the test command was skipped");
  assert.match(ruleLines(cli(skipped, "check"), "R18"), /tests\/test_new\.py/);
});

// a lint command that reports the findings given as path:line (or path(line,col)) and fails
const LINT = 'process.stdout.write(process.argv.slice(1).join("\\n") + "\\n"); process.exitCode = 1';
const lint = (...findings) => ({ cmd: `${NODE} -e ${JSON.stringify(LINT)} ${findings.map((f) => JSON.stringify(f)).join(" ")}`, onlyNew: true });
const TWENTY = Array.from({ length: 20 }, (_, i) => `export const a${i} = ${i};`).join("\n") + "\n";
const withLine5Changed = (repo) => write(repo, "src/a.ts", TWENTY.replace("export const a4 = 4;", "export const a4 = 44;"));

test("C8 reported-surface: an onlyNew lint command failing only on lines this task did not change counts green and records the old findings it ignored", () => {
  const repo = opened("rv-c8", [lint("src/a.ts:1:1 no-var", "src/a.ts:12:3 eqeqeq", "src/other.ts:2:1 semi")], { "src/a.ts": TWENTY, "src/other.ts": "x\ny\n" });
  withLine5Changed(repo);
  assert.match(cli(repo, "doctor"), /verify: [^\n]*\(onlyNew\)/);
  assert.match(cli(repo, "verify"), /green/);
  const c = verifyJson(repo).commands[0];
  assert.equal(c.exit, 0);
  assert.equal(c.oldFindings, 3);
  assert.match(cli(repo, "report", ["--brief"]), /For you:[^\n]*3 old lint findings/);
});

test("C9 refused: an onlyNew lint command with a finding on a line this task changed stays red, through gate verify, check and report", () => {
  const repo = opened("rv-c9", [lint("src/a.ts:1:1 no-var", "src/a.ts:5:3 eqeqeq")], { "src/a.ts": TWENTY });
  withLine5Changed(repo);
  assert.match(cli(repo, "verify"), /1 of 1 red/);
  assert.notEqual(verifyJson(repo).commands[0].exit, 0);
  assert.match(ruleLines(cli(repo, "check"), "R3"), /red|failed|exit/i);
  assert.match(cli(repo, "report"), /✗/);
});

test("C10 edge: an onlyNew command whose output names no path:line finding stays red", () => {
  const repo = opened("rv-c10", [lint("Error: cannot find module eslint-plugin-x")], { "src/a.ts": TWENTY });
  withLine5Changed(repo);
  cli(repo, "verify");
  assert.notEqual(verifyJson(repo).commands[0].exit, 0);
});

test("C11 happy: path(line,col) findings (tsc) parse as well as path:line", () => {
  const repo = opened("rv-c11", [lint("src/a.ts(12,3): error TS2322: nope")], { "src/a.ts": TWENTY });
  withLine5Changed(repo);
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].exit, 0);
  assert.equal(verifyJson(repo).commands[0].oldFindings, 1);
});

test("C12 reported-surface: the report lists each command's exclusions, marks one new in this run or naming a changed file, and For you names it", () => {
  const known = ok("pytest", "--deselect", "tests/test_x.py::test_flaky");
  const repo = opened("rv-c12", [known], { "src/a.ts": TWENTY });
  withLine5Changed(repo);
  cli(repo, "verify", ["--add", ok("pytest", "-k", '"not test_slow"', "--ignore=src/a.ts")]);
  cli(repo, "verify");
  const report = cli(repo, "report");
  assert.match(report, /excluded from verify/i, report);
  assert.match(report, /--deselect tests\/test_x\.py::test_flaky/, report);
  assert.match(report, /-k "?not test_slow"?[^\n]*new in this run/, report);
  assert.match(report, /--ignore=src\/a\.ts[^\n]*(new in this run|changed file)/, report);
  assert.doesNotMatch(report, /test_flaky[^\n]*new in this run/, report);
  assert.match(cli(repo, "report", ["--brief"]), /For you:[^\n]*exclu/i);
});

test("C13 idempotent: a ledger from before this change (no verifyAtOpen, no verifyDropped) still verifies, checks and reports", () => {
  const repo = opened("rv-c13", [ok("lint")]);
  const ledger = ledgerOf(repo);
  delete ledger.verifyAtOpen;
  delete ledger.verifyDropped;
  saveLedger(runDir(repo), ledger);
  assert.match(cli(repo, "verify"), /all 1 green/);
  assert.equal(ruleLines(cli(repo, "check"), "R3"), "");
  assert.match(cli(repo, "report"), /✓/);
});

test("C14 happy: the R13 text points at gate verify --add and --drop", () => {
  const repo = opened("rv-c14", [ok("lint")]);
  write(repo, ".claude/gate.json", JSON.stringify({ verify: [ok("lint"), ok("more")] }));
  const r13 = ruleLines(cli(repo, "check"), "R13");
  assert.match(r13, /gate verify --add/, r13);
  assert.match(r13, /--drop/, r13);
});

test("C15 refused: with lint green and the only test command dropped, a closed case test raises R18", () => {
  const tests = ok("pytest");
  const repo = opened("rv-c15", [ok("lint"), tests], { "tests/test_new.py": "def test_x(): pass\n" });
  caseOn(repo, "tests/test_new.py:test_x");
  cli(repo, "verify", ["--drop", tests]);
  cli(repo, "verify");
  assert.match(ruleLines(cli(repo, "check"), "R18"), /tests\/test_new\.py/);
});

test("C16 edge: go test ./..., a pytest file::name id, a --flag=path, a cd into a package and a jest name filter are each read right", () => {
  const shapes = [
    ["go", ok("go", "test", "./..."), "pkg/orders/orders_test.go", { "pkg/orders/orders_test.go": "package orders\n" }],
    ["nodeid", ok("pytest", "tests/test_new.py::test_x"), "tests/test_new.py", { "tests/test_new.py": "def test_x(): pass\n" }],
    ["flag", ok("pytest", "--rootdir=tests", "--junitxml=tests/report.xml"), "tests/test_new.py", { "tests/test_new.py": "def test_x(): pass\n", "tests/report.xml": "<x/>\n" }],
    ["cd", `cd web && ${ok("vitest", "src/x.test.ts")}`, "web/src/x.test.ts", { "web/src/x.test.ts": "test('x', () => {});\n", "web/bin/vitest": STAND_IN }],
    ["filter", ok("jest", "renders"), "src/x.test.ts", { "src/x.test.ts": "test('renders', () => {});\n" }],
  ];
  for (const [name, cmd, file, files] of shapes) {
    const repo = opened(`rv-c16-${name}`, [cmd], files);
    caseOn(repo, `${file}:x`);
    cli(repo, "verify");
    assert.equal(ruleLines(cli(repo, "check"), "R18"), "", `${name}: ${cmd}`);
  }
});

test("C17 edge: a sibling repo's test command covers its own case tests; a main-repo whole-suite command does not cover the sibling's", () => {
  const other = makeRepo("rv-c17-front", { ".claude/gate.json": JSON.stringify({ verify: [ok("vitest")] }), ...binsFor([ok("vitest")]), "src/x.test.ts": "test('x', () => {});\n" });
  execFileSync("git", ["add", "-A"], { cwd: other });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: other });
  const repo = makeRepo("rv-c17", { ".claude/gate.json": JSON.stringify({ verify: [ok("pytest")] }), ...binsFor([ok("pytest")]) });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature", "--repo", "../rv-c17-front"]);
  caseOn(repo, "../rv-c17-front/src/x.test.ts:x");
  cli(repo, "verify");
  assert.equal(ruleLines(cli(repo, "check"), "R18"), "");

  const bare = makeRepo("rv-c17b-front", { ".claude/gate.json": JSON.stringify({ verify: [ok("lint")] }), ...binsFor([ok("lint")]), "src/x.test.ts": "test('x', () => {});\n" });
  execFileSync("git", ["add", "-A"], { cwd: bare });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: bare });
  const main = makeRepo("rv-c17b", { ".claude/gate.json": JSON.stringify({ verify: [ok("pytest")] }), ...binsFor([ok("pytest")]) });
  execFileSync("git", ["add", "-A"], { cwd: main });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: main });
  cli(main, "open", ["t", "feature", "--repo", "../rv-c17b-front"]);
  caseOn(main, "../rv-c17b-front/src/x.test.ts:x");
  cli(main, "verify");
  assert.match(ruleLines(cli(main, "check"), "R18"), /rv-c17b-front\/src\/x\.test\.ts/);
});

test("C18 happy: gate waive coverage clears R18; a case pointer whose file is gone or not a test file needs no coverage", () => {
  const repo = opened("rv-c18", [ok("lint")], { "tests/test_new.py": "def test_x(): pass\n" });
  caseOn(repo, "tests/test_new.py:test_x");
  cli(repo, "verify");
  assert.match(ruleLines(cli(repo, "check"), "R18"), /test_new/);
  assert.match(ruleLines(cli(repo, "check"), "R18"), /gate waive coverage/);
  cli(repo, "waive", ["coverage", "user: the suite runs in CI only"]);
  assert.equal(ruleLines(cli(repo, "check"), "R18"), "");

  const src = opened("rv-c18-src", [ok("lint")]);
  caseOn(src, "src/a.ts:a0");
  cli(src, "verify");
  assert.equal(ruleLines(cli(src, "check"), "R18"), "");
});

test("C19 refused: an onlyNew command whose finding names a path outside the repo, or that exits 2, stays red", () => {
  const trace = opened("rv-c19-trace", [lint("src/a.ts:1:1 no-var", "/usr/lib/node_modules/eslint/bin/cli.js:123")], { "src/a.ts": TWENTY });
  withLine5Changed(trace);
  cli(trace, "verify");
  assert.notEqual(verifyJson(trace).commands[0].exit, 0);

  const crash = opened("rv-c19-crash", [{ cmd: `${NODE} -e "console.log('src/a.ts:1:1 no-var'); process.exit(2)"`, onlyNew: true }], { "src/a.ts": TWENTY });
  withLine5Changed(crash);
  cli(crash, "verify");
  assert.equal(verifyJson(crash).commands[0].exit, 2);
});

test("C20 refused: an onlyNew command whose output exceeds the cap stays red", () => {
  const big = { cmd: `${NODE} -e "for (let i = 0; i < 60000; i++) console.log('src/a.ts:1:1 no-var ' + 'x'.repeat(40)); process.exitCode = 1"`, onlyNew: true };
  const repo = opened("rv-c20", [big], { "src/a.ts": TWENTY });
  withLine5Changed(repo);
  cli(repo, "verify");
  assert.notEqual(verifyJson(repo).commands[0].exit, 0);
});

test("C21 edge: an onlyNew finding on the line next to one this task deleted is new", () => {
  const repo = opened("rv-c21", [lint("src/a.ts:5:1 no-unused-vars")], { "src/a.ts": TWENTY });
  write(repo, "src/a.ts", TWENTY.replace("export const a4 = 4;\n", ""));
  cli(repo, "verify");
  assert.notEqual(verifyJson(repo).commands[0].exit, 0);
});

test("C22 refused: a --deselect of the case's own file::name removes that command's coverage", () => {
  const repo = opened("rv-c22", [ok("pytest", "--deselect", "tests/test_new.py::test_x")], { "tests/test_new.py": "def test_x(): pass\n" });
  caseOn(repo, "tests/test_new.py:test_x");
  cli(repo, "verify");
  assert.match(ruleLines(cli(repo, "check"), "R18"), /tests\/test_new\.py/);
});

test("C24 refused: npm test with a test/ folder, or jest with --config, covers a case test elsewhere", () => {
  const npm = opened("rv-c24-npm", ["npm test"], { "test/fixtures.txt": "x\n", "src/x.test.ts": "test('x', () => {});\n" });
  caseOn(npm, "src/x.test.ts:x");
  cli(npm, "verify");
  assert.equal(ruleLines(cli(npm, "check"), "R18"), "");

  const jest = opened("rv-c24-jest", [ok("jest", "--config", "jest.config.js")], { "jest.config.js": "module.exports = {};\n", "src/x.test.ts": "test('x', () => {});\n" });
  caseOn(jest, "src/x.test.ts:x");
  cli(jest, "verify");
  assert.equal(ruleLines(cli(jest, "check"), "R18"), "");
});

test("C25 refused: onlyNew on a command that runs tests never turns its failure green", () => {
  const repo = opened("rv-c25", [{ cmd: ok("pytest"), onlyNew: true }], { "src/a.ts": TWENTY, "tests/test_b.py": "def test_b(): assert False\n", "bin/pytest": "echo 'tests/test_b.py:1: AssertionError'\nexit 1\n" });
  withLine5Changed(repo);
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].exit, 1);
});

test("C26 refused: an onlyNew output with a place that is not a source file of the repo stays red", () => {
  for (const [name, place] of [["spaces", "my dir/a.py:5:1 x"], ["modules", "node_modules/x/cli.js:12"], ["time", "at 12:30:01 something broke"]]) {
    const repo = opened(`rv-c26-${name}`, [lint("src/a.ts:1:1 no-var", place)], { "src/a.ts": TWENTY, "node_modules/x/cli.js": "x\n" });
    withLine5Changed(repo);
    cli(repo, "verify");
    assert.notEqual(verifyJson(repo).commands[0].exit, 0, name);
  }
});

test("C27 idempotent: drop, restore, drop of a gate.json command leaves nothing owed once verify runs", () => {
  const stale = ok("stale-suite");
  const repo = opened("rv-c27", [ok("lint"), stale]);
  write(repo, "src/a.ts", "export const changed = 1;\n");
  cli(repo, "verify", ["--drop", stale]);
  cli(repo, "verify", ["--add", stale]);
  cli(repo, "verify", ["--drop", stale]);
  cli(repo, "verify");
  assert.equal(ruleLines(cli(repo, "check"), "R3"), "");
});

test("C28 edge: a runner after a package tool or launcher is a test run (yarn jest, pnpm exec vitest); a runner's name as an argument is not", async () => {
  const { runsTests } = await import("../scripts/lib/verify.mjs");
  for (const cmd of ["yarn jest", "pnpm vitest run", "pnpm exec vitest", "npm exec jest", "bun x vitest", "python -m pytest", "./node_modules/.bin/jest", "NODE_OPTIONS=--experimental-vm-modules jest", "CI=1 vitest run", "cross-env NODE_ENV=test jest", "env CI=1 pytest", "timeout 600 pytest", "npx --yes jest", "pnpm --filter web vitest", "yarn workspace web jest", "uv run --frozen pytest"]) assert.equal(runsTests(cmd), true, cmd);
  for (const cmd of ["tsc -p packages/jest", "tsc -p jest", "eslint tests", "npm run lint"]) assert.equal(runsTests(cmd), false, cmd);
});

test("C29 refused: an onlyNew command whose output places a finding in a test file stays red, whatever script runs it", () => {
  const repo = opened("rv-c29", [lint("src/a.ts:1:1 no-var", "at Object.<anonymous> (src/b.test.ts:3:5)")], { "src/a.ts": TWENTY, "src/b.test.ts": "test('b', () => {\n  expect(1).toBe(1);\n  expect(1).toBe(2);\n});\n" });
  withLine5Changed(repo);
  cli(repo, "verify");
  assert.notEqual(verifyJson(repo).commands[0].exit, 0);
});
