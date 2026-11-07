import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, write } from "./helpers.mjs";
import { proposeSetup } from "../scripts/lib/setup.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { coverageGaps } from "../scripts/lib/verify.mjs";

// From the 0.20.0 review, 3.3: the setup notice was missed in 14 sessions, gate.json kept the last
// tickets' test files, and a wrapper that runs named test files did not count as a test command.

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = [], input = "") => spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: envFor(repo), cwd: repo });
const started = (repo) => assert.equal(run(repo, "session-start", [], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" })).status, 0);
const said = (repo, text) => run(repo, "log", [], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "UserPromptSubmit", prompt: text }));
const runs = (repo) => existsSync(path.join(repo, ".claude", "gate", "runs"));
const JEST = { "package.json": JSON.stringify({ name: "j", scripts: { lint: "eslint .", test: "jest", build: "tsc" }, devDependencies: { jest: "29" } }), ".claude/gate.json": null };
function proposal(repo) {
  const r = run(repo, "setup");
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return { json: JSON.parse(r.stdout.slice(r.stdout.indexOf("{"), r.stdout.lastIndexOf("\n}") + 2)), out: r.stdout };
}
const WRAPPED = (verify) => ({
  "scripts/test_db.sh": "#!/bin/sh\n", "pytest.ini": "[pytest]\n",
  "tests/test_a.py": "def test_a():\n    pass\n", "tests/test_b.py": "def test_b():\n    pass\n",
  ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], verify }),
});

test("C1 reported-surface: a session shown the setup notice is refused at its first gate open, and no run is made", () => {
  const repo = makeRepo("shm-c1", JEST);
  started(repo);
  const r = run(repo, "open", ["t", "feature"]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /^done-gate: /m);
  assert.match(r.stderr, /`gate setup`/);
  assert.match(r.stderr, /--apply/);
  assert.match(r.stderr, /--decline/);
  assert.match(r.stderr, /gate open t feature --setup-later "<their words, at least three>"/);
  assert.equal(runs(repo), false);
});

test("C2 idempotent: a retry is refused again, unsaid words are refused, the user's words open it and hold for the session", () => {
  const repo = makeRepo("shm-c2", JEST);
  started(repo);
  assert.notEqual(run(repo, "open", ["t", "feature"]).status, 0);
  assert.notEqual(run(repo, "open", ["t", "feature"]).status, 0, "a plain retry");
  const unsaid = run(repo, "open", ["t", "feature", "--setup-later", "do it later then"]);
  assert.notEqual(unsaid.status, 0);
  assert.match(unsaid.stderr, /did not say "do it later then"/);
  assert.equal(runs(repo), false);
  said(repo, "ok, do it later then");
  const r = run(repo, "open", ["t", "feature", "--setup-later", "do it later then"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(run(repo, "abandon", ["t", "done with it"]).status, 0);
  assert.equal(run(repo, "open", ["u", "feature"]).status, 0, "the words hold for the session");
});

test("C3 refused: no refusal without the notice, on a set-up repo, or when rejoining an open run", () => {
  const quiet = makeRepo("shm-c3a", JEST);
  assert.equal(run(quiet, "open", ["t", "feature"]).status, 0, "no session-start notice");
  for (const testFiles of ["npx jest {files}", null]) {
    const repo = makeRepo(`shm-c3-${testFiles ? "set" : "null"}`, { ...JEST, ".claude/gate.json": JSON.stringify({ testFiles }) });
    started(repo);
    assert.equal(run(repo, "open", ["t", "feature"]).status, 0, String(testFiles));
  }
  const rejoin = makeRepo("shm-c3b", JEST);
  assert.equal(run(rejoin, "open", ["t", "feature"]).status, 0);
  started(rejoin);
  assert.equal(run(rejoin, "open", ["t"]).status, 0, "rejoin by slug");
});

test("C4 happy: after gate setup --apply or --decline, gate open is not refused", () => {
  for (const verb of ["--apply", "--decline"]) {
    const repo = makeRepo(`shm-c4${verb}`, JEST);
    started(repo);
    said(repo, "yes go ahead now");
    assert.equal(run(repo, "setup", [verb, "--user-ok", "yes go ahead"]).status, 0);
    const r = run(repo, "open", ["t", "feature"]);
    assert.equal(r.status, 0, `${verb}: ${r.stderr}`);
  }
});

test("C5 reported-surface: a wrapper over two named test files becomes testFiles, the entry is left out, and a note names it", () => {
  const cmd = "scripts/test_db.sh run tests/test_a.py tests/test_b.py -q";
  const repo = makeRepo("shm-c5", WRAPPED([cmd, "ruff check ."]));
  const { json, out } = proposal(repo);
  assert.equal(json.testFiles, "scripts/test_db.sh run {files} -q");
  // with no final command the related entry goes last
  assert.deepEqual(json.verify, ["ruff check .", { related: true }]);
  assert.ok(out.includes(cmd), out);
  assert.match(out, /Left out of verify/);
  // with the only test command left out, the proposal says a final check is still needed
  assert.match(out, /No test command to run as the final check/);
});

test("C6 boundary: a test command naming a folder, a glob or nothing is kept and marked final", () => {
  const verify = ["scripts/test_db.sh run tests/test_a.py -q", "scripts/test_db.sh run tests/ -q", "python3 -m pytest tests/test_*.py", "python3 -m pytest"];
  const { json } = proposal(makeRepo("shm-c6", WRAPPED(verify)));
  assert.deepEqual(json.verify, [{ related: true }, { cmd: verify[1], when: "final" }, { cmd: verify[2], when: "final" }, { cmd: verify[3], when: "final" }]);
});

test("C7 edge: a per-ticket list that is the source of testFiles is still left out; one whose files are gone is kept", () => {
  const cmd = "python3 -m pytest tests/test_a.py";
  const repo = makeRepo("shm-c7", { "tests/test_a.py": "def test_a():\n    pass\n", ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], verify: [cmd] }), "package.json": "{}" });
  const { json } = proposal(repo);
  assert.equal(json.testFiles, "python3 -m pytest {files}");
  assert.deepEqual(json.verify, [{ related: true }]);
  const gone = "python3 -m pytest tests/test_gone.py";
  const stale = makeRepo("shm-c7b", { "pytest.ini": "[pytest]\n", ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], verify: [gone] }), "package.json": "{}" });
  assert.deepEqual(proposal(stale).json.verify, [{ related: true }, { cmd: gone, when: "final" }]);
});

