// stdin-hang: the dispatcher must only wait for stdin when a verb actually has a payload
// there (hook verbs, or an explicit `-` argument). Claude Code's Bash tool hands every
// child a pipe it never closes, so anything else hangs forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { snapshot } from "../scripts/lib/tree.mjs";
import { IGNORE_CASE } from "../scripts/lib/paths.mjs";

const PROMPT_MS = 5000;

// The runner itself is started by Claude Code, so it inherits CLAUDE_CODE_SESSION_ID;
// leaving it in the child's env would let the real session leak into a fixture repo.
function env(repo, extra = {}) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1", ...extra };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

// spawnSync closes stdin for us; this is the closed-pipe path.
function cli(repo, verb, args = [], input = "") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input, encoding: "utf8", env: env(repo),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

const gateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) =>
  path.join(gateDir(repo), "runs", loadSession(gateDir(repo), "S1").current);

// Reproduces Claude Code's Bash tool: stdin is a pipe that is never written to and never
// ended. Races the child's exit against a timer and reports whether it beat it.
function spawnOpenPipe(repo, args, ms = PROMPT_MS) {
  const child = spawn(process.execPath, [gate, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: env(repo),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ timedOut: true, code: null, stdout, stderr, ms: Date.now() - started });
    }, ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code, stdout, stderr, ms: Date.now() - started });
    });
  }).finally(() => {
    child.stdin.destroy();
  });
}

test("C1 reported-surface: a non-hook verb with a never-closing stdin pipe still exits", async () => {
  const repo = makeRepo("stdin-doctor");
  const r = await spawnOpenPipe(repo, ["doctor"]);
  assert.equal(r.timedOut, false, `doctor did not exit within ${PROMPT_MS}ms with stdin held open`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^repo: /m);
});

test("C2 happy: `note plan -` still reads the note body from stdin", () => {
  const repo = makeRepo("stdin-note-dash");
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "note", ["plan", "-"], "Touch CourtCard.tsx.\nNo data change.\n");
  const md = readFileSync(path.join(runDir(repo), "ledger.md"), "utf8");
  assert.match(md, /## Plan\n\nTouch CourtCard\.tsx\.\nNo data change\./);
});

test("C3 happy: hook verbs still read their JSON payload from stdin", () => {
  const repo = makeRepo("stdin-hooks");
  const fence = spawnSync(process.execPath, [gate, "fence"], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(repo, ".claude", "gate", "runs", "x", "ledger.json") },
      cwd: repo,
      session_id: "S1",
    }),
    encoding: "utf8",
    env: env(repo),
  });
  assert.equal(fence.status, 0, fence.stderr);
  const out = JSON.parse(fence.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");

  const start = spawnSync(process.execPath, [gate, "session-start"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "S1", cwd: repo }),
    encoding: "utf8",
    env: env(repo),
  });
  assert.equal(start.status, 0, start.stderr);
  const state = path.join(gateDir(repo), "sessions", "S1", "state.json");
  assert.equal(existsSync(state), true, `expected ${state} to exist`);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).session, "S1");
});

test("C4 boundary: a non-hook verb ignores a cwd piped on stdin and uses CLAUDE_PROJECT_DIR", () => {
  const repo = makeRepo("stdin-root");
  const other = makeRepo("stdin-root-other");
  const r = cli(repo, "doctor", [], JSON.stringify({ cwd: other }));
  const line = r.stdout.split("\n").find((l) => l.startsWith("repo: "));
  assert.equal(line, `repo: ${repo}`);
});

test("C5 edge: an unknown verb with a never-closing stdin pipe also exits promptly", async () => {
  const repo = makeRepo("stdin-unknown");
  const r = await spawnOpenPipe(repo, ["no-such-verb"]);
  assert.equal(r.timedOut, false, `unknown verb did not exit within ${PROMPT_MS}ms with stdin held open`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /unknown verb/);
});

test("C6 refused: Claude Code harness lock files are neither source nor snapshotted; gate.json stays source", () => {
  const repo = makeRepo("stdin-locks");
  write(repo, ".claude/scheduled_tasks.lock", "{}\n");
  write(repo, ".claude/foo.lock", "{}\n");
  write(repo, ".claude/gate.json", JSON.stringify({ tests: ["tests/**"] }));

  const cfg = loadConfig(repo);
  assert.equal(cfg.isSource(".claude/scheduled_tasks.lock"), false);
  assert.equal(cfg.isSource(".claude/foo.lock"), false);
  assert.equal(cfg.isSource(".claude/gate.json"), true);

  const files = snapshot(repo).files;
  assert.equal(Object.hasOwn(files, ".claude/scheduled_tasks.lock"), false);
  assert.equal(Object.hasOwn(files, ".claude/foo.lock"), false);
  assert.equal(Object.hasOwn(files, ".claude/gate.json"), true);
});

test("C7 refused: settings.local.json and scheduled_tasks.json are excluded; settings.json stays source", () => {
  const repo = makeRepo("stdin-harness-files");
  write(repo, ".claude/settings.local.json", JSON.stringify({ permissions: {} }));
  write(repo, ".claude/scheduled_tasks.json", JSON.stringify({ tasks: [] }));
  write(repo, ".claude/settings.json", JSON.stringify({ hooks: {} }));

  const cfg = loadConfig(repo);
  assert.equal(cfg.isSource(".claude/settings.local.json"), false);
  assert.equal(cfg.isSource(".claude/scheduled_tasks.json"), false);
  assert.equal(cfg.isSource(".claude/settings.json"), true);

  const files = snapshot(repo).files;
  assert.equal(Object.hasOwn(files, ".claude/settings.local.json"), false);
  assert.equal(Object.hasOwn(files, ".claude/scheduled_tasks.json"), false);
  assert.equal(Object.hasOwn(files, ".claude/settings.json"), true);
});

test("C8 edge: a `-` that is an ordinary argument, not a stdin marker, does not hold the verb open", async () => {
  const repo = makeRepo("stdin-case-dash");
  cli(repo, "open", ["t", "feature"]);
  const r = await spawnOpenPipe(repo, ["case", "add", "-", "--kind", "edge"]);
  assert.equal(r.timedOut, false, `case add "-" did not exit within ${PROMPT_MS}ms with stdin held open`);
  assert.equal(r.code, 0, r.stderr);
  // the verb must have actually run, not fallen through the fail-open wrapper (which also exits 0)
  assert.match(r.stdout, /^C1 added \(edge\)/m);
  assert.equal(r.stderr, "");
});

// IGNORE_CASE is the gate's own definition of a case-insensitive filesystem
// (scripts/lib/paths.mjs: win32 or darwin).
test("C9 edge: a mixed-case harness file is excluded by isSource and by the snapshot alike", {
  skip: IGNORE_CASE ? false : `case-sensitive platform (${process.platform}): mixed-case paths are distinct files here`,
}, () => {
  const repo = makeRepo("stdin-mixed-case");
  write(repo, ".claude/Scheduled_Tasks.LOCK", "{}\n");

  const cfg = loadConfig(repo);
  const inSnapshot = Object.hasOwn(snapshot(repo).files, ".claude/Scheduled_Tasks.LOCK");
  assert.equal(cfg.isSource(".claude/Scheduled_Tasks.LOCK"), false);
  assert.equal(inSnapshot, false);
});
