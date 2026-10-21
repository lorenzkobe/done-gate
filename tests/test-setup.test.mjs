// test-setup: a repo with tests but no testFiles key is told at session start to set up the
// faster test loop; `gate setup` prints a proposal built from the repo and writes nothing.
// Cases C1–C6.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = [], input = "") => spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: envFor(repo), cwd: repo });
function startContext(repo) {
  const r = run(repo, "session-start", [], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" }));
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}
const SETUP = /<done-gate-setup>[\s\S]*?<\/done-gate-setup>/;
// the JSON object `gate setup` prints, and the lines after it
function proposal(repo) {
  const r = run(repo, "setup");
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const start = r.stdout.indexOf("{");
  const end = r.stdout.lastIndexOf("\n}") + 2;
  return { json: JSON.parse(r.stdout.slice(start, end)), out: r.stdout };
}
const JEST = { "package.json": JSON.stringify({ name: "j", scripts: { lint: "eslint .", test: "jest", build: "tsc" }, devDependencies: { jest: "29" } }) };

test("C1 happy: a repo with tests and no testFiles key gets a setup block at session start", () => {
  const repo = makeRepo("ts-c1", JEST);
  const block = SETUP.exec(startContext(repo))?.[0] ?? "";
  assert.match(block, /`gate setup`/);
  assert.match(block, /gate setup --apply/);
  assert.match(block, /gate setup --decline/);
  assert.match(block, /--user-ok/);
  assert.match(block, /before `gate open`/);
});

test("C2 refused: no setup block with testFiles set or null, or with no tests; a fresh session has no done-gate-status", () => {
  const set = makeRepo("ts-c2-set", { ...JEST, ".claude/gate.json": JSON.stringify({ testFiles: "npx jest {files}" }) });
  assert.doesNotMatch(startContext(set), SETUP);
  const declined = makeRepo("ts-c2-null", { ...JEST, ".claude/gate.json": JSON.stringify({ testFiles: null }) });
  assert.doesNotMatch(startContext(declined), SETUP);
  const bare = makeRepo("ts-c2-bare", { "package.json": JSON.stringify({ name: "b", scripts: { lint: "true", build: "true" } }) });
  const ctx = startContext(bare);
  assert.doesNotMatch(ctx, SETUP);
  assert.doesNotMatch(ctx.replace(/<done-gate-status>\ndone-gate runs in place[\s\S]*?<\/done-gate-status>/, ""), /done-gate-status/);
});

test("C3 happy: gate setup on a jest repo proposes testFiles, keeps lint and build, marks the test command final after a related entry, and writes nothing", () => {
  const repo = makeRepo("ts-c3", JEST);
  const { json } = proposal(repo);
  assert.equal(json.testFiles, "npx jest {files}");
  assert.deepEqual(json.verify, ["npm run lint", { related: true }, { cmd: "npm run test", when: "final" }, { cmd: "npm run build", when: "source" }]);
  assert.equal(json.serialTests, undefined, "serialTests is a question for the user, not a guess");
  assert.equal(existsSync(path.join(repo, ".claude", "gate.json")), false, "gate setup wrote gate.json");
});

test("C4 edge: a pytest repo with ./venv and tests/conftest.py gets the venv runner and keeps its gate.json keys", () => {
  const existing = { tests: ["tests/**"], schema: ["app/migrations/**"], verify: [{ cmd: "./venv/bin/python -m pytest tests -q", timeout: 900 }, "./venv/bin/python -m flake8 app"] };
  const repo = makeRepo("ts-c4", { "venv/bin/python": "#!/bin/sh\n", "tests/conftest.py": "\n", "tests/test_a.py": "def test_a():\n    pass\n", ".claude/gate.json": JSON.stringify(existing) });
  const before = readFileSync(path.join(repo, ".claude", "gate.json"), "utf8");
  const { json, out } = proposal(repo);
  assert.equal(json.testFiles, "./venv/bin/python -m pytest {files} -q");
  assert.deepEqual(json.tests, existing.tests);
  assert.deepEqual(json.schema, existing.schema);
  assert.deepEqual(json.verify, [{ related: true }, { cmd: "./venv/bin/python -m pytest tests -q", timeout: 900, when: "final" }, "./venv/bin/python -m flake8 app"]);
  assert.match(out, /serialTests/);
  assert.equal(readFileSync(path.join(repo, ".claude", "gate.json"), "utf8"), before);
});

test("C5 boundary: no detectable runner: no testFiles proposed, a note says to fill it in, exit 0", () => {
  const repo = makeRepo("ts-c5", { ".claude/gate.json": JSON.stringify({ verify: ["make check"] }), "tests/check.sh": "true\n" });
  const { json, out } = proposal(repo);
  assert.equal(json.testFiles, undefined);
  assert.match(out, /testFiles/);
  assert.match(out, /by hand|yourself|fill/i);
});

test("C6 idempotent: the printed proposal, written as gate.json, loads with testFiles and a related entry and a final command", () => {
  const repo = makeRepo("ts-c6", JEST);
  const { json } = proposal(repo);
  write(repo, ".claude/gate.json", JSON.stringify(json, null, 2));
  const cfg = loadConfig(repo);
  assert.equal(cfg.testFiles, "npx jest {files}");
  assert.ok(cfg.verify.some((v) => v.related));
  assert.equal(cfg.verify.find((v) => v.cmd === "npm run test").when, "final");
  assert.doesNotMatch(startContext(repo), SETUP, "a set-up repo is not asked again");
});

// a user message as the UserPromptSubmit hook logs it
const said = (repo, text) => run(repo, "log", [], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "UserPromptSubmit", prompt: text }));
const check = (repo) => run(repo, "check").stdout;

