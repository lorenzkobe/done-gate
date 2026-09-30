import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { decide } from "../scripts/lib/guard.mjs";

function run(repo, verb, session, input = {}, args = []) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session },
  });
}
const start = (repo, session, source) => run(repo, "session-start", session, { hook_event_name: "SessionStart", session_start_source: source });
const startContext = (repo, session, source) => JSON.parse(start(repo, session, source).stdout).hookSpecificOutput.additionalContext;
const stop = (repo, session) => run(repo, "stop", session, { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done." });
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const r3 = (out) => out.split("\n").filter((l) => /\bR3\b/.test(l));

test("C1 happy: gate verify writes verify.started.json before the first command and removes it once verify.json lands, green or red", () => {
  const repo = makeRepo("ff-marker");
  run(repo, "open", "S1", {}, ["t", "feature"]);
  const marker = path.join(runDir(repo), "verify.started.json");
  write(repo, "sees.mjs", `import { existsSync } from "node:fs"; process.exit(existsSync(${JSON.stringify(marker)}) ? 0 : 7);\n`);
  const sees = `${JSON.stringify(process.execPath)} sees.mjs`;
  writeFileSync(path.join(repo, ".claude", "gate.json"), JSON.stringify({ verify: [sees] }));
  const green = run(repo, "verify", "S1");
  assert.match(green.stdout, /all 1 green/, green.stdout + green.stderr);
  assert.ok(!existsSync(marker), "marker removed after a green run");
  writeFileSync(path.join(repo, ".claude", "gate.json"), JSON.stringify({ verify: [`${sees} && exit 3`] }));
  const red = run(repo, "verify", "S1");
  assert.match(red.stdout, /1 of 1 red/);
  assert.ok(!existsSync(marker), "marker removed after a red run");
});

test("C2 reported-surface: a verify killed mid-run leaves the marker; R3 and the report say it started and never finished", () => {
  const repo = makeRepo("ff-killed");
  run(repo, "open", "S1", {}, ["t", "feature"]);
  write(repo, "src/a.ts", "export const a = 1;\n");
  writeFileSync(path.join(runDir(repo), "verify.started.json"), JSON.stringify({ startedAt: "2026-09-30T06:02:00.000Z", commands: ["pytest"] }));
  const lines = r3(run(repo, "check", "S1").stdout);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /started at 2026-09-30T06:02.*never finished/);
  assert.match(lines[0], /gate verify/);
  const report = run(repo, "report", "S1").stdout;
  assert.match(report, /started at 2026-09-30T06:02.*never finished/);
  assert.doesNotMatch(report, /_not run_/);
});

test("C10 edge: a marker whose process is alive reads as still running and does not ask for a rerun; a dead pid reads as never finished", () => {
  const repo = makeRepo("ff-running");
  run(repo, "open", "S1", {}, ["t", "feature"]);
  write(repo, "src/a.ts", "export const a = 1;\n");
  const marker = path.join(runDir(repo), "verify.started.json");
  writeFileSync(marker, JSON.stringify({ startedAt: "2026-09-30T06:02:00.000Z", pid: process.pid, commands: ["pytest"] }));
  const running = r3(run(repo, "check", "S1").stdout)[0];
  assert.match(running, /started at 2026-09-30T06:02.*still running.*do not start another/);
  assert.doesNotMatch(running, /never finished/);
  assert.match(run(repo, "report", "S1").stdout, /still running/);
  writeFileSync(marker, JSON.stringify({ startedAt: "2026-09-30T06:02:00.000Z", pid: 2147483000, commands: ["pytest"] }));
  assert.match(r3(run(repo, "check", "S1").stdout)[0], /never finished.*gate verify/);
});

test("C3 edge: an older finished verify plus a newer marker reads as a rerun that never finished, not as merely stale", () => {
  const repo = makeRepo("ff-rerun", { ".claude/gate.json": JSON.stringify({ verify: ["true"] }) });
  run(repo, "open", "S1", {}, ["t", "feature"]);
  write(repo, "src/a.ts", "export const a = 1;\n");
  assert.match(run(repo, "verify", "S1").stdout, /all 1 green/);
  write(repo, "src/a.ts", "export const a = 2;\n");
  writeFileSync(path.join(runDir(repo), "verify.started.json"), JSON.stringify({ startedAt: new Date(Date.now() + 1000).toISOString(), commands: ["true"] }));
  const lines = r3(run(repo, "check", "S1").stdout);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /never finished/);
  assert.doesNotMatch(lines[0], /stale/);
});

