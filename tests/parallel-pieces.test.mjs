// parallel-pieces: pieces of one task run on up to four workers at once in one checkout. A
// worker moves no git state, the lead declares pieces with `gate plan pieces` and the gate
// groups them, and a worker's read of its packet tells which number it holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gate, makeRepo, planChecked, readyToEdit } from "./helpers.mjs";
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
function planned(name, { files = FILES.join(","), playbook = "feature", extra = {} } = {}) {
  const repo = makeRepo(name, { ...Object.fromEntries(FILES.map((f) => [f, "export const x = 1;\n"])), ...extra });
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

test("C9 refused: pieces on a run with no file plan", () => {
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

// 7.2: on a pieces run a worker keeps to its piece and the briefs follow the groups

// verify reads red.flag: present, it fails
const VERIFY = {
  ".claude/gate.json": JSON.stringify({ testFiles: null, strength: false, verify: [{ cmd: "node check.mjs" }] }),
  "check.mjs": 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("red.flag") ? 1 : 0);\n',
};
const started = (repo, id) => hook(repo, { hook_event_name: "SubagentStart", agent_id: id, agent_type: "done-gate:worker" });
const stopped = (repo, id) => hook(repo, { hook_event_name: "SubagentStop", agent_id: id, agent_type: "done-gate:worker" });
const packetPath = (repo, n) => path.join(repo, runRel(repo), `brief-worker-${n}.md`);
// a worker briefed on files, spawned and reading its packet: its number
function spawned(repo, id, files) {
  const n = Number(/brief-worker-(\d+)\.md/.exec(cli(repo, "brief", "worker", ...(files ? ["--files", files] : [])))[1]);
  started(repo, id);
  assert.equal(fence(repo, "Read", { file_path: packetPath(repo, n) }, [id, "worker"]), null);
  return n;
}
const editAs = (repo, rel, who = null) => fence(repo, "Edit", { file_path: path.join(repo, rel), old_string: "x", new_string: "y" }, who);
const writeAs = (repo, rel, who = null) => fence(repo, "Write", { file_path: path.join(repo, rel), content: "x" }, who);
function editedBy(repo, rel, id) {
  writeFileSync(path.join(repo, rel), "export const y = 2;\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(repo, rel) }, tool_response: {}, ...(id ? { agent_id: id, agent_type: "done-gate:worker" } : {}) });
}
// pieces a | b | a,c: group 1 holds a and b, group 2 holds a,c
function pieced(name, pieces = ["src/a.ts", "src/b.ts", "src/a.ts,src/c.ts"]) {
  const repo = planned(name, { extra: VERIFY });
  cli(repo, "plan", "pieces", ...pieces);
  return repo;
}
const W3 = ["W3", "worker"];

test("7.2 C1 refused: a worker's Edit of code in another piece or outside its own is refused", () => {
  const repo = pieced("pp2-c1");
  spawned(repo, "W1", "src/a.ts");
  spawned(repo, "W2", "src/b.ts");
  for (const rel of ["src/b.ts", "src/d.ts"]) {
    const why = editAs(repo, rel, W1);
    assert.match(why ?? "", new RegExp(`${rel.replace(".", "\\.")} is outside your piece`), why);
    assert.match(why, /stop and tell the lead/);
  }
});

test("7.2 C2 happy: a bound worker edits its own piece and a new test no other piece lists", () => {
  const repo = pieced("pp2-c2");
  spawned(repo, "W1", "src/a.ts");
  assert.equal(editAs(repo, "src/a.ts", W1), null);
  assert.equal(writeAs(repo, "tests/new.test.ts", W1), null);
  assert.equal(writeAs(repo, "docs/notes.md", W1), null);
});

test("7.2 C3 refused: a worker that has not read its packet edits nothing until it does", () => {
  const repo = pieced("pp2-c3");
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  started(repo, "W3");
  assert.match(editAs(repo, "src/a.ts", W3) ?? "", /read your packet first/);
  assert.match(writeAs(repo, "tests/new.test.ts", W3) ?? "", /read your packet first/);
  fence(repo, "Read", { file_path: packetPath(repo, 1) }, W3);
  assert.equal(editAs(repo, "src/a.ts", W3), null);
});

test("7.2 C4 refused: a test or doc another piece lists, or another running worker edited, is not a worker's", () => {
  const repo = pieced("pp2-c4", ["src/a.ts,tests/a.test.ts,docs/notes.md", "src/b.ts", "src/c.ts"]);
  spawned(repo, "W1", "src/a.ts,tests/a.test.ts,docs/notes.md");
  spawned(repo, "W2", "src/b.ts");
  assert.match(editAs(repo, "tests/a.test.ts", W2) ?? "", /tests\/a\.test\.ts is in another piece/);
  assert.match(editAs(repo, "docs/notes.md", W2) ?? "", /docs\/notes\.md is in another piece/);
  assert.equal(writeAs(repo, "tests/new.test.ts", W1), null);
  editedBy(repo, "tests/new.test.ts", "W1");
  assert.match(editAs(repo, "tests/new.test.ts", W2) ?? "", /another worker .*still running/);
  stopped(repo, "W1");
  assert.equal(editAs(repo, "tests/new.test.ts", W2), null);
});

test("7.2 C5 edge: no pieces, or a worker briefed without --files, keeps the old reach", () => {
  const plain = planned("pp2-c5-plain", { extra: VERIFY });
  started(plain, "W1");
  assert.equal(editAs(plain, "src/b.ts", W1), null);
  const repo = pieced("pp2-c5");
  spawned(repo, "W1", null);
  assert.equal(editAs(repo, "src/b.ts", W1), null);
  assert.equal(editAs(repo, "src/d.ts", W1), null);
});

test("7.2 C6 refused: a running worker's file is refused to the lead's shell and Edit and to another worker's shell", () => {
  const repo = pieced("pp2-c6");
  const n = spawned(repo, "W1", "src/a.ts");
  spawned(repo, "W2", "src/b.ts");
  for (const why of [bash(repo, "echo x > src/a.ts"), editAs(repo, "src/a.ts"), bash(repo, "sed -i '' s/x/y/ src/a.ts", W2), bash(repo, `node -e "require('fs').writeFileSync('src/a.ts','x')"`)]) {
    assert.match(why ?? "", new RegExp(`src/a\\.ts is in worker ${n}'s piece, and that worker is still running`), why);
  }
  assert.equal(bash(repo, "sed -i '' s/x/y/ src/a.ts", W1), null);
  assert.equal(bash(repo, "echo x > src/d.ts"), null);
  stopped(repo, "W1");
  assert.equal(bash(repo, "echo x > src/a.ts"), null);
  assert.equal(editAs(repo, "src/a.ts"), null);
});

test("7.2 C7 refused: a worker brief must name a piece, and a bare one waits while a worker runs", () => {
  const repo = pieced("pp2-c7");
  const why = refused(repo, "brief", "worker", "--files", "src/d.ts");
  assert.match(why, /src\/d\.ts is not one of this run's pieces/);
  assert.match(why, /gate brief worker --files src\/a\.ts,src\/c\.ts/);
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/b.ts"), /not one of this run's pieces/);
  spawned(repo, "W1", "src/a.ts");
  assert.match(refused(repo, "brief", "worker"), /worker 1 is still running/);
  stopped(repo, "W1");
  cli(repo, "brief", "worker");
});

test("7.2 C8 refused: a piece whose worker still runs is not briefed again", () => {
  const repo = pieced("pp2-c8");
  const n = spawned(repo, "W1", "src/a.ts");
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts"), new RegExp(`worker ${n} is still running`));
  stopped(repo, "W1");
  assert.match(cli(repo, "brief", "worker", "--files", "src/a.ts"), new RegExp(`brief-worker-${n}\\.md`));
});

test("7.2 C9 refused: group 2's first brief waits for group 1's workers and a green verify", () => {
  const repo = pieced("pp2-c9");
  spawned(repo, "W1", "src/a.ts");
  spawned(repo, "W2", "src/b.ts");
  stopped(repo, "W2");
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /group 2 waits for group 1: worker 1 is still running/);
  stopped(repo, "W1");
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /group 2 starts once `gate verify` is green[\s\S]*no verify\.json/);
  writeFileSync(path.join(repo, "red.flag"), "");
  run(repo, ["verify"]);
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /group 2 starts once `gate verify` is green[\s\S]*red/);
  rmSync(path.join(repo, "red.flag"));
  cli(repo, "verify");
  editedBy(repo, "src/b.ts", null);
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /stale/);
  cli(repo, "verify");
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
});

