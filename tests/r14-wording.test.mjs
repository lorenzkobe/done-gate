// R14's sentence. The rule reopens an optional step that was marked N/A once the task's
// effective tier turns out to require it; these cases are about what it *says* when it does.
// States are built through the CLI exactly as tests/tier-policy.test.mjs C10/C23 build theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadPolicy, requires, tierFor, tierOrder } from "../scripts/lib/policy.mjs";
import { OPTIONAL_STEPS } from "../scripts/lib/size.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/tier-policy.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session),
  });
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// `check` exits 0 whether or not rules are unmet; only a crash is a failure here.
function check(repo) {
  const r = run(repo, "check");
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!/GATE ERROR/.test(out), out);
  return r.stdout;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const stepOf = (ledger, key) => ledger.steps.find((s) => s.key === key);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// Exactly one R14 line, returned.
function r14Line(out) {
  const ls = out.split("\n").filter((l) => l.includes("R14"));
  assert.equal(ls.length, 1, out);
  return ls[0];
}

// ---------------------------------------------------------------------------
// sources of truth for every literal below
// ---------------------------------------------------------------------------

const policy = loadPolicy();

// Tier names come from models.json via policy.mjs, not from any string in rules.mjs.
const SMALL = tierFor(policy, { files: 1, lines: 2 });
const STANDARD = tierFor(policy, { files: 3, lines: 6 });

// The exact shape of the size sentence, tier names taken from policy order (models.json).
// Written out rather than stitched from `.*` so a nested-parenthesis mess like
// "the task's size ((standard, 1 files, 2 lines)) requires" cannot slip through.
const TIER_ALT = tierOrder(policy).join("|");
const SIZE_SHAPE = new RegExp(`the task's size \\((${TIER_ALT}), \\d+ files?, \\d+ lines?\\) requires`);

// Asserts the size sentence, in shape, and that the line has no doubled parenthesis anywhere.
function assertSizeShape(line) {
  assert.match(line, SIZE_SHAPE);
  assert.match(line, /the task's size \((small|standard|large), \d+ files?, \d+ lines?\) requires/);
  assert.equal(
    (line.match(/\(\(/g) ?? []).length,
    0,
    `no "((" anywhere on the R14 line, got: ${line}`,
  );
  assert.equal((line.match(/\)\)/g) ?? []).length, 0, `no "))" either, got: ${line}`);
}

// The tier the size sentence names.
function namedTier(line) {
  const m = SIZE_SHAPE.exec(line);
  assert.ok(m, `no size sentence on the R14 line: ${line}`);
  return m[1];
}

// A tier only pulls the optional steps back when its policy `requires` lists the skeptic
// (size.mjs `requiredSteps`); that is the source of truth for "this size requires the step".
const requiresSkeptic = (tier) => requires(policy, tier).includes("skeptic");

test("fixture anchors: the tier names these cases talk about are the ones policy hands out", () => {
  assert.equal(SMALL, "small", "1 file / 2 lines is the small tier in models.json");
  assert.equal(STANDARD, "standard", "3 files is past small.maxFiles in models.json");
  assert.deepEqual(tierOrder(policy), ["small", "standard", "large"]);
  // {reconcile} is an optional step of the feature playbook — the only reason it can be N/A.
  assert.deepEqual(OPTIONAL_STEPS.feature, ["skeptic", "reconcile"]);
});

// ---------------------------------------------------------------------------
// C1 — reported surface
// ---------------------------------------------------------------------------

test("C1 reported-surface: a hand-written N/A on {reconcile} at an unchanged standard size says the size requires the step, never 'grew from standard to standard'", () => {
  const repo = committed("r14-c1");
  cli(repo, "open", ["unchanged-size", "feature"]);
  cli(repo, "note", ["task", "Two files, standard from the start. [inferred]"]);
  // Two named files: the prediction is standard, so nothing is auto-N/A'd.
  // --files takes one comma-separated value (verbs.mjs `flag`), so both names go in one arg.
  cli(repo, "note", ["plan", "Touch two files.", "--files", "src/a.ts,src/b.ts"]);
  cli(repo, "step", ["reconcile", "na", "x"]);

  const predicted = ledgerOf(repo);
  assert.equal(predicted.tier.predicted, STANDARD);
  assert.deepEqual(predicted.tier.autoNa, [], "a standard prediction marks nothing N/A by itself");
  assert.equal(stepOf(predicted, "reconcile").state, "N/A");
  assert.equal(stepOf(predicted, "reconcile").note, "x", "the N/A is hand-written, not the auto one");

  // One small edit: the measured diff is small, so the effective tier never grew — it was
  // standard when the plan was written and it is standard now.
  write(repo, "src/a.ts", "export const a = 2;\n");

  const out = check(repo);
  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, SMALL, "the measured diff really is the smaller tier");
  assert.equal(stepOf(l, "reconcile").state, null, "the hand-written N/A is reopened");
  assert.deepEqual(l.tier.reopened, ["reconcile"]);

  const line = r14Line(out);
  assert.match(line, /\{reconcile\}/);
  assertSizeShape(line);
  assert.match(line, /requires .*\{reconcile\}/);
  // The size the sentence names must be a size that actually requires the step: per
  // size.mjs `requiredSteps`, the optional steps come back only at a tier whose policy
  // `requires` lists the skeptic. Naming `small` here would make the sentence false —
  // small requires only qa and reviewer.
  assert.ok(
    requiresSkeptic(namedTier(line)),
    `R14 names a size that does not require {reconcile}: ${line}`,
  );
  assert.doesNotMatch(line, new RegExp(`grew from ${STANDARD} to ${STANDARD}`));
  assert.doesNotMatch(line, /grew from standard to standard/);
  // measured ranks *below* predicted here, so nothing grew in either direction
  assert.doesNotMatch(line, /grew from/);

  // And the literal reported surface: the diff catches up with the prediction, so predicted
  // and measured are both standard. Still no growth — the size simply requires the step.
  write(repo, "src/b.ts", "export const b = 1;\n");
  const out2 = check(repo);
  assert.equal(ledgerOf(repo).tier.measured.tier, STANDARD, "predicted and measured now agree");
  const line2 = r14Line(out2);
  assertSizeShape(line2);
  assert.match(line2, /requires .*\{reconcile\}/);
  assert.doesNotMatch(line2, /grew from standard to standard/);
  assert.doesNotMatch(line2, new RegExp(`grew from ${STANDARD} to ${STANDARD}`));
});

