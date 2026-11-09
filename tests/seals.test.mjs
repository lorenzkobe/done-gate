import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here, asOldRun, pinnedBefore, waiveArgs, resealRun } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { appendEvents, nextSeq } from "../scripts/lib/events.mjs";
import { sealProblems } from "../scripts/lib/seal.mjs";
import { decide } from "../scripts/lib/guard.mjs";

// D1 Part B: the gate seals the evidence it writes, outside the repo; on a run opened at rules 2 a
// change no gate command or hook made is R20 and blocks the close until the user decides.

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const eventsFile = (repo, session = "S1") => path.join(stateDir(repo), "sessions", session, "events.jsonl");
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const envOf = (repo, extra = {}) => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1", ...extra };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
};
const run = (repo, verb, args = [], extra = {}) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envOf(repo, extra) });
const REFUSAL = /^done-gate: /m;
function cli(repo, verb, args = [], extra = {}) {
  const r = run(repo, verb, args, extra);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const hook = (repo, payload, extra = {}) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envOf(repo, extra) });
const r20 = (repo, extra = {}) => cli(repo, "check", [], extra).split("\n").filter((l) => /\bR20\b/.test(l)).join("\n");

function opened(name, extra = {}) {
  const repo = makeRepo(name);
  cli(repo, "open", [name, "feature"], extra);
  cli(repo, "note", ["task", "Add a badge. [inferred]"], extra);
  cli(repo, "case", ["add", "the badge renders", "--kind", "happy"], extra);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "" } }, extra);
  return repo;
}
// a reviewer writes its findings file with the Write tool, as the hook sees it
function reviewWritten(repo, name = "review-1.md") {
  const file = path.join(runDir(repo), name);
  writeFileSync(file, "# Review 1\n\n## Act on\n- none\n## Consider\n- none\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, tool_response: {}, agent_id: "R1", agent_type: "done-gate:reviewer" });
  return file;
}

test("C1 evidence only the gate's verbs and hooks wrote checks with no R20", () => {
  const repo = opened("seal-c1");
  cli(repo, "verify");
  cli(repo, "decide", ["review", "kept the check", "one caller", "src/a.ts:1", "open"]);
  reviewWritten(repo);
  assert.equal(r20(repo), "");
});

test("C2 ledger.json edited outside the gate is R20 at check and at close, and the close is refused", () => {
  const repo = opened("seal-c2");
  const file = path.join(runDir(repo), "ledger.json");
  writeFileSync(file, JSON.stringify({ ...ledgerOf(repo), cases: [] }, null, 2));
  assert.match(r20(repo), /evidence changed outside the gate[^\n]*ledger\.json/);
  const closed = run(repo, "close");
  assert.match(`${closed.stdout}${closed.stderr}`, /\bR20\b[^\n]*ledger\.json/);
  assert.equal(ledgerOf(repo).status, "open");
});

test("C3 verify.json or decisions.tsv rewritten outside the gate is R20 naming that file", () => {
  const repo = opened("seal-c3");
  cli(repo, "verify");
  cli(repo, "decide", ["review", "kept the check", "one caller", "src/a.ts:1", "open"]);
  const verify = path.join(runDir(repo), "verify.json");
  writeFileSync(verify, readFileSync(verify, "utf8").replace(/"exit": 0/g, '"exit": 0 '));
  assert.match(r20(repo), /verify\.json/);
  const other = opened("seal-c3b");
  cli(other, "decide", ["review", "kept the check", "one caller", "src/a.ts:1", "open"]);
  appendFileSync(path.join(runDir(other), "decisions.tsv"), "2026-01-01\treview\tforged\twhy\tsrc/a.ts:1\topen\n");
  assert.match(r20(other), /decisions\.tsv/);
});

test("C4 a helper's review file the hook saw written is sealed; changed after, it is R20", () => {
  const repo = opened("seal-c4");
  const file = reviewWritten(repo);
  assert.equal(r20(repo), "");
  writeFileSync(file, readFileSync(file, "utf8").replace("- none\n## Consider", "- none\n- \n## Consider"));
  assert.match(r20(repo), /review-1\.md/);
});

test("C5 an events line changed, inserted or removed after the run opened is R20 naming the event", () => {
  const changed = opened("seal-c5");
  const lines = readFileSync(eventsFile(changed), "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1));
  writeFileSync(eventsFile(changed), [...lines.slice(0, -1), JSON.stringify({ ...last, exit: 0 })].join("\n") + "\n");
  assert.match(r20(changed), new RegExp(`events[^\\n]*events#${last.seq}`));

  const inserted = opened("seal-c5b");
  appendFileSync(eventsFile(inserted), `${JSON.stringify({ seq: nextSeq(), ts: new Date().toISOString(), session: "S1", agent: null, kind: "command", tool: "Bash", cmd: "npm test", exit: 0 })}\n`);
  assert.match(r20(inserted), /events/);

  const removed = opened("seal-c5c");
  // a line before the newest: the newest may still be on its way (C18)
  const kept = readFileSync(eventsFile(removed), "utf8").trimEnd().split("\n");
  writeFileSync(eventsFile(removed), [...kept.slice(0, -2), kept.at(-1)].join("\n") + "\n");
  assert.match(r20(removed), /removed/);
});

test("C6 lines from before the run opened, a torn line and a pruned session folder raise nothing", () => {
  const repo = opened("seal-c6");
  const file = eventsFile(repo);
  const before = JSON.stringify({ seq: ledgerOf(repo).openedSeq - 1000, ts: new Date(0).toISOString(), session: "S1", agent: null, kind: "command", tool: "Bash", cmd: "old", exit: 0 });
  writeFileSync(file, `${before}\n${readFileSync(file, "utf8")}{"seq": 12\n`);
  assert.equal(r20(repo), "");
  const ledger = ledgerOf(repo);
  writeFileSync(path.join(runDir(repo), "ledger.json"), JSON.stringify({ ...ledger, sessions: [...ledger.sessions, "S9"] }, null, 2));
  resealRun(repo);
  assert.equal(r20(repo), "", "a session with no folder left is not a change");
});

test("C7 a sealed run file removed is R20 that it was removed; a recorded findings file removed too, an unrecorded one is not", () => {
  const repo = opened("seal-c7");
  cli(repo, "verify");
  rmSync(path.join(runDir(repo), "verify.json"));
  assert.match(r20(repo), /verify\.json[^\n]*removed/);
  const other = opened("seal-c7b");
  const review = path.join(runDir(other), "review-2.md");
  writeFileSync(review, "# Review 2\n\n## Act on\n- none\n## Consider\n- none\n");
  assert.equal(r20(other), "", "a findings file never recorded is R15's, not a change");
  cli(other, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  rmSync(review);
  assert.match(r20(other), /review-2\.md[^\n]*removed/);
});

test("C8 gate waive evidence on the user's words clears R20 and the report lists it; other words are refused", () => {
  const repo = opened("seal-c8");
  writeFileSync(path.join(runDir(repo), "ledger.json"), JSON.stringify({ ...ledgerOf(repo), cases: [] }, null, 2));
  assert.match(r20(repo), /R20/);
  const r = run(repo, "waive", ["evidence", "the test edited the ledger", "--user-ok", "go ahead and ship it"]);
  assert.match(r.stderr, REFUSAL);
  cli(repo, "waive", waiveArgs(repo, "evidence", "I edited the ledger by hand to drop a case"));
  assert.equal(r20(repo), "");
  assert.match(cli(repo, "report", ["--brief"]), /skipped with your OK: I edited the [^\n]* by hand to drop a case/);
});

test("C9 a run opened before rules 2 is never checked", () => {
  const repo = opened("seal-c9");
  asOldRun(repo);
  writeFileSync(path.join(runDir(repo), "ledger.json"), JSON.stringify({ ...ledgerOf(repo), cases: [] }, null, 2));
  appendFileSync(eventsFile(repo), `${JSON.stringify({ seq: nextSeq(), ts: new Date().toISOString(), session: "S1", agent: null, kind: "command", tool: "Bash", cmd: "npm test", exit: 0 })}\n`);
  assert.equal(r20(repo), "");
});

test("C10 with no write access to the seal folder the gate keeps working, checks nothing it could not seal, and the report says so", () => {
  const blocked = path.join(here, ".tmp", "seal-c10-seals");
  rmSync(blocked, { recursive: true, force: true });
  writeFileSync(blocked, "a file where the seals folder should be\n");
  const extra = { DONE_GATE_SEALS: blocked };
  const repo = opened("seal-c10", extra);
  writeFileSync(path.join(runDir(repo), "ledger.json"), JSON.stringify({ ...ledgerOf(repo), cases: [] }, null, 2));
  assert.equal(r20(repo, extra), "");
  assert.match(cli(repo, "report", [], extra), /could not keep its seals/);
});

test("C11 two hooks appending events at once both seal, and the check stays clean", async () => {
  const repo = opened("seal-c11");
  const one = (i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [gate, "log"], { env: envOf(repo) });
    child.on("close", resolve);
    child.stdin.end(JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `echo ${i}` }, tool_response: { stdout: `${i}` } }));
  });
  await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));
  assert.equal(readFileSync(eventsFile(repo), "utf8").trimEnd().split("\n").length >= 13, true);
  assert.equal(r20(repo), "");
});

