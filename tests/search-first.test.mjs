// search-first: the lead, skeptic, reviewers, worker and arbiter search the code and the memory
// before grep; QA searches memory only. The gate checks the lead at `gate note context` and
// each helper at `gate huddle add|reply` and in R17. Cases C1–C24 of the task's case table.
//
// Written from the requirements and the case table, blind to the implementation.
//
// source-of-truth anchors
//   what an MCP call is logged as     → scripts/lib/events.mjs (PostToolUse mcp__* → kind "tool", agent id)
//   code and memory servers           → the amended plan (CODE_SERVER socraticode…, MEMORY_SERVER mempalace…)
//   which short names count            → the amended plan (search/query/symbol/…; never add/update/index/list/status)
//   tool names used as fixtures        → the session's own deferred-tool list (mcp__socraticode__*, mcp__mempalace__*)
//   the flags --no-code / --no-memory  → the amended plan, item (2)
//   the ledger stamp lookups: true     → the plan, "Old runs"
//   R17 and its waiver key lookups     → the amended plan, item (3)
//   helper file shapes                 → agents/reviewer.md, agents/worker.md, agents/arbiter.md
//   the PostToolUseFailure matcher     → the amended plan, item (4)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, here, lookedUp, CODE_LOOKUP, MEMORY_LOOKUP } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { eventsFromHookInput, appendEvents, readEvents } from "../scripts/lib/events.mjs";

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env: envFor(repo) });
const REFUSAL = /^done-gate: /m;

function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, REFUSAL, `expected \`gate ${verb} ${args.join(" ")}\` to be refused, got:\n${r.stdout}${r.stderr}`);
  return r.stderr;
}
const check = (repo) => run(repo, "check").stdout;
const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const r17 = (repo) => lines(check(repo)).filter((l) => /\bR17\b/.test(l));

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerPath = (repo) => path.join(runDir(repo), "ledger.json");
const ledgerOf = (repo) => JSON.parse(readFileSync(ledgerPath(repo), "utf8"));
const ledgerMd = (repo) => readFileSync(path.join(runDir(repo), "ledger.md"), "utf8");
const stepOf = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key);
const huddlesOf = (repo, role) => ledgerOf(repo).huddles.filter((h) => h.role === role);
const forYou = (repo) => lines(cli(repo, "report", ["--brief"])).find((l) => l.startsWith("For you:")) ?? "";

function hook(repo, payload) {
  const r = spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
  assert.equal(r.status, 0, r.stderr);
}
// one MCP call, as PostToolUse logs it; `who` is {agent_id, agent_type} for a subagent
const mcp = (repo, tool_name, who = {}) => hook(repo, { hook_event_name: "PostToolUse", tool_name, tool_input: { query: "where the badge is read" }, tool_response: {}, ...who });
const as = (id, role) => ({ agent_id: id, agent_type: role.includes(":") ? role : `done-gate:${role}` });
const prompt = (repo, text = "add a badge to the venue card") => hook(repo, { hook_event_name: "UserPromptSubmit", prompt: text });
const start = (repo, id, role) => hook(repo, { hook_event_name: "SubagentStart", ...as(id, role) });
const stop = (repo, id, role) => hook(repo, { hook_event_name: "SubagentStop", ...as(id, role), stop_hook_active: false });

// A helper's own Write of a run-dir file, logged under its agent id.
function helperWrites(repo, id, role, name, body) {
  writeFileSync(path.join(runDir(repo), name), body);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", ...as(id, role), tool_input: { file_path: path.join(runDir(repo), name), content: body }, tool_response: {} });
}
// A helper's Edit of a source or test file.
function helperEdits(repo, id, role, rel, content) {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", ...as(id, role), tool_input: { file_path: path.join(repo, rel) }, tool_response: {} });
}
// The lead's shell edit of a source file.
function shellWrite(repo, rel, content) {
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `cat > ${rel} <<'EOF' ...` }, tool_response: { exit_code: 0 } });
  write(repo, rel, content);
}

