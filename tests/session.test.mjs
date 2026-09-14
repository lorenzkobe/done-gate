import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

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
  assert.ok(!/done-gate-status/.test(ctx));
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
  for (const k of ["read", "skeptic", "implement"]) run(repo, "step", "S1", {}, [k, "done", "x", "--evidence", "ledger.md"]);
  run(repo, "close", "S1");
  run(repo, "stop", "S1", { last_assistant_message: "report" });
  const r = run(repo, "report", "S1");
  assert.match(r.stdout, /^# p — plan — closed/m);
});
