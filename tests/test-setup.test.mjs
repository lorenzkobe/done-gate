// test-setup: a repo with tests but no testFiles key is told at session start to set up the
// faster test loop; `gate setup` prints a proposal built from the repo and writes nothing.
// Cases C1–C6.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, clearedFrom } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { needsSetup, pendingOffers } from "../scripts/lib/setup.mjs";
import { nextSeq } from "../scripts/lib/events.mjs";
import { updateSession } from "../scripts/lib/session-state.mjs";

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
// no gate.json: the fixture's declined setup would hide the ask these tests are about
const JEST = { "package.json": JSON.stringify({ name: "j", scripts: { lint: "eslint .", test: "jest", build: "tsc" }, devDependencies: { jest: "29" } }), ".claude/gate.json": null };

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
  said(open, "set it up later please");
  assert.equal(run(open, "open", ["t", "feature", "--setup-later", "set it up later"]).status, 0);
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
  said(repo, "set it up later please");
  assert.equal(run(repo, "open", ["t", "feature", "--setup-later", "set it up later"]).status, 0);
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
  const repo = makeRepo("ts-c12", { ".claude/gate.json": null, "package.json": JSON.stringify({ name: "p", scripts: { lint: "eslint .", test: "vitest run", build: "vite build" }, devDependencies: { vitest: "1" } }), "pnpm-lock.yaml": "" });
  const { json } = proposal(repo);
  assert.equal(json.testFiles, "npx vitest run {files}");
  assert.deepEqual(json.verify, ["pnpm run lint", { related: true }, { cmd: "pnpm run test", when: "final" }, { cmd: "pnpm run build", when: "source" }]);
  const ruff = makeRepo("ts-c12-ruff", { ".claude/gate.json": null, "pyproject.toml": "[tool.ruff]\nline-length = 100\n", "package.json": JSON.stringify({ name: "r", scripts: {} }) });
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
  assert.match(run(repo, "setup").stdout, /already set up/);
  assert.equal(loadConfig(repo).testFiles, "scripts/run-tests {files}");
  startContext(repo);
  said(repo, "yes add the keys please");
  for (const flag of ["--apply", "--decline"]) {
    const r = run(repo, "setup", [flag, "--user-ok", "yes add the keys"]);
    assert.notEqual(r.status, 0, flag);
    assert.match(r.stderr, /already set up/, flag);
  }
});

