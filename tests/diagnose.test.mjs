import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate } from "./helpers.mjs";
import { helperProblems } from "../scripts/lib/diagnose.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

const DRAFT = "# Skeptic 1\n\n## Act on\n- unverified\n\n## Consider\n- unverified\n";
const DONE = "# Skeptic 1\n\n## Act on\n- none\n\n## Consider\n- none\n";

// A run dir and an event stream built by hand: seq grows with each call, ts is minutes ago.
function world(name) {
  const root = makeRepo(`dg-${name}`);
  const dir = path.join(root, ".claude", "gate", "runs", "2026-11-08-x");
  mkdirSync(dir, { recursive: true });
  let seq = 100;
  const events = [];
  const ledger = { slug: "x", openedSeq: seq, sessions: ["S1"], briefed: {}, handled: {} };
  const push = (kind, extra = {}, ago = 0) => {
    const e = { seq: ++seq, ts: new Date(Date.now() - ago * 60 * 1000).toISOString(), session: "S1", agent: null, agentType: null, kind, ...extra };
    events.push(e);
    return e;
  };
  const w = {
    root, dir, events, ledger,
    brief: (file) => (ledger.briefed[file] = { seq: ++seq }),
    piece: (file) => (ledger.seen = { ...(ledger.seen ?? {}), [file]: { seq: ++seq, files: [file] } }),
    start: (id, role, ago) => push("subagent-start", { agent: id, agentType: `done-gate:${role}` }, ago),
    stop: (id, role, ago) => push("subagent-stop", { agent: id, agentType: `done-gate:${role}` }, ago),
    edit: (id, role, file, ago) => push("edit", { agent: id, agentType: `done-gate:${role}`, tool: "Write", path: path.relative(root, path.join(dir, file)).split(path.sep).join("/") }, ago),
    notice: (id, cause, summary = `Agent "x" ${cause}`, ago) => push("prompt", { text: `<task-notification><task-id>${id}</task-id><summary>${summary}</summary></task-notification>`, handback: true, notice: { agent: id, status: "completed", cause } }, ago),
    file: (name, body) => writeFileSync(path.join(dir, name), body),
    problems: () => helperProblems({ events, ledger, dir, root, now: Date.now() }),
  };
  return w;
}

// a skeptic briefed on skeptic-1.md that wrote its draft
function skeptic(name) {
  const w = world(name);
  w.brief("skeptic-1.md");
  w.start("A1", "skeptic");
  w.file("skeptic-1.md", DRAFT);
  w.edit("A1", "skeptic", "skeptic-1.md");
  return w;
}

test("4.3 C1 each cause gives its next step", () => {
  const rows = [
    ["turn-limit", "resume", /SendMessage[\s\S]*A1[\s\S]*skeptic-1\.md/],
    ["lost-connection", "resume", /SendMessage/],
    ["api-problem", "resume", /SendMessage/],
    ["session-limit", "pause", /session limit[\s\S]*resume/],
    ["stalled", "resume", /SendMessage/],
    ["only-you", "tell", /tell the user[\s\S]*do not retry/i],
    ["stopped-by-user", "ask-first", /ask the user before/i],
    ["unknown", "tell", /something nobody has seen[\s\S]*ask/],
  ];
  for (const [cause, step, words] of rows) {
    const w = skeptic(`c1-${cause}`);
    w.notice("A1", cause, `Agent "x" failed: something nobody has seen`);
    const [p] = w.problems();
    assert.equal(p?.cause, cause, `${cause}: ${JSON.stringify(p)}`);
    assert.equal(p.step, step, `${cause}: ${p.line}`);
    assert.match(p.line, words, `${cause}: ${p.line}`);
  }
  const lead = skeptic("c1-lead");
  lead.notice("A1", "stopped-by-lead");
  assert.deepEqual(lead.problems(), [], "a stop the lead chose needs nothing");

  const finished = skeptic("c1-finished");
  finished.notice("A1", "finished");
  const [f] = finished.problems();
  assert.equal(f.cause, "finished");
  assert.equal(f.step, "resume");
  assert.match(f.line, /skeptic-1\.md/);

  const gone = skeptic("c1-gone");
  gone.events.forEach((e) => (e.ts = new Date(Date.now() - 46 * 60 * 1000).toISOString()));
  const [g] = gone.problems();
  assert.equal(g.cause, "gone");
  assert.equal(g.step, "fresh");
  assert.match(g.line, /gate brief skeptic/);
});

