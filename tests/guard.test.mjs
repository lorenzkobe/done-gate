import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate } from "./helpers.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

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

test("the reviewer may write only its own review-<n>.md inside the open task's run dir, and nothing at all when no ledger is open", () => {
  // A helper's file belongs to the session's own task, so the rule needs a real open run dir.
  const open = makeRepo("guard-open", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: open, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  const opened = spawnSync(process.execPath, [gate, "open", "guard-open", "feature"], { encoding: "utf8", env });
  assert.equal(opened.status, 0, opened.stderr);
  const dir = path.join(open, ".claude", "gate", "runs", loadSession(path.join(open, ".claude", "gate"), "S1").current);
  const openInput = (tool, file_path, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path }, cwd: open, session_id: "S1", ...extra });

  // Which run dir is "the open task's" is resolved from the session, so this half goes
  // through `gate fence` — the hook entry point — rather than the in-process helper.
  const fence = (payload) => {
    const r = spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify(payload), encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const rv = { agent_id: "A2", agent_type: "done-gate:reviewer" };
  assert.equal(fence(openInput("Write", path.join(dir, "review-1.md"), rv)), false);
  assert.equal(fence(openInput("Write", path.join(dir, "review-2.md"), { ...rv, agent_type: "done-gate:reviewer-2" })), false);
  assert.equal(fence(openInput("Edit", `${open}/src/a.ts`, rv)), true);
  assert.equal(fence(openInput("Write", path.join(dir, "ledger.md"), rv)), true);
  // another task's run dir is not this reviewer's to write
  assert.equal(fence(openInput("Write", path.join(open, ".claude", "gate", "runs", "other", "review-1.md"), rv)), true);

  // the refused side: no ledger means no task, so there is no file the reviewer may write
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/review-1.md`, rv), repo, cfg).deny, true);
});

test("the skeptic may write only its own skeptic-<n>.md in the open task's run dir; unknown agents and the main session follow the evidence rule only", () => {
  assert.equal(decide(input("Write", `${repo}/notes.md`, { agent_id: "A3", agent_type: "done-gate:skeptic" }), repo, cfg).deny, true);
  // no ledger is open in this repo, so even a well-named skeptic file is refused
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/skeptic-1.md`, { agent_id: "A3", agent_type: "done-gate:skeptic" }), repo, cfg).deny, true);
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