test("C16 edge: the pytest guess follows the repo's environment; bad apply files and a malformed gate.json are refused clearly", () => {
  const guess = (name, files) => proposal(makeRepo(name, { ".claude/gate.json": null, "pytest.ini": "[pytest]\n", "tests/test_a.py": "def test_a():\n    pass\n", ...files })).json.testFiles;
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

function agedRun(name, ageMs, session = "S9", touchedMs = ageMs) {
  const repo = makeRepo(name, JEST);
  startContext(repo);
  said(repo, "set it up later please");
  const opened = run(repo, "open", ["old-task", "feature", "--setup-later", "set it up later"]);
  assert.equal(opened.status, 0, opened.stderr);
  const ledger = path.join(repo, ".claude/gate/runs", readdirSync(path.join(repo, ".claude/gate/runs"))[0], "ledger.json");
  const body = JSON.parse(readFileSync(ledger, "utf8"));
  writeFileSync(ledger, JSON.stringify({ ...body, sessions: [session], openedAt: new Date(Date.now() - ageMs).toISOString() }));
  const touched = new Date(Date.now() - touchedMs);
  utimesSync(ledger, touched, touched);
  rmSync(path.join(repo, ".claude/gate/sessions/S1"), { recursive: true, force: true });
  return repo;
}
const DAY = 24 * 3600 * 1000;

test("a repo with only another session's run, two days or older, gets the setup notice and apply works", () => {
  const repo = agedRun("ts-stale", 3 * DAY);
  assert.match(startContext(repo), SETUP);
  said(repo, "yes add the keys please");
  const applied = run(repo, "setup", ["--apply", "--user-ok", "yes add the keys"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(readFileSync(path.join(repo, ".claude/gate.json"), "utf8"), /testFiles/);
});

test("an own run and a fresh foreign run still hide the notice and refuse apply", () => {
  const fresh = agedRun("ts-fresh", 2 * DAY - 60_000);
  assert.doesNotMatch(startContext(fresh), SETUP);
  said(fresh, "yes add the keys please");
  assert.notEqual(run(fresh, "setup", ["--apply", "--user-ok", "yes add the keys"]).status, 0);
  const own = agedRun("ts-own", 3 * DAY, "S1");
  const resumed = run(own, "session-start", [], JSON.stringify({ session_id: "S1", cwd: own, hook_event_name: "SessionStart", session_start_source: "resume" }));
  assert.doesNotMatch(JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext, SETUP);
  said(own, "yes add the keys please");
  assert.notEqual(run(own, "setup", ["--apply", "--user-ok", "yes add the keys"]).status, 0);
});

test("apply beside a stale run re-stamps it: no R13 on attach or a cleared session, and its report says so", () => {
  for (const join of ["attach", "clear"]) {
    const repo = agedRun(`ts-restamp-${join}`, 3 * DAY);
    startContext(repo);
    said(repo, "yes add the keys please");
    assert.equal(run(repo, "setup", ["--apply", "--user-ok", "yes add the keys"]).status, 0);
    rmSync(path.join(repo, ".claude/gate/sessions/S1"), { recursive: true, force: true });
    if (join === "clear") {
      // the session S1 cleared was on the run; the claude process kept its pid
      assert.equal(spawnSync(process.execPath, [gate, "attach", "old-task"], { encoding: "utf8", env: { ...envFor(repo), DONE_GATE_SESSION: "S0" }, cwd: repo }).status, 0);
      clearedFrom(repo, "S0");
    }
    const started = run(repo, "session-start", [], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "SessionStart", session_start_source: join === "clear" ? "clear" : "startup" }));
    assert.equal(started.status, 0, started.stderr);
    if (join === "attach") assert.equal(run(repo, "attach", ["old-task"]).status, 0);
    assert.doesNotMatch(run(repo, "check").stdout, /R13/, join);
    assert.match(run(repo, "report").stdout, /gate setup changed gate\.json on .* while this run sat idle/, join);
  }
});

test("a run opened days ago but touched recently is not stale", () => {
  const repo = agedRun("ts-active", 3 * DAY, "S9", 60_000);
  assert.doesNotMatch(startContext(repo), SETUP);
  said(repo, "yes add the keys please");
  assert.notEqual(run(repo, "setup", ["--apply", "--user-ok", "yes add the keys"]).status, 0);
});

test("decline is allowed beside a stale run and refused beside a fresh or own one", () => {
  const stale = agedRun("ts-decline-stale", 3 * DAY);
  startContext(stale);
  said(stale, "no thanks not now");
  assert.equal(run(stale, "setup", ["--decline", "--user-ok", "no thanks not now"]).status, 0);
  assert.match(readFileSync(path.join(stale, ".claude/gate.json"), "utf8"), /"testFiles": null/);
  for (const repo of [agedRun("ts-decline-fresh", DAY), agedRun("ts-decline-own", 3 * DAY, "S1")]) {
    startContext(repo);
    said(repo, "no thanks not now");
    assert.notEqual(run(repo, "setup", ["--decline", "--user-ok", "no thanks not now"]).status, 0);
  }
});

test("3.4: gate setup keeps a verify entry's external flag, on a final command and a plain one", () => {
  const repo = makeRepo("ts-external", { ...JEST, ".claude/gate.json": JSON.stringify({ verify: [{ cmd: "npm run test", external: true }, { cmd: "npm run db", external: true }] }) });
  const { json } = proposal(repo);
  assert.deepEqual(json.verify.filter((v) => v.external).map((v) => v.cmd), ["npm run test", "npm run db"]);
});

// Batch 3.13: a repo already set up is offered what later releases added, once.
const SET_UP = { ".claude/gate.json": JSON.stringify({ testFiles: "npx vitest run {files}", verify: ["npm run lint", { related: true }, { cmd: "npm run test", when: "final" }] }) };
const PLAYWRIGHT = { "package.json": JSON.stringify({ name: "p", scripts: { lint: "eslint .", test: "vitest", "test:e2e": "playwright test" }, devDependencies: { "@playwright/test": "1" } }) };
const setUpRepo = (name, files = {}) => makeRepo(name, { ...SET_UP, ...PLAYWRIGHT, ...files });
const gateJson = (repo) => JSON.parse(readFileSync(path.join(repo, ".claude", "gate.json"), "utf8"));
const words = (repo, prompt) => run(repo, "log", [], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "UserPromptSubmit", prompt }));
const applied = (repo, say = "yes add those settings") => {
  words(repo, say);
  const r = run(repo, "setup", ["--apply", "--user-ok", say]);
  assert.equal(r.status, 0, r.stderr);
};

