import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
