import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, lookedUp } from "./helpers.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// A task that grows to large mid-task (0.16.0 review, item 3.7) switches to what is still
// possible; the report and session storage stay bounded (item 3.5). One test per case.

const REFUSAL = /^done-gate: /m;
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));

function run(repo, verb, args = [], input = "", session = "S1") {
  return spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session } });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const hook = (repo, payload, session = "S1") => run(repo, "log", [], JSON.stringify({ session_id: session, cwd: repo, ...payload }), session);
const leadEdit = (repo, rel, content) => {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_output: "ok" });
};
const started = (repo, role) => hook(repo, { hook_event_name: "SubagentStart", agent_id: `A-${role}`, agent_type: `done-gate:${role}` });
const stopped = (repo, role) => hook(repo, { hook_event_name: "SubagentStop", agent_id: `A-${role}`, agent_type: `done-gate:${role}` });
const ruleLines = (out, rule) => out.split("\n").filter((l) => new RegExp(`^\\d+\\. ${rule} — `).test(l)).join("\n");
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n") + "\n";
const cleanReview = (n) => `# Review ${n}\n\n## Act on\n- none\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: npm test exit 0\n`;

function planned(name, planArgs = ["--files", "src/a.ts"]) {
  const repo = makeRepo(name);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["plan", "One module; no hot path.", ...planArgs]);
  return repo;
}
// a lead edit past 400 lines: the measurement crosses into large
function grown(name) {
  const repo = planned(name);
  leadEdit(repo, "src/a.ts", lines(440, "a"));
  cli(repo, "check");
  return repo;
}

test("C1 reported-surface: a run predicted standard whose edits measure large is marked grown, and gate check asks for QA and reviewer-2 instead of waivers", () => {
  const repo = grown("ll-c1");
  assert.ok(ledgerOf(repo).tier.grewAt, "the run is not marked grown");
  const out = cli(repo, "check");
  assert.match(ruleLines(out, "R7"), /gate brief qa/, out);
  assert.match(ruleLines(out, "R9"), /reviewer-2/, out);
  assert.match(ruleLines(out, "R9"), /large/, out);
});

test("C2 happy: after a QA helper stops and a clean reviewer-2 round, the grown run has no R7 or R9 for them", () => {
  const repo = grown("ll-c2");
  write(repo, "tests/a.test.ts", "test('a', () => { expect(1).toBe(1); });\n");
  started(repo, "qa");
  lookedUp(repo, { agent: "A-qa", role: "qa" });
  stopped(repo, "qa");
  // past the 400-line piece cap the second review goes in slices, as gate check names them
  for (let n = 1; n <= 3; n++) {
    const said = `${cli(repo, "check")}\n${run(repo, "brief", ["reviewer-2"]).stderr}`;
    const piece = /gate brief reviewer-2 --files (\S+?)`/.exec(said)?.[1];
    if (!piece) break;
    cli(repo, "brief", ["reviewer-2", "--files", piece]);
    started(repo, "reviewer-2");
    lookedUp(repo, { agent: "A-reviewer-2", role: "reviewer-2" });
    writeFileSync(path.join(runDir(repo), `review2-${n}.md`), cleanReview(n));
    cli(repo, "huddle", ["add", "reviewer-2", "--file", `review2-${n}.md`]);
    stopped(repo, "reviewer-2");
  }
  const out = cli(repo, "check");
  assert.equal(ruleLines(out, "R7"), "", out);
  assert.equal(ruleLines(out, "R9"), "", out);
});

test("C3 refused: a run predicted or declared large from the plan is not marked grown", () => {
  const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
  const predicted = planned("ll-c3-predicted", ["--files", LARGE.join(",")]);
  leadEdit(predicted, "src/a.ts", lines(420, "a"));
  cli(predicted, "check");
  assert.equal(ledgerOf(predicted).tier.grewAt ?? null, null);

  const declared = planned("ll-c3-declared", ["--files", "src/a.ts", "--size", "large"]);
  leadEdit(declared, "src/a.ts", lines(420, "a"));
  cli(declared, "check");
  assert.equal(ledgerOf(declared).tier.grewAt ?? null, null);
});

test("C4 edge: the QA packet on a grown run says the code exists, stay blind to it, and add the tests the case table lacks", () => {
  const repo = grown("ll-c4");
  const out = cli(repo, "brief", ["qa"]);
  const packet = readFileSync(/^packet: (.+)$/m.exec(out)[1], "utf8");
  assert.match(packet, /grew to large/i, packet);
  assert.match(packet, /blind/i, packet);
});

test("C5 happy: the brief report of a grown run says it grew to large mid-task", () => {
  const repo = grown("ll-c5");
  assert.match(cli(repo, "report", ["--brief"]), /grew to large mid-task/);
});

test("C6 boundary: the report embeds helper files up to 40 KB of text and names the rest", () => {
  const repo = planned("ll-c6");
  leadEdit(repo, "src/a.ts", lines(20, "a"));
  for (const n of [1, 2]) {
    cli(repo, "brief", ["reviewer"]);
    started(repo, "reviewer");
    lookedUp(repo, { agent: "A-reviewer", role: "reviewer" });
    writeFileSync(path.join(runDir(repo), `review-${n}.md`), cleanReview(n).replace("- none\n## Consider", `- none\n## Consider\n${"- a long note line that pads the file\n".repeat(700)}`));
    cli(repo, "huddle", ["add", "reviewer", "--file", `review-${n}.md`]);
    stopped(repo, "reviewer");
  }
  const report = cli(repo, "report");
  assert.match(report, /<summary>review-1\.md<\/summary>/);
  assert.doesNotMatch(report, /<summary>review-2\.md<\/summary>/);
  assert.match(report, /review-2\.md[^\n]*not embedded|not embedded[^\n]*review-2\.md/);
});