test("7.2 C10 happy: a review round's re-brief of a group 2 piece is not held by the group order", () => {
  const repo = pieced("pp2-c10");
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  cli(repo, "brief", "worker", "--files", "src/b.ts");
  cli(repo, "verify");
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
  writeFileSync(path.join(repo, "red.flag"), "");
  run(repo, ["verify"]);
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
});

test("7.2 C11 refused: a reviewer brief and gate plan pieces wait while a worker runs", () => {
  const repo = pieced("pp2-c11");
  spawned(repo, "W1", "src/a.ts");
  editedBy(repo, "src/a.ts", "W1");
  assert.match(refused(repo, "brief", "reviewer"), /worker 1 is still running/);
  assert.match(refused(repo, "brief", "reviewer-2"), /worker 1 is still running/);
  assert.match(refused(repo, "plan", "pieces", "src/a.ts", "src/b.ts"), /worker 1 is still running/);
  stopped(repo, "W1");
  cli(repo, "plan", "pieces", "src/a.ts", "src/b.ts");
  cli(repo, "brief", "reviewer");
});

test("7.2 C12 edge: --files spelled in another case takes the piece's own spelling and number where the file system folds case", async () => {
  const { IGNORE_CASE } = await import("../scripts/lib/paths.mjs");
  const repo = pieced("pp2-c12");
  const n = Number(/brief-worker-(\d+)\.md/.exec(cli(repo, "brief", "worker", "--files", "src/a.ts"))[1]);
  if (!IGNORE_CASE) {
    assert.match(refused(repo, "brief", "worker", "--files", "SRC/A.ts"), /not one of this run's pieces/);
    return;
  }
  assert.match(cli(repo, "brief", "worker", "--files", "SRC/A.ts"), new RegExp(`brief-worker-${n}\\.md`));
  assert.deepEqual(ledgerOf(repo).briefed[`worker-${n}.md`].files, ["src/a.ts"]);
});

test("7.2 C13 refused: group 2's first brief waits while a group 1 piece was never briefed", () => {
  const repo = pieced("pp2-c13");
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  cli(repo, "verify");
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /group 2 waits for group 1: src\/b\.ts has not been briefed/);
  cli(repo, "brief", "worker", "--files", "src/b.ts");
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
});

