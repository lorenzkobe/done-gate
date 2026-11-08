import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventsFromHookInput, readEvents, appendEvents } from "../scripts/lib/events.mjs";
import { makeRepo, gate, write, here, readyToEdit, planChecked } from "./helpers.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// ===== from tests/events.test.mjs =====
{
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const stdin = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", "stdin", `${name}.json`), "utf8"));
const tmp = path.join(here, ".tmp", "events-state");

beforeEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});

function pick(e) {
  const { seq, ts, ...rest } = e;
  assert.equal(typeof seq, "number");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/);
  return rest;
}

test("Edit/Write become edit events with root-relative POSIX paths", () => {
  assert.deepEqual(pick(eventsFromHookInput(stdin("edit"), "/repo")[0]), {
    session: "S1", agent: null, agentType: null, kind: "edit", tool: "Edit", path: "src/app/page.tsx",
  });
  assert.equal(eventsFromHookInput(stdin("write"), "/repo")[0].path, "tests/x.test.ts");
});

test("MultiEdit emits one edit event per file", () => {
  const evs = eventsFromHookInput(stdin("multiedit"), "/repo");
  assert.deepEqual(evs.map((e) => e.path), ["src/a.ts", "src/b.ts"]);
  assert.ok(evs.every((e) => e.kind === "edit" && e.tool === "MultiEdit"));
});

test("Bash is attribution only: a truncated command, never a path", () => {
  const [e] = eventsFromHookInput(stdin("bash"), "/repo");
  assert.equal(e.kind, "command");
  assert.equal(e.cmd, "rtk npm run test");
  assert.equal(e.path, undefined);
});

const failed = (tool_name, tool_input, tool_error) => ({ session_id: "S1", cwd: "/repo", hook_event_name: "PostToolUseFailure", tool_name, tool_input, tool_error, tool_error_type: "execution_failed" });

test("C1 reported-surface: a failed Bash call is logged as a command with its exit code, and closes a repro step with --ran", () => {
  const [e] = eventsFromHookInput(failed("Bash", { command: "npm test" }, "Exit code 1\nFAIL tests/a.test.ts"), "/repo");
  assert.equal(e.kind, "command");
  assert.equal(e.cmd, "npm test");
  assert.equal(e.exit, 1);
  assert.equal(eventsFromHookInput(failed("Bash", { command: "false" }, "Error: Exit code: 127"), "/repo")[0].exit, 127);

  const repo = makeRepo("failed-run-repro");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  const cli = (...args) => spawnSync(process.execPath, [gate, ...args], { input: "", encoding: "utf8", env });
  cli("open", "red-run", "bugfix");
  cli("note", "task", "A bug. [inferred]");
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ ...failed("Bash", { command: "npm test -- tests/a.test.ts" }, "Exit code 1"), cwd: repo }), encoding: "utf8", env });
  const r = cli("step", "repro", "done", "the test fails red (src/a.ts:1)", "--ran", "npm test -- tests/a.test.ts");
  assert.equal(r.status, 0, r.stderr);
});

