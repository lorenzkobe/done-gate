import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// stop-sees-helpers: the Stop hook must see every running agent, log every block, and a
// stale ledger must be abandonable. Cases C1–C10 of the task's case table.

const envFor = (repo, session) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session });
const REFUSAL = /^done-gate: /m;

function run(repo, verb, args = [], { input = "", session = "S1" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: envFor(repo, session) });
}
function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}
function refused(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}${r.stderr}`);
  return r.stderr;
}
function hook(repo, verb, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, verb], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null;
}
const logHook = (repo, payload, session = "S1") => hook(repo, "log", payload, session);
const stopHook = (repo, message = "done.", session = "S1") =>
  hook(repo, "stop", { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: message }, session);
const sessionStart = (repo, session = "S1") =>
  hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" }, session);

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const eventsOf = (repo, session = "S1") =>
  readFileSync(path.join(stateDir(repo), "sessions", session, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function committed(name) {
  const repo = makeRepo(name);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}

// An open feature ledger with unmet rules, so a plain stop blocks unless a helper is running.
function blocked(name) {
  const repo = committed(name);
  sessionStart(repo);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "See the helpers. [inferred]"]);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "the turn ends while a helper runs", "--kind", "happy"]);
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
  assert.equal(stopHook(repo)?.decision, "block", "fixture: the turn should block with no helper running");
  return repo;
}

const prompt = (repo, text) => logHook(repo, { hook_event_name: "UserPromptSubmit", user_message: text });
const start = (repo, id, type) => logHook(repo, { hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
const stop = (repo, id, type) => logHook(repo, { hook_event_name: "SubagentStop", agent_id: id, agent_type: type, stop_hook_active: false });

const HANDBACK = '<agent-message from="a10a0819723a58f5c"> [Subagent hand-back] The text below is the final report of a subagent';
const NOTIFICATION = "<task-notification> <task-id>a10a0819723a58f5c</task-id> <status>completed</status>";

// ---------------------------------------------------------------------------
// C1 reported-surface — two helpers in parallel; the first hands back; the second still counts
// ---------------------------------------------------------------------------

test("C1 reported-surface: after one of two parallel helpers hands back, the Stop hook still ends the turn silently for the other, without finalising", () => {
  const repo = blocked("ssh-c1-parallel");
  prompt(repo, "fix it please");
  start(repo, "A1", "done-gate:qa");
  start(repo, "A2", "done-gate:skeptic");
  // the skeptic hands back: its report arrives as a UserPromptSubmit, then its stop event
  prompt(repo, HANDBACK);
  stop(repo, "A2", "done-gate:skeptic");

  assert.equal(stopHook(repo), null, "the turn was blocked while QA was still running");
  assert.equal(loadLedger(runDir(repo)).status, "open");
  assert.ok(loadSession(stateDir(repo), "S1").current, "the session's run was cleared");

  // QA stops: the normal rules apply again
  stop(repo, "A1", "done-gate:qa");
  assert.equal(stopHook(repo)?.decision, "block", "the turn was let go after every helper stopped");
});

// ---------------------------------------------------------------------------
// C2 happy — a task-notification is a hand-back too
// ---------------------------------------------------------------------------

test("C2 happy: a <task-notification> prompt does not hide a running helper", () => {
  const repo = blocked("ssh-c2-notification");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:reviewer");
  start(repo, "A2", "done-gate:reviewer-2");
  prompt(repo, HANDBACK);
  stop(repo, "A1", "done-gate:reviewer");
  prompt(repo, NOTIFICATION);
  assert.equal(stopHook(repo), null, "the turn was blocked while reviewer-2 was still running");
  const events = eventsOf(repo);
  const handbacks = events.filter((e) => e.kind === "prompt" && e.handback === true);
  assert.equal(handbacks.length, 2, "both hand-back prompts are tagged");
  assert.ok(events.some((e) => e.kind === "prompt" && e.text === "go" && !e.handback), "a real prompt is not tagged");
});

// ---------------------------------------------------------------------------
// C3 refused — a real user prompt still resets
// ---------------------------------------------------------------------------

test("C3 refused: a helper started before the newest real user prompt does not make the turn end legal", () => {
  const repo = blocked("ssh-c3-real-prompt");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:qa");
  prompt(repo, "forget that, new turn");
  assert.equal(stopHook(repo)?.decision, "block", "a helper from before the newest prompt bought a quiet stop");
});

// ---------------------------------------------------------------------------
// C4 happy — any running agent counts, not only done-gate roles
// ---------------------------------------------------------------------------

test("C4 happy: a running Explore, Plan or general-purpose agent makes the turn end legal", () => {
  const repo = blocked("ssh-c4-any-agent");
  for (const type of ["Explore", "Plan", "general-purpose"]) {
    prompt(repo, `look around with ${type}`);
    start(repo, `X-${type}`, type);
    assert.equal(stopHook(repo), null, `the turn was blocked while a ${type} agent was running`);
    stop(repo, `X-${type}`, type);
    assert.equal(stopHook(repo)?.decision, "block", `the turn was let go after the ${type} agent stopped`);
  }
});

// ---------------------------------------------------------------------------
// C5 boundary — a start older than 45 minutes is ignored
// ---------------------------------------------------------------------------

test("C5 boundary: a start older than 45 minutes with no stop cannot hold the turn open", () => {
  const repo = blocked("ssh-c5-stale-start");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:qa");
  // age the start event by 46 minutes in the session log
  const file = path.join(stateDir(repo), "sessions", "S1", "events.jsonl");
  const aged = eventsOf(repo).map((e) => (e.kind === "subagent-start" ? { ...e, ts: new Date(Date.now() - 46 * 60 * 1000).toISOString() } : e));
  writeFileSync(file, aged.map((e) => `${JSON.stringify(e)}\n`).join(""));
  assert.equal(stopHook(repo)?.decision, "block", "a 46-minute-old start held the turn open");
});

// ---------------------------------------------------------------------------
// C6 happy — every block is logged and the report counts them
// ---------------------------------------------------------------------------

test("C6 happy: every Stop block appends a block event with the rule ids, and the report's attention list counts them", () => {
  const repo = blocked("ssh-c6-block-event"); // one block already happened in the fixture
  assert.equal(stopHook(repo)?.decision, "block");
  const blocks = eventsOf(repo).filter((e) => e.kind === "block");
  assert.equal(blocks.length, 2, "two blocks, two events");
  assert.ok(Array.isArray(blocks[0].rules) && blocks[0].rules.includes("R3"), `rules recorded: ${JSON.stringify(blocks[0])}`);
  assert.equal(blocks[0].session, "S1");
  const report = cli(repo, "report").stdout;
  assert.match(report, /the gate blocked the turn 2 times/);
});

// ---------------------------------------------------------------------------
// C7 happy — gate abandon
// ---------------------------------------------------------------------------

test("C7 happy: gate abandon <slug> \"<reason>\" marks the ledger abandoned; check, session-start and open then ignore it; the report says why", () => {
  const repo = blocked("ssh-c7-abandon");
  const dir = runDir(repo);
  const r = cli(repo, "abandon", ["ssh-c7-abandon", "the probe is over"]);
  assert.match(r.stdout, /abandoned/);
  const ledger = loadLedger(dir);
  assert.equal(ledger.status, "abandoned");
  assert.equal(ledger.abandonReason, "the probe is over");
  assert.ok(ledger.abandonedAt);
  assert.equal(loadSession(stateDir(repo), "S1").current, null, "the session still points at the abandoned run");

  // the source change is still there, so the gate says R1 (no ledger) rather than the old unmet list
  const check = cli(repo, "check").stdout;
  assert.match(check, /R1/);
  assert.doesNotMatch(check, /R3|R5|R7/);

  // a fresh session does not attach to it
  const ctx = sessionStart(repo, "S2").hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /Open ledger/);
  assert.equal(loadSession(stateDir(repo), "S2").current, null);

  // the abandoned run's report names the reason
  const report = cli(repo, "report", ["--run", "ssh-c7-abandon"]).stdout;
  assert.match(report, /abandoned/);
  assert.match(report, /the probe is over/);

  // gate open with the same slug starts a new run instead of re-attaching the abandoned one
  cli(repo, "open", ["ssh-c7-abandon", "feature"]);
  assert.notEqual(runDir(repo), dir, "open re-attached the abandoned run");
});

// ---------------------------------------------------------------------------
// C8 refused — abandon needs a reason and a live ledger
// ---------------------------------------------------------------------------

test("C8 refused: gate abandon with no reason, an unknown slug, or a closed ledger is refused with a usage message", () => {
  const repo = blocked("ssh-c8-abandon-refused");
  assert.match(refused(repo, "abandon", ["ssh-c8-abandon-refused"]), /usage: gate abandon/);
  assert.match(refused(repo, "abandon", ["no-such-run", "why"]), /no open run/);
  assert.equal(loadLedger(runDir(repo)).status, "open", "a refused abandon changed the ledger");
  // a closed ledger cannot be abandoned
  const dir = runDir(repo);
  const ledger = loadLedger(dir);
  ledger.status = "closed";
  writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(ledger));
  assert.match(refused(repo, "abandon", ["ssh-c8-abandon-refused", "why"]), /no open run/);
});

// ---------------------------------------------------------------------------
// C9 happy — session-start says when the ledger it attached came from another session
// ---------------------------------------------------------------------------

test("C9 happy: a session that inherits a ledger opened by another session is told so and given the abandon hint", () => {
  const repo = blocked("ssh-c9-inherited");
  const ctx = sessionStart(repo, "S2").hookSpecificOutput.additionalContext;
  assert.match(ctx, /Open ledger/);
  assert.match(ctx, /opened by another session/);
  assert.match(ctx, /gate abandon ssh-c9-inherited/);
  // the session that opened it is not told that
  const own = sessionStart(repo, "S1").hookSpecificOutput.additionalContext;
  assert.doesNotMatch(own, /opened by another session/);
});

// ---------------------------------------------------------------------------
// C10 idempotent — abandoning twice
// ---------------------------------------------------------------------------

test("C10 idempotent: abandoning an already abandoned ledger is refused and changes nothing", () => {
  const repo = blocked("ssh-c10-twice");
  const dir = runDir(repo);
  cli(repo, "abandon", ["ssh-c10-twice", "first"]);
  const before = readFileSync(path.join(dir, "ledger.json"), "utf8");
  refused(repo, "abandon", ["ssh-c10-twice", "second"]);
  assert.equal(readFileSync(path.join(dir, "ledger.json"), "utf8"), before);
  assert.equal(loadLedger(dir).abandonReason, "first");
});