test("4.3 C2 the third counted failure on one file stops saying resume; a fourth asks with nothing Recommended", () => {
  const w = skeptic("c2");
  const steps = [];
  for (let i = 0; i < 3; i++) {
    w.notice("A1", "stalled");
    steps.push(w.problems()[0].step);
    w.start("A1", "skeptic");
  }
  assert.deepEqual(steps, ["resume", "resume", "fresh"]);
  assert.deepEqual(w.problems(), [], "a resumed helper shows nothing");
  w.start("A2", "skeptic");
  w.edit("A2", "skeptic", "skeptic-1.md");
  w.notice("A2", "stalled");
  const [p] = w.problems();
  assert.equal(p.attempts, 4);
  assert.equal(p.step, "ask");
  assert.match(p.line, /ask the user/i);
  assert.match(p.line, /no option marked Recommended/);
});

test("4.3 C3 outages, only-you and chosen stops never count", () => {
  const w = skeptic("c3");
  for (const cause of ["lost-connection", "api-problem", "session-limit", "only-you", "stopped-by-user", "lost-connection"]) {
    w.notice("A1", cause);
    w.start("A1", "skeptic");
  }
  w.notice("A1", "stalled");
  const [p] = w.problems();
  assert.equal(p.attempts, 1);
  assert.equal(p.step, "resume");
});

test("4.3 C4 a turn limit after new edits does not count; one with no edit since the last failure does", () => {
  const w = skeptic("c4");
  w.notice("A1", "turn-limit");
  assert.equal(w.problems()[0].attempts, 0, "the first limit came after the helper wrote its file");
  w.start("A1", "skeptic");
  w.edit("A1", "skeptic", "skeptic-1.md");
  w.notice("A1", "turn-limit");
  assert.equal(w.problems()[0].attempts, 0, "a limit after new edits counted");
  w.start("A1", "skeptic");
  w.notice("A1", "turn-limit");
  const [p] = w.problems();
  assert.equal(p.attempts, 1, "a limit with no edit since the last one did not count");
  assert.equal(p.step, "resume");
});

test("4.3 C5 a fresh helper on the same file inherits the count; workers and QA count by agent id", () => {
  const w = skeptic("c5");
  w.notice("A1", "stalled");
  w.notice("A1", "stalled");
  w.start("A2", "skeptic");
  w.edit("A2", "skeptic", "skeptic-1.md");
  w.notice("A2", "stalled");
  assert.equal(w.problems()[0].attempts, 3);
  assert.equal(w.problems()[0].agent, "A2");

  const q = world("c5-qa");
  q.start("Q1", "qa");
  q.notice("Q1", "stalled");
  q.start("W1", "worker");
  q.notice("W1", "stalled");
  q.start("W2", "worker");
  const byAgent = Object.fromEntries(q.problems().map((p) => [p.agent, p.attempts]));
  assert.deepEqual(byAgent, { Q1: 1, W1: 1 }, "another worker starting cleared or joined W1's count");
});

test("4.3 C6 nothing shows for a live helper, a finished file, or another kind of agent", () => {
  const live = skeptic("c6-live");
  live.notice("A1", "turn-limit");
  live.start("A1", "skeptic");
  assert.deepEqual(live.problems(), []);

  const done = skeptic("c6-done");
  done.file("skeptic-1.md", DONE);
  done.notice("A1", "turn-limit");
  assert.deepEqual(done.problems(), [], "a finished file lost to a later notice");

  const other = world("c6-other");
  other.events.push({ seq: 999, ts: new Date().toISOString(), session: "S1", agent: "X1", agentType: "Explore", kind: "subagent-start" });
  other.notice("X1", "stalled");
  assert.deepEqual(other.problems(), []);
});

// ---- through the CLI and the hook ----

const envFor = (repo) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" });
const cli = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
const hook = (repo, payload) => {
  const r = spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const tn = (id, summary) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
const LIMIT = (id) => tn(id, 'Agent "Skeptic" stopped at its 40-turn limit (partial result; SendMessage to task-id to continue)');
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);

function opened(name) {
  const repo = makeRepo(`dg-cli-${name}`);
  cli(repo, "open", [name, "feature"]);
  return repo;
}

test("4.3 C7 a notice for a done-gate helper returns its line as added context; others return nothing", () => {
  const repo = opened("c7");
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "done-gate:skeptic" });
  const out = hook(repo, { hook_event_name: "UserPromptSubmit", prompt: LIMIT("A1") });
  assert.equal(out.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /skeptic[\s\S]*A1[\s\S]*turn limit[\s\S]*SendMessage/);

  hook(repo, { hook_event_name: "SubagentStart", agent_id: "X1", agent_type: "Explore" });
  assert.equal(hook(repo, { hook_event_name: "UserPromptSubmit", prompt: LIMIT("X1") }).hookSpecificOutput, undefined, "another agent type got a line");
  assert.equal(hook(repo, { hook_event_name: "UserPromptSubmit", prompt: tn("b1", 'Background command "npm test" failed with exit code 1') }).hookSpecificOutput, undefined);

  const none = makeRepo("dg-cli-c7-none");
  hook(none, { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "done-gate:skeptic" });
  assert.equal(hook(none, { hook_event_name: "UserPromptSubmit", prompt: LIMIT("A1") }).hookSpecificOutput, undefined, "no run open still got a line");
});