test("C2 edge: a failed Bash call with no exit code in its error (denied, interrupted, timed out) logs nothing, nor does a failed Edit or browser call", () => {
  assert.deepEqual(eventsFromHookInput(failed("Bash", { command: "npm test" }, "Command timed out"), "/repo"), []);
  assert.deepEqual(eventsFromHookInput(failed("Bash", { command: "rm x" }, "done-gate: that command writes gate evidence files"), "/repo"), []);
  assert.deepEqual(eventsFromHookInput(failed("Edit", { file_path: "/repo/src/a.ts" }, "String not found"), "/repo"), []);
  assert.deepEqual(eventsFromHookInput(failed("mcp__claude-in-chrome__computer", { action: "left_click", ref: "ref_1" }, "no such element"), "/repo"), []);
  const hooks = JSON.parse(readFileSync(path.join(root, "hooks", "hooks.json"), "utf8")).hooks;
  assert.ok((hooks.PostToolUseFailure ?? []).some((h) => /Bash/.test(h.matcher) && h.hooks.some((x) => /gate\.mjs" log/.test(x.command))), "hooks.json registers PostToolUseFailure for Bash");
});

test("Agent, Skill and Chrome tools map to agent, skill and browser kinds", () => {
  assert.deepEqual(pick(eventsFromHookInput(stdin("agent"), "/repo")[0]), {
    session: "S1", agent: null, agentType: null, kind: "agent", tool: "Agent", spawned: "done-gate:reviewer",
  });
  assert.deepEqual(pick(eventsFromHookInput(stdin("skill"), "/repo")[0]), {
    session: "S1", agent: null, agentType: null, kind: "skill", tool: "Skill", skill: "verify",
  });
  // a browser event also keeps what was done: the fixture's tool_input.action is "screenshot"
  const browser = pick(eventsFromHookInput(stdin("chrome"), "/repo")[0]);
  assert.equal(browser.kind, "browser");
  assert.equal(browser.tool, "mcp__claude-in-chrome__computer");
  assert.equal(browser.action, "screenshot");
  assert.equal(browser.agent, null);
});

test("an edit inside a subagent keeps the agent id and type", () => {
  const [e] = eventsFromHookInput(stdin("sub-edit"), "/repo");
  assert.equal(e.agent, "A9");
  assert.equal(e.agentType, "done-gate:qa");
  assert.equal(e.path, "tests/y.test.ts");
});

test("SubagentStart/Stop, UserPromptSubmit and SessionStart map to their kinds", () => {
  assert.equal(eventsFromHookInput(stdin("subagent-start"), "/repo")[0].kind, "subagent-start");
  const stop = eventsFromHookInput(stdin("subagent-stop"), "/repo")[0];
  assert.equal(stop.kind, "subagent-stop");
  assert.equal(stop.agentType, "done-gate:reviewer");
  const prompt = eventsFromHookInput(stdin("prompt"), "/repo")[0];
  assert.equal(prompt.kind, "prompt");
  assert.equal(prompt.text, "fix the badge on the venue card please");
  const start = eventsFromHookInput(stdin("session-start"), "/repo")[0];
  assert.equal(start.kind, "session-start");
  assert.equal(start.source, "startup");
});

test("an unrecognised payload produces no events and never throws", () => {
  assert.deepEqual(eventsFromHookInput({ __unparseable: "garbage" }, "/repo"), []);
  assert.deepEqual(eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, "/repo"), []);
});

test("appendEvents/readEvents round-trip per session, in seq order", () => {
  const a = eventsFromHookInput(stdin("edit"), "/repo");
  const b = eventsFromHookInput(stdin("bash"), "/repo");
  appendEvents(tmp, "S1", a);
  appendEvents(tmp, "S1", b);
  appendEvents(tmp, "S2", eventsFromHookInput(stdin("write"), "/repo"));
  const s1 = readEvents(tmp, "S1");
  assert.deepEqual(s1.map((e) => e.kind), ["edit", "command"]);
  assert.ok(s1[0].seq < s1[1].seq);
  assert.equal(readEvents(tmp, "S2").length, 1);
  assert.deepEqual(readEvents(tmp, "nope"), []);
});

test("`gate log` CLI writes the line and answers the silent PostToolUse envelope", () => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "gate.mjs"), "log"], {
    input: readFileSync(path.join(here, "fixtures", "stdin", "edit.json"), "utf8"),
    encoding: "utf8",
    env: { ...process.env, DONE_GATE_STATE_DIR: tmp, CLAUDE_PROJECT_DIR: "/repo" },
  });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { continue: true, suppressOutput: true });
  const file = path.join(tmp, "sessions", "S1", "events.jsonl");
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).path, "src/app/page.tsx");
});
}

// ===== from tests/guard.test.mjs =====
{
const repo = makeRepo("guard", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
const cfg = loadConfig(repo);
const input = (tool, file_path, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path }, cwd: repo, session_id: "S1", ...extra });