test("3.13 C1 a set-up repo with Playwright is offered the final entry and the driver once", () => {
  const repo = setUpRepo("ts-o1");
  assert.match(startContext(repo), /<done-gate-setup>[\s\S]*gate setup/);
  const before = gateJson(repo);
  const { json } = proposal(repo);
  assert.equal(json.driver, "cmd:npm run test:e2e");
  assert.deepEqual(json.verify, [...before.verify, { cmd: "npm run test:e2e", when: "final" }]);
  assert.equal(json.testFiles, before.testFiles, "only new keys move");
  assert.deepEqual(gateJson(repo), before, "gate setup wrote nothing");
  applied(repo);
  assert.equal(gateJson(repo).driver, "cmd:npm run test:e2e");
  assert.deepEqual(gateJson(repo).offered, ["e2e"]);
  assert.doesNotMatch(startContext(repo), /<done-gate-setup>/);
  assert.match(run(repo, "setup").stdout, /already set up/);
});

test("3.13 C2 a decline stays: no notice and no proposal after it, and nothing else in gate.json changed", () => {
  const repo = setUpRepo("ts-o2");
  const before = gateJson(repo);
  words(repo, "no thanks not those");
  assert.equal(run(repo, "setup", ["--decline", "--user-ok", "no thanks not those"]).status, 0);
  assert.deepEqual(gateJson(repo), { ...before, offered: ["e2e"] });
  assert.doesNotMatch(startContext(repo), /<done-gate-setup>/);
  assert.match(run(repo, "setup").stdout, /already set up/);
});

test("3.13 C3 an existing driver or a verify skill is kept with a note, and verify is unchanged", () => {
  const driver = setUpRepo("ts-o3", { ".claude/gate.json": JSON.stringify({ ...JSON.parse(SET_UP[".claude/gate.json"]), driver: "skill:verify" }) });
  const before = gateJson(driver);
  const out = run(driver, "setup").stdout;
  assert.deepEqual(gateJson(driver), before);
  assert.match(out, /npm run test:e2e/);
  assert.match(out, /skill:verify/);

  const skill = setUpRepo("ts-o3b", { ".claude/skills/verify/SKILL.md": "# verify\n" });
  const second = run(skill, "setup");
  assert.match(second.stdout, /already set up/);
  assert.match(second.stdout, /npm run test:e2e/);
  assert.match(second.stdout, /verify skill/);
  assert.equal(gateJson(skill).driver, undefined);
});

test("3.13 C4 a repo with no e2e gets nothing new, and gate setup still says it is set up", () => {
  const repo = makeRepo("ts-o4", { ...SET_UP, "package.json": JSON.stringify({ name: "n", scripts: { test: "vitest" } }) });
  assert.doesNotMatch(startContext(repo), /<done-gate-setup>/);
  assert.match(run(repo, "setup").stdout, /already set up/);
  assert.match(run(repo, "setup", ["--apply", "--user-ok", "x y z"]).stderr, /already set up/);
});

test("3.13 C5 each way to find it, with the repo's package manager", () => {
  const scripted = (scripts, extra = {}) => ({ "package.json": JSON.stringify({ name: "x", scripts }), ...extra });
  const driverOf = (name, files) => proposal(makeRepo(name, { ...SET_UP, ...files })).json.driver;
  assert.equal(driverOf("ts-o5a", scripted({ e2e: "playwright test" })), "cmd:npm run e2e");
  assert.equal(driverOf("ts-o5b", scripted({ cy: "cypress run --headless" })), "cmd:npm run cy");
  assert.equal(driverOf("ts-o5c", scripted({ test: "vitest" }, { "playwright.config.ts": "export default {};\n" })), "cmd:npx playwright test");
  assert.equal(driverOf("ts-o5d", scripted({ test: "vitest" }, { "cypress.config.js": "module.exports = {};\n" })), "cmd:npx cypress run");
  assert.equal(driverOf("ts-o5e", scripted({ "test:e2e": "playwright test" }, { "pnpm-lock.yaml": "lockfileVersion: 9\n" })), "cmd:pnpm run test:e2e");
  assert.equal(driverOf("ts-o5f", scripted({ "test:e2e": "playwright test" }, { "yarn.lock": "# yarn\n" })), "cmd:yarn test:e2e");
});

