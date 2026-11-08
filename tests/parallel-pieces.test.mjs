// parallel-pieces: pieces of one task run on up to four workers at once in one checkout. A
// worker moves no git state, the lead declares pieces with `gate plan pieces` and the gate
// groups them, and a worker's read of its packet tells which number it holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { asOldRun, gate, makeRepo, planChecked, readyToEdit } from "./helpers.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { workerRuns } from "../scripts/lib/rules.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function envFor(repo) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}
const run = (repo, args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, ...args) {
  const r = run(repo, args);
  assert.equal(r.status, 0, `gate ${args.join(" ")}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}
function refused(repo, ...args) {
  const r = run(repo, args);
  assert.notEqual(r.status, 0, `gate ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.match(r.stderr, /^done-gate: /m);
  return r.stderr;
}
const hook = (repo, payload) => execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), env: envFor(repo) });

// who: null for the lead, else [agent id, role]
function fence(repo, tool, tool_input, who = null) {
  const payload = { hook_event_name: "PreToolUse", session_id: "S1", cwd: repo, tool_name: tool, tool_input, ...(who ? { agent_id: who[0], agent_type: `done-gate:${who[1]}` } : {}) };
  const r = spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify(payload), encoding: "utf8", env: envFor(repo) });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : null;
}
const bash = (repo, command, who) => fence(repo, "Bash", { command }, who);

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runRel = (repo) => `.claude/gate/runs/${loadSession(stateDir(repo), "S1").current}`;
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(repo, runRel(repo), "ledger.json"), "utf8"));
const packets = (repo) => readEvents(stateDir(repo), "S1").filter((e) => e.kind === "packet");
const runsOf = (repo) => workerRuns({ ledger: ledgerOf(repo), events: readEvents(stateDir(repo), "S1") });

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/types.ts"];
function planned(name, { files = FILES.join(","), playbook = "feature" } = {}) {
  const repo = makeRepo(name, Object.fromEntries(FILES.map((f) => [f, "export const x = 1;\n"])));
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", name, playbook);
  readyToEdit(repo, { plan: files ? ["--files", files] : [] });
  if (ledgerOf(repo).checkHold) planChecked(repo);
  return repo;
}
const W1 = ["W1", "worker"];
const W2 = ["W2", "worker"];

test("C1 refused: a worker's git stash, checkout and commit are refused, naming the shared checkout", () => {
  const repo = planned("pp-c1");
  for (const cmd of ["git stash", "git stash -q", "git checkout .", "git commit -am wip", "cd src && git restore a.ts", "git -C . reset --hard"]) {
    const why = bash(repo, cmd, W1);
    assert.match(why ?? "", /worker/, `${cmd}: ${why}`);
    assert.match(why, /share/, `${cmd}: ${why}`);
    assert.match(why, /git diff/, `${cmd}: ${why}`);
  }
});

test("C2 happy: a worker's git diff, log and status pass, and so does its shell write to its own worker-<n>.md", () => {
  const repo = planned("pp-c2");
  for (const cmd of ["git diff", "git diff --stat src/a.ts", "git log --oneline -3", "git status --short", "git stash list"]) {
    assert.equal(bash(repo, cmd, W1), null, cmd);
  }
  assert.equal(bash(repo, `cd ${runRel(repo)} && cat > worker-1.md <<'E'\nx\nE`, W1), null);
});

test("C3 edge: the lead's git writes are not this rule's, and a reviewer's stay refused by the scratch rule", () => {
  const repo = planned("pp-c3");
  for (const cmd of ["git stash", "git commit -am wip"]) assert.equal(bash(repo, cmd), null, cmd);
  const reviewer = bash(repo, "git stash", ["R1", "reviewer"]);
  assert.match(reviewer ?? "", /never with git write commands/);
});

test("C4 happy: three pieces, two overlapping, print two groups with a brief line per piece", () => {
  const repo = planned("pp-c4");
  const out = cli(repo, "plan", "pieces", "src/a.ts,src/b.ts", "src/b.ts,src/c.ts", "src/d.ts");
  assert.match(out, /3 pieces in 2 groups/);
  const g1 = out.indexOf("group 1");
  const g2 = out.indexOf("group 2");
  assert.ok(g1 >= 0 && g2 > g1, out);
  const at = (line) => out.indexOf(`gate brief worker --files ${line}`);
  assert.ok(at("src/a.ts,src/b.ts") > g1 && at("src/a.ts,src/b.ts") < g2, out);
  assert.ok(at("src/d.ts") > g1 && at("src/d.ts") < g2, out);
  assert.ok(at("src/b.ts,src/c.ts") > g2, out);
  const { pieces } = ledgerOf(repo);
  assert.deepEqual(pieces.list, [["src/a.ts", "src/b.ts"], ["src/b.ts", "src/c.ts"], ["src/d.ts"]]);
  assert.deepEqual(pieces.groups, [[0, 2], [1]]);
  assert.deepEqual(pieces.shared, []);
  assert.match(out.trim().split("\n").at(-1), /^next:/);
});