test("evidence files under the run dir are denied for everyone, ledger.md stays writable", () => {
  for (const f of ["events.jsonl", "verify.json", "decisions.tsv", "ledger.json", "blocks.json"]) {
    assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/${f}`), repo, cfg).deny, true, f);
  }
  assert.equal(decide(input("Edit", `${repo}/.claude/gate/sessions/S1/state.json`), repo, cfg).deny, true);
  assert.equal(decide(input("Edit", `${repo}/.claude/gate/runs/x/ledger.md`), repo, cfg).deny, false);
});

test("a Bash command that writes an evidence file is denied; reads and ordinary commands pass", () => {
  const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1" });
  assert.equal(decide(bash("echo x >> .claude/gate/runs/x/events.jsonl"), repo, cfg).deny, true);
  assert.equal(decide(bash("cat .claude/gate/runs/x/verify.json"), repo, cfg).deny, false);
  assert.equal(decide(bash("npm test"), repo, cfg).deny, false);
  assert.equal(decide(bash("node gate.mjs verify"), repo, cfg).deny, false);
});

test("the QA agent may write only under the tests globs", () => {
  const qa = { agent_id: "A1", agent_type: "done-gate:qa" };
  const planned = { slug: "x", taskSeq: 1, contextSeq: 2, planSeq: 3, cases: [{ id: "C1" }], steps: [{ key: "context" }, { key: "plan" }, { key: "cases" }], waivers: [] };
  assert.equal(decide(input("Write", `${repo}/tests/new.test.ts`, qa), repo, cfg, ".claude/gate/runs/x", planned).deny, false);
  assert.equal(decide(input("Edit", `${repo}/src/a.ts`, qa), repo, cfg).deny, true);
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/ledger.md`, qa), repo, cfg).deny, true);
});

test("a QA shell write to a test or source file is refused and names the Write tool", () => {
  const qa = { agent_id: "A1", agent_type: "done-gate:qa" };
  const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1", ...qa });
  for (const command of ["cat > tests/new.test.ts <<'EOF'\nx\nEOF", "echo x > src/a.ts"]) {
    const verdict = decide(bash(command), repo, cfg);
    assert.equal(verdict.deny, true, command);
    assert.match(verdict.reason, /use the Write tool/, command);
  }
});

