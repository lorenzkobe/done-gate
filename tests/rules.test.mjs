import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, sourceHash, lateOrder } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadPolicy } from "../scripts/lib/size.mjs";

// ===== from tests/rules.test.mjs =====
{
const cfg = loadConfig(makeRepo("rules-cfg"));

function state(over = {}) {
  return {
    config: cfg,
    ledger: null,
    changed: [],
    now: { hash: "h-now", files: {} },
    verify: null,
    events: [],
    reviews: [],
    lastMessage: "",
    ...over,
  };
}

const ids = (unmet) => unmet.map((u) => u.rule);

test("R1: source changed with no ledger blocks; nothing changed passes", () => {
  assert.deepEqual(ids(evaluate(state())), []);
  assert.deepEqual(ids(evaluate(state({ changed: ["src/a.ts"] }))), ["R1"]);
});

test("doc-only changes without a ledger pass R1", () => {
  assert.deepEqual(ids(evaluate(state({ changed: ["docs/notes.md", "README.md"] }))), []);
});

test("R3: with a ledger, verify.json must exist, be green, and match the current source hash", () => {
  const ledger = { status: "open", steps: [], waivers: [], cases: [] };
  const now = { hash: "x", files: { "src/a.ts": { h: "1" }, "docs/x.md": { h: "2" } } };
  const changed = ["src/a.ts", "tests/a.test.ts"];
  assert.ok(ids(evaluate(state({ ledger, changed, now }))).includes("R3"));
  const green = { sourceHash: sourceHash(now, cfg), commands: [{ cmd: "npm run test", exit: 0, timedOut: false }] };
  assert.ok(!ids(evaluate(state({ ledger, changed, now, verify: green }))).includes("R3"));
  const red = { ...green, commands: [{ cmd: "npm run test", exit: 1, timedOut: false }] };
  assert.ok(ids(evaluate(state({ ledger, changed, now, verify: red }))).includes("R3"));
  const timedOut = { ...green, commands: [{ cmd: "npm run build", exit: null, timedOut: true }] };
  assert.ok(ids(evaluate(state({ ledger, changed, now, verify: timedOut }))).includes("R3"));
  const stale = { ...green, sourceHash: "older" };
  assert.ok(ids(evaluate(state({ ledger, changed, now, verify: stale }))).includes("R3"));
});

test("sourceHash ignores non-source files so a docs edit after verify does not invalidate it", () => {
  const a = { files: { "src/a.ts": { h: "1" }, "docs/x.md": { h: "2" } } };
  const b = { files: { "src/a.ts": { h: "1" }, "docs/x.md": { h: "changed" } } };
  const c = { files: { "src/a.ts": { h: "9" }, "docs/x.md": { h: "2" } } };
  assert.equal(sourceHash(a, cfg), sourceHash(b, cfg));
  assert.notEqual(sourceHash(a, cfg), sourceHash(c, cfg));
});

test("R7: source changed without any test file changing blocks unless the qa step is waived", () => {
  const ledger = { status: "open", steps: [], waivers: [], cases: [] };
  assert.ok(ids(evaluate(state({ ledger, changed: ["src/a.ts"] }))).includes("R7"));
  assert.ok(!ids(evaluate(state({ ledger, changed: ["src/a.ts", "tests/a.test.ts"] }))).includes("R7"));
  const waived = { ...ledger, waivers: [{ key: "qa", quote: "skip tests", found: true }] };
  assert.ok(!ids(evaluate(state({ ledger: waived, changed: ["src/a.ts"] }))).includes("R7"));
});

test("every unmet item names its rule and says what to do next", () => {
  const unmet = evaluate(state({ changed: ["src/a.ts"] }));
  assert.equal(unmet.length, 1);
  assert.match(unmet[0].text, /gate open/);
});
}

