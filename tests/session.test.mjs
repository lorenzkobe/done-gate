import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { makeRepo, write, gate, lookedUp, pluginRoot, AT_GIT_TOPLEVEL } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadLedger } from "../scripts/lib/ledger.mjs";

// ===== from tests/session.test.mjs =====
{
function run(repo, verb, session, input = {}, args = []) {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session },
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const start = (repo, session, source = "startup") => run(repo, "session-start", session, { hook_event_name: "SessionStart", session_start_source: source });

test("a fresh session with no ledgers gets the mandate only", () => {
  const repo = makeRepo("session-fresh");
  const out = JSON.parse(start(repo, "S1").stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctx, /You have done-gate/);
  // the in-place warning is about where the plugin runs from (this checkout), not about ledgers
  const ledgerStatus = ctx.replace(/<done-gate-status>\ndone-gate runs in place[\s\S]*?<\/done-gate-status>/, "");
  assert.ok(!/done-gate-status/.test(ledgerStatus));
});

test("after /clear, the new session auto-attaches to the open ledger and is told what is unmet", () => {
  const repo = makeRepo("session-clear");
  start(repo, "S1");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  write(repo, "src/a.ts", "changed\n");
  const out = JSON.parse(start(repo, "S2", "clear").stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /<done-gate-status>/);
  assert.match(ctx, /badge/);
  assert.match(ctx, /unmet/);
  assert.match(loadSession(path.join(repo, ".claude", "gate"), "S2").current, /badge/);
});

test("a subagent session gets nothing", () => {
  const repo = makeRepo("session-sub");
  const r = run(repo, "session-start", "S1", { hook_event_name: "SessionStart", agent_id: "A1", agent_type: "done-gate:qa" });
  assert.equal(r.stdout.trim(), "");
});

test("doctor prints version, resolved config and state without throwing", () => {
  const repo = makeRepo("session-doctor");
  const r = run(repo, "doctor", "S1");
  assert.match(r.stdout, /done-gate \d+\.\d+\.\d+/);
  assert.match(r.stdout, /verify:/);
  assert.match(r.stdout, /npm run lint/);
  assert.match(r.stdout, /driver: none/);
  assert.match(r.stdout, /ledger: none/);
});

test("report still renders the ledger that just closed", () => {
  const repo = makeRepo("session-report-closed");
  start(repo, "S1");
  run(repo, "open", "S1", {}, ["p", "plan"]);
  run(repo, "note", "S1", {}, ["task", "t"]);
  run(repo, "note", "S1", {}, ["plan", "p"]);
  write(path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current), "skeptic-1.md", "# Skeptic 1\n\n## Act on\n- none\n");
  run(repo, "huddle", "S1", {}, ["add", "skeptic", "--file", "skeptic-1.md"]);
  // only gate note context closes {context} on a stamped ledger, after the lead's lookups
  lookedUp(repo);
  run(repo, "note", "S1", {}, ["context", "Traced: src/a.ts:1 exports a0\nRelated: tests/a.test.ts pins a\nResearch: none needed: a fixture"]);
  for (const k of ["skeptic", "implement"]) run(repo, "step", "S1", {}, [k, "done", "x", "--evidence", "ledger.md"]);
  run(repo, "close", "S1");
  run(repo, "stop", "S1", { last_assistant_message: "report" });
  const r = run(repo, "report", "S1");
  assert.match(r.stdout, /^# p — plan — closed/m);
});

test("a run an older plugin left closing is closed late at session start, gets a report, and is never attached", () => {
  const repo = makeRepo("session-closing-legacy");
  start(repo, "S1");
  run(repo, "open", "S1", {}, ["old", "plan"]);
  const dir = path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
  const ledger = loadLedger(dir);
  ledger.status = "closing";
  writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(ledger));
  const ctx = JSON.parse(start(repo, "S2").stdout).hookSpecificOutput.additionalContext;
  assert.ok(!/Open ledger/.test(ctx), `the closing run was attached:\n${ctx}`);
  const closed = loadLedger(dir);
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedLate, true);
  assert.match(readFileSync(path.join(dir, "report.md"), "utf8"), /Closed late/);
  assert.equal(loadSession(path.join(repo, ".claude", "gate"), "S2").current, null);
});
}