test("C5 boundary: five disjoint pieces make a group of four and a group of one", () => {
  const repo = planned("pp-c5");
  const out = cli(repo, "plan", "pieces", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts");
  assert.match(out, /5 pieces in 2 groups/);
  assert.deepEqual(ledgerOf(repo).pieces.groups, [[0, 1, 2, 3], [4]]);
});

test("C6 edge: a piece holding a shared file runs alone, and a piece never runs before one it overlaps", () => {
  const repo = planned("pp-c6");
  cli(repo, "plan", "pieces", "src/types.ts,src/a.ts", "src/b.ts", "src/c.ts", "--shared", "src/types.ts");
  assert.deepEqual(ledgerOf(repo).pieces.groups, [[0], [1, 2]]);
  assert.deepEqual(ledgerOf(repo).pieces.shared, ["src/types.ts"]);
  // the fourth piece shares only with the third, which sits in group 2: it goes to group 3
  cli(repo, "plan", "pieces", "src/a.ts", "src/b.ts", "src/a.ts,src/c.ts", "src/c.ts,src/d.ts");
  assert.deepEqual(ledgerOf(repo).pieces.groups, [[0, 1], [2], [3]]);
  assert.deepEqual(ledgerOf(repo).pieces.shared, []);
});

test("C7 edge: one piece stays with the lead and stores no pieces", () => {
  const repo = planned("pp-c7");
  cli(repo, "plan", "pieces", "src/a.ts", "src/b.ts");
  assert.ok(ledgerOf(repo).pieces);
  const out = cli(repo, "plan", "pieces", "src/a.ts,src/b.ts");
  assert.match(out, /stays with the lead/);
  assert.equal(ledgerOf(repo).pieces, undefined);
});

test("C8 refused: a folder, a pattern, code outside the plan, an empty piece or an unheld shared file store nothing", () => {
  const repo = planned("pp-c8", { files: "src/a.ts,src/b.ts,src/c.ts" });
  assert.match(refused(repo, "plan", "pieces", "src/", "src/b.ts"), /folder or a pattern/);
  assert.match(refused(repo, "plan", "pieces", "src", "src/b.ts"), /folder or a pattern/);
  assert.match(refused(repo, "plan", "pieces", "src/*.ts", "src/b.ts"), /folder or a pattern/);
  assert.match(refused(repo, "plan", "pieces", "src/a.ts", "src/d.ts"), /src\/d\.ts.*not in this task's plan[\s\S]*gate plan add/);
  assert.match(refused(repo, "plan", "pieces", "src/a.ts", ""), /names no file/);
  assert.match(refused(repo, "plan", "pieces", "src/a.ts", " , "), /names no file/);
  assert.match(refused(repo, "plan", "pieces", "src/a.ts", "src/b.ts", "--shared", "src/c.ts"), /src\/c\.ts.*in no piece/);
  assert.match(refused(repo, "plan", "pieces", "src/a.ts", "../x.ts"), /outside|not a file inside/);
  assert.match(refused(repo, "plan", "pieces"), /usage: gate plan pieces/);
  assert.equal(ledgerOf(repo).pieces, undefined);
  // a test or doc is plan-free, and counts for overlap
  cli(repo, "plan", "pieces", "src/a.ts,tests/shared.test.ts", "src/b.ts,tests/shared.test.ts", "src/c.ts,README.md");
  assert.deepEqual(ledgerOf(repo).pieces.groups, [[0, 2], [1]]);
});

test("C9 refused: pieces on a run under the old rules or on a run with no file plan", () => {
  const old = planned("pp-c9-old");
  asOldRun(old);
  assert.match(refused(old, "plan", "pieces", "src/a.ts", "src/b.ts"), /opened before/);
  const inv = planned("pp-c9-inv", { files: null, playbook: "investigation" });
  assert.match(refused(inv, "plan", "pieces", "src/a.ts", "src/b.ts"), /no file plan/);
});

test("C10 happy: each worker's packet read names its number, by Read and by cat", () => {
  const repo = planned("pp-c10");
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "W1", agent_type: "done-gate:worker" });
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "W2", agent_type: "done-gate:worker" });
  assert.equal(fence(repo, "Read", { file_path: path.join(repo, runRel(repo), "brief-worker-1.md") }, W1), null);
  assert.equal(bash(repo, `cat ${path.join(repo, runRel(repo), "brief-worker-2.md")}`, W2), null);
  assert.deepEqual(packets(repo).map((e) => [e.agent, e.n]), [["W1", 1], ["W2", 2]]);
  const byAgent = Object.fromEntries(runsOf(repo).map((r) => [r.agent, r]));
  assert.deepEqual(byAgent.W1, { agent: "W1", n: 1, running: true });
  assert.deepEqual(byAgent.W2, { agent: "W2", n: 2, running: true });
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "W2", agent_type: "done-gate:worker" });
  const after = Object.fromEntries(runsOf(repo).map((r) => [r.agent, r]));
  assert.equal(after.W1.running, true);
  assert.deepEqual(after.W2, { agent: "W2", n: 2, running: false });
});