// ===== from tests/rules2.test.mjs =====
{
const repo = makeRepo("rules2", {
  ".claude/gate.json": JSON.stringify({
    source: ["src/**", "supabase/**", "tests/**"], tests: ["tests/**"], ui: ["src/app/**"],
    schema: ["src/lib/data/db.ts", "supabase/migrations/**"], highRisk: ["src/lib/payments/**"],
    checks: ["claude-md-budget", "migration-number"], driver: "skill:verify",
  }),
  "CLAUDE.md": "# rules\n\nNext number:\n   `0003`.\n",
  "supabase/migrations/0001_a.sql": "x", "supabase/migrations/0002_b.sql": "y",
});
const cfg = loadConfig(repo);
const ids = (s) => evaluate(s).map((u) => u.rule);
const green = (now) => ({ sourceHash: "n/a", commands: [{ cmd: "x", exit: 0, timedOut: false }] });
const clean = (over = {}) => {
  const ledger = {
    status: "open", planSeq: 1, taskSeq: 1, waivers: [], huddles: [], reviews: [],
    cases: [{ id: "C1", status: "closed", test: "t", seq: 2 }],
    steps: [{ n: 1, key: "schema", state: "N/A", note: "none" }],
    gateHash: cfg.hash, baseline: { seq: 0 },
    ...over.ledger,
  };
  return { root: repo, dir: repo, config: cfg, ledger, changed: ["src/a.ts", "tests/a.test.ts"], now: { hash: "x", files: {} }, verify: null, events: [], reviews: [], lastMessage: "", ledgerMd: "", ...over, ledger };
};

test("R4: a UI change needs a driver run (browser event or /verify skill) after the last edit, unless waived", () => {
  const changed = ["src/app/page.tsx", "tests/a.test.ts"];
  assert.ok(ids(clean({ changed })).includes("R4"));
  const edit = { seq: 10, kind: "edit", path: "src/app/page.tsx", agent: null };
  assert.ok(ids(clean({ changed, events: [edit, { seq: 5, kind: "browser", agent: null }] })).includes("R4"), "browser call BEFORE the edit does not count");
  assert.ok(!ids(clean({ changed, events: [edit, { seq: 11, kind: "browser", agent: null }] })).includes("R4"));
  assert.ok(!ids(clean({ changed, events: [edit, { seq: 12, kind: "skill", skill: "verify", agent: null }] })).includes("R4"));
  assert.ok(!ids(clean({ changed, ledger: { waivers: [{ key: "driver", found: true }] } })).includes("R4"));
  assert.ok(!ids(clean({ changed: ["src/lib/x.ts", "tests/a.test.ts"] })).includes("R4"), "non-UI change needs no driver");
});

test("R4 names the missing driver when the repo has none configured", () => {
  const noDriver = loadConfig(makeRepo("rules2-nodriver"));
  const u = evaluate(clean({ config: noDriver, changed: ["src/app/page.tsx", "tests/a.test.ts"] })).find((x) => x.rule === "R4");
  assert.match(u.text, /verify-setup/);
});

test("R5: source change needs a reviewer huddle with its file, after the last edit, with every Act-on item closed", () => {
  const edit = { seq: 10, kind: "edit", path: "src/a.ts", agent: null };
  assert.ok(ids(clean({ events: [edit] })).includes("R5"));
  const stopEarly = { seq: 9, kind: "subagent-stop", agentType: "done-gate:reviewer" };
  const stopLate = { seq: 20, kind: "subagent-stop", agentType: "done-gate:reviewer" };
  const huddle = { id: "H1", role: "reviewer", file: "review-1.md", actOn: [] };
  assert.ok(ids(clean({ events: [edit, stopEarly], reviews: ["review-1.md"], ledger: { huddles: [huddle] } })).includes("R5"), "review before the last edit is stale");
  assert.ok(ids(clean({ events: [edit, stopLate], reviews: [], ledger: { huddles: [huddle] } })).includes("R5"), "no review file");
  assert.ok(!ids(clean({ events: [edit, stopLate], reviews: ["review-1.md"], ledger: { huddles: [huddle] } })).includes("R5"));
  const open = { ...huddle, actOn: [{ id: "H1.1", text: "x", closed: null }] };
  assert.ok(ids(clean({ events: [edit, stopLate], reviews: ["review-1.md"], ledger: { huddles: [open] } })).includes("R5"));
  assert.ok(!ids(clean({ events: [edit], ledger: { waivers: [{ key: "review", found: true }] } })).includes("R5"));
});

test("R6: a schema change needs the schema step DONE with evidence, never N/A", () => {
  const changed = ["src/lib/data/db.ts", "tests/a.test.ts"];
  assert.ok(ids(clean({ changed })).includes("R6"));
  assert.ok(!ids(clean({ changed, ledger: { steps: [{ n: 1, key: "schema", state: "DONE", evidence: "events#3" }] } })).includes("R6"));
  assert.ok(!ids(clean({ changed, ledger: { waivers: [{ key: "schema", found: true }] } })).includes("R6"));
});

test("R9: a high-risk change needs the second reviewer too", () => {
  const changed = ["src/lib/payments/x.ts", "tests/a.test.ts"];
  const edit = { seq: 10, kind: "edit", path: "src/lib/payments/x.ts", agent: null };
  const r1 = { seq: 20, kind: "subagent-stop", agentType: "done-gate:reviewer" };
  const r2 = { seq: 21, kind: "subagent-stop", agentType: "done-gate:reviewer-2" };
  const h1 = { id: "H1", role: "reviewer", file: "review-1.md", actOn: [] };
  const h2 = { id: "H2", role: "reviewer-2", file: "review-2.md", actOn: [] };
  assert.ok(ids(clean({ changed, events: [edit, r1], reviews: ["review-1.md"], ledger: { huddles: [h1] } })).includes("R9"));
  assert.ok(!ids(clean({ changed, events: [edit, r1, r2], reviews: ["review-1.md", "review-2.md"], ledger: { huddles: [h1, h2] } })).includes("R9"));
  assert.ok(!ids(clean({ changed: ["src/a.ts", "tests/a.test.ts"], events: [edit, r1], reviews: ["review-1.md"], ledger: { huddles: [h1] } })).includes("R9"));
});

test("R10: migration-number requires CLAUDE.md's next number to be max+1 when a migration is added; claude-md-budget caps CLAUDE.md", () => {
  assert.ok(!ids(clean({ changed: ["src/a.ts", "tests/a.test.ts"] })).includes("R10"));
  write(repo, "supabase/migrations/0003_c.sql", "z");
  assert.ok(ids(clean({ changed: ["supabase/migrations/0003_c.sql", "tests/a.test.ts"] })).includes("R10"), "CLAUDE.md still says 0003");
  write(repo, "CLAUDE.md", "# rules\n\nNext number:\n   `0004`.\n");
  assert.ok(!ids(clean({ changed: ["supabase/migrations/0003_c.sql", "tests/a.test.ts"] })).includes("R10"));
  write(repo, "CLAUDE.md", `# big\n${"x".repeat(150_001)}\n`);
  assert.ok(ids(clean({ changed: ["CLAUDE.md"] })).includes("R10"));
  assert.ok(ids({ root: repo, config: cfg, ledger: null, changed: ["CLAUDE.md"], now: { hash: "x", files: {} }, events: [] }).includes("R10"), "doc-only path still runs the checks");
  write(repo, "CLAUDE.md", "# rules\n\nNext number:\n   `0004`.\n");
});

test("R13: gate.json changed since the ledger opened blocks unless waived", () => {
  assert.ok(ids(clean({ ledger: { gateHash: "stale" } })).includes("R13"));
  assert.ok(!ids(clean({ ledger: { gateHash: "stale", waivers: [{ key: "gate-config", found: true }] } })).includes("R13"));
});

test("agent briefs exist with the fixed model table and the write fences described", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const { pluginRoot } = await import("./helpers.mjs");
  const models = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
  assert.deepEqual(models.roles, { skeptic: "sonnet", qa: "opus", reviewer: "sonnet", "reviewer-2": "opus", arbiter: "opus", worker: "sonnet" });
  for (const [name, model] of Object.entries(models.roles)) {
    const file = path.join(pluginRoot, "agents", `${name}.md`);
    assert.ok(existsSync(file), file);
    const fm = readFileSync(file, "utf8").split("---")[1];
    assert.match(fm, new RegExp(`^name: ${name}$`, "m"));
    assert.match(fm, new RegExp(`^model: ${model}$`, "m"));
    assert.ok(!/fable/i.test(fm), "Fable is never a helper");
  }
});
}

