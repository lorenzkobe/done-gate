import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gate, here, write } from "./helpers.mjs";

// The hooks file a session's events under the repo it started in. A verb run from the model's
// shell (no CLAUDE_PROJECT_DIR) roots itself at its cwd, so a run opened inside a sibling repo
// would never see them: gate open refuses there and names the command that works (review 3.2).

function repoAt(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  write(dir, "a.txt", "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"], { cwd: dir });
  return dir;
}
function pair(name) {
  const top = path.join(here, ".tmp", name);
  rmSync(top, { recursive: true, force: true });
  return { top, main: repoAt(path.join(top, "main")), other: repoAt(path.join(top, "other")) };
}
const session = (name) => `sib-${name}-${process.pid}`;
// the hook writes under its project dir, which the harness sets
function prompted(repo, id) {
  const payload = { session_id: id, cwd: repo, hook_event_name: "UserPromptSubmit", prompt: "hi" };
  execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
}
// a verb from the model's shell: no CLAUDE_PROJECT_DIR, rooted at its cwd
function shellVerb(cwd, id, ...args) {
  const env = { ...process.env, DONE_GATE_SESSION: id };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [gate, ...args], { cwd, encoding: "utf8", env });
}
const runsIn = (repo) => existsSync(path.join(repo, ".claude", "gate", "runs"));

test("C1 reported-surface: events under a sibling repo: gate open in this repo is refused with that repo and the --repo command", () => {
  const { main, other } = pair("sib-c1");
  const id = session("c1");
  prompted(main, id);
  const r = shellVerb(other, id, "open", "t", "bugfix");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /^done-gate: /m);
  assert.ok(r.stderr.includes(main), r.stderr);
  assert.ok(r.stderr.includes(`cd ${main} && gate open t bugfix --repo ${other}`), r.stderr);
  assert.equal(runsIn(other), false);
});

test("C2 edge: events under an ancestor folder's state dir are refused the same way", () => {
  const { top } = pair("sib-c2");
  const outer = repoAt(path.join(top, "outer"));
  const inner = repoAt(path.join(outer, "inner"));
  const id = session("c2");
  prompted(outer, id);
  const r = shellVerb(inner, id, "open", "t", "bugfix");
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`cd ${outer} && gate open t bugfix --repo ${inner}`), r.stderr);
});

test("C3 happy: events in this repo open normally, even when a sibling holds them too", () => {
  const { main, other } = pair("sib-c3");
  const id = session("c3");
  prompted(main, id);
  prompted(other, id);
  const r = shellVerb(other, id, "open", "t", "bugfix");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(runsIn(other), true);
});

test("C4 boundary: no events anywhere opens normally", () => {
  const { other } = pair("sib-c4");
  const r = shellVerb(other, session("c4"), "open", "t", "bugfix");
  assert.equal(r.status, 0, r.stderr);
});

test("C5 refused: gate open --repo ../other from the main repo still opens and declares the sibling", () => {
  const { main, other } = pair("sib-c5");
  const id = session("c5");
  prompted(main, id);
  const r = shellVerb(main, id, "open", "t", "bugfix", "--repo", other);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(runsIn(main), true);
  assert.equal(runsIn(other), false);
});

test("C6 idempotent: rejoining a run by slug from the wrong repo is refused the same way", () => {
  const { main, other } = pair("sib-c6");
  const first = session("c6a");
  assert.equal(shellVerb(other, first, "open", "t", "bugfix").status, 0);
  const id = session("c6b");
  prompted(main, id);
  const r = shellVerb(other, id, "open", "t");
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`--repo ${other}`), r.stderr);
});

test("C7 refused: gate attach from the wrong repo is refused with the open --repo command", () => {
  const { main, other } = pair("sib-c7");
  assert.equal(shellVerb(other, session("c7a"), "open", "t", "bugfix").status, 0);
  const id = session("c7b");
  prompted(main, id);
  const r = shellVerb(other, id, "attach", "t");
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`cd ${main} && gate open t --repo ${other}`), r.stderr);
});

