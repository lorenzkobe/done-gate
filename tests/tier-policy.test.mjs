import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";
import { snapshot, diffSnapshots } from "../scripts/lib/tree.mjs";
import { lintClaims } from "../scripts/lib/claims.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { loadPolicy, tierFor } from "../scripts/lib/policy.mjs";
import { measure, OPTIONAL_STEPS, optionalSteps } from "../scripts/lib/size.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/brief-report.test.mjs)
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
const ledgerFile = (repo) => path.join(runDir(repo), "ledger.json");
const ledgerOf = (repo) => JSON.parse(readFileSync(ledgerFile(repo), "utf8"));
const stepOf = (ledger, key) => ledger.steps.find((s) => s.key === key);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so tracked/clean files can be measured by `git diff --numstat`.
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// A tree that is not a git repo at all, and not nested inside one.
function nonGitRepo(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gate-nongit-"));
  const all = {
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ name: "nongit", scripts: { test: "true" } }),
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// The assess-time call shape: baseline is the snapshot taken at `gate open` plus the
// set of paths already dirty against HEAD then.
function measureNow(root, baseline, extra = {}) {
  const now = snapshot(root, baseline);
  return measure({
    config: loadConfig(root),
    policy: loadPolicy(),
    diff: diffSnapshots(baseline, now),
    baseline,
    now,
    root,
    ...extra,
  });
}

const baselineAt = (root, dirty = []) => ({ ...snapshot(root), dirty });
const rowFor = (m, rel) => m.details.find((d) => d.path === rel);

// ---------------------------------------------------------------------------
// source-of-truth anchors: models.json and the spec's own numbers, never the
// implementation's constants.
// ---------------------------------------------------------------------------

const modelsJson = () => JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
const nLines = (s) => s.split("\n").length - 1; // newline count, the unit `git diff --numstat` reports

// ---------------------------------------------------------------------------
// hook events, fed to `gate log` exactly as Claude Code's hooks feed them
// ---------------------------------------------------------------------------

function hook(repo, payload) {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
}

// A Bash PostToolUse payload, shaped like tests/fixtures/stdin/bash.json: attribution
// for a command, never a path.
const commandEvent = (repo, command) =>
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command, description: "edit a file" }, tool_output: "..." });

const reviewerStop = (repo) =>
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "A9", agent_type: "done-gate:reviewer", stop_hook_active: false });

const browserEvent = (repo) =>
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__computer", tool_input: { action: "screenshot" }, tool_output: "..." });

// An edit made by a shell command: the hook fires for the command, then the bytes land.
// No Edit/Write tool event ever exists for the path.
function shellWrite(repo, rel, content) {
  commandEvent(repo, `cat > ${rel} <<'EOF' ...`);
  write(repo, rel, content);
}

