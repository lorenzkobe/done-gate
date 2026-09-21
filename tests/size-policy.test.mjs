import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, here } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";
import { snapshot, diffSnapshots } from "../scripts/lib/tree.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { loadPolicy, tierFor, measure, OPTIONAL_STEPS, optionalSteps } from "../scripts/lib/size.mjs";

// ===== from tests/tier-policy.test.mjs =====
{
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
  assert.equal(p.ceiling.helpersPerTask, 10);
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

test("C5 happy: note plan --files src/a.ts predicts small, marks {skeptic} N/A with note 'tier small (predicted)', fills autoNa, and prints the predicted tier", () => {
  const repo = committed("tier-c5");
  cli(repo, "open", ["badge", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  const r = cli(repo, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  assert.match(r.stdout, /tier predicted small \(1 file\)/);

  const l = ledgerOf(repo);
  assert.equal(l.tier.predicted, "small");
  assert.deepEqual(l.tier.predictedFiles, ["src/a.ts"]);
  assert.deepEqual(l.tier.autoNa, ["skeptic"]);
  assert.equal(stepOf(l, "skeptic").state, "N/A");
  assert.equal(stepOf(l, "skeptic").note, "tier small (predicted)");
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

test("C10 refused: growth from small to standard blanks the auto-N/A {skeptic}; a hand-written N/A on {skeptic} is blanked too; check names it under R8, never R14; a second check leaves ledger.json byte-identical", () => {
  const repo = committed("tier-c10");
  cli(repo, "open", ["grow", "feature"]);
  cli(repo, "note", ["task", "One small change. [inferred]"]);
  cli(repo, "note", ["plan", "Touch one file.", "--files", "src/a.ts"]);
  // {skeptic}'s N/A is now hand-written over the auto one; it must still be blanked on growth.
  cli(repo, "step", ["skeptic", "na", "no design risk, tiny change"]);

  const predicted = ledgerOf(repo);
  assert.equal(predicted.tier.predicted, "small");
  assert.equal(stepOf(predicted, "skeptic").state, "N/A");
  assert.equal(stepOf(predicted, "skeptic").note, "no design risk, tiny change");
  const beforeGrowth = check(repo);
  assert.ok(!/R8 — step\(s\) blank: [^\n]*\{skeptic\}/.test(beforeGrowth), "nothing has outgrown its tier yet");

  // The task outgrows small: three source files.
  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const out = check(repo);
  assert.ok(!out.includes("R14"), out);
  const r8 = out.split("\n").find((l) => l.includes("R8") && l.includes("step(s) blank"));
  assert.ok(r8, out);
  assert.match(r8, /\{skeptic\}/);

  const grown = ledgerOf(repo);
  assert.equal(grown.tier.measured.tier, "standard");
  assert.equal(stepOf(grown, "skeptic").state, null, "hand-written N/A blanked");
  assert.equal("reopened" in grown.tier, false, "no reopened list is kept");

  // Re-measuring is idempotent: no write.
  const before = readFileSync(ledgerFile(repo));
  check(repo);
  const after = readFileSync(ledgerFile(repo));
  assert.ok(before.equals(after), "a second check must not rewrite ledger.json");
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

  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");
  write(repo, "src/d.ts", "export const d = 1;\n");

  const out = check(repo);
  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, "standard");
  assert.equal(stepOf(l, "skeptic").state, "DONE");
  assert.ok(!out.includes("R14"), out);
});

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

test("C12 happy: gate size prints the measured and predicted tiers, files and lines, forced categories, required helpers with models and auto-N/A keys", () => {
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
// C16
// ---------------------------------------------------------------------------

test("C16 happy: models.json carries the policy object and no escalate/never/ceiling prose keys; roles carry the arbiter", () => {
  const m = modelsJson();

  assert.deepEqual(m.roles, { skeptic: "sonnet", qa: "opus", reviewer: "sonnet", "reviewer-2": "opus", arbiter: "opus", worker: "sonnet" });

  assert.equal(typeof m.policy, "object");
  assert.deepEqual(Object.keys(m.policy).sort(), ["ceiling", "delegatesAt", "escalate", "forceStandard", "tiers"]);
  assert.equal(m.policy.delegatesAt, "large");
  assert.deepEqual(Object.keys(m.policy.tiers).sort(), ["large", "small", "standard"]);
  assert.deepEqual(m.policy.tiers.small, { maxFiles: 1, maxLines: 40, requires: ["qa", "reviewer"] });
  assert.deepEqual(m.policy.tiers.standard, { maxFiles: 10, maxLines: 400, requires: ["skeptic", "qa", "reviewer"] });
  assert.deepEqual(m.policy.tiers.large, { requires: ["skeptic", "qa", "reviewer", "reviewer:opus"] });
  assert.deepEqual(m.policy.forceStandard, ["ui", "schema", "highRisk"]);
  assert.deepEqual(m.policy.escalate, { reviewerRound2: { model: "opus", whenActOnAtLeast: 2, orTier: "large" } });
  assert.deepEqual(m.policy.ceiling, { helpersPerTask: 10 });

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

test("C19 edge: a waived {skeptic} stays WAIVED when the diff grows; nothing goes blank", () => {
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
  const r8 = out.split("\n").find((x) => x.includes("R8") && x.includes("step(s) blank"));
  assert.ok(!r8 || !r8.includes("{skeptic}"), r8);
  assert.ok(!out.includes("R14"), out);
});

// ---------------------------------------------------------------------------
// C20
// ---------------------------------------------------------------------------

test("C20 refused: only the feature playbook auto-N/As at tier small; bugfix and refactor skip nothing", () => {
  // The source of truth for which steps a tier may drop, per playbook.
  assert.deepEqual(Object.keys(OPTIONAL_STEPS).sort(), ["bugfix", "feature", "refactor"]);
  assert.deepEqual(OPTIONAL_STEPS.feature, ["skeptic"]);
  assert.deepEqual(OPTIONAL_STEPS.bugfix, []);
  assert.deepEqual(OPTIONAL_STEPS.refactor, []);
  assert.deepEqual(optionalSteps({ playbook: "bugfix" }), []);
  assert.deepEqual(optionalSteps({ playbook: "feature" }), ["skeptic"]);
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

// ---------------------------------------------------------------------------
// C23
// ---------------------------------------------------------------------------

test("C23 boundary: with no --files the measured diff alone decides: a small edit leaves a hand-written N/A alone; growth blanks it", () => {
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

  check(repo);
  assert.equal(ledgerOf(repo).tier.measured.tier, "small");
  assert.equal(stepOf(ledgerOf(repo), "skeptic").state, "N/A");

  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const grown = check(repo);
  assert.ok(!grown.includes("R14"), grown);
  assert.match(grown.split("\n").find((l) => l.includes("R8") && l.includes("step(s) blank")), /\{skeptic\}/);
  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, "standard");
  assert.equal(stepOf(l, "skeptic").state, null);
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
}

// ===== from tests/report-tier.test.mjs =====
{
// ---------------------------------------------------------------------------
// conventions (mirrors tests/tier-policy.test.mjs and tests/brief-report.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1", bin = gate } = {}) {
  return spawnSync(process.execPath, [bin, verb, ...args], {
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

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const closedRunDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).lastClosed);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so tracked/clean files can be measured by `git diff --numstat`.
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// a Stop hook payload, exactly as tests/stop.test.mjs feeds one
function stopHook(repo, message = "report", session = "S1") {
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({
      session_id: session,
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: message,
    }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
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

// the events file itself is the contract; parsed here rather than through the module
// the implementer is editing
function eventsOf(repo, session = "S1") {
  const file = path.join(stateDir(repo), "sessions", session, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .sort((a, b) => a.seq - b.seq);
}

const stdinFixture = (name) =>
  JSON.parse(readFileSync(path.join(here, "fixtures", "stdin", `${name}.json`), "utf8"));

const subagentStop = (repo, agentType, extra = {}) =>
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "A9", agent_type: agentType, stop_hook_active: false, ...extra });

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// Every mutating verb ends with a `next:` hint (tests/next-hints.test.mjs owns that line);
// assertions about a verb's own output ignore it.
const withoutHint = (s) => lines(s).filter((l) => !l.startsWith("next:"));

function sectionOf(md, heading) {
  const m = new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(md);
  return m ? m[1].trim() : null;
}

const tierLines = (md) => {
  const s = sectionOf(md, "Tier");
  return s === null ? null : lines(s);
};

const lineStarting = (text, prefix) => lines(text).find((l) => l.startsWith(prefix));

// ---------------------------------------------------------------------------
// source-of-truth anchors: models.json, never the implementation's constants
// ---------------------------------------------------------------------------

const POLICY = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8")).policy;
const TIER_NAMES = Object.keys(POLICY.tiers); // small, standard, large
const REQUIRES = (tier) => POLICY.tiers[tier].requires;
const ESC = POLICY.escalate.reviewerRound2; // { model, whenActOnAtLeast, orTier }
const LARGE_FILES = POLICY.tiers.standard.maxFiles + 1; // 11: the first file count that is large
const MODEL = "claude-opus-4";

const SIZE_RE = new RegExp(`^Size: (${TIER_NAMES.join("|")}) \\(\\d+ files?, \\d+ lines?\\)\\.$`);

// words that belong to the ledger's own vocabulary and must never reach the brief
const INTERNAL_WORDS = ["tier", "auto-N/A", "predicted", "requires"];

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function openTiered(repo, { slug = "sized", playbook = "feature", files = null } = {}) {
  cli(repo, "open", [slug, playbook]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "One component, no data change.", ...(files ? ["--files", files] : [])]);
}

// predicted small (one file named in the plan), measured standard (three source files,
// one of them a .tsx, which forces the ui category) → auto-N/A keys and reopened keys.
function standardTier(name) {
  const repo = committed(name);
  openTiered(repo, { files: "src/a.ts" });
  write(repo, "src/a.ts", "export const a = 2;\nexport const b = 3;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/app/page.tsx", "export default () => null; // changed\n");
  return repo;
}

// 11 changed source files: one past standard.maxFiles, so the effective tier is large.
function largeTier(name) {
  const repo = committed(name);
  openTiered(repo);
  for (let i = 0; i < LARGE_FILES; i++) write(repo, `src/big/f${i}.ts`, `export const f${i} = ${i};\n`);
  return repo;
}

// A feature ledger the gate agrees is clean: nothing under source touched, every step
// closed, `gate close` run. The Stop hook then finalises it (tests/stop.test.mjs).
function closedTieredFixture(name, slug = "shipped") {
  const repo = committed(name);
  openTiered(repo, { slug, files: "src/a.ts,src/b.ts" });
  cli(repo, "case", ["add", "shows the size", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:shows the size"]);
  // DONE, not N/A: an optional step left N/A is reopened the moment the tier is reconciled
  const steps = loadLedger(runDir(repo)).steps;
  for (const s of steps) if (!s.state) cli(repo, "step", [String(s.n), "done", "nothing changed under source", "--evidence", "events#1"]);
  cli(repo, "close");
  return repo;
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 happy: subagent start and stop events carry the payload's model, and omit the key when the payload has none", () => {
  const repo = makeRepo("report-tier-c1");
  const start = stdinFixture("subagent-start");
  const stop = stdinFixture("subagent-stop");
  assert.equal(start.hook_event_name, "SubagentStart", "fixture anchor: tests/fixtures/stdin/subagent-start.json");
  assert.equal(stop.hook_event_name, "SubagentStop", "fixture anchor: tests/fixtures/stdin/subagent-stop.json");

  hook(repo, { ...start, cwd: repo, model: MODEL });
  hook(repo, { ...stop, cwd: repo, model: MODEL });
  hook(repo, { ...start, cwd: repo });
  hook(repo, { ...stop, cwd: repo });

  const evs = eventsOf(repo);
  assert.deepEqual(
    evs.map((e) => e.kind),
    ["subagent-start", "subagent-stop", "subagent-start", "subagent-stop"],
  );
  assert.equal(evs[0].model, MODEL, `SubagentStart dropped the model: ${JSON.stringify(evs[0])}`);
  assert.equal(evs[1].model, MODEL, `SubagentStop dropped the model: ${JSON.stringify(evs[1])}`);
  assert.ok(!("model" in evs[2]), `a payload with no model must leave the key off: ${JSON.stringify(evs[2])}`);
  assert.ok(!("model" in evs[3]), `a payload with no model must leave the key off: ${JSON.stringify(evs[3])}`);

  // the rest of the record is untouched
  assert.equal(evs[1].agent, stop.agent_id);
  assert.equal(evs[1].agentType, stop.agent_type);
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 happy: the full report's Tier block carries the predicted and measured tier, the forced category, and the auto-N/A keys", () => {
  const repo = standardTier("report-tier-c2");
  const report = cli(repo, "report").stdout;

  const block = tierLines(report);
  assert.ok(block, `no "## Tier" section in the full report:\n${report}`);
  assert.ok(block[0].startsWith("tier:"), `the Tier section must open with the tier line:\n${block.join("\n")}`);

  // the first three lines are the block `gate size` prints (minus its files detail line)
  const size = withoutHint(cli(repo, "size").stdout).filter((l) => !l.startsWith("files:"));
  assert.deepEqual(block.slice(0, size.length), size, "the report's Tier block disagrees with `gate size`");

  assert.ok(block[0].includes("predicted small (1 file)"), block[0]);
  assert.match(block[0], /measured standard: 3 files, \d+ lines/, block[0]);
  assert.ok(block[0].includes("forced: ui"), `a .tsx file forces the ui category:\n${block[0]}`);
  assert.ok(block[0].startsWith("tier: standard"), `small predicted + standard measured is standard:\n${block[0]}`);

  const keys = block.find((l) => l.startsWith("auto-N/A:"));
  assert.ok(keys, `no auto-N/A line:\n${block.join("\n")}`);
  assert.ok(keys.includes("auto-N/A: {skeptic}"), keys);
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 happy: the Tier block counts helpers spawned against the required list, from subagent-stop events by role", () => {
  const repo = standardTier("report-tier-c3");
  const required = REQUIRES("standard");

  const none = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.ok(none, "no helpers line in the Tier block");
  assert.match(none, /^helpers: spawned 0 of\b/, none);
  for (const role of required) assert.ok(none.includes(role), `${role} is required for standard but is not named: ${none}`);

  subagentStop(repo, "done-gate:qa");
  subagentStop(repo, "reviewer"); // isRole accepts the bare role too
  subagentStop(repo, "general-purpose"); // not a gate helper: never counted

  const some = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.match(some, /^helpers: spawned 2 of\b/, some);
  for (const role of required) assert.ok(some.includes(role), `${role} missing from: ${some}`);
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

test("C4 edge: the round 2 model line is required by Act-on count or by a large tier, and names the recorded model", () => {
  const round2 = (repo) => lineStarting(cli(repo, "report").stdout, "round 2 model:");

  // one Act-on item, standard tier → below the threshold
  const one = standardTier("report-tier-c4-one");
  writeFileSync(path.join(runDir(one), "review-1.md"), "# Review 1\n\n## Act on\n- null venue crashes\n");
  cli(one, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(one, "huddle", ["acton", "H1", "null venue crashes"]);
  assert.equal(round2(one), "round 2 model: not required");

  // the threshold from models.json, with nothing recorded
  const many = standardTier("report-tier-c4-many");
  writeFileSync(path.join(runDir(many), "review-1.md"), "# Review 1\n\n## Act on\n- one\n- two\n");
  cli(many, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  for (let i = 0; i < ESC.whenActOnAtLeast; i++) cli(many, "huddle", ["acton", "H1", `finding ${i}`]);
  assert.equal(round2(many), `round 2 model: ${ESC.model} required, recorded: unrecorded`);

  // the second reviewer ran and the harness said on which model
  subagentStop(many, "done-gate:reviewer");
  subagentStop(many, "done-gate:reviewer", { model: MODEL });
  assert.equal(round2(many), `round 2 model: ${ESC.model} required, recorded: ${MODEL}`);

  // tier large on its own is enough, with no Act-on items at all
  const big = largeTier("report-tier-c4-large");
  assert.equal(ESC.orTier, "large", "anchor: models.json escalate.reviewerRound2.orTier");
  assert.equal(round2(big), `round 2 model: ${ESC.model} required, recorded: unrecorded`);
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 refused: the brief's Changed line carries the plain size word and none of the ledger's own words", () => {
  const repo = standardTier("report-tier-c5");
  const brief = cli(repo, "report", ["--brief"]).stdout;
  const all = lines(brief);

  assert.equal(all.filter((l) => l.startsWith("Size:")).length, 0, `the brief has no separate Size line any more:\n${brief}`);
  const changed = all.find((l) => l.startsWith("Changed"));
  assert.ok(changed, `no Changed line in the brief:\n${brief}`);
  for (const word of INTERNAL_WORDS) {
    assert.ok(!changed.toLowerCase().includes(word.toLowerCase()), `"${word}" leaked into the brief: ${changed}`);
  }

  // the size word is the effective tier
  const tierLine = lines(cli(repo, "size").stdout)[0];
  const effective = /^tier: (\S+)/.exec(tierLine)[1];
  assert.ok(changed.includes(`size ${effective}`), `expected "size ${effective}" in: ${changed}`);
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 boundary: a closed ledger's report still shows the Tier block from the tier persisted at close", () => {
  const repo = closedTieredFixture("report-tier-c6");
  stopHook(repo); // the Stop hook finalises a clean, closing run
  assert.equal(loadSession(stateDir(repo), "S1").current, null, "no run is open any more");
  assert.ok(loadLedger(closedRunDir(repo)).tier, "the tier was not persisted at finalise");

  const report = cli(repo, "report").stdout;
  const block = tierLines(report);
  assert.ok(block, `a closed run's report lost the Tier section:\n${report}`);
  assert.equal(block[0], "tier: standard · predicted standard (2 files) · measured small: 0 files, 0 lines");
});

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

test("C7 boundary: an untiered playbook prints no Tier block and no Size line", () => {
  const repo = committed("report-tier-c7");
  cli(repo, "open", ["notes", "plan"]);
  cli(repo, "note", ["task", "Write the spec. [inferred]"]);
  cli(repo, "note", ["plan", "One document."]);
  write(repo, "src/a.ts", "export const a = 2;\n");

  const report = cli(repo, "report").stdout;
  assert.equal(tierLines(report), null, `the plan playbook is not tiered:\n${report}`);

  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.equal(lines(brief).filter((l) => l.startsWith("Size:")).length, 0, `no size is known for an untiered run:\n${brief}`);
});

// ---------------------------------------------------------------------------
// C9
// ---------------------------------------------------------------------------

test("C9 edge: at tier large the helpers line counts all four required helpers, the second reviewer standing for reviewer:opus", () => {
  const repo = largeTier("report-tier-c9");
  const required = REQUIRES("large");
  assert.equal(required.length, 4, "anchor: models.json tiers.large.requires");
  assert.ok(required.includes("reviewer:opus"), "anchor: models.json tiers.large.requires");

  subagentStop(repo, "done-gate:skeptic");
  subagentStop(repo, "done-gate:qa");
  subagentStop(repo, "done-gate:reviewer");

  const three = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.match(three, /^helpers: spawned 3 of 4\b/, three);

  subagentStop(repo, "done-gate:reviewer", { model: MODEL }); // the round-2 reviewer

  const four = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.match(four, /^helpers: spawned 4 of 4 required\b/, four);
  for (const entry of required) {
    assert.match(four, new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^,]*✓`), `${entry} is not ticked: ${four}`);
  }
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

test("C10 boundary: a closed ledger with no tier field at all reports a Tier block that says the size was never measured", () => {
  const repo = closedTieredFixture("report-tier-c10", "untiered-close");
  stopHook(repo);
  const dir = closedRunDir(repo);

  // an older ledger, written before tiers existed: no tier key at all
  const ledger = loadLedger(dir);
  delete ledger.tier;
  saveLedger(dir, ledger);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8")).tier, undefined);

  const r = run(repo, "report");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const block = tierLines(r.stdout);
  assert.ok(block, `a tier-less closed ledger still gets a Tier section:\n${r.stdout}`);
  assert.ok(block[0].includes("measured: not yet"), block[0]);

  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.equal(lines(brief).filter((l) => l.startsWith("Size:")).length, 0, `nothing was measured, so no Size line:\n${brief}`);
});

// ---------------------------------------------------------------------------
// C11
// ---------------------------------------------------------------------------

test("C11 edge: a reviewer-2 stop satisfies reviewer:opus and records the round 2 model", () => {
  const repo = largeTier("report-tier-c11");
  const required = REQUIRES("large");
  assert.ok(required.includes("reviewer:opus"), "anchor: models.json tiers.large.requires");

  subagentStop(repo, "done-gate:skeptic");
  subagentStop(repo, "done-gate:qa");
  subagentStop(repo, "done-gate:reviewer");
  subagentStop(repo, "done-gate:reviewer-2", { model: MODEL });

  const report = cli(repo, "report").stdout;

  const helpers = lineStarting(report, "helpers:");
  assert.match(helpers, /^helpers: spawned 4 of 4 required\b/, helpers);
  for (const entry of required) {
    assert.match(helpers, new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^,]*✓`), `${entry} is not ticked: ${helpers}`);
  }

  assert.equal(lineStarting(report, "round 2 model:"), `round 2 model: ${ESC.model} required, recorded: ${MODEL}`);
});
}

// ===== from tests/size-policy.test.mjs =====
{
// T2 — R14 (tier outgrown) and the blast-radius feature are gone; `gate note attention`
// and the Attention prose go with them. R8 keeps exactly two clauses: blank steps and
// open cases. Growth from small to standard still blanks {skeptic}; R8, not R14, names it.
//
// Written from the requirements and the case table, blind to the implementation.
//
// Sources of truth for the literals below:
//   - step keys ({skeptic}, {reconcile}, {read}, …): skills/gate/playbooks/*.md, the files
//     scripts/lib/ledger.mjs parses into ledger.steps — never the rule's own constants.
//   - the refusal shape (`done-gate: ` on stderr, exit 0): tests/smoke.test.mjs and
//     tests/waivers.test.mjs; scripts/gate.mjs always sets process.exitCode = 0.
//   - the `gate note` sections that survive: the task's requirements (task and plan).
//   - the run dir / ledger.json layout: scripts/lib/session-state.mjs.
//   - the old ledger shape hand-written in C3: a run opened by this CLI, plus the two
//     fields the previous version carried (`blast`, `tier.reopened`) and a {blast} step,
//     rewritten the way tests/waivers.test.mjs C4 rewrites a carried-over waiver.

// ---------------------------------------------------------------------------
// conventions (mirrors tests/rules.test.mjs, tests/waivers.test.mjs and
// tests/tier-policy.test.mjs)
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
  return r;
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}

function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.match(
    r.stderr,
    REFUSAL,
    `expected \`gate ${verb} ${args.join(" ")}\` to be refused, got:\n${r.stdout}${r.stderr}`,
  );
  return r;
}

// `check` exits 0 whether or not rules are unmet; only a crash is a failure here.
function check(repo) {
  const r = run(repo, "check");
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r.stdout;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const closedRunDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).lastClosed);
const ledgerFileOf = (dir) => path.join(dir, "ledger.json");
const ledgerOf = (repo) => JSON.parse(readFileSync(ledgerFileOf(runDir(repo)), "utf8"));
const writeLedger = (repo, ledger) =>
  writeFileSync(ledgerFileOf(runDir(repo)), `${JSON.stringify(ledger, null, 2)}\n`);
const stepOf = (ledger, key) => ledger.steps.find((s) => s.key === key);

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// `gate check` prints one "<n>. <rule> — <text>" line per unmet rule, or "clean".
const ruleLines = (out, rule) => lines(out).filter((l) => new RegExp(`\\b${rule}\\b`).test(l));

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so tracked/clean files can be measured by `git diff --numstat`
// (tests/tier-policy.test.mjs owns this helper).
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// A Stop hook payload, exactly as tests/stop.test.mjs feeds one.
function stopHook(repo, message = "report", session = "S1") {
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({
      session_id: session,
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: message,
    }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

const headings = (md) =>
  md.split("\n").flatMap((l) => {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    return m ? [m[1]] : [];
  });

// The vocabulary this task deletes. "side effect(s)" was the plain-language stand-in the
// brief printed for "blast radius"; with the feature gone neither word may appear.
const GONE_WORDS = [
  [/\bblast\b/i, "blast"],
  [/\brungs?\b/i, "rung"],
  [/\bside[- ]effects?\b/i, "side effect"],
];

// ---------------------------------------------------------------------------
// C1 refused — the verb and the note section are both gone
// ---------------------------------------------------------------------------

test("C1 refused: `gate blast` is an unknown verb and `gate note attention` is refused with the usage line", () => {
  const repo = makeRepo("size-policy-c1");
  cli(repo, "open", ["gone", "feature"]);
  cli(repo, "note", ["task", "Remove a feature. [inferred]"]);
  cli(repo, "note", ["plan", "Touch a few modules."]);

  // `gate blast add …` is no longer a verb: stderr says so, stdout stays empty, exit 0.
  const blast = run(repo, "blast", ["add", "only one consumer", "--rung", "2", "--proof", "src/a.ts:1"]);
  assert.match(blast.stderr, /unknown verb/, `\`gate blast\` still runs:\n${blast.stdout}${blast.stderr}`);
  assert.equal(blast.stdout.trim(), "", `\`gate blast\` wrote to stdout:\n${blast.stdout}`);

  // Nothing was recorded, and no step was marked by it.
  const afterBlast = ledgerOf(repo);
  assert.deepEqual(afterBlast.blast ?? [], [], "an unknown verb still appended a blast row");
  assert.equal(
    afterBlast.steps.find((s) => s.key === "blast"),
    undefined,
    "the playbook still carries a {blast} step",
  );

  // `gate note attention "…"` is refused, and the usage line names only the sections left.
  const note = refused(repo, "note", ["attention", "look at the null venue path first"]);
  const usage = lines(note.stderr).find((l) => /usage/i.test(l));
  assert.ok(usage, `the refusal carries no usage line:\n${note.stderr}`);
  assert.ok(usage.includes("task"), `the usage line does not offer \`task\`: ${usage}`);
  assert.ok(usage.includes("plan"), `the usage line does not offer \`plan\`: ${usage}`);
  assert.ok(!/attention/i.test(usage), `the usage line still offers \`attention\`: ${usage}`);

  // The refused note wrote nothing: ledger.md keeps Task and Plan and gains no section.
  const md = readFileSync(path.join(runDir(repo), "ledger.md"), "utf8");
  assert.ok(!/^##\s*Attention/im.test(md), `ledger.md grew an Attention section:\n${md}`);
  assert.deepEqual(headings(md), ["Task", "Plan"], `ledger.md sections changed:\n${md}`);

  // The surviving sections still work.
  cli(repo, "note", ["task", "Remove a feature, for real. [inferred]"]);
});

// ---------------------------------------------------------------------------
// C2 happy — growth still blanks {skeptic}; R8 names it, R14 is nowhere
// ---------------------------------------------------------------------------

test("C2 happy: growth from small to standard blanks {skeptic} and `gate check` names it under R8, never R14", () => {
  const repo = committed("size-policy-c2");
  cli(repo, "open", ["grow", "feature"]);
  cli(repo, "note", ["task", "One small change. [inferred]"]);
  cli(repo, "note", ["plan", "Touch one file.", "--files", "src/a.ts"]);

  // A one-file prediction is small, so the optional {skeptic} is auto-N/A'd: R8's blank-step
  // line must not name it yet.
  const predicted = ledgerOf(repo);
  assert.equal(predicted.tier.predicted, "small");
  assert.equal(stepOf(predicted, "skeptic").state, "N/A", "{skeptic} was not auto-N/A'd at small");

  const small = check(repo);
  assert.deepEqual(ruleLines(small, "R14"), [], `R14 still exists:\n${small}`);
  const smallR8 = ruleLines(small, "R8").join("\n");
  assert.ok(!smallR8.includes("{skeptic}"), `R8 names an N/A step:\n${smallR8}`);

  // Three source files: the measured diff outgrows small.
  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const grown = check(repo);
  assert.deepEqual(ruleLines(grown, "R14"), [], `R14 fired on growth:\n${grown}`);

  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, "standard", "the measured tier did not grow");
  assert.equal(stepOf(l, "skeptic").state, null, "{skeptic} was not blanked by the growth");

  // R8 is now the rule that names it, as a blank step.
  const grownR8 = ruleLines(grown, "R8");
  const named = grownR8.find((line) => line.includes("{skeptic}"));
  assert.ok(named, `no R8 line names {skeptic} after the growth:\n${grown}`);
  assert.ok(/blank/i.test(named), `the R8 line does not say the step is blank: ${named}`);

  // The reopened bookkeeping is gone with R14: no ledger field, no marker on `gate steps`,
  // no line in the tier block.
  assert.ok(
    !("reopened" in (l.tier ?? {})),
    `ledger.tier still carries a reopened list: ${JSON.stringify(l.tier?.reopened)}`,
  );
  const steps = cli(repo, "steps").stdout;
  assert.ok(!/reopened/i.test(steps), `\`gate steps\` still marks a reopened step:\n${steps}`);
  const size = cli(repo, "size").stdout;
  assert.ok(!/reopened/i.test(size), `\`gate size\` still prints a reopened line:\n${size}`);

  // Closing the blanked step clears it from R8 again.
  cli(repo, "step", ["skeptic", "done", "huddled, two findings answered", "--evidence", "events#1"]);
  const after = check(repo);
  assert.ok(
    !ruleLines(after, "R8").join("\n").includes("{skeptic}"),
    `R8 still names a closed {skeptic}:\n${after}`,
  );
  assert.deepEqual(ruleLines(after, "R14"), [], after);
});

// ---------------------------------------------------------------------------
// C3 boundary — an old ledger.json, written before this change, still works
// ---------------------------------------------------------------------------

// The step line the old feature playbook produced, verbatim: carried-over data, echoed by
// the report rather than rewritten.
const OLD_BLAST_STEP_TEXT = "Blast radius (`gate blast add`): the fact the change is safe because of.";

test("C3 boundary: an old ledger.json carrying blast rows, a {blast} step and tier.reopened still loads, reports and closes", () => {
  const repo = committed("size-policy-c3");
  cli(repo, "open", ["carried", "feature"]);
  cli(repo, "note", ["task", "An old run, resumed. [inferred]"]);
  cli(repo, "note", ["plan", "One file.", "--files", "src/a.ts"]);

  // Rewrite the ledger in the shape the previous version stored: blast rows (one of them
  // with no rung at all, which R8 used to block on), a {blast} playbook step, and a
  // tier.reopened list naming a step that is blank again (what R14 used to fire on).
  const old = ledgerOf(repo);
  const lastStep = old.steps[old.steps.length - 1];
  old.blast = [
    { fact: "CourtCard is the only consumer", rung: 4, unproven: false, proof: "tests/a.test.ts", seq: 11 },
    { fact: "the sitemap does not read the badge", rung: null, unproven: true, proof: null, seq: 12 },
  ];
  old.steps = [
    ...old.steps,
    {
      n: lastStep.n + 1,
      key: "blast",
      text: OLD_BLAST_STEP_TEXT,
      state: "DONE",
      note: "two facts recorded",
      evidence: "ledger.json#blast",
      seq: 13,
    },
  ];
  stepOf(old, "skeptic").state = null; // reopened by the old R14 plumbing
  old.tier = { ...old.tier, reopened: ["skeptic"] };
  writeLedger(repo, old);

  // It loads: `gate check` runs clean of crashes, says nothing about R14 or rungs, and the
  // rung-less row raises nothing.
  const out = check(repo);
  assert.deepEqual(ruleLines(out, "R14"), [], `R14 fired on a carried-over ledger:\n${out}`);
  for (const [re, what] of GONE_WORDS) {
    const hit = lines(out).find((l) => re.test(l));
    assert.equal(hit, undefined, `\`gate check\` still talks about ${what}: ${JSON.stringify(hit)}`);
  }
  // The blank {skeptic} is still named, by R8 and nothing else.
  const named = ruleLines(out, "R8").find((l) => l.includes("{skeptic}"));
  assert.ok(named, `R8 does not name the blank {skeptic} of an old ledger:\n${out}`);

  // The old {blast} step survives untouched: an unknown key is data, not a crash.
  assert.equal(stepOf(ledgerOf(repo), "blast").state, "DONE", "the carried-over {blast} step was rewritten");

  // It reports: the full report renders with no Blast section and no rung wording.
  const report = cli(repo, "report");
  const reportMd = readFileSync(path.join(runDir(repo), "report.md"), "utf8");
  for (const md of [report.stdout, reportMd]) {
    assert.ok(headings(md).length > 0, `the report rendered no sections:\n${md}`);
    const bad = headings(md).find((h) => /blast/i.test(h));
    assert.equal(bad, undefined, `the report still has a Blast section: ${JSON.stringify(bad)}`);

    // The carried-over step is data, so its own text (which names the old verb) is echoed
    // under Steps. Every other trace of the feature is gone: no fact rows, no rungs.
    const carried = lines(md).filter((l) => l.includes(OLD_BLAST_STEP_TEXT));
    assert.equal(carried.length, 1, `the carried-over {blast} step was dropped from the report:\n${md}`);
    const rest = lines(md).filter((l) => !l.includes(OLD_BLAST_STEP_TEXT));
    for (const [re, what] of GONE_WORDS) {
      const hit = rest.find((l) => re.test(l));
      assert.equal(hit, undefined, `the report still mentions ${what}: ${JSON.stringify(hit)}`);
    }
    for (const fact of ["CourtCard is the only consumer", "the sitemap does not read the badge"]) {
      assert.ok(!md.includes(fact), `the report still renders a blast-radius fact: ${fact}`);
    }
  }

  // And it closes.
  for (const s of ledgerOf(repo).steps) {
    if (!s.state && s.key !== "close") cli(repo, "step", [String(s.n), "na", "carried-over run, nothing to do"]);
  }
  const closed = cli(repo, "close");
  assert.equal(ledgerOf(repo).status, "closing", `\`gate close\` did not close an old ledger:\n${closed.stdout}`);
});

// ---------------------------------------------------------------------------
// C4 happy — the brief and the full report for a closed run
// ---------------------------------------------------------------------------

// The clean-closing fixture tests/brief-report.test.mjs uses: the plan playbook, every
// step closed, no source touched, `gate close` run.
function cleanClosingFixture(name, slug = "tidy") {
  const repo = makeRepo(name);
  cli(repo, "open", [slug, "plan"]);
  cli(repo, "note", ["task", "Write the spec. [inferred]"]);
  cli(repo, "note", ["plan", "One document."]);
  cli(repo, "case", ["add", "spec covers the refused side", "--kind", "refused"]);
  cli(repo, "case", ["add", "spec covers the happy path", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:refused"]);
  cli(repo, "case", ["close", "C2", "--test", "tests/a.test.ts:happy"]);
  cli(repo, "step", ["read", "done", "read it", "--evidence", "events#1"]);
  cli(repo, "step", ["skeptic", "done", "no findings", "--evidence", "events#2"]);
  cli(repo, "step", ["implement", "done", "spec written", "--evidence", "docs/notes.md"]);
  cli(repo, "close");
  return repo;
}

test("C4 happy: `gate report --brief` for a closed run has no Blast section, no attention prose and no rung or side-effect wording", () => {
  const repo = cleanClosingFixture("size-policy-c4", "shipped");
  stopHook(repo); // the Stop hook finalises a clean, closing run
  assert.equal(loadSession(stateDir(repo), "S1").current, null, "no run is open any more");

  const dir = closedRunDir(repo);
  const out = cli(repo, "report", ["--brief"]).stdout;

  // The brief still says something about the run it closed.
  assert.ok(lines(out).length >= 2, `the brief is empty:\n${out}`);
  assert.ok(out.includes("shipped") || /case/i.test(out), `the brief does not describe the run:\n${out}`);

  for (const [re, what] of [...GONE_WORDS, [/\battention\b/i, "attention"]]) {
    const hit = lines(out).find((l) => re.test(l));
    assert.equal(hit, undefined, `the brief still mentions ${what}: ${JSON.stringify(hit)}`);
  }

  // The full report written alongside it has neither section.
  const file = path.join(dir, "report.md");
  assert.ok(existsSync(file), `report.md was not written to the closed run dir: ${file}`);
  const md = readFileSync(file, "utf8");
  const hs = headings(md);
  assert.ok(hs.includes("Steps"), `report.md is not the full report (sections: ${hs.join(", ")})`);
  assert.equal(hs.find((h) => /blast/i.test(h)), undefined, `report.md still has a Blast section: ${hs.join(", ")}`);
  // The report keeps its Attention section (waivers, skips, unmet rules), but nothing in it
  // is free prose from ledger.md any more: every line is a bullet or the empty marker.
  const attention = md.split(/^## Attention\n/m)[1]?.split(/^## /m)[0] ?? "";
  for (const l of lines(attention)) {
    assert.ok(/^- /.test(l) || l === "_nothing flagged_", `free prose in report.md's Attention section: ${JSON.stringify(l)}`);
  }
  for (const [re, what] of GONE_WORDS) {
    const hit = lines(md).find((l) => re.test(l));
    assert.equal(hit, undefined, `report.md still mentions ${what}: ${JSON.stringify(hit)}`);
  }
});

// ---------------------------------------------------------------------------
// C5 edge — the reviewer packet
// ---------------------------------------------------------------------------

test("C5 edge: the reviewer brief packet has no Blast radius section", () => {
  const repo = committed("size-policy-c5", { "src/lib/x.ts": "export const x = 1;\n" });
  cli(repo, "open", ["packet", "feature"]);
  cli(repo, "note", ["task", "Give the reviewer a packet. [inferred]"]);
  cli(repo, "note", ["plan", "Touch one module.", "--files", "src/lib/x.ts"]);
  cli(repo, "case", ["add", "renders the packet", "--kind", "happy"]);
  write(repo, "src/lib/x.ts", "export const x = 2;\n");

  const r = cli(repo, "brief", ["reviewer"]);
  const packetPath = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(packetPath, `no "packet: <path>" line in:\n${r.stdout}`);
  const text = readFileSync(packetPath, "utf8");

  const hs = headings(text);
  // Not vacuous: the reviewer packet still carries the sections either side of the old one.
  assert.ok(hs.includes("Diff"), `the reviewer packet has no Diff section (sections: ${hs.join(", ")})`);
  assert.ok(hs.includes("Verify"), `the reviewer packet has no Verify section (sections: ${hs.join(", ")})`);
  assert.ok(
    hs.some((h) => /write your findings/i.test(h)),
    `the reviewer packet does not say where to write findings (sections: ${hs.join(", ")})`,
  );

  assert.equal(hs.find((h) => /blast/i.test(h)), undefined, `the packet still has a Blast section: ${hs.join(", ")}`);
  for (const [re, what] of GONE_WORDS) {
    const hit = lines(text).find((l) => re.test(l));
    assert.equal(hit, undefined, `the reviewer packet still mentions ${what}: ${JSON.stringify(hit)}`);
  }
});

// ---------------------------------------------------------------------------
// C6 edge — R8's two remaining clauses, and only those two
// ---------------------------------------------------------------------------

const cfg = loadConfig(makeRepo("size-policy-rules-cfg"));

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
const r8Of = (unmet) => unmet.filter((u) => u.rule === "R8");
const base = { status: "open", steps: [], waivers: [], cases: [], blast: [] };

test("C6 edge: R8 fires for a blank step and an open case, and for nothing else", () => {
  // 1. an open case
  const openCase = evaluate(state({ ledger: { ...base, cases: [{ id: "C1", status: "open", test: null, na: null }] } }));
  const caseLine = r8Of(openCase);
  assert.equal(caseLine.length, 1, `expected exactly one R8 for an open case: ${JSON.stringify(ids(openCase))}`);
  assert.ok(caseLine[0].text.includes("C1"), `the R8 line does not name C1: ${caseLine[0].text}`);

  // 2. a blank step, named by number and key
  const blankStep = evaluate(state({ ledger: { ...base, steps: [{ n: 4, key: "skeptic", state: null }] } }));
  const stepLine = r8Of(blankStep);
  assert.equal(stepLine.length, 1, `expected exactly one R8 for a blank step: ${JSON.stringify(ids(blankStep))}`);
  assert.ok(stepLine[0].text.includes("{skeptic}"), `the R8 line does not name {skeptic}: ${stepLine[0].text}`);
  assert.ok(stepLine[0].text.includes("4"), `the R8 line does not name step 4: ${stepLine[0].text}`);

  // 3. both at once: two R8 items, one per clause
  const both = evaluate(state({
    ledger: {
      ...base,
      cases: [{ id: "C1", status: "open", test: null, na: null }],
      steps: [{ n: 4, key: "skeptic", state: null }],
    },
  }));
  assert.equal(r8Of(both).length, 2, `expected one R8 per clause: ${JSON.stringify(r8Of(both).map((u) => u.text))}`);

  // 4. nothing else. Every case closed with a pointer, every step stated — and a carried-over
  //    blast row with no rung, which used to be R8's third clause, raises nothing.
  const clean = {
    ...base,
    cases: [
      { id: "C1", status: "closed", test: "tests/a.test.ts:one", na: null },
      { id: "C2", status: "closed", test: null, na: "covered by C1" },
    ],
    steps: [
      { n: 1, key: "read", state: "DONE" },
      { n: 2, key: "skeptic", state: "N/A" },
      { n: 3, key: "qa", state: "WAIVED" },
      { n: 4, key: "cleanup", state: "SKIPPED" },
    ],
    blast: [{ fact: "no rung on this one", rung: null, unproven: true, proof: null }],
    tier: { predicted: "small", predictedFiles: [], measured: null, autoNa: ["skeptic"], reopened: ["skeptic"] },
  };
  const none = evaluate(state({ ledger: clean }));
  assert.deepEqual(r8Of(none), [], `R8 fired with nothing blank and nothing open: ${JSON.stringify(r8Of(none))}`);

  // 5. R14 is gone everywhere, and no unmet item talks about rungs or blast radius.
  for (const unmet of [openCase, blankStep, both, none]) {
    assert.ok(!ids(unmet).includes("R14"), `R14 is still a rule: ${JSON.stringify(ids(unmet))}`);
    for (const u of unmet) {
      for (const [re, what] of GONE_WORDS) {
        assert.ok(!re.test(u.text), `${u.rule} still mentions ${what}: ${u.text}`);
      }
    }
  }
});
}
