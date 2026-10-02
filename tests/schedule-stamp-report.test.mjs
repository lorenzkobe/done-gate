import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { eventsFromHookInput } from "../scripts/lib/events.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const blocks = (out, rule) => out.split("\n").some((l) => new RegExp(`\\b${rule}\\b`).test(l));
const read = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");

function hook(repo, payload) {
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
}
function edit(repo, rel, content) {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) } });
}
const command = (repo, cmd, tool_response) => hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, ...(tool_response ? { tool_response } : {}) });

const GATE_JSON = { source: ["src/**"], tests: ["tests/**"], ui: ["src/**/*.tsx"], verify: ["true"], driver: "cmd:npx playwright test" };

function opened(name, files = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify(GATE_JSON, null, 2), ...files });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Add a screen. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One screen.", "--files", "src/app/page.tsx"]);
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  return repo;
}

test("C1 a command event carries the exit code from tool_response, 130 when interrupted, null when absent", () => {
  const base = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, session_id: "S1" };
  assert.equal(eventsFromHookInput({ ...base, tool_response: { stdout: "", stderr: "", exitCode: 1 } }, "/repo")[0].exit, 1);
  assert.equal(eventsFromHookInput({ ...base, tool_response: { exit_code: 0 } }, "/repo")[0].exit, 0);
  assert.equal(eventsFromHookInput({ ...base, tool_response: { stdout: "", interrupted: true } }, "/repo")[0].exit, 130);
  assert.equal(eventsFromHookInput({ ...base, tool_response: "..." }, "/repo")[0].exit, null);
  assert.equal(eventsFromHookInput(base, "/repo")[0].exit, null);
});

test("C2 a cmd: driver run that failed does not satisfy R4; one that passed or has no exit code does", () => {
  const repo = opened("ssr-c2");
  edit(repo, "src/app/page.tsx", "export default () => <b/>;\n");
  command(repo, "npx playwright test", { exitCode: 1 });
  assert.ok(blocks(run(repo, "check").stdout, "R4"));
  command(repo, "npx playwright test", { interrupted: true });
  assert.ok(blocks(run(repo, "check").stdout, "R4"));
  command(repo, "npx playwright test", { exitCode: 0 });
  assert.ok(!blocks(run(repo, "check").stdout, "R4"));
  const bare = opened("ssr-c2b");
  edit(bare, "src/app/page.tsx", "export default () => <b/>;\n");
  hook(bare, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npx playwright test", run_in_background: true }, tool_response: { stdout: "started" } });
  assert.ok(blocks(run(bare, "check").stdout, "R4"), "a background run reports before it can fail and does not count");
  command(bare, "npx playwright test");
  assert.ok(!blocks(run(bare, "check").stdout, "R4"));
});

test("C1 a background command's exit is never known, and the event says it ran in the background", () => {
  const e = eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npx playwright test", run_in_background: true }, tool_response: { exitCode: 0 }, session_id: "S1" }, "/repo")[0];
  assert.equal(e.exit, null);
  assert.equal(e.background, true);
});

test("C2 verify.json is written whole: no partial file is ever at its path", () => {
  const src = read("scripts/lib/verify.mjs");
  assert.match(src, /renameSync\(`\$\{file\}\.\$\{process\.pid\}\.tmp`, file\)/);
});

test("C3 the ledger records the plugin version at open and the full report header names it", () => {
  const repo = opened("ssr-c3");
  const version = run(repo, "--version").stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(ledgerOf(repo).version, version);
  assert.match(cli(repo, "report").split("\n")[0], new RegExp(`done-gate ${version.replace(/\./g, "\\.")}$`));
  assert.match(cli(repo, "report", ["--brief"]).trimEnd().split("\n").pop(), new RegExp(`^Full report: .* · done-gate ${version.replace(/\./g, "\\.")}$`));
});

test("C4 the brief's app line names the cmd: driver when it drove, and says not driven when it did not", () => {
  const repo = opened("ssr-c4");
  edit(repo, "src/app/page.tsx", "export default () => <b/>;\n");
  assert.match(cli(repo, "report", ["--brief"]), /App not yet driven after the last change\./);
  command(repo, "npx playwright test e2e/page.spec.ts", { exitCode: 0 });
  assert.match(cli(repo, "report", ["--brief"]), /App driven after the last change \(npx playwright test\)\./);
});

test("C5 re-noting the plan keeps its first timestamp and the report never calls the plan late", () => {
  const repo = opened("ssr-c5");
  const first = ledgerOf(repo).planSeq;
  edit(repo, "src/app/page.tsx", "export default () => <b/>;\n");
  cli(repo, "note", ["plan", "Amended after the skeptic.", "--files", "src/app/page.tsx"]);
  const after = ledgerOf(repo);
  assert.equal(after.planSeq, first);
  assert.doesNotMatch(cli(repo, "report"), /Plan written after the first source edit/);
  assert.match(readFileSync(path.join(runDir(repo), "ledger.md"), "utf8"), /Amended after the skeptic/);
});

test("C6 the gate skill schedules skeptic with tests, both reviewers together on high-risk, verify in the background; the hints agree; the budget holds", () => {
  const skill = read("skills/gate/SKILL.md");
  assert.ok(Buffer.byteLength(skill) < 4096, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  assert.match(skill, /skeptic[^.]*same turn|same turn[^.]*skeptic/i);
  assert.match(skill, /reviewer-2[^.]*(?:together|at once|same turn)/i);
  assert.match(skill, /verify[^.]*background/i);
  const next = read("scripts/lib/next.mjs");
  assert.match(next, /skeptic:[^\n]*(?:same turn|while it reads)/);
  assert.match(next, /review:[^\n]*reviewer-2[^\n]*(?:together|at once|same turn)/);
  assert.match(next, /review:[^\n]*verify[^\n]*background/);
});

test("C7 verify-setup's skill has a Seed section: the seed command, re-seeding after a reset, a doctor that refuses an unseeded instance", () => {
  const skill = read("skills/verify-setup/SKILL.md");
  assert.match(skill, /\*\*Seed\*\*/);
  assert.match(skill, /re-?seed[^.]*reset/i);
  assert.match(skill, /Doctor[^\n]*(?:seeded|unseeded)/i);
});

test("C8 a ledger from before with no version field still reports, with the version shown as unknown", () => {
  const repo = opened("ssr-c8");
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  delete ledger.version;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  assert.match(cli(repo, "report").split("\n")[0], /done-gate unknown$/);
  assert.match(cli(repo, "report", ["--brief"]), /· done-gate unknown$/m);
});
