// related-final: gate verify runs this task's related tests while working ({related: true})
// and the area suite once at the end (when: "final", `gate verify --final`). Cases C1–C8.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, lookedUp } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env: envFor(repo), cwd: repo });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

const NODE = JSON.stringify(process.execPath);
// a stand-in runner: appends one JSON line per run with its tag and file arguments, exits 1
// when RED is in the tag
const PROBE = `import { appendFileSync } from "node:fs";
const [tag, ...files] = process.argv.slice(2);
appendFileSync("probe.log", JSON.stringify({ tag, files }) + "\\n");
process.exit(tag.includes("RED") ? 1 : 0);
`;
const CONTEXT = "Traced: src/booking.ts:1 · Related: tests/booking.test.ts · Research: none needed: a test fixture";

function opened(name, config, extra = {}) {
  const repo = makeRepo(name, {
    "probe.mjs": PROBE,
    ".gitignore": "node_modules/\nprobe.log\n",
    "src/booking.ts": "export const booking = 1;\n",
    "src/index.ts": "export * from './booking';\n",
    "tests/booking.test.ts": "import { booking } from '../src/booking';\ntest('b', () => booking);\n",
    "tests/other.test.ts": "test('o', () => 1);\n",
    "tests/case.test.ts": "test('c', () => 1);\n",
    "tests/index.test.ts": "import '../src/index';\n",
    ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], ...config }),
    ...extra,
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "One constant; no hot path.", "--files", "src/booking.ts"]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  return repo;
}
const probeRuns = (repo) => (existsSync(path.join(repo, "probe.log")) ? readFileSync(path.join(repo, "probe.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const resetProbe = (repo) => rmSync(path.join(repo, "probe.log"), { force: true });
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
const verifyJson = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8"));
const r3 = (repo) => run(repo, "check").stdout.split("\n").filter((l) => /R3/.test(l)).join("\n");
const RELATED = { testFiles: `${NODE} probe.mjs related {files}`, verify: [{ related: true }] };
const FINAL = (tag = "FINAL") => ({ cmd: `${NODE} probe.mjs ${tag}`, when: "final" });

test("C1 happy: the related entry runs testFiles on case tests, changed tests and tests naming a changed module, and nothing else", () => {
  const repo = opened("rf-c1", RELATED);
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  write(repo, "src/index.ts", "export * from './booking';\nexport const x = 1;\n");
  write(repo, "tests/new.test.ts", "test('n', () => 1);\n");
  cli(repo, "case", ["close", "C1", "--test", "tests/case.test.ts:c"]);
  cli(repo, "verify");
  const runs = probeRuns(repo);
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.deepEqual([...runs[0].files].sort(), ["tests/booking.test.ts", "tests/case.test.ts", "tests/new.test.ts"], "index is a generic stem: tests/index.test.ts is not related by it");
  const row = verifyJson(repo).commands[0];
  assert.deepEqual([...row.files].sort(), ["tests/booking.test.ts", "tests/case.test.ts", "tests/new.test.ts"]);
  assert.equal(row.exit, 0);
});

test("C2 boundary: no related test file: the related row is skipped and verify is green", () => {
  const repo = opened("rf-c2", RELATED);
  write(repo, "src/index.ts", "export * from './booking';\nexport const x = 1;\n");
  const out = cli(repo, "verify").stdout;
  assert.match(out, /no related test files/);
  assert.deepEqual(probeRuns(repo), []);
  assert.equal(r3(repo), "");
});

test("C3 refused: a related entry without testFiles is refused, naming testFiles, and nothing runs", () => {
  const repo = opened("rf-c3", { verify: [{ related: true }, `${NODE} probe.mjs OTHER`] });
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  const r = run(repo, "verify");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /testFiles/);
  assert.deepEqual(probeRuns(repo), []);
});

test("C4 happy: a final command is owed after a plain verify, runs once with --final, stays green on the same implementation, and is owed again after an edit", () => {
  const repo = opened("rf-c4", { verify: [`${NODE} probe.mjs QUICK`, FINAL()] });
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  cli(repo, "verify");
  assert.deepEqual(probeRuns(repo).map((r) => r.tag), ["QUICK"], "plain verify ran the final command");
  assert.match(r3(repo), /gate verify --final/);

  resetProbe(repo);
  cli(repo, "verify", ["--final"]);
  assert.deepEqual(probeRuns(repo).map((r) => r.tag), ["QUICK", "FINAL"]);
  assert.equal(r3(repo), "");

  resetProbe(repo);
  write(repo, "tests/booking.test.ts", "test('b2', () => 1);\n");
  cli(repo, "verify");
  assert.deepEqual(probeRuns(repo).map((r) => r.tag), ["QUICK"]);
  assert.equal(r3(repo), "", "a test-only edit owes the final command again");

  write(repo, "src/booking.ts", "export const booking = 3;\n");
  cli(repo, "verify");
  assert.match(r3(repo), /gate verify --final/);
});

test("C5 edge: with no implementation change a final command is not owed", () => {
  const repo = opened("rf-c5", { verify: [`${NODE} probe.mjs QUICK`, FINAL()] });
  write(repo, "tests/booking.test.ts", "test('b2', () => 1);\n");
  cli(repo, "verify");
  assert.equal(r3(repo), "");
  assert.deepEqual(probeRuns(repo).map((r) => r.tag), ["QUICK"]);
});

test("C6 refused: a red final run keeps R3 red, naming the command", () => {
  const repo = opened("rf-c6", { verify: [`${NODE} probe.mjs QUICK`, FINAL("FINAL-RED")] });
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  const r = run(repo, "verify", ["--final"]);
  assert.equal(r.status, 0, "a red verify still exits 0; R3 holds it");
  assert.match(r3(repo), /verify is red.*FINAL-RED/);
});

test("C7 edge: a pending final row does not make the reviewer's verify not fresh; the related row's files count as covered", () => {
  const repo = opened("rf-c7", { ...RELATED, verify: [{ related: true }, FINAL()] });
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  cli(repo, "case", ["close", "C1", "--test", "tests/case.test.ts:c"]);
  cli(repo, "verify");
  const packet = readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", ["reviewer"]).stdout)[1], "utf8");
  assert.match(packet, /verify\.json is fresh/, packet);
  assert.doesNotMatch(run(repo, "check").stdout, /R18/, "the related row's files count as covered");
});

test("C8 idempotent: a gate.json with neither form runs what it ran before and R3 is clear after one verify", () => {
  const repo = opened("rf-c8", { verify: [`${NODE} probe.mjs QUICK`, { cmd: `${NODE} probe.mjs BUILD`, when: "source" }] });
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  cli(repo, "verify");
  assert.deepEqual(probeRuns(repo).map((r) => r.tag), ["QUICK", "BUILD"]);
  assert.equal(r3(repo), "");
});

test("C9 boundary: a generic module name relates nothing; a bare word needs its folder or package; path and dotted references relate", () => {
  const repo = opened("rf-c9", RELATED, {
    "src/models.ts": "export const m = 1;\n",
    "tests/uses-models.test.ts": "import { m } from '../src/models';\n",
    "tests/word-only.test.ts": "// a booking is made here\n",
    "tests/dotted.test.py": "from src.booking import booking\n",
    "tests/from-import.test.py": "from src import booking\n",
  });
  write(repo, "src/models.ts", "export const m = 2;\n");
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  cli(repo, "verify");
  const files = probeRuns(repo).flatMap((r) => r.files).sort();
  assert.deepEqual(files, ["tests/booking.test.ts", "tests/dotted.test.py", "tests/from-import.test.py"], JSON.stringify(files));
});

test("C10 edge: the related entry is 'related tests' in verify output and the packet, and --drop 'related tests' drops it", () => {
  const repo = opened("rf-c10", { ...RELATED, verify: [{ related: true }, `${NODE} probe.mjs QUICK`] });
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  const out = cli(repo, "verify").stdout;
  assert.match(out, /related tests/);
  assert.doesNotMatch(out, /undefined/);
  const packet = readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", ["reviewer"]).stdout)[1], "utf8");
  assert.match(/## Test command\n([\s\S]*?)(?=\n## |$)/.exec(packet)[1], /related tests/);
  assert.doesNotMatch(packet, /`undefined`/);
  cli(repo, "verify", ["--drop", "related tests"]);
  resetProbe(repo);
  cli(repo, "verify");
  assert.deepEqual(probeRuns(repo).map((r) => r.tag), ["QUICK"]);
});

test("C11 edge: gate verify --final reruns every entry, so the related row and its files stay in verify.json", () => {
  const repo = opened("rf-c11", { ...RELATED, verify: [{ related: true }, FINAL()] });
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  cli(repo, "verify");
  cli(repo, "verify", ["--final"]);
  const rows = verifyJson(repo).commands;
  assert.deepEqual(rows.map((c) => c.cmd.includes("FINAL") ? "final" : c.cmd), ["related tests", "final"]);
  assert.deepEqual(rows[0].files, ["tests/booking.test.ts"]);
  assert.equal(r3(repo), "");
});

test("C12 refused: a related entry in a declared repo's gate.json is skipped as main-repo-only", () => {
  const other = makeRepo("rf-c12-other", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], testFiles: `${NODE} probe.mjs OTHER {files}`, verify: [{ related: true }] }) });
  execFileSync("git", ["add", "-A"], { cwd: other });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: other });
  const repo = makeRepo("rf-c12", { "probe.mjs": PROBE, ".gitignore": "node_modules/\nprobe.log\n", ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], verify: [`${NODE} probe.mjs QUICK`] }) });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature", "--repo", "../rf-c12-other"]);
  write(repo, "src/a.ts", "export const a = 9;\n");
  const out = cli(repo, "verify").stdout;
  assert.match(out, /related tests.*main repo only/);
  assert.equal(probeRuns(other).length, 0);
});

