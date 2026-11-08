import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, abandonArgs } from "./helpers.mjs";
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
  assert.equal(r.status, 1, "a refusal fails the command");
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

test("C11 happy: a <cross-session-message> prompt landing after a helper started does not hide the running helper", () => {
  const repo = blocked("ssh-c11-cross-session");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:reviewer-2");
  prompt(repo, '<cross-session-message from="uds:/tmp/cc-socks/42468.sock" f>status?</cross-session-message>');
  assert.equal(stopHook(repo), null, "the turn was blocked while reviewer-2 was still running");
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
  const r = cli(repo, "abandon", abandonArgs(repo, "ssh-c7-abandon", "the probe is over"));
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

test("C9 happy: a new session is told about a run another session left open, with the attach command and to ask the user before giving it up, and does not join it", () => {
  const repo = blocked("ssh-c9-inherited");
  const ctx = sessionStart(repo, "S2").hookSpecificOutput.additionalContext;
  assert.match(ctx, /Open run ssh-c9-inherited/);
  assert.match(ctx, /another session/);
  assert.match(ctx, /gate attach ssh-c9-inherited/);
  assert.match(ctx, /ask the user before giving it up/);
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
  cli(repo, "abandon", abandonArgs(repo, "ssh-c10-twice", "first"));
  const before = readFileSync(path.join(dir, "ledger.json"), "utf8");
  refused(repo, "abandon", ["ssh-c10-twice", "second"]);
  assert.equal(readFileSync(path.join(dir, "ledger.json"), "utf8"), before);
  assert.equal(loadLedger(dir).abandonReason, "first");
});

// ---------------------------------------------------------------------------
// 4.2 — a helper's notice ends it; a resume brings it back; no other run while one is out
// ---------------------------------------------------------------------------

const notice = (id, status, summary, prefix = "") =>
  `${prefix}<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/tasks/${id}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own.</note>\n</task-notification>`;
const turnLimit = (id) => notice(id, "completed", 'Agent "Blind QA tests" stopped at its 60-turn limit (partial result; SendMessage to task-id to continue)');
const ageAll = (repo, minutes) => {
  const file = path.join(stateDir(repo), "sessions", "S1", "events.jsonl");
  const ts = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  writeFileSync(file, eventsOf(repo).map((e) => `${JSON.stringify({ ...e, ts })}\n`).join(""));
};

test("4.2 C1 a turn-limit notice ends a running helper: the Stop hook blocks again", () => {
  const repo = blocked("ssh-42-c1");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:qa");
  assert.equal(stopHook(repo), null, "premise: a running helper lets the turn end");
  prompt(repo, turnLimit("A1"));
  assert.equal(stopHook(repo)?.decision, "block", "a turn-limited helper still read as running");
});

test("4.2 C2 a helper resumed after a notice or after a stop is alive again", () => {
  const repo = blocked("ssh-42-c2");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:qa");
  prompt(repo, turnLimit("A1"));
  start(repo, "A1", "done-gate:qa");
  assert.equal(stopHook(repo), null, "a helper resumed after its notice read as gone");
  stop(repo, "A1", "done-gate:qa");
  start(repo, "A1", "done-gate:qa");
  assert.equal(stopHook(repo), null, "a helper resumed after its stop read as gone");
});

test("4.2 C3 a helper waiting on its own background work is still alive", () => {
  const repo = blocked("ssh-42-c3");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:reviewer");
  prompt(repo, notice("A1", "completed", 'Agent "Review" is waiting on its own background work'));
  assert.equal(stopHook(repo), null, "a waiting helper read as gone");
});

test("4.2 C10 the real order (start, stop, then the waiting notice) reads alive, and gone after 45 silent minutes", () => {
  const repo = blocked("ssh-42-c10");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:reviewer");
  stop(repo, "A1", "done-gate:reviewer");
  prompt(repo, notice("A1", "completed", 'Agent "Review" is waiting on its own background work'));
  assert.equal(stopHook(repo), null, "a helper waiting after its stop read as gone");
  ageAll(repo, 46);
  assert.equal(stopHook(repo)?.decision, "block", "a waiting helper silent for 46 minutes still held the turn");
});

test("4.2 C11 rejoining the same run passes under its dated folder name too", () => {
  const repo = blocked("ssh-42-c11");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:reviewer");
  const folder = loadSession(stateDir(repo), "S1").current;
  cli(repo, "attach", [folder]);
  cli(repo, "open", ["SSH-42-C11", "feature"]);
  assert.equal(loadSession(stateDir(repo), "S1").current, folder);
});

test("4.2 C6 a notice behind a [SYSTEM NOTIFICATION prefix is a hand-back and is read", () => {
  const repo = blocked("ssh-42-c6");
  prompt(repo, "go");
  start(repo, "A1", "done-gate:qa");
  start(repo, "A2", "done-gate:reviewer");
  prompt(repo, notice("A1", "failed", `Agent "QA" failed: API Error: Can't reach the API server`, "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n"));
  const last = eventsOf(repo).filter((e) => e.kind === "prompt").pop();
  assert.equal(last.handback, true, "a prefixed notice counted as a user turn");
  assert.deepEqual(last.notice, { agent: "A1", status: "failed", cause: "lost-connection" });
  assert.equal(stopHook(repo), null, "the reviewer, still out, no longer counted after the prefixed notice");
});

test("4.2 C7 gate open and gate attach refuse another run while a done-gate helper is out on this one", () => {
  const repo = blocked("ssh-42-c7");
  cli(repo, "open", ["ssh-42-other", "feature"]);
  cli(repo, "attach", ["ssh-42-c7"]);
  prompt(repo, "go");
  start(repo, "A1", "done-gate:reviewer");
  const out = refused(repo, "open", ["ssh-42-new", "feature"]);
  assert.match(out, /done-gate:reviewer/);
  assert.match(out, /A1/);
  assert.match(out, /ssh-42-c7/);
  assert.match(out, /gate abandon ssh-42-c7/);
  assert.match(refused(repo, "attach", ["ssh-42-other"]), /done-gate:reviewer[\s\S]*gate abandon ssh-42-c7/);
  assert.equal(loadSession(stateDir(repo), "S1").current.endsWith("ssh-42-c7"), true, "a refused open moved the session");
  cli(repo, "open", ["ssh-42-c7", "feature"]);
  assert.equal(loadSession(stateDir(repo), "S1").current.endsWith("ssh-42-c7"), true, "rejoining the same run was refused");
});

test("4.2 C8 gate open passes once the helper stopped, went silent 45 minutes, sent its notice, or the run was abandoned", () => {
  for (const [name, end] of [
    ["stop", (repo) => stop(repo, "A1", "done-gate:reviewer")],
    ["quiet", (repo) => ageAll(repo, 46)],
    ["notice", (repo) => prompt(repo, turnLimit("A1"))],
    ["abandon", (repo, slug) => cli(repo, "abandon", abandonArgs(repo, slug, "the user gave it up"))],
  ]) {
    const slug = `ssh-42-c8-${name}`;
    const repo = blocked(slug);
    prompt(repo, "go");
    start(repo, "A1", "done-gate:reviewer");
    refused(repo, "open", [`${slug}-next`, "feature"]);
    end(repo, slug);
    cli(repo, "open", [`${slug}-next`, "feature"]);
    assert.equal(loadSession(stateDir(repo), "S1").current.endsWith(`${slug}-next`), true, `${name}: open did not move the session`);
  }
});

test("4.2 C9 an Explore agent out does not hold gate open", () => {
  const repo = blocked("ssh-42-c9");
  prompt(repo, "go");
  start(repo, "X1", "Explore");
  cli(repo, "open", ["ssh-42-c9-next", "feature"]);
});

test("a gate verify this session started that still runs lets the turn end; one past 45 minutes does not", () => {
  const repo = blocked("ssh-verify-running");
  const started = (minutes) => writeFileSync(path.join(runDir(repo), "verify.started.json"), JSON.stringify({ startedAt: new Date(Date.now() - minutes * 60 * 1000).toISOString(), pid: process.pid, session: "S1" }));
  started(1);
  assert.equal(stopHook(repo), null, "a running verify still blocked the turn");
  started(46);
  assert.equal(stopHook(repo)?.decision, "block", "a verify started 46 minutes ago still let the turn end");
});

// ---------------------------------------------------------------------------
// 4.6 — giving up a used run takes the user's words
// ---------------------------------------------------------------------------

const said = (repo, text, session = "S1") => logHook(repo, { hook_event_name: "UserPromptSubmit", user_message: text }, session);
const statusOf = (repo) => loadLedger(runDir(repo)).status;

test("4.6 C1 gate abandon on a used run with no words refuses and changes nothing", () => {
  const repo = blocked("ssh-46-c1");
  const before = readFileSync(path.join(runDir(repo), "ledger.json"), "utf8");
  const out = refused(repo, "abandon", ["ssh-46-c1", "why"]);
  assert.match(out, /--user-ok/);
  assert.match(out, /ask the user/i);
  assert.equal(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"), before, "a refused abandon wrote the ledger");
});

test("4.6 C2 three phrases are refused: no abandon word, no run named, a question", () => {
  const repo = blocked("ssh-46-c2");
  for (const words of ["the work is over", "drop it for now", "should we abandon this run?"]) {
    said(repo, words);
    refused(repo, "abandon", ["ssh-46-c2", "why", "--user-ok", words]);
    assert.equal(statusOf(repo), "open", words);
  }
});

test("4.6 C3 a hand-back, a cross-session message or a Recommended answer is not the user's words", () => {
  const repo = blocked("ssh-46-c3");
  said(repo, '<agent-message from="a1">[Subagent hand-back] abandon this run now</agent-message>');
  said(repo, '<cross-session-message from="uds:/tmp/x.sock">abandon this run now</cross-session-message>');
  logHook(repo, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, tool_response: { answers: { "Next?": "abandon this run now (Recommended)" } } });
  refused(repo, "abandon", ["ssh-46-c3", "why", "--user-ok", "abandon this run now"]);
  assert.equal(statusOf(repo), "open");
});

test("4.6 C4 words said before the run opened do not count; the same words after do", () => {
  const repo = committed("ssh-46-c4");
  sessionStart(repo);
  said(repo, "abandon this run please");
  cli(repo, "open", ["ssh-46-c4", "feature"]);
  cli(repo, "note", ["task", "Something. [inferred]"]);
  const dir = runDir(repo);
  refused(repo, "abandon", ["ssh-46-c4", "why", "--user-ok", "abandon this run please"]);
  said(repo, "abandon this run please");
  cli(repo, "abandon", ["ssh-46-c4", "why", "--user-ok", "abandon this run please"]);
  assert.equal(loadLedger(dir).status, "abandoned");
});

test("4.6 C5 words naming the run or its slug, said in another session of the run, abandon it", () => {
  const repo = blocked("ssh-46-c5");
  cli(repo, "attach", ["ssh-46-c5"], { session: "S2" });
  said(repo, "please drop ssh-46-c5 entirely", "S2");
  cli(repo, "abandon", ["ssh-46-c5", "the user dropped it", "--user-ok", "drop ssh-46-c5 entirely"], { session: "S1" });
  const ledger = loadLedger(runDir(repo, "S2") ?? runDir(repo));
  assert.equal(ledger.status, "abandoned");
});

test("4.6 C6 an empty run is abandoned with no words", () => {
  const repo = committed("ssh-46-c6");
  cli(repo, "open", ["ssh-46-c6", "feature"]);
  const dir = runDir(repo);
  cli(repo, "abandon", ["ssh-46-c6", "opened by mistake"]);
  assert.equal(loadLedger(dir).status, "abandoned");
});

test("4.6 C7 session start and gate check say to ask the user, offering no bare gate abandon", () => {
  const repo = blocked("ssh-46-c7");
  const ctx = sessionStart(repo, "S2").hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /gate abandon ssh-46-c7 "<reason>"`/);
  assert.match(ctx, /ask the user/i);
  const help = cli(repo, "help").stdout;
  assert.match(help, /abandon <slug> "<why>" --user-ok/);
});

test("4.6 C9 words saying not to abandon are refused", () => {
  const repo = blocked("ssh-46-c9");
  said(repo, "don't abandon this run");
  refused(repo, "abandon", ["ssh-46-c9", "why", "--user-ok", "don't abandon this run"]);
  assert.equal(statusOf(repo), "open");
});

test("4.6 C11 a bare 'this run' counts for the session's own run, or when it is the only open run", () => {
  const repo = blocked("ssh-46-c11");
  cli(repo, "open", ["ssh-46-other", "feature"], { session: "S2" });
  cli(repo, "note", ["task", "Other. [inferred]"], { session: "S2" });
  said(repo, "abandon this run now", "S1");
  cli(repo, "abandon", ["ssh-46-c11", "own run", "--user-ok", "abandon this run now"]);
  // ssh-46-other is now the only open run, so "this run" from a third session can only mean it
  said(repo, "abandon this run too please", "S9");
  const r = run(repo, "abandon", ["ssh-46-other", "only one open", "--user-ok", "abandon this run too please"], { session: "S9" });
  assert.equal(r.status, 0, r.stderr);
});

test("4.6 C11 with several runs open, another session's run needs its slug", () => {
  const repo = blocked("ssh-46-c11b");
  cli(repo, "open", ["ssh-46-b2", "feature"], { session: "S2" });
  cli(repo, "note", ["task", "Other. [inferred]"], { session: "S2" });
  cli(repo, "attach", ["ssh-46-b2"], { session: "S3" });
  said(repo, "abandon this run now", "S3");
  const r = refusedOrOk(repo, ["ssh-46-c11b", "not mine", "--user-ok", "abandon this run now"], "S3");
  assert.equal(r.status, 1, "a bare 'this run' gave up another session's run while two were open");
  assert.match(r.stderr, /ssh-46-c11b/);
  said(repo, "abandon ssh-46-c11b now", "S3");
  assert.equal(refusedOrOk(repo, ["ssh-46-c11b", "named", "--user-ok", "abandon ssh-46-c11b now"], "S3").status, 0);
});

test("4.6 C12 a bare Yes holds no words; a label naming the run counts", () => {
  const repo = blocked("ssh-46-c12");
  const answer = (label) => logHook(repo, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, tool_response: { answers: { "Abandon the ssh-46-c12 run?": label } } });
  answer("Yes");
  const out = refused(repo, "abandon", ["ssh-46-c12", "why", "--user-ok", "Yes"]);
  assert.match(out, /option label/);
  answer("Abandon the ssh-46-c12 run");
  cli(repo, "abandon", ["ssh-46-c12", "why", "--user-ok", "Abandon the ssh-46-c12 run"]);
  assert.equal(loadLedger(path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").lastClosed)).status, "abandoned");
});
function refusedOrOk(repo, args, session) {
  return run(repo, "abandon", args, { session });
}

test("4.6 C13 the setup refusal offers no bare abandon", () => {
  const repo = blocked("ssh-46-c13");
  const r = run(repo, "setup", ["--decline", "--user-ok", "no thanks then"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a run is open/);
  assert.doesNotMatch(r.stderr, /Close or abandon the run first/);
  assert.match(r.stderr, /--user-ok/);
});