function brief(repo, role, args = []) {
  const out = cli(repo, "brief", [role, ...args]);
  const p = lines(out).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${out}`);
  return readFileSync(p, "utf8");
}
function section(md, heading) {
  const all = md.split("\n");
  const at = all.findIndex((l) => l.trim() === `## ${heading}`);
  assert.ok(at >= 0, `packet has no "## ${heading}" section:\n${md.slice(0, 2000)}`);
  const rest = all.slice(at + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const CONTEXT = [
  "Traced: src/a.ts:1 exports a0, read by src/app/page.tsx:1; no other caller.",
  "Related: tests/a.test.ts pins a; docs/notes.md describes the page.",
  "Research: none needed: a one-line constant change with no known pattern to compare.",
].join("\n");
const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
// open + task; the lead has made no lookup yet
function opened(name, { files = {} } = {}) {
  const repo = committed(name, files);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  return repo;
}
// opened + the lead's lookups + context (with `contextArgs`) + plan + a case
function planned(name, { plan = ["src/a.ts", "src/app/page.tsx"], lead = [CODE_LOOKUP, MEMORY_LOOKUP], contextArgs = [] } = {}) {
  const files = plan.length > 10 ? Object.fromEntries(plan.map((f) => [f, "export const x = 1;\n"])) : {};
  const repo = opened(name, { files });
  for (const t of lead) mcp(repo, t);
  // a skipped search kind needs the user's OK in their words (search-tools-ask-user)
  if (contextArgs.some((a) => a.startsWith("--no-"))) prompt(repo, "go on without it");
  const ok = contextArgs.some((a) => a.startsWith("--no-")) ? ["--user-ok", "go on without it"] : [];
  cli(repo, "note", ["context", CONTEXT, ...contextArgs, ...ok]);
  cli(repo, "note", ["plan", "The plan.", "--files", plan.join(",")]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  return repo;
}
// planned + both planned files changed by the lead, so a reviewer has a diff
function changed(name, opts) {
  const repo = planned(name, opts);
  shellWrite(repo, "src/a.ts", "export const a = 2;\nexport const venue = null;\nexport const badge = null;\n");
  shellWrite(repo, "src/app/page.tsx", "export default () => 'badge';\n");
  return repo;
}

const FIND_1 = "the empty list renders a stray comma — src/a.ts:1";
const FIND_2 = "null venue crashes the badge — src/a.ts:2";
const reviewFile = (n, slug, actOn = [FIND_1], extra = "") =>
  `# Review ${n} — ${slug}\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n${extra}` +
  `## Consider\n- rename the helper\n## Noted\n- the module is small\n## Dismissed\n- none\n## Evidence verdict\n- tests: npm test exit 0, 3 passed (ran it myself)\n`;
const reviewPartial = (n, slug) =>
  `# Review ${n} — ${slug}\n\n## Act on\n- ${FIND_1}\n## Consider\n- unverified\n## Noted\n- unverified\n## Dismissed\n- none\n## Evidence verdict\n- unverified\n`;
const workerFile = (n, slug, replies) => `# Worker ${n} — ${slug}\n\n## Replies\n${replies.map((t) => `- ${t}`).join("\n")}\n`;
const arbiterFile = (n, slug, ruling) => `# Arbiter ${n} — ${slug}\n\n## Ruling\n- ${ruling}\n`;

// ---------------------------------------------------------------------------
// The lead, at gate note context
// ---------------------------------------------------------------------------

test("C1 happy: a lead with a code lookup and a memory lookup after gate open writes the context", () => {
  const repo = opened("srch-c1");
  mcp(repo, CODE_LOOKUP);
  mcp(repo, MEMORY_LOOKUP);
  cli(repo, "note", ["context", CONTEXT]);
  assert.equal(stepOf(repo, "context").state, "DONE");
  assert.match(ledgerMd(repo), /Traced: src\/a\.ts:1/);
  assert.equal(ledgerOf(repo).lookupGap ?? null, null, "no gap was declared, yet one was stored");
});

test("C2 refused: a lead with no lookup is refused at gate note context, naming both kinds with SocratiCode/MemPalace examples and --no-code/--no-memory; nothing is written", () => {
  const repo = opened("srch-c2");
  const before = ledgerMd(repo);
  const err = refused(repo, "note", ["context", CONTEXT]);
  for (const word of [/SocratiCode/, /MemPalace/, /--no-code/, /--no-memory/]) assert.match(err, word, err);
  assert.equal(ledgerMd(repo), before, "the refused context was written to ledger.md");
  assert.equal(stepOf(repo, "context").state, null, "the refused context closed the step");
  assert.equal(ledgerOf(repo).contextSeq ?? null, null);
});

test("C3 refused: a lead with only a code lookup is refused, naming memory as the missing kind", () => {
  const repo = opened("srch-c3");
  mcp(repo, CODE_LOOKUP);
  const err = refused(repo, "note", ["context", CONTEXT]);
  assert.match(err, /memory/i, err);
  assert.match(err, /MemPalace|--no-memory/, err);
  assert.equal(stepOf(repo, "context").state, null);
  // and the mirror: memory only names code
  const other = opened("srch-c3-mirror");
  mcp(other, MEMORY_LOOKUP);
  const err2 = refused(other, "note", ["context", CONTEXT]);
  assert.match(err2, /code/i, err2);
  assert.match(err2, /SocratiCode|--no-code/, err2);
});

test("C4 happy: a code lookup plus --no-memory \"MemPalace not installed\" is accepted, the gap is stored, and the brief's For-you line says memory search was not available and why", () => {
  const repo = opened("srch-c4");
  mcp(repo, CODE_LOOKUP);
  prompt(repo, "go on without mempalace");
  cli(repo, "note", ["context", CONTEXT, "--no-memory", "MemPalace not installed", "--user-ok", "go on without mempalace"]);
  assert.equal(stepOf(repo, "context").state, "DONE");
  const gap = ledgerOf(repo).lookupGap;
  assert.ok(gap, "no lookupGap stored");
  assert.match(String(gap.memory), /MemPalace not installed/);
  assert.ok(!gap.code, `code was not declared missing, yet the gap holds ${JSON.stringify(gap)}`);
  assert.doesNotMatch(section(ledgerMd(repo), "Context"), /--no-memory|MemPalace not installed/, "the flag leaked into the Context text");
  const line = forYou(repo);
  assert.match(line, /MemPalace not installed/, line);
  assert.match(line, /memory|MemPalace/i, line);
  // with no gap, the For-you line says nothing about it
  const clean = opened("srch-c4-clean");
  lookedUp(clean);
  cli(clean, "note", ["context", CONTEXT]);
  assert.doesNotMatch(forYou(clean), /not installed|not indexed|not available/, forYou(clean));
});

test("C5 refused: an empty --no-code or --no-memory reason is refused; declaring a kind that was also searched (not indexed) is accepted", () => {
  const repo = opened("srch-c5");
  mcp(repo, MEMORY_LOOKUP);
  refused(repo, "note", ["context", CONTEXT, "--no-code", ""]);
  refused(repo, "note", ["context", CONTEXT, "--no-code", "   "]);
  refused(repo, "note", ["context", CONTEXT, "--no-code"]);
  assert.equal(stepOf(repo, "context").state, null);
  const mem = opened("srch-c5-mem");
  mcp(mem, CODE_LOOKUP);
  refused(mem, "note", ["context", CONTEXT, "--no-memory", ""]);
  assert.equal(stepOf(mem, "context").state, null);

  const both = opened("srch-c5-both");
  lookedUp(both);
  prompt(both, "skip the code index");
  cli(both, "note", ["context", CONTEXT, "--no-code", "SocratiCode: not indexed", "--user-ok", "skip the code index"]);
  assert.match(String(ledgerOf(both).lookupGap?.code), /SocratiCode: not indexed/);
});

test("C6 refused: write-shaped, listing and status calls are not lookups; a symbol or kg_query call is", () => {
  const notMemory = ["mcp__mempalace__mempalace_add_drawer", "mcp__mempalace__mempalace_list_wings"];
  const notCode = [
    "mcp__socraticode__codebase_update",
    "mcp__socraticode__codebase_context_index",
    "mcp__socraticode__codebase_graph_build",
    "mcp__socraticode__codebase_list_projects",
    "mcp__socraticode__codebase_status",
    "mcp__serena__replace_symbol_body",
    "mcp__serena__rename_symbol",
  ];
  for (const tool of notMemory) {
    const repo = opened(`srch-c6-${tool.split("__").pop()}`);
    mcp(repo, CODE_LOOKUP);
    mcp(repo, tool);
    assert.match(refused(repo, "note", ["context", CONTEXT]), /memory/i, `${tool} counted as a memory lookup`);
  }
  for (const tool of notCode) {
    const repo = opened(`srch-c6-${tool.split("__").pop()}`);
    mcp(repo, MEMORY_LOOKUP);
    mcp(repo, tool);
    assert.match(refused(repo, "note", ["context", CONTEXT]), /code/i, `${tool} counted as a code lookup`);
  }
  // the permitted side: other read-named calls on the same servers count
  const reads = opened("srch-c6-reads");
  mcp(reads, "mcp__socraticode__codebase_symbol");
  mcp(reads, "mcp__mempalace__mempalace_kg_query");
  cli(reads, "note", ["context", CONTEXT]);
});

test("C7 boundary: a helper's or Explore's lookups do not satisfy the lead; a lead lookup before the task's user prompt does not count; one after that prompt but before gate open does", () => {
  const helpers = opened("srch-c7-helpers");
  mcp(helpers, CODE_LOOKUP, as("A1", "skeptic"));
  mcp(helpers, MEMORY_LOOKUP, as("A1", "skeptic"));
  mcp(helpers, CODE_LOOKUP, as("X1", "Explore"));
  mcp(helpers, MEMORY_LOOKUP, as("X1", "Explore"));
  const err = refused(helpers, "note", ["context", CONTEXT]);
  assert.match(err, /subagent|helper|Explore/i, `the refusal does not say a subagent's lookups do not count:\n${err}`);

  // before the prompt that started the task
  const early = committed("srch-c7-early");
  mcp(early, CODE_LOOKUP);
  mcp(early, MEMORY_LOOKUP);
  prompt(early);
  cli(early, "open", ["srch-c7-early", "feature"]);
  cli(early, "note", ["task", "Add a badge. [inferred]"]);
  refused(early, "note", ["context", CONTEXT]);

  // no prompt at all: the window starts at gate open
  const bare = committed("srch-c7-bare");
  mcp(bare, CODE_LOOKUP);
  mcp(bare, MEMORY_LOOKUP);
  cli(bare, "open", ["srch-c7-bare", "feature"]);
  cli(bare, "note", ["task", "Add a badge. [inferred]"]);
  refused(bare, "note", ["context", CONTEXT]);

  // after the prompt, before gate open
  const between = committed("srch-c7-between");
  prompt(between);
  mcp(between, CODE_LOOKUP);
  mcp(between, MEMORY_LOOKUP);
  cli(between, "open", ["srch-c7-between", "feature"]);
  cli(between, "note", ["task", "Add a badge. [inferred]"]);
  cli(between, "note", ["context", CONTEXT]);
  assert.equal(stepOf(between, "context").state, "DONE");
});

test("C20 refused: gate step context na or skipped is refused on a stamped ledger", () => {
  const repo = opened("srch-c20");
  assert.equal(ledgerOf(repo).lookups, true, "premise: a new ledger is stamped lookups: true");
  refused(repo, "step", ["context", "na", "nothing to trace"]);
  refused(repo, "step", ["context", "skipped", "nothing to trace"]);
  assert.equal(stepOf(repo, "context").state, null);
});

test("C25 refused: gate step context done (any evidence) is refused on a stamped ledger; only gate note context closes it", () => {
  const repo = opened("srch-c25");
  assert.equal(ledgerOf(repo).lookups, true, "premise: a new ledger is stamped lookups: true");
  lookedUp(repo);
  for (const evidence of ["ledger.md", "ledger.md#context", "src/a.ts:1"]) {
    refused(repo, "step", ["context", "done", "traced it", "--evidence", evidence]);
    assert.equal(stepOf(repo, "context").state, null, `step context done --evidence ${evidence} closed the step`);
  }
  cli(repo, "note", ["context", CONTEXT]);
  assert.equal(stepOf(repo, "context").state, "DONE");
  assert.equal(stepOf(repo, "context").evidence, "ledger.md#context");
});

test("C23 edge: a failed lookup (PostToolUseFailure on an mcp__ search) is logged; since 0.17 it does not count, and the refusal names it", () => {
  // the hook is wired for it
  const hooks = JSON.parse(readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const matchers = hooks.hooks.PostToolUseFailure.map((h) => new RegExp(`^(?:${h.matcher})$`));
  assert.ok(matchers.some((m) => m.test(CODE_LOOKUP)), "PostToolUseFailure does not fire for an mcp__ call");
  assert.ok(matchers.some((m) => m.test("Bash")), "PostToolUseFailure no longer fires for Bash");
  // the event
  const failure = { session_id: "S1", cwd: "/repo", hook_event_name: "PostToolUseFailure", tool_name: CODE_LOOKUP, tool_input: { query: "badge" }, tool_error: "MCP error -32000: project not indexed", tool_error_type: "execution_failed" };
  const [e] = eventsFromHookInput(failure, "/repo");
  assert.ok(e, "a failed mcp__ call produced no event");
  assert.equal(e.kind, "tool");
  assert.equal(e.tool, CODE_LOOKUP);
  // through the real hook verb, it no longer satisfies the lead's code lookup (the user's choice in 0.17)
  const repo = opened("srch-c23");
  hook(repo, { hook_event_name: "PostToolUseFailure", tool_name: CODE_LOOKUP, tool_input: { query: "badge" }, tool_error: "MCP error -32000: project not indexed", tool_error_type: "execution_failed" });
  mcp(repo, MEMORY_LOOKUP);
  assert.match(refused(repo, "note", ["context", CONTEXT]), new RegExp(`${CODE_LOOKUP}\` call failed`));
  prompt(repo, "skip the code index");
  cli(repo, "note", ["context", CONTEXT, "--no-code", "SocratiCode: not indexed", "--user-ok", "skip the code index"]);
  // a failed Bash call is still a command with its exit code
  const [bash] = eventsFromHookInput({ ...failure, tool_name: "Bash", tool_input: { command: "npm test" }, tool_error: "Exit code 1" }, "/repo");
  assert.equal(bash.kind, "command");
  assert.equal(bash.exit, 1);
});

// ---------------------------------------------------------------------------
// Helpers, at huddle add / reply and in R17
// ---------------------------------------------------------------------------

test("C8 refused: a reviewer file whose reviewer made no lookups is refused at huddle add, naming the reviewer and what it skipped; with both lookups it records", () => {
  const repo = changed("srch-c8");
  start(repo, "R1", "reviewer");
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewFile(1, "srch-c8"));
  stop(repo, "R1", "reviewer");
  const err = refused(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.match(err, /reviewer/, err);
  assert.match(err, /code/i, err);
  assert.match(err, /memory/i, err);
  assert.deepEqual(huddlesOf(repo, "reviewer"), [], "the refused file was recorded");

  lookedUp(repo, { agent: "R1", role: "reviewer" });
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.equal(huddlesOf(repo, "reviewer").length, 1);
});

test("C9 edge: another agent's lookups (the lead's, a second reviewer's) do not count for this reviewer", () => {
  const repo = changed("srch-c9");
  start(repo, "R1", "reviewer");
  start(repo, "R2", "reviewer");
  lookedUp(repo, { agent: "R2", role: "reviewer" });
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewFile(1, "srch-c9"));
  stop(repo, "R1", "reviewer");
  stop(repo, "R2", "reviewer");
  refused(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.deepEqual(huddlesOf(repo, "reviewer"), []);
});

test("C10 edge: QA needs only a memory lookup; a code lookup is not required of it, and a code lookup alone does not do", () => {
  const ok = planned("srch-c10-ok");
  start(ok, "Q1", "qa");
  lookedUp(ok, { agent: "Q1", role: "qa", tools: [MEMORY_LOOKUP] });
  helperEdits(ok, "Q1", "qa", "tests/badge.test.ts", "test('badge', () => {});\n");
  stop(ok, "Q1", "qa");
  assert.deepEqual(r17(ok), [], "QA with a memory lookup was flagged");

  const bad = planned("srch-c10-bad");
  start(bad, "Q1", "qa");
  lookedUp(bad, { agent: "Q1", role: "qa", tools: [CODE_LOOKUP] });
  helperEdits(bad, "Q1", "qa", "tests/badge.test.ts", "test('badge', () => {});\n");
  stop(bad, "Q1", "qa");
  const flagged = r17(bad).join("\n");
  assert.match(flagged, /qa|QA/, `QA with no memory lookup is not flagged:\n${check(bad)}`);
  assert.match(flagged, /memory/i, flagged);
});

// opened ledger, review-1.md (two findings, no agent behind it), H1.1 resolved, H1.2 disputed,
// review-2.md upholding: the state an arbiter is briefed for.
function upheld(name) {
  const repo = changed(name);
  writeFileSync(path.join(runDir(repo), "review-1.md"), reviewFile(1, name, [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:empty list"]);
  cli(repo, "huddle", ["dispute", "H1.2", "the caller already null-checks venue", "--evidence", "src/a.ts:2"]);
  writeFileSync(path.join(runDir(repo), "review-2.md"), reviewFile(2, name, [], "\n## Disputes\n- H1.2 — upheld: the card renders before the venue query resolves\n\n"));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  return repo;
}

test("C11 refused: an arbiter file is checked the same way at huddle add arbiter (code and memory)", () => {
  const repo = upheld("srch-c11");
  start(repo, "A7", "arbiter");
  lookedUp(repo, { agent: "A7", role: "arbiter", tools: [MEMORY_LOOKUP] });
  helperWrites(repo, "A7", "arbiter", "arbiter-1.md", arbiterFile(1, "srch-c11", "H1.2 — implementer: the caller's null check runs first"));
  stop(repo, "A7", "arbiter");
  const err = refused(repo, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);
  assert.match(err, /arbiter/, err);
  assert.match(err, /code/i, err);
  assert.deepEqual(huddlesOf(repo, "arbiter"), []);
  lookedUp(repo, { agent: "A7", role: "arbiter", tools: [CODE_LOOKUP] });
  cli(repo, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);
  assert.equal(huddlesOf(repo, "arbiter").length, 1);
});

test("C12 refused: a worker that edited with no lookups shows as R17 in gate check and blocks close; worker-<n>.md is refused at huddle reply", () => {
  const repo = planned("srch-c12", { plan: LARGE });
  start(repo, "W1", "worker");
  helperEdits(repo, "W1", "worker", "src/f0.ts", "export const x = 2;\n");
  stop(repo, "W1", "worker");
  const flagged = r17(repo).join("\n");
  assert.match(flagged, /worker/, `no R17 line for the worker:\n${check(repo)}`);
  const closing = run(repo, "close");
  assert.match(closing.stderr, REFUSAL, "close went through with R17 standing");
  assert.match(closing.stdout, /\bR17\b/, closing.stdout);

  writeFileSync(path.join(runDir(repo), "review-1.md"), reviewFile(1, "srch-c12"));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  start(repo, "W1", "worker");
  helperWrites(repo, "W1", "worker", "worker-1.md", workerFile(1, "srch-c12", ["H1.1 — fixed: src/f0.ts:1"]));
  stop(repo, "W1", "worker");
  const err = refused(repo, "huddle", ["reply", "--file", "worker-1.md"]);
  assert.match(err, /worker/, err);
  assert.equal(ledgerOf(repo).huddles.flatMap((h) => h.actOn).find((a) => a.id === "H1.1").closed ?? null, null, "the refused reply closed H1.1");

  lookedUp(repo, { agent: "W1", role: "worker" });
  cli(repo, "huddle", ["reply", "--file", "worker-1.md"]);
  assert.deepEqual(r17(repo), [], "R17 stays after the worker's lookups");
});

test("C13 idempotent: a reviewer resumed for round 2 (same agent id) keeps its round-1 lookups", () => {
  const repo = changed("srch-c13");
  start(repo, "R1", "reviewer");
  lookedUp(repo, { agent: "R1", role: "reviewer" });
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewFile(1, "srch-c13"));
  stop(repo, "R1", "reviewer");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:empty list"]);
  shellWrite(repo, "src/a.ts", "export const a = 3;\nexport const venue = null;\nexport const badge = null;\n");
  start(repo, "R1", "reviewer");
  helperWrites(repo, "R1", "reviewer", "review-2.md", reviewFile(2, "srch-c13", []));
  stop(repo, "R1", "reviewer");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  assert.equal(huddlesOf(repo, "reviewer").length, 2);
});

test("C14 edge: a kind the lead declared missing exempts every helper for that kind, and only that kind", () => {
  const repo = changed("srch-c14", { lead: [MEMORY_LOOKUP], contextArgs: ["--no-code", "SocratiCode not installed"] });
  start(repo, "R1", "reviewer");
  lookedUp(repo, { agent: "R1", role: "reviewer", tools: [MEMORY_LOOKUP] });
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewFile(1, "srch-c14"));
  stop(repo, "R1", "reviewer");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  start(repo, "S1x", "skeptic");
  helperWrites(repo, "S1x", "skeptic", "skeptic-1.md", "# Skeptic 1 — sf-c14\n\n## Act on\n- none\n## Consider\n- inline it\n## Noted\n- small\n## The one question\n- none\n");
  stop(repo, "S1x", "skeptic");
  const err = refused(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  assert.match(err, /memory/i, `a skeptic with no memory lookup is not named for memory:\n${err}`);
});

test("C15 boundary: a ledger opened without the lookups stamp (an older run) is not checked at note context or by R17", () => {
  const repo = opened("srch-c15");
  const ledger = ledgerOf(repo);
  assert.equal(ledger.lookups, true, "premise: gate open stamps lookups: true");
  delete ledger.lookups;
  writeFileSync(ledgerPath(repo), JSON.stringify(ledger, null, 2));
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "The plan.", "--files", "src/a.ts,src/app/page.tsx"]);
  shellWrite(repo, "src/a.ts", "export const a = 2;\n");
  start(repo, "R1", "reviewer");
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewFile(1, "srch-c15"));
  stop(repo, "R1", "reviewer");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.deepEqual(r17(repo), []);
});

test("C17 happy: helper packets carry a Lookups section naming the tools the lead used, or the declared gap", () => {
  const repo = changed("srch-c17");
  for (const role of ["skeptic", "reviewer"]) {
    const s = section(brief(repo, role), "Lookups");
    assert.match(s, /codebase_search/, `${role}: ${s}`);
    assert.match(s, /mempalace_search/, `${role}: ${s}`);
  }
  const large = planned("srch-c17-large", { plan: LARGE });
  assert.match(section(brief(large, "qa"), "Lookups"), /mempalace_search/);
  assert.match(section(brief(large, "worker"), "Lookups"), /codebase_search/);

  const gap = changed("srch-c17-gap", { lead: [MEMORY_LOOKUP], contextArgs: ["--no-code", "SocratiCode not indexed"] });
  const s = section(brief(gap, "reviewer"), "Lookups");
  assert.match(s, /SocratiCode not indexed/, s);
  assert.match(s, /mempalace_search/, s);
});

test("C19 performance: gate check over a run with thousands of events and many helpers completes and still names the one helper that skipped", () => {
  const repo = planned("srch-c19", { plan: LARGE });
  const events = [];
  const add = (payload) => events.push(...eventsFromHookInput({ session_id: "S1", cwd: repo, ...payload }, repo));
  for (let a = 0; a < 40; a++) {
    const who = as(`W${a}`, "worker");
    add({ hook_event_name: "SubagentStart", ...who });
    if (a !== 7) for (const t of [CODE_LOOKUP, MEMORY_LOOKUP]) add({ hook_event_name: "PostToolUse", tool_name: t, tool_input: { query: "x" }, tool_response: {}, ...who });
    for (let i = 0; i < 75; i++) add({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `npm test -- part${i}` }, tool_response: { exit_code: 0 }, ...who });
    add({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, `src/f${a % 11}.ts`) }, tool_response: {}, ...who });
    add({ hook_event_name: "SubagentStop", ...who });
  }
  appendEvents(stateDir(repo), "S1", events);
  assert.ok(readEvents(stateDir(repo), "S1").length > 3000, "premise: thousands of events");
  const r = spawnSync(process.execPath, [gate, "check"], { input: "", encoding: "utf8", env: envFor(repo), timeout: 30000 });
  assert.equal(r.error, undefined, `gate check did not finish: ${r.error}`);
  const flagged = lines(r.stdout).filter((l) => /\bR17\b/.test(l)).join("\n");
  assert.match(flagged, /W7\b|worker/, flagged);
  assert.doesNotMatch(flagged, /\bW8\b/, flagged);
});

