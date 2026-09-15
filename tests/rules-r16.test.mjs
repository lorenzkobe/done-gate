// T7 — R16, the after-the-fact backstop for lead edits at a delegating size, and the
// freshness half: a worker's edits are implementation edits (R5's last-edit clock, R2's
// late-order check) while R4's driven check stays keyed on the lead's own actions.
//
// Written from the case table, blind to rules.mjs and size.mjs. The boundary values are
// anchored to models.json (tiers.small.maxFiles, roles.worker) and to the ledger file
// itself, never to the implementation's constants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadPolicy } from "../scripts/lib/size.mjs";
import { evaluate, lateOrder } from "../scripts/lib/rules.mjs";

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