test("the reviewer may write only its own review-<n>.md inside the open task's run dir, and nothing at all when no ledger is open", () => {
  // A helper's file belongs to the session's own task, so the rule needs a real open run dir.
  const open = makeRepo("guard-open", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: open, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  const opened = spawnSync(process.execPath, [gate, "open", "guard-open", "feature"], { encoding: "utf8", env });
  assert.equal(opened.status, 0, opened.stderr);
  const dir = path.join(open, ".claude", "gate", "runs", loadSession(path.join(open, ".claude", "gate"), "S1").current);
  const openInput = (tool, file_path, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path }, cwd: open, session_id: "S1", ...extra });

  // Which run dir is "the open task's" is resolved from the session, so this half goes
  // through `gate fence` — the hook entry point — rather than the in-process helper.
  const fence = (payload) => {
    const r = spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify(payload), encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const rv = { agent_id: "A2", agent_type: "done-gate:reviewer" };
  assert.equal(fence(openInput("Write", path.join(dir, "review-1.md"), rv)), false);
  assert.equal(fence(openInput("Write", path.join(dir, "review2-1.md"), { ...rv, agent_type: "done-gate:reviewer-2" })), false);
  assert.equal(fence(openInput("Write", path.join(dir, "review-2.md"), { ...rv, agent_type: "done-gate:reviewer-2" })), true);
  assert.equal(fence(openInput("Edit", `${open}/src/a.ts`, rv)), true);
  assert.equal(fence(openInput("Write", path.join(dir, "ledger.md"), rv)), true);
  // another task's run dir is not this reviewer's to write
  assert.equal(fence(openInput("Write", path.join(open, ".claude", "gate", "runs", "other", "review-1.md"), rv)), true);

  // the refused side: no ledger means no task, so there is no file the reviewer may write
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/review-1.md`, rv), repo, cfg).deny, true);
});

test("the skeptic may write only its own skeptic-<n>.md in the open task's run dir; unknown agents and the main session follow the evidence and plan-first rules only", () => {
  assert.equal(decide(input("Write", `${repo}/notes.md`, { agent_id: "A3", agent_type: "done-gate:skeptic" }), repo, cfg).deny, true);
  // no ledger is open in this repo, so even a well-named skeptic file is refused
  assert.equal(decide(input("Write", `${repo}/.claude/gate/runs/x/skeptic-1.md`, { agent_id: "A3", agent_type: "done-gate:skeptic" }), repo, cfg).deny, true);
  assert.equal(decide(input("Write", `${repo}/docs/notes.md`, { agent_id: "A4", agent_type: "general-purpose" }), repo, cfg).deny, false);
  assert.equal(decide(input("Write", `${repo}/docs/notes.md`), repo, cfg).deny, false);
  // code waits for a planned run, for any caller
  assert.equal(decide(input("Write", `${repo}/src/a.ts`, { agent_id: "A4", agent_type: "general-purpose" }), repo, cfg).deny, true);
});

test("`gate fence` emits the PreToolUse deny envelope and logs the attempt; allows are silent", () => {
  const run = (payload) => spawnSync(process.execPath, [gate, "fence"], {
    input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
  const denied = run(input("Write", `${repo}/.claude/gate/runs/x/verify.json`));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /evidence/);
  const events = readFileSync(path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl"), "utf8");
  assert.match(events, /"kind":"deny"/);
  const allowed = run(input("Write", `${repo}/docs/notes.md`));
  assert.equal(allowed.stdout.trim(), "");
});
}

// ===== from tests/events-hooks.test.mjs =====
{
// T6 — the lead-delegation fence. When a ledger is open on a tiered playbook and the
// plan predicted standard or large, the main session (no agent_type) may not edit source
// or tests; it is told to brief and spawn a worker. The worker may. Everything else —
// small tasks, an un-tiered playbook, no --files, no open ledger, the other helper roles —
// is unchanged.
//
// The fence is driven the way production drives it: a PreToolUse payload on stdin to
// `gate fence`, so which run dir and which ledger are "the open task's" is resolved by the
// session, not by this test. Ledgers are built with the real CLI and read back from
// ledger.json (tests/tier-policy.test.mjs's ledgerOf()).

// ---------------------------------------------------------------------------
// conventions (mirrors tests/guard.test.mjs and tests/tier-policy.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function cli(repo, verb, args = [], session = "S1") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input: "",
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  return r;
}

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD: `gate open` snapshots the tree against HEAD.
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));

// A PreToolUse payload, exactly as tests/guard.test.mjs builds one.
const pre = (repo, tool, file_path, extra = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: { file_path },
  cwd: repo,
  session_id: "S1",
  ...extra,
});

// `gate fence` on stdin: null when the call is allowed (the hook stays silent),
// otherwise the deny reason the model is shown.
function fence(repo, payload) {
  const r = spawnSync(process.execPath, [gate, "fence"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  if (out === "") return null;
  const hook = JSON.parse(out).hookSpecificOutput;
  assert.equal(hook.permissionDecision, "deny", out);
  return hook.permissionDecisionReason;
}

// A ledger open on `playbook` whose plan named `files`, so tier.predicted is whatever the
// CLI derives from them. Returns the repo.
function openedWith(name, { playbook = "feature", files = null, extra = {} } = {}) {
  const repo = committed(name, extra);
  cli(repo, "open", [name, playbook]);
  readyToEdit(repo, { plan: files ? ["--files", files.join(",")] : [] });
  // these tests are about who edits once code may be edited, so the plan check is run first
  if (ledgerOf(repo).checkHold) planChecked(repo);
  return repo;
}

const stdinFixture = (name) =>
  JSON.parse(readFileSync(path.join(here, "fixtures", "stdin", `${name}.json`), "utf8"));

// ---------------------------------------------------------------------------
// C1 — the lead is fenced off source once the plan predicts large (policy.delegatesAt)
// ---------------------------------------------------------------------------

// eleven files: one more than models.json tiers.standard.maxFiles
const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i + 1}.ts`);
const LARGE_EXTRA = Object.fromEntries(LARGE.map((f) => [f, "export const x = 1;\n"]));
// on a run under the new rules the edit tools take only planned code, so the files edited are planned
const LARGE_PLAN = [...LARGE, "src/a.ts", "src/b.ts", "src/nb.ipynb"];

test("C1 happy: at predicted large the lead's Edit/Write/MultiEdit/NotebookEdit on source is allowed", () => {
  const repo = openedWith("fence-c1", { files: LARGE_PLAN, extra: LARGE_EXTRA });
  assert.equal(ledgerOf(repo).tier.predicted, "large");
  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))), null, "Edit");
  assert.equal(fence(repo, pre(repo, "Write", path.join(repo, "src/b.ts"))), null, "Write");
  assert.equal(
    fence(repo, {
      ...pre(repo, "MultiEdit", undefined),
      tool_input: { edits: [{ file_path: path.join(repo, "src/a.ts") }, { file_path: path.join(repo, "src/b.ts") }] },
    }),
    null,
    "MultiEdit",
  );
  assert.equal(
    fence(repo, { ...pre(repo, "NotebookEdit", undefined), tool_input: { notebook_path: path.join(repo, "src/nb.ipynb") } }),
    null,
    "NotebookEdit",
  );
});