// ===== from tests/session-marker.test.mjs =====
{
// The session marker: verbs the model runs from its shell get no hook payload and no
// DONE_GATE_SESSION, so they must fall back to <stateDir>/current-session, which the
// SessionStart hook writes. Written from the requirements, blind to the implementation.

// stateDir and the "no-session" directory name are the product's, not this test's:
// scripts/lib/context.mjs stateDir default and scripts/lib/events.mjs sessionDir().
const stateDirOf = (repo) => path.join(repo, ".claude", "gate");
const markerOf = (repo) => path.join(stateDirOf(repo), "current-session");
const sessionsOf = (repo) => path.join(stateDirOf(repo), "sessions");

// Every id source is set or deleted explicitly: the runner's own env carries a real
// CLAUDE_CODE_SESSION_ID, which would otherwise resolve these spawns for the wrong reason.
// `session`/`codeSession` omitted → that variable is deleted (the model's own shell).
function envFor(repo, session, codeSession) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo };
  delete env.DONE_GATE_STATE_DIR;
  if (session === undefined) delete env.DONE_GATE_SESSION;
  else env.DONE_GATE_SESSION = session;
  if (codeSession === undefined) delete env.CLAUDE_CODE_SESSION_ID;
  else env.CLAUDE_CODE_SESSION_ID = codeSession;
  return env;
}

// Non-hook verbs hang on an open stdin pipe, so always hand them a closed one.
function shell(repo, args, session, codeSession) {
  return spawnSync(process.execPath, [gate, ...args], {
    input: "",
    encoding: "utf8",
    env: envFor(repo, session, codeSession),
  });
}

function hook(repo, verb, payload) {
  return spawnSync(process.execPath, [gate, verb], {
    input: JSON.stringify({ cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo), // hook verbs get their id from the payload, never from the env
  });
}

const sessionStart = (repo, session, source = "startup") =>
  hook(repo, "session-start", { session_id: session, hook_event_name: "SessionStart", session_start_source: source });

const fence = (repo, tool, filePath) =>
  hook(repo, "fence", {
    session_id: "S1",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: filePath },
  });

const bash = (repo, command) =>
  hook(repo, "fence", {
    session_id: "S1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });

test("C1 reported-surface: a shell verb with no session env writes under the SessionStart id, not no-session", () => {
  const repo = makeRepo("marker-c1");
  const start = sessionStart(repo, "S9");
  assert.equal(start.status, 0, start.stderr);

  const opened = shell(repo, ["open", "t", "feature"]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /^ledger: /m, opened.stderr);

  const state = loadSession(stateDirOf(repo), "S9");
  assert.ok(state, "sessions/S9/state.json should exist");
  assert.match(state.current, /-t$/);
  assert.equal(readFileSync(markerOf(repo), "utf8").trim(), "S9");
  assert.ok(existsSync(path.join(stateDirOf(repo), "runs", state.current, "ledger.json")));
  assert.deepEqual(loadLedger(path.join(stateDirOf(repo), "runs", state.current)).sessions, ["S9"]);
  assert.equal(existsSync(path.join(sessionsOf(repo), "no-session")), false, "no sessions/no-session dir");
});

test("C2 happy: a non-empty DONE_GATE_SESSION beats the marker", () => {
  const repo = makeRepo("marker-c2");
  sessionStart(repo, "S9");

  const opened = shell(repo, ["open", "t", "feature"], "SENV");
  assert.equal(opened.status, 0, opened.stderr);

  const fromEnv = loadSession(stateDirOf(repo), "SENV");
  assert.ok(fromEnv, "sessions/SENV/state.json should exist");
  assert.match(fromEnv.current, /-t$/);
  assert.equal(loadSession(stateDirOf(repo), "S9").current, null, "the marker's session stays untouched");
  assert.deepEqual(loadLedger(path.join(stateDirOf(repo), "runs", fromEnv.current)).sessions, ["SENV"]);
});

test("C3 boundary: an empty-string DONE_GATE_SESSION counts as unset, so the marker wins", () => {
  const repo = makeRepo("marker-c3");
  sessionStart(repo, "S9");

  const opened = shell(repo, ["open", "t", "feature"], "");
  assert.equal(opened.status, 0, opened.stderr);

  const state = loadSession(stateDirOf(repo), "S9");
  assert.ok(state, "sessions/S9/state.json should exist");
  assert.match(state.current, /-t$/);
  assert.deepEqual(readdirSync(sessionsOf(repo)).sort(), ["S9"], "no no-session and no empty-named dir");
});

test("C4 boundary: no marker and no env still resolves to no-session without crashing", () => {
  const repo = makeRepo("marker-c4");
  assert.equal(existsSync(markerOf(repo)), false, "no SessionStart ran, so no marker");

  const opened = shell(repo, ["open", "t", "feature"]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /^ledger: /m, opened.stderr);

  const state = loadSession(stateDirOf(repo), null);
  assert.ok(existsSync(path.join(sessionsOf(repo), "no-session", "state.json")));
  assert.match(state.current, /-t$/);
  assert.deepEqual(loadLedger(path.join(stateDirOf(repo), "runs", state.current)).sessions, [null]);
});

test("C5 refused: the fence denies Edit and Write to .claude/gate/current-session", () => {
  const repo = makeRepo("marker-c5");
  sessionStart(repo, "S1");

  for (const tool of ["Write", "Edit"]) {
    const r = fence(repo, tool, markerOf(repo));
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", `${tool} to the marker`);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /evidence/);
  }
  // The permitted side: an ordinary docs file is still silent (no decision emitted); code waits for a planned run.
  assert.equal(fence(repo, "Write", path.join(repo, "docs", "notes.md")).stdout.trim(), "");
});

test("C7 refused: the fence denies a Bash command that writes to .claude/gate/current-session", () => {
  const repo = makeRepo("marker-c7");
  sessionStart(repo, "S1");

  for (const command of ["echo S1 > .claude/gate/current-session", "rm .claude/gate/current-session"]) {
    const r = bash(repo, command);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /evidence/);
  }
  // The permitted side: a command that does not name an evidence file is still silent.
  assert.equal(bash(repo, "npm test").stdout.trim(), "");
});

test("C8 happy: CLAUDE_CODE_SESSION_ID beats the marker and loses to DONE_GATE_SESSION", () => {
  const marked = makeRepo("marker-c8-env");
  sessionStart(marked, "S9");
  const overMarker = shell(marked, ["open", "t", "feature"], undefined, "S7");
  assert.equal(overMarker.status, 0, overMarker.stderr);
  const s7 = loadSession(stateDirOf(marked), "S7");
  assert.ok(s7, "sessions/S7/state.json should exist");
  assert.match(s7.current, /-t$/);
  assert.equal(loadSession(stateDirOf(marked), "S9").current, null, "the marker's session stays untouched");
  assert.deepEqual(readdirSync(sessionsOf(marked)).sort(), ["S7", "S9"]);

  const both = makeRepo("marker-c8-gate");
  sessionStart(both, "S9");
  const overBoth = shell(both, ["open", "t", "feature"], "S5", "S7");
  assert.equal(overBoth.status, 0, overBoth.stderr);
  const s5 = loadSession(stateDirOf(both), "S5");
  assert.ok(s5, "sessions/S5/state.json should exist");
  assert.match(s5.current, /-t$/);
  assert.equal(loadSession(stateDirOf(both), "S7"), null, "CLAUDE_CODE_SESSION_ID must not win over DONE_GATE_SESSION");
  assert.equal(loadSession(stateDirOf(both), "S9").current, null);
});
}

