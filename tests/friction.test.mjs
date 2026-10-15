import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, here, CODE_LOOKUP, MEMORY_LOOKUP } from "./helpers.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { decide, shellWrites } from "../scripts/lib/guard.mjs";

// Friction from the 0.16.0 review (items 2.6, 3.6, 3.8, 3.10): the fence's read-only false
// denials and scratch roots, a stop while this session's own verify runs, a shorter gate open,
// version and stale-run warnings, and the lead's lookup window. One test per case.

const REFUSAL = /^done-gate: /m;
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));
const R = ".claude/gate/runs/2026-10-14-x";
const GATE = `node "${path.join(pluginRoot, "scripts", "gate.mjs")}"`;

function run(repo, verb, args = [], input = "") {
  return spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const hook = (repo, verb, payload) => {
  const r = run(repo, verb, [], JSON.stringify({ session_id: "S1", cwd: repo, ...payload }));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const logged = (repo, payload) => hook(repo, "log", payload);
const prompt = (repo) => logged(repo, { hook_event_name: "UserPromptSubmit", prompt: "add a badge" });
const lookup = (repo, tool_name) => logged(repo, { hook_event_name: "PostToolUse", tool_name, tool_input: { query: "badge" }, tool_response: {} });
const failedLookup = (repo, tool_name) => logged(repo, { hook_event_name: "PostToolUseFailure", tool_name, tool_input: { query: "badge" }, tool_error: "MCP error -32000: project not indexed" });
const CONTEXT = "Traced: src/a.ts:1 exports a0 · Related: tests/a.test.ts:1 pins it · Research: none needed: one constant";

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
const lead = (command) => decide({ tool_name: "Bash", tool_input: { command } }, pluginRoot);

test("C1 reported-surface: a shell function or a $G variable wrapping gate passes the fence on a run path", () => {
  const fn = `n=$(grep -c . ${R}/decisions.tsv); G() { ${GATE} "$@" 2>&1 | grep -v "^next" | head -2; }; G step driver done "x" --evidence decisions#$n`;
  assert.equal(lead(fn).deny, false, fn);
  assert.equal(lead(`function G { ${GATE} "$@"; }; G huddle add reviewer --file ${R}/review-1.md`).deny, false);
  const variable = `G="${GATE.replace(/"/g, "")}"; $G huddle add reviewer --file ${R}/review-1.md 2>&1 | tail -3`;
  assert.equal(lead(variable).deny, false, variable);
  assert.equal(lead(`G="${GATE.replace(/"/g, "")}"; \${G} check`).deny, false);
});

test("C2 refused: a shell function or variable whose body writes an evidence file is still denied, called or not", () => {
  for (const command of [
    `G() { echo x >> ${R}/events.jsonl; }; G`,
    `G() { echo x >> ${R}/events.jsonl; }`,
    `W="tee ${R}/verify.json"; echo '{}' | $W`,
    `G() { cat; }; G > ${R}/verify.json`,
    `G() { cat x; } > ${R}/verify.json; G`,
    `cat() { rm ${R}/ledger.json; }; cat`,
    `G=cat; for G in rm; do $G ${R}/ledger.json; done`,
    `G="sed -i"; $G s/a/b/ ${R}/review-1.md`,
    `G="node -e"; $G 'require("fs").writeFileSync("${R}/verify.json","{}")'`,
    `read G; $G ${R}/ledger.json`,
    `git grep -Orm x -- ${R}`,
    `git reflog expire --all ${R}`,
    `echo function rm; rm ${R}/ledger.json`,
    `echo "x rm() {"; rm ${R}/ledger.json`,
    `cat <<EOF\nrm() {\nEOF\nrm ${R}/ledger.json`,
    `false && rm() { :; }; rm ${R}/ledger.json`,
    `echo x G="node a/gate.mjs"; $G rm ${R}/ledger.json`,
    `cat <<EOF\nG="node a/gate.mjs"\nEOF\n$G rm ${R}/ledger.json`,
    `G="node a/gate.mjs" true; $G rm ${R}/ledger.json`,
    `false && G="node a/gate.mjs"; $G rm ${R}/ledger.json`,
    `if false; then\nrm() { :; }\nfi\nrm ${R}/ledger.json`,
    `(\nrm() { :; }\n)\nrm ${R}/ledger.json`,
    `x=$(\nrm() { :; }\n); rm ${R}/ledger.json`,
    `rm() { :; } &\nrm ${R}/ledger.json`,
    `if false; then\nrm() { node a/gate.mjs "$@"; }\nfi\nrm ${R}/ledger.json`,
    `if false; then\nG="node a/gate.mjs"\nfi\n$G rm ${R}/ledger.json`,
    `(\nG="node a/gate.mjs"\n)\n$G rm ${R}/ledger.json`,
    ...["unlink", "shred -u", "curl -o", "eval rm", "npx rimraf"].map((p) => `if false; then\n${p.split(" ")[0]}() { node a/gate.mjs "$@"; }\nfi\n${p} ${R}/ledger.json`),
  ]) assert.equal(lead(command).deny, true, command);
});

test("C3 reported-surface: until or while waits with sleep and git check-ignore on an evidence path pass the fence", () => {
  for (const command of [
    `until [ -f ${R}/verify.json ]; do sleep 5; done`,
    `while ! [ -f ${R}/verify.json ]; do sleep 2; done; cat ${R}/verify.json`,
    `git check-ignore -v ${R}/ledger.json`,
    `git rev-list --count HEAD -- ${R}`,
  ]) assert.equal(lead(command).deny, false, command);
});

test("C4 refused: a helper's write to src/tmp or a scratchpad folder in the repo is outside scratch; /tmp, /private/tmp and tests/.tmp stay scratch", () => {
  for (const target of ["src/tmp/x.ts", "lib/scratchpad/y.ts", "tmp/z.ts"]) assert.deepEqual(shellWrites(`echo x > ${target}`).outside, [target], target);
  for (const target of ["tests/.tmp/../src/a.ts", "/tmp/../Users/kobz/x", "/private/tmp/../../Users/x/src/a.ts"]) assert.equal(shellWrites(`echo x > ${target}`).outside.length, 1, target);
  for (const target of ["/tmp/x", "/private/tmp/claude-501/s/scratchpad/y", "tests/.tmp/z"]) assert.deepEqual(shellWrites(`echo x > ${target}`).outside, [], target);
});

function withVerifyStarted(name, pid, session = "S1") {
  const repo = committed(name);
  hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/a.ts", "export const changed = 1;\n");
  writeFileSync(path.join(runDir(repo), "verify.started.json"), JSON.stringify({ startedAt: new Date().toISOString(), pid, session, commands: ["npm run test"] }));
  return repo;
}
const stopOut = (repo) => hook(repo, "stop", { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "verify is running." });

test("C5 reported-surface: the stop does not block while this session's own verify runs; it blocks once that verify has died, or when the verify is another session's", () => {
  const running = withVerifyStarted("fr-c5-running", process.pid);
  assert.equal(stopOut(running), "", "the stop blocked while the verify still runs");
  const other = withVerifyStarted("fr-c5-other", process.pid, "S2");
  assert.match(stopOut(other), /"decision":"block"/, "another session's verify let this turn end");
  const dead = withVerifyStarted("fr-c5-dead", 2 ** 22 + 12345);
  assert.match(stopOut(dead), /"decision":"block"[\s\S]*never finished/);
});

test("C6 happy: gate open prints each keyed step as its key and a short first clause; gate steps prints the full text", () => {
  const repo = committed("fr-c6");
  const opened = cli(repo, "open", ["t", "feature"]);
  const stepLines = opened.split("\n").filter((l) => /^\s*\d+\. /.test(l));
  assert.ok(stepLines.length >= 5, opened);
  for (const l of stepLines) {
    assert.match(l, /\{[\w-]+\}/, l);
    assert.ok(Buffer.byteLength(l) <= 100, `a step line is ${Buffer.byteLength(l)} bytes:\n${l}`);
  }
  const full = cli(repo, "steps");
  assert.ok(full.length > opened.length, "gate steps lost the full text");
});

test("C7 edge: gate open warns when a newer done-gate version sits beside this one in the plugin cache; a dev checkout prints nothing", () => {
  const cache = path.join(here, ".tmp", "fr-c7-cache", "done-gate");
  const old = path.join(cache, "0.16.0");
  mkdirSync(path.dirname(old), { recursive: true });
  execFileSync("rsync", ["-a", "--exclude", ".git", "--exclude", "tests", "--exclude", ".claude", `${pluginRoot}/`, `${old}/`]);
  const manifest = path.join(old, ".claude-plugin", "plugin.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "0.16.0" }));
  mkdirSync(path.join(cache, "0.17.1"), { recursive: true });
  const repo = committed("fr-c7");
  const r = spawnSync(process.execPath, [path.join(old, "scripts", "gate.mjs"), "open", "t", "feature"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(`${r.stdout}${r.stderr}`, /0\.17\.1[^\n]*(newer|installed)|newer[^\n]*0\.17\.1/, r.stdout);

  const dev = committed("fr-c7-dev");
  assert.doesNotMatch(cli(dev, "open", ["t", "feature"]), /newer|superseded/);
});

test("C8 happy: gate check shows each open run's age and points a stale one at gate abandon", () => {
  const repo = committed("fr-c8");
  cli(repo, "open", ["old", "feature"]);
  const ledger = ledgerOf(repo);
  ledger.openedAt = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  ledger.sessions = ["S0"];
  saveLedger(runDir(repo), ledger);
  const r = spawnSync(process.execPath, [gate, "check"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S2" } });
  assert.match(r.stdout, /old[^\n]*5 days/, r.stdout);
  assert.match(r.stdout, /gate abandon old/, r.stdout);
});

test("C9 reported-surface: lookups before a clarifying answer still count when the run opens after it", () => {
  const repo = committed("fr-c9");
  hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });
  prompt(repo);
  lookup(repo, CODE_LOOKUP);
  lookup(repo, MEMORY_LOOKUP);
  prompt(repo); // the user's answer to a clarifying question
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
});

test("C10 boundary: a lookup made before the previous run ended (here abandoned) does not count for the next run", () => {
  const repo = committed("fr-c10");
  hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });
  prompt(repo);
  lookup(repo, CODE_LOOKUP);
  lookup(repo, MEMORY_LOOKUP);
  cli(repo, "open", ["first", "feature"]);
  cli(repo, "abandon", ["first", "user moved on"]);
  prompt(repo);
  cli(repo, "open", ["second", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  const r = run(repo, "note", ["context", CONTEXT]);
  assert.match(r.stderr, REFUSAL, r.stdout);
});

test("C11 refused: a failed lookup no longer counts; the refusal names it and says to retry or declare --no-code", () => {
  const repo = committed("fr-c11");
  prompt(repo);
  failedLookup(repo, CODE_LOOKUP);
  lookup(repo, MEMORY_LOOKUP);
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  const r = run(repo, "note", ["context", CONTEXT]);
  assert.match(r.stderr, REFUSAL);
  assert.match(r.stderr, /codebase_search[^\n]*failed|failed[^\n]*codebase_search/, r.stderr);
  assert.match(r.stderr, /--no-code/, r.stderr);
  cli(repo, "note", ["context", CONTEXT, "--no-code", "SocratiCode: not indexed"]);
});

test("C12 happy: SKILL.md defines gate as a shell function and stays under 4096 bytes", () => {
  const file = path.join(pluginRoot, "skills", "gate", "SKILL.md");
  const text = readFileSync(file, "utf8");
  assert.match(text, /Start each Bash command with `gate\(\) \{ node "[^"]+\/scripts\/gate\.mjs" "\$@"; \};`/, text.slice(0, 400));
  assert.ok(statSync(file).size < 4096, `SKILL.md is ${statSync(file).size} bytes`);
});

test("C13 edge: abandoning another session's stale run keeps this session's lookups", () => {
  const repo = committed("fr-c13");
  cli(repo, "open", ["old", "feature"]);
  const ledger = ledgerOf(repo);
  ledger.sessions = ["S0"];
  saveLedger(runDir(repo), ledger);
  const s2 = (verb, args = [], input = "") => spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S2" } });
  const log2 = (payload) => s2("log", [], JSON.stringify({ session_id: "S2", cwd: repo, ...payload }));
  s2("session-start", [], JSON.stringify({ session_id: "S2", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" }));
  log2({ hook_event_name: "UserPromptSubmit", prompt: "add a badge" });
  for (const tool_name of [CODE_LOOKUP, MEMORY_LOOKUP]) log2({ hook_event_name: "PostToolUse", tool_name, tool_input: { query: "badge" }, tool_response: {} });
  assert.equal(s2("abandon", ["old", "left by another session"]).status, 0);
  log2({ hook_event_name: "UserPromptSubmit", prompt: "yes, go ahead" });
  assert.equal(s2("open", ["new", "feature"]).status, 0);
  assert.equal(s2("note", ["task", "Add a badge. [inferred]"]).status, 0);
  const r = s2("note", ["context", CONTEXT]);
  assert.equal(r.status, 0, r.stderr);
});