test("C1 happy: a plan naming two files predicts standard and the lead still edits source there", () => {
  const repo = openedWith("fence-c1-standard", { files: ["src/a.ts", "src/b.ts"] });
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))), null, "the lead implements at standard");
});

// ---------------------------------------------------------------------------
// C2 — everything the fence must leave alone
// ---------------------------------------------------------------------------

// reversed in 0.22: a plan that named no files is asked to name them (tests/plan-binds.test.mjs C6)
test("C2 happy: the lead still edits source when the prediction is small and on the un-tiered plan playbook; a plan that named no files is asked to name them; with no run open it is refused", () => {
  const small = openedWith("fence-c2-small", { files: ["src/a.ts"] });
  assert.equal(ledgerOf(small).tier.predicted, "tiny");
  assert.equal(fence(small, pre(small, "Edit", path.join(small, "src/a.ts"))), null, "tier tiny");

  const noFiles = openedWith("fence-c2-nofiles");
  assert.equal(ledgerOf(noFiles).tier.predicted, null, "no --files means no prediction");
  assert.match(fence(noFiles, pre(noFiles, "Edit", path.join(noFiles, "src/a.ts"))) ?? "", /names no files/, "no prediction");

  // no ledger at all: `gate open` was never run here, so code waits for one
  const none = committed("fence-c2-none");
  assert.match(fence(none, pre(none, "Edit", path.join(none, "src/a.ts"))) ?? "", /no run is open/, "no open ledger");

  // scripts/lib/ledger.mjs gives a tier only to feature/bugfix/refactor; plan gets null
  const planned = openedWith("fence-c2-plan", { playbook: "plan", files: ["src/a.ts", "src/b.ts"] });
  assert.equal(ledgerOf(planned).tier, null, "the plan playbook is never tiered");
  assert.equal(fence(planned, pre(planned, "Edit", path.join(planned, "src/a.ts"))), null, "plan playbook");
});

test("C2 happy: bugfix and refactor are tiered too, and the lead edits at large there as well", () => {
  for (const playbook of ["bugfix", "refactor"]) {
    const repo = openedWith(`fence-c2-${playbook}`, { playbook, files: LARGE_PLAN, extra: LARGE_EXTRA });
    assert.equal(ledgerOf(repo).tier.predicted, "large", playbook);
    assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))), null, playbook);
  }
});

// ---------------------------------------------------------------------------
// C3 — the boundary is config.isSource(), which covers tests and skips docs
// ---------------------------------------------------------------------------

test("C3 edge: at large a test file is the lead's like source; docs/notes.md and the run dir's ledger.md stay writable", () => {
  const repo = openedWith("fence-c3", { files: LARGE, extra: LARGE_EXTRA });
  assert.equal(ledgerOf(repo).tier.predicted, "large");

  // the boundary, read from the config that owns it (source **, minus docs/** and **/*.md)
  const cfg = loadConfig(repo);
  assert.equal(cfg.isSource("tests/a.test.ts"), true);
  assert.equal(cfg.isSource("docs/notes.md"), false);
  assert.equal(cfg.isSource(".claude/gate/runs/x/ledger.md"), false);

  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "tests/a.test.ts"))), null, "tests are the lead's too");

  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "docs/notes.md"))), null, "docs");
  assert.equal(fence(repo, pre(repo, "Write", path.join(runDir(repo), "ledger.md"))), null, "ledger.md");
});

// ---------------------------------------------------------------------------
// C4 — the worker is the role the deny points at
// ---------------------------------------------------------------------------

test("C4 happy: a done-gate:worker edits source and tests at large, but not another role's review-1.md", () => {
  const repo = openedWith("fence-c4", { files: LARGE, extra: LARGE_EXTRA });
  assert.equal(ledgerOf(repo).tier.predicted, "large");
  const worker = { agent_id: "A7", agent_type: "done-gate:worker" };

  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"), worker)), null, "source");
  assert.equal(fence(repo, pre(repo, "Write", path.join(repo, "tests/a.test.ts"), worker)), null, "tests");
  assert.ok(fence(repo, pre(repo, "Write", path.join(runDir(repo), "review-1.md"), worker)), "review-1.md");
});