// in-place-warning
test("C1 reported-surface and C2 edge: session start warns when done-gate runs in place from a git checkout, not from an installed copy", { skip: !AT_GIT_TOPLEVEL && "needs this checkout's own .git" }, () => {
  const startFrom = (bin, name) => {
    const repo = makeRepo(name);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: repo };
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(process.execPath, [bin, "session-start"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" }), encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  };
  const here = startFrom(gate, "inplace-checkout");
  assert.match(here, new RegExp(`done-gate runs in place from ${pluginRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), here);
  const copy = path.join(os.tmpdir(), `dg-copy-${process.pid}`);
  rmSync(copy, { recursive: true, force: true });
  execFileSync("rsync", ["-a", "--exclude", ".git", "--exclude", "tests", "--exclude", ".claude", `${pluginRoot}/`, `${copy}/`]);
  try {
    assert.doesNotMatch(startFrom(path.join(copy, "scripts", "gate.mjs"), "inplace-copy"), /runs in place/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

// release-check: a newer done-gate release is told to the user before any work starts
test("C1 happy, C2 refused, C3 happy: a newer release is told at session start, gate open waits for an update or the user's OK", () => {
  const home = path.join(os.tmpdir(), `dg-home-release-${process.pid}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "done-gate-release.json"), JSON.stringify({ latest: "99.0.0", checkedAt: new Date().toISOString(), repo: "o/r" }));
  const repo = makeRepo("release-newer");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1", DONE_GATE_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const hook = (verb, payload) => spawnSync(process.execPath, [gate, verb], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env });
  const verb = (args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env });
  try {
    const ctx = JSON.parse(hook("session-start", { hook_event_name: "SessionStart", session_start_source: "startup" }).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /99\.0\.0/, ctx);
    assert.match(ctx, /claude plugin update done-gate@done-gate/, ctx);
    assert.match(ctx, /tell the user/i, ctx);

    const refused = verb(["open", "t", "feature"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /99\.0\.0/, refused.stderr);
    assert.match(refused.stderr, /--old-version-ok/, refused.stderr);

    assert.equal(verb(["open", "t", "feature", "--old-version-ok", "keep the old one"]).status, 1, "words the user did not say");
    hook("log", { hook_event_name: "UserPromptSubmit", prompt: "fine, keep the old one for today" });
    const opened = verb(["open", "t", "feature", "--old-version-ok", "keep the old one"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(verb(["open", "t", "feature"]).status, 0, "re-joining the open run is not a new task");
    assert.match(ctx, /\/reload-plugins/, "the notice names the reload");
    writeFileSync(path.join(home, ".claude", "done-gate-release.json"), JSON.stringify({ latest: JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version, checkedAt: new Date().toISOString() }));
    assert.equal(verb(["open", "u", "feature"]).status, 0, "running the latest: a new run opens");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("C4 edge: no newer release, or nothing saved and no github marketplace to ask: no notice, open works", () => {
  const home = path.join(os.tmpdir(), `dg-home-norelease-${process.pid}`);
  for (const saved of [{ latest: "0.0.1", checkedAt: new Date().toISOString() }, null]) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    if (saved) writeFileSync(path.join(home, ".claude", "done-gate-release.json"), JSON.stringify(saved));
    const repo = makeRepo("release-none");
    const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1", DONE_GATE_HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    const out = spawnSync(process.execPath, [gate, "session-start"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" }), encoding: "utf8", env });
    assert.doesNotMatch(out.stdout, /claude plugin update/, JSON.stringify(saved));
    assert.equal(spawnSync(process.execPath, [gate, "open", "t", "feature"], { encoding: "utf8", env }).status, 0, JSON.stringify(saved));
  }
  rmSync(home, { recursive: true, force: true });
});

test("C5 boundary: an answer older than 6 hours that cannot be refreshed (offline, no github marketplace) still stands; once the running version catches up the notice is gone", async () => {
  const { checkRelease, knownNewer } = await import("../scripts/lib/release.mjs");
  const home = path.join(os.tmpdir(), `dg-home-stale-${process.pid}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "done-gate-release.json"), JSON.stringify({ latest: "0.30.0", checkedAt: new Date(Date.now() - 7 * 3600e3).toISOString() }));
  const before = process.env.DONE_GATE_HOME;
  process.env.DONE_GATE_HOME = home;
  try {
    assert.equal(await checkRelease("0.19.0"), "0.30.0");
    assert.equal(await checkRelease("0.30.0"), null, "updated: nothing to tell");
    assert.equal(knownNewer("0.19.0"), "0.30.0");
    assert.equal(knownNewer("1.0.0"), null);
  } finally {
    process.env.DONE_GATE_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});

test("C5 boundary: a fresh answer is used without going online; an old one is refreshed and rewritten; a failed refresh waits its six hours too", async () => {
  const { checkRelease } = await import("../scripts/lib/release.mjs");
  const home = path.join(os.tmpdir(), `dg-home-fetch-${process.pid}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify({ "done-gate": { source: { source: "github", repo: "o/r" } } }));
  const saved = path.join(home, ".claude", "done-gate-release.json");
  const before = { home: process.env.DONE_GATE_HOME, fetch: globalThis.fetch };
  const calls = [];
  let answer = { ok: true, json: async () => ({ version: "0.40.0" }) };
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  process.env.DONE_GATE_HOME = home;
  try {
    const now = Date.now();
    writeFileSync(saved, JSON.stringify({ latest: "0.30.0", checkedAt: new Date(now - 3600e3).toISOString() }));
    assert.equal(await checkRelease("0.19.0", now), "0.30.0", "a fresh answer");
    assert.equal(calls.length, 0, "no network for a fresh answer");

    writeFileSync(saved, JSON.stringify({ latest: "0.30.0", checkedAt: new Date(now - 7 * 3600e3).toISOString() }));
    assert.equal(await checkRelease("0.19.0", now), "0.40.0", "an old answer is refreshed");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /raw\.githubusercontent\.com\/o\/r\/HEAD\/\.claude-plugin\/plugin\.json/);
    assert.equal(JSON.parse(readFileSync(saved, "utf8")).latest, "0.40.0", "and rewritten");

    answer = new Error("offline");
    const later = now + 7 * 3600e3;
    assert.equal(await checkRelease("0.19.0", later), "0.40.0", "offline: the saved answer stands");
    assert.equal(calls.length, 2);
    assert.equal(await checkRelease("0.19.0", later + 60e3), "0.40.0");
    assert.equal(calls.length, 2, "a failed try waits its six hours too");
  } finally {
    globalThis.fetch = before.fetch;
    process.env.DONE_GATE_HOME = before.home;
    rmSync(home, { recursive: true, force: true });
  }
});

test("C3 refused: --old-version-ok with no words is a usage error", () => {
  const repo = makeRepo("release-noargs");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [gate, "open", "t", "feature", "--old-version-ok"], { encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs the user's words/);
});