test("C13 edge: a final command keeps covering a case's test file when a later verify skips it; --final reruns it after a test-only edit", () => {
  const repo = opened("rf-c13", { verify: [`${NODE} probe.mjs QUICK`, { cmd: `${NODE} --test tests/case.test.mjs`, when: "final" }] }, {
    "tests/case.test.mjs": 'import test from "node:test";\ntest("c", () => {});\n',
  });
  write(repo, "src/booking.ts", "export const booking = 2;\n");
  cli(repo, "case", ["close", "C1", "--test", "tests/case.test.mjs:c"]);
  cli(repo, "verify", ["--final"]);
  assert.doesNotMatch(run(repo, "check").stdout, /R18|R3/);
  cli(repo, "verify");
  assert.doesNotMatch(run(repo, "check").stdout, /R18|R3/, "a skip on unchanged code lost the final command's coverage");

  write(repo, "tests/case.test.mjs", 'import test from "node:test";\ntest("c", () => {});\ntest("d", () => {});\n');
  cli(repo, "verify");
  assert.match(run(repo, "check").stdout, /R18/, "a test-only edit: the final command did not run the changed test file");
  cli(repo, "verify", ["--final"]);
  assert.doesNotMatch(run(repo, "check").stdout, /R18|R3/, "--final did not rerun the final command after a test-only edit");
});