function reviewerPass(repo, n) {
  writeFileSync(path.join(runDir(repo), `review-${n}.md`), `# Review ${n}\n\n## Act on\n\n_none_\n`);
  reviewerStop(repo);
  cli(repo, "huddle", ["add", "reviewer", "--file", `review-${n}.md`]);
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 boundary: loadPolicy returns models.json's policy; missing keys fall back to defaults; a parse error falls back entirely without throwing", () => {
  const shipped = modelsJson().policy;
  const p = loadPolicy();
  assert.deepEqual(p.tiers.small, { maxFiles: 1, maxLines: 40, requires: ["qa", "reviewer"] });
  assert.deepEqual(p.tiers.standard, { maxFiles: 10, maxLines: 400, requires: ["skeptic", "qa", "reviewer"] });
  assert.deepEqual(p.tiers.large.requires, ["skeptic", "qa", "reviewer", "reviewer:opus"]);
  assert.deepEqual(p.forceStandard, ["ui", "schema", "highRisk"]);
  assert.equal(p.ceiling.helpersPerTask, 6);
  assert.deepEqual(p.tiers, shipped.tiers, "loadPolicy() must report what models.json actually says");
  assert.deepEqual(p.forceStandard, shipped.forceStandard);

  // loadPolicy takes the path of a models.json FILE. Prove the argument is honoured
  // before leaning on it: a file that says something else must be read, or every
  // fallback assertion below would pass without the file ever being opened.
  const dir = mkdtempSync(path.join(os.tmpdir(), "gate-policy-"));
  const at = (name, body) => {
    const file = path.join(dir, name);
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };
  const loud = modelsJson();
  loud.policy.tiers.small.maxFiles = 999;
  assert.equal(loadPolicy(at("loud.json", loud)).tiers.small.maxFiles, 999, "the file argument is read");

  // A models.json with only `roles`: every policy key falls back.
  const partial = loadPolicy(at("partial.json", { roles: { qa: "opus" } }));
  assert.deepEqual(partial.tiers, p.tiers);
  assert.deepEqual(partial.forceStandard, p.forceStandard);

  // `policy` present but half-filled: the named keys survive, the rest fall back.
  const half = loadPolicy(at("half.json", { roles: {}, policy: { forceStandard: ["ui"] } }));
  assert.deepEqual(half.forceStandard, ["ui"]);
  assert.deepEqual(half.tiers, p.tiers);

  // A models.json that is not JSON: falls back entirely, never throws.
  const broken = loadPolicy(at("broken.json", "{ not json"));
  assert.deepEqual(broken.tiers, p.tiers);
  assert.deepEqual(broken.forceStandard, p.forceStandard);

  // A path that does not exist at all.
  assert.deepEqual(loadPolicy(path.join(dir, "nope.json")).tiers, p.tiers);
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 boundary: tierFor: 1 file and 40 lines is small; 41 lines is standard; 2 files is standard; 11 files or 401 lines is large", () => {
  const p = loadPolicy();
  const at = (files, lines, forced = []) => tierFor(p, { files, lines, forced });

  assert.equal(at(1, 40), "small");
  assert.equal(at(1, 41), "standard");
  assert.equal(at(2, 1), "standard");
  assert.equal(at(10, 400), "standard");
  assert.equal(at(11, 1), "large");
  assert.equal(at(1, 401), "large");
  assert.equal(at(0, 0), "small", "an empty diff is the smallest tier");
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 edge: a ui, schema or highRisk file forces small up to standard (forced lists the category)", () => {
  const gateJson = {
    source: ["src/**", "supabase/**", "tests/**"],
    tests: ["tests/**"],
    ui: ["src/app/**"],
    schema: ["supabase/migrations/**"],
    highRisk: ["src/lib/payments/**"],
  };
  const cases = [
    ["ui", "src/app/page.tsx"],
    ["schema", "supabase/migrations/0001_a.sql"],
    ["highRisk", "src/lib/payments/charge.ts"],
  ];
  for (const [category, rel] of cases) {
    const repo = makeRepo(`tier-c3-${category}`, {
      ".claude/gate.json": JSON.stringify(gateJson),
      [rel]: "one\n",
    });
    const baseline = baselineAt(repo);
    write(repo, rel, "two\n");
    const m = measureNow(repo, baseline);
    assert.equal(m.files, 1, `${category}: one file changed`);
    assert.deepEqual(m.forced, [category]);
    assert.equal(m.tier, "standard", `${category} must raise small to standard`);
  }

  // The same one-line change to a plain source file stays small.
  const plain = makeRepo("tier-c3-plain", { ".claude/gate.json": JSON.stringify(gateJson) });
  const base = baselineAt(plain);
  write(plain, "src/a.ts", "two\n");
  const m = measureNow(plain, base);
  assert.deepEqual(m.forced, []);
  assert.equal(m.tier, "small");
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

test("C4 happy: snapshot entries carry a line count l; a cached entry without l is re-read once and then cached with it", () => {
  const repo = committed("tier-c4", { "src/count.ts": "a\nb\nc\n" });

  const s1 = snapshot(repo);
  assert.equal(s1.files["src/count.ts"].l, 3);

  // Anchored to git's own unit: the initial commit added exactly l lines of this file.
  const numstat = git(repo, ["log", "-1", "--numstat", "--format="])
    .split("\n")
    .map((l) => l.split("\t"))
    .find((c) => c[2] === "src/count.ts");
  assert.equal(Number(numstat[0]), s1.files["src/count.ts"].l);

  // A cached entry that predates `l` is re-read, and only that one.
  const stale = structuredClone(s1);
  delete stale.files["src/count.ts"].l;
  const s2 = snapshot(repo, stale);
  assert.equal(s2.files["src/count.ts"].l, 3);
  assert.equal(s2.rehashed, 1, "only the entry missing l is re-read");

  const s3 = snapshot(repo, s2);
  assert.equal(s3.rehashed, 0, "l is cached after the re-read");
  assert.equal(s3.files["src/count.ts"].l, 3);
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 happy: note plan --files src/a.ts predicts small, marks {skeptic} and {reconcile} N/A with note 'tier small (predicted)', fills autoNa, and prints the predicted tier", () => {
  const repo = committed("tier-c5");
  cli(repo, "open", ["badge", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  const r = cli(repo, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  assert.match(r.stdout, /tier predicted small \(1 file\)/);

  const l = ledgerOf(repo);
  assert.equal(l.tier.predicted, "small");
  assert.deepEqual(l.tier.predictedFiles, ["src/a.ts"]);
  assert.deepEqual([...l.tier.autoNa].sort(), ["reconcile", "skeptic"]);
  assert.deepEqual(l.tier.reopened, []);

  for (const key of ["skeptic", "reconcile"]) {
    assert.equal(stepOf(l, key).state, "N/A", key);
    assert.equal(stepOf(l, key).note, "tier small (predicted)", key);
  }
  assert.equal(stepOf(l, "qa").state, null, "QA is never dropped");
  assert.equal(stepOf(l, "review").state, null, "the reviewer is never dropped");
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 edge: a second note plan --files with two files revises to standard: the auto-N/A steps return to blank and autoNa empties; a hand-written N/A is untouched", () => {
  const repo = committed("tier-c6");
  cli(repo, "open", ["badge", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  cli(repo, "step", ["schema", "na", "no schema files touched"]);

  const first = ledgerOf(repo);
  assert.equal(first.tier.predicted, "small");
  assert.equal(stepOf(first, "skeptic").state, "N/A");

  const r = cli(repo, "note", ["plan", "Two components.", "--files", "src/a.ts,src/b.ts"]);
  assert.match(r.stdout, /tier predicted standard/);

  const l = ledgerOf(repo);
  assert.equal(l.tier.predicted, "standard");
  assert.deepEqual(l.tier.predictedFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(l.tier.autoNa, []);
  assert.equal(stepOf(l, "skeptic").state, null);
  assert.equal(stepOf(l, "reconcile").state, null);
  assert.equal(stepOf(l, "schema").state, "N/A", "a hand-written N/A is not an auto one");
  assert.equal(stepOf(l, "schema").note, "no schema files touched");
});

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

test("C7 boundary: a file dirty at gate open is measured by line-count delta (source delta, estimate) and appears in baseline.dirty", () => {
  const repo = committed("tier-c7", { "src/a.ts": "l1\nl2\nl3\n" });
  write(repo, "src/a.ts", "l1\nl2\nl3\nl4\n"); // dirty before the gate ever opens
  cli(repo, "open", ["dirty", "feature"]);

  assert.ok(ledgerOf(repo).baseline.dirty.includes("src/a.ts"), "recorded as dirty at open");

  const baseline = baselineAt(repo, ledgerOf(repo).baseline.dirty);
  assert.equal(baseline.files["src/a.ts"].l, 4);

  write(repo, "src/a.ts", "l1\nl2\nl3\nl4\nl5\nl6\n"); // 6 lines: 2 more than the baseline
  const m = measureNow(repo, baseline);

  const row = rowFor(m, "src/a.ts");
  assert.equal(row.source, "delta", "a file dirty at open cannot be measured against HEAD");
  assert.equal(row.estimate, true);
  assert.equal(row.lines, 2, "|6 - 4|, not the 3 added lines git diff HEAD would report");
  assert.equal(m.files, 1);
  assert.equal(m.lines, 2);
  assert.equal(m.tier, "small");
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

test("C8 happy: a tracked file clean at open is measured by git numstat (source git); a content edit that keeps the line count counts 2", () => {
  const repo = committed("tier-c8"); // src/a.ts is tracked and clean
  cli(repo, "open", ["clean", "feature"]);
  assert.ok(!ledgerOf(repo).baseline.dirty.includes("src/a.ts"));

  const baseline = baselineAt(repo, ledgerOf(repo).baseline.dirty);
  write(repo, "src/a.ts", "export const a = 2;\n"); // same line count, different content
  const m = measureNow(repo, baseline);

  const row = rowFor(m, "src/a.ts");
  assert.equal(row.source, "git");
  assert.equal(row.estimate, false);
  assert.equal(row.lines, 2, "1 added + 1 deleted; the line-delta fallback would have said 1");
  assert.equal(m.files, 1);
  assert.equal(m.lines, 2);
  assert.equal(m.tier, "small");
});

// ---------------------------------------------------------------------------
// C9
// ---------------------------------------------------------------------------

test("C9 boundary: a non-git repo measures every file by line delta and every row is an estimate", () => {
  const repo = nonGitRepo({
    "src/a.ts": "a\n",
    "src/b.ts": "b1\nb2\nb3\n",
  });
  const baseline = baselineAt(repo, []);
  writeFileSync(path.join(repo, "src/a.ts"), "a\na2\na3\n"); // +2
  writeFileSync(path.join(repo, "src/b.ts"), "b1\n"); // -2
  const m = measureNow(repo, baseline);

  assert.equal(m.files, 2);
  assert.deepEqual(
    m.details.map((d) => [d.path, d.source, d.estimate]).sort(),
    [
      ["src/a.ts", "delta", true],
      ["src/b.ts", "delta", true],
    ],
  );
  assert.equal(rowFor(m, "src/a.ts").lines, 2);
  assert.equal(rowFor(m, "src/b.ts").lines, 2);
  assert.equal(m.lines, 4);
  assert.equal(m.tier, "standard", "2 files is past small regardless of line count");
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

test("C10 refused: growth from small to standard reopens {skeptic} and {reconcile} once, including a hand-written N/A; check prints R14 naming them; a second check leaves ledger.json byte-identical", () => {
  const repo = committed("tier-c10");
  cli(repo, "open", ["grow", "feature"]);
  cli(repo, "note", ["task", "One small change. [inferred]"]);
  cli(repo, "note", ["plan", "Touch one file.", "--files", "src/a.ts"]);
  // {reconcile}'s N/A is now hand-written, not the auto one; it must still be reopened.
  cli(repo, "step", ["reconcile", "na", "nothing to reconcile, tiny change"]);

  const predicted = ledgerOf(repo);
  assert.equal(predicted.tier.predicted, "small");
  assert.equal(stepOf(predicted, "skeptic").state, "N/A");
  assert.equal(stepOf(predicted, "reconcile").note, "nothing to reconcile, tiny change");
  assert.ok(!check(repo).includes("R14"), "nothing has outgrown its tier yet");

  // The task outgrows small: three source files.
  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const out = check(repo);
  const r14 = out.split("\n").filter((l) => l.includes("R14"));
  assert.equal(r14.length, 1, out);
  assert.match(r14[0], /\{skeptic\}/);
  assert.match(r14[0], /\{reconcile\}/);
  assert.match(r14[0], /small/);
  assert.match(r14[0], /standard/);

  const grown = ledgerOf(repo);
  assert.equal(grown.tier.measured.tier, "standard");
  assert.equal(stepOf(grown, "skeptic").state, null, "auto N/A reopened");
  assert.equal(stepOf(grown, "reconcile").state, null, "hand-written N/A reopened too");
  assert.deepEqual([...grown.tier.reopened].sort(), ["reconcile", "skeptic"]);

  // Re-measuring is idempotent: no second reopen, no write.
  const before = readFileSync(ledgerFile(repo));
  const out2 = check(repo);
  const after = readFileSync(ledgerFile(repo));
  assert.ok(before.equals(after), "a second check must not rewrite ledger.json");
  assert.equal(out2.split("\n").filter((l) => l.includes("R14")).length, 1);
  assert.deepEqual([...ledgerOf(repo).tier.reopened].sort(), ["reconcile", "skeptic"]);
});

// ---------------------------------------------------------------------------
// C11
// ---------------------------------------------------------------------------

test("C11 edge: a DONE or WAIVED step is never reopened by further growth", () => {
  const repo = committed("tier-c11");
  cli(repo, "open", ["done-steps", "feature"]);
  cli(repo, "note", ["task", "One small change. [inferred]"]);
  cli(repo, "note", ["plan", "Touch one file.", "--files", "src/a.ts"]);
  cli(repo, "step", ["skeptic", "done", "huddled, no findings", "--evidence", "events#1"]);
  cli(repo, "waive", ["reconcile", "skip the reconcile round, I read the tests myself"]);

  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");
  write(repo, "src/d.ts", "export const d = 1;\n");

  const out = check(repo);
  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, "standard");
  assert.equal(stepOf(l, "skeptic").state, "DONE");
  assert.equal(stepOf(l, "reconcile").state, "WAIVED");
  assert.deepEqual(l.tier.reopened, []);
  assert.ok(!out.includes("R14"), out);
});

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

test("C12 happy: gate size prints the measured and predicted tiers, files and lines, forced categories, required helpers with models, auto-N/A and reopened keys", () => {
  const repo = committed("tier-c12");
  cli(repo, "open", ["sized", "feature"]);
  cli(repo, "note", ["task", "Badge. [inferred]"]);
  cli(repo, "note", ["plan", "One component.", "--files", "src/app/page.tsx"]);
  write(repo, "src/app/page.tsx", "export default () => null; // changed\n");

  const out = cli(repo, "size").stdout;
  assert.match(out, /^tier:/m, "the block starts with a tier: line");
  assert.match(out, /measured/);
  assert.match(out, /standard/, "a ui file forces standard");
  assert.match(out, /predicted/);
  assert.match(out, /\b1 file\b/);
  assert.match(out, /\blines?\b/);
  assert.match(out, /\bui\b/, "the forced category is named");
  assert.match(out, /^.*requires:/m);
  assert.match(out, /auto-N\/A:/);
  assert.match(out, /reopened:/);

  // The models come from models.json's roles, not from a constant in the scripts.
  const roles = modelsJson().roles;
  for (const role of ["skeptic", "qa", "reviewer"]) {
    assert.match(out, new RegExp(`${role}[^\\n]*${roles[role]}`), `${role} → ${roles[role]}`);
  }
});

// ---------------------------------------------------------------------------
// C13
// ---------------------------------------------------------------------------

test("C13 refused: the plan playbook is never tiered: no tier field, note plan --files stores nothing", () => {
  const repo = committed("tier-c13");
  cli(repo, "open", ["spec", "plan"]);
  cli(repo, "note", ["task", "Write the spec. [inferred]"]);
  const r = cli(repo, "note", ["plan", "One document.", "--files", "src/a.ts"]);
  assert.ok(!/tier/i.test(r.stdout), r.stdout);

  const l = ledgerOf(repo);
  assert.ok(l.tier === undefined || l.tier === null, `plan ledgers carry no tier: ${JSON.stringify(l.tier)}`);
  assert.equal(stepOf(l, "skeptic").state, null, "the plan playbook's skeptic is mandatory");
  assert.ok(!check(repo).includes("R14"));
});

// ---------------------------------------------------------------------------
// C14
// ---------------------------------------------------------------------------

test("C14 refused: a source edit made through a shell command after the reviewer huddle makes R5 unmet again; a reviewer pass after that edit clears it (same for R4 with a browser event)", () => {
  // --- R5: a plain source file, edited by a shell command (no Edit/Write tool event) ---
  const r5 = committed("tier-c14-r5");
  cli(r5, "open", ["shell-edit", "feature"]);
  cli(r5, "note", ["task", "Change a. [inferred]"]);
  cli(r5, "note", ["plan", "One file."]);

  shellWrite(r5, "src/a.ts", "export const a = 2;\n");
  // No gate verb runs between the edit and the reviewer: the hash change must date
  // itself to the command event, so the very first pass after it counts.
  reviewerPass(r5, 1);
  assert.ok(!check(r5).includes("R5"), "the first reviewer pass after the shell edit clears R5");

  shellWrite(r5, "src/a.ts", "export const a = 3;\n");
  assert.ok(check(r5).includes("R5"), "a shell-made edit after the huddle makes the review stale");

  reviewerPass(r5, 2);
  assert.ok(!check(r5).includes("R5"), "a reviewer pass after the shell edit clears it again");

  // --- R4: a UI file, same shape, cleared by a browser event ---
  const r4 = committed("tier-c14-r4");
  cli(r4, "open", ["shell-edit-ui", "feature"]);
  cli(r4, "note", ["task", "Change the page. [inferred]"]);
  cli(r4, "note", ["plan", "One component."]);

  shellWrite(r4, "src/app/page.tsx", "export default () => null; // v2\n");
  browserEvent(r4);
  assert.ok(!check(r4).includes("R4"), "the first browser call after the shell edit clears R4");

  shellWrite(r4, "src/app/page.tsx", "export default () => null; // v3\n");
  assert.ok(check(r4).includes("R4"), "a shell-made UI edit makes the driver run stale");

  browserEvent(r4);
  assert.ok(!check(r4).includes("R4"), "a browser call after the shell edit clears it again");
});

// ---------------------------------------------------------------------------
// C15
// ---------------------------------------------------------------------------

test("C15 boundary: the brief for a ledger with an unproven fact passes lintClaims with no findings", () => {
  const repo = committed("tier-c15");
  cli(repo, "open", ["badge", "feature"]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "One component, no data change."]);
  cli(repo, "case", ["add", "renders badge", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:renders the badge"]);
  // rung 2 is below 4, so the gate records this fact as unproven.
  cli(repo, "blast", ["add", "only one consumer", "--rung", "2", "--proof", "src/a.ts:1"]);
  write(repo, "src/a.ts", "export const a = 2;\n");

  const l = ledgerOf(repo);
  assert.equal(l.blast[0].unproven, true, "the fixture must actually carry an unproven fact");

  const text = cli(repo, "report", ["--brief"]).stdout;
  assert.match(text, /only one consumer/, "the brief must still surface the fact");
  assert.deepEqual(lintClaims(text, () => true), []);
});

// ---------------------------------------------------------------------------
// C16
// ---------------------------------------------------------------------------

test("C16 happy: models.json carries the policy object and no escalate/never/ceiling prose keys; roles unchanged", () => {
  const m = modelsJson();

  assert.deepEqual(m.roles, { skeptic: "sonnet", qa: "opus", reviewer: "sonnet", "reviewer-2": "opus" });

  assert.equal(typeof m.policy, "object");
  assert.deepEqual(Object.keys(m.policy).sort(), ["ceiling", "escalate", "forceStandard", "tiers"]);
  assert.deepEqual(Object.keys(m.policy.tiers).sort(), ["large", "small", "standard"]);
  assert.deepEqual(m.policy.tiers.small, { maxFiles: 1, maxLines: 40, requires: ["qa", "reviewer"] });
  assert.deepEqual(m.policy.tiers.standard, { maxFiles: 10, maxLines: 400, requires: ["skeptic", "qa", "reviewer"] });
  assert.deepEqual(m.policy.tiers.large, { requires: ["skeptic", "qa", "reviewer", "reviewer:opus"] });
  assert.deepEqual(m.policy.forceStandard, ["ui", "schema", "highRisk"]);
  assert.deepEqual(m.policy.escalate, { reviewerRound2: { model: "opus", whenActOnAtLeast: 2, orTier: "large" } });
  assert.deepEqual(m.policy.ceiling, { helpersPerTask: 6 });

  for (const key of ["escalate", "never", "ceiling"]) {
    assert.ok(!(key in m), `top-level ${key} prose key is gone`);
  }
});

// ---------------------------------------------------------------------------
// C17
// ---------------------------------------------------------------------------

test("C17 boundary: measure ignores test files and docs when counting files and lines", () => {
  const repo = committed("tier-c17");
  cli(repo, "open", ["ignores", "feature"]);
  const baseline = baselineAt(repo, ledgerOf(repo).baseline.dirty);

  write(repo, "src/a.ts", "export const a = 2;\n"); // source: 1 added + 1 deleted
  write(repo, "tests/a.test.ts", "test('a', () => { expect(1).toBe(1); });\n"); // test
  write(repo, "docs/notes.md", "# notes\n\nmore prose\n"); // doc

  const m = measureNow(repo, baseline);
  assert.deepEqual(m.details.map((d) => d.path), ["src/a.ts"]);
  assert.equal(m.files, 1);
  assert.equal(m.lines, 2);
  assert.equal(m.tier, "small");
  assert.equal(nLines(readFileSync(path.join(repo, "docs/notes.md"), "utf8")), 3, "the doc really did change");
});

// ---------------------------------------------------------------------------
// C18
// ---------------------------------------------------------------------------

test("C18 boundary: a git repo with no commits measures changed files by line delta, never 0 lines", () => {
  const repo = makeRepo("tier-c18"); // git init, nothing committed: HEAD does not exist
  assert.equal(
    spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo, encoding: "utf8" }).status !== 0,
    true,
    "the fixture must have no HEAD",
  );
  const baseline = baselineAt(repo, []);
  write(repo, "src/a.ts", "export const a = 2;\n"); // same line count as before
  write(repo, "src/b.ts", "b1\nb2\nb3\n"); // added, 3 lines
  const m = measureNow(repo, baseline);

  assert.equal(m.files, 2);
  assert.deepEqual([...new Set(m.details.map((d) => d.source))], ["delta"]);
  assert.ok(m.details.every((d) => d.estimate === true), JSON.stringify(m.details));
  assert.equal(rowFor(m, "src/a.ts").lines, 1, "a same-line-count edit still counts as 1, never 0");
  assert.equal(rowFor(m, "src/b.ts").lines, 3);
  assert.ok(m.details.every((d) => d.lines > 0), JSON.stringify(m.details));
  assert.equal(m.lines, 4);
});

// ---------------------------------------------------------------------------
// C19
// ---------------------------------------------------------------------------

test("C19 edge: a waived {skeptic} stays WAIVED when the diff grows and nothing is reopened", () => {
  const repo = committed("tier-c19");
  cli(repo, "open", ["waived", "feature"]);
  cli(repo, "note", ["task", "Small change. [inferred]"]);
  cli(repo, "note", ["plan", "One file.", "--files", "src/a.ts"]);
  cli(repo, "waive", ["skeptic", "skip it"]);
  assert.equal(stepOf(ledgerOf(repo), "skeptic").state, "WAIVED");

  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const out = check(repo);
  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, "standard");
  assert.equal(stepOf(l, "skeptic").state, "WAIVED", "a waiver survives growth");
  assert.ok(!l.tier.reopened.includes("skeptic"), JSON.stringify(l.tier.reopened));
  // {reconcile} was auto-N/A'd by the same small prediction and IS reopened, so R14
  // fires for it alone: the waived step is never named.
  const r14 = out.split("\n").filter((x) => x.includes("R14"));
  assert.equal(r14.length, 1, out);
  assert.match(r14[0], /\{reconcile\}/);
  assert.ok(!r14[0].includes("{skeptic}"), r14[0]);

  // Waive the reopened step too and nothing is left to reopen.
  cli(repo, "waive", ["reconcile", "skip the reconcile round as well"]);
  const out2 = check(repo);
  assert.ok(!out2.includes("R14"), out2);
  assert.equal(stepOf(ledgerOf(repo), "skeptic").state, "WAIVED");
});

// ---------------------------------------------------------------------------
// C20
// ---------------------------------------------------------------------------

test("C20 refused: only the feature playbook auto-N/As at tier small; bugfix and refactor skip nothing", () => {
  // The source of truth for which steps a tier may drop, per playbook.
  assert.deepEqual(Object.keys(OPTIONAL_STEPS).sort(), ["bugfix", "feature", "refactor"]);
  assert.deepEqual(OPTIONAL_STEPS.feature, ["skeptic", "reconcile"]);
  assert.deepEqual(OPTIONAL_STEPS.bugfix, [], "bugfix's {reconcile} is the GREEN proof");
  assert.deepEqual(OPTIONAL_STEPS.refactor, []);
  assert.deepEqual(optionalSteps({ playbook: "bugfix" }), []);
  assert.deepEqual(optionalSteps({ playbook: "feature" }), ["skeptic", "reconcile"]);
  assert.deepEqual(optionalSteps({ playbook: "plan" }), [], "the plan playbook is never tiered");

  for (const playbook of ["bugfix", "refactor"]) {
    const repo = committed(`tier-c20-${playbook}`);
    cli(repo, "open", [`fix-${playbook}`, playbook]);
    cli(repo, "note", ["task", "One small change. [inferred]"]);
    const r = cli(repo, "note", ["plan", "One file.", "--files", "src/a.ts"]);
    assert.match(r.stdout, /tier predicted small \(1 file\)/, playbook);

    const l = ledgerOf(repo);
    assert.equal(l.tier.predicted, "small", playbook);
    assert.deepEqual(l.tier.autoNa, [], `${playbook} drops no step`);
    const reconcile = stepOf(l, "reconcile");
    if (reconcile) assert.equal(reconcile.state, null, `${playbook} {reconcile} stays blank`);
    for (const step of l.steps) {
      assert.notEqual(step.note, "tier small (predicted)", `${playbook}: ${step.key}`);
    }
  }
});

// ---------------------------------------------------------------------------
// C21
// ---------------------------------------------------------------------------

test("C21 edge: after a reviewer huddle, a new test file does not re-block R5; an implementation edit does", () => {
  const repo = committed("tier-c21");
  cli(repo, "open", ["qa-writes-tests", "feature"]);
  cli(repo, "note", ["task", "Change a. [inferred]"]);
  cli(repo, "note", ["plan", "One file."]);
  shellWrite(repo, "src/a.ts", "export const a = 2;\n");
  reviewerPass(repo, 1); // no gate verb between the edit and the reviewer
  assert.ok(!check(repo).includes("R5"), "the first reviewer pass after the edit is fresh");

  shellWrite(repo, "tests/new.test.ts", "test('new', () => {});\n"); // QA writing tests
  assert.ok(!check(repo).includes("R5"), "a test file is not part of the freshness clock");

  shellWrite(repo, "src/a.ts", "export const a = 3;\n"); // implementation edit
  assert.ok(check(repo).includes("R5"), "an implementation edit makes the review stale");
});

// ---------------------------------------------------------------------------
// C22
// ---------------------------------------------------------------------------

test("C22 happy: after a reopen, `gate steps` marks the blank step as reopened", () => {
  const repo = committed("tier-c22");
  cli(repo, "open", ["steps-out", "feature"]);
  cli(repo, "note", ["task", "Small change. [inferred]"]);
  cli(repo, "note", ["plan", "One file.", "--files", "src/a.ts"]);
  assert.ok(!/reopened/.test(cli(repo, "steps").stdout), "nothing reopened yet");

  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");
  check(repo);
  assert.deepEqual([...ledgerOf(repo).tier.reopened].sort(), ["reconcile", "skeptic"]);

  const out = cli(repo, "steps").stdout;
  const reopened = out.split("\n").filter((l) => /reopened/.test(l));
  assert.equal(reopened.length, 2, out);
  assert.ok(reopened.some((l) => l.includes("{skeptic}")), out);
  assert.ok(reopened.some((l) => l.includes("{reconcile}")), out);
  assert.match(reopened[0], /\(reopened: the task outgrew its tier\)/);
});

// ---------------------------------------------------------------------------
// C23
// ---------------------------------------------------------------------------

test("C23 boundary: with no --files the measured diff alone decides: a small edit leaves a hand-written N/A alone; growth reopens it", () => {
  const repo = committed("tier-c23");
  cli(repo, "open", ["no-files", "feature"]);
  cli(repo, "note", ["task", "Small change. [inferred]"]);
  const r = cli(repo, "note", ["plan", "One file."]); // no --files
  assert.ok(!/tier predicted/.test(r.stdout), r.stdout);
  assert.equal(ledgerOf(repo).tier.predicted, null);
  assert.deepEqual(ledgerOf(repo).tier.autoNa, []);
  assert.match(cli(repo, "size").stdout, /predicted: none \(no --files\)/);

  cli(repo, "step", ["skeptic", "na", "small"]);
  write(repo, "src/a.ts", "l1\nl2\nl3\nl4\nl5\n"); // one file, 5 lines: measured small

  const small = check(repo);
  assert.ok(!small.includes("R14"), small);
  assert.equal(ledgerOf(repo).tier.measured.tier, "small");
  assert.equal(stepOf(ledgerOf(repo), "skeptic").state, "N/A");
  assert.deepEqual(ledgerOf(repo).tier.reopened, []);

  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const grown = check(repo);
  assert.ok(grown.includes("R14"), grown);
  assert.match(grown.split("\n").find((l) => l.includes("R14")), /\{skeptic\}/);
  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, "standard");
  assert.equal(stepOf(l, "skeptic").state, null);
  assert.deepEqual(l.tier.reopened, ["skeptic"]);
});

// ---------------------------------------------------------------------------
// C24
// ---------------------------------------------------------------------------

test("C24 boundary: an untracked binary file counts as one file worth 1 line, by delta, with a null line count", () => {
  const repo = committed("tier-c24");
  const baseline = baselineAt(repo, []);

  // ~20 KB of bytes no line counter can split: NUL, high bytes, no newline convention.
  const blob = Buffer.alloc(20 * 1024);
  for (let i = 0; i < blob.length; i++) blob[i] = i % 251;
  blob[0] = 0x00;
  blob[1] = 0x00;
  blob[blob.length - 1] = 0x00;
  assert.ok(blob.includes(0x00), "the fixture must actually contain NUL bytes");
  write(repo, "src/blob.bin", blob);

  const now = snapshot(repo, baseline);
  assert.equal(now.files["src/blob.bin"].l, null, "a binary file has no line count");

  const m = measureNow(repo, baseline);
  const row = rowFor(m, "src/blob.bin");
  assert.equal(m.files, 1);
  assert.equal(row.source, "delta", "untracked, so never measured against HEAD");
  assert.equal(row.estimate, true);
  assert.equal(row.lines, 1, "a null line count floors at 1, never 0 and never NaN");
  assert.equal(m.lines, 1);
  assert.equal(m.tier, "small");
});

// ---------------------------------------------------------------------------
// C25
// ---------------------------------------------------------------------------

test("C25 boundary: gate size still prints the tier block when the ledger's tier record is the legacy bare string", () => {
  const repo = committed("tier-c25");
  cli(repo, "open", ["legacy", "feature"]);
  cli(repo, "note", ["task", "Change a. [inferred]"]);
  cli(repo, "note", ["plan", "One file.", "--files", "src/a.ts"]);
  write(repo, "src/a.ts", "export const a = 2;\n");

  // Damaged through the product's own writer, so the file stays well-formed JSON.
  const dir = runDir(repo);
  const ledger = loadLedger(dir);
  ledger.tier = "standard"; // the legacy shape: a bare string, not { predicted, ... }
  saveLedger(dir, ledger);
  assert.equal(loadLedger(dir).tier, "standard", "the damaged shape really is on disk");

  const r = run(repo, "size");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "", r.stderr);
  assert.ok(r.stdout.startsWith("tier:"), JSON.stringify(r.stdout.slice(0, 120)));
  assert.ok(!/GATE ERROR/.test(r.stdout), r.stdout);

  // And the rest of the gate keeps working on that ledger.
  assert.ok(!/GATE ERROR/.test(check(repo)));
});

// ---------------------------------------------------------------------------
// C26
// ---------------------------------------------------------------------------

test("C26 refused: note plan --files drops a path outside the repo and keeps the rest", () => {
  const repo = committed("tier-c26");
  cli(repo, "open", ["outside", "feature"]);
  cli(repo, "note", ["task", "Change a. [inferred]"]);
  cli(repo, "note", ["plan", "p", "--files", "/etc/hosts,src/a.ts"]);

  const l = ledgerOf(repo);
  assert.deepEqual(l.tier.predictedFiles, ["src/a.ts"]);
  assert.equal(l.tier.predicted, "small", "one file survived, so the prediction is small");
  assert.ok(
    !JSON.stringify(l).includes("/etc/hosts"),
    "no part of the ledger records a path outside the repo",
  );
});

// ---------------------------------------------------------------------------
// C27
// ---------------------------------------------------------------------------

test("C27 refused: an edit made inside a non-gate subagent after the reviewer pass makes R5 unmet again", () => {
  const repo = committed("tier-c27");
  cli(repo, "open", ["subagent-edit", "feature"]);
  cli(repo, "note", ["task", "Change a. [inferred]"]);
  cli(repo, "note", ["plan", "One file."]);

  shellWrite(repo, "src/a.ts", "export const a = 2;\n");
  reviewerPass(repo, 1);
  assert.ok(!check(repo).includes("R5"), "the reviewer pass is fresh");

  // A helper agent edits source behind the reviewer's back: same payload shape as
  // tests/fixtures/stdin/sub-edit.json, but a general-purpose agent, not QA.
  hook(repo, {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    agent_id: "A1",
    agent_type: "general-purpose",
    tool_input: { file_path: path.join(repo, "src", "a.ts") },
    tool_output: "ok",
  });
  write(repo, "src/a.ts", "export const a = 3;\n");

  assert.ok(check(repo).includes("R5"), "a subagent's edit after the huddle makes the review stale");
});

// ---------------------------------------------------------------------------
// C28
// ---------------------------------------------------------------------------

test("C28 boundary: a source change with no event at all is dated now, so it makes R5 unmet again", () => {
  const repo = committed("tier-c28");
  cli(repo, "open", ["no-event", "feature"]);
  cli(repo, "note", ["task", "Change a. [inferred]"]);
  cli(repo, "note", ["plan", "One file."]);

  shellWrite(repo, "src/a.ts", "export const a = 2;\n");
  reviewerPass(repo, 1);
  assert.ok(!check(repo).includes("R5"), "the reviewer pass is fresh");

  // Nothing in this session claims the edit: no Edit event, no Bash command. A watcher,
  // an external process, a `git checkout`. It must not be dated before the reviewer.
  write(repo, "src/a.ts", "export const a = 3;\n");

  assert.ok(check(repo).includes("R5"), "an unattributed source change cannot predate the review");
});

// ---------------------------------------------------------------------------
// C29
// ---------------------------------------------------------------------------

test("C29 edge: a pure rename costs 0 lines on both rows and names the path it came from", () => {
  const repo = committed("tier-c29");
  cli(repo, "open", ["renamed", "feature"]);
  const baseline = baselineAt(repo, ledgerOf(repo).baseline.dirty);

  git(repo, ["mv", "src/a.ts", "src/b.ts"]);
  const m = measureNow(repo, baseline);

  const added = rowFor(m, "src/b.ts");
  const gone = rowFor(m, "src/a.ts");
  assert.ok(added, `no row for src/b.ts: ${JSON.stringify(m.details)}`);
  assert.ok(gone, `no row for src/a.ts: ${JSON.stringify(m.details)}`);
  assert.equal(added.lines, 0, "moving a file writes no lines");
  assert.equal(added.source, "git");
  assert.equal(added.from, "src/a.ts");
  assert.equal(gone.lines, 0);
  assert.equal(m.lines, 0, "a pure rename is worth no lines at all");
});

// ---------------------------------------------------------------------------
// C30
// ---------------------------------------------------------------------------

test("C30 boundary: a non-ASCII path dirty at open is recorded verbatim and measured by delta", () => {
  const rel = "src/café.ts"; // composed e-acute, the form Node writes
  const repo = committed("tier-c30", { [rel]: "l1\nl2\nl3\n" });
  write(repo, rel, "l1\nl2\nl3\nl4\n"); // dirty before the gate opens
  cli(repo, "open", ["accents", "feature"]);

  const dirty = ledgerOf(repo).baseline.dirty;
  assert.ok(
    dirty.includes(rel),
    `baseline.dirty must hold the real path, not a git-quoted one: ${JSON.stringify(dirty)}`,
  );

  const baseline = baselineAt(repo, dirty);
  write(repo, rel, "l1\nl2\nl3\nl4\nl5\nl6\n");
  const m = measureNow(repo, baseline);

  const row = rowFor(m, rel);
  assert.ok(row, `no row for ${rel}: ${JSON.stringify(m.details)}`);
  assert.equal(row.source, "delta", "dirty at open, so never measured against HEAD");
  assert.equal(row.estimate, true);
  assert.equal(row.lines, 2);
});

// ---------------------------------------------------------------------------
// C31
// ---------------------------------------------------------------------------

test("C31 refused: the policy is hashed, and a policy that changed since the ledger opened blocks under R13", () => {
  const real = loadPolicy();
  assert.match(real.hash, /^[0-9a-f]{40}$/);

  // A models.json that says something different must hash differently.
  const tweakedFile = path.join(mkdtempSync(path.join(os.tmpdir(), "gate-policy-hash-")), "models.json");
  const shipped = modelsJson();
  shipped.policy.tiers.small.maxFiles = 999;
  writeFileSync(tweakedFile, JSON.stringify(shipped));
  const tweaked = loadPolicy(tweakedFile);
  assert.equal(tweaked.tiers.small.maxFiles, 999, "the temp copy really is different");
  assert.match(tweaked.hash, /^[0-9a-f]{40}$/);
  assert.notEqual(tweaked.hash, real.hash, "a changed policy must change the hash");
  assert.equal(loadPolicy().hash, real.hash, "and the same policy must hash the same twice");

  // A hand-built state, as tests/rules2.test.mjs builds one: only the policy is stale.
  const root = makeRepo("tier-c31");
  const cfg = loadConfig(root);
  const state = (over = {}) => ({
    root, dir: root, config: cfg, policy: real,
    changed: ["src/a.ts", "tests/a.test.ts"],
    now: { hash: "x", files: {} }, verify: null, events: [], reviews: [], lastMessage: "", ledgerMd: "",
    ledger: {
      status: "open", planSeq: 1, taskSeq: 1, waivers: [], huddles: [], reviews: [],
      cases: [{ id: "C1", status: "closed", test: "t", seq: 2 }], blast: [{ fact: "f", rung: 4 }],
      steps: [{ n: 1, key: "schema", state: "N/A", note: "none" }],
      gateHash: cfg.hash, policyHash: real.hash, baseline: { seq: 0, dirty: [] },
      ...over,
    },
  });

  const fresh = evaluate(state()).filter((u) => u.rule === "R13");
  assert.deepEqual(fresh, [], "a matching policy hash does not block");

  const stale = evaluate(state({ policyHash: "other" })).filter((u) => u.rule === "R13");
  assert.equal(stale.length, 1, JSON.stringify(evaluate(state({ policyHash: "other" }))));
  assert.match(stale[0].text, /models\.json/);
});

// ---------------------------------------------------------------------------
// C32
// ---------------------------------------------------------------------------

test("C32 refused: the log hook stamps the source-change seq for a main-session command and writes no session state; a subagent's command stamps nothing", () => {
  const repo = committed("tier-c32");
  cli(repo, "open", ["stamping", "feature"]);
  cli(repo, "note", ["task", "Change a. [inferred]"]);
  cli(repo, "note", ["plan", "One file."]);

  const stateJson = path.join(stateDir(repo), "sessions", "S1", "state.json");
  const bashPayload = (over = {}) => ({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "printf 'export const a = 2;\\n' > src/a.ts", description: "edit a file" },
    tool_output: "...",
    ...over,
  });

  // --- a main-session Bash call: it stamps, and it touches no session state ---
  const before = readFileSync(stateJson);
  write(repo, "src/a.ts", "export const a = 2;\n");
  hook(repo, bashPayload());

  const commands = () => readEvents(stateDir(repo), "S1").filter((e) => e.kind === "command");
  const stamped = ledgerOf(repo).lastSourceChangeSeq;
  assert.equal(typeof stamped, "number", `the hook must stamp the source change: ${JSON.stringify(stamped)}`);
  assert.ok(
    before.equals(readFileSync(stateJson)),
    "the log hook must not rewrite sessions/S1/state.json",
  );

  // The stamp is anchored to the event that caused it. A placeholder here is not
  // cosmetic: rules date "the last edit" from max(edit event seq, this), so a stamp
  // that is older than every event makes the ledger's half of that clock inert.
  assert.equal(commands().length, 1);
  assert.equal(
    stamped,
    commands()[0].seq,
    "the stamp must carry the command event's own seq, not a value older than every event",
  );

  // --- the same call from inside a subagent: no stamp, the seq stays put ---
  write(repo, "src/a.ts", "export const a = 3;\n");
  hook(repo, bashPayload({ agent_id: "A1", agent_type: "general-purpose" }));

  const both = commands();
  assert.equal(both.length, 2, "the subagent's command is on the log");
  assert.ok(both[1].seq > stamped, "and it is newer than the stamp");
  assert.equal(both[1].agent, "A1");
  assert.equal(
    ledgerOf(repo).lastSourceChangeSeq,
    stamped,
    "a subagent's command does not date the main session's source change",
  );
  assert.ok(before.equals(readFileSync(stateJson)), "still no session state written");
});