test("C12 tests keep their seals under tests/.tmp, and resealRun lets a fixture's hand-written ledger pass", () => {
  assert.equal(process.env.DONE_GATE_SEALS, path.join(here, ".tmp", "seals"));
  const repo = opened("seal-c12");
  pinnedBefore(repo);
  assert.equal(r20(repo), "");
  assert.ok(existsSync(process.env.DONE_GATE_SEALS));
});

test("C13 the check over a 20000-line events file takes under 300 ms", () => {
  const repo = opened("seal-c13");
  const ledger = ledgerOf(repo);
  const batch = Array.from({ length: 20000 }, (_, i) => ({ seq: nextSeq(), ts: new Date().toISOString(), session: "S1", agent: null, kind: "command", tool: "Bash", cmd: `echo ${i}`, exit: 0 }));
  appendEvents(stateDir(repo), "S1", batch);
  const started = performance.now();
  const problems = sealProblems({ stateDir: stateDir(repo), dir: runDir(repo), ledger });
  const ms = performance.now() - started;
  assert.deepEqual(problems, []);
  assert.ok(ms < 300, `the check took ${ms} ms`);
});

test("C14 a shell edit followed by a gate verb that saves the same file is still R20", () => {
  const repo = opened("seal-c14");
  writeFileSync(path.join(runDir(repo), "ledger.json"), JSON.stringify({ ...ledgerOf(repo), cases: [] }, null, 2));
  cli(repo, "case", ["add", "a second case", "--kind", "edge"]);
  assert.match(r20(repo), /ledger\.json/);

  const verified = opened("seal-c14b");
  cli(verified, "verify");
  const verify = path.join(runDir(verified), "verify.json");
  writeFileSync(verify, `${readFileSync(verify, "utf8")}\n`);
  cli(verified, "verify", ["--force"]);
  assert.match(r20(verified), /verify\.json/);

  const decided = opened("seal-c14c");
  cli(decided, "decide", ["review", "kept it", "one caller", "src/a.ts:1", "open"]);
  appendFileSync(path.join(runDir(decided), "decisions.tsv"), "2026-01-01\treview\tforged\twhy\tsrc/a.ts:1\topen\n");
  cli(decided, "decide", ["review", "another", "why", "src/a.ts:1", "open"]);
  assert.match(r20(decided), /decisions\.tsv/);
});

