// F3: a turn that ends, and a run that closes, name what the lead started in the background in this
// run that has not been reported ended or stopped. Advice only: nothing here ever blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, lookedUp, doneArgs } from "./helpers.mjs";
import { eventsFromHookInput } from "../scripts/lib/events.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function run(repo, verb, args = [], { input = {}, session = "S1" } = {}) {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session },
  });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null };
}
const hook = (repo, payload, session = "S1") => run(repo, "log", [], { input: payload, session });
const stop = (repo, message = "Waiting on you.\nPAUSED: is the layout right?", session = "S1") =>
  run(repo, "stop", [], { input: { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: message }, session }).json;
const background = (repo, command, response, { session = "S1", agent = null } = {}) =>
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command, run_in_background: true }, tool_response: response, ...(agent ? { agent_id: agent, agent_type: "done-gate:worker" } : {}) }, session);
const started = (id) => ({ stdout: "", stderr: "", backgroundTaskId: id });
const notified = (repo, id, status = "completed", summary = 'Background command "x" completed (exit code 0)') =>
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` });

function opened(name, playbook = "feature") {
  const repo = makeRepo(name);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  run(repo, "session-start", [], { input: { hook_event_name: "SessionStart", session_start_source: "startup" } });
  run(repo, "open", ["t", playbook]);
  return repo;
}

// a plan run with every step closed; before() runs just ahead of `gate close`, whose output it returns
function closePlanRun(repo, before) {
  lookedUp(repo);
  run(repo, "note", ["task", "Write the spec. [inferred]"]);
  run(repo, "note", ["context", "Traced: src/a.ts:1 is the entry, read by src/app/page.tsx:1.\nRelated: tests/a.test.ts pins it.\nResearch: none needed: a local change."]);
  run(repo, "note", ["plan", "One document."]);
  run(repo, "case", ["add", "spec covers the refused side", "--kind", "refused"]);
  run(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:refused"]);
  const keys = run(repo, "steps").stdout.split("\n").map((l) => /\{([a-z0-9-]+)\}/.exec(l)?.[1]).filter((k) => k && k !== "close" && k !== "context");
  if (keys.includes("skeptic")) {
    writeFileSync(path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current, "skeptic-1.md"), "# Skeptic 1\n\n## Act on\n- none\n");
    run(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  }
  for (const key of keys) run(repo, "step", doneArgs(repo, key, key, `did ${key}`, "docs/notes.md"));
  before();
  return run(repo, "close").stdout;
}

test("F3 C1 happy: a background command with no end reported is named with its minutes when the turn ends, with the wake sentence", () => {
  const repo = opened("bg-c1");
  background(repo, "npm run dev -- --port 3000", started("b1"));
  const out = stop(repo);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /may still be running in the background[^\n]*`npm run dev -- --port 3000` \(\d+ min\)/);
  assert.match(out.systemMessage, /wakes when one ends/);
  assert.match(out.systemMessage, /dev server/);
});

test("F3 C2 happy: a command its notification ended, or one stopped with TaskStop or KillShell, is not named", () => {
  const repo = opened("bg-c2");
  background(repo, "npm test", started("b1"));
  notified(repo, "b1");
  background(repo, "npm run dev", started("b2"));
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "b2" }, tool_response: {} });
  background(repo, "npm run watch", started("b3"));
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "KillShell", tool_input: { shell_id: "b3" }, tool_response: {} });
  assert.equal(stop(repo), null);
  background(repo, "sleep 999", started("b4"));
  notified(repo, "b4", "killed", 'Background command "sleep" was stopped');
  assert.equal(stop(repo), null);
});

test("F3 C3 edge: nothing running, a helper's background command, one from before the run or from another session: no line", () => {
  const before = makeRepo("bg-c3");
  execFileSync("git", ["add", "-A"], { cwd: before });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: before });
  run(before, "session-start", [], { input: { hook_event_name: "SessionStart", session_start_source: "startup" } });
  background(before, "npm run dev", started("b0"));
  run(before, "open", ["t", "feature"]);
  assert.equal(stop(before), null);

  const repo = opened("bg-c3b");
  background(repo, "npm run dev", started("b1"), { agent: "A1" });
  run(repo, "session-start", [], { input: { hook_event_name: "SessionStart", session_start_source: "startup" }, session: "S2" });
  background(repo, "npm run dev", started("b2"), { session: "S2" });
  assert.equal(stop(repo), null);
});

test("F3 C4 refused: a blocked turn keeps its own reason; the line never blocks", () => {
  const repo = opened("bg-c4");
  background(repo, "npm run dev", started("b1"));
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
  const out = stop(repo, "done.");
  assert.equal(out.decision, "block");
  assert.doesNotMatch(out.reason, /npm run dev/);
  assert.equal(out.systemMessage, "done-gate blocked the stop; see reason.");
});

test("F3 C5 reported-surface: gate close prints the line and the report's For you holds it", () => {
  const repo = opened("bg-c5", "plan");
  const closed = closePlanRun(repo, () => background(repo, "npm run dev", started("b1")));
  assert.match(closed, /t closed/);
  assert.match(closed, /may still be running in the background[^\n]*`npm run dev`/);
  const dir = path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").lastClosed);
  assert.match(run(repo, "report", ["--brief", "--run", path.basename(dir).replace(/^\d{4}-\d{2}-\d{2}-/, "")]).stdout, /For you:[^\n]*may still be running[^\n]*npm run dev/);
});

test("F3 C6 edge: the task id comes from backgroundTaskId, else the stdout line; with neither the command is not named", () => {
  const ev = (response) => eventsFromHookInput({ hook_event_name: "PostToolUse", session_id: "S1", tool_name: "Bash", tool_input: { command: "npm run dev", run_in_background: true }, tool_response: response }, "/repo")[0];
  assert.equal(ev(started("b1")).task, "b1");
  assert.equal(ev({ stdout: "Command running in background with ID: bk4wm3wc3. Output is being written to: /tmp/x.output" }).task, "bk4wm3wc3");
  assert.equal(ev({ stdout: "" }).task, undefined);
  const repo = opened("bg-c6");
  background(repo, "npm run dev", { stdout: "" });
  assert.equal(stop(repo), null);
});

test("F3 C7 edge: a helper's task-notification keeps its notice and also ends that id", () => {
  const ev = eventsFromHookInput({ hook_event_name: "UserPromptSubmit", session_id: "S1", prompt: '<task-notification>\n<task-id>a8964</task-id>\n<status>completed</status>\n<summary>Agent "Review" finished</summary>\n</task-notification>' }, "/repo")[0];
  assert.deepEqual(ev.notice, { agent: "a8964", status: "completed", cause: "finished" });
  assert.deepEqual(ev.ended, { task: "a8964", status: "completed" });
});

test("F3 C8 edge: TaskStop, KillShell and KillBash reach gate log through the PostToolUse matcher", () => {
  const hooks = JSON.parse(readFileSync(path.join(path.dirname(gate), "..", "hooks", "hooks.json"), "utf8"));
  const matcher = new RegExp(`^(?:${hooks.hooks.PostToolUse.find((h) => h.hooks.some((x) => / log"?$/.test(x.command))).matcher})$`);
  for (const tool of ["TaskStop", "KillShell", "KillBash"]) assert.ok(matcher.test(tool), tool);
});

test("F3 C9 edge: a server killed with pkill sends no notice, so it is named as may still be running on every quiet turn end", () => {
  const repo = opened("bg-c9");
  background(repo, "npm run dev", started("b1"));
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pkill -f 'next dev'" }, tool_response: { stdout: "" } });
  assert.match(stop(repo).systemMessage, /may still be running[^\n]*`npm run dev`/);
  assert.match(stop(repo).systemMessage, /may still be running[^\n]*`npm run dev`/);
});

test("F3 C10 edge: a command from before the session's last resume is not named; one from before a compact still is", () => {
  const repo = opened("bg-c10");
  background(repo, "npm run dev", started("b1"));
  run(repo, "session-start", [], { input: { hook_event_name: "SessionStart", source: "compact" } });
  assert.match(stop(repo).systemMessage, /`npm run dev`/);
  run(repo, "session-start", [], { input: { hook_event_name: "SessionStart", source: "resume" } });
  assert.equal(stop(repo), null);
});

test("F3 C11 idempotent: the report's For you shows the list saved at close, the same on a later rebuild", () => {
  const repo = opened("bg-c11", "plan");
  closePlanRun(repo, () => background(repo, "npm run dev", started("b1")));
  const slug = ["--run", "t"];
  const first = /For you:[^\n]*/.exec(run(repo, "report", ["--brief", ...slug]).stdout)[0];
  notified(repo, "b1");
  assert.equal(/For you:[^\n]*/.exec(run(repo, "report", ["--brief", ...slug]).stdout)[0], first);
  assert.match(first, /npm run dev/);
});

test("F3 C12 edge: a notice matched by its tool-use id ends the command even when its task id differs", () => {
  const repo = opened("bg-c12");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_9", tool_input: { command: "npm test", run_in_background: true }, tool_response: started("b1") });
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>other</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>failed</status>\n<summary>Background command \"npm test\" failed with exit code 143</summary>\n</task-notification>" });
  assert.equal(stop(repo), null);
});