test("C14 boundary: a hub module most tests reference selects none of them; a module a few reference still selects those", () => {
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`tests/test_m${i}.py`, "from src import hub\n"]));
  const repo = opened("rf-c14", RELATED, {
    ...many,
    "src/hub.py": "X = 1\n",
    "src/leaf.py": "Y = 1\n",
    "tests/test_leaf_a.py": "from src.leaf import Y\n",
    "tests/test_leaf_b.py": "from src import hub\nfrom src import leaf\n",
  });
  write(repo, "src/hub.py", "X = 2\n");
  write(repo, "src/leaf.py", "Y = 2\n");
  cli(repo, "verify");
  const files = probeRuns(repo).flatMap((r) => r.files).sort();
  assert.deepEqual(files, ["tests/test_leaf_a.py", "tests/test_leaf_b.py"], JSON.stringify(files));
});

test("C15 edge: helper files under the tests folder are not selected, scanned or changed; a closed case's own file still is", () => {
  const repo = opened("rf-c15", RELATED, {
    "src/leaf.py": "Y = 1\n",
    "tests/test_leaf.py": "from src.leaf import Y\n",
    "tests/leaf_support.py": "from src.leaf import Y\n",
    "tests/conftest.py": "from src.leaf import Y\n",
    "tests/booking_helpers.py": "Z = 1\n",
    "tests/case_check.py": "def test_c():\n    pass\n",
  });
  write(repo, "src/leaf.py", "Y = 2\n");
  write(repo, "tests/booking_helpers.py", "Z = 2\n");
  cli(repo, "case", ["close", "C1", "--test", "tests/case_check.py:test_c"]);
  cli(repo, "verify");
  const files = probeRuns(repo).flatMap((r) => r.files).sort();
  assert.deepEqual(files, ["tests/case_check.py", "tests/test_leaf.py"], JSON.stringify(files));
});