// ---------------------------------------------------------------------------
// C2 — happy
// ---------------------------------------------------------------------------

test("C2 happy: a real growth from small to standard still says 'tier grew from small to standard'", () => {
  const repo = committed("r14-c2");
  cli(repo, "open", ["real-growth", "feature"]);
  cli(repo, "note", ["task", "One small change. [inferred]"]);
  cli(repo, "note", ["plan", "Touch one file.", "--files", "src/a.ts"]);

  const predicted = ledgerOf(repo);
  assert.equal(predicted.tier.predicted, SMALL);
  assert.deepEqual([...predicted.tier.autoNa].sort(), ["reconcile", "skeptic"]);
  assert.ok(!check(repo).includes("R14"), "nothing has outgrown its tier yet");

  // Three source files: past small.maxFiles, so the tier really did grow.
  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const out = check(repo);
  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, STANDARD);
  assert.deepEqual([...l.tier.reopened].sort(), ["reconcile", "skeptic"]);

  const line = r14Line(out);
  assert.match(line, new RegExp(`grew from ${SMALL} to ${STANDARD}`));
  assert.match(line, /grew from small to standard/);
  assert.match(line, /\{skeptic\}/);
  assert.match(line, /\{reconcile\}/);
});

// ---------------------------------------------------------------------------
// C3 — boundary
// ---------------------------------------------------------------------------

test("C3 boundary: with no prediction at all the message names the measured size and never says 'unpredicted'", () => {
  const repo = committed("r14-c3");
  cli(repo, "open", ["no-prediction", "feature"]);
  cli(repo, "note", ["task", "Unsized change. [inferred]"]);
  cli(repo, "note", ["plan", "Some files."]); // no --files: nothing is predicted
  cli(repo, "step", ["reconcile", "na", "x"]);

  const predicted = ledgerOf(repo);
  assert.equal(predicted.tier.predicted, null);
  assert.deepEqual(predicted.tier.autoNa, []);
  assert.equal(stepOf(predicted, "reconcile").state, "N/A");

  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const out = check(repo);
  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, STANDARD);
  assert.deepEqual(l.tier.reopened, ["reconcile"]);

  const line = r14Line(out);
  assertSizeShape(line);
  assert.match(
    line,
    new RegExp(`the task's size \\(${STANDARD}, \\d+ files?, \\d+ lines?\\) requires`),
    "the message names the size it measured",
  );
  assert.match(line, /requires .*\{reconcile\}/);
  assert.doesNotMatch(line, /unpredicted/);
  assert.doesNotMatch(line, /null/);
});