// ===== from tests/late-order.test.mjs =====
{
// C11 — R2 matches its own message. An edit logged before `gate open` means the Plan and
// the case table are written after the first code change; R2 blocks only while one of them
// is missing altogether, and once both exist the late order is recorded in the reports
// rather than blocking the turn. Written from the case table, blind to rules.mjs/report.mjs.

const SESSION = "L1";

// The model's own shell: no session env at all, so the verbs fall back to the marker the
// SessionStart hook wrote (tests/session-marker.test.mjs owns that contract).
function shellEnv(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo };
  delete e.DONE_GATE_SESSION;
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.DONE_GATE_STATE_DIR;
  return e;
}

function sh(repo, args) {
  const r = spawnSync(process.execPath, [gate, ...args], { input: "", encoding: "utf8", env: shellEnv(repo) });
  assert.equal(r.status, 0, `gate ${args.join(" ")}\n${r.stderr}`);
  return r;
}

function hookVerb(repo, verb, payload) {
  const r = spawnSync(process.execPath, [gate, verb], {
    input: JSON.stringify({ session_id: SESSION, cwd: repo, ...payload }),
    encoding: "utf8",
    env: shellEnv(repo),
  });
  assert.equal(r.status, 0, `gate ${verb}\n${r.stderr}`);
  return r;
}

// `check` exits 0 whether or not rules are unmet; only a crash is a failure here.
function check(repo) {
  const r = spawnSync(process.execPath, [gate, "check"], { input: "", encoding: "utf8", env: shellEnv(repo) });
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!/GATE ERROR/.test(out), out);
  return r.stdout;
}

test("C11 boundary: an edit logged before `gate open` blocks R2 only while the Plan or case table is missing, then the late order is recorded", () => {
  const repo = makeRepo("late-order-c11");

  hookVerb(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });

  // the Edit tool fires the PostToolUse hook, then the bytes land — before any ledger
  hookVerb(repo, "log", {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(repo, "src", "a.ts") },
    tool_output: "ok",
  });
  write(repo, "src/a.ts", "export const a = 2;\n");

  sh(repo, ["open", "late", "feature"]);

  // nothing written yet: R2 blocks
  const empty = check(repo);
  assert.match(empty, /R2/, `R2 should block while the Plan and case table are missing:\n${empty}`);

  // the Plan alone is not enough — the case table must exist too
  sh(repo, ["note", "task", "Make a() return 2. [inferred]"]);
  sh(repo, ["note", "plan", "One file, one constant.", "--files", "src/a.ts"]);
  const planOnly = check(repo);
  assert.match(planOnly, /R2/, `R2 should still block while the case table is missing:\n${planOnly}`);

  // with both written, the late order stops blocking
  sh(repo, ["case", "add", "a() returns 2", "--kind", "happy"]);
  sh(repo, ["case", "close", "C1", "--na", "covered by the existing fixture"]);
  const both = check(repo);
  assert.ok(!/R2\b/.test(both), `a late Plan and case table that exist must not block:\n${both}`);

  // …and is recorded instead
  const brief = sh(repo, ["report", "--brief"]).stdout;
  assert.match(
    brief,
    /written after the first code change/,
    `the brief should record the late order:\n${brief}`,
  );
});
}