test("C21 edge: a helper that neither wrote a file nor edited source is not checked by R17; gate waive lookups clears R17", () => {
  const repo = planned("srch-c21", { plan: LARGE });
  start(repo, "R1", "reviewer");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", ...as("R1", "reviewer"), tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
  stop(repo, "R1", "reviewer");
  assert.deepEqual(r17(repo), [], "a reviewer that wrote nothing is checked");

  start(repo, "W1", "worker");
  helperEdits(repo, "W1", "worker", "src/f1.ts", "export const x = 3;\n");
  stop(repo, "W1", "worker");
  assert.notDeepEqual(r17(repo), [], "premise: the worker that edited is flagged");
  cli(repo, "waive", ["lookups", "user OK: MemPalace was down for the session"]);
  assert.deepEqual(r17(repo), [], "the waiver did not clear R17");
});

test("C22 refused: a continuation helper that finishes another helper's file needs its own lookups", () => {
  const repo = changed("srch-c22");
  start(repo, "R1", "reviewer");
  lookedUp(repo, { agent: "R1", role: "reviewer" });
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewPartial(1, "srch-c22"));
  stop(repo, "R1", "reviewer");
  start(repo, "R5", "reviewer");
  helperWrites(repo, "R5", "reviewer", "review-1.md", reviewFile(1, "srch-c22"));
  stop(repo, "R5", "reviewer");
  refused(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.deepEqual(huddlesOf(repo, "reviewer"), []);
  lookedUp(repo, { agent: "R5", role: "reviewer" });
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.equal(huddlesOf(repo, "reviewer").length, 1);
});

