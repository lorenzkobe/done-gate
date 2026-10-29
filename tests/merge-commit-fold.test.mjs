import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { makeRepo, gate, write } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

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
