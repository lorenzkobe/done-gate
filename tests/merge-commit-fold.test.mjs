import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, write, abandonArgs } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { readEvents, sessionDir } from "../scripts/lib/events.mjs";
import { gitMoves } from "../scripts/lib/guard.mjs";
import { commandReflog, gitBrought, headReflog } from "../scripts/lib/tree.mjs";
import { broughtSinceOpen } from "../scripts/lib/assess.mjs";

// From the 0.20.0 review, 3.1: a run that only brought another branch in was measured from the
// incoming commits. A merge stopped on a conflict and finished with `git commit` counted every
// file the merge brought in; what a merge commit brings from its other side is git's move.

const FILES = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
const env = (repo) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" });
const run = (repo, ...args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: env(repo) });
const hook = (repo, payload) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PostToolUse", tool_response: {}, ...payload }), encoding: "utf8", env: env(repo) });
const git = (repo, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// a Bash call as the hooks see it: the fence logs its start, `work` does what the command does,
// PostToolUse logs its end, so the files it wrote fall inside its run
let call = 0;
function shell(repo, command, work = () => {}) {
  const id = { tool_use_id: `T${++call}` };
  spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...id }), encoding: "utf8", env: env(repo) });
  try {
    work();
  } catch {
    // a merge that stops on a conflict exits non-zero
  }
  hook(repo, { tool_name: "Bash", tool_input: { command }, ...id });
}
const editTool = (repo, rel, content) => {
  write(repo, rel, content);
  hook(repo, { tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) } });
};
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const ledgerOf = (repo) => loadLedger(path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current));
// the files folded out of the run as git's, after an assess
function folded(repo) {
  run(repo, "check");
  return ledgerOf(repo).foreign ?? [];
}
// what the run counts as its own change, after an assess
function measured(repo) {
  run(repo, "check");
  return ledgerOf(repo).tier.measured;
}