test("C15 an evidence waiver covers the changes seen when it was given; a later change is R20 again", () => {
  const repo = opened("seal-c15");
  writeFileSync(path.join(runDir(repo), "ledger.json"), JSON.stringify({ ...ledgerOf(repo), cases: [] }, null, 2));
  cli(repo, "waive", waiveArgs(repo, "evidence", "I dropped the cases by hand"));
  assert.equal(r20(repo), "");
  const verify = path.join(runDir(repo), "decisions.tsv");
  writeFileSync(verify, "ts\tphase\tdecision\twhy\tevidence\tresult\nforged\n");
  assert.match(r20(repo), /decisions\.tsv/);
});

test("C16 the fence refuses a shell write naming the seals folder", () => {
  const root = makeRepo("seal-c16");
  const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: root, session_id: "S1" });
  assert.equal(decide(bash("echo 'ledger.json\tabc' >> ~/.claude/done-gate/seals/0123456789abcdef/run-x-1.seals"), root).deny, true);
  assert.equal(decide(bash("cat ~/.claude/done-gate/seals/0123456789abcdef/run-x-1.seals"), root).deny, false);
});

test("C17 a run with no seals file at all and a session with no events seals are not checked, and the report says so", () => {
  const repo = opened("seal-c17");
  rmSync(process.env.DONE_GATE_SEALS + "-none", { recursive: true, force: true });
  const extra = { DONE_GATE_SEALS: `${process.env.DONE_GATE_SEALS}-none` };
  writeFileSync(path.join(runDir(repo), "ledger.json"), JSON.stringify({ ...ledgerOf(repo), cases: [] }, null, 2));
  assert.equal(r20(repo, extra), "");
  assert.match(cli(repo, "report", [], extra), /Not checked against the gate.s seals/);
});

test("C18 a seal whose line is not written yet is no removed line for a few seconds", () => {
  const repo = opened("seal-c18");
  const ledger = ledgerOf(repo);
  const seq = nextSeq();
  const problems = () => sealProblems({ stateDir: stateDir(repo), dir: runDir(repo), ledger });
  // the seal of a line on its way: what appendEvents writes first
  appendEvents(stateDir(repo), "S1", [{ seq, ts: new Date().toISOString(), session: "S1", agent: null, kind: "command", tool: "Bash", cmd: "echo", exit: 0 }]);
  const lines = readFileSync(eventsFile(repo), "utf8").trimEnd().split("\n");
  writeFileSync(eventsFile(repo), lines.slice(0, -1).join("\n") + "\n");
  assert.deepEqual(problems(), []);
});

test("C19 a decisions.tsv or verify.json written outside the gate before its first gate write is marked by that write", () => {
  const repo = opened("seal-c19");
  writeFileSync(path.join(runDir(repo), "decisions.tsv"), "ts\tphase\tdecision\twhy\tevidence\tresult\n2026-01-01\treview\tforged\twhy\tsrc/a.ts:1\topen\n");
  cli(repo, "decide", ["review", "kept it", "one caller", "src/a.ts:1", "open"]);
  assert.match(r20(repo), /decisions\.tsv/);
  const verified = opened("seal-c19b");
  writeFileSync(path.join(runDir(verified), "verify.json"), "{}");
  cli(verified, "verify");
  assert.match(r20(verified), /verify\.json/);
});