test("7.2 C14 edge: a worker resumed for a review round keeps its number; an unbound one is told where its packet is", () => {
  const repo = pieced("pp2-c14");
  const n = spawned(repo, "W1", "src/a.ts");
  stopped(repo, "W1");
  started(repo, "W1");
  assert.deepEqual(runsOf(repo), [{ agent: "W1", n, running: true }]);
  assert.equal(editAs(repo, "src/a.ts", W1), null);
  started(repo, "W3");
  assert.match(editAs(repo, "src/a.ts", W3) ?? "", new RegExp(`read your packet first: the brief-worker-<n>\\.md in ${runRel(repo).replace(/[.]/g, "\\.")} that your prompt names`));
});

test("7.2 C15 edge: decide with no state dir, or on a run with no pieces, reads no events and never throws", async () => {
  const { decide } = await import("../scripts/lib/guard.mjs");
  const repo = pieced("pp2-c15");
  started(repo, "W1");
  const ledger = ledgerOf(repo);
  const worker = { agent_id: "W1", agent_type: "done-gate:worker" };
  const edit = { tool_name: "Edit", tool_input: { file_path: path.join(repo, "src/b.ts"), old_string: "x", new_string: "y" }, ...worker };
  const shell = { tool_name: "Bash", tool_input: { command: "echo x > src/a.ts" } };
  for (const input of [edit, shell]) {
    assert.equal(decide(input, repo, null, runRel(repo), ledger).deny, false);
    assert.equal(decide(input, repo, null, runRel(repo), ledger, { stateDir: stateDir(repo), session: "S1", unreadable: true }).deny, false);
    assert.doesNotThrow(() => decide(input, repo, null, null, null));
  }
});