// ---------------------------------------------------------------------------
// C5 — the other helper roles are untouched by the new branch
// ---------------------------------------------------------------------------

test("C5 boundary: done-gate:qa is still refused source and still allowed tests at predicted standard", () => {
  const repo = openedWith("fence-c5", { files: ["src/a.ts", "src/b.ts"] });
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  const qa = { agent_id: "A1", agent_type: "done-gate:qa" };

  const denied = fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"), qa));
  assert.ok(denied, "QA never edits source");
  assert.doesNotMatch(denied, /gate brief worker/, "QA is refused as QA, not told to brief a worker");
  assert.equal(fence(repo, pre(repo, "Write", path.join(repo, "tests/a.test.ts"), qa)), null, "tests");
});

// ---------------------------------------------------------------------------
// C6 — the deny is evidence: an event, and a count in the report
// ---------------------------------------------------------------------------

test("C6 edge: a fenced write is logged as a deny event and the report counts it", () => {
  const repo = openedWith("fence-c6", { files: LARGE, extra: LARGE_EXTRA });
  assert.deepEqual(readEvents(stateDir(repo), "S1").filter((e) => e.kind === "deny"), [], "nothing denied yet");

  assert.ok(fence(repo, pre(repo, "Write", path.join(repo, ".claude/gate/runs/x/ledger.json"))));

  const denies = readEvents(stateDir(repo), "S1").filter((e) => e.kind === "deny");
  assert.equal(denies.length, 1);
  assert.equal(denies[0].session, "S1");
  assert.equal(denies[0].agentType ?? null, null, "the lead has no agent type");
  assert.match(cli(repo, "report").stdout, /blocked writes to gate files 1/);
});

// ---------------------------------------------------------------------------
// C8 — a measured size can fence the lead even when the plan predicted small
// ---------------------------------------------------------------------------

test("C8 boundary: a plan that predicted small and grew to a measured large leaves the lead free to edit", () => {
  const repo = openedWith("fence-c8", { files: ["src/a.ts"] });
  assert.equal(ledgerOf(repo).tier.predicted, "tiny", "the plan named one file");
  for (const f of LARGE) write(repo, f, "export const x = 2;\n");
  cli(repo, "check");
  assert.equal(ledgerOf(repo).tier.measured.tier, "large");
  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))), null);
});

// reversed in 0.22, as C2's plan with no files
test("C8 boundary: with no prediction and nothing measured yet the lead is asked to name the files, not fenced by size", () => {
  const repo = openedWith("fence-c8-unmeasured"); // no --files
  assert.equal(ledgerOf(repo).tier.predicted, null);
  cli(repo, "check"); // nothing has changed, so there is no standard measurement to fence on
  assert.notEqual(ledgerOf(repo).tier.measured?.tier ?? null, "standard");
  assert.match(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))) ?? "", /names no files/);
});

// ---------------------------------------------------------------------------
// C7 — the ordinary pass-through is unchanged
// ---------------------------------------------------------------------------

test("C7 idempotent: the tests/fixtures/stdin edit payloads pass the fence silently once a run is planned", () => {
  const repo = committed("fence-c7");
  cli(repo, "open", ["fence-c7", "feature"]);
  readyToEdit(repo, { plan: ["--files", "src/app/page.tsx,src/a.ts,src/b.ts"] });
  planChecked(repo);
  // the fixtures address /repo; point them at this one, and ask the fence rather than the log
  const asPreToolUse = (name) =>
    JSON.parse(JSON.stringify(stdinFixture(name)).split("/repo").join(repo).split('"PostToolUse"').join('"PreToolUse"'));

  for (const name of ["edit", "write", "multiedit", "sub-edit"]) {
    const payload = asPreToolUse(name);
    assert.equal(payload.hook_event_name, "PreToolUse", name);
    assert.equal(fence(repo, payload), null, name);
  }

  // and a Bash payload that names no evidence file is still none of the fence's business
  assert.equal(fence(repo, asPreToolUse("bash")), null, "bash");
});
}

test("a <cross-session-message> prompt from another session is tagged as a hand-back, so it is not a new turn", () => {
  const ev = (text) => eventsFromHookInput({ hook_event_name: "UserPromptSubmit", session_id: "S1", prompt: text }, "/repo")[0];
  assert.equal(ev('<cross-session-message from="uds:/tmp/cc-socks/42468.sock" f>after task 12 stop</cross-session-message>').handback, true);
  assert.equal(ev("fix the badge").handback, undefined);
});

