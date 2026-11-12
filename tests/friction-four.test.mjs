import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, clearedFrom } from "./helpers.mjs";
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

test("C4 reported-surface: a fresh session does not join another session's open run; it is told how to attach and to ask the user before giving it up, and a Stop with nothing changed passes", () => {
  const repo = makeRepo("ff-foreign");
  start(repo, "S1", "startup");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  write(repo, "src/a.ts", "changed\n");
  const ctx = startContext(repo, "S2", "startup");
  assert.match(ctx, /gate attach badge/);
  assert.match(ctx, /ask the user before giving it up/);
  assert.doesNotMatch(ctx, /gate abandon badge/);
  assert.ok(!loadSession(stateDir(repo), "S2")?.current, "S2 did not join");
  assert.equal(stop(repo, "S2").stdout.trim(), "", "S2 is not blocked for S1's diff");
});

test("C5 happy: a session started by /clear joins the run the cleared session was on; resume and compact under a new id join nothing", () => {
  const repo = makeRepo("ff-continue");
  start(repo, "S1", "startup");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  clearedFrom(repo, "S1");
  const ctx = startContext(repo, "S-clear", "clear");
  assert.match(ctx, /<done-gate-status>/);
  assert.match(loadSession(stateDir(repo), "S-clear").current, /badge/);
  for (const source of ["resume", "compact"]) {
    startContext(repo, `S-${source}`, source);
    assert.equal(loadSession(stateDir(repo), `S-${source}`)?.current ?? null, null, source);
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

const preCompact = (repo, session, extra = {}) => run(repo, "pre-compact", session, { hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null, ...extra });

test("compaction C1 happy: with a run open, pre-compact tells the summariser what to keep and what the run folder already holds", () => {
  const repo = makeRepo("ff-precompact");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  const r = preCompact(repo, "S1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^A done-gate run is open: badge \(feature\), in \.claude\/gate\/runs\/\d{4}-\d\d-\d\d-badge\./);
  assert.match(r.stdout, /Keep in the summary:.*the user gave on this task, in their own words/s);
  assert.match(r.stdout, /what was tried and did not work/);
  assert.match(r.stdout, /Leave out the Task, Context, Plan and case table[^\n]*`gate report` prints the first four/);
  assert.throws(() => JSON.parse(r.stdout), "plain text, not a hook JSON answer");
  assert.equal(preCompact(repo, "S1", { trigger: "manual", custom_instructions: "keep the diff" }).stdout, r.stdout);
  const hooks = JSON.parse(readFileSync(path.join(path.dirname(gate), "..", "hooks", "hooks.json"), "utf8")).hooks;
  assert.ok((hooks.PreCompact ?? []).some((h) => !h.matcher && h.hooks.some((x) => /gate\.mjs" pre-compact$/.test(x.command))), "hooks.json has no PreCompact entry calling gate pre-compact");
});

test("compaction C2 refused: pre-compact prints nothing with no run, a closed or abandoned run, a subagent's payload or no session id", () => {
  const none = makeRepo("ff-precompact-none");
  assert.deepEqual([preCompact(none, "S1").status, preCompact(none, "S1").stdout], [0, ""]);
  const repo = makeRepo("ff-precompact-other");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  assert.equal(preCompact(repo, "S2").stdout, "", "another session's run");
  assert.equal(preCompact(repo, "S1", { agent_id: "A1", agent_type: "done-gate:reviewer" }).stdout, "", "a subagent");
  start(repo, "S1", "startup");
  assert.match(preCompact(repo, "S1").stdout, /badge/, "premise: S1's run is open and the session marker is written");
  const bare = spawnSync(process.execPath, [gate, "pre-compact"], { input: JSON.stringify({ cwd: repo, hook_event_name: "PreCompact" }), encoding: "utf8", env: (({ DONE_GATE_SESSION: _s, CLAUDE_CODE_SESSION_ID: _c, ...e }) => ({ ...e, CLAUDE_PROJECT_DIR: repo }))(process.env) });
  assert.deepEqual([bare.status, bare.stdout, bare.stderr], [0, "", ""]);
  const ledgerFile = path.join(runDir(repo), "ledger.json");
  writeFileSync(ledgerFile, JSON.stringify({ ...JSON.parse(readFileSync(ledgerFile, "utf8")), status: "abandoned" }));
  assert.deepEqual([preCompact(repo, "S1").status, preCompact(repo, "S1").stdout], [0, ""]);
});

test("compaction C3 happy: a session that joins a run after a compact, clear or resume is pointed at gate report; a startup is not", () => {
  for (const source of ["compact", "clear", "resume"]) {
    const repo = makeRepo(`ff-pointer-${source}`);
    run(repo, "open", "S1", {}, ["badge", "feature"]);
    const ctx = startContext(repo, "S1", source);
    assert.match(ctx, /Open ledger: [^\n]*badge[^\n]*`gate report` prints its Task, Context, Plan, cases and findings: read it before going on\./, source);
    const report = run(repo, "report", "S1").stdout;
    for (const heading of ["## Task", "## Context", "## Plan", "## Case table"]) assert.ok(report.includes(heading), `${source}: gate report has no ${heading}`);
  }
  const repo = makeRepo("ff-pointer-startup");
  run(repo, "open", "S1", {}, ["badge", "feature"]);
  const ctx = startContext(repo, "S1", "startup");
  assert.match(ctx, /Open ledger/);
  assert.doesNotMatch(ctx, /read it before going on/);
});