// 7.3: the packet explains sharing a checkout, and the hints walk the groups

const packetText = (out) => readFileSync(/packet: (\S+)/.exec(out)[1], "utf8");
const sectionOf = (text, name) => {
  const at = text.indexOf(`## ${name}\n`);
  if (at < 0) return null;
  const rest = text.slice(at + name.length + 4);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
};
// a pieces run at its implement step
function atImplement(repo) {
  cli(repo, "step", "tests", "done", "wrote the tests, red first", "--evidence", "tests/a.test.ts");
  assert.match(cli(repo, "next"), /^next: step \d+: implement/m);
}

test("7.3 C1 happy: each worker's packet lists the other pieces' files as not its own", () => {
  const repo = pieced("pp3-c1");
  const one = packetText(cli(repo, "brief", "worker", "--files", "src/a.ts"));
  const others = sectionOf(one, "Other pieces");
  assert.ok(others, one);
  assert.match(others, /src\/b\.ts/);
  assert.match(others, /src\/c\.ts/);
  assert.doesNotMatch(others, /src\/a\.ts/);
  assert.match(others, /do not touch/i);
  assert.match(others, /not yours[^.]*report it/i);
  assert.doesNotMatch(sectionOf(one, "Files you own"), /src\/b\.ts/);
  const two = sectionOf(packetText(cli(repo, "brief", "worker", "--files", "src/b.ts")), "Other pieces");
  assert.match(two, /src\/a\.ts/);
  assert.doesNotMatch(two, /src\/b\.ts/);
});