// main moves on in every file and in src/f0.ts against the feature branch, which the run is on
function diverged(name) {
  const repo = makeRepo(name, Object.fromEntries(FILES.map((f, i) => [f, `export const v${i} = ${i};\n`])));
  git(repo, "checkout", "-qb", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
  write(repo, "src/f0.ts", "export const v0 = 'feature';\n");
  git(repo, "commit", "-qam", "feature work");
  git(repo, "checkout", "-q", "main");
  FILES.forEach((f, i) => write(repo, f, `export const v${i} = ${i * 10 + 1};\n`));
  git(repo, "commit", "-qam", "main moved on");
  git(repo, "checkout", "-q", "feature");
  assert.equal(run(repo, "open", "t", "refactor").status, 0);
  return repo;
}
// git merge main, stopped on the src/f0.ts conflict, fixed by hand and committed
// a real tool call comes seconds after the one before; a command's run is read with one second of
// slack, so the merge starts past it
const gap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
function merge(repo, branch = "main") {
  gap();
  shell(repo, `git merge ${branch}`, () => git(repo, "merge", branch));
}
function mergedByHand(repo, { fix = (r) => editTool(r, "src/f0.ts", "export const v0 = 'both';\n") } = {}) {
  merge(repo);
  fix(repo);
  shell(repo, "git add -A", () => git(repo, "add", "-A"));
  shell(repo, "git commit --no-edit", () => git(repo, "commit", "-q", "--no-edit"));
}

test("C1 reported-surface: a merge finished with git commit: what main brought in leaves the run, the hand-fixed file stays", () => {
  const repo = diverged("mcf-c1");
  mergedByHand(repo);
  const m = measured(repo);
  assert.equal(m.files, 1, JSON.stringify(m));
  assert.notEqual(m.tier, "large");
});

test("C2 refused: a file the session wrote with sed while the merge was open stays the run's", () => {
  const repo = diverged("mcf-c2");
  mergedByHand(repo, {
    fix: (r) => {
      editTool(r, "src/f0.ts", "export const v0 = 'both';\n");
      shell(r, "sed -i '' 's/51/mine/' src/f5.ts", () => write(r, "src/f5.ts", "export const v5 = 'mine';\n"));
    },
  });
  // the gate cannot tell which dirty files a shell write touched, so it keeps them all
  assert.ok(measured(repo).files >= 2);
  assert.ok(!folded(repo).includes("src/f5.ts"));
});

test("C3 refused: a merge, then a plain commit of the session's own work: the merge's files fold, the own commit's stay", () => {
  const repo = diverged("mcf-c3");
  mergedByHand(repo);
  editTool(repo, "src/f7.ts", "export const v7 = 'own';\n");
  shell(repo, "git commit -am 'own work'", () => git(repo, "commit", "-qam", "own work"));
  const m = measured(repo);
  assert.equal(m.files, 2, JSON.stringify(m));
});

test("C6 edge: commit own work, then merge main with git commit: the merge's files fold, the own commit's stay", () => {
  const repo = diverged("mcf-c6");
  editTool(repo, "src/f7.ts", "export const v7 = 'own';\n");
  shell(repo, "git commit -am 'own work'", () => git(repo, "commit", "-qam", "own work"));
  mergedByHand(repo);
  const m = measured(repo);
  assert.equal(m.files, 2, JSON.stringify(m));
});

test("C7 refused: the run's own branch merged into main with git commit still counts the files the run edited", () => {
  const repo = diverged("mcf-c7");
  editTool(repo, "src/f9.ts", "export const v9 = 'run';\n");
  shell(repo, "git commit -am 'run work'", () => git(repo, "commit", "-qam", "run work"));
  shell(repo, "git checkout main", () => git(repo, "checkout", "-q", "main"));
  merge(repo, "feature");
  editTool(repo, "src/f0.ts", "export const v0 = 'both';\n");
  shell(repo, "git commit -am 'merge feature'", () => git(repo, "commit", "-qam", "merge feature"));
  assert.ok(!folded(repo).includes("src/f9.ts"), folded(repo).join(","));
  assert.ok(measured(repo).files >= 1);
});

test("C4 happy: a clean merge by git merge alone still folds as a move", () => {
  const repo = makeRepo("mcf-c4", Object.fromEntries(FILES.map((f, i) => [f, `export const v${i} = ${i};\n`])));
  git(repo, "checkout", "-qb", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
  git(repo, "checkout", "-q", "main");
  FILES.forEach((f, i) => write(repo, f, `export const v${i} = ${i * 10 + 1};\n`));
  git(repo, "commit", "-qam", "main moved on");
  git(repo, "checkout", "-q", "feature");
  assert.equal(run(repo, "open", "t", "refactor").status, 0);
  merge(repo);
  assert.equal(measured(repo).files, 0);
});

test("C5 edge: two merges in a row, both finished with git commit, fold what both brought in", () => {
  const repo = diverged("mcf-c5");
  mergedByHand(repo);
  // main moves on again in another terminal
  git(repo, "checkout", "-q", "main");
  write(repo, "src/f3.ts", "export const v3 = 'again';\n");
  write(repo, "src/f0.ts", "export const v0 = 'main again';\n");
  git(repo, "commit", "-qam", "main again");
  git(repo, "checkout", "-q", "feature");
  mergedByHand(repo, { fix: (r) => editTool(r, "src/f0.ts", "export const v0 = 'both again';\n") });
  assert.equal(measured(repo).files, 1);
});

// files of 22 lines: main changes the first line of each (but `untouched`), so merges are clean
const lines = (top, bottom) => `export const a = ${top};\n${Array.from({ length: 20 }, (_, k) => `export const pad${k} = ${k};`).join("\n")}\nexport const b = ${bottom};\n`;
function cleanSplit(name, untouched = []) {
  const repo = makeRepo(name, Object.fromEntries(FILES.map((f) => [f, lines(0, 0)])));
  git(repo, "checkout", "-qb", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
  git(repo, "checkout", "-q", "main");
  FILES.filter((f) => !untouched.includes(f)).forEach((f) => write(repo, f, lines(1, 0)));
  git(repo, "commit", "-qam", "main moved on");
  git(repo, "checkout", "-q", "feature");
  assert.equal(run(repo, "open", "t", "refactor").status, 0);
  return repo;
}

test("C8 refused: a file the run wrote with sed and committed, then changed elsewhere by a clean merge of main, stays the run's", () => {
  const repo = cleanSplit("mcf-c8");
  shell(repo, "sed -i '' 's/b = 0/b = 99/' src/f7.ts", () => write(repo, "src/f7.ts", lines(0, 99)));
  shell(repo, "git commit -am own", () => git(repo, "commit", "-qam", "own"));
  gap();
  shell(repo, "git merge --no-commit main", () => git(repo, "merge", "--no-commit", "--no-ff", "main"));
  shell(repo, "git commit --no-edit", () => git(repo, "commit", "-q", "--no-edit"));
  assert.ok(!folded(repo).includes("src/f7.ts"), folded(repo).join(","));
  assert.ok(folded(repo).includes("src/f1.ts"));
});

test("C9 refused: the run's branch, written with sed and committed, merged into main (which never touched the file) still counts it", () => {
  const repo = cleanSplit("mcf-c9", ["src/f9.ts"]);
  shell(repo, "sed -i '' 's/b = 0/b = 9/' src/f9.ts", () => write(repo, "src/f9.ts", lines(0, 9)));
  shell(repo, "git commit -am 'run work'", () => git(repo, "commit", "-qam", "run work"));
  shell(repo, "git checkout main", () => git(repo, "checkout", "-q", "main"));
  gap();
  shell(repo, "git merge --no-commit --no-ff feature", () => git(repo, "merge", "--no-commit", "--no-ff", "feature"));
  shell(repo, "git commit --no-edit", () => git(repo, "commit", "-q", "--no-edit"));
  assert.ok(!folded(repo).includes("src/f9.ts"), folded(repo).join(","));
  assert.ok(measured(repo).files >= 1);
});

test("C10 refused: a commit and a checkout chained in one call, then the branch merged into main, still counts the run's file", () => {
  const repo = cleanSplit("mcf-c10", ["src/f9.ts"]);
  shell(repo, "sed -i '' 's/b = 0/b = 9/' src/f9.ts", () => write(repo, "src/f9.ts", lines(0, 9)));
  shell(repo, "git commit -am 'run work' && git checkout main", () => {
    git(repo, "commit", "-qam", "run work");
    git(repo, "checkout", "-q", "main");
  });
  gap();
  shell(repo, "git merge --no-commit --no-ff feature", () => git(repo, "merge", "--no-commit", "--no-ff", "feature"));
  shell(repo, "git commit --no-edit", () => git(repo, "commit", "-q", "--no-edit"));
  assert.ok(!folded(repo).includes("src/f9.ts"), folded(repo).join(","));
});

// Batch 3.2: after a commit, what git changed leaves the run less the commits the run made itself.
// The run is on `feature`, level with the base; main moved on in every file but src/f0.ts and src/f1.ts.
function ahead(name, { older = false } = {}) {
  // the gate's own line already in .gitignore: a dirty tree would stop the rebase before it starts
  const repo = makeRepo(name, { ".gitignore": "node_modules/\nignored.txt\n.claude/gate/\n", ...Object.fromEntries(FILES.map((f, i) => [f, `export const v${i} = ${i};\n`])) });
  git(repo, "checkout", "-qb", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
  if (older) {
    write(repo, "src/older.ts", "export const older = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "older branch work");
  }
  git(repo, "checkout", "-q", "main");
  FILES.slice(2).forEach((f, i) => write(repo, f, `export const v${i + 2} = 'main';\n`));
  git(repo, "commit", "-qam", "main moved on");
  git(repo, "checkout", "-q", "feature");
  assert.equal(run(repo, "open", "t", "refactor").status, 0);
  return repo;
}
const ownCommit = (repo, rel, content, subject = "own work") => {
  editTool(repo, rel, content);
  gap();
  shell(repo, `git commit -am '${subject}'`, () => git(repo, "commit", "-qam", subject));
};
const rebased = (repo, command = "git rebase main") => {
  gap();
  shell(repo, command, () => git(repo, "rebase", "main"));
};
const failed = (repo, command, work) => {
  const id = { tool_use_id: `T${++call}` };
  spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...id }), encoding: "utf8", env: env(repo) });
  try {
    work();
  } catch {
    // it stops on a conflict: that is the case under test
  }
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, tool_error: "Exit code 1", ...id }), encoding: "utf8", env: env(repo) });
};
const eventsOf = (repo) => readEvents(stateDir(repo), "S1");
// what a gate from before the reflog field left: the same events with the field gone
function stripReflog(repo) {
  const file = path.join(sessionDir(stateDir(repo), "S1"), "events.jsonl");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    const { reflog: _gone, ...rest } = JSON.parse(l);
    return JSON.stringify(rest);
  });
  writeFileSync(file, `${lines.join("\n")}\n`);
}