const gapsFor = (repo, cmd, file = "tests/test_a.py") => coverageGaps({
  root: repo,
  config: loadConfig(repo),
  ledger: { cases: [{ id: "C1", status: "closed", test: `${file}::test_a` }] },
  verify: { commands: [{ cmd, exit: 0 }] },
});

test("C8 reported-surface: R18: the testFiles template filled in covers the files it names, not others", () => {
  const repo = makeRepo("shm-c8", { ...WRAPPED([]), ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], testFiles: "scripts/test_db.sh run {files} -q" }) });
  assert.deepEqual(gapsFor(repo, "scripts/test_db.sh run tests/test_a.py -q"), []);
  assert.deepEqual(gapsFor(repo, "scripts/test_db.sh run tests/test_b.py -q").map((g) => g.id), ["C1"]);
});

test("C9 refused: R18: with no testFiles the wrapper is not a test command, and a lint naming a test file never covers it", () => {
  const repo = makeRepo("shm-c9", WRAPPED([]));
  assert.deepEqual(gapsFor(repo, "scripts/test_db.sh run tests/test_a.py -q").map((g) => g.id), ["C1"]);
  const set = makeRepo("shm-c9b", { ...WRAPPED([]), ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], testFiles: "scripts/test_db.sh run {files} -q" }) });
  assert.deepEqual(gapsFor(set, "ruff check tests/test_a.py").map((g) => g.id), ["C1"]);
});

// From docs/after-0.21.0.md, limits 1 and 2: a one-word template matched every call of its
// program, and a linter naming a folder was taken as the template.
const ONE_WORD = { "run.sh": "#!/bin/sh\n", "tests/test_a.py": "def test_a():\n    pass\n", "tests/test_b.py": "def test_b():\n    pass\n", ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], testFiles: "./run.sh {files}" }) };

test("C1 refused: a one-word template: a call naming no test path is not a test run of the whole folder", () => {
  assert.deepEqual(gapsFor(makeRepo("shm-ow1", ONE_WORD), "./run.sh lint").map((g) => g.id), ["C1"]);
});

test("C2 happy: a one-word template still covers the test files a call names, and only those", () => {
  const repo = makeRepo("shm-ow2", ONE_WORD);
  assert.deepEqual(gapsFor(repo, "./run.sh tests/test_a.py"), []);
  assert.deepEqual(gapsFor(repo, "./run.sh tests/test_b.py").map((g) => g.id), ["C1"]);
});

test("C3 boundary: a template of two words or more run with no path still covers the folder it runs in", () => {
  const repo = makeRepo("shm-ow3", { ...WRAPPED([]), ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], testFiles: "scripts/test_db.sh run {files} -q" }) });
  assert.deepEqual(gapsFor(repo, "scripts/test_db.sh run -q"), []);
});

test("C4 refused: setup never takes a linter naming the repo folder as testFiles", () => {
  const { json } = proposal(makeRepo("shm-lint1", WRAPPED(["ruff check ."])));
  assert.equal(json.testFiles, "python3 -m pytest {files} -q");
});

test("C5 edge: setup skips a linter listed before the wrapper and takes the wrapper", () => {
  const { json } = proposal(makeRepo("shm-lint2", WRAPPED(["ruff check tests/", "npx eslint tests/", "scripts/test_db.sh run tests/ -q"])));
  assert.equal(json.testFiles, "scripts/test_db.sh run {files} -q");
});

test("C6 edge: setup takes no template from a script that names only the repo folder", () => {
  const { json } = proposal(makeRepo("shm-lint3", { ...WRAPPED(["./lint.sh ."]), "lint.sh": "#!/bin/sh\n" }));
  assert.equal(json.testFiles, "python3 -m pytest {files} -q");
});

test("C7 boundary: a one-word template run bare or with flags only still covers the folder", () => {
  const repo = makeRepo("shm-ow7", ONE_WORD);
  assert.deepEqual(gapsFor(repo, "./run.sh"), []);
  assert.deepEqual(gapsFor(repo, "./run.sh -q"), []);
});

test("C8 edge: setup keeps a call of a one-word template's program that runs no tests as it is", () => {
  const json = proposeSetup(makeRepo("shm-ow8", { ...ONE_WORD, ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], testFiles: "./run.sh {files}", verify: ["./run.sh lint"] }) })).proposal;
  assert.deepEqual(json.verify, ["./run.sh lint", { related: true }]);
});

test("C9 edge: the setup refusal's --setup-later line keeps the --repo and --old-version-ok it was given", () => {
  const repo = makeRepo("shm-c9-flags", JEST);
  started(repo);
  said(repo, "fine, carry on");
  const r = run(repo, "open", ["t", "feature", "--repo", "../x y", "--old-version-ok", "fine, carry on"]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`gate open t feature --repo '../x y' --old-version-ok 'fine, carry on' --setup-later "<their words, at least three>"`), r.stderr);
});
