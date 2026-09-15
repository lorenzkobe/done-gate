import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { nextHint } from "../scripts/lib/next.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/next-hints.test.mjs and tests/tier-policy.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { session = "S1" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input: "",
    encoding: "utf8",
    env: envFor(repo, session),
  });
}

// every verb exits 0 (the gate fails open); a refusal is the `done-gate: …` line on stderr
const REFUSAL = /^done-gate: /m;

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const hintOf = (stdout) => lines(stdout).at(-1) ?? "";
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerFile = (repo, session = "S1") => path.join(runDir(repo, session), "ledger.json");
const ledgerOf = (repo, session = "S1") => JSON.parse(readFileSync(ledgerFile(repo, session), "utf8"));
const stepOf = (ledger, key) => ledger.steps.find((s) => s.key === key);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so `--files` predictions have a baseline to measure against
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// ---------------------------------------------------------------------------
// source-of-truth anchors
//   step keys + their order → the approved plan (Team gate v0.3, T4), transcribed here
//   the playbook file       → skills/gate/playbooks.md, one `## <name>` per playbook
//   tier thresholds         → models.json (policy.tiers.small.maxFiles)
//   the "unknown playbook" name list → the five section names below
// Never ledger.mjs's or next.mjs's own tables.
// ---------------------------------------------------------------------------

const PLAYBOOK_FILE = path.join(pluginRoot, "skills", "gate", "playbooks.md");

// key lists exactly as the task states them; `null` is an unkeyed step
const EXPECTED = {
  feature: ["read", "plan", "cases", "skeptic", "qa", "implement", "verify", "driver", "schema", "review", "close"],
  bugfix: ["repro", "rootcause", "plan", "cases", "qa", "implement", "verify", "driver", "schema", "review", "close"],
  refactor: ["read", "plan", "cases", "qa", "verify-before", "implement", "verify", "driver", "review", "close"],
  plan: ["read", "plan", "skeptic", "implement", "close"],
  investigation: [null, null],
};
const NAMES = Object.keys(EXPECTED);

// the keys the old 14-step feature playbook carried and this change removes
const DROPPED = ["reconcile", "cleanup", "docs"];

const POLICY = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8")).policy;

// ---------------------------------------------------------------------------
// C1 — the new step lists
// ---------------------------------------------------------------------------

test("C1 happy: `gate open` copies in the new step list for each playbook — keys in order, numbers 1..n", () => {
  assert.ok(existsSync(PLAYBOOK_FILE), `every playbook now lives in ${PLAYBOOK_FILE}`);
  const headings = readFileSync(PLAYBOOK_FILE, "utf8")
    .split("\n")
    .flatMap((l) => {
      const m = /^##\s+(.+?)\s*$/.exec(l.replace(/\r$/, ""));
      return m ? [m[1].toLowerCase()] : [];
    });
  assert.deepEqual(headings, NAMES, "one `## <playbook>` section per playbook, in order");

  for (const name of NAMES) {
    const repo = makeRepo(`playbooks-c1-${name}`);
    cli(repo, "open", [`task-${name}`, name]);
    const l = ledgerOf(repo);
    assert.equal(l.playbook, name);
    assert.deepEqual(l.steps.map((s) => s.key), EXPECTED[name], `${name}: step keys`);
    assert.equal(l.steps.length, EXPECTED[name].length, `${name}: step count`);
    assert.deepEqual(
      l.steps.map((s) => s.n),
      EXPECTED[name].map((_, i) => i + 1),
      `${name}: step numbers are 1..n`,
    );
    for (const gone of DROPPED) {
      assert.equal(stepOf(l, gone), undefined, `${name}: {${gone}} is folded away, not copied in`);
    }
  }
});

// ---------------------------------------------------------------------------
// C2 — an unknown playbook
// ---------------------------------------------------------------------------

test("C2 refused: an unknown playbook is refused by name and lists the five playbooks; no run is created", () => {
  const repo = makeRepo("playbooks-c2");
  const r = run(repo, "open", ["chore-task", "chore"]);
  assert.equal(r.status, 0, "the gate always fails open");
  assert.equal(r.stdout, "", `a refused open must print nothing on stdout:\n${r.stdout}`);
  assert.match(r.stderr, REFUSAL);
  assert.match(r.stderr, /unknown playbook "chore"/);
  for (const name of NAMES) assert.match(r.stderr, new RegExp(`\\b${name}\\b`), `${name} must be offered:\n${r.stderr}`);
  assert.equal(existsSync(path.join(stateDir(repo), "runs", `${new Date().toISOString().slice(0, 10)}-chore-task`)), false);
});