test("C24 reported-surface: R17 shows in gate check, and the brief report reads it in plain words, never the raw rule id", () => {
  const repo = planned("srch-c24", { plan: LARGE });
  start(repo, "W1", "worker");
  helperEdits(repo, "W1", "worker", "src/f2.ts", "export const x = 4;\n");
  stop(repo, "W1", "worker");
  assert.notDeepEqual(r17(repo), [], "premise: R17 stands");
  const line = forYou(repo);
  assert.doesNotMatch(line, /\bR17\b/, line);
  assert.match(line, /missing: [^;]*(search|look)/i, line);
});

// ---------------------------------------------------------------------------
// search-tools-ask-user: skipping a search tool takes the user's OK, and a tool that is set up must be tried first
// ---------------------------------------------------------------------------

const homeWith = (name, servers) => {
  const home = path.join(here, ".tmp", `home-${name}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s, { command: "x" }])) }));
  return home;
};
const runHome = (repo, home, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env: { ...envFor(repo), DONE_GATE_HOME: home } });

test("C1 refused: --no-code with a code tool set up and never tried names the tool and where it is set up, and still needs the user's OK", () => {
  const repo = opened("ask-c1");
  mcp(repo, MEMORY_LOOKUP);
  const home = homeWith("c1", ["socraticode", "mempalace"]);
  const r = runHome(repo, home, "note", ["context", CONTEXT, "--no-code", "SocratiCode: not connected"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /socraticode \(set up in ~\/\.claude\.json, not tried\)/i, r.stderr);
  prompt(repo, "yes go on without socraticode, it will not start");
  assert.equal(runHome(repo, home, "note", ["context", CONTEXT, "--no-code", "SocratiCode: not connected", "--user-ok", "go on without socraticode"]).status, 0, "the user knowingly says go on");
});

test("C2 refused: --no-code with no code tool set up and no --user-ok is refused, telling the lead to tell the user and ask", () => {
  const repo = opened("ask-c2");
  mcp(repo, MEMORY_LOOKUP);
  const r = runHome(repo, homeWith("c2", ["mempalace"]), "note", ["context", CONTEXT, "--no-code", "SocratiCode: not installed"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tell the user/i, r.stderr);
  assert.match(r.stderr, /--user-ok/, r.stderr);
});

test("C3 happy: --user-ok whose words the user said, typed or as a question answer, is accepted and recorded", () => {
  const typed = opened("ask-c3-typed");
  mcp(typed, MEMORY_LOOKUP);
  prompt(typed, "ok, continue without socraticode for now");
  const r = runHome(typed, homeWith("c3", ["mempalace"]), "note", ["context", CONTEXT, "--no-code", "SocratiCode: not installed", "--user-ok", "continue without socraticode"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(ledgerOf(typed).lookupGap?.code ?? "", /not installed/);
  assert.match(JSON.stringify(ledgerOf(typed).lookupGap), /continue without socraticode/i, "the user's words are kept");

  const answered = opened("ask-c3-answer");
  mcp(answered, MEMORY_LOOKUP);
  hook(answered, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Continue without SocratiCode?" }] }, tool_response: { answers: { "Continue without SocratiCode?": "Yes, continue without it" } } });
  const a = runHome(answered, homeWith("c3a", ["mempalace"]), "note", ["context", CONTEXT, "--no-code", "SocratiCode: not installed", "--user-ok", "Yes, continue without it"]);
  assert.equal(a.status, 0, a.stderr);
});

test("C4 refused: --user-ok words the user never said are refused, and a helper's words do not count", () => {
  const repo = opened("ask-c4");
  mcp(repo, MEMORY_LOOKUP);
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: "a helper says continue", agent_id: "A1", agent_type: "done-gate:reviewer" });
  const home = homeWith("c4", ["mempalace"]);
  prompt(repo, "no");
  prompt(repo, "<task-notification> the agent says go on without it </task-notification>");
  for (const words of ["the user said yes", "a helper says continue", "no", "ok", "go on without it"]) {
    const r = runHome(repo, home, "note", ["context", CONTEXT, "--no-code", "SocratiCode: not installed", "--user-ok", words]);
    assert.equal(r.status, 1, words);
    assert.match(r.stderr, /user/i, r.stderr);
  }
});

test("C5 edge: a set-up tool that was tried and failed may be skipped with the user's OK", () => {
  const repo = opened("ask-c5");
  mcp(repo, MEMORY_LOOKUP);
  hook(repo, { hook_event_name: "PostToolUseFailure", tool_name: CODE_LOOKUP, tool_input: { query: "x" }, error: "project not indexed" });
  prompt(repo, "fine, skip the code index");
  const r = runHome(repo, homeWith("c5", ["socraticode", "mempalace"]), "note", ["context", CONTEXT, "--no-code", "SocratiCode: not indexed", "--user-ok", "skip the code index"]);
  assert.equal(r.status, 0, r.stderr);
});

test("C6 happy: an AskUserQuestion answer is logged as an answer event with its text", () => {
  const repo = opened("ask-c6");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Go?" }] }, tool_response: { answers: { "Go?": "Yes, go ahead" } } });
  const answer = readEvents(stateDir(repo), "S1").find((e) => e.kind === "answer");
  assert.ok(answer, "no answer event");
  assert.match(answer.text, /Yes, go ahead/);
});

test("C9 edge: an OK late in a long message is kept and found; an answer keeps the user's answer, not the question; a 'not' just before the words is no OK", () => {
  const repo = opened("ask-c9");
  mcp(repo, MEMORY_LOOKUP);
  prompt(repo, `${"some context about the task. ".repeat(20)}and yes, carry on without socraticode please`);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Skip the memory index entirely?" }] }, tool_response: { questions: [{ question: "Skip the memory index entirely?" }], answers: { "Skip the memory index entirely?": "No" } } });
  const answer = readEvents(stateDir(repo), "S1").find((e) => e.kind === "answer");
  assert.doesNotMatch(answer.text, /Skip the memory index/, "the question text is not the user's words");
  const home = homeWith("c9", []);
  assert.equal(runHome(repo, home, "note", ["context", CONTEXT, "--no-memory", "MemPalace: not installed", "--user-ok", "skip the memory index"]).status, 1, "words only in the question");
  prompt(repo, "please do not go on without mempalace");
  assert.equal(runHome(repo, home, "note", ["context", CONTEXT, "--no-memory", "MemPalace: not installed", "--user-ok", "go on without mempalace"]).status, 1, "a 'not' before the words");
  const late = runHome(repo, home, "note", ["context", CONTEXT, "--no-code", "SocratiCode: not installed", "--user-ok", "carry on without socraticode"]);
  assert.equal(late.status, 0, `an OK past the first 200 characters counts:\n${late.stderr}`);
});