test("4.3 C8 gate diagnose prints one line per problem, or none, and writes nothing", () => {
  const repo = opened("c8");
  const ledgerFile = path.join(runDir(repo), "ledger.json");
  const r0 = cli(repo, "diagnose");
  assert.equal(r0.status, 0, r0.stderr);
  assert.match(r0.stdout, /no helper problems/);
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "done-gate:skeptic" });
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: LIMIT("A1") });
  const before = readFileSync(ledgerFile, "utf8");
  const r = cli(repo, "diagnose");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skeptic[\s\S]*A1[\s\S]*turn limit/);
  assert.equal(readFileSync(ledgerFile, "utf8"), before, "gate diagnose changed the ledger");
});

test("4.3 C9 --handled hides a problem until a newer notice; an id with no problem is refused", () => {
  const repo = opened("c9");
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "done-gate:skeptic" });
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: tn("A1", 'Agent "Skeptic" failed: Invalid API key · Please run /login') });
  const bad = cli(repo, "diagnose", ["--handled", "nobody"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /nobody/);
  const ok = cli(repo, "diagnose", ["--handled", "A1"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(cli(repo, "diagnose").stdout, /no helper problems/);
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "done-gate:skeptic" });
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: LIMIT("A1") });
  assert.match(cli(repo, "diagnose").stdout, /A1[\s\S]*turn limit/, "a newer notice stayed hidden");
});

test("4.3 C10 a helper re-briefed before it wrote anything still ties to its file through the brief's earlier seqs", () => {
  const w = world("c10");
  w.brief("skeptic-1.md");
  w.start("A1", "skeptic");
  w.notice("A1", "stalled");
  w.notice("A1", "stalled");
  const first = w.ledger.briefed["skeptic-1.md"].seq;
  w.brief("skeptic-1.md");
  w.ledger.briefed["skeptic-1.md"].earlier = [first];
  w.start("A2", "skeptic");
  w.notice("A2", "stalled");
  const [p] = w.problems();
  assert.equal(p.key, "skeptic-1.md");
  assert.equal(p.attempts, 3);
  assert.equal(p.step, "fresh");
});

test("4.3 C10 gate brief keeps a re-briefed file's earlier seqs", () => {
  const repo = opened("c10-brief");
  cli(repo, "note", ["task", "A task. [inferred]"]);
  const ledger = () => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
  cli(repo, "brief", ["skeptic"]);
  const first = ledger().briefed?.["skeptic-1.md"]?.seq;
  assert.ok(first, `premise: the skeptic brief is recorded:\n${JSON.stringify(ledger().briefed)}`);
  cli(repo, "brief", ["skeptic"]);
  const again = ledger().briefed["skeptic-1.md"];
  assert.ok(again.seq > first, "premise: the re-brief named the same file");
  assert.deepEqual(again.earlier, [first]);
});

test("4.3 C11 pieces briefed before either agent starts: a writer ties to its file, a silent agent counts under its own id", () => {
  const w = world("c11");
  w.piece("review-1.md");
  w.piece("review-2.md");
  w.start("R1", "reviewer");
  w.start("R2", "reviewer");
  w.file("review-1.md", DRAFT);
  w.edit("R1", "reviewer", "review-1.md");
  w.notice("R1", "stalled");
  w.notice("R2", "stalled");
  const byAgent = Object.fromEntries(w.problems().map((p) => [p.agent, p.key]));
  assert.equal(byAgent.R1, "review-1.md");
  assert.equal(byAgent.R2, "review-2.md", "the one unclaimed piece ties to the agent that wrote nothing");

  const two = world("c11-two");
  two.piece("review-1.md");
  two.piece("review-2.md");
  two.start("R1", "reviewer");
  two.start("R2", "reviewer");
  two.notice("R1", "stalled");
  two.notice("R2", "stalled");
  const keys = two.problems().map((p) => p.key).sort();
  assert.deepEqual(keys, ["R1", "R2"], "two silent agents and two pieces were guessed onto files");
});

// ---- 4.5: a run left behind says why it stopped ----

import { leftBehind } from "../scripts/lib/diagnose.mjs";