test("3.13 C6 an e2e command already in verify gets only the driver; a repo with default verify keeps its commands", () => {
  const there = makeRepo("ts-o6", { ...PLAYWRIGHT, ".claude/gate.json": JSON.stringify({ testFiles: "npx vitest run {files}", verify: ["npm run lint", "npm run test:e2e"] }) });
  const first = proposal(there).json;
  assert.deepEqual(first.verify, ["npm run lint", "npm run test:e2e"]);
  assert.equal(first.driver, "cmd:npm run test:e2e");

  const defaults = makeRepo("ts-o6b", { ...PLAYWRIGHT, ".claude/gate.json": JSON.stringify({ testFiles: "npx vitest run {files}" }) });
  const before = loadConfig(defaults).verify.map((v) => v.cmd);
  const cmds = proposal(defaults).json.verify.map((v) => (typeof v === "string" ? v : v.cmd));
  for (const cmd of before) assert.ok(cmds.includes(cmd), cmd);
  assert.ok(cmds.includes("npm run test:e2e"));
});

// what gate close does to the session: the edits before now are history
const closedARun = (repo) => updateSession(path.join(repo, ".claude", "gate"), "S1", { baselineSeq: nextSeq() });

test("an answer given before a run closed still declines or applies after it", () => {
  const declined = setUpRepo("ts-late-no");
  startContext(declined);
  proposal(declined);
  words(declined, "no to the new setting");
  closedARun(declined);
  const no = run(declined, "setup", ["--decline", "--user-ok", "no to the new setting"]);
  assert.equal(no.status, 0, no.stderr);
  assert.deepEqual(gateJson(declined).offered, ["e2e"]);

  const taken = setUpRepo("ts-late-yes");
  startContext(taken);
  proposal(taken);
  words(taken, "yes add those settings");
  closedARun(taken);
  const yes = run(taken, "setup", ["--apply", "--user-ok", "yes add those settings"]);
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(gateJson(taken).driver, "cmd:npm run test:e2e");
});

test("words that answered one setup do not answer the next, and unsaid or a helper's words stay refused after a run closed", () => {
  const repo = setUpRepo("ts-late-reuse");
  startContext(repo);
  applied(repo);
  write(repo, ".claude/gate.json", SET_UP[".claude/gate.json"]);
  assert.equal(pendingOffers(repo).length, 1);
  assert.match(run(repo, "setup", ["--apply", "--user-ok", "yes add those settings"]).stderr, /did not say/);

  const other = setUpRepo("ts-late-unsaid");
  startContext(other);
  run(other, "log", [], JSON.stringify({ session_id: "S1", cwd: other, hook_event_name: "UserPromptSubmit", prompt: "no to that setting", agent_id: "A1", agent_type: "done-gate:reviewer" }));
  closedARun(other);
  for (const said of ["no thanks not those", "no to that setting"]) {
    assert.match(run(other, "setup", ["--decline", "--user-ok", said]).stderr, /did not say/, said);
  }
  assert.equal(gateJson(other).offered, undefined);
});

test("3.13 C7 first setup carries the same offers and records them", () => {
  const repo = makeRepo("ts-o7", { ".claude/gate.json": null, "package.json": JSON.stringify({ name: "p", scripts: { test: "jest", "test:e2e": "playwright test" }, devDependencies: { jest: "29" } }) });
  assert.equal(needsSetup(repo), true);
  const { json } = proposal(repo);
  assert.equal(json.driver, "cmd:npm run test:e2e");
  assert.deepEqual(json.offered, ["e2e"]);
  applied(repo);
  assert.match(run(repo, "setup").stdout, /already set up/);
  assert.equal(pendingOffers(repo).length, 0);

  const declined = makeRepo("ts-o7b", { ".claude/gate.json": null, ...PLAYWRIGHT });
  words(declined, "no thanks not now");
  assert.equal(run(declined, "setup", ["--decline", "--user-ok", "no thanks not now"]).status, 0);
  assert.equal(gateJson(declined).testFiles, null);
  assert.deepEqual(gateJson(declined).offered, ["e2e"]);
  assert.doesNotMatch(startContext(declined), /<done-gate-setup>/);
});