// ===== from tests/rules-r16.test.mjs =====
{
// T7 — R16, the after-the-fact backstop for lead edits at a delegating size, and the
// freshness half: a worker's edits are implementation edits (R5's last-edit clock, R2's
// late-order check) while R4's driven check stays keyed on the lead's own actions.
//
// Written from the case table, blind to rules.mjs and size.mjs. The boundary values are
// anchored to models.json (tiers.small.maxFiles, roles.worker) and to the ledger file
// itself, never to the implementation's constants.

// ---------------------------------------------------------------------------
// source-of-truth anchors: models.json, never the implementation's constants
// ---------------------------------------------------------------------------

const MODELS = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
const SMALL_MAX_FILES = MODELS.policy.tiers.small.maxFiles; // 1: one more file is standard
assert.ok(MODELS.roles.worker, "anchor: models.json roles.worker is the delegated editor");
const WORKER = "done-gate:worker"; // the agent_type the Agent tool reports for that role

// the smallest --files list a prediction calls standard, and a list it calls small
const STANDARD_FILES = Array.from({ length: SMALL_MAX_FILES + 1 }, (_, i) => `src/f${i}.ts`);
const SMALL_FILES = STANDARD_FILES.slice(0, SMALL_MAX_FILES);

// ---------------------------------------------------------------------------
// conventions (mirrors tests/report-tier.test.mjs and tests/late-order.test.mjs)
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

// hook payloads, fed to `gate log` exactly as Claude Code's hooks feed them
function hook(repo, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// An Edit PostToolUse payload. No agent_id/agent_type is the lead; a worker carries both.
const editHook = (repo, rel, agent = null) =>
  hook(repo, {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(repo, rel) },
    tool_output: "ok",
    ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
  });

const leadEdit = (repo, rel) => editHook(repo, rel);
const workerEdit = (repo, rel) => editHook(repo, rel, { id: "W1", type: WORKER });

// `check` exits non-zero while rules are unmet; only a crash is a failure here.
function check(repo) {
  const r = spawnSync(process.execPath, [gate, "check"], { input: "", encoding: "utf8", env: envFor(repo) });
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!/GATE ERROR/.test(out), out);
  return r.stdout;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const r16Lines = (out) => lines(out).filter((l) => /\bR16\b/.test(l));

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

// An open feature ledger (feature is tiered) with Task written; the Plan is left to the test.
function opened(name) {
  const repo = committed(name);
  cli(repo, "open", ["r16", "feature"]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  return repo;
}

const notePlan = (repo, files) =>
  cli(repo, "note", ["plan", "One component, no data change.", ...(files ? ["--files", files.join(",")] : [])]).stdout;

// the effective size `gate size` reports, which is what R16 must name
const effectiveSize = (repo) => /^tier: (\S+)/.exec(lines(cli(repo, "size").stdout)[0])[1];

// ---------------------------------------------------------------------------
// hand-built state for the pure rules (mirrors tests/rules2.test.mjs)
// ---------------------------------------------------------------------------

const unitRepo = makeRepo("rules-r16-unit", {
  ".claude/gate.json": JSON.stringify({
    source: ["src/**", "tests/**"], tests: ["tests/**"], ui: ["src/app/**"],
  }),
});
const cfg = loadConfig(unitRepo);
const policy = loadPolicy();
const ids = (s) => evaluate(s).map((u) => u.rule);
const textOf = (s, rule) => evaluate(s).find((u) => u.rule === rule)?.text ?? "";

const clean = (over = {}) => {
  const ledger = {
    status: "open", playbook: "feature", planSeq: 1, taskSeq: 1, waivers: [], huddles: [], reviews: [],
    cases: [{ id: "C1", status: "closed", test: "t", seq: 2 }],
    steps: [{ n: 1, key: "schema", state: "N/A", note: "none" }],
    gateHash: cfg.hash, baseline: { seq: 0 },
    ...over.ledger,
  };
  return {
    root: unitRepo, dir: unitRepo, config: cfg, policy, ledger,
    changed: ["src/a.ts", "tests/a.test.ts"], now: { hash: "x", files: {} },
    verify: null, events: [], reviews: [], lastMessage: "", ledgerMd: "",
    ...over, ledger,
  };
};

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 refused: at predicted standard, a lead edit event on src/a.ts after the plan is R16 naming the path and the size; the worker's edit is not", () => {
  const repo = opened("rules-r16-c1");
  const predicted = notePlan(repo, STANDARD_FILES);
  assert.match(predicted, /predicted standard/, `${SMALL_FILES.length + 1} files must predict standard: ${predicted}`);

  // the lead edits one file itself, the worker edits another
  write(repo, "src/a.ts", "export const a = 2;\n");
  leadEdit(repo, "src/a.ts");
  write(repo, "src/b.ts", "export const b = 1;\n");
  workerEdit(repo, "src/b.ts");

  const size = effectiveSize(repo);
  assert.equal(size, "standard", "the prediction keeps the task at a delegating size");

  const found = r16Lines(check(repo));
  assert.equal(found.length, 1, `exactly one R16 item was expected:\n${check(repo)}`);
  assert.match(found[0], /src\/a\.ts/, `R16 must name the file the lead edited: ${found[0]}`);
  assert.match(found[0], new RegExp(`\\b${size}\\b`), `R16 must name the size: ${found[0]}`);
  assert.ok(!/src\/b\.ts/.test(found[0]), `a worker's edit is not a violation: ${found[0]}`);
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 happy: at predicted small, and on the untiered plan playbook, a lead edit event never produces R16", () => {
  const small = opened("rules-r16-c2-small");
  const predicted = notePlan(small, SMALL_FILES);
  assert.match(predicted, /predicted small/, `${SMALL_FILES.length} file must predict small: ${predicted}`);
  write(small, "src/a.ts", "export const a = 2;\n");
  leadEdit(small, "src/a.ts");
  assert.equal(effectiveSize(small), "small", "nothing outgrew the prediction");
  assert.deepEqual(r16Lines(check(small)), [], "at small the lead edits its own source");

  // the plan playbook is not tiered at all: there is no size, so there is no delegation
  const notes = committed("rules-r16-c2-plan");
  cli(notes, "open", ["notes", "plan"]);
  cli(notes, "note", ["task", "Write the spec. [inferred]"]);
  cli(notes, "note", ["plan", "One document.", "--files", STANDARD_FILES.join(",")]);
  write(notes, "src/a.ts", "export const a = 2;\n");
  leadEdit(notes, "src/a.ts");
  assert.deepEqual(r16Lines(check(notes)), [], "an untiered playbook never delegates");
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 boundary: a lead edit before the plan stays clean when the size is re-predicted to standard", () => {
  const repo = opened("rules-r16-c3");

  // the edit happens first, while nothing has been predicted at all
  write(repo, "src/a.ts", "export const a = 2;\n");
  leadEdit(repo, "src/a.ts");

  notePlan(repo, SMALL_FILES); // predicted small
  notePlan(repo, STANDARD_FILES); // re-predicted standard, after the edit

  assert.equal(effectiveSize(repo), "standard", "the second prediction is the one in force");
  assert.deepEqual(r16Lines(check(repo)), [], "a re-prediction must not backdate a violation");
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

test("C4 happy: a worker edit after the reviewer's stop makes R5 say there is no reviewer pass after the last edit", () => {
  const edit = { seq: 10, kind: "edit", path: "src/a.ts", agent: null, agentType: null };
  const stop = { seq: 20, kind: "subagent-stop", agentType: "done-gate:reviewer" };
  const huddle = { id: "H1", role: "reviewer", file: "review-1.md", actOn: [] };
  const reviewed = { events: [edit, stop], reviews: ["review-1.md"], ledger: { huddles: [huddle] } };

  assert.ok(!ids(clean(reviewed)).includes("R5"), "the reviewer stopped after the lead's last edit");

  const after = { seq: 30, kind: "edit", path: "src/a.ts", agent: "W1", agentType: WORKER };
  const state = clean({ ...reviewed, events: [edit, stop, after] });
  assert.ok(ids(state).includes("R5"), "a worker's edit is an implementation edit: the review is stale");
  assert.match(textOf(state, "R5"), /no reviewer pass after the last edit/);
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 edge: a worker edit before the Plan makes lateOrder name the Plan late, as a lead edit would", () => {
  const before = { seq: 50, kind: "edit", path: "src/a.ts", agent: "W1", agentType: WORKER };
  const ledger = { planSeq: 100, cases: [{ id: "C1", status: "closed", test: "t", seq: 101 }] };

  const late = lateOrder(clean({ events: [before], ledger }));
  assert.deepEqual(late.late, ["Plan", "case table"], "both were written after the worker's first edit");
  assert.equal(late.path, "src/a.ts");

  // the same worker edit after both: nothing is late (the path is still reported)
  const after = { ...before, seq: 200 };
  assert.deepEqual(lateOrder(clean({ events: [after], ledger })).late, []);
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 edge: a worker's UI edit and a worker's browser call leave R4 unmet; only the lead's own driver run clears it", () => {
  const changed = ["src/app/page.tsx", "tests/a.test.ts"];
  const edit = { seq: 10, kind: "edit", path: "src/app/page.tsx", agent: "W1", agentType: WORKER };
  assert.ok(ids(clean({ changed, events: [edit] })).includes("R4"), "a worker's UI edit does not drive the surface");

  const byWorker = { seq: 20, kind: "browser", agent: "W1", agentType: WORKER };
  assert.ok(ids(clean({ changed, events: [edit, byWorker] })).includes("R4"), "R4's driven check ignores a worker's own browser call");

  const byLead = { seq: 30, kind: "browser", agent: null, agentType: null };
  assert.ok(!ids(clean({ changed, events: [edit, byWorker, byLead] })).includes("R4"), "the lead drove the surface after the last edit");
});

// ---------------------------------------------------------------------------
// C7 — as amended in the ledger's Plan after the skeptic huddle: the mark is stamped once,
// when the size first becomes delegated, and a re-prediction keeps it.
// ---------------------------------------------------------------------------

test("C7 happy: `gate note plan --files` stamps tier.predictedSeq when the size first becomes standard, and a later re-prediction keeps that mark", () => {
  const repo = opened("rules-r16-c7");

  // small: the lead may edit, so there is no mark to count from
  notePlan(repo, SMALL_FILES);
  const first = ledgerOf(repo);
  assert.equal(first.tier.predictedSeq, null, `a small prediction must not stamp predictedSeq: ${JSON.stringify(first.tier)}`);

  // standard: the mark is set now
  notePlan(repo, STANDARD_FILES);
  const second = ledgerOf(repo);
  assert.equal(second.tier.predicted, "standard");
  assert.equal(typeof second.tier.predictedSeq, "number", `no tier.predictedSeq after a standard prediction: ${JSON.stringify(second.tier)}`);
  assert.ok(second.tier.predictedSeq >= second.planSeq, `the mark is not older than the Plan: ${second.tier.predictedSeq} < ${second.planSeq}`);

  // a re-prediction while already delegated never moves the mark forward (that would erase a standing R16)
  notePlan(repo, STANDARD_FILES);
  const third = ledgerOf(repo);
  assert.equal(third.tier.predictedSeq, second.tier.predictedSeq, "a re-prediction at a delegated size must keep the original mark");
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

test("C8 boundary: a ledger with no tier.predictedSeq falls back to planSeq", () => {
  const repo = opened("rules-r16-c8");

  // an edit before the Plan, and one after it
  write(repo, "src/b.ts", "export const b = 1;\n");
  leadEdit(repo, "src/b.ts");
  notePlan(repo, STANDARD_FILES);
  write(repo, "src/a.ts", "export const a = 2;\n");
  leadEdit(repo, "src/a.ts");

  // an older ledger, written before predictedSeq existed
  const dir = runDir(repo);
  const ledger = loadLedger(dir);
  delete ledger.tier.predictedSeq;
  saveLedger(dir, ledger);
  assert.equal(loadLedger(dir).tier.predictedSeq, undefined);

  const out = check(repo);
  const found = r16Lines(out);
  assert.equal(found.length, 1, `exactly one R16 item was expected:\n${out}`);
  assert.match(found[0], /src\/a\.ts/, `the edit after planSeq is the violation: ${found[0]}`);
  assert.ok(!/src\/b\.ts/.test(found[0]), `the edit before planSeq is not: ${found[0]}`);
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

// A shell edit leaves no `edit` event: the source hash moves and the only event that can
// explain it is the Bash call. Whose Bash call it was decides R16 — this is the case the
// fence cannot see, so the backstop must read the same lead/worker line here as it does
// for tool edits.
function shellEdit(repo, agent = null) {
  hook(repo, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "sed -i '' 's/1/2/' src/a.ts" },
    tool_output: "",
    ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
  });
  write(repo, "src/a.ts", "export const a = 2;\n"); // the bytes land after the hook fires
}

test("C10 edge: at a delegated size a source change explained only by a worker's Bash call is not R16; the lead's own Bash call is", () => {
  const byWorker = opened("rules-r16-c10-worker");
  notePlan(byWorker, STANDARD_FILES);
  shellEdit(byWorker, { id: "W1", type: WORKER });
  assert.equal(effectiveSize(byWorker), "standard", "the prediction keeps the task at a delegating size");
  assert.deepEqual(r16Lines(check(byWorker)), [], "the worker is the one allowed to edit, shell or tool");

  const byLead = opened("rules-r16-c10-lead");
  notePlan(byLead, STANDARD_FILES);
  shellEdit(byLead);
  assert.equal(effectiveSize(byLead), "standard");
  const out = check(byLead);
  const found = r16Lines(out);
  assert.equal(found.length, 1, `a lead shell edit at a delegated size is R16:\n${out}`);
  assert.match(found[0], /\bstandard\b/, `R16 must name the size: ${found[0]}`);
});
}

// ===== from tests/waivers.test.mjs =====
{
// T1 — waivers are key + reason: no transcript lookup, no claim labels.
// Written from the requirements and the case table, blind to the implementation.
//
// Sources of truth for the literals below:
//   - waiver step keys ("qa", "driver", …) and rule ids: scripts/lib/rules.mjs (R7 waives on
//     the step key "qa"; R11/R12 are the two rules this task removes).
//   - the dispute evidence pointer grammar: the `gate huddle dispute` usage string, which
//     names "a test (file:name), a file:line, verify.json, events#<seq> or a helper file".
//   - the run dir / ledger.json layout: scripts/lib/session-state.mjs + scripts/lib/ledger.mjs.

// ---------------------------------------------------------------------------
// conventions (mirrors tests/rules.test.mjs for the repo, tests/review-dispute.test.mjs
// for the CLI: scripts/gate.mjs always sets process.exitCode = 0, so a refusal is a
// `done-gate: <message>` line on stderr, never a non-zero status)
// ---------------------------------------------------------------------------

const REFUSAL = /^done-gate: /m;

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1" } = {}) {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}

function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.match(r.stderr, REFUSAL, `expected \`gate ${verb} ${args.join(" ")}\` to be refused, got:\n${r.stdout}${r.stderr}`);
  return r;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const writeLedger = (repo, ledger) =>
  writeFileSync(path.join(runDir(repo), "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// `gate check` prints one "<n>. <rule> — <text>" line per unmet rule, or "clean".
const check = (repo) => run(repo, "check").stdout;
const ruleLine = (out, rule) => lines(out).find((l) => new RegExp(`\\b${rule}\\b`).test(l));

// A Stop hook payload, exactly as Claude Code feeds one (tests/stop.test.mjs owns the shape).
// `extra` lets a case leave transcript_path out entirely.
function stop(repo, message = "done.", extra = {}, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({
      session_id: session,
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: message,
      ...extra,
    }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return { ...r, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null };
}

const errorLog = (repo) => path.join(stateDir(repo), "gate-error.log");

// An open feature ledger over a repo whose only change is one source file — the exact
// shape R7 fires on (source changed, no test file changed).
function openedWithSourceEdit(name) {
  const repo = makeRepo(name);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Change one module."]);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  write(repo, "src/a.ts", "export const a = 2;\n");
  return repo;
}

// ---------------------------------------------------------------------------
// C1 happy — `gate waive qa "<reason>"` needs no transcript, and the report says why
// ---------------------------------------------------------------------------

const QA_REASON = "no tests for this one, it is a prose-only change and I read it myself";

test("C1: waive qa records the reason with no transcript lookup, satisfies R7, and the report prints the reason", () => {
  const repo = openedWithSourceEdit("waivers-c1");

  // R7 is unmet before the waiver: source changed, no test file changed.
  assert.ok(ruleLine(check(repo), "R7"), `R7 did not fire on a source-only change:\n${check(repo)}`);

  const waived = cli(repo, "waive", ["qa", QA_REASON]);
  assert.doesNotMatch(
    waived.stdout,
    /transcript/i,
    `\`gate waive\` still promises a transcript lookup: ${waived.stdout}`,
  );

  // The waiver is key + reason. Nothing records a transcript verdict.
  const [w, ...rest] = ledgerOf(repo).waivers;
  assert.equal(rest.length, 0, "one waive recorded more than one waiver");
  assert.equal(w.key, "qa");
  assert.equal(w.reason, QA_REASON, `the waiver does not carry the reason: ${JSON.stringify(w)}`);
  assert.ok(!("found" in w), `the waiver still carries a transcript verdict: ${JSON.stringify(w)}`);
  assert.equal(typeof w.seq, "number", `the waiver has no seq: ${JSON.stringify(w)}`);

  // R7 is satisfied, and no rule complains about the waiver itself.
  const out = check(repo);
  assert.ok(!ruleLine(out, "R7"), `R7 still fires after \`gate waive qa\`:\n${out}`);
  assert.ok(!ruleLine(out, "R12"), `R12 fired on a waiver with no transcript:\n${out}`);

  // The report names the waived key and quotes the user's reason, without a transcript verdict.
  const md = cli(repo, "report").stdout;
  const waiverLine = lines(md).find((l) => /waived/i.test(l) && /\bqa\b/.test(l));
  assert.ok(waiverLine, `the report has no waiver line for qa:\n${md}`);
  assert.ok(waiverLine.includes(QA_REASON), `the report's waiver line drops the reason: ${waiverLine}`);
  assert.doesNotMatch(waiverLine, /transcript/i, `the report still reports a transcript verdict: ${waiverLine}`);

  // The plain-language brief says the same thing in the user's own words.
  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.ok(brief.includes(QA_REASON), `the brief drops the waiver reason:\n${brief}`);
  assert.doesNotMatch(brief, /could not find you saying/i, `the brief still hunts the transcript:\n${brief}`);
});

// ---------------------------------------------------------------------------
// C2 refused — pointerResolver survives the move out of claims.mjs
// ---------------------------------------------------------------------------

const FINDING = "null venue crashes the badge — src/a.ts:2 — venue is optional on the card";
const WHY = "the caller already null-checks venue before it renders the card";

test("C2: gate huddle dispute is refused when --evidence does not resolve, and accepted when it does", () => {
  const repo = openedWithSourceEdit("waivers-c2");
  writeFileSync(
    path.join(runDir(repo), "review-1.md"),
    `# Review 1 — waivers-c2\n\n## Act on\n- ${FINDING}\n\n## Consider\n- rename the helper\n`,
  );
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  const itemOf = (id) => ledgerOf(repo).huddles.flatMap((h) => h.actOn ?? []).find((a) => a.id === id);
  assert.ok(itemOf("H1.1"), `the reviewer finding was not recorded as H1.1: ${JSON.stringify(ledgerOf(repo).huddles)}`);

  // refused: a file that is in neither the run dir nor the repo
  const missingFile = refused(repo, "huddle", ["dispute", "H1.1", WHY, "--evidence", "src/nope.ts:12"]);
  assert.match(missingFile.stderr, /resolve/i, `the refusal does not say the pointer failed to resolve: ${missingFile.stderr}`);
  assert.equal(itemOf("H1.1").dispute ?? null, null, "a dispute was recorded with an unresolvable pointer");

  // refused: an events#<seq> pointer with no such event
  const missingEvent = refused(repo, "huddle", ["dispute", "H1.1", WHY, "--evidence", "events#99999"]);
  assert.match(missingEvent.stderr, /resolve/i, `the refusal does not say the pointer failed to resolve: ${missingEvent.stderr}`);
  assert.equal(itemOf("H1.1").dispute ?? null, null, "a dispute was recorded with an unresolvable events pointer");

  // refused: a helper file the run dir does not hold
  refused(repo, "huddle", ["dispute", "H1.1", WHY, "--evidence", "review-9.md"]);
  assert.equal(itemOf("H1.1").dispute ?? null, null, "a dispute was recorded against a helper file that does not exist");

  // permitted: a real file:line in the repo
  cli(repo, "huddle", ["dispute", "H1.1", WHY, "--evidence", "src/a.ts:2"]);
  const recorded = JSON.stringify(itemOf("H1.1").dispute);
  assert.ok(recorded.includes(WHY), `the dispute does not carry the why: ${recorded}`);
  assert.ok(recorded.includes("src/a.ts:2"), `the dispute does not carry the evidence pointer: ${recorded}`);
});

// ---------------------------------------------------------------------------
// C3 edge — no claim labels anywhere, and nothing asks for them
// ---------------------------------------------------------------------------

test("C3: an unlabelled claim in ledger.md or in the final message never produces an unmet R11", () => {
  const repo = openedWithSourceEdit("waivers-c3");
  appendFileSync(
    path.join(runDir(repo), "ledger.md"),
    "\n## Notes\n\nAll the tests pass and the build is green.\n",
  );

  const out = check(repo);
  assert.ok(!ruleLine(out, "R11"), `R11 fired on an unlabelled line in ledger.md:\n${out}`);
  assert.doesNotMatch(out, /\[measured\]|\[inferred\]|\[guess\]/, `a rule still asks for claim labels:\n${out}`);

  // The same claim as the turn's last message, through the real Stop hook.
  const blocked = stop(repo, "Tests pass, the build is green and there are no regressions.");
  const reason = blocked.json?.reason ?? "";
  assert.ok(!ruleLine(reason, "R11"), `the stop hook reported R11 for an unlabelled claim:\n${reason}`);
  assert.doesNotMatch(reason, /unlabelled/i, `the stop hook still complains about unlabelled claims:\n${reason}`);
  assert.doesNotMatch(reason, /\[measured\]|\[inferred\]|\[guess\]/, `the stop hook still asks for claim labels:\n${reason}`);
});

// ---------------------------------------------------------------------------
// C4 boundary — an old ledger.json, written before this change, still waives
// ---------------------------------------------------------------------------

test("C4: a waiver carried over with found:false still counts as waived, and never raises R12", () => {
  const repo = openedWithSourceEdit("waivers-c4");
  cli(repo, "waive", ["qa", QA_REASON]);

  // Rewrite the waiver in the shape the previous version stored: a quote plus a transcript
  // verdict of false. A ledger opened before this task can hold exactly this.
  const ledger = ledgerOf(repo);
  ledger.waivers = [{ key: "qa", quote: QA_REASON, found: false, seq: ledger.waivers[0].seq }];
  writeLedger(repo, ledger);

  const out = check(repo);
  assert.ok(!ruleLine(out, "R7"), `a waiver with found:false stopped waiving R7 (the match is on the key):\n${out}`);
  assert.ok(!ruleLine(out, "R12"), `R12 still fires on an old waiver's transcript verdict:\n${out}`);
  assert.doesNotMatch(out, /transcript/i, `a rule still talks about the transcript:\n${out}`);

  // The stop hook agrees with `gate check`, and leaves the old field alone.
  const reason = stop(repo).json?.reason ?? "";
  assert.ok(!ruleLine(reason, "R12"), `the stop hook reported R12 for an old waiver:\n${reason}`);
  assert.ok(!ruleLine(reason, "R7"), `the stop hook did not honour an old waiver:\n${reason}`);
  assert.equal(ledgerOf(repo).waivers[0].key, "qa", "the stop hook rewrote the carried-over waiver");
});

// ---------------------------------------------------------------------------
// C5 edge — the Stop hook no longer needs a transcript at all
// ---------------------------------------------------------------------------

test("C5: the stop hook with no transcript_path in the payload does not throw", () => {
  const repo = openedWithSourceEdit("waivers-c5");
  cli(repo, "waive", ["qa", QA_REASON]);
  cli(repo, "waive", ["driver", "no UI here, skip the phone pass"]);

  assert.ok(!existsSync(errorLog(repo)), "the repo already had a gate-error.log before the stop hook ran");

  // The payload carries no transcript_path key at all.
  const r = stop(repo, "A change and two waivers.");
  const both = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(both, /GATE ERROR/, `the stop hook failed open with a gate error:\n${both}`);
  assert.doesNotMatch(r.stderr, /at .*\.mjs/, `the stop hook threw:\n${r.stderr}`);
  assert.ok(!existsSync(errorLog(repo)), `the stop hook logged a gate error:\n${existsSync(errorLog(repo)) ? readFileSync(errorLog(repo), "utf8") : ""}`);

  const reason = r.json?.reason ?? "";
  assert.ok(!ruleLine(reason, "R11"), `the stop hook reported R11:\n${reason}`);
  assert.ok(!ruleLine(reason, "R12"), `the stop hook reported R12:\n${reason}`);
  assert.ok(!ruleLine(reason, "R7"), `the waiver did not satisfy R7 without a transcript:\n${reason}`);

  // A transcript_path that points nowhere is equally harmless: nothing reads it any more.
  const ghost = stop(repo, "Again.", { transcript_path: path.join(repo, "no-such-transcript.jsonl") });
  assert.doesNotMatch(`${ghost.stdout}${ghost.stderr}`, /GATE ERROR/, `a missing transcript file crashed the stop hook:\n${ghost.stderr}`);
  assert.ok(!existsSync(errorLog(repo)), "a missing transcript file logged a gate error");
  assert.ok(!ruleLine(ghost.json?.reason ?? "", "R12"), `R12 fired once a transcript path was supplied:\n${ghost.json?.reason}`);
});
}
