// The session marker: verbs the model runs from its shell get no hook payload and no
// DONE_GATE_SESSION, so they must fall back to <stateDir>/current-session, which the
// SessionStart hook writes. Written from the requirements, blind to the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";

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
  // The permitted side: an ordinary source file is still silent (no decision emitted).
  assert.equal(fence(repo, "Write", path.join(repo, "src", "a.ts")).stdout.trim(), "");
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
