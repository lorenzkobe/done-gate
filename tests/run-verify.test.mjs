import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here, waiveArgs, naArgs, userSays } from "./helpers.mjs";
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
  cli(na, "case", naArgs(na, "C1", "covered by an existing fixture"));
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
  userSays(repo, "drop the test command");
  cli(repo, "verify", ["--drop", tests, "--user-ok", "drop the test command"]);
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
  cli(repo, "waive", waiveArgs(repo, "coverage", "user: the suite runs in CI only"));
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

// Batch 3.4: the same tree is not tested twice, code moved during a run records nothing green, and
// verify.json keeps a short history.
const COUNT = (name) => `sh -c 'echo x >> ../${name}.count'`;
const runsOf = (repo, name) => {
  const file = path.join(path.dirname(repo), `${name}.count`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
};
const counted = (name, extra = {}, files = {}) => {
  rmSync(path.join(here, ".tmp", `${name}.count`), { force: true });
  return opened(name, [{ cmd: COUNT(name), ...extra }], files);
};

test("3.4 C1 gate verify twice on the same tree runs each command once, and the second closes the step", () => {
  const repo = counted("rv-34c1");
  cli(repo, "verify");
  assert.equal(runsOf(repo, "rv-34c1"), 1);
  const out = cli(repo, "verify");
  assert.equal(runsOf(repo, "rv-34c1"), 1);
  assert.match(out, /skipped: already green on this exact tree/);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "verify").state, "DONE");
  const [row] = verifyJson(repo).commands;
  assert.equal(row.covers, true);
  assert.ok(verifyJson(repo).greenTree[row.cmd]);
});

test("3.4 C2 a doc edit re-runs, a red command re-runs, an added command runs", () => {
  const doc = counted("rv-34c2");
  cli(doc, "verify");
  write(doc, "docs/notes.md", "# changed\n");
  cli(doc, "verify");
  assert.equal(runsOf(doc, "rv-34c2"), 2);

  const redName = "rv-34c2r";
  rmSync(path.join(here, ".tmp", `${redName}.count`), { force: true });
  const red = opened(redName, [`sh -c 'echo x >> ../${redName}.count; exit 1'`]);
  cli(red, "verify");
  cli(red, "verify");
  assert.equal(runsOf(red, redName), 2);

  const added = counted("rv-34c2a");
  cli(added, "verify");
  cli(added, "verify", ["--add", "true"]);
  cli(added, "verify");
  assert.equal(runsOf(added, "rv-34c2a"), 1);
  assert.deepEqual(ranCmds(added), ["true"]);
});

test("3.4 C2 changed related files re-run, as the resolved command differs", () => {
  const repo = opened("rv-34c2f", [{ related: true }], { "tests/a.test.ts": "test('a', () => {});\n", ".claude/gate.json": JSON.stringify({ testFiles: "sh -c 'true' {files}", verify: [{ related: true }] }) });
  write(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].skipped, undefined);
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].covers, true);
  assert.deepEqual(verifyJson(repo).commands[0].files, ["tests/a.test.ts"]);
  write(repo, "tests/b.test.ts", "test('b', () => {});\n");
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].skipped, undefined);
  assert.deepEqual(verifyJson(repo).commands[0].files, ["tests/a.test.ts", "tests/b.test.ts"]);
});

test("3.4 C3 --force runs everything, the final command too; external never skips", () => {
  const name = "rv-34c3";
  rmSync(path.join(here, ".tmp", `${name}.count`), { force: true });
  const repo = opened(name, [COUNT(name), { cmd: `sh -c 'echo f >> ../${name}.final.count'`, when: "final" }]);
  rmSync(path.join(path.dirname(repo), `${name}.final.count`), { force: true });
  cli(repo, "verify");
  cli(repo, "verify", ["--force"]);
  assert.equal(runsOf(repo, name), 2);
  assert.equal(runsOf(repo, `${name}.final`), 1, "--force runs the final command too");

  const ext = counted("rv-34c3e", { external: true });
  cli(ext, "verify");
  cli(ext, "verify");
  assert.equal(runsOf(ext, "rv-34c3e"), 2);
  const schema = JSON.parse(readFileSync(new URL("../gate.schema.json", import.meta.url), "utf8"));
  assert.ok(JSON.stringify(schema.properties.verify).includes('"external"'));
});

test("3.4 C4 a skip keeps R18 clean and the packet calls verify fresh", () => {
  const verify = [{ cmd: ok("pytest", "tests"), when: "always" }];
  const repo = opened("rv-34c4", verify, { "tests/a.test.py": "def test_a(): pass\n" });
  cli(repo, "note", ["task", "t"]);
  cli(repo, "case", ["add", "a case", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.py:test_a"]);
  cli(repo, "verify");
  assert.equal(ruleLines(cli(repo, "check"), "R18"), "");
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].covers, true);
  assert.equal(ruleLines(cli(repo, "check"), "R18"), "");
  const packet = /^packet: (.+)$/m.exec(cli(repo, "brief", ["reviewer"]))[1];
  assert.match(readFileSync(packet, "utf8"), /verify\.json is fresh/);
});

