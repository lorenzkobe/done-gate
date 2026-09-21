// C9 — one whole session, driven the way production drives it: the hook verbs are fed a
// JSON payload on stdin and get their session id from it; the shell verbs are spawned with
// no session env at all and must find the session through the marker the SessionStart hook
// wrote. Session start → blocked stop → open → the task → close → the finalising stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

const NODE = JSON.stringify(process.execPath);
const SESSION = "E1";

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const markerOf = (repo) => path.join(stateDir(repo), "current-session");
const sessionsOf = (repo) => path.join(stateDir(repo), "sessions");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), SESSION).current);
const ledgerOf = (dir) => JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8"));

// The model's own shell: no DONE_GATE_SESSION, no CLAUDE_CODE_SESSION_ID. The runner's
// env carries a real CLAUDE_CODE_SESSION_ID, so both are deleted explicitly.
function shellEnv(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo };
  delete e.DONE_GATE_SESSION;
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.DONE_GATE_STATE_DIR;
  return e;
}

// A shell verb: stdin is closed (non-hook verbs hang on an open pipe) and carries no JSON.
function sh(repo, args) {
  const r = spawnSync(process.execPath, [gate, ...args], {
    input: "",
    encoding: "utf8",
    env: shellEnv(repo),
  });
  assert.equal(r.status, 0, `gate ${args.join(" ")}\n${r.stderr}`);
  return r;
}

// A hook verb: the id comes from the payload, never from the env.
function hookVerb(repo, verb, payload) {
  const r = spawnSync(process.execPath, [gate, verb], {
    input: JSON.stringify({ session_id: SESSION, cwd: repo, ...payload }),
    encoding: "utf8",
    env: shellEnv(repo),
  });
  assert.equal(r.status, 0, `gate ${verb}\n${r.stderr}`);
  return r;
}

const sessionStart = (repo) =>
  hookVerb(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });

const stop = (repo, message = "report") => {
  const r = hookVerb(repo, "stop", {
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: message,
  });
  return { ...r, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null };
};

// An edit as Claude Code reports it: the PostToolUse hook fires, then the bytes land.
function edit(repo, tool, rel, content) {
  hookVerb(repo, "log", {
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { file_path: path.join(repo, rel) },
    tool_output: "ok",
  });
  write(repo, rel, content);
}

test("C9 happy: one session end to end — session start, a blocked stop, open, the task, close, and the finalising stop", () => {
  const repo = makeRepo("e2e-session", {
    ".claude/gate.json": JSON.stringify({
      verify: [
        { cmd: `${NODE} -e "process.exit(0)" # npm run lint`, when: "always" },
        { cmd: `${NODE} -e "process.exit(0)" # npm run build`, when: "source" },
      ],
    }),
  });

  // ---- SessionStart writes the marker -------------------------------------
  sessionStart(repo);
  assert.equal(readFileSync(markerOf(repo), "utf8").trim(), SESSION);

  // ---- an edit with no ledger open: the stop blocks with R1 ---------------
  // The edit goes through the `log` hook, so the session's first source-edit event lands
  // before the ledger exists. R2 blocks only while the Plan or the case table is missing;
  // once they exist the late order is recorded, not blocked (see the tail of this test).
  edit(repo, "Edit", "src/a.ts", "export const a = 2;\n");
  const blocked = stop(repo);
  assert.equal(blocked.json?.decision, "block", blocked.stdout);
  assert.match(blocked.json.reason, /R1/);

  // ---- open from the shell, with no session env at all ---------------------
  const opened = sh(repo, ["open", "badge", "feature"]);
  assert.match(opened.stdout, /^ledger: /m, opened.stderr);
  const state = loadSession(stateDir(repo), SESSION);
  assert.ok(state?.current, "the ledger landed in sessions/E1, found through the marker");
  assert.equal(
    existsSync(path.join(sessionsOf(repo), "no-session")),
    false,
    "a shell verb with no session env must not fall back to sessions/no-session",
  );
  const dir = runDir(repo);
  assert.deepEqual(ledgerOf(dir).sessions, [SESSION]);

  // R1 is met now: the stop still blocks on the work that is missing, but never on R1.
  const afterOpen = stop(repo);
  assert.equal(afterOpen.json?.decision, "block", afterOpen.stdout);
  assert.ok(!/R1\b/.test(afterOpen.json.reason), `R1 should be met once a ledger is open:\n${afterOpen.json.reason}`);

  // ---- the task ------------------------------------------------------------
  sh(repo, ["note", "task", "Make a() return 2. [inferred]"]);
  sh(repo, ["note", "context", "Traced: src/a.ts:1 is the entry, read by src/app/page.tsx:1.\nRelated: tests/a.test.ts pins it.\nResearch: none needed: a local change."]);
  sh(repo, ["note", "plan", "One file, one constant.", "--files", "src/a.ts"]);
  sh(repo, ["case", "add", "a() returns 2", "--kind", "happy"]);
  sh(repo, ["case", "close", "C1", "--na", "covered by the existing fixture"]);

  edit(repo, "Write", "tests/a.test.ts", "test('a', () => { /* returns 2 */ });\n");
  sh(repo, ["verify"]);

  // ---- the reviewer pass ---------------------------------------------------
  hookVerb(repo, "log", {
    hook_event_name: "SubagentStop",
    agent_id: "A9",
    agent_type: "done-gate:reviewer",
    stop_hook_active: false,
  });
  writeFileSync(path.join(dir, "review-1.md"), "# Review 1\n\n## Act on\n\n_none_\n");
  sh(repo, ["huddle", "add", "reviewer", "--file", "review-1.md"]);

  // ---- close every step the playbook left blank ----------------------------
  for (const step of ledgerOf(dir).steps) {
    if (step.state !== null || step.key === "close") continue;
    const r = spawnSync(process.execPath, [gate, "step", step.key, "na", "not needed for a one-constant change"], {
      input: "",
      encoding: "utf8",
      env: shellEnv(repo),
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const stillBlank = ledgerOf(dir).steps.filter((s) => s.state === null && s.key !== "close");
  assert.deepEqual(stillBlank.map((s) => s.key), [], "no playbook step is left blank");

  sh(repo, ["close"]);
  assert.equal(ledgerOf(dir).status, "closing");

  // ---- the late order is recorded, not blocked ----------------------------
  // src/a.ts was edited before the ledger existed, so the Plan and the case table were
  // both written after the first code change. The gate says so in both reports.
  const full = sh(repo, ["report"]).stdout;
  assert.match(
    full,
    /Plan and case table written after the first source edit \(src\/a\.ts\)/,
    `the full report's Attention should record the late order:\n${full}`,
  );
  const brief = sh(repo, ["report", "--brief"]).stdout;
  assert.match(
    brief,
    /written after the first code change/,
    `the brief should say the plan came after the code:\n${brief}`,
  );

  // ---- the finalising stop -------------------------------------------------
  const final = stop(repo);
  assert.equal(final.stdout.trim(), "", `the finalising stop should allow the turn:\n${final.stdout}`);
  assert.equal(ledgerOf(dir).status, "closed");
  const closedState = loadSession(stateDir(repo), SESSION);
  assert.ok(closedState.lastClosed, "the session records the run it just closed");
  assert.equal(closedState.lastClosed, path.basename(dir));
  assert.equal(closedState.current, null, "no ledger is open any more");
});