test("3.2 C1 a stopped --continue keeps its reflog: stopping twice then finishing folds main's files and keeps the commits'", () => {
  const repo = ahead("mcf-32c1");
  ownCommit(repo, "src/f2.ts", "export const v2 = 'a';\n", "first");
  ownCommit(repo, "src/f3.ts", "export const v3 = 'b';\n", "second");
  gap();
  const continueRebase = () => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.editor=true", "rebase", "--continue"], { cwd: repo, stdio: "pipe" });
  failed(repo, "git rebase main", () => git(repo, "rebase", "main"));
  editTool(repo, "src/f2.ts", "export const v2 = 'both';\n");
  gap();
  shell(repo, "git add -A", () => git(repo, "add", "-A"));
  gap();
  failed(repo, "git rebase --continue", continueRebase);
  const stopped = eventsOf(repo).filter((e) => e.kind === "command" && e.exit === 1 && e.cmd === "git rebase --continue").pop();
  assert.ok(stopped.reflog?.length > 0, "the failure event carries the reflog");
  editTool(repo, "src/f3.ts", "export const v3 = 'both';\n");
  gap();
  shell(repo, "git add -A", () => git(repo, "add", "-A"));
  gap();
  shell(repo, "git rebase --continue", continueRebase);
  const foreign = folded(repo);
  assert.ok(foreign.includes("src/f7.ts"), `main's files fold: ${foreign}`);
  assert.ok(!foreign.includes("src/f2.ts") && !foreign.includes("src/f3.ts"), `the commits' files stay: ${foreign}`);
  assert.equal(measured(repo).files, 2);
});