test("C11 edge: a re-read moves the worker's number; other roles, other runs and two numbers log nothing", () => {
  const repo = planned("pp-c11");
  const packet = (n) => path.join(repo, runRel(repo), `brief-worker-${n}.md`);
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "W1", agent_type: "done-gate:worker" });
  fence(repo, "Read", { file_path: packet(1) }, W1);
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "W1", agent_type: "done-gate:worker" });
  // resumed with another packet (SendMessage): a new start, then the read
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "W1", agent_type: "done-gate:worker" });
  bash(repo, `cd ${runRel(repo)} && sed -n 1,40p brief-worker-3.md`, W1);
  assert.deepEqual(runsOf(repo), [{ agent: "W1", n: 3, running: true }]);
  const before = packets(repo).length;
  fence(repo, "Read", { file_path: packet(1) }, ["R1", "reviewer"]);
  fence(repo, "Read", { file_path: packet(1) });
  bash(repo, "cat .claude/gate/runs/2026-01-01-other/brief-worker-5.md", W1);
  bash(repo, `cat ${packet(1)} ${packet(2)}`, W1);
  fence(repo, "Read", { file_path: path.join(repo, runRel(repo), "brief-reviewer-1.md") }, W1);
  assert.equal(packets(repo).length, before);
});

test("C12 refused: two pieces with the same files, in any order or case, would share one worker number", () => {
  const repo = planned("pp-c12");
  assert.match(refused(repo, "plan", "pieces", "src/a.ts,src/b.ts", "src/c.ts", "src/b.ts,src/a.ts"), /pieces 1 and 3 name the same files/);
  assert.match(refused(repo, "plan", "pieces", "src/a.ts", "src/a.ts,src/a.ts"), /pieces 1 and 2 name the same files/);
  assert.equal(ledgerOf(repo).pieces, undefined);
});

test("C13 edge: overlap folds case where the file system does, so one file never sits in two pieces of a group", async () => {
  const { groupPieces } = await import("../scripts/lib/size.mjs");
  const { IGNORE_CASE } = await import("../scripts/lib/paths.mjs");
  assert.deepEqual(groupPieces([["src/A.ts"], ["src/a.ts"]]), IGNORE_CASE ? [[0], [1]] : [[0, 1]]);
  assert.deepEqual(groupPieces([["src/T.ts", "src/x.ts"], ["src/y.ts"]], ["src/t.ts"]), IGNORE_CASE ? [[0], [1]] : [[0, 1]]);
});

test("C14 refused: --shared takes a comma list and is refused when given twice", () => {
  const repo = planned("pp-c14");
  cli(repo, "plan", "pieces", "src/types.ts,src/a.ts", "src/b.ts", "src/e.ts,src/c.ts", "--shared", "src/types.ts,src/e.ts");
  assert.deepEqual(ledgerOf(repo).pieces.groups, [[0], [1], [2]]);
  assert.deepEqual(ledgerOf(repo).pieces.shared, ["src/types.ts", "src/e.ts"]);
  assert.match(refused(repo, "plan", "pieces", "src/types.ts,src/a.ts", "src/e.ts", "--shared", "src/types.ts", "--shared", "src/e.ts"), /--shared once, as a comma list/);
});

test("C15 edge: a worker reading a sibling's packet keeps its own number; its newest start resets it", () => {
  const repo = planned("pp-c15");
  const packet = (n) => path.join(repo, runRel(repo), `brief-worker-${n}.md`);
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "W1", agent_type: "done-gate:worker" });
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "W2", agent_type: "done-gate:worker" });
  fence(repo, "Read", { file_path: packet(1) }, W1);
  fence(repo, "Read", { file_path: packet(2) }, W2);
  fence(repo, "Read", { file_path: packet(2) }, W1);
  bash(repo, `cat ${packet(1)}`, W2);
  const byAgent = Object.fromEntries(runsOf(repo).map((r) => [r.agent, r.n]));
  assert.deepEqual(byAgent, { W1: 1, W2: 2 });
});