test("C16 boundary: tests in any layout are selected; a hub keeps its namesake test; 20 references are not a hub, 21 are", () => {
  const repo = opened("rf-c16", RELATED, {
    "src/leaf.py": "Y = 1\n",
    "tests/__tests__/unit/leaf.ts": "import 'src/leaf';\n",
    "tests/LeafTest.java": "import src.leaf;\n",
    "tests/leaf_spec.rb": "require 'src/leaf'\n",
    "tests/leaf.cy.ts": "import '../src/leaf';\n",
    "tests/tests.py": "from src.leaf import Y\n",
    "src/hub.py": "X = 1\n",
    "tests/test_hub.py": "from src import hub\n",
    ...Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`tests/test_h${i}.py`, "from src import hub\n"])),
    "src/twenty.py": "T = 1\n",
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`tests/test_t${i}.py`, "from src import twenty\n"])),
  });
  for (const f of ["src/leaf.py", "src/hub.py", "src/twenty.py"]) write(repo, f, "Z = 2\n");
  cli(repo, "verify");
  const files = new Set(probeRuns(repo).flatMap((r) => r.files));
  for (const f of ["tests/__tests__/unit/leaf.ts", "tests/LeafTest.java", "tests/leaf_spec.rb", "tests/leaf.cy.ts", "tests/tests.py", "tests/test_hub.py", "tests/test_t19.py"]) assert.ok(files.has(f), `${f} not selected: ${[...files].sort().join(", ")}`);
  assert.ok(!files.has("tests/test_h0.py"), "21 references in a repo of this size are a hub");
});

test("C17 edge: files named as tests are selected even when their name or folder sounds like a helper", () => {
  const named = ["tests/test_utils.py", "tests/test_helpers.py", "tests/test_support.py", "tests/helpers/foo_helper_spec.rb", "tests/support/a.test.ts", "tests/helpers/x_helper_test.rb"];
  const repo = opened("rf-c17", RELATED, { "src/leaf.py": "Y = 1\n", ...Object.fromEntries(named.map((f) => [f, "from src.leaf import Y\n"])), "tests/leaf_helpers.py": "from src.leaf import Y\n" });
  write(repo, "src/leaf.py", "Y = 2\n");
  cli(repo, "verify");
  const files = probeRuns(repo).flatMap((r) => r.files).sort();
  assert.deepEqual(files, [...named].sort(), JSON.stringify(files));
});