test("3.2 C2 a 40-pick rebase past the old 30 entries still knows the command's own entries", () => {
  const repo = ahead("mcf-32c2");
  ownCommit(repo, "src/f0.ts", "export const v0 = 'own';\n", "own");
  // older commits on the branch, not the run's: made with no tool call in the run
  for (let i = 0; i < 40; i++) {
    write(repo, `src/pick${i}.ts`, `export const p${i} = ${i};\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", `pick ${i}`);
  }
  rebased(repo);
  const last = eventsOf(repo).filter((e) => e.kind === "command" && e.cmd === "git rebase main").pop();
  assert.ok(last.reflog.length > 40, `${last.reflog.length} entries`);
  assert.ok(folded(repo).includes("src/f7.ts"));
});

test("3.2 C3 the stored reflog stays small: old history stores 30 entries, recent ones are kept past that", () => {
  const repo = ahead("mcf-32c3");
  const old = { ...process.env, GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z" };
  for (let i = 0; i < 40; i++) execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", `old ${i}`], { cwd: repo, env: old });
  assert.equal(commandReflog(repo).length, 30);
  for (let i = 0; i < 35; i++) git(repo, "commit", "--allow-empty", "-qm", `new ${i}`);
  const kept = commandReflog(repo);
  assert.equal(kept.length, 36, "every recent entry and the first older one, which a command's start may name");
  assert.match(kept[35][2], /old 39/);
  assert.ok(headReflog(repo, 200).length > kept.length);
});

test("3.2 C4 an old event with no reflog stays unknown and folds nothing", () => {
  const repo = ahead("mcf-32c4");
  editTool(repo, "src/f0.ts", "export const v0 = 'own';\n");
  gap();
  // the shape an older gate logged: a committing git command with no reflog on it
  shell(repo, "git commit -am own", () => git(repo, "commit", "-qam", "own"));
  stripReflog(repo);
  rebased(repo);
  stripReflog(repo);
  assert.deepEqual(folded(repo), []);
});

test("3.2 C5 commit then rebase on main: only the commit's files count, and verify must be green on the new code", () => {
  const repo = ahead("mcf-32c5");
  write(repo, ".claude/gate.json", JSON.stringify({ testFiles: null, verify: ["true"] }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "config");
  ownCommit(repo, "src/f0.ts", "export const v0 = 'own';\n");
  assert.equal(run(repo, "verify").status, 0);
  rebased(repo);
  assert.equal(measured(repo).files, 1);
  assert.ok(folded(repo).includes("src/f7.ts"));
  assert.ok(!folded(repo).includes("src/f0.ts"));
  assert.match(run(repo, "check").stdout, /R3[^\n]*stale/);
  assert.equal(run(repo, "verify").status, 0);
  assert.doesNotMatch(run(repo, "check").stdout, /\bR3\b/);
});

test("3.2 C6 sed then commit then rebase stays the run's, and so does a sed chained after the rebase", () => {
  const committed = ahead("mcf-32c6");
  gap();
  shell(committed, "sed -i '' s/0/own/ src/f0.ts", () => write(committed, "src/f0.ts", "export const v0 = 'own';\n"));
  gap();
  shell(committed, "git commit -am own", () => git(committed, "commit", "-qam", "own"));
  rebased(committed);
  assert.ok(!folded(committed).includes("src/f0.ts"));
  assert.equal(measured(committed).files, 1);

  const chained = ahead("mcf-32c6b");
  gap();
  shell(chained, "git rebase main && sed -i '' s/main/own/ src/f7.ts", () => {
    git(chained, "rebase", "main");
    write(chained, "src/f7.ts", "export const v7 = 'own';\n");
  });
  assert.ok(!folded(chained).includes("src/f7.ts"));
});

test("3.2 C7 older branch commits replayed by a rebase are moves, not the run's", () => {
  const repo = ahead("mcf-32c7", { older: true });
  rebased(repo);
  const made = eventsOf(repo).filter((e) => e.kind === "command" && e.cmd === "git rebase main").pop();
  assert.ok(made.reflog.some(([, , subject]) => /^rebase \(pick\):/.test(subject)), "premise: the rebase picked a commit");
  ownCommit(repo, "src/f0.ts", "export const v0 = 'own';\n");
  gap();
  git(repo, "checkout", "-q", "main");
  write(repo, "src/f8.ts", "export const v8 = 'main again';\n");
  git(repo, "commit", "-qam", "main again");
  git(repo, "checkout", "-q", "feature");
  rebased(repo);
  const foreign = folded(repo);
  assert.ok(foreign.includes("src/f8.ts"), `${foreign}`);
  assert.ok(!foreign.includes("src/f0.ts"));
  assert.equal(measured(repo).files, 1);
});

test("3.2 C8 a git move chained with a test run is a move; a redirect or any other command is not", () => {
  assert.equal(gitMoves("git rebase main && npm test"), true);
  assert.equal(gitMoves("git pull && npx vitest run"), true);
  assert.equal(gitMoves("git rebase main && npm test > src/a.ts"), false);
  assert.equal(gitMoves("git rebase main && npm run build"), false);
  assert.equal(gitMoves("npm test"), false, "no git move in it");

  const repo = ahead("mcf-32c8");
  rebased(repo, "git rebase main && npm test");
  assert.ok(folded(repo).includes("src/f7.ts"));
  assert.equal(measured(repo).files, 0);
});

test("3.2 C9 a file both the commit and main changed stays counted: it only adds reading, never hides a line", () => {
  const repo = ahead("mcf-32c9");
  ownCommit(repo, "src/f7.ts", "export const v7 = 'main';\nexport const own = 1;\n");
  gap();
  failed(repo, "git rebase main", () => git(repo, "rebase", "main"));
  git(repo, "checkout", "--theirs", "src/f7.ts");
  editTool(repo, "src/f7.ts", "export const v7 = 'main';\nexport const own = 1;\n");
  gap();
  shell(repo, "git add -A", () => git(repo, "add", "-A"));
  gap();
  shell(repo, "git rebase --continue", () => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.editor=true", "rebase", "--continue"], { cwd: repo, stdio: "pipe" }));
  assert.ok(!folded(repo).includes("src/f7.ts"));
  assert.equal(measured(repo).files, 1);
});

test("3.2 C10 rebaseline after a build chained with a rebase folds main's files, and For you shows the reason", () => {
  const repo = ahead("mcf-32c10");
  gap();
  shell(repo, "npm run build && git rebase main", () => git(repo, "rebase", "main"));
  assert.ok(!folded(repo).includes("src/f7.ts"), "premise: the chain counts as the run's writer");
  const out = run(repo, "rebaseline", "brought in by the rebase, as the user said");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /starting point moved/);
  assert.equal(measured(repo).files, 0);
  assert.match(run(repo, "report", "--brief").stdout, /brought in by the rebase, as the user said/);
});

test("3.2 C11 rebaseline keeps a sed file, an edit-tool file and an own commit's file even when git also brought it", () => {
  const repo = ahead("mcf-32c11");
  ownCommit(repo, "src/f0.ts", "export const v0 = 'own';\n");
  gap();
  shell(repo, "npm run build && git rebase main", () => git(repo, "rebase", "main"));
  editTool(repo, "src/f7.ts", "export const v7 = 'main';\n");
  gap();
  shell(repo, "sed -i '' s/main/own/ src/f8.ts", () => write(repo, "src/f8.ts", "export const v8 = 'own';\n"));
  const r = run(repo, "rebaseline", "brought in by the rebase, as the user said");
  assert.equal(r.status, 0, r.stderr);
  const kept = /kept[^\n]*/.exec(r.stdout)?.[0] ?? "";
  for (const file of ["src/f0.ts", "src/f7.ts", "src/f8.ts"]) assert.match(kept, new RegExp(file.replace(".", "\\.")), r.stdout);
  assert.doesNotMatch(kept, /src\/f9\.ts/, "main's untouched file folds");
});

test("3.2 C12 gitBrought is null when git cannot answer, and the difference less own commits when it can", () => {
  const repo = ahead("mcf-32c12");
  assert.equal(gitBrought(repo, "not-a-commit", "HEAD", []), null);
  const brought = gitBrought(repo, "feature", "main", []);
  assert.ok(brought.has("src/f7.ts"));
  const own = git(repo, "rev-parse", "main").trim();
  assert.equal(gitBrought(repo, "feature", "main", [own]).size, 0);
  assert.equal(gitBrought(repo, "feature", "main", ["not-a-commit"]), null);
});

test("3.2 C13 a conflict fixed with sed stays through rebaseline, after a rebase --continue or a merge's git commit", () => {
  const rebase = ahead("mcf-32c13");
  ownCommit(rebase, "src/f7.ts", "export const v7 = 'own';\n");
  gap();
  failed(rebase, "git rebase main", () => git(rebase, "rebase", "main"));
  gap();
  shell(rebase, "sed -i '' s/conflict/fixed/ src/f7.ts", () => write(rebase, "src/f7.ts", "export const v7 = 'fixed';\n"));
  gap();
  shell(rebase, "git add -A", () => git(rebase, "add", "-A"));
  gap();
  shell(rebase, "git rebase --continue", () => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.editor=true", "rebase", "--continue"], { cwd: rebase, stdio: "pipe" }));
  const kept = run(rebase, "rebaseline", "brought in by the rebase, as the user said");
  assert.match(kept.stdout + kept.stderr, /kept[^\n]*src\/f7\.ts|written by this run/);
  assert.ok(!folded(rebase).includes("src/f7.ts"));

  const merged = diverged("mcf-32c13b");
  merge(merged);
  gap();
  shell(merged, "sed -i '' s/conflict/fixed/ src/f0.ts", () => write(merged, "src/f0.ts", "export const v0 = 'fixed';\n"));
  gap();
  shell(merged, "git add -A", () => git(merged, "add", "-A"));
  gap();
  shell(merged, "git commit --no-edit", () => git(merged, "commit", "-q", "--no-edit"));
  const out = run(merged, "rebaseline", "brought in by the merge, as the user said");
  assert.match(out.stdout + out.stderr, /src\/f0\.ts/);
  assert.ok(!(ledgerOf(merged).rebaselines ?? []).flatMap((r) => r.paths).includes("src/f0.ts"), "the fix did not leave the run");
});

test("3.2 C14 only a plain test run keeps a move", () => {
  for (const cmd of ["git rebase main && npm run test:fix", "git rebase main && npm run test:update", "git pull && npm run test-gen", "git pull && npx vitest -u", "git pull && npx jest --updateSnapshot", "git pull && npx vitest --update", "git pull && make test", "git pull && npx jest --watch"]) {
    assert.equal(gitMoves(cmd), false, cmd);
  }
  for (const cmd of ["git pull && npm run test", "git pull && pnpm test", "git rebase main && pytest -q", "git rebase main && go test ./...", "git rebase main && cargo test", "git pull && node --test tests/a.test.mjs"]) {
    assert.equal(gitMoves(cmd), true, cmd);
  }
});

test("3.2 C15 rebaseline's new fold does nothing with an unknown reflog", () => {
  const unknown = ahead("mcf-32c15");
  gap();
  shell(unknown, "npm run build && git rebase main", () => git(unknown, "rebase", "main"));
  stripReflog(unknown);
  const out = run(unknown, "rebaseline", "brought in by the rebase, as the user said");
  assert.match(out.stdout + out.stderr, /kept[^\n]*src\/f7\.ts|written by this run/);
  assert.equal(broughtSinceOpen(unknown, ledgerOf(unknown), eventsOf(unknown)), null);
});

test("3.2 C15 a declared repo's file a chain wrote stays through rebaseline", () => {
  const repo = ahead("mcf-32c15r");
  const other = makeRepo("mcf-32c15r-other", { ".claude/gate.json": JSON.stringify({ testFiles: null, verify: ["true"] }) });
  git(other, "add", "-A");
  git(other, "commit", "-qm", "init");
  assert.equal(run(repo, "repo", "add", "../mcf-32c15r-other").status, 0);
  gap();
  shell(repo, "npm run build && git rebase main", () => {
    git(repo, "rebase", "main");
    write(other, "src/x.ts", "export const x = 1;\n");
  });
  const out = run(repo, "rebaseline", "brought in by the rebase, as the user said");
  assert.match(out.stdout, /kept[^\n]*mcf-32c15r-other\/src\/x\.ts/, out.stdout + out.stderr);
});

test("3.2 C15 with no run open rebaseline works as before: a chain's files stay", () => {
  const repo = ahead("mcf-32c15b");
  assert.equal(run(repo, "abandon", ...abandonArgs(repo, "t", "this case needs no run")).status, 0);
  gap();
  shell(repo, "npm run build && git rebase main", () => git(repo, "rebase", "main"));
  const out = run(repo, "rebaseline", "brought in by the rebase, as the user said");
  assert.doesNotMatch(out.stdout, /starting point moved[^\n]*src\/f7\.ts/);
});