// a run on disk whose session log holds the given events
function leftRun(name, build) {
  const root = makeRepo(`dg-left-${name}`);
  const stateDir = path.join(root, ".claude", "gate");
  const dir = path.join(stateDir, "runs", `2026-11-01-${name}`);
  mkdirSync(dir, { recursive: true });
  const ledger = { slug: name, playbook: "feature", status: "open", openedAt: "2026-11-01T00:00:00.000Z", openedSeq: 10, sessions: ["S0"], steps: [{ key: "context", state: "DONE" }, { key: "plan", state: "DONE" }, { key: "cases" }, { key: "close" }] };
  let seq = 10;
  const events = [];
  const at = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const push = (kind, ago, extra = {}) => events.push({ seq: ++seq, ts: at(ago), session: "S0", agent: null, agentType: null, kind, ...extra });
  build({ push, ledger });
  if (events.length) {
    mkdirSync(path.join(stateDir, "sessions", "S0"), { recursive: true });
    writeFileSync(path.join(stateDir, "sessions", "S0", "events.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }
  return leftBehind({ stateDir, root, session: "S9" }, { dir, ledger });
}

test("4.5 C3 with no failure it says exactly that, with last activity, steps done and the next step", () => {
  const r = leftRun("c3", ({ push }) => {
    push("prompt", 300, { text: "do it" });
    push("edit", 290, { path: "src/a.ts" });
  });
  assert.equal(r.why, "it stopped with no failure on record");
  assert.equal(r.done, 2);
  assert.equal(r.total, 4);
  assert.equal(r.next, "cases");
  assert.match(r.summary, /last active 4 hours ago/);
  assert.match(r.summary, /2 of 4 steps done, next \{cases\}/);
});

test("4.5 C4 a failed turn carried past is not the reason; one nothing followed is", () => {
  const past = leftRun("c4-past", ({ push }) => {
    push("turn-failed", 300, { error: "overloaded", details: "529" });
    push("prompt", 290, { text: "carry on" });
  });
  assert.equal(past.why, "it stopped with no failure on record");
  const last = leftRun("c4-last", ({ push }) => {
    push("prompt", 300, { text: "do it" });
    push("turn-failed", 290, { error: "rate_limit", details: "429", text: "You've hit your session limit · resets 6:40pm" });
  });
  assert.match(last.why, /last turn ended on an error[\s\S]*session limit/);
});

test("4.5 C5 no records left says so and asks; active under 45 minutes says ask first", () => {
  const none = leftRun("c5-none", () => {});
  assert.match(none.why, /no event records[\s\S]*ask the user/);
  const active = leftRun("c5-active", ({ push }) => push("edit", 10, { path: "src/a.ts" }));
  assert.match(active.why, /active 10 minutes ago[\s\S]*ask the user first/);
});

const sessionStart = (repo, id, source = "startup") => {
  const r = spawnSync(process.execPath, [gate, "session-start"], { input: JSON.stringify({ session_id: id, cwd: repo, hook_event_name: "SessionStart", source, session_start_source: source }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: id } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
};
const as = (repo, id, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: id } });

test("4.5 C6 session start lists each open run with its reason, at most five, and joins none", () => {
  const repo = makeRepo("dg-left-c6");
  for (let i = 1; i <= 6; i++) as(repo, `S${i}`, "open", [`run-${i}`, "feature"]);
  const ctx = sessionStart(repo, "S9");
  const lines = ctx.split("\n").filter((l) => l.startsWith("Open run "));
  assert.equal(lines.length, 5, ctx);
  assert.match(ctx, /and 1 more open run/);
  for (const l of lines) {
    assert.match(l, /another session/);
    assert.match(l, /steps done/);
    assert.match(l, /no event records[\s\S]*ask the user/, "a shell-opened run with no records says so");
    assert.match(l, /gate attach run-\d[\s\S]*ask the user before giving it up/);
  }
  assert.equal(loadSession(path.join(repo, ".claude", "gate"), "S9").current, null, "session start joined another session's run");
});

test("4.5 C7 gate attach prints the full story; gate check's stale line names the reason", () => {
  const repo = makeRepo("dg-left-c7");
  as(repo, "S1", "open", ["old", "feature"]);
  mkdirSync(path.join(repo, ".claude", "gate", "sessions", "S1"), { recursive: true });
  writeFileSync(path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl"), `${JSON.stringify({ seq: 2e15, ts: new Date(Date.now() - 90 * 60 * 1000).toISOString(), session: "S1", agent: null, agentType: null, kind: "prompt", text: "x" })}\n`);
  const r = as(repo, "S9", "attach", ["old"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /run old: last active/);
  assert.match(r.stdout, /steps: \d+ of \d+ done/);
  assert.match(r.stdout, /why it stopped: /);

  const stale = makeRepo("dg-left-c7-stale");
  as(stale, "S1", "open", ["gone", "feature"]);
  const dir = path.join(stale, ".claude", "gate", "runs", loadSession(path.join(stale, ".claude", "gate"), "S1").current);
  const ledgerFile = path.join(dir, "ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  writeFileSync(ledgerFile, JSON.stringify({ ...ledger, openedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(), sessions: ["S0"] }));
  const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
  utimesSync(ledgerFile, old, old);
  const check = as(stale, "S2", "check").stdout;
  assert.match(check, /open run gone[^\n]*5 days[^\n]*no event records[^\n]*ask the user whether to finish it or give it up/, check);
});

test("4.5 C8 six open runs, the newest with a 4 MB log and the sixth unreadable: five are listed, under 2 s", () => {
  const repo = makeRepo("dg-left-c8");
  for (let i = 1; i <= 6; i++) as(repo, `S${i}`, "open", [`run-${i}`, "feature"]);
  const sessions = path.join(repo, ".claude", "gate", "sessions");
  const line = (n) => `${JSON.stringify({ seq: 1e15 + n, ts: new Date().toISOString(), session: "S6", agent: null, agentType: null, kind: "command", tool: "Bash", cmd: "x".repeat(150), exit: 0 })}\n`;
  mkdirSync(path.join(sessions, "S6"), { recursive: true });
  writeFileSync(path.join(sessions, "S6", "events.jsonl"), Array.from({ length: 16000 }, (_, n) => line(n)).join(""));
  // the oldest run's log is a folder: reading it would throw, so a listing of five proves it was skipped
  // (gate open logged its verb there first)
  rmSync(path.join(sessions, "S1", "events.jsonl"), { force: true });
  mkdirSync(path.join(sessions, "S1", "events.jsonl"), { recursive: true });
  const started = Date.now();
  const ctx = sessionStart(repo, "S9");
  const ms = Date.now() - started;
  assert.equal(ctx.split("\n").filter((l) => l.startsWith("Open run ")).length, 5, ctx);
  assert.doesNotMatch(ctx, /Open run run-1\b/);
  assert.ok(ms < 2000, `session start took ${ms} ms`);
});

test("4.5 C9 a helper's records after a failed turn leave the failure as the reason", () => {
  const r = leftRun("c9", ({ push }) => {
    push("prompt", 300, { text: "do it" });
    push("turn-failed", 290, { error: "overloaded", details: "529" });
    push("subagent-stop", 288, { agent: "A1", agentType: "done-gate:reviewer" });
    push("edit", 287, { agent: "A1", agentType: "done-gate:reviewer", path: "x/review-1.md" });
  });
  assert.match(r.why, /last turn ended on an error/);
});

test("4.5 C10 only the sessions the run names count: an attaching session is not its last activity", () => {
  const r = leftRun("c10", ({ push }) => push("edit", 300, { path: "src/a.ts" }));
  assert.equal(r.why, "it stopped with no failure on record");
  const repo = makeRepo("dg-left-c10");
  as(repo, "S1", "open", ["old", "feature"]);
  const sessions = path.join(repo, ".claude", "gate", "sessions");
  mkdirSync(path.join(sessions, "S1"), { recursive: true });
  writeFileSync(path.join(sessions, "S1", "events.jsonl"), `${JSON.stringify({ seq: 2e15, ts: new Date(Date.now() - 300 * 60 * 1000).toISOString(), session: "S1", agent: null, agentType: null, kind: "prompt", text: "x" })}\n`);
  mkdirSync(path.join(sessions, "S9"), { recursive: true });
  writeFileSync(path.join(sessions, "S9", "events.jsonl"), `${JSON.stringify({ seq: 3e15, ts: new Date().toISOString(), session: "S9", agent: null, agentType: null, kind: "prompt", text: "y" })}\n`);
  const out = as(repo, "S9", "attach", ["old"]).stdout;
  assert.match(out, /last active 5 hours ago/, out);
});

test("4.5 C11 gate check with a stale run whose log cannot be read still lists it", () => {
  const repo = makeRepo("dg-left-c11");
  as(repo, "S1", "open", ["gone", "feature"]);
  const dir = path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
  const ledgerFile = path.join(dir, "ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  writeFileSync(ledgerFile, JSON.stringify({ ...ledger, openedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(), sessions: ["S0"] }));
  const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
  utimesSync(ledgerFile, old, old);
  mkdirSync(path.join(repo, ".claude", "gate", "sessions", "S0", "events.jsonl"), { recursive: true });
  const r = as(repo, "S2", "check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /open run gone[^\n]*5 days[^\n]*ask the user/, r.stdout);
});

// ---- 4.7: gate watch ----

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

const FAST = { DONE_GATE_WATCH_POLL_MS: "100", DONE_GATE_WATCH_GRACE_MS: "600", DONE_GATE_WATCH_QUIET_MS: "60000" };
function watch(repo, extra = {}) {
  const child = spawn(process.execPath, [gate, "watch"], { env: { ...envFor(repo), ...FAST, ...extra } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, at: Date.now() })));
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const startHelper = (repo, id, role = "reviewer") => hook(repo, { hook_event_name: "SubagentStart", agent_id: id, agent_type: `done-gate:${role}` });
const stopHelper = (repo, id, role = "reviewer") => hook(repo, { hook_event_name: "SubagentStop", agent_id: id, agent_type: `done-gate:${role}` });

test("4.7 C1 a watch exits within one poll of the last helper stopping, saying it finished", async () => {
  const repo = opened("w-c1");
  startHelper(repo, "A1");
  const done = watch(repo);
  await pause(400);
  stopHelper(repo, "A1");
  const stoppedAt = Date.now();
  const r = await done;
  assert.equal(r.code, 0, r.out);
  assert.ok(r.at - stoppedAt < 1000, `the watch took ${r.at - stoppedAt} ms after the stop`);
  assert.match(r.out, /reviewer A1[^\n]*finished/);
});

test("4.7 C2 a turn-limit notice ends the watch with that helper's cause and next step", async () => {
  const repo = opened("w-c2");
  startHelper(repo, "A1", "skeptic");
  const done = watch(repo);
  await pause(300);
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: LIMIT("A1") });
  const r = await done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /skeptic A1[\s\S]*turn limit[\s\S]*SendMessage A1/);
});

test("4.7 C3 with no helper out it waits the grace, then says none is out", async () => {
  const repo = opened("w-c3");
  const started = Date.now();
  const r = await watch(repo);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.at - started >= 600, "it did not wait the grace");
  assert.match(r.out, /no helper is out/);
});

test("4.7 C4 no new event for the quiet time: it exits, names the helper still out, and says to run it again", async () => {
  const repo = opened("w-c4");
  startHelper(repo, "A1");
  const r = await watch(repo, { DONE_GATE_WATCH_QUIET_MS: "500" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /quiet/);
  assert.match(r.out, /done-gate:reviewer \(A1\)/);
  assert.match(r.out, /gate watch/);
});

test("4.7 C5 a helper silent past 45 minutes ends the watch with cause gone", async () => {
  const repo = opened("w-c5");
  startHelper(repo, "A1");
  const file = path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl");
  const old = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  writeFileSync(file, readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => `${JSON.stringify({ ...JSON.parse(l), ts: old })}\n`).join(""));
  const r = await watch(repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no helper is out/);
  assert.match(r.out, /gate diagnose[^\n]*1 helper/);
});

test("4.7 C10 a stop followed by a waiting notice within the confirming poll keeps the watch going", async () => {
  const repo = opened("w-c10");
  startHelper(repo, "A1");
  let ended = false;
  const done = watch(repo, { DONE_GATE_WATCH_POLL_MS: "400", DONE_GATE_WATCH_QUIET_MS: "2500" }).then((r) => ((ended = true), r));
  await pause(500);
  stopHelper(repo, "A1");
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: tn("A1", 'Agent "Review" is waiting on its own background work') });
  await pause(1200);
  assert.equal(ended, false, "a waiting helper was reported back");
  const r = await done;
  assert.match(r.out, /quiet[\s\S]*A1/);
});

test("4.7 C11 helpers from an earlier round are not named when this watch ends", async () => {
  const repo = opened("w-c11");
  startHelper(repo, "R0");
  stopHelper(repo, "R0");
  const done = watch(repo);
  await pause(200);
  startHelper(repo, "A2");
  await pause(300);
  stopHelper(repo, "A2");
  const r = await done;
  assert.match(r.out, /A2[^\n]*finished/);
  assert.doesNotMatch(r.out, /R0/);
});

test("4.7 C12 quiet counts from the watch's start when the newest event is older", async () => {
  const repo = opened("w-c12");
  startHelper(repo, "A1");
  const file = path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl");
  const old = new Date(Date.now() - 19 * 60 * 1000).toISOString();
  writeFileSync(file, readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => `${JSON.stringify({ ...JSON.parse(l), ts: old })}\n`).join(""));
  const started = Date.now();
  const r = await watch(repo, { DONE_GATE_WATCH_QUIET_MS: "800" });
  assert.match(r.out, /quiet/);
  assert.ok(r.at - started >= 800, `the watch went quiet after ${r.at - started} ms`);
});