test("3.4 C6 a command that edits a source file records nothing green, leaves the step open and names it; the next clean run goes green", () => {
  const flag = "rv-34c6.flag";
  rmSync(path.join(here, ".tmp", flag), { force: true });
  const repo = opened("rv-34c6", [`sh -c 'test -e ../${flag} || { touch ../${flag}; echo "export const moved = 1;" >> src/a.ts; }'`]);
  const out = cli(repo, "verify");
  assert.match(out, /src\/a\.ts/);
  assert.doesNotMatch(out, /all 1 green/);
  const record = verifyJson(repo);
  assert.deepEqual(record.greenAt, {});
  assert.deepEqual(record.greenTree ?? {}, {});
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "verify").state, null);
  assert.match(cli(repo, "verify"), /all 1 green/);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "verify").state, "DONE");
  assert.equal(Object.keys(verifyJson(repo).greenAt).length, 1);
});

test("3.4 C7 a docs change during the run still records green", () => {
  const repo = opened("rv-34c7", ["sh -c 'echo more >> docs/notes.md'"]);
  assert.match(cli(repo, "verify"), /all 1 green/);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "verify").state, "DONE");
  assert.equal(Object.keys(verifyJson(repo).greenAt).length, 1);
});

test("3.4 C8 history grows, survives a skip, stops at 20; an old verify.json with none still reads", () => {
  const repo = counted("rv-34c8");
  cli(repo, "verify");
  cli(repo, "verify");
  const [first, second] = verifyJson(repo).history;
  assert.equal(first.ran.length, 1);
  assert.equal(first.skipped, 0);
  assert.deepEqual(second.ran, []);
  assert.equal(second.skipped, 1);
  assert.equal(second.sourceHash, first.sourceHash);
  assert.equal(second.treeHash, first.treeHash);
  assert.equal(typeof first.ms, "number");
  assert.ok(first.at);

  const file = path.join(runDir(repo), "verify.json");
  const old = verifyJson(repo);
  old.history = Array.from({ length: 20 }, (_, i) => ({ at: "t", sourceHash: `s${i}`, treeHash: `t${i}`, ran: ["c"], skipped: 0, ms: 1 }));
  writeFileSync(file, JSON.stringify(old));
  cli(repo, "verify");
  const history = verifyJson(repo).history;
  assert.equal(history.length, 20);
  assert.equal(history[0].sourceHash, "s1", "the oldest fell off");

  const { history: _gone, ...none } = verifyJson(repo);
  writeFileSync(file, JSON.stringify(none));
  cli(repo, "verify");
  assert.equal(verifyJson(repo).history.length, 1);
  assert.equal(ruleLines(cli(repo, "check"), "R3"), "");
});