test("C7 edge: --apply writes the proposal with the user's OK and counts as no change; refused without it, with unsaid words, bad JSON, or a run open", () => {
  const repo = makeRepo("ts-c7", JEST);
  startContext(repo);
  const gj = path.join(repo, ".claude", "gate.json");
  assert.notEqual(run(repo, "setup", ["--apply"]).status, 0, "no --user-ok");
  assert.notEqual(run(repo, "setup", ["--apply", "--user-ok", "yes add the keys"]).status, 0, "words the user never said");
  assert.equal(existsSync(gj), false);
  said(repo, "yes add the keys please");
  const bad = path.join(path.dirname(repo), "ts-c7-edited.json");
  writeFileSync(bad, "{ not json");
  assert.notEqual(run(repo, "setup", ["--apply", bad, "--user-ok", "yes add the keys"]).status, 0, "invalid JSON");
  const ok = run(repo, "setup", ["--apply", "--user-ok", "yes add the keys"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(loadConfig(repo).testFiles, "npx jest {files}");
  assert.doesNotMatch(check(repo), /R1/, "writing gate.json through gate setup is not task work");

  const open = makeRepo("ts-c7-open", JEST);
  startContext(open);
  said(open, "yes add the keys please");
  run(open, "open", ["t", "feature"]);
  const refused = run(open, "setup", ["--apply", "--user-ok", "yes add the keys"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /run is open|R13/);
});

test("C8 edge: --decline writes testFiles null, keeps other keys, no R1, and the next session is not asked", () => {
  const repo = makeRepo("ts-c8", { ...JEST, ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
  startContext(repo);
  said(repo, "no thanks not now");
  const r = run(repo, "setup", ["--decline", "--user-ok", "no thanks not"]);
  assert.equal(r.status, 0, r.stderr);
  const gj = JSON.parse(readFileSync(path.join(repo, ".claude", "gate.json"), "utf8"));
  assert.deepEqual(gj, { tests: ["tests/**"], testFiles: null });
  assert.doesNotMatch(check(repo), /R1/);
  assert.doesNotMatch(startContext(repo), SETUP);
});

test("C9 edge: a malformed gate.json: the mandate still ships and there is no setup block", () => {
  const repo = makeRepo("ts-c9", { ...JEST, ".claude/gate.json": "{ broken" });
  const ctx = startContext(repo);
  assert.match(ctx, /You have done-gate/);
  assert.doesNotMatch(ctx, SETUP);
});

test("C10 edge: no setup block while a run is open", () => {
  const repo = makeRepo("ts-c10", JEST);
  startContext(repo);
  run(repo, "open", ["t", "feature"]);
  const again = run(repo, "session-start", [], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "SessionStart", session_start_source: "resume" }));
  assert.doesNotMatch(JSON.parse(again.stdout).hookSpecificOutput.additionalContext, SETUP);
  const other = run(repo, "session-start", [], JSON.stringify({ session_id: "S2", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" }));
  assert.doesNotMatch(JSON.parse(other.stdout).hookSpecificOutput.additionalContext, SETUP);
});

test("C11 edge: an existing related entry or final command is kept as is; a testFiles without {files} still asks", () => {
  const repo = makeRepo("ts-c11", { ...JEST, ".claude/gate.json": JSON.stringify({ verify: ["npm run lint", { related: true }, { cmd: "npm run test", when: "final" }] }) });
  const { json } = proposal(repo);
  assert.deepEqual(json.verify, ["npm run lint", { related: true }, { cmd: "npm run test", when: "final" }]);
  const bad = makeRepo("ts-c11-bad", { ...JEST, ".claude/gate.json": JSON.stringify({ testFiles: "npx jest" }) });
  assert.match(startContext(bad), SETUP);
  assert.equal(proposal(bad).json.testFiles, "npx jest {files}");
});

test("C12 edge: pnpm with no gate.json gets pnpm run commands, build source; a ruff-only pyproject is not pytest", () => {
  const repo = makeRepo("ts-c12", { "package.json": JSON.stringify({ name: "p", scripts: { lint: "eslint .", test: "vitest run", build: "vite build" }, devDependencies: { vitest: "1" } }), "pnpm-lock.yaml": "" });
  const { json } = proposal(repo);
  assert.equal(json.testFiles, "npx vitest run {files}");
  assert.deepEqual(json.verify, ["pnpm run lint", { related: true }, { cmd: "pnpm run test", when: "final" }, { cmd: "pnpm run build", when: "source" }]);
  const ruff = makeRepo("ts-c12-ruff", { "pyproject.toml": "[tool.ruff]\nline-length = 100\n", "package.json": JSON.stringify({ name: "r", scripts: {} }) });
  assert.doesNotMatch(startContext(ruff), SETUP);
  assert.equal(proposal(ruff).json.testFiles, undefined);
});

test("C13 happy: a verify command that runs named test files through a wrapper becomes testFiles, with a serialTests hint for a database wrapper", () => {
  const cmd = `bash -c "scripts/test_db.sh run tests/test_a.py tests/test_b*.py lambdas/gen --deselect tests/test_a.py::test_x -p no:cacheprovider -q"`;
  const repo = makeRepo("ts-c13", {
    "scripts/test_db.sh": "#!/bin/sh\n", "venv/bin/python": "#!/bin/sh\n", "pytest.ini": "[pytest]\n",
    "tests/test_a.py": "def test_x():\n    pass\n", "tests/test_b1.py": "def test_b():\n    pass\n", "lambdas/gen/handler.py": "x = 1\n",
    ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], verify: [cmd] }),
  });
  const { json, out } = proposal(repo);
  assert.equal(json.testFiles, "scripts/test_db.sh run {files} -p no:cacheprovider -q");
  assert.match(out, /scripts\/test_db\.sh/);
  assert.match(out, /serialTests/);
  assert.match(out, /looks like a shared test database/);
});

test("C14 refused: no detectable runner: no related entry is proposed, and the proposal still loads as a working config", () => {
  const repo = makeRepo("ts-c14", { "go.mod": "module x\n", ".claude/gate.json": JSON.stringify({ verify: ["go vet ./...", "go test ./..."] }) });
  const { json, out } = proposal(repo);
  assert.equal(json.testFiles, undefined);
  assert.ok(!json.verify.some((e) => e && e.related), JSON.stringify(json.verify));
  assert.match(out, /related/);
});

test("C15 refused: an existing valid testFiles is kept; apply and decline on a set-up repo are refused", () => {
  const repo = makeRepo("ts-c15", { ...JEST, ".claude/gate.json": JSON.stringify({ testFiles: "scripts/run-tests {files}" }) });
  assert.equal(proposal(repo).json.testFiles, "scripts/run-tests {files}");
  startContext(repo);
  said(repo, "yes add the keys please");
  for (const flag of ["--apply", "--decline"]) {
    const r = run(repo, "setup", [flag, "--user-ok", "yes add the keys"]);
    assert.notEqual(r.status, 0, flag);
    assert.match(r.stderr, /already set up/, flag);
  }
});

test("C16 edge: the pytest guess follows the repo's environment; bad apply files and a malformed gate.json are refused clearly", () => {
  const guess = (name, files) => proposal(makeRepo(name, { "pytest.ini": "[pytest]\n", "tests/test_a.py": "def test_a():\n    pass\n", ...files })).json.testFiles;
  assert.equal(guess("ts-c16-venv", { ".venv/bin/python": "#!/bin/sh\n" }), "./.venv/bin/python -m pytest {files} -q");
  assert.equal(guess("ts-c16-poetry", { "poetry.lock": "" }), "poetry run pytest {files} -q");
  assert.equal(guess("ts-c16-uv", { "uv.lock": "" }), "uv run pytest {files} -q");
  assert.equal(guess("ts-c16-plain", {}), "python3 -m pytest {files} -q");

  const repo = makeRepo("ts-c16-apply", JEST);
  startContext(repo);
  said(repo, "yes add the keys please");
  for (const [n, body] of [["nofiles", { testFiles: "npx jest" }], ["norunner", { verify: [{ related: true }] }]]) {
    const f = path.join(path.dirname(repo), `ts-c16-${n}.json`);
    writeFileSync(f, JSON.stringify(body));
    const r = run(repo, "setup", ["--apply", f, "--user-ok", "yes add the keys"]);
    assert.notEqual(r.status, 0, n);
    assert.match(r.stderr, /testFiles/, n);
  }
  const broken = makeRepo("ts-c16-broken", { ...JEST, ".claude/gate.json": "{ broken" });
  const b = run(broken, "setup");
  assert.equal(b.status, 1);
  assert.match(b.stderr, /gate\.json.*(JSON|fix)/i);
  assert.doesNotMatch(`${b.stdout}${b.stderr}`, /GATE ERROR/);
});
