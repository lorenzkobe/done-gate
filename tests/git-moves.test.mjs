import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { readEvents, eventsFromHookInput } from "../scripts/lib/events.mjs";

// Git's own moves are not the agent's edits (0.16.0 review, item 3.1): a checkout, pull or
// rebase moves the starting point, unless this session made a commit through git; and
// `gate rebaseline "<reason>"` moves it by hand. One test per case of the run's case table.

const REFUSAL = /^done-gate: /m;
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", (({ current, lastClosed }) => current ?? lastClosed)(loadSession(stateDir(repo), "S1")));
const ledgerOf = (repo) => loadLedger(runDir(repo));
const git = (repo, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });

function run(repo, verb, args = [], input = "") {
  return spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.notEqual(r.status, 0, `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.match(r.stderr, REFUSAL);
  return r.stderr;
}
function hook(repo, verb, payload) {
  const r = run(repo, verb, [], JSON.stringify({ session_id: "S1", cwd: repo, ...payload }));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const start = (repo) => hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });
const shell = (repo, command) => hook(repo, "log", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: {} });
const editTool = (repo, rel, content) => {
  write(repo, rel, content);
  hook(repo, "log", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_output: "ok" });
};
const stopRules = (repo) => {
  const out = hook(repo, "stop", { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done." });
  return out.startsWith("{") ? JSON.parse(out).reason ?? "" : "";
};
const unmet = (repo) => cli(repo, "check");

// A repo on main with a branch `other` that changes src/f1.ts and adds src/new.ts.
function repoWithBranch(name) {
  const repo = makeRepo(name, { "src/f1.ts": "export const v1 = 1;\n", "src/f2.ts": "export const v2 = 2;\n" });
  execFileSync("git", ["checkout", "-qb", "main"], { cwd: repo });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "other");
  write(repo, "src/f1.ts", "export const v1 = 100;\n");
  write(repo, "src/new.ts", "export const n = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "other");
  git(repo, "checkout", "-q", "main");
  start(repo);
  return repo;
}
const checkout = (repo, ...args) => {
  git(repo, "checkout", "-q", ...args);
  shell(repo, `git checkout ${args.join(" ")}`);
};

test("C1 reported-surface: with no run open, a branch switch raises no R1 at the stop", () => {
  const repo = repoWithBranch("gm-c1");
  checkout(repo, "other");
  assert.doesNotMatch(stopRules(repo), /R1/);
});

test("C2 reported-surface: with no run open, a fast-forward merge or pull raises no R1", () => {
  const repo = repoWithBranch("gm-c2");
  git(repo, "merge", "-q", "--ff-only", "other");
  shell(repo, "git merge --ff-only other");
  assert.doesNotMatch(stopRules(repo), /R1/);

  const pulled = repoWithBranch("gm-c2-pull");
  git(pulled, "pull", "-q", "--ff-only", ".", "other");
  shell(pulled, "git pull --ff-only . other");
  assert.doesNotMatch(stopRules(pulled), /R1/);
});

test("C3 reported-surface: inside a run, a branch switch leaves the other branch's files out of the run's changes, and the report says git moved them", () => {
  const repo = repoWithBranch("gm-c3");
  cli(repo, "open", ["t", "feature"]);
  checkout(repo, "other");
  const report = cli(repo, "report");
  assert.doesNotMatch(report, /^- source/m, report);
  assert.match(report, /changed only by other commits or a git move[^\n]*src\/f1\.ts, src\/new\.ts/, report);
});

test("C4 refused: after this session ran git commit, files clean against the new HEAD still count", () => {
  const bare = repoWithBranch("gm-c4-bare");
  write(bare, "src/f2.ts", "export const v2 = 'mine';\n");
  git(bare, "commit", "-qam", "mine");
  shell(bare, "git commit -qam mine");
  assert.match(stopRules(bare), /R1/, "a commit by this session hid its own shell edit");

  const inRun = repoWithBranch("gm-c4-run");
  cli(inRun, "open", ["t", "feature"]);
  write(inRun, "src/f2.ts", "export const v2 = 'mine';\n");
  shell(inRun, "sed -i '' s/2/mine/ src/f2.ts");
  git(inRun, "commit", "-qam", "mine");
  shell(inRun, "git commit -qam mine");
  assert.match(cli(inRun, "report"), /- source \(1\): src\/f2\.ts/);
});

test("C5 refused: a file this session edited with an edit tool still counts after a checkout, even when it matches the new HEAD", () => {
  const repo = repoWithBranch("gm-c5");
  cli(repo, "open", ["t", "feature"]);
  editTool(repo, "src/f1.ts", "export const v1 = 100;\n");
  write(repo, "src/f1.ts", "export const v1 = 1;\n");
  checkout(repo, "other");
  assert.match(cli(repo, "report"), /- source \(\d+\): [^\n]*src\/f1\.ts/);
});

test("C6 edge: another session's commit with no run open raises no R1", () => {
  const repo = repoWithBranch("gm-c6");
  write(repo, "src/f2.ts", "export const v2 = 'theirs';\n");
  git(repo, "commit", "-qam", "another terminal");
  assert.doesNotMatch(stopRules(repo), /R1/);
});

test("C7 edge: a file the move deleted and the agent recreated untracked still counts", () => {
  const repo = repoWithBranch("gm-c7");
  checkout(repo, "other");
  checkout(repo, "main");
  write(repo, "src/new.ts", "export const n = 2;\n");
  assert.match(stopRules(repo), /R1[^\n]*src\/new\.ts/);
});

test("C8 idempotent: an event from before this change (git, no commits key) is read as committing", () => {
  const ev = (cmd) => eventsFromHookInput({ hook_event_name: "PostToolUse", session_id: "S1", tool_name: "Bash", tool_input: { command: cmd } }, "/repo")[0];
  assert.equal(ev("git checkout other").commits, false);
  for (const cmd of ["git commit -qm x", "git cherry-pick abc", "git revert HEAD", "git am < p", "git rebase --continue", "git merge --continue", 'bash -c "git add -A && git commit -m x"']) assert.equal(ev(cmd).commits, true, cmd);

  const repo = repoWithBranch("gm-c8");
  cli(repo, "open", ["t", "feature"]);
  // an old checkout event: git with no commits key
  const file = path.join(stateDir(repo), "sessions", "S1", "events.jsonl");
  const seq = Date.now() * 1000;
  write(repo, path.relative(repo, file), `${existsSync(file) ? readFileSync(file, "utf8") : ""}${JSON.stringify({ seq, ts: new Date().toISOString(), session: "S1", agent: null, agentType: null, kind: "command", tool: "Bash", cmd: "git checkout other", exit: null, git: true })}\n`);
  git(repo, "checkout", "-q", "other");
  assert.match(cli(repo, "report"), /- source \(\d+\): [^\n]*src\/f1\.ts/);
});

test("C9 happy: gate rebaseline with no run clears an R1 caused by a stash pop and records the reason as a session event", () => {
  const repo = repoWithBranch("gm-c9");
  write(repo, "src/f2.ts", "export const v2 = 'user';\n");
  git(repo, "stash", "-q");
  shell(repo, "git stash");
  git(repo, "stash", "pop", "-q");
  // the pop rewrote the file after the stash's run, not inside it
  const later = new Date(Date.now() + 5000);
  utimesSync(path.join(repo, "src/f2.ts"), later, later);
  shell(repo, "git stash pop");
  const first = stopRules(repo);
  assert.match(first, /R1/, "premise: the stash pop shows as a change");
  assert.match(first, /gate rebaseline/);
  cli(repo, "rebaseline", ["the user's own stash, popped back"]);
  assert.doesNotMatch(stopRules(repo), /R1/);
  const ev = readEvents(stateDir(repo), "S1").find((e) => e.kind === "rebaseline");
  assert.equal(ev?.reason, "the user's own stash, popped back");
});

test("C10 happy: gate rebaseline in a run folds the changed files the run did not edit, keeps the ones it edited, and For you names the reason", () => {
  const repo = repoWithBranch("gm-c10");
  cli(repo, "open", ["t", "feature"]);
  editTool(repo, "src/f1.ts", "export const v1 = 'mine';\n");
  write(repo, "src/f2.ts", "export const v2 = 'another terminal';\n");
  cli(repo, "rebaseline", ["another terminal's edit to f2"]);
  const report = cli(repo, "report");
  assert.match(report, /- source \(1\): src\/f1\.ts/, report);
  const brief = cli(repo, "report", ["--brief"]);
  assert.match(brief, /For you:[^\n]*another terminal's edit to f2/, brief);
  assert.deepEqual(ledgerOf(repo).rebaselines.map((r) => r.paths), [["src/f2.ts"]]);
});

test("C11 refused: gate rebaseline with nothing to fold, or with no reason, is refused", () => {
  const repo = repoWithBranch("gm-c11");
  cli(repo, "open", ["t", "feature"]);
  refused(repo, "rebaseline", ["nothing changed"]);
  write(repo, "src/f2.ts", "export const v2 = 'x';\n");
  refused(repo, "rebaseline", []);
  editTool(repo, "src/f1.ts", "export const v1 = 'mine';\n");
  assert.equal(ledgerOf(repo).rebaselines, undefined);
  assert.match(cli(repo, "report"), /- source \(2\): src\/f1\.ts, src\/f2\.ts/, "a refused rebaseline moved something");
});

test("C12 happy: the R1 text names gate rebaseline for changes that are not yours", () => {
  const repo = repoWithBranch("gm-c12");
  write(repo, "src/f2.ts", "export const v2 = 'x';\n");
  assert.match(stopRules(repo), /R1[\s\S]*gate rebaseline "<why>"/);
});

test("C13 boundary: a run whose HEAD moved by another session's commit absorbs only that commit's file and keeps its own shell edit", () => {
  const repo = repoWithBranch("gm-c13");
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/f2.ts", "export const v2 = 'mine';\n");
  shell(repo, "sed -i '' s/2/mine/ src/f2.ts");
  write(repo, "src/f1.ts", "export const v1 = 'theirs';\n");
  // written after the sed's run, so no command of this run can have written it
  const later = new Date(Date.now() + 5000);
  utimesSync(path.join(repo, "src/f1.ts"), later, later);
  git(repo, "commit", "-qm", "another terminal", "--", "src/f1.ts");
  const report = cli(repo, "report");
  assert.match(report, /- source \(1\): src\/f2\.ts/, report);
  assert.deepEqual(ledgerOf(repo).foreign, ["src/f1.ts"]);
});

test("C14 refused: a git alias commit and git rebase -x count as committing", () => {
  const ev = (cmd) => eventsFromHookInput({ hook_event_name: "PostToolUse", session_id: "S1", tool_name: "Bash", tool_input: { command: cmd } }, "/repo")[0];
  for (const cmd of ["git stash", "git stash push -m x", "sed -i '' s/a/b/ f && git stash && git checkout stash@{0}", "git checkout x; npm run build", "git pull --rebase=interactive", "git -c core.hooksPath=h checkout main", "git ci -am x", "git -c alias.c=commit c -m x", 'git rebase -x "sed -i s/a/b/ f" main', "git rebase -i main", "git rebase --exec true main"]) assert.equal(ev(cmd).commits, true, cmd);
  for (const cmd of ["git switch other", "git pull", "git pull --rebase", "git rebase main", "git reset --hard HEAD~1", "git stash pop", "git restore src/a.ts", "git merge --ff-only other", "cd sub && git pull", "git fetch && git status && git checkout main", "git -C sub checkout main"]) assert.equal(ev(cmd).commits, false, cmd);
  assert.equal(ev("npm test").commits, undefined, "a non-git command carries no commits key");
});

test("C15 refused: with no run open, a sed edit followed by a commit git cannot see still raises R1", () => {
  const repo = repoWithBranch("gm-c15");
  write(repo, "src/f2.ts", "export const v2 = 'mine';\n");
  shell(repo, "sed -i '' s/2/mine/ src/f2.ts");
  git(repo, "commit", "-qam", "release");
  shell(repo, "npm version patch");
  assert.match(stopRules(repo), /R1[^\n]*src\/f2\.ts/);
});

test("C16 refused: gate rebaseline in a run keeps a file the run wrote through the shell and names it", () => {
  const repo = repoWithBranch("gm-c16");
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/f1.ts", "export const v1 = 'mine';\n");
  shell(repo, "sed -i '' s/1/mine/ src/f1.ts");
  write(repo, "src/f2.ts", "export const v2 = 'another terminal';\n");
  // later than the sed's run, so no command of this run can have written it
  const later = new Date(Date.now() + 5000);
  utimesSync(path.join(repo, "src/f2.ts"), later, later);
  const out = cli(repo, "rebaseline", ["another terminal's edit to f2"]);
  assert.match(out, /kept[^\n]*src\/f1\.ts/, out);
  assert.match(cli(repo, "report"), /- source \(1\): src\/f1\.ts/);
});

test("C17 edge: a checkout round trip leaves no change behind, with or without a run", () => {
  const bare = repoWithBranch("gm-c17-bare");
  checkout(bare, "other");
  assert.doesNotMatch(stopRules(bare), /R1/);
  checkout(bare, "main");
  assert.doesNotMatch(stopRules(bare), /R1/);

  const inRun = repoWithBranch("gm-c17-run");
  cli(inRun, "open", ["t", "feature"]);
  checkout(inRun, "other");
  cli(inRun, "check");
  checkout(inRun, "main");
  assert.doesNotMatch(cli(inRun, "report"), /- source \(/);
});

test("C18 refused: a write chained with git moves in one command is the agent's, with or without a run", () => {
  const inRun = repoWithBranch("gm-c18-run");
  cli(inRun, "open", ["t", "feature"]);
  write(inRun, "src/f2.ts", "export const v2 = 'mine';\n");
  git(inRun, "stash", "-q");
  git(inRun, "checkout", "-q", "stash@{0}");
  shell(inRun, "sed -i '' s/2/mine/ src/f2.ts && git stash && git checkout stash@{0}");
  assert.match(cli(inRun, "report"), /- source \(1\): src\/f2\.ts/);

  const bare = repoWithBranch("gm-c18-bare");
  write(bare, "src/f2.ts", "export const v2 = 'mine';\n");
  git(bare, "stash", "-q");
  git(bare, "checkout", "-q", "stash@{0}");
  shell(bare, "sed -i '' s/2/mine/ src/f2.ts; git stash; git checkout stash@{0}");
  assert.match(stopRules(bare), /R1[^\n]*src\/f2\.ts/);
});

test("C19 refused: gate rebaseline in a run keeps an edit-tool edit made before the run opened", () => {
  const repo = repoWithBranch("gm-c19");
  editTool(repo, "src/f1.ts", "export const v1 = 'mine';\n");
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/f2.ts", "export const v2 = 'x';\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(path.join(repo, "src/f2.ts"), later, later);
  const out = cli(repo, "rebaseline", ["another terminal's edit to f2"]);
  assert.match(out, /kept[^\n]*src\/f1\.ts/, out);
  assert.match(cli(repo, "report"), /- source \(1\): src\/f1\.ts/);
});

test("C20 happy: with no run open, a rebaseline and a git-move fold are reported by the next run", () => {
  const repo = repoWithBranch("gm-c20");
  checkout(repo, "other");
  stopRules(repo);
  write(repo, "src/f2.ts", "export const v2 = 'another terminal';\n");
  cli(repo, "rebaseline", ["another terminal's edit to f2"]);
  cli(repo, "open", ["t", "feature"]);
  const brief = cli(repo, "report", ["--brief"]);
  assert.match(brief, /For you:[^\n]*another terminal's edit to f2/, brief);
  assert.match(cli(repo, "report"), /changed only by other commits or a git move[^\n]*src\/f1\.ts/);
});