// ---------------------------------------------------------------------------
// C3 — the ledger.md template
// ---------------------------------------------------------------------------

test("C3 happy: a fresh ledger.md has exactly the Task and Plan sections, with slug, playbook and opened date filled in", () => {
  const repo = makeRepo("playbooks-c3");
  cli(repo, "open", ["venue-badge", "feature"]);
  const l = ledgerOf(repo);
  const md = readFileSync(path.join(runDir(repo), "ledger.md"), "utf8");

  const sections = md.split("\n").flatMap((line) => {
    const m = /^##\s+(.+?)\s*$/.exec(line.replace(/\r$/, ""));
    return m ? [m[1]] : [];
  });
  assert.deepEqual(sections, ["Task", "Plan"]);
  assert.ok(!/\{\{|\}\}/.test(md), `every placeholder must be filled in:\n${md}`);
  assert.match(md, /venue-badge/);
  assert.match(md, /feature/);
  assert.ok(md.includes(l.openedAt.slice(0, 10)), `the opened date must be filled in:\n${md}`);
});

// ---------------------------------------------------------------------------
// C4 — the one optional step left
// ---------------------------------------------------------------------------

test("C4 edge: `note plan --files <one file>` marks only {skeptic} N/A on a feature; bugfix and refactor mark nothing", () => {
  assert.equal(POLICY.tiers.small.maxFiles, 1, "premise: one file is tier small per models.json");

  const feature = committed("playbooks-c4-feature");
  cli(feature, "open", ["badge", "feature"]);
  cli(feature, "note", ["task", "Add a badge. [inferred]"]);
  cli(feature, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  const f = ledgerOf(feature);
  assert.equal(f.tier.predicted, "small");
  assert.deepEqual(f.tier.autoNa, ["skeptic"]);
  assert.equal(stepOf(f, "skeptic").state, "N/A");
  assert.deepEqual(
    f.steps.filter((s) => s.state).map((s) => s.key),
    ["plan", "skeptic"],
    "only {plan} (just written) and {skeptic} (auto-N/A) are closed",
  );

  for (const name of ["bugfix", "refactor"]) {
    const repo = committed(`playbooks-c4-${name}`);
    cli(repo, "open", ["badge", name]);
    cli(repo, "note", ["task", "Fix the badge. [inferred]"]);
    cli(repo, "note", ["plan", "One component.", "--files", "src/a.ts"]);
    const l = ledgerOf(repo);
    assert.equal(l.tier.predicted, "small", name);
    assert.deepEqual(l.tier.autoNa, [], `${name}: nothing is auto-N/A`);
    assert.deepEqual(
      l.steps.filter((s) => s.state).map((s) => s.key),
      ["plan"],
      `${name}: only {plan} is closed`,
    );
  }
});

// ---------------------------------------------------------------------------
// C5 — the next: hints
// ---------------------------------------------------------------------------

test("C5 edge: after the case table the hint names {read}/{repro}; the {implement} hint drops reconcile; cleanup and docs have no hint", () => {
  const feature = committed("playbooks-c5-feature");
  cli(feature, "open", ["badge", "feature"]);
  cli(feature, "note", ["task", "Add a badge. [inferred]"]);
  cli(feature, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  const afterCases = hintOf(cli(feature, "case", ["add", "renders the badge", "--kind", "happy"]).stdout);
  assert.match(afterCases, /`gate step read done/, `the first blank feature step is {read}:\n${afterCases}`);

  const bugfix = committed("playbooks-c5-bugfix");
  cli(bugfix, "open", ["badge", "bugfix"]);
  cli(bugfix, "note", ["task", "Badge is missing. [inferred]"]);
  cli(bugfix, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  const afterBugCases = hintOf(cli(bugfix, "case", ["add", "the badge is missing", "--kind", "reported-surface"]).stdout);
  assert.match(afterBugCases, /`gate step repro done/, `the first blank bugfix step is {repro}:\n${afterBugCases}`);

  // walk the feature run to {implement}: {skeptic} is auto-N/A at tier small
  cli(feature, "step", ["read", "done", "read the card and its callers", "--evidence", "events#1"]);
  const afterQa = hintOf(cli(feature, "step", ["qa", "done", "QA wrote the tests", "--evidence", "tests/a.test.ts"]).stdout);
  assert.equal(stepOf(ledgerOf(feature), "skeptic").state, "N/A", "premise: tier small auto-N/As {skeptic}");
  assert.match(afterQa, /`gate step implement done/, `{implement} is the next blank step:\n${afterQa}`);
  assert.ok(!/reconcile/i.test(afterQa), `the {implement} hint must not mention reconcile:\n${afterQa}`);

  // a step key with no hint of its own falls back to the step's own text and number
  for (const key of DROPPED) {
    const h = nextHint({
      status: "open",
      playbook: "feature",
      taskSeq: 1,
      planSeq: 2,
      cases: [{ id: "C1", status: "closed" }],
      steps: [{ n: 1, key, text: "an old step", state: null, note: null, evidence: null, seq: null }],
    });
    assert.match(h, /`gate step 1 done\|skipped\|na/, `{${key}} must have no hint of its own:\n${h}`);
    assert.ok(!new RegExp(`gate step ${key}\\b`).test(h), `{${key}} must have no hint of its own:\n${h}`);
  }
});

// ---------------------------------------------------------------------------
// C6 — the refactor baseline verify
// ---------------------------------------------------------------------------

test("C6 happy: `gate verify --step verify-before` still closes {verify-before} on the refactor playbook", () => {
  const repo = committed("playbooks-c6");
  cli(repo, "open", ["move-card", "refactor"]);
  const keys = ledgerOf(repo).steps.map((s) => s.key);
  assert.ok(keys.indexOf("verify-before") < keys.indexOf("implement"), `the baseline runs before the move: ${keys}`);

  const r = cli(repo, "verify", ["--step", "verify-before"]);
  assert.match(r.stdout, /step \{verify-before\} closed with verify\.json/, r.stdout);

  const l = ledgerOf(repo);
  assert.equal(stepOf(l, "verify-before").state, "DONE");
  assert.equal(stepOf(l, "verify-before").evidence, "verify.json");
  assert.equal(stepOf(l, "verify").state, null, "the post-move {verify} is untouched");
});

// ---------------------------------------------------------------------------
// C7 — a run opened under the old 14-step playbook
// ---------------------------------------------------------------------------

test("C7 boundary: a ledger written under the old 14-step feature playbook still attaches, reports and closes", () => {
  // the feature playbook as it stood before this change, keys and all
  const OLD = [
    "read", "plan", "cases", "skeptic", "qa", "implement", "reconcile",
    "verify", "driver", "schema", "cleanup", "review", "docs", "close",
  ];
  const repo = committed("playbooks-c7");
  cli(repo, "open", ["legacy-run", "feature"]);
  const ledger = ledgerOf(repo);
  ledger.steps = OLD.map((key, i) => ({
    n: i + 1, key, text: `old step ${i + 1}`, state: null, note: null, evidence: null, seq: null,
  }));
  writeFileSync(ledgerFile(repo), `${JSON.stringify(ledger, null, 2)}\n`);

  // a second session joins the run the old way
  const attached = cli(repo, "attach", ["legacy-run"], { session: "S2" });
  assert.match(attached.stdout, /ledger: /);
  assert.deepEqual(ledgerOf(repo, "S2").steps.map((s) => s.key), OLD, "attaching never rewrites the old step list");

  const report = cli(repo, "report", [], { session: "S2" });
  const stepLines = report.stdout.split("\n## ").find((s) => s.startsWith("Steps\n"));
  assert.ok(stepLines, `the report has a Steps section:\n${report.stdout}`);
  assert.equal(lines(stepLines).filter((l) => /^\d+\. /.test(l)).length, OLD.length, "all 14 old steps are reported");
  assert.ok(existsSync(path.join(runDir(repo, "S2"), "report.md")));

  cli(repo, "close", [], { session: "S2" });
  const closed = ledgerOf(repo, "S2");
  assert.equal(closed.status, "closing");
  assert.equal(stepOf(closed, "close").state, "DONE");
  assert.deepEqual(closed.steps.map((s) => s.key), OLD, "closing never rewrites the old step list");
});
