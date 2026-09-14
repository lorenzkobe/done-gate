import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function run(repo, verb, input, args = [], session = "S1") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input: JSON.stringify({ session_id: session, cwd: repo, hook_event_name: "Stop", stop_hook_active: false, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session },
  });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null };
}

const start = (repo, session = "S1") => run(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" }, [], session);
const stop = (repo, msg = "done.", session = "S1") => run(repo, "stop", { last_assistant_message: msg }, [], session);

test("a session that changed nothing is never blocked", () => {
  const repo = makeRepo("stop-noop");
  start(repo);
  assert.equal(stop(repo).json, null);
});

test("inside a subagent the gate stays out of the way", () => {
  const repo = makeRepo("stop-sub");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  assert.equal(run(repo, "stop", { agent_id: "A1", agent_type: "done-gate:qa", last_assistant_message: "x" }).json, null);
});

test("editing source with no ledger blocks with R1, even when the edit bypassed the Edit tool", () => {
  const repo = makeRepo("stop-r1");
  start(repo);
  write(repo, "src/a.ts", "changed by sed\n"); // no PostToolUse event was logged
  const out = stop(repo).json;
  assert.equal(out.decision, "block");
  assert.match(out.reason, /R1/);
  assert.match(out.reason, /gate open/);
});

test("a doc-only change with no ledger passes", () => {
  const repo = makeRepo("stop-docs");
  start(repo);
  write(repo, "docs/notes.md", "# changed\n");
  assert.equal(stop(repo).json, null);
});

test("with an open ledger, a PAUSED: last line lets the turn end and is recorded", () => {
  const repo = makeRepo("stop-pause");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  run(repo, "open", {}, ["task", "feature"]);
  const out = stop(repo, "Some progress.\n\nPAUSED: need the API key from you").json;
  assert.equal(out, null);
  const dir = path.join(repo, ".claude", "gate", "runs", readFileSync(path.join(repo, ".claude/gate/sessions/S1/state.json"), "utf8").match(/"current":"([^"]+)"/)[1]);
  assert.equal(loadLedger(dir).pauses.length, 1);
  assert.match(loadLedger(dir).pauses[0].text, /API key/);
});

test("with an open ledger and unmet rules, a plain 'done' message is blocked and the reason lists them", () => {
  const repo = makeRepo("stop-block");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  run(repo, "open", {}, ["task", "feature"]);
  const out = stop(repo).json;
  assert.equal(out.decision, "block");
  assert.match(out.reason, /R3/);
  assert.match(out.reason, /R7/);
});

test("six consecutive identical blocks fall open with a GATE OVERRIDDEN stamp; progress resets the counter", () => {
  const repo = makeRepo("stop-override");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  run(repo, "open", {}, ["task", "feature"]);
  for (let i = 0; i < 5; i++) assert.equal(stop(repo).json?.decision, "block");
  assert.equal(loadSession(path.join(repo, ".claude", "gate"), "S1").blocks.count, 5);
  write(repo, "tests/a.test.ts", "progress\n"); // R7 now met → unmet list differs → counter resets
  assert.equal(stop(repo).json?.decision, "block");
  assert.equal(loadSession(path.join(repo, ".claude", "gate"), "S1").blocks.count, 1);
  for (let i = 0; i < 4; i++) assert.equal(stop(repo).json?.decision, "block");
  const sixth = stop(repo).json;
  assert.equal(sixth, null);
  const current = loadSession(path.join(repo, ".claude", "gate"), "S1").current;
  const ledger = loadLedger(path.join(repo, ".claude", "gate", "runs", current));
  assert.ok(ledger.overridden, "override stamped on the ledger");
});

test("a corrupt ledger.json blocks once with the parse error, then falls open with a GATE ERROR stamp", () => {
  const repo = makeRepo("stop-corrupt");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  run(repo, "open", {}, ["task", "feature"]);
  const current = loadSession(path.join(repo, ".claude", "gate"), "S1").current;
  writeFileSync(path.join(repo, ".claude", "gate", "runs", current, "ledger.json"), "{ not json");
  const first = stop(repo).json;
  assert.equal(first.decision, "block");
  assert.match(first.reason, /ledger\.json/);
  const second = stop(repo).json;
  assert.equal(second, null);
  assert.match(readFileSync(path.join(repo, ".claude", "gate", "gate-error.log"), "utf8"), /ledger\.json/);
});

test("`gate check` prints the same unmet list without blocking anything", () => {
  const repo = makeRepo("stop-check");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  const r = run(repo, "check", {});
  assert.match(r.stdout, /R1/);
});