test("7.3 C2 edge: a file the packet owns is never listed as another piece's; no pieces, or no --files, has no such section", () => {
  const repo = pieced("pp3-c2");
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  cli(repo, "brief", "worker", "--files", "src/b.ts");
  cli(repo, "verify");
  const late = sectionOf(packetText(cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts")), "Other pieces");
  assert.match(late, /src\/b\.ts/);
  assert.doesNotMatch(late, /src\/a\.ts|src\/c\.ts/);
  assert.equal(sectionOf(packetText(cli(repo, "brief", "worker")), "Other pieces"), null);
  const plain = planned("pp3-c2-plain", { extra: VERIFY });
  assert.equal(sectionOf(packetText(cli(plain, "brief", "worker", "--files", "src/a.ts")), "Other pieces"), null);
});

test("7.3 C3 happy: the worker packet's tests section is Tests so far", () => {
  const repo = pieced("pp3-c3");
  editedBy(repo, "tests/a.test.ts", null);
  const text = packetText(cli(repo, "brief", "worker", "--files", "src/a.ts"));
  assert.match(sectionOf(text, "Tests so far") ?? "", /tests\/a\.test\.ts/);
  assert.doesNotMatch(text, /Tests already written/);
});

test("7.3 C4 happy: gate next walks the groups: group 1's briefs, then group 2's in full, then verify", () => {
  const repo = pieced("pp3-c4");
  atImplement(repo);
  const first = cli(repo, "next");
  assert.match(first, /group 1 of 2/);
  assert.match(first, /`gate brief worker --files src\/a\.ts`/);
  assert.match(first, /`gate brief worker --files src\/b\.ts`/);
  assert.doesNotMatch(first, /--files src\/a\.ts,src\/c\.ts/);
  assert.match(first, /`gate verify`/);
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  const second = cli(repo, "brief", "worker", "--files", "src/b.ts");
  assert.match(second, /group 2 of 2[\s\S]*`gate brief worker --files src\/a\.ts,src\/c\.ts`/, second);
  cli(repo, "verify");
  const last = cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
  assert.match(last, /every piece is briefed/, last);
  assert.doesNotMatch(last, /group \d of 2/);
});

test("7.3 C5 edge: a run with no pieces keeps the old implement hint", () => {
  const repo = planned("pp3-c5", { extra: VERIFY });
  atImplement(repo);
  const hint = cli(repo, "next");
  assert.doesNotMatch(hint, /group \d|gate brief worker --files|every piece/);
  assert.match(hint, /implement, keeping the diff to the plan/);
});

test("7.3 C6 refused: implement stays open on a green verify while a group is unbriefed", () => {
  const stepOf = (repo) => ledgerOf(repo).steps.find((s) => s.key === "implement").state;
  const repo = pieced("pp3-c6");
  atImplement(repo);
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  cli(repo, "brief", "worker", "--files", "src/b.ts");
  editedBy(repo, "src/a.ts", null);
  cli(repo, "verify");
  cli(repo, "check");
  assert.equal(stepOf(repo), null);
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
  cli(repo, "check");
  assert.equal(stepOf(repo), "DONE");
});

test("7.3 C7 reported-surface: the skill, session start, README and worker role name pieces and the 4-at-once groups", async () => {
  const { pluginRoot } = await import("./helpers.mjs");
  const { statSync } = await import("node:fs");
  const doc = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");
  assert.ok(statSync(path.join(pluginRoot, "skills/gate/SKILL.md")).size < 4096);
  const skill = doc("skills/gate/SKILL.md");
  assert.match(skill, /gate plan pieces/);
  assert.match(skill, /at most 4 workers at once/i);
  assert.doesNotMatch(skill, /ten helpers/i);
  for (const rel of ["hooks/session-start.md", "README.md"]) {
    assert.match(doc(rel), /gate plan pieces/, rel);
    assert.match(doc(rel), /4 workers at once|4 at once/, rel);
  }
  assert.match(doc("agents/worker.md"), /Other pieces/);
  assert.match(doc("agents/worker.md"), /report it/i);
});

test("7.3 C8 refused: implement stays open on a green verify while a worker runs, with every piece briefed", () => {
  const stepOf = (repo) => ledgerOf(repo).steps.find((s) => s.key === "implement").state;
  const repo = pieced("pp3-c8");
  atImplement(repo);
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  cli(repo, "brief", "worker", "--files", "src/b.ts");
  cli(repo, "verify");
  spawned(repo, "W1", "src/a.ts,src/c.ts");
  editedBy(repo, "src/b.ts", null);
  cli(repo, "verify");
  cli(repo, "check");
  assert.equal(stepOf(repo), null);
  stopped(repo, "W1");
  cli(repo, "check");
  assert.equal(stepOf(repo), "DONE");
});

test("7.3 C9 edge: each group's hint and the last one print in full after the plain implement hint was shown", () => {
  const repo = planned("pp3-c9", { extra: VERIFY });
  const plain = cli(repo, "step", "tests", "done", "wrote the tests, red first", "--evidence", "tests/a.test.ts");
  assert.match(plain, /^next: step \d+: implement, keeping/m);
  assert.match(cli(repo, "plan", "pieces", "src/a.ts", "src/b.ts", "src/a.ts,src/c.ts"), /^next: step \d+: implement in groups: group 1 of 2/m);
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  assert.match(cli(repo, "brief", "worker", "--files", "src/b.ts"), /group 2 of 2/);
  cli(repo, "verify");
  assert.match(cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /every piece is briefed/);
});

test("7.3 C10 reported-surface: the Test command line and the worker role say tests so far", async () => {
  const { pluginRoot } = await import("./helpers.mjs");
  const repo = pieced("pp3-c10");
  const command = sectionOf(packetText(cli(repo, "brief", "worker", "--files", "src/a.ts")), "Test command");
  assert.match(command, /run the tests so far and the tests of the files you own/);
  const role = readFileSync(path.join(pluginRoot, "agents/worker.md"), "utf8");
  assert.doesNotMatch(role, /tests already written/i);
});

// 7.4: a failed worker holds only its own piece, and the whole route end to end

const cutOff = (repo, id) => hook(repo, { hook_event_name: "UserPromptSubmit", prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "Worker" stopped at its 100-turn limit (partial result; SendMessage to task-id to continue)</summary>\n</task-notification>` });

test("7.4 C1 happy: one of three workers cut off stops counting as running; the others run on and their edits stay", () => {
  const repo = pieced("pp4-c1", ["src/a.ts", "src/b.ts", "src/c.ts"]);
  spawned(repo, "W1", "src/a.ts");
  spawned(repo, "W2", "src/b.ts");
  spawned(repo, "W3", "src/c.ts");
  cutOff(repo, "W2");
  const running = Object.fromEntries(runsOf(repo).map((r) => [r.agent, r.running]));
  assert.deepEqual(running, { W1: true, W2: false, W3: true });
  editedBy(repo, "src/a.ts", "W1");
  editedBy(repo, "src/c.ts", "W3");
  stopped(repo, "W1");
  stopped(repo, "W3");
  const edits = readEvents(stateDir(repo), "S1").filter((e) => e.kind === "edit").map((e) => [e.agent, e.path]);
  assert.deepEqual(edits, [["W1", "src/a.ts"], ["W3", "src/c.ts"]]);
  assert.equal(editAs(repo, "src/b.ts"), null, "a cut worker's file is free again");
});

test("7.4 C2 happy: gate diagnose names a cut worker's piece and re-briefs that piece", async () => {
  const { helperProblems } = await import("../scripts/lib/diagnose.mjs");
  const repo = pieced("pp4-c2", ["src/a.ts", "src/b.ts", "src/c.ts"]);
  spawned(repo, "W1", "src/a.ts");
  spawned(repo, "W2", "src/b.ts");
  cutOff(repo, "W2");
  assert.match(cli(repo, "diagnose"), /worker W2 on src\/b\.ts stopped at its turn limit/);
  const later = Date.now() + 46 * 60 * 1000;
  const gone = helperProblems({ events: readEvents(stateDir(repo), "S1"), ledger: ledgerOf(repo), dir: path.join(repo, runRel(repo)), root: repo, now: later }).find((p) => p.agent === "W1");
  assert.match(gone.line, /worker W1 on src\/a\.ts has been silent/);
  assert.match(gone.line, /`gate brief worker --files src\/a\.ts` and spawn a fresh one/);
});

function cutGroupOne(name) {
  const repo = pieced(name);
  spawned(repo, "W1", "src/a.ts");
  spawned(repo, "W2", "src/b.ts");
  cutOff(repo, "W1");
  stopped(repo, "W2");
  cli(repo, "verify");
  return repo;
}

test("7.4 C3 refused: group 2 waits while a group 1 worker is cut off and not handled", () => {
  const repo = cutGroupOne("pp4-c3");
  const why = refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
  assert.match(why, /group 2 waits for group 1: worker 1 on src\/a\.ts was cut off/);
  assert.match(why, /gate diagnose/);
});

test("7.4 C4 happy: a re-brief of the cut piece keeps its number, binds the new agent, then group 2 goes", () => {
  const repo = cutGroupOne("pp4-c4");
  assert.match(cli(repo, "brief", "worker", "--files", "src/a.ts"), /brief-worker-1\.md/);
  started(repo, "W9");
  fence(repo, "Read", { file_path: packetPath(repo, 1) }, ["W9", "worker"]);
  assert.deepEqual(runsOf(repo).find((r) => r.agent === "W9"), { agent: "W9", n: 1, running: true });
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /worker 1 is still running/);
  stopped(repo, "W9");
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
});

test("7.4 C5 happy: gate diagnose --handled on the cut worker lets group 2 go", () => {
  const repo = cutGroupOne("pp4-c5");
  cli(repo, "diagnose", "--handled", "W1");
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
});

test("7.4 C6 happy: end to end, four workers at once, then group 2, then one review holding every piece", () => {
  const repo = pieced("pp4-c6", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/a.ts,src/e.ts"]);
  assert.deepEqual(ledgerOf(repo).pieces.groups, [[0, 1, 2, 3], [4]]);
  atImplement(repo);
  const one = [["W1", "src/a.ts"], ["W2", "src/b.ts"], ["W3", "src/c.ts"], ["W4", "src/d.ts"]];
  for (const [id, file] of one) spawned(repo, id, file);
  for (const [id, file] of one) {
    assert.equal(editAs(repo, file, [id, "worker"]), null, `${id} on ${file}`);
    assert.equal(bash(repo, `sed -i '' s/x/x/ ${file}`, [id, "worker"]), null, `${id} shell on ${file}`);
  }
  for (const [id, file] of one) editedBy(repo, file, id);
  for (const [id] of one) stopped(repo, id);
  cli(repo, "verify");
  spawned(repo, "W5", "src/a.ts,src/e.ts");
  for (const file of ["src/a.ts", "src/e.ts"]) {
    assert.equal(editAs(repo, file, ["W5", "worker"]), null);
    editedBy(repo, file, "W5");
  }
  stopped(repo, "W5");
  cli(repo, "verify");
  const edits = readEvents(stateDir(repo), "S1").filter((e) => e.kind === "edit").map((e) => `${e.agent}:${e.path}`);
  assert.deepEqual(edits, ["W1:src/a.ts", "W2:src/b.ts", "W3:src/c.ts", "W4:src/d.ts", "W5:src/a.ts", "W5:src/e.ts"]);
  assert.equal(readEvents(stateDir(repo), "S1").filter((e) => e.kind === "deny").length, 0, "no refusal on the way");
  const packet = packetText(cli(repo, "brief", "reviewer"));
  for (const f of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]) assert.match(packet, new RegExp(`\\+\\+\\+ b/${f.replace(".", "\\.")}`), f);
});

test("7.4 C9 happy: once a fresh worker finished the cut piece, diagnose lists nothing; failures on one piece count together", async () => {
  const { helperProblems } = await import("../scripts/lib/diagnose.mjs");
  const repo = cutGroupOne("pp4-c9");
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  started(repo, "W9");
  fence(repo, "Read", { file_path: packetPath(repo, 1) }, ["W9", "worker"]);
  cutOff(repo, "W9");
  const problems = () => helperProblems({ events: readEvents(stateDir(repo), "S1"), ledger: ledgerOf(repo), dir: path.join(repo, runRel(repo)), root: repo });
  assert.deepEqual(problems().map((p) => [p.agent, p.attempts]), [["W9", 2]]);
  started(repo, "W8");
  fence(repo, "Read", { file_path: packetPath(repo, 1) }, ["W8", "worker"]);
  stopped(repo, "W8");
  assert.deepEqual(problems(), []);
  assert.match(cli(repo, "diagnose"), /no helper problems/);
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
});

test("7.4 C10 edge: a worker cut before it read its packet names no piece and still holds the next group", () => {
  const repo = pieced("pp4-c10");
  spawned(repo, "W1", "src/a.ts");
  cli(repo, "brief", "worker", "--files", "src/b.ts");
  started(repo, "W2");
  cutOff(repo, "W2");
  stopped(repo, "W1");
  cli(repo, "verify");
  assert.match(cli(repo, "diagnose"), /worker W2 stopped at its turn limit/);
  assert.doesNotMatch(cli(repo, "diagnose"), /W2 on /);
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /worker W2 was cut off before it read its packet/);
  cli(repo, "diagnose", "--handled", "W2");
  cli(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts");
});

test("7.4 C11 refused: a cut piece holds the reviewer brief and the implement step's self-close", () => {
  const repo = pieced("pp4-c11", ["src/a.ts", "src/b.ts"]);
  atImplement(repo);
  spawned(repo, "W1", "src/a.ts");
  spawned(repo, "W2", "src/b.ts");
  editedBy(repo, "src/a.ts", "W1");
  stopped(repo, "W1");
  cutOff(repo, "W2");
  cli(repo, "verify");
  cli(repo, "check");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "implement").state, null);
  assert.match(refused(repo, "brief", "reviewer"), /worker 2 on src\/b\.ts was cut off/);
  cli(repo, "diagnose", "--handled", "W2");
  cli(repo, "check");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "implement").state, "DONE");
  cli(repo, "brief", "reviewer");
});

test("7.4 C12 refused: re-briefing the cut piece without spawning a worker keeps the next group waiting", () => {
  const repo = cutGroupOne("pp4-c12");
  cli(repo, "brief", "worker", "--files", "src/a.ts");
  assert.match(refused(repo, "brief", "worker", "--files", "src/a.ts,src/c.ts"), /worker 1 on src\/a\.ts was cut off/);
});