test("C7 happy: session-start removes session folders untouched for 14 days that no open run lists, at most once a day", () => {
  const repo = planned("ll-c7");
  const sessions = path.join(stateDir(repo), "sessions");
  const old = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  for (const id of ["OLD", "OLD-LISTED", "RECENT"]) {
    mkdirSync(path.join(sessions, id), { recursive: true });
    writeFileSync(path.join(sessions, id, "events.jsonl"), "");
  }
  for (const id of ["OLD", "OLD-LISTED"]) {
    for (const f of [path.join(sessions, id, "events.jsonl"), path.join(sessions, id)]) utimesSync(f, old, old);
  }
  const ledger = ledgerOf(repo);
  ledger.sessions = [...ledger.sessions, "OLD-LISTED"];
  saveLedger(runDir(repo), ledger);
  run(repo, "session-start", [], JSON.stringify({ session_id: "S9", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" }), "S9");
  assert.equal(existsSync(path.join(sessions, "OLD")), false, "the stale session folder stayed");
  assert.equal(existsSync(path.join(sessions, "OLD-LISTED")), true, "a folder an open run lists was removed");
  assert.equal(existsSync(path.join(sessions, "RECENT")), true, "a recent folder was removed");
  // once a day: a second stale folder made now waits for tomorrow
  mkdirSync(path.join(sessions, "OLD2"), { recursive: true });
  utimesSync(path.join(sessions, "OLD2"), old, old);
  run(repo, "session-start", [], JSON.stringify({ session_id: "S8", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" }), "S8");
  assert.equal(existsSync(path.join(sessions, "OLD2")), true, "the prune ran twice in one day");
});

test("C8 idempotent: a ledger from before this change (no grewAt) checks and reports as before", () => {
  const repo = grown("ll-c8");
  const ledger = ledgerOf(repo);
  delete ledger.tier.grewAt;
  ledger.tier.predictedSeq = ledger.tier.predictedSeq ?? 1;
  saveLedger(runDir(repo), ledger);
  cli(repo, "check");
  assert.doesNotMatch(cli(repo, "report", ["--brief"]), /grew to large/);
});

test("C9 refused: a run planned large also needs the QA pass and a clean reviewer-2 round; an old qa waiver does not clear the QA pass", () => {
  const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
  const repo = planned("ll-c9", ["--files", LARGE.join(",")]);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", agent_id: "A-worker", agent_type: "done-gate:worker", tool_input: { file_path: path.join(repo, "src/a.ts") }, tool_output: "ok" });
  write(repo, "src/a.ts", lines(30, "a"));
  write(repo, "tests/a.test.ts", "test('a', () => { expect(1).toBe(1); });\n");
  cli(repo, "waive", ["qa", "an old ledger's tests waiver"]);
  let out = cli(repo, "check");
  assert.match(ruleLines(out, "R7"), /gate brief qa/, out);
  assert.match(ruleLines(out, "R9"), /reviewer-2/, out);
  cli(repo, "waive", ["qa-pass", "user: the tests came from the spec"]);
  cli(repo, "waive", ["review-2", "user: one reviewer is enough here"]);
  out = cli(repo, "check");
  assert.doesNotMatch(ruleLines(out, "R7"), /gate brief qa/, out);
  assert.equal(ruleLines(out, "R9"), "", out);
});

test("C10 edge: a grown run that shrinks back below large has no QA or reviewer-2 requirement; grown again, the QA pass that ran still counts", () => {
  const repo = grown("ll-c10");
  started(repo, "qa");
  lookedUp(repo, { agent: "A-qa", role: "qa" });
  stopped(repo, "qa");
  write(repo, "src/a.ts", lines(30, "a"));
  write(repo, "tests/a.test.ts", "test('a', () => { expect(1).toBe(1); });\n");
  let out = cli(repo, "check");
  assert.doesNotMatch(ruleLines(out, "R7"), /gate brief qa/, out);
  assert.equal(ruleLines(out, "R9"), "", out);
  write(repo, "src/a.ts", lines(430, "b"));
  out = cli(repo, "check");
  assert.doesNotMatch(ruleLines(out, "R7"), /gate brief qa/, "the QA pass that ran no longer counts");
  assert.match(ruleLines(out, "R9"), /reviewer-2/, out);

  // with no QA pass at all, shrinking back drops the requirement
  const none = grown("ll-c10-none");
  assert.match(ruleLines(cli(none, "check"), "R7"), /gate brief qa/, "premise: a grown run without QA owes it");
  write(none, "src/a.ts", lines(30, "a"));
  assert.doesNotMatch(ruleLines(cli(none, "check"), "R7"), /gate brief qa/);
});

test("C11 refused: the prune never removes this session, no-session, or a session a recent run lists; age is the newest of its files", () => {
  const repo = planned("ll-c11");
  const sessions = path.join(stateDir(repo), "sessions");
  const old = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  const stale = (id, freshEvents = false) => {
    mkdirSync(path.join(sessions, id), { recursive: true });
    for (const f of ["events.jsonl", "state.json"]) writeFileSync(path.join(sessions, id, f), f === "state.json" ? "{}" : "");
    for (const f of ["events.jsonl", "state.json", ""]) if (!(freshEvents && f === "events.jsonl")) utimesSync(path.join(sessions, id, f), old, old);
  };
  stale("S9");
  stale("no-session");
  stale("ACTIVE", true);
  stale("STATE-ONLY");
  utimesSync(path.join(sessions, "STATE-ONLY", "state.json"), new Date(), new Date());
  stale("CLOSED-RUN");
  stale("IDLE-OPEN");
  const ledger = ledgerOf(repo);
  ledger.sessions = [...ledger.sessions, "CLOSED-RUN"];
  ledger.status = "closed";
  saveLedger(runDir(repo), ledger);
  // an open run idle for 20 days keeps the sessions its rules read
  const idle = path.join(stateDir(repo), "runs", "2026-01-01-idle");
  mkdirSync(idle, { recursive: true });
  saveLedger(idle, { ...ledger, slug: "idle", status: "open", sessions: ["IDLE-OPEN"] });
  utimesSync(path.join(idle, "ledger.json"), old, old);
  run(repo, "session-start", [], JSON.stringify({ session_id: "S9", cwd: repo, hook_event_name: "SessionStart", session_start_source: "resume" }), "S9");
  for (const id of ["S9", "no-session", "ACTIVE", "STATE-ONLY", "CLOSED-RUN", "IDLE-OPEN"]) assert.equal(existsSync(path.join(sessions, id)), true, `${id} was removed`);
});
