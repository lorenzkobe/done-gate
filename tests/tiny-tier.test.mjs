import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadPolicy, tierFor, predictTier, OPTIONAL_STEPS, optionalSteps, requiredSteps } from "../scripts/lib/size.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

// tiny: one plain source file, at most 15 lines. No skeptic, no reviewer; tests and verify
// stay. Reached only by evidence: a plan naming exactly one source file, or an exact
// measurement. Growth gives the dropped steps back.

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const check = (repo) => run(repo, "check").stdout;
const blocks = (out, rule) => out.split("\n").some((l) => new RegExp(`\\b${rule}\\b`).test(l));
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerFile = (repo) => path.join(runDir(repo), "ledger.json");
const ledgerOf = (repo) => JSON.parse(readFileSync(ledgerFile(repo), "utf8"));
const stepOf = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key);
const measured = (repo) => /measured (\w+):/.exec(cli(repo, "size"))?.[1] ?? null;

function committed(name, files) {
  const repo = makeRepo(name, files);
  const git = (args) => execFileSync("git", args, { cwd: repo });
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}
function opened(name, { playbook = "feature", files = {}, planFiles = "src/a.ts", dirty = null } = {}) {
  const repo = committed(name, { "src/a.ts": "export const a = 1;\n", ...files });
  // the session starts first, so the dirty write is an edit made in this session before open:
  // it matches no baseline entry, gets no base copy and keeps the line-delta estimate
  if (dirty) {
    run(repo, "check");
    write(repo, dirty[0], dirty[1]);
  }
  cli(repo, "open", [name, playbook]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: tiny"]);
  const out = cli(repo, "note", ["plan", "One module. No hot path.", "--files", planFiles]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  return { repo, out };
}
const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
const read = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");
const flat = (rel) => read(rel).replace(/\s+/g, " ");

const policy = loadPolicy();
const order = Object.keys(policy.tiers);

test("C1 boundary: 1 file and 15 lines is tiny; 16 lines or 2 files is not; tiny is the first tier and requires nobody", () => {
  assert.equal(order[0], "tiny");
  assert.deepEqual(policy.tiers.tiny, { maxFiles: 1, maxLines: 15, requires: [] });
  const at = (files, l) => tierFor(policy, { files, lines: l });
  assert.equal(at(1, 15), "tiny");
  assert.equal(at(1, 16), "small");
  assert.equal(at(2, 2), "standard");
  assert.equal(at(1, 40), "small");
});

test("C2/C12 happy: one plain source file predicts tiny; {skeptic} and {review} go N/A with 'tier tiny (predicted)'; tests, verify, close stay", () => {
  const { repo, out } = opened("tiny-c2");
  assert.match(out, /tier predicted tiny \(1 file\)/);
  for (const key of ["skeptic", "review"]) {
    assert.equal(stepOf(repo, key).state, "N/A", key);
    assert.equal(stepOf(repo, key).note, "tier tiny (predicted)", key);
  }
  assert.deepEqual(ledgerOf(repo).tier.autoNa.sort(), ["review", "skeptic"]);
  for (const key of ["tests", "verify", "close"]) assert.equal(stepOf(repo, key).state, null, key);
});

test("C3 happy: bugfix and refactor at predicted tiny drop {skeptic} and {review} like feature; OPTIONAL_STEPS says which step each playbook may drop", () => {
  assert.deepEqual(OPTIONAL_STEPS.feature, ["skeptic", "review"]);
  assert.deepEqual(OPTIONAL_STEPS.bugfix, ["skeptic", "review"]);
  assert.deepEqual(OPTIONAL_STEPS.refactor, ["skeptic", "review"]);
  assert.deepEqual(optionalSteps({ playbook: "plan" }), []);
  assert.deepEqual(requiredSteps(policy, "tiny", { playbook: "feature" }), []);
  assert.deepEqual(requiredSteps(policy, "small", { playbook: "feature" }), ["review"]);
  assert.deepEqual(requiredSteps(policy, "standard", { playbook: "feature" }), ["skeptic", "review"]);
  for (const playbook of ["bugfix", "refactor"]) {
    const { repo } = opened(`tiny-c3-${playbook}`, { playbook });
    assert.equal(stepOf(repo, "review").state, "N/A", playbook);
    assert.equal(stepOf(repo, "skeptic").state, "N/A", playbook);
    assert.deepEqual(ledgerOf(repo).tier.autoNa.sort(), ["review", "skeptic"], playbook);
  }
});

test("C4 edge: a tiny task whose diff grows past 15 lines gets {review} back and R5 asks for a reviewer; a second file gives {skeptic} back too", () => {
  const { repo } = opened("tiny-c4");
  write(repo, "src/a.ts", lines(20));
  assert.equal(measured(repo), "small");
  assert.equal(stepOf(repo, "review").state, null, "review reopened");
  assert.deepEqual(ledgerOf(repo).tier.autoNa, ["skeptic"], "a reopened step leaves the auto-N/A list");
  assert.equal(stepOf(repo, "skeptic").state, "N/A", "skeptic still dropped at small");
  assert.ok(blocks(check(repo), "R5"), check(repo));
  write(repo, "src/b.ts", "export const b = 1;\n");
  assert.equal(measured(repo), "standard");
  assert.equal(stepOf(repo, "skeptic").state, null, "skeptic reopened");
});

test("C5 refused: at tiny, source changed and no reviewer pass: no R5; the same at small has R5", () => {
  const tiny = opened("tiny-c5-tiny").repo;
  write(tiny, "src/a.ts", lines(3));
  assert.equal(measured(tiny), "tiny");
  assert.ok(!blocks(check(tiny), "R5"), check(tiny));
  const small = opened("tiny-c5-small").repo;
  write(small, "src/a.ts", lines(30));
  assert.equal(measured(small), "small");
  assert.ok(blocks(check(small), "R5"), check(small));
});

test("C6 refused: a ui file forces tiny up to standard at prediction and at measurement", () => {
  const { repo, out } = opened("tiny-c6", { planFiles: "src/app/page.tsx" });
  assert.match(out, /tier predicted standard \(1 file, forced by ui\)/);
  assert.equal(stepOf(repo, "review").state, null);
  assert.equal(stepOf(repo, "skeptic").state, null);
  write(repo, "src/app/page.tsx", "export default () => 1;\n");
  assert.equal(measured(repo), "standard");
});

test("C7 idempotent: noting the same one-file plan twice leaves autoNa and the N/A steps as they were", () => {
  const { repo } = opened("tiny-c7");
  const before = JSON.stringify([ledgerOf(repo).tier.autoNa, stepOf(repo, "review"), stepOf(repo, "skeptic")].map((x) => (x.seq === undefined ? x : { ...x, seq: 0 })));
  cli(repo, "note", ["plan", "One module. No hot path.", "--files", "src/a.ts"]);
  const after = JSON.stringify([ledgerOf(repo).tier.autoNa, stepOf(repo, "review"), stepOf(repo, "skeptic")].map((x) => (x.seq === undefined ? x : { ...x, seq: 0 })));
  assert.equal(after, before);
});

test("C8 edge: a models.json without tiny loads its tiers as written and one file predicts small", () => {
  const file = path.join(pluginRoot, "tests", ".tmp", "old-models.json");
  const old = JSON.parse(read("models.json"));
  delete old.policy.tiers.tiny;
  writeFileSync(file, JSON.stringify(old));
  const p = loadPolicy(file);
  assert.deepEqual(Object.keys(p.tiers), ["small", "standard", "large"]);
  assert.equal(tierFor(p, { files: 1, lines: 0 }), "small");
  assert.deepEqual(requiredSteps(p, "small", { playbook: "feature" }), ["review"]);
  assert.equal(predictTier(p, loadConfig(pluginRoot), []).tier, "small", "a zero-file plan floors only above a tier that needs no helper");
});

test("C9 reported-surface: README, SKILL.md, the playbooks and session-start.md name tiny and what it skips", () => {
  const readme = read("README.md");
  assert.match(readme, /^\| tiny \| one source file, ≤ 15 lines[^|]*\| none \|$/m, "README tier table");
  assert.match(readme, /R5 \|[^\n]*tiny/, "README R5 row names tiny");
  assert.match(read("skills/gate/SKILL.md"), /tiny[^.]*(skips|drops|no)[^.]*(reviewer|review)/i, "SKILL.md");
  const pb = read("skills/gate/playbooks.md");
  assert.match(pb, /spawn the skeptic[^\n]*N\/A below standard/, "feature skeptic step");
  assert.equal((pb.match(/spawn the reviewer[^\n]*N\/A at tiny/g) ?? []).length, 3, "three review steps say N/A at tiny");
  assert.match(read("hooks/session-start.md"), /tiny/i);
});

test("C10 reported-surface: the no-slop list is in SKILL.md, every playbook's implement step, worker.md and both reviewers; reviewer.md files it under Act on", () => {
  const list = /restate.{0,120}hedg.{0,120}(guard|try\/catch).{0,120}docstring.{0,120}TODO.{0,120}commented-out.{0,120}emoji/i;
  assert.match(flat("skills/gate/SKILL.md"), list, "SKILL.md");
  assert.match(read("skills/gate/playbooks.md"), /(Implement|fix)[^\n]*no slop/i, "implement steps point at it");
  assert.match(flat("agents/worker.md"), list, "worker.md");
  assert.match(read("agents/reviewer.md"), /Act-on[^\n]*slop|slop[^\n]*Act-on/i, "reviewer.md: slop is Act-on");
  assert.match(flat("agents/reviewer.md"), list, "reviewer.md list");
  assert.match(read("agents/reviewer-2.md"), /slop/i, "reviewer-2.md");
});

test("C11 performance: tierFor is one pass over the tiers; 10000 calls stay under 50 ms", () => {
  const t0 = performance.now();
  for (let i = 0; i < 10000; i++) tierFor(policy, { files: i % 12, lines: i % 500 });
  assert.ok(performance.now() - t0 < 50);
});

test("C13 refused: a measurement with a line-delta estimate never lands on tiny: it floors at small and says why", () => {
  const { repo } = opened("tiny-c13", { files: { "src/a.ts": "l1\nl2\nl3\n" }, dirty: ["src/a.ts", "l1\nl2\nl3\nl4\n"] });
  write(repo, "src/a.ts", "x1\nx2\nx3\nx4\n");
  const size = cli(repo, "size");
  assert.match(size, /measured small: 1 file, 1 line/, size);
  assert.match(size, /line-delta estimate/, size);
  assert.equal(stepOf(repo, "review").state, null, "review came back");
});

test("C14 refused: a plan naming zero source files predicts small, not tiny", () => {
  const { repo, out } = opened("tiny-c14", { planFiles: "tests/a.test.ts" });
  assert.match(out, /tier predicted small \(0 files\)/);
  assert.equal(stepOf(repo, "review").state, null);
  assert.equal(stepOf(repo, "skeptic").state, "N/A");
});

test("C15 edge: re-prediction is per step: tiny→small reopens {review} and keeps {skeptic}; standard→tiny drops both; a hand N/A is never touched", () => {
  const { repo } = opened("tiny-c15");
  cli(repo, "step", ["tests", "na", "pinned by hand"]);
  cli(repo, "note", ["plan", "Two modules.", "--files", "src/a.ts,src/b.ts"]);
  assert.equal(stepOf(repo, "review").state, null);
  assert.equal(stepOf(repo, "skeptic").state, null);
  assert.deepEqual(ledgerOf(repo).tier.autoNa, []);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  assert.equal(stepOf(repo, "review").state, "N/A");
  assert.equal(stepOf(repo, "skeptic").state, "N/A");
  assert.deepEqual(ledgerOf(repo).tier.autoNa.sort(), ["review", "skeptic"]);
  assert.equal(stepOf(repo, "tests").state, "N/A");
  assert.equal(stepOf(repo, "tests").note, "pinned by hand");
  cli(repo, "note", ["plan", "Zero modules.", "--files", "tests/a.test.ts"]);
  assert.equal(stepOf(repo, "review").state, null, "small keeps the reviewer");
  assert.equal(stepOf(repo, "skeptic").state, "N/A", "small still drops the skeptic");
  assert.deepEqual(ledgerOf(repo).tier.autoNa, ["skeptic"]);
});

test("C16 edge: an open ledger carrying the old note 'tier small (predicted)' is still auto-N/A and reopens on growth", () => {
  const { repo } = opened("tiny-c16");
  const l = ledgerOf(repo);
  l.tier.predicted = "small";
  l.tier.autoNa = ["skeptic"];
  const skeptic = l.steps.find((s) => s.key === "skeptic");
  skeptic.note = "tier small (predicted)";
  const review = l.steps.find((s) => s.key === "review");
  Object.assign(review, { state: null, note: null });
  writeFileSync(ledgerFile(repo), JSON.stringify(l));
  cli(repo, "note", ["plan", "Two modules.", "--files", "src/a.ts,src/b.ts"]);
  assert.equal(stepOf(repo, "skeptic").state, null, "the old auto note is recognised");
});

test("C17 refused: an untiered plan ledger with source edits still gets R5; a tiered ledger with no prediction is judged by measurement", () => {
  const plan = committed("tiny-c17-plan", { "src/a.ts": "export const a = 1;\n" });
  cli(plan, "open", ["spec", "plan"]);
  cli(plan, "note", ["task", "Write the spec. [inferred]"]);
  cli(plan, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: tiny"]);
  cli(plan, "note", ["plan", "Spec only."]);
  write(plan, "src/a.ts", lines(2));
  assert.ok(blocks(check(plan), "R5"), check(plan));

  const unpredicted = committed("tiny-c17-unpredicted", { "src/a.ts": "export const a = 1;\n" });
  cli(unpredicted, "open", ["badge", "feature"]);
  cli(unpredicted, "note", ["task", "Add a badge. [inferred]"]);
  cli(unpredicted, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: tiny"]);
  cli(unpredicted, "note", ["plan", "No files named."]);
  cli(unpredicted, "case", ["add", "renders", "--kind", "happy"]);
  write(unpredicted, "src/a.ts", lines(2));
  assert.equal(measured(unpredicted), "tiny");
  assert.ok(!blocks(check(unpredicted), "R5"), check(unpredicted));
  write(unpredicted, "src/a.ts", lines(30));
  assert.ok(blocks(check(unpredicted), "R5"), check(unpredicted));
});
