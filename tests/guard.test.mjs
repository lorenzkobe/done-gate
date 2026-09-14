import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate } from "./helpers.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

const repo = makeRepo("guard", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
const cfg = loadConfig(repo);
const input = (tool, file_path, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path }, cwd: repo, session_id: "S1", ...extra });

test("evidence files under the run dir are denied for everyone, ledger.md stays writable", () => {
  for (const f of ["events.jsonl", "verify.json", "decisions.tsv", "ledger.json", "blocks.json"]) {
    assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/${f}`), repo, cfg).deny, true, f);
  }
  assert.equal(decide(input("Edit", `${repo}/.claude/gate/sessions/S1/state.json`), repo, cfg).deny, true);
  assert.equal(decide(input("Edit", `${repo}/.claude/gate/runs/x/ledger.md`), repo, cfg).deny, false);
});

test("a Bash command that names an evidence file is denied; ordinary commands pass", () => {
  const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1" });
  assert.equal(decide(bash("echo x >> .claude/gate/runs/x/events.jsonl"), repo, cfg).deny, true);
  assert.equal(decide(bash("cat .claude/gate/runs/x/verify.json"), repo, cfg).deny, true);
  assert.equal(decide(bash("npm test"), repo, cfg).deny, false);
  assert.equal(decide(bash("node gate.mjs verify"), repo, cfg).deny, false);
});

test("the QA agent may write only under the tests globs", () => {
  const qa = { agent_id: "A1", agent_type: "done-gate:qa" };
  assert.equal(decide(input("Write", `${repo}/tests/new.test.ts`, qa), repo, cfg).deny, false);
  assert.equal(decide(input("Edit", `${repo}/src/a.ts`, qa), repo, cfg).deny, true);
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/ledger.md`, qa), repo, cfg).deny, true);
});

test("the reviewer may write only its own review-<n>.md inside a run dir", () => {
  const rv = { agent_id: "A2", agent_type: "done-gate:reviewer" };
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/review-1.md`, rv), repo, cfg).deny, false);
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/review-2.md`, { ...rv, agent_type: "done-gate:reviewer-2" }), repo, cfg).deny, false);
  assert.equal(decide(input("Edit", `${repo}/src/a.ts`, rv), repo, cfg).deny, true);
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/ledger.md`, rv), repo, cfg).deny, true);
});

test("the skeptic may not write at all; unknown agents and the main session follow the evidence rule only", () => {
  assert.equal(decide(input("Write", `${repo}/notes.md`, { agent_id: "A3", agent_type: "done-gate:skeptic" }), repo, cfg).deny, true);
  assert.equal(decide(input("Write", `${repo}/src/a.ts`, { agent_id: "A4", agent_type: "general-purpose" }), repo, cfg).deny, false);
  assert.equal(decide(input("Write", `${repo}/src/a.ts`), repo, cfg).deny, false);
});

test("`gate fence` emits the PreToolUse deny envelope and logs the attempt; allows are silent", () => {
  const run = (payload) => spawnSync(process.execPath, [gate, "fence"], {
    input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
  const denied = run(input("Write", `${repo}/.claude/gate/runs/x/verify.json`));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /evidence/);
  const events = readFileSync(path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl"), "utf8");
  assert.match(events, /"kind":"deny"/);
  const allowed = run(input("Write", `${repo}/src/a.ts`));
  assert.equal(allowed.stdout.trim(), "");
});