test("3.4 C10 a skip of a related entry keeps its case tests in R18's list", () => {
  const repo = opened("rv-34c10", [{ related: true }], { "tests/a.test.ts": "test('a', () => {});\n", ".claude/gate.json": JSON.stringify({ testFiles: "sh -c 'true' {files}", verify: [{ related: true }] }) });
  cli(repo, "note", ["task", "t"]);
  cli(repo, "case", ["add", "a case", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:a"]);
  write(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(repo, "verify");
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].covers, true);
  assert.equal(ruleLines(cli(repo, "check"), "R18"), "");
});

test("3.4 C11 a when-source test command on the same tree is a fresh skip; one skipped because only tests changed stays not fresh", () => {
  const verify = [{ cmd: ok("pytest", "tests"), when: "source" }];
  const repo = opened("rv-34c11", verify, { "tests/a.test.py": "def test_a(): pass\n" });
  write(repo, "src/a.ts", "export const a = 2;\n");
  cli(repo, "note", ["task", "t"]);
  cli(repo, "case", ["add", "a case", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.py:test_a"]);
  cli(repo, "verify");
  cli(repo, "verify");
  const [row] = verifyJson(repo).commands;
  assert.equal(row.covers, true);
  assert.equal(ruleLines(cli(repo, "check"), "R18"), "");
  assert.match(readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", ["reviewer"]))[1], "utf8"), /verify\.json is fresh/);

  write(repo, "tests/a.test.py", "def test_a2(): pass\n");
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].covers, undefined);
  assert.match(readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", ["reviewer"]))[1], "utf8"), /not fresh/);
});

test("3.4 C12 a skip of an onlyNew entry keeps the old findings it ignored, in the record and the report", () => {
  const lint = "sh -c 'echo src/a.ts:1: old finding; exit 1'";
  const repo = opened("rv-34c12", [{ cmd: lint, onlyNew: true }]);
  write(repo, "src/a.ts", Array.from({ length: 20 }, (_, i) => `export const a${i} = ${i};`).join("\n") + "\nexport const more = 1;\n");
  cli(repo, "verify");
  assert.equal(verifyJson(repo).commands[0].oldFindings, 1);
  assert.match(cli(repo, "verify"), /1 old finding/);
  const [row] = verifyJson(repo).commands;
  assert.equal(row.covers, true);
  assert.equal(row.oldFindings, 1);
  assert.equal(row.rawExit, 1);
  assert.match(cli(repo, "report"), /old lint finding/);
});

test("3.4 C13 verify then verify --final on one source hash is no re-run", () => {
  const repo = opened("rv-34c13", ["true", { cmd: "sh -c true", when: "final" }]);
  cli(repo, "verify");
  cli(repo, "verify", ["--final"]);
  const history = verifyJson(repo).history;
  assert.equal(history[0].sourceHash, history[1].sourceHash);
  assert.equal(history[0].ran.some((c) => history[1].ran.includes(c)), false);
});

// Batch 3.5: exit 0 is not green when the runner's own summary says no test ran.
const runner = (name, ...lines) => ({ [`bin/${name}`]: lines.map((l) => `printf '%b\\n' ${JSON.stringify(l)}`).join("\n") + "\n" });
const row = (repo) => verifyJson(repo).commands[0];
const judged = (name, tool, words, ...lines) => {
  const repo = opened(name, [`sh bin/${[tool, ...words].join(" ")}`], runner(tool, ...lines));
  const out = cli(repo, "verify");
  return { repo, out, row: row(repo) };
};
const isNoTests = ({ row: r, out }, label) => {
  assert.equal(r.exit, 1, label);
  assert.equal(r.rawExit, 0, label);
  assert.equal(r.noTests, true, label);
  assert.match(out, /no tests ran/, label);
  assert.doesNotMatch(out, /all 1 green/, label);
};
const isGreen = ({ row: r }, label) => {
  assert.equal(r.exit, 0, label);
  assert.equal(r.noTests, undefined, label);
};

test("3.5 C1 a zero summary from each runner with exit 0 is red, and stays out of the step", () => {
  isNoTests(judged("rv-35j1", "jest", [], "No tests found, exiting with code 0"), "jest none");
  isNoTests(judged("rv-35j2", "jest", [], "Tests:       0 total"), "jest zero");
  isNoTests(judged("rv-35v", "vitest", [], "No test files found, exiting with code 0"), "vitest");
  isNoTests(judged("rv-35p1", "pytest", [], "collected 0 items", "", "==== no tests ran in 0.01s ===="), "pytest");
  isNoTests(judged("rv-35n", "node", ["--test"], "ℹ tests 0", "ℹ pass 0"), "node");
  isNoTests(judged("rv-35g1", "go", ["test", "./..."], "?   \texample.com/a\t[no test files]"), "go none");
  isNoTests(judged("rv-35g2", "go", ["test", "./..."], "testing: warning: no tests to run", "PASS", "ok  \texample.com/b\t0.1s [no tests to run]"), "go no tests to run");
  const cargo = judged("rv-35c", "cargo", ["test"], "running 0 tests", "", "test result: ok. 0 passed; 0 failed");
  isNoTests(cargo, "cargo");
  assert.equal(ledgerOf(cargo.repo).steps.find((s) => s.key === "verify").state, null);
  assert.deepEqual(verifyJson(cargo.repo).greenAt, {});
  assert.match(cli(cargo.repo, "report"), /no tests ran/);
});

test("3.5 C2 cargo's 0 beside real tests stays green, even far above the tail; go's no test files beside an ok line too", () => {
  isGreen(judged("rv-35c2", "cargo", ["test"], "running 3 tests", "test result: ok. 3 passed; 0 failed", "running 0 tests", "test result: ok. 0 passed; 0 failed"), "cargo beside");
  const far = Array.from({ length: 2000 }, (_, i) => `   Compiling crate${i} with a long enough line to fill the tail buffer quickly`);
  isGreen(judged("rv-35c3", "cargo", ["test"], "running 3 tests", "test result: ok. 3 passed; 0 failed", ...far, "running 0 tests", "test result: ok. 0 passed; 0 failed"), "cargo far above");
  isGreen(judged("rv-35g3", "go", ["test", "./..."], "?   \texample.com/a\t[no test files]", "ok  \texample.com/b\t0.1s"), "go beside");
});

test("3.5 C3 a real summary stays green, unknown output stays green, and past 2 MB nothing is judged", () => {
  isGreen(judged("rv-35r1", "jest", [], "Tests:       3 passed, 3 total"), "jest");
  isGreen(judged("rv-35r2", "vitest", [], " Test Files  1 passed (1)", "      Tests  3 passed (3)"), "vitest");
  isGreen(judged("rv-35r3", "pytest", [], "collected 3 items", "==== 3 passed in 0.02s ===="), "pytest");
  isGreen(judged("rv-35r4", "node", ["--test"], "ℹ tests 3", "ℹ pass 3"), "node");
  isGreen(judged("rv-35r5", "jest", [], "all good, nothing to report"), "unknown");
  const big = opened("rv-35r6", ["sh bin/jest"], { "bin/jest": `yes 0123456789012345678901234567890123456789 | head -c 2400000\nprintf 'Tests:       0 total\\n'\n` });
  cli(big, "verify");
  assert.equal(row(big).exit, 0);
});

test("3.5 C4 lint is untouched: no test runner printing a zero stays green", () => {
  isGreen(judged("rv-35l", "eslint", [], "Tests:       0 total", "running 0 tests"), "lint");
});

test("3.5 C6 a report key: a fresh file with tests is green; stale, empty, missing or zero-test is red", () => {
  const entry = (report) => [{ cmd: "sh bin/wrapper", report }];
  const writes = (content) => ({ ".gitignore": "node_modules/\nignored.txt\nout.xml\n", "bin/wrapper": `printf '%s' '${content}' > out.xml\n` });
  const green = opened("rv-35f1", entry("out.xml"), writes('<testsuites tests="3"></testsuites>'));
  cli(green, "verify");
  isGreen({ row: row(green) }, "junit");
  const json = opened("rv-35f2", entry("out.xml"), writes('{"numTotalTests": 4}'));
  cli(json, "verify");
  isGreen({ row: row(json) }, "jest json");

  for (const [name, bin] of [["rv-35f3", writes('<testsuites tests="0"></testsuites>')], ["rv-35f4", writes("")], ["rv-35f5", { ...writes(""), "bin/wrapper": "true\n" }]]) {
    const repo = opened(name, entry("out.xml"), bin);
    assert.match(cli(repo, "verify"), /no tests ran/, name);
    assert.equal(row(repo).noTests, true, name);
  }
  const stale = opened("rv-35f6", entry("out.xml"), { ...writes(""), "bin/wrapper": "true\n", "out.xml": '<testsuites tests="3"></testsuites>' });
  const old = new Date(Date.now() - 3600000);
  utimesSync(path.join(stale, "out.xml"), old, old);
  assert.match(cli(stale, "verify"), /no tests ran/);
  const schema = JSON.parse(readFileSync(new URL("../gate.schema.json", import.meta.url), "utf8"));
  assert.ok(JSON.stringify(schema.properties.verify).includes('"report"'));
});

const relatedRepo = (name, extra = {}) => opened(name, [{ related: true }], {
  "tests/a.test.ts": "test('a', () => {});\n",
  "src/b.ts": "export const b = 1;\n",
  "bin/related": 'echo "$@" > ../related.seen\n',
  ".claude/gate.json": JSON.stringify({ testFiles: "sh bin/related tests-only {files}", testRelated: "sh bin/related {files}", verify: [{ related: true }], ...extra }),
});
const seen = (repo) => readFileSync(path.join(path.dirname(repo), "related.seen"), "utf8").trim();

test("3.5 C7 testRelated runs in place of the guess with changed source plus related test files; files stay the test files and R18 is clean", () => {
  const repo = relatedRepo("rv-35t1");
  cli(repo, "note", ["task", "t"]);
  cli(repo, "case", ["add", "a case", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:a"]);
  write(repo, "src/b.ts", "export const b = 2;\n");
  write(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(repo, "verify");
  assert.equal(seen(repo), "src/b.ts tests/a.test.ts");
  assert.deepEqual(row(repo).files, ["tests/a.test.ts"]);
  assert.equal(ruleLines(cli(repo, "check"), "R18"), "");
});

test("3.5 C8 testRelated with no related test files still runs on changed source; its zero stays green; nothing changed skips", () => {
  const quiet = opened("rv-35t2", [{ related: true }], {
    "src/b.ts": "export const b = 1;\n",
    "bin/related": "printf 'No test files found, exiting with code 0\\n'\n",
    ".claude/gate.json": JSON.stringify({ testFiles: "sh bin/related {files}", testRelated: "sh bin/related {files}", verify: [{ related: true }] }),
  });
  write(quiet, "src/b.ts", "export const b = 2;\n");
  cli(quiet, "verify");
  assert.equal(row(quiet).skipped, undefined);
  assert.deepEqual(row(quiet).files, []);
  isGreen({ row: row(quiet) }, "exempt");

  const nothing = relatedRepo("rv-35t3");
  cli(nothing, "verify");
  assert.equal(row(nothing).skipped, "no related test files");
});

test("3.5 C9 with no testRelated the related entry uses testFiles, and a zero summary there is red", () => {
  const repo = opened("rv-35t4", [{ related: true }], {
    "tests/a.test.ts": "test('a', () => {});\n",
    "bin/jest": "printf 'No tests found, exiting with code 0\\n'\n",
    ".claude/gate.json": JSON.stringify({ testFiles: "sh bin/jest {files}", verify: [{ related: true }] }),
  });
  write(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(repo, "verify");
  assert.equal(row(repo).noTests, true);
});

test("3.5 C10 testRelated given test files that prints a zero is red; only an empty list of test files is exempt", () => {
  const repo = opened("rv-35t5", [{ related: true }], {
    "tests/a.test.ts": "test('a', () => {});\n",
    "bin/jest": "printf 'No tests found, exiting with code 0\\n'\n",
    ".claude/gate.json": JSON.stringify({ testFiles: "sh bin/jest {files}", testRelated: "sh bin/jest {files}", verify: [{ related: true }] }),
  });
  write(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(repo, "verify");
  assert.equal(row(repo).noTests, true);
});

test("3.5 C11 a report that would count as source is refused before anything runs; an ignored one closes the step on two runs", () => {
  const name = "rv-35f7";
  rmSync(path.join(here, ".tmp", `${name}.count`), { force: true });
  const unignored = opened(name, [{ cmd: COUNT(name), report: "out.xml" }]);
  assert.match(refused(unignored, "verify"), /out\.xml[^\n]*git-ignored/);
  assert.equal(runsOf(unignored, name), 0);

  const ignored = opened("rv-35f8", [{ cmd: "sh bin/wrapper", report: "out.xml" }], { ".gitignore": "node_modules/\nignored.txt\nout.xml\n", "bin/wrapper": "date +%N | xargs -I{} printf '<testsuites tests=\"3\" id=\"{}\"></testsuites>' > out.xml\n" });
  cli(ignored, "verify");
  cli(ignored, "verify", ["--force"]);
  assert.equal(ledgerOf(ignored).steps.find((s) => s.key === "verify").state, "DONE");
  assert.equal(ruleLines(cli(ignored, "check"), "R3"), "");
});

test("3.5 C12 a zero beside a line counting tests that ran stays green", () => {
  isGreen(judged("rv-35m", "vitest", [], "No test files found, exiting with code 0", "", "  5 passing (12ms)"), "mocha beside vitest");
  isGreen(judged("rv-35w", "jest", [], "Tests:       0 total", "12 passed"), "a package with tests");
});

test("3.5 C13 testRelated gets no deleted file and no other repo's path; a change that only deleted source skips", () => {
  const repo = relatedRepo("rv-35t6");
  rmSync(path.join(repo, "src/b.ts"));
  cli(repo, "verify");
  assert.equal(row(repo).skipped, "no related test files");

  const both = relatedRepo("rv-35t7");
  rmSync(path.join(both, "src/b.ts"));
  write(both, "src/c.ts", "export const c = 1;\n");
  cli(both, "verify");
  assert.equal(seen(both), "src/c.ts");
});

test("3.5 C14 a wrapper testFiles template is judged by the resolved command", () => {
  const repo = opened("rv-35t8", [{ related: true }], {
    "tests/a.test.ts": "test('a', () => {});\n",
    "scripts/run.sh": "printf 'ℹ tests 0\\n'\n",
    ".claude/gate.json": JSON.stringify({ testFiles: "sh scripts/run.sh --db test {files}", verify: [{ related: true }] }),
  });
  write(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(repo, "verify");
  assert.equal(row(repo).noTests, true);
});

test("3.5 C15 vitest's own Tests no tests summary counts as zero", () => {
  isNoTests(judged("rv-35v2", "vitest", [], " Test Files  no tests", "      Tests  no tests"), "vitest no tests");
});

test("3.5 C16 a report from the previous verify is stale; a directory and tests= only in a testcase are red; several suites read", () => {
  const ignore = ".gitignore";
  const base = { [ignore]: "node_modules/\nignored.txt\nout.xml\n" };
  const previous = opened("rv-35f9", [{ cmd: "sh bin/wrapper", report: "out.xml" }], { ...base, "bin/wrapper": `test -e ../rv-35f9.flag || { touch ../rv-35f9.flag; printf '<testsuites tests="3"></testsuites>' > out.xml; }\n` });
  rmSync(path.join(path.dirname(previous), "rv-35f9.flag"), { force: true });
  cli(previous, "verify");
  assert.equal(row(previous).exit, 0);
  const old = new Date(Date.now() - 5000);
  utimesSync(path.join(previous, "out.xml"), old, old);
  cli(previous, "verify", ["--force"]);
  assert.match(row(previous).noTestsWhy, /not written by this run/);

  const dir = opened("rv-35f10", [{ cmd: "mkdir -p out.xml", report: "out.xml" }], base);
  cli(dir, "verify");
  assert.equal(row(dir).noTests, true);

  const inCase = opened("rv-35f11", [{ cmd: "sh bin/wrapper", report: "out.xml" }], { ...base, "bin/wrapper": `printf '<testsuites><testcase tests="3"/></testsuites>' > out.xml\n` });
  cli(inCase, "verify");
  assert.equal(row(inCase).noTests, true);

  const suites = opened("rv-35f12", [{ cmd: "sh bin/wrapper", report: "out.xml" }], { ...base, "bin/wrapper": `printf '<testsuite tests="0"/><testsuite tests="2"/>' > out.xml\n` });
  cli(suites, "verify");
  assert.equal(row(suites).exit, 0);
});

test("3.5 C17 testRelated with no testFiles stays refused, and the packet names what the related entry runs", () => {
  const none = opened("rv-35t9", [{ related: true }], { ".claude/gate.json": JSON.stringify({ testRelated: "sh bin/related {files}", verify: [{ related: true }] }) });
  assert.match(refused(none, "verify"), /needs testFiles/);
  const repo = relatedRepo("rv-35t10");
  const packet = /^packet: (.+)$/m.exec(cli(repo, "brief", ["reviewer"]))[1];
  assert.match(readFileSync(packet, "utf8"), /testRelated on this task's changed source/);
});

test("3.5 C18 R3, the verify output and the report name why a command with exit 0 went red", () => {
  const repo = opened("rv-35why", ["sh bin/jest"], runner("jest", "No tests found, exiting with code 0"));
  write(repo, "src/a.ts", "export const a = 'changed';\n");
  assert.match(cli(repo, "verify"), /no tests ran: its summary shows no test/);
  assert.match(ruleLines(cli(repo, "check"), "R3"), /ran no tests \(its summary shows no test\)/);
  assert.match(cli(repo, "report"), /no tests ran: its summary shows no test/);
});

// F1: a red test command runs once more on the run's base commit, in a temporary worktree; tests
// failing there too are old. bin/vitest stands in for a runner: it fails the names in fails.txt,
// passes pass.txt tests (3 by default), prints node's spec summary and logs each run's folder.
const fakeRunner = (log) => ({
  "bin/vitest": [
    `echo "$PWD $([ -e node_modules/x/index.js ] && echo linked)" >> ${JSON.stringify(log)}`,
    "[ -e slow.txt ] && sleep 3",
    "[ -e drop-link.txt ] && [ -L node_modules ] && rm node_modules",
    "[ -e unreadable.txt ] && { echo boom; exit 1; }",
    "P=$(cat pass.txt 2>/dev/null || echo 3)",
    "L=$(mktemp); cat fails.txt > $L; [ -e needs-env ] && [ ! -e .env ] && echo 'env one' >> $L",
    "F=$(cat failcount.txt 2>/dev/null || grep -c . $L)",
    'printf "\\342\\204\\271 tests %s\\n\\342\\204\\271 pass %s\\n\\342\\204\\271 fail %s\\n" $((P+F)) $P $F',
    '[ "$F" -gt 0 ] || exit 0',
    'printf "\\n\\342\\234\\226 failing tests:\\n"',
    'while read -r n; do printf "\\ntest at %s/tests/a.test.mjs:3:1\\n\\342\\234\\226 %s (0.3ms)\\n" "$PWD" "$n"; done < $L',
    "exit 1",
  ].join("\n") + "\n",
});
function baseRepo(name, { base = "", now = base, extra = {}, cmd = "sh bin/vitest" } = {}) {
  const log = path.join(here, ".tmp", `${name}.runs`);
  rmSync(log, { force: true });
  const repo = opened(name, [cmd], { ...fakeRunner(log), "fails.txt": base, ...extra });
  write(repo, "fails.txt", now);
  write(repo, "src/a.ts", "export const a = 'changed';\n");
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { repo, runs, baseRuns: () => runs().filter((l) => !l.startsWith(`${repo} `) && l !== repo) };
}

test("F1 C1 happy: a test command red only on tests also failing on the base commit counts green, with the old failures named in verify.json, verify, the report and For you", () => {
  const { repo, baseRuns } = baseRepo("rv-f1c1", { base: "old one\nold two\n" });
  const out = cli(repo, "verify");
  assert.match(out, /✓ sh bin\/vitest — exit 1: 2 old test failures \(failing on the base commit too\)/);
  const c = row(repo);
  assert.equal(c.exit, 0);
  assert.equal(c.rawExit, 1);
  assert.equal(c.oldFailures, 2);
  assert.deepEqual(c.oldFailList, ["tests/a.test.mjs › old one", "tests/a.test.mjs › old two"]);
  assert.equal(baseRuns().length, 1);
  assert.equal(ruleLines(cli(repo, "check"), "R3"), "");
  assert.match(cli(repo, "report"), /2 old test failures[^\n]*tests\/a\.test\.mjs › old one/);
  assert.match(cli(repo, "report", ["--brief"]), /For you:[^\n]*2 old test failures[^\n]*sh bin\/vitest/);
  const again = cli(repo, "verify");
  assert.match(again, /skipped: already green on this exact tree[^\n]*2 old test failures/);
  assert.match(again, /old: tests\/a\.test\.mjs › old one, tests\/a\.test\.mjs › old two/);
  assert.equal(baseRuns().length, 1);
  assert.match(cli(repo, "report"), /2 old test failures[^\n]*old two/);
});

test("F1 C2 refused: a test the change broke (passing on the base commit) keeps the command red and the output names it as new", () => {
  const { repo } = baseRepo("rv-f1c2", { base: "old one\n", now: "old one\nbroke one\n" });
  const out = cli(repo, "verify");
  assert.match(out, /✗ sh bin\/vitest — exit 1/);
  assert.match(out, /new with this change: tests\/a\.test\.mjs › broke one/);
  assert.equal(row(repo).exit, 1);
  assert.equal(row(repo).oldFailures, undefined);
  assert.match(ruleLines(cli(repo, "check"), "R3"), /red/);
});

test("F1 C3 refused: a failing test the base commit does not have stays red", () => {
  const { repo } = baseRepo("rv-f1c3", { base: "old one\n", now: "brand new test\n" });
  assert.match(cli(repo, "verify"), /new with this change: tests\/a\.test\.mjs › brand new test/);
  assert.equal(row(repo).exit, 1);
});

test("F1 C4 edge: output with no failing test name the gate reads stays red and the base commit is not run", () => {
  const { repo, baseRuns } = baseRepo("rv-f1c4", { base: "old one\n", extra: { "unreadable.txt": "x\n" } });
  cli(repo, "verify");
  assert.equal(row(repo).exit, 1);
  assert.equal(baseRuns().length, 0);
});

test("F1 C5 refused: a base run that shows no passing test is not trusted and the command stays red", () => {
  const { repo, baseRuns } = baseRepo("rv-f1c5", { base: "old one\n", extra: { "pass.txt": "0\n" } });
  write(repo, "pass.txt", "3\n");
  const out = cli(repo, "verify");
  assert.equal(baseRuns().length, 1);
  assert.equal(row(repo).exit, 1);
  assert.match(out, /the base commit run showed no passing test/);
});

test("F1 C6 boundary: the same names but a fail total above the base commit's stays red; equal totals count old", () => {
  const { repo } = baseRepo("rv-f1c6", { base: "old one\n" });
  write(repo, "failcount.txt", "2\n");
  assert.match(cli(repo, "verify"), /more tests fail than on the base commit \(2, was 1\)/);
  assert.equal(row(repo).exit, 1);
  write(repo, "failcount.txt", "1\n");
  cli(repo, "verify");
  assert.equal(row(repo).exit, 0);
});

test("F1 C7 idempotent: a second red verify of the same command reuses the base result, so the base commit runs once", () => {
  const { repo, baseRuns } = baseRepo("rv-f1c7", { base: "old one\n", now: "old one\nbroke one\n" });
  cli(repo, "verify");
  write(repo, "src/a.ts", "export const a = 'changed again';\n");
  cli(repo, "verify");
  assert.equal(baseRuns().length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(runDir(repo), "base-runs.json"), "utf8")).runs["sh bin/vitest"].names, ["tests/a.test.mjs › old one"]);
});

test("F1 C8 edge: the worktree and its links are gone after verify, git lists only the repo, and the repo's node_modules is untouched", () => {
  const { repo, baseRuns } = baseRepo("rv-f1c8", { base: "old one\n", extra: { "node_modules/x/index.js": "module.exports = 1;\n" } });
  cli(repo, "verify");
  const [line] = baseRuns();
  assert.match(line, / linked$/);
  const dir = line.replace(/ linked$/, "");
  assert.equal(path.basename(dir), path.basename(repo));
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(path.dirname(dir)), false);
  const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree "));
  assert.equal(listed.length, 1);
  assert.equal(readFileSync(path.join(repo, "node_modules/x/index.js"), "utf8"), "module.exports = 1;\n");

  const dropped = baseRepo("rv-f1c8d", { base: "old one\n", extra: { "node_modules/x/index.js": "module.exports = 1;\n", "drop-link.txt": "x\n" } });
  cli(dropped.repo, "verify");
  assert.equal(row(dropped.repo).exit, 0);
  assert.equal(existsSync(dropped.baseRuns()[0].replace(/ linked$/, "")), false);
});

test("F1 C9 edge: a timeout and a lint command never run on the base commit", () => {
  const timed = baseRepo("rv-f1c9t", { base: "old one\n", extra: { "slow.txt": "x\n" } });
  const gateJson = path.join(timed.repo, ".claude/gate.json");
  writeFileSync(gateJson, JSON.stringify({ verify: [{ cmd: "sh bin/vitest", timeout: 1 }] }));
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "timeout"], { cwd: timed.repo });
  cli(timed.repo, "verify");
  assert.equal(row(timed.repo).timedOut, true);
  assert.equal(timed.baseRuns().length, 0);

  const lint = baseRepo("rv-f1c9l", { base: "old one\n", cmd: "sh bin/vitest-lint" });
  write(lint.repo, "bin/vitest-lint", readFileSync(path.join(lint.repo, "bin/vitest"), "utf8"));
  cli(lint.repo, "verify");
  assert.equal(row(lint.repo).exit, 1);
  assert.equal(lint.baseRuns().length, 0);
});

test("F1 C10 happy: failing test names are read from node spec, TAP, vitest, jest, pytest, go and cargo output", async () => {
  const { failedTests } = await import("../scripts/lib/verify.mjs");
  const root = "/work/repo";
  const spec = "✖ outer (1ms)\nℹ fail 2\n\n✖ failing tests:\n\ntest at /work/repo/tests/a.test.mjs:4:1\n✖ bad one (0.306292ms)\n  AssertionError\n\ntest at tests/b.test.mjs:5:36\n✖ inner bad (12ms)\n";
  assert.deepEqual(failedTests(spec, [root]).names, ["tests/a.test.mjs › bad one", "tests/b.test.mjs › inner bad"]);
  assert.equal(failedTests(spec, [root]).fail, 2);
  assert.deepEqual(failedTests("TAP version 13\nnot ok 3 - bad one # time=1.2ms\n    not ok 1 - inner\nok 4 - fine\n# fail 2\n", [root]).names, ["bad one", "inner"]);
  assert.deepEqual(failedTests(" FAIL  tests/a.test.ts > suite > bad one 3ms\n Tests  1 failed | 4 passed (5)\n", [root]).names, ["tests/a.test.ts > suite > bad one"]);
  assert.equal(failedTests(" Tests  1 failed | 4 passed (5)\n FAIL  x > y\n", [root]).fail, 1);
  assert.deepEqual(failedTests("FAIL tests/a.test.js\n  ● suite › bad one\n\nTests:       1 failed, 3 passed, 4 total\n", [root]).names, ["suite › bad one", "tests/a.test.js"]);
  assert.deepEqual(failedTests("FAILED tests/test_a.py::test_bad - assert 1 == 2\n==== 1 failed, 2 passed in 0.1s ====\n", [root]).names, ["tests/test_a.py::test_bad"]);
  assert.deepEqual(failedTests("--- FAIL: TestBad (0.00s)\n    --- FAIL: TestBad/sub (0.00s)\nFAIL\nFAIL\texample.com/a\t0.01s\nFAIL\texample.com/b [build failed]\n", [root]).names, ["TestBad", "TestBad/sub", "example.com/a", "example.com/b [build failed]"]);
  assert.deepEqual(failedTests("ERROR tests/test_b.py - ImportError\n1 error in 0.1s\n", [root]).names, ["error: tests/test_b.py"]);
  assert.deepEqual(failedTests("not ok 1 - later # TODO not yet\nnot ok 2 - real\n", [root]).names, ["real"]);
  assert.deepEqual(failedTests("test tests::bad ... FAILED\ntest result: FAILED. 2 passed; 1 failed\n", [root]).names, ["tests::bad"]);
  assert.equal(failedTests("boom\n", [root]), null);
});

test("F1 C11 refused: an ignored .env the tests read is linked into the base worktree, so a test the change broke that needs it stays red", () => {
  const { repo } = baseRepo("rv-f1c11", { base: "old one\n", now: "old one\nenv one\n", extra: { "needs-env": "x\n", ".gitignore": "node_modules/\nignored.txt\n.env\n" } });
  write(repo, ".env", "KEY=1\n");
  assert.match(cli(repo, "verify"), /new with this change: tests\/a\.test\.mjs › env one/);
  assert.equal(row(repo).exit, 1);
});

test("F1 C12 refused: a run opened on uncommitted changes does not trust a base run and says why", () => {
  const log = path.join(here, ".tmp", "rv-f1c12.runs");
  rmSync(log, { force: true });
  const repo = makeRepo("rv-f1c12", { ".claude/gate.json": JSON.stringify({ verify: ["sh bin/vitest"] }), ...fakeRunner(log), "fails.txt": "old one\n" });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  write(repo, "src/a.ts", "export const dirty = 1;\n");
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/a.ts", "export const dirty = 2;\n");
  assert.match(cli(repo, "verify"), /the run began on uncommitted changes or other sessions' commits/);
  assert.equal(row(repo).exit, 1);
});

test("F1 C14 idempotent: the base result is saved when the base run ends, so a verify killed before it wrote verify.json does not run the base again", () => {
  const { repo, baseRuns } = baseRepo("rv-f1c14", { base: "old one\n", now: "old one\nbroke one\n" });
  cli(repo, "verify");
  assert.ok(existsSync(path.join(runDir(repo), "base-runs.json")));
  rmSync(path.join(runDir(repo), "verify.json"));
  cli(repo, "verify");
  assert.equal(baseRuns().length, 1);
});

test("F1 C15 edge: a worktree a dead verify left is removed on the next base run, and the repo's hooks do not run on the base checkout", () => {
  const { repo, baseRuns } = baseRepo("rv-f1c15", { base: "old one\n" });
  const left = execFileSync("mktemp", ["-d", path.join(execFileSync("node", ["-p", "require('os').tmpdir()"], { encoding: "utf8" }).trim(), "done-gate-base-999999-XXXXXX")], { encoding: "utf8" }).trim();
  execFileSync("git", ["worktree", "add", "--detach", "-q", path.join(left, "w"), "HEAD"], { cwd: repo });
  const marker = path.join(here, ".tmp", "rv-f1c15.hook");
  rmSync(marker, { force: true });
  write(repo, ".git/hooks/post-checkout", `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  execFileSync("chmod", ["+x", path.join(repo, ".git/hooks/post-checkout")]);
  cli(repo, "verify");
  assert.equal(baseRuns().length, 1);
  assert.equal(row(repo).exit, 0);
  assert.equal(existsSync(left), false);
  assert.equal(existsSync(marker), false);
  const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree "));
  assert.equal(listed.length, 1);
});