// From docs/after-0.21.0.md, limit 8: the printed line must run as printed.
test("C1 reported-surface: paths with spaces are quoted in the printed line", () => {
  const top = path.join(here, ".tmp", "sib spaces");
  rmSync(top, { recursive: true, force: true });
  const main = repoAt(path.join(top, "main repo"));
  const other = repoAt(path.join(top, "other repo"));
  const id = session("sp1");
  prompted(main, id);
  const r = shellVerb(other, id, "open", "t", "bugfix");
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`cd '${main}' && gate open t bugfix --repo '${other}'`), r.stderr);
});

test("C2 edge: the other flags come back, a relative --repo made absolute from the refused folder", () => {
  const { top, main, other } = pair("sib-flags");
  const third = repoAt(path.join(top, "third"));
  const id = session("fl1");
  prompted(main, id);
  const r = shellVerb(other, id, "open", "t", "bugfix", "--repo", "../third", "--old-version-ok", "go on, it's fine", "--setup-later", "later please");
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`cd ${main} && gate open t bugfix --old-version-ok 'go on, it'\\''s fine' --setup-later 'later please' --repo ${third} --repo ${other}`), r.stderr);
});

test("C4 edge: a --repo naming either folder itself is left out, so the printed line opens as printed", () => {
  const { main, other } = pair("sib-self");
  const id = session("self");
  prompted(main, id);
  const r = shellVerb(other, id, "open", "t", "bugfix", "--repo", "../main", "--repo", ".");
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`cd ${main} && gate open t bugfix --repo ${other}\``), r.stderr);
});

test("C5 refused: with a newer release known, the wrong folder is refused first with the cd line", () => {
  const { top, main, other } = pair("sib-newer");
  const home = path.join(top, "home");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "done-gate-release.json"), JSON.stringify({ latest: "99.0.0", checkedAt: new Date().toISOString() }));
  const id = session("newer");
  prompted(main, id);
  const env = { ...process.env, DONE_GATE_SESSION: id, DONE_GATE_HOME: home };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [gate, "open", "t", "bugfix", "--repo", "../third"], { cwd: other, encoding: "utf8", env });
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`cd ${main} && gate open t bugfix --repo ${path.join(top, "third")} --repo ${other}`), r.stderr);
  const here = spawnSync(process.execPath, [gate, "open", "t", "bugfix", "--repo", "../other"], { cwd: main, encoding: "utf8", env });
  assert.ok(here.stderr.includes("`gate open t bugfix --repo ../other --old-version-ok \"<their words, at least three>\"`"), here.stderr);
});

// a log a shell verb left behind with no hook's record in it: a rebaseline run from this folder
function strayLog(repo, id) {
  const dir = path.join(repo, ".claude", "gate", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ seq: 1, ts: new Date().toISOString(), session: id, agent: null, agentType: null, kind: "rebaseline", why: "x" })}\n`);
}

test("4.5 C1 refused: a stray rebaseline log here is not home; gate open names the repo holding the real events", () => {
  const { main, other } = pair("sib-45-c1");
  const id = session("45c1");
  prompted(main, id);
  strayLog(other, id);
  const r = shellVerb(other, id, "open", "t", "bugfix");
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`cd ${main} && gate open t bugfix --repo ${other}`), r.stderr);
  assert.equal(runsIn(other), false);
});

test("4.5 C2 edge: a stray log in the first sibling is skipped for the second, which holds real events", () => {
  const top = path.join(here, ".tmp", "sib-45-c2");
  rmSync(top, { recursive: true, force: true });
  const first = repoAt(path.join(top, "a-first"));
  const second = repoAt(path.join(top, "b-second"));
  const here_ = repoAt(path.join(top, "c-here"));
  const id = session("45c2");
  strayLog(first, id);
  prompted(second, id);
  const r = shellVerb(here_, id, "open", "t", "bugfix");
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.stderr.includes(`cd ${second} && `), r.stderr);
  assert.ok(!r.stderr.includes(`cd ${first} && `), r.stderr);
});