test("4.2 C4 a helper's notice rides on its prompt event as agent, status and cause; other texts carry none", () => {
  const ev = (text) => eventsFromHookInput({ hook_event_name: "UserPromptSubmit", session_id: "S1", prompt: text }, "/repo")[0];
  const tn = (status, summary) => `<task-notification>\n<task-id>a89641e7ffb541041</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
  assert.deepEqual(ev(tn("completed", 'Agent "Blind QA tests" stopped at its 60-turn limit (partial result; SendMessage to task-id to continue)')).notice, { agent: "a89641e7ffb541041", status: "completed", cause: "turn-limit" });
  assert.deepEqual(ev(tn("completed", 'Agent "Review" finished')).notice, { agent: "a89641e7ffb541041", status: "completed", cause: "finished" });
  assert.equal(ev(tn("completed", 'Background command "Run the full checks" completed (exit code 0)')).notice, undefined);
  assert.equal(ev("fix the badge").notice, undefined);
  assert.equal(ev(`<agent-message from="a1">see ${tn("failed", 'Agent "x" failed: server error')}</agent-message>`).notice, undefined);
});

// ---- 4.4: the lead's failed turn, and the same failing command twice ----
{
const pluginDir = path.resolve(here, "..");
const envFor = (repo) => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
};
const cli = (repo, verb, args = []) => {
  const r = spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env: envFor(repo) });
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  return r;
};
const committed = (name) => {
  const repo = makeRepo(name);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
};

const log44 = (repo, payload) => {
  const r = spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? null;
};
const stopFailure = (error, details, extra = {}) => ({ hook_event_name: "StopFailure", error, error_details: details, last_assistant_message: "I was in the middle of it", ...extra });
const prompt44 = (repo, text = "carry on") => log44(repo, { hook_event_name: "UserPromptSubmit", prompt: text });
const bashFail = (repo, command, exit = 1, extra = {}) => log44(repo, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, tool_error: `Exit code ${exit}\nboom`, ...extra });
const bashOk = (repo, command) => log44(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "ok" } });
function opened44(name) {
  const repo = committed(name);
  cli(repo, "open", [name, "feature"]);
  return repo;
}

test("4.4 C1 StopFailure is wired to gate log and a lead's failure is logged as turn-failed; a helper's is not", () => {
  const hooks = JSON.parse(readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf8")).hooks;
  assert.ok((hooks.StopFailure ?? []).some((h) => h.hooks.some((x) => /gate\.mjs" log/.test(x.command))), "hooks.json has no StopFailure entry calling gate log");
  const [e] = eventsFromHookInput({ session_id: "S1", ...stopFailure("server_error", "API Error: 500") }, "/repo");
  assert.equal(e.kind, "turn-failed");
  assert.equal(e.error, "server_error");
  assert.equal(e.details, "API Error: 500");
  assert.equal(e.text, "I was in the middle of it");
  assert.equal(eventsFromHookInput({ session_id: "S1", hook_event_name: "StopFailure" }, "/repo")[0].error, "unknown");
  assert.deepEqual(eventsFromHookInput({ session_id: "S1", agent_id: "A1", ...stopFailure("server_error", "x") }, "/repo"), []);
});

test("4.4 C2 each error group gives its sentence", () => {
  const rows = [
    ["rate_limit", "429 Too Many Requests", /session limit[\s\S]*resets 6:40pm[\s\S]*wait/i, "You've hit your session limit · resets 6:40pm"],
    ["rate_limit", "429 rate limited", /passing API problem[\s\S]*carry on/i],
    ["overloaded", "529 Overloaded", /passing API problem/i],
    ["server_error", "500", /passing API problem/i],
    ["billing_error", "Credit balance too low", /only the user can fix[\s\S]*Credit balance too low/i],
    ["authentication_failed", "Invalid API key", /only the user can fix/i],
    ["max_output_tokens", "", /output limit[\s\S]*smaller/i],
    ["invalid_request", "a refusal nobody has seen", /a refusal nobody has seen[\s\S]*ask the user/i],
    ["something_new", "brand new wording", /brand new wording[\s\S]*ask the user/i],
  ];
  for (const [i, [error, details, words, shown]] of rows.entries()) {
    const repo = opened44(`ev-44-c2-${i}`);
    log44(repo, stopFailure(error, details, shown ? { last_assistant_message: shown } : {}));
    const told = prompt44(repo);
    assert.match(told ?? "", /last turn ended on an error/, `${error}: ${told}`);
    assert.match(told, words, `${error}: ${told}`);
  }
});

test("4.4 C3 the next prompt is told once, naming the helpers still out", () => {
  const repo = opened44("ev-44-c3");
  log44(repo, { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "done-gate:reviewer" });
  log44(repo, stopFailure("overloaded", "529 Overloaded"));
  const told = prompt44(repo);
  assert.match(told, /done-gate:reviewer \(A1\)/);
  assert.equal(prompt44(repo, "and again"), null, "the failed turn was told twice");
});

test("4.4 C4 no run open, or no failed turn, says nothing", () => {
  const none = committed("ev-44-c4-none");
  log44(none, stopFailure("overloaded", "529"));
  assert.equal(prompt44(none), null, "no run open still told");
  const clean = opened44("ev-44-c4-clean");
  assert.equal(prompt44(clean), null, "a prompt with no failed turn told something");
});

test("4.4 C5 the same failing command twice in a row gets one note; a third gets none", () => {
  const repo = opened44("ev-44-c5");
  assert.equal(bashFail(repo, "npm test"), null, "a first failure got a note");
  const note = bashFail(repo, "npm test");
  assert.match(note ?? "", /`npm test` failed the same way twice/);
  assert.match(note, /exit 1/);
  assert.equal(bashFail(repo, "npm test"), null, "a third failure in a row got another note");
});

test("4.4 C6 an edit, a success or another exit between gets no note; lead and helper are counted apart", () => {
  const edit = opened44("ev-44-c6-edit");
  bashFail(edit, "npm test");
  log44(edit, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(edit, "src", "a.ts"), content: "x" }, tool_response: {} });
  assert.equal(bashFail(edit, "npm test"), null, "an edit between still got a note");

  const ok = opened44("ev-44-c6-ok");
  bashFail(ok, "npm test");
  bashOk(ok, "npm test");
  assert.equal(bashFail(ok, "npm test"), null, "a success between still got a note");

  const exit = opened44("ev-44-c6-exit");
  bashFail(exit, "npm test", 1);
  assert.equal(bashFail(exit, "npm test", 2), null, "another exit still got a note");

  const split = opened44("ev-44-c6-split");
  bashFail(split, "npm test");
  assert.equal(bashFail(split, "npm test", 1, { agent_id: "W1", agent_type: "done-gate:worker" }), null, "a helper's failure paired with the lead's");
  assert.match(bashFail(split, "npm test") ?? "", /failed the same way twice/, "the lead's own second failure got no note");
});

test("4.4 C7 session-limit wording only in the shown message still reads as the session limit", () => {
  const repo = opened44("ev-44-c7");
  log44(repo, stopFailure("rate_limit", "429 Too Many Requests", { last_assistant_message: "You've hit your session limit · resets 9:15pm" }));
  const told = prompt44(repo);
  assert.match(told, /session limit/i);
  assert.doesNotMatch(told, /passing API problem/);
});

test("4.4 C8 a prompt long after the failure still points at gate diagnose for the helper it cut off", () => {
  const repo = opened44("ev-44-c8");
  log44(repo, { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "done-gate:reviewer" });
  log44(repo, stopFailure("rate_limit", "429", { last_assistant_message: "You've hit your session limit · resets 6:40pm" }));
  const file = path.join(repo, ".claude", "gate", "sessions", "S1", "events.jsonl");
  const old = new Date(Date.now() - 50 * 60 * 1000).toISOString();
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), ts: old }));
  writeFileSync(file, `${lines.join("\n")}\n`);
  const told = prompt44(repo);
  assert.match(told, /gate diagnose/);
  assert.doesNotMatch(told, /still out: done-gate:reviewer/);
});

test("4.4 C9 a hand-back arriving first does not use up the telling", () => {
  const repo = opened44("ev-44-c9");
  log44(repo, stopFailure("overloaded", "529 Overloaded"));
  assert.equal(prompt44(repo, '<agent-message from="a1">[Subagent hand-back] done</agent-message>'), null, "a hand-back was told the failed turn");
  assert.match(prompt44(repo) ?? "", /last turn ended on an error/, "the user's own message was not told after a hand-back");
});
}