test("4.7 C13 the exit says nothing more is owed if the hand-backs came; the brief line says one watch per wait", async () => {
  const repo = opened("w-c13");
  startHelper(repo, "A1");
  const done = watch(repo);
  await pause(300);
  stopHelper(repo, "A1");
  assert.match((await done).out, /nothing more is owed/);
  cli(repo, "note", ["task", "A task. [inferred]"]);
  assert.match(cli(repo, "brief", ["skeptic"]).stdout, /one watch per wait/);
});

test("4.7 C6 with two helpers out the first stopping does not end the watch", async () => {
  const repo = opened("w-c6");
  startHelper(repo, "A1");
  startHelper(repo, "A2", "reviewer-2");
  let ended = false;
  const done = watch(repo).then((r) => ((ended = true), r));
  await pause(300);
  stopHelper(repo, "A1");
  await pause(500);
  assert.equal(ended, false, "the watch ended with A2 still out");
  stopHelper(repo, "A2", "reviewer-2");
  const r = await done;
  assert.match(r.out, /A1[^\n]*finished[\s\S]*A2[^\n]*finished|A2[^\n]*finished[\s\S]*A1[^\n]*finished/);
});

test("4.7 C7 the watch writes nothing", async () => {
  const repo = opened("w-c7");
  startHelper(repo, "A1");
  const gateDir = path.join(repo, ".claude", "gate");
  const sum = () => {
    const files = [path.join(runDir(repo), "ledger.json"), ...readdirSync(path.join(gateDir, "sessions")).flatMap((s) => readdirSync(path.join(gateDir, "sessions", s)).map((f) => path.join(gateDir, "sessions", s, f)))];
    return files.map((f) => `${f}:${createHash("sha1").update(readFileSync(f)).digest("hex")}`).join("\n");
  };
  const before = sum();
  await watch(repo, { DONE_GATE_WATCH_QUIET_MS: "300" });
  assert.equal(sum(), before);
});