test("3.13 C8 a set-up repo with app/api is offered api; a run open silences it, refuses apply, and gate open is not held", () => {
  const repo = makeRepo("ts-o8", { ...SET_UP, "app/api/users/route.ts": "export const GET = 1;\n" });
  assert.deepEqual(proposal(repo).json.api, ["app/api/**"]);
  assert.match(startContext(repo), /<done-gate-setup>/);
  const opened = run(repo, "open", ["t", "feature"]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.doesNotMatch(startContext(repo), /<done-gate-setup>/);
  words(repo, "yes add those settings");
  assert.match(run(repo, "setup", ["--apply", "--user-ok", "yes add those settings"]).stderr, /a run is open/);
});

test("3.13 C9 gate.schema.json allows offered, and the keys it lists stay out of later proposals", () => {
  const schema = JSON.parse(readFileSync(new URL("../gate.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.offered.type, "array");
  const repo = makeRepo("ts-o9", { ...PLAYWRIGHT, "app/api/users/route.ts": "export const GET = 1;\n", ".claude/gate.json": JSON.stringify({ ...JSON.parse(SET_UP[".claude/gate.json"]), offered: ["e2e"] }) });
  const { json } = proposal(repo);
  assert.equal(json.driver, undefined);
  assert.deepEqual(json.api, ["app/api/**"]);
  assert.deepEqual(json.offered, ["e2e", "api"]);
});

test("3.13 C10 a repo that declined the faster loop keeps testFiles null and is still offered the new keys", () => {
  const repo = makeRepo("ts-o10", { ...PLAYWRIGHT, ".claude/gate.json": JSON.stringify({ testFiles: null }) });
  assert.match(startContext(repo), /<done-gate-setup>[\s\S]*e2e/);
  applied(repo);
  assert.equal(gateJson(repo).testFiles, null);
  assert.equal(gateJson(repo).driver, "cmd:npm run test:e2e");
  assert.equal(needsSetup(repo), false);
});

test("3.13 C11 an empty app/api is no offer; a bare gate setup on a set-up repo says so with status 0; apply refuses an edited file there", () => {
  const empty = makeRepo("ts-o11", { ...SET_UP, "package.json": JSON.stringify({ name: "n", scripts: { test: "vitest" } }) });
  mkdirSync(path.join(empty, "app/api"), { recursive: true });
  assert.doesNotMatch(startContext(empty), /<done-gate-setup>/);
  const bare = run(empty, "setup");
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /already set up/);

  const repo = setUpRepo("ts-o11b");
  write(repo, "edited.json", JSON.stringify({ testFiles: "other {files}", driver: "cmd:other" }));
  words(repo, "yes add those settings");
  assert.match(run(repo, "setup", ["--apply", "edited.json", "--user-ok", "yes add those settings"]).stderr, /already set up/);
  assert.equal(gateJson(repo).driver, undefined);
});

test("3.13 C12 a note-only offer brings no notice, and shows only in gate setup", () => {
  const repo = setUpRepo("ts-o12", { ".claude/gate.json": JSON.stringify({ ...JSON.parse(SET_UP[".claude/gate.json"]), driver: "skill:verify" }) });
  assert.doesNotMatch(startContext(repo), /<done-gate-setup>/);
  assert.equal(pendingOffers(repo).length, 0);
  assert.match(run(repo, "setup").stdout, /npm run test:e2e/);
});

test("3.13 C13 another spelling in verify becomes the driver with no second entry; interactive and joined scripts are not picked; the proposal states the cost", () => {
  const spelled = makeRepo("ts-o13", { ...PLAYWRIGHT, ".claude/gate.json": JSON.stringify({ testFiles: "npx vitest run {files}", verify: ["npm run lint", "npx playwright test"] }) });
  const first = proposal(spelled);
  assert.equal(first.json.driver, "cmd:npx playwright test");
  assert.deepEqual(first.json.verify, ["npm run lint", "npx playwright test"]);
  assert.match(first.out, /red or flaky run blocks/);

  const pick = (name, scripts) => proposal(makeRepo(name, { ...SET_UP, "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest", ...scripts } }) })).json.driver;
  assert.equal(pick("ts-o13b", { dev: "playwright test --ui", run: "playwright test" }), "cmd:npm run run");
  assert.match(run(makeRepo("ts-o13c", { ...SET_UP, "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest", dev: "playwright test --headed" } }) }), "setup").stdout, /already set up/);
  assert.match(run(makeRepo("ts-o13d", { ...SET_UP, "package.json": JSON.stringify({ name: "x", scripts: { all: "vitest && playwright test" } }) }), "setup").stdout, /already set up/);
  assert.equal(pick("ts-o13e", { "test:e2e": "./run-e2e.sh", other: "playwright test" }), "cmd:npm run test:e2e");
});

test("3.13 C14 a repo with no gate.json gets no offers", () => {
  const repo = makeRepo("ts-o14", { ".claude/gate.json": null, "package.json": JSON.stringify({ name: "n" }), "playwright.config.ts": "export default {};\n", "tests/a.test.ts": null, "src/a.ts": null, "src/app/page.tsx": null });
  assert.deepEqual(pendingOffers(repo), []);
  assert.equal(existsSync(path.join(repo, ".claude", "gate.json")), false);
});
