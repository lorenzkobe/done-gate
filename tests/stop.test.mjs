import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { snapshot } from "../scripts/lib/tree.mjs";
import { IGNORE_CASE } from "../scripts/lib/paths.mjs";
import { fileURLToPath } from "node:url";

// ===== from tests/stop.test.mjs =====
{
function run(repo, verb, input, args = [], session = "S1") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input: JSON.stringify({ session_id: session, cwd: repo, hook_event_name: "Stop", stop_hook_active: false, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session },
  });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null };
}

const start = (repo, session = "S1") => run(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" }, [], session);
const stop = (repo, msg = "done.", session = "S1") => run(repo, "stop", { last_assistant_message: msg }, [], session);

test("a session that changed nothing is never blocked", () => {
  const repo = makeRepo("stop-noop");
  start(repo);
  assert.equal(stop(repo).json, null);
});

test("inside a subagent the gate stays out of the way", () => {
  const repo = makeRepo("stop-sub");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  assert.equal(run(repo, "stop", { agent_id: "A1", agent_type: "done-gate:qa", last_assistant_message: "x" }).json, null);
});

test("editing source with no ledger blocks with R1, even when the edit bypassed the Edit tool", () => {
  const repo = makeRepo("stop-r1");
  start(repo);
  write(repo, "src/a.ts", "changed by sed\n"); // no PostToolUse event was logged
  const out = stop(repo).json;
  assert.equal(out.decision, "block");
  assert.match(out.reason, /R1/);
  assert.match(out.reason, /gate open/);
});

test("a doc-only change with no ledger passes", () => {
  const repo = makeRepo("stop-docs");
  start(repo);
  write(repo, "docs/notes.md", "# changed\n");
  assert.equal(stop(repo).json, null);
});

test("with an open ledger, a PAUSED: last line lets the turn end and is recorded", () => {
  const repo = makeRepo("stop-pause");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  run(repo, "open", {}, ["task", "feature"]);
  const out = stop(repo, "Some progress.\n\nPAUSED: need the API key from you").json;
  assert.equal(out, null);
  const dir = path.join(repo, ".claude", "gate", "runs", readFileSync(path.join(repo, ".claude/gate/sessions/S1/state.json"), "utf8").match(/"current":"([^"]+)"/)[1]);
  assert.equal(loadLedger(dir).pauses.length, 1);
  assert.match(loadLedger(dir).pauses[0].text, /API key/);
});

test("with an open ledger and unmet rules, a plain 'done' message is blocked and the reason lists them", () => {
  const repo = makeRepo("stop-block");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  run(repo, "open", {}, ["task", "feature"]);
  const out = stop(repo).json;
  assert.equal(out.decision, "block");
  assert.match(out.reason, /R3/);
  assert.match(out.reason, /R7/);
});

test("six consecutive identical blocks fall open with a GATE OVERRIDDEN stamp; progress resets the counter", () => {
  const repo = makeRepo("stop-override");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  run(repo, "open", {}, ["task", "feature"]);
  for (let i = 0; i < 5; i++) assert.equal(stop(repo).json?.decision, "block");
  assert.equal(loadSession(path.join(repo, ".claude", "gate"), "S1").blocks.count, 5);
  write(repo, "tests/a.test.ts", "progress\n"); // R7 now met → unmet list differs → counter resets
  assert.equal(stop(repo).json?.decision, "block");
  assert.equal(loadSession(path.join(repo, ".claude", "gate"), "S1").blocks.count, 1);
  for (let i = 0; i < 4; i++) assert.equal(stop(repo).json?.decision, "block");
  const sixth = stop(repo).json;
  assert.equal(sixth, null);
  const current = loadSession(path.join(repo, ".claude", "gate"), "S1").current;
  const ledger = loadLedger(path.join(repo, ".claude", "gate", "runs", current));
  assert.ok(ledger.overridden, "override stamped on the ledger");
});

test("a corrupt ledger.json blocks once with the parse error, then falls open with a GATE ERROR stamp", () => {
  const repo = makeRepo("stop-corrupt");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  run(repo, "open", {}, ["task", "feature"]);
  const current = loadSession(path.join(repo, ".claude", "gate"), "S1").current;
  writeFileSync(path.join(repo, ".claude", "gate", "runs", current, "ledger.json"), "{ not json");
  const first = stop(repo).json;
  assert.equal(first.decision, "block");
  assert.match(first.reason, /ledger\.json/);
  const second = stop(repo).json;
  assert.equal(second, null);
  assert.match(readFileSync(path.join(repo, ".claude", "gate", "gate-error.log"), "utf8"), /ledger\.json/);
});

test("`gate check` prints the same unmet list without blocking anything", () => {
  const repo = makeRepo("stop-check");
  start(repo);
  write(repo, "src/a.ts", "changed\n");
  const r = run(repo, "check", {});
  assert.match(r.stdout, /R1/);
});
}

// ===== from tests/stdin-hang.test.mjs =====
{
// stdin-hang: the dispatcher must only wait for stdin when a verb actually has a payload
// there (hook verbs, or an explicit `-` argument). Claude Code's Bash tool hands every
// child a pipe it never closes, so anything else hangs forever.

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
}

// ===== from tests/smoke.test.mjs =====
{
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = path.join(root, "scripts", "gate.mjs");

function run(args, input = "", env = {}) {
  return spawnSync(process.execPath, [gate, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("--version prints the plugin.json version", () => {
  const { version } = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), version);
});

test("plugin.json and package.json versions agree", () => {
  const plugin = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const market = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(plugin.version, pkg.version);
  assert.equal(market.plugins[0].version, pkg.version);
});

test("an unknown verb fails OPEN: exit 0, error on stderr, nothing on stdout", () => {
  const r = run(["no-such-verb"], "{}");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unknown verb/);
});

test("a verb that throws fails OPEN: exit 0 and the stack lands in gate-error.log", () => {
  const r = run(["__throw"], "{}", { DONE_GATE_STATE_DIR: path.join(root, "tests", ".tmp", "smoke-state"), DONE_GATE_TEST: "1" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const log = readFileSync(path.join(root, "tests", ".tmp", "smoke-state", "gate-error.log"), "utf8");
  assert.match(log, /__throw/);
});
}