test("4.7 C8 no run open is refused; gate brief's one-helper line names gate watch", async () => {
  const none = makeRepo("w-c8-none");
  const r = await watch(none);
  assert.equal(r.code, 1);
  assert.match(r.out, /no open run/);
  const repo = opened("w-c8");
  cli(repo, "note", ["task", "A task. [inferred]"]);
  assert.match(cli(repo, "brief", ["skeptic"]).stdout, /one helper per packet[^\n]*gate watch/);
});

test("4.7 C9 a poll over a 4 MB session log stays well under the 5 s poll", async () => {
  const repo = opened("w-c9");
  const file = path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl");
  const line = (n) => `${JSON.stringify({ seq: 1e15 + n, ts: new Date().toISOString(), session: "S1", agent: null, agentType: null, kind: "command", tool: "Bash", cmd: "x".repeat(150), exit: 0 })}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Array.from({ length: 16000 }, (_, n) => line(n)).join(""));
  startHelper(repo, "A1");
  stopHelper(repo, "A1");
  const started = Date.now();
  const r = await watch(repo, { DONE_GATE_WATCH_GRACE_MS: "0" });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.at - started < 2000, `one poll took ${r.at - started} ms`);
});

// ---- F9: a helper quiet for the idle time ----

const ageEvents = (repo, minutes, keep = () => false) => {
  const file = path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl");
  const old = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  writeFileSync(file, readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((e) => `${JSON.stringify(keep(e) ? e : { ...e, ts: old })}\n`).join(""));
};
// a helper's Read reaches the gate through the fence, which logs it
const helperRead = (repo, id) => assert.equal(spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PreToolUse", agent_id: id, agent_type: "done-gate:reviewer", tool_name: "Read", tool_input: { file_path: path.join(repo, "src/a.ts") } }), encoding: "utf8", env: envFor(repo) }).status, 0);

test("F9 C1 happy: a helper with no event of its own for the idle time ends the watch with its idle line", async () => {
  const repo = opened("w-f9c1");
  startHelper(repo, "A1");
  const r = await watch(repo, { DONE_GATE_WATCH_IDLE_MS: "500" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /reviewer A1 has done nothing for [^\n]*: SendMessage it to ask where it stands, or run `gate diagnose`\. Advice only; the gate stops waiting for it at 45 minutes\./);
  assert.doesNotMatch(r.out, /quiet: no new event/);
});

test("F9 C2 refused: a helper that keeps acting does not end the watch idle; its stop ends it as finished", async () => {
  const repo = opened("w-f9c2");
  startHelper(repo, "A1");
  const done = watch(repo, { DONE_GATE_WATCH_IDLE_MS: "900" });
  for (let i = 0; i < 4; i++) {
    await pause(400);
    helperRead(repo, "A1");
  }
  stopHelper(repo, "A1");
  const r = await done;
  assert.match(r.out, /reviewer A1[^\n]*finished/);
  assert.doesNotMatch(r.out, /has done nothing/);
});

test("F9 C3 boundary: a helper quiet before the watch is named only after the idle time of watching", async () => {
  const repo = opened("w-f9c3");
  startHelper(repo, "A1");
  ageEvents(repo, 12);
  const started = Date.now();
  const r = await watch(repo, { DONE_GATE_WATCH_IDLE_MS: "800" });
  assert.ok(r.at - started >= 800, `named after ${r.at - started} ms`);
  assert.match(r.out, /reviewer A1 has done nothing for 12 min/);
});

test("F9 C4 happy: a prompt to the lead carries the idle line for a helper quiet 10 minutes; a fresh helper or no run adds nothing", () => {
  const repo = opened("w-f9c4");
  startHelper(repo, "A1");
  startHelper(repo, "A2", "reviewer-2");
  ageEvents(repo, 11, (e) => e.agent === "A2");
  const told = hook(repo, { hook_event_name: "UserPromptSubmit", prompt: tn("A3", 'Background command "npm test" completed (exit code 0)') });
  const line = told.hookSpecificOutput?.additionalContext ?? "";
  assert.match(line, /reviewer A1 has done nothing for 11 min/);
  assert.doesNotMatch(line, /A2/);
  const none = makeRepo("dg-cli-w-f9c4-none");
  assert.equal(hook(none, { hook_event_name: "UserPromptSubmit", prompt: "go on" }).hookSpecificOutput, undefined);
});

test("F9 C5 edge: a helper silent past 45 minutes still counts as gone, with no idle line", async () => {
  const repo = opened("w-f9c5");
  startHelper(repo, "A1");
  ageEvents(repo, 46);
  const r = await watch(repo, { DONE_GATE_WATCH_IDLE_MS: "200" });
  assert.match(r.out, /no helper is out/);
  assert.doesNotMatch(r.out, /has done nothing/);
  const told = hook(repo, { hook_event_name: "UserPromptSubmit", prompt: "go on" });
  assert.doesNotMatch(told.hookSpecificOutput?.additionalContext ?? "", /has done nothing/);
});

const eventsOf = (repo) => readFileSync(path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fenceAs = (repo, id, tool, tool_input) => spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PreToolUse", agent_id: id, agent_type: "done-gate:reviewer", tool_name: tool, tool_input }), encoding: "utf8", env: envFor(repo) });

test("F9 C6 edge: a helper that only reads keeps the watch from naming it idle, since the fence logs each call", async () => {
  const repo = opened("w-f9c6");
  startHelper(repo, "A1");
  const done = watch(repo, { DONE_GATE_WATCH_IDLE_MS: "900" });
  for (const [tool, input] of [["Read", { file_path: path.join(repo, "src/a.ts") }], ["Grep", { pattern: "a", path: repo }], ["Glob", { pattern: "**/*.ts" }]]) {
    await pause(450);
    assert.equal(fenceAs(repo, "A1", tool, input).status, 0);
  }
  stopHelper(repo, "A1");
  const r = await done;
  assert.doesNotMatch(r.out, /has done nothing/);
  assert.ok(eventsOf(repo).some((e) => e.kind === "helper-tool" && e.agent === "A1" && e.tool === "Grep"));
});

test("F9 C7 edge: a helper inside a long Bash call is busy, not idle", async () => {
  const repo = opened("w-f9c7");
  startHelper(repo, "A1");
  const r = spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PreToolUse", agent_id: "A1", agent_type: "done-gate:reviewer", tool_name: "Bash", tool_use_id: "toolu_long", tool_input: { command: "npm test" } }), encoding: "utf8", env: envFor(repo) });
  assert.equal(r.status, 0);
  const done = watch(repo, { DONE_GATE_WATCH_IDLE_MS: "300", DONE_GATE_WATCH_QUIET_MS: "1500" });
  const out = (await done).out;
  assert.doesNotMatch(out, /has done nothing/);
  assert.match(out, /quiet/);
});

test("F9 C8 edge: a helper waiting on its own background work is not named idle; the quiet still ends the watch", async () => {
  const repo = opened("w-f9c8");
  startHelper(repo, "A1");
  stopHelper(repo, "A1");
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: tn("A1", 'Agent "Review" is waiting on its own background work') });
  const r = await watch(repo, { DONE_GATE_WATCH_IDLE_MS: "300", DONE_GATE_WATCH_QUIET_MS: "1200" });
  assert.doesNotMatch(r.out, /has done nothing/);
  assert.match(r.out, /quiet[\s\S]*A1/);
});

test("F9 C9 boundary: an idle time of 0 is the default, and a helper of another session is never named", async () => {
  const repo = opened("w-f9c9");
  startHelper(repo, "A1");
  const zero = await watch(repo, { DONE_GATE_WATCH_IDLE_MS: "0", DONE_GATE_WATCH_QUIET_MS: "700" });
  assert.doesNotMatch(zero.out, /has done nothing/);
  assert.match(zero.out, /quiet/);
  const other = opened("w-f9c9b");
  const ledgerFile = path.join(runDir(other), "ledger.json");
  writeFileSync(ledgerFile, JSON.stringify({ ...JSON.parse(readFileSync(ledgerFile, "utf8")), sessions: ["S1", "S2"] }));
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S2", cwd: other, hook_event_name: "SubagentStart", agent_id: "B1", agent_type: "done-gate:reviewer" }), encoding: "utf8", env: { ...envFor(other), DONE_GATE_SESSION: "S2" } });
  const r = await watch(other, { DONE_GATE_WATCH_IDLE_MS: "300", DONE_GATE_WATCH_QUIET_MS: "1200" });
  assert.doesNotMatch(r.out, /B1 has done nothing/);
});