test("C4 reported-surface: a fresh session does not join another session's open run; it is told how to attach or abandon, and a Stop with nothing changed passes", () => {
  const repo = makeRepo("ff-foreign");
  start(repo, "S1", "startup");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  write(repo, "src/a.ts", "changed\n");
  const ctx = startContext(repo, "S2", "startup");
  assert.match(ctx, /gate attach badge/);
  assert.match(ctx, /gate abandon badge/);
  assert.ok(!loadSession(stateDir(repo), "S2")?.current, "S2 did not join");
  assert.equal(stop(repo, "S2").stdout.trim(), "", "S2 is not blocked for S1's diff");
});

test("C5 happy: a session started by clear, resume or compact still joins the open run", () => {
  const repo = makeRepo("ff-continue");
  start(repo, "S1", "startup");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  for (const source of ["clear", "resume", "compact"]) {
    const session = `S-${source}`;
    const ctx = startContext(repo, session, source);
    assert.match(ctx, /<done-gate-status>/, source);
    assert.match(loadSession(stateDir(repo), session).current, /badge/, source);
  }
});

test("C6 refused: gate attach joins the run by hand after a startup that did not", () => {
  const repo = makeRepo("ff-attach");
  start(repo, "S1", "startup");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  start(repo, "S2", "startup");
  assert.ok(!loadSession(stateDir(repo), "S2")?.current);
  const r = run(repo, "attach", "S2", {}, ["badge"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(loadSession(stateDir(repo), "S2").current, /badge/);
});

test("C7 reported-surface: gate open prints the verify commands it will run and where they come from", () => {
  const scripts = makeRepo("ff-open-scripts");
  assert.match(run(scripts, "open", "S1", {}, ["t", "feature"]).stdout, /^verify: npm run lint · npm run test · npm run build \(package\.json scripts\)$/m);
  const json = makeRepo("ff-open-json", { ".claude/gate.json": JSON.stringify({ verify: ["pytest tests/phone", "flake8 phone"] }) });
  assert.match(run(json, "open", "S1", {}, ["t", "feature"]).stdout, /^verify: pytest tests\/phone · flake8 phone \(\.claude\/gate\.json\)$/m);
  const none = makeRepo("ff-open-none", { ".claude/gate.json": JSON.stringify({ verify: [] }) });
  assert.match(run(none, "open", "S1", {}, ["t", "feature"]).stdout, /^verify: none/m);
});

test("C8 reported-surface: the pointer errors name ledger.md#<section>, and ledger.md#Plan resolves a skeptic finding", () => {
  const repo = makeRepo("ff-pointer");
  run(repo, "open", "S1", {}, ["t", "feature"]);
  run(repo, "note", "S1", {}, ["plan", "the plan keeps one pass"]);
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), "# Skeptic 1\n\n## Act on\n- the plan misses the empty case\n");
  run(repo, "huddle", "S1", {}, ["add", "skeptic", "--file", "skeptic-1.md"]);
  const bad = run(repo, "huddle", "S1", {}, ["resolve", "H1.1", "--evidence", "plan"]);
  assert.match(bad.stderr, /ledger\.md#<section>/);
  const dispute = run(repo, "huddle", "S1", {}, ["dispute", "H1.1", "not so", "--evidence", "plan"]);
  assert.match(dispute.stderr, /ledger\.md#<section>/);
  const good = run(repo, "huddle", "S1", {}, ["resolve", "H1.1", "--evidence", "ledger.md#Plan"]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /H1\.1 resolved/);
});

test("C9 refused: the verify start marker is an evidence file; a Write to it or an rm of it is denied, a read passes", () => {
  const repo = makeRepo("ff-guard");
  const cfg = loadConfig(repo);
  const marker = `${repo}/.claude/gate/runs/x/verify.started.json`;
  const tool = (tool_name, tool_input) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: repo, session_id: "S1" });
  assert.equal(decide(tool("Write", { file_path: marker }), repo, cfg).deny, true);
  assert.equal(decide(tool("Bash", { command: `rm ${marker}` }), repo, cfg).deny, true);
  assert.equal(decide(tool("Bash", { command: `cat ${marker}` }), repo, cfg).deny, false);
});
