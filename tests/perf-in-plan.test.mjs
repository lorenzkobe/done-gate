// perf-in-plan — performance becomes a designed-in concern at plan, build and review time.
// Written from the task's requirements and case table, blind to the implementation of
// scripts/lib/verbs.mjs, skills/gate/playbooks.md, skills/gate/SKILL.md, README.md and the
// agent briefs.
//
// Sources of truth for every literal asserted here:
//   the kind name "performance" .......... the task text ("the case table gains a performance kind")
//   the six kinds that existed before .... `git show HEAD:scripts/lib/verbs.mjs` CASE_KINDS at task open
//   the playbook step counts and keys .... `git show HEAD:skills/gate/playbooks.md` at task open
//   the step-line grammar ({key} last) ... scripts/lib/ledger.mjs playbookSteps()
//   the kind list SKILL/README must match  scripts/lib/verbs.mjs CASE_KINDS (named by case C8)
//
// Assertions are on the words the requirement names, never on whole sentences: the wording is
// the writer's, the vocabulary is the requirement's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, pluginRoot } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { CASE_KINDS } from "../scripts/lib/verbs.mjs";

// ---------------------------------------------------------------------------
// conventions (mirror tests/verbs.test.mjs and tests/roles.test.mjs)
// ---------------------------------------------------------------------------

const envFor = (repo) => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
};

function run(repo, verb, args = [], input = "") {
  return spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: envFor(repo) });
}

function cli(repo, verb, args = [], input = "") {
  const r = run(repo, verb, args, input);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  return r;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));

const opened = (name, playbook = "feature") => {
  const repo = makeRepo(name);
  cli(repo, "open", ["t", playbook]);
  return repo;
};

// Markdown wraps: a phrase may be split across lines, so prose checks run on the text with
// every run of whitespace collapsed to a single space.
const flat = (s) => s.replace(/\s+/g, " ");
const read = (...p) => readFileSync(path.join(pluginRoot, ...p), "utf8");
const linesOf = (s) => s.split("\n");

// assert.match would print the whole file on failure; these files are the thing under test and
// QA is blind to them, so a failure says what is missing, not what is there.
function has(text, needle, file, why = "") {
  assert.ok(flat(text).toLowerCase().includes(needle.toLowerCase()), `${file} never says ${JSON.stringify(needle)}${why ? ` (${why})` : ""}`);
}
function matches(text, re, file, why = "") {
  assert.ok(re.test(flat(text)), `${file} has nothing matching ${re}${why ? ` (${why})` : ""}`);
}

const agentFile = (role) => read("agents", `${role}.md`);
const body = (md) => md.replace(/^---\n[\s\S]*?\n---\n/, "");

// playbooks.md, parsed the way scripts/lib/ledger.mjs parses it
const PLAYBOOKS_MD = () => read("skills", "gate", "playbooks.md");
const playbookSection = (name) => {
  const md = PLAYBOOKS_MD();
  const m = new RegExp(`^## ${name}\\s*$`, "m").exec(md);
  assert.ok(m, `skills/gate/playbooks.md has no "## ${name}" section`);
  const rest = md.slice(m.index + m[0].length);
  const end = /^## /m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
};
const stepLines = (name) => linesOf(playbookSection(name)).filter((l) => /^\d+\.\s/.test(l));
const keyOf = (line) => /\{([a-z0-9-]+)\}\s*$/.exec(line.trim())?.[1] ?? null;
const keysOf = (name) => stepLines(name).map(keyOf);

// ---------------------------------------------------------------------------
// anchors recorded from the tree as the task opened (git show HEAD:…), so a step that is
// renumbered, dropped or wrapped onto a second line fails rather than passing quietly.
// ---------------------------------------------------------------------------

const KINDS_BEFORE = ["happy", "edge", "refused", "boundary", "idempotent", "reported-surface"];
const NEW_KIND = "performance";

const PLAYBOOKS_BEFORE = {
  feature: ["read", "plan", "cases", "skeptic", "qa", "implement", "verify", "driver", "schema", "review", "close"],
  bugfix: ["repro", "rootcause", "plan", "cases", "qa", "implement", "verify", "driver", "schema", "review", "close"],
  refactor: ["read", "plan", "cases", "qa", "verify-before", "implement", "verify", "driver", "review", "close"],
  plan: ["read", "plan", "skeptic", "implement", "close"],
  investigation: [null, null],
};

// ---------------------------------------------------------------------------
// C1 — a performance case is a real row
// ---------------------------------------------------------------------------

test("C1 happy: `gate case add --kind performance` records a row of kind performance", () => {
  const repo = opened("perf-c1");
  const r = cli(repo, "case", ["add", "the venue list renders 500 rows without a query per row", "--kind", NEW_KIND]);
  assert.match(r.stdout, /C1 added \(performance\)/, r.stdout);

  const [row] = ledgerOf(repo).cases;
  assert.equal(row.id, "C1");
  assert.equal(row.kind, NEW_KIND);
  assert.equal(row.case, "the venue list renders 500 rows without a query per row");
  assert.equal(row.status, "open");
  assert.equal(row.test, null);
  assert.equal(row.na, null);

  // a performance row closes with a test pointer like any other kind
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:one query for the whole list"]);
  const closed = ledgerOf(repo).cases[0];
  assert.equal(closed.status, "closed");
  assert.equal(closed.test, "tests/a.test.ts:one query for the whole list");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "cases").state, "DONE");
});

// ---------------------------------------------------------------------------
// C2 — the refused side: an unknown kind is still refused, and the message names performance
// ---------------------------------------------------------------------------

test("C2 refused: an unknown --kind is refused, nothing is written, and both the error and the usage line list performance", () => {
  const repo = opened("perf-c2");

  // the gate fails open: scripts/gate.mjs always sets exitCode 0 and writes the refusal to
  // stderr, so "refused" means the message is there and the ledger did not move.
  const bad = run(repo, "case", ["add", "slow list", "--kind", "perf"]);
  assert.equal(bad.stdout.trim(), "", `an unknown kind was accepted:\n${bad.stdout}`);
  has(bad.stderr, 'unknown kind "perf"', "gate case add stderr");
  has(bad.stderr, NEW_KIND, "gate case add stderr", "the have-list must name every kind the CLI accepts");
  for (const kind of KINDS_BEFORE) {
    has(bad.stderr, kind, "gate case add stderr", "the kinds that existed before must still be listed");
  }
  assert.deepEqual(ledgerOf(repo).cases, [], "a refused case must not reach the ledger");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "cases").state, null, "a refused case must not close the cases step");

  // the usage line (no case text at all) lists the kinds too
  const usage = run(repo, "case", ["add"]);
  assert.equal(usage.stdout.trim(), "", usage.stdout);
  has(usage.stderr, "usage: gate case add", "gate case add stderr");
  has(usage.stderr, NEW_KIND, "gate case add usage line", "the usage string must list performance");
  for (const kind of KINDS_BEFORE) {
    has(usage.stderr, kind, "gate case add usage line");
  }

  // the empty string is not a kind either
  const blank = run(repo, "case", ["add", "slow list", "--kind", ""]);
  assert.equal(blank.stdout.trim(), "", `an empty kind was accepted:\n${blank.stdout}`);
  assert.deepEqual(ledgerOf(repo).cases, [], "an empty kind must not reach the ledger either");
});

// ---------------------------------------------------------------------------
// C3 — the worker's performance rule
// ---------------------------------------------------------------------------

test("C3 happy: agents/worker.md carries a numbered performance rule — nothing in a loop, no repeated work, no unbounded list, and say so when the plan's cost shape cannot be met", () => {
  const md = body(agentFile("worker"));
  const file = "agents/worker.md";

  // the four rules that were there when the task opened are still there, in order
  const numbered = linesOf(md).filter((l) => /^\d+\.\s/.test(l)).map((l) => Number(/^(\d+)\./.exec(l)[1]));
  assert.deepEqual(numbered, [1, 2, 3, 4, 5], `agents/worker.md's rules are numbered ${numbered.join(", ")}; the task adds rule 5 to the four that existed`);
  has(md, "Edit only the files you own", file, "rule 1 must survive");
  has(md, "Keep the diff to the plan", file, "rule 3 must survive");

  // the performance rule itself, found by its title (the case table fixes the rule, not its number):
  // from its line up to the next numbered rule or the end of the list
  const from = md.indexOf("\n4. **Keep the plan's cost shape.**");
  assert.ok(from > 0, `${file} has no "Keep the plan's cost shape" rule`);
  const rest = md.slice(from + 1);
  const end = rest.search(/\n(?:\d+\. |\n[^\d\n])/);
  const rule5 = flat(end > 0 ? rest.slice(0, end) : rest);

  // no query/read/network call in a loop
  matches(rule5, /\bloop\b/i, `${file} rule 5`, "no query, read or network call in a loop");
  matches(rule5, /\bquer(y|ies)\b/i, `${file} rule 5`);
  matches(rule5, /\bnetwork\b/i, `${file} rule 5`);
  // no repeated work that could run once
  matches(rule5, /\bonce\b/i, `${file} rule 5`, "work repeated that could run once");
  matches(rule5, /\brepeat(ed|s)?\b/i, `${file} rule 5`);
  // no unbounded list
  matches(rule5, /\bunbounded\b/i, `${file} rule 5`);
  // prefer the linear shape
  matches(rule5, /\blinear\b/i, `${file} rule 5`);
  // say so when the plan's cost shape cannot be met
  matches(rule5, /cost shape/i, `${file} rule 5`, "the worker must say so when the plan's cost shape cannot be met");
});

// ---------------------------------------------------------------------------
// C4 — the reviewers' performance item
// ---------------------------------------------------------------------------

test("C4 happy: reviewer.md item 5 checks the diff against the plan's cost shape and performance rows, and a listed pattern on a named hot path is Act-on; reviewer-2.md says the same", () => {
  const reviewer = body(agentFile("reviewer"));
  const file = "agents/reviewer.md";

  // the seven review steps that existed when the task opened are still seven, in order
  const numbered = linesOf(reviewer).filter((l) => /^\d+\.\s\*\*/.test(l)).map((l) => Number(/^(\d+)\./.exec(l)[1]));
  assert.deepEqual(numbered, [1, 2, 3, 4, 5, 6, 7], `agents/reviewer.md's review order is ${numbered.join(", ")}; item 5 is the performance item`);

  // item 5, from "5. **" up to "6. **"
  const start = reviewer.indexOf("\n5. **");
  const end = reviewer.indexOf("\n6. **");
  assert.ok(start > 0 && end > start, `${file} has no item 5 followed by an item 6`);
  const item5 = flat(reviewer.slice(start, end));

  const checks = [
    [/cost shape/i, "the plan's cost shape"],
    [/performance/i, "the plan's performance rows"],
    [/hot path/i, "a named hot path"],
    [/\bact[- ]on\b/i, "a listed pattern on a named hot path blocks as Act-on"],
    [/\bloop\b/i, "a query or read inside a loop"],
    [/\bunbounded\b/i, "an unbounded list"],
  ];
  for (const [re, why] of checks) matches(item5, re, `${file} item 5`, why);

  // reviewer-2 carries the same demand. Its brief is prose, not a numbered list, so the pin is
  // the vocabulary, not a line number.
  const r2 = body(agentFile("reviewer-2"));
  for (const [re, why] of checks) matches(r2, re, "agents/reviewer-2.md", why);
});

// ---------------------------------------------------------------------------
// C5 — the skeptic attacks the performance note
// ---------------------------------------------------------------------------

test("C5 happy: agents/skeptic.md tells the skeptic to attack the plan's performance note — hot paths, data sizes and cost shape", () => {
  const md = body(agentFile("skeptic"));
  const file = "agents/skeptic.md";

  for (const [re, why] of [
    [/hot path/i, "the plan names hot paths"],
    [/data size/i, "the plan names data sizes"],
    [/cost shape/i, "the plan names a cost shape"],
    [/performance/i, "the performance note is a thing the skeptic attacks"],
  ]) {
    matches(md, re, file, why);
  }

  // it is an item of the attack list the skeptic answers in order, not a line of the preamble
  const numbered = linesOf(md).filter((l) => /^\d+\.\s\*\*/.test(l));
  assert.ok(numbered.length >= 5, `agents/skeptic.md's attack list has ${numbered.length} items; it had 5 when the task opened`);
  const listStart = md.indexOf("\n1. **");
  const listEnd = md.indexOf("File shape:");
  assert.ok(listStart > 0 && listEnd > listStart, `${file}: could not find the numbered attack list before "File shape:"`);
  const list = flat(md.slice(listStart, listEnd));
  for (const re of [/hot path/i, /data size/i, /cost shape/i]) {
    matches(list, re, `${file}'s numbered attack list`, "the performance note is attacked in the list, not only mentioned in passing");
  }

  // the items that were there when the task opened are still there
  for (const kept of ["Premise", "Missing cases", "Cheaper shape", "Side effects", "The one question"]) {
    has(md, kept, file, "an existing skeptic item must survive");
  }
});

// ---------------------------------------------------------------------------
// C6 — the plan step of every building playbook asks for the performance note
// ---------------------------------------------------------------------------

test("C6 happy: the {plan} step of feature, bugfix and refactor asks for hot paths, data sizes and cost shape, and allows a one-line 'no hot path'", () => {
  for (const name of ["feature", "bugfix", "refactor"]) {
    const line = stepLines(name).find((l) => keyOf(l) === "plan");
    // scripts/lib/ledger.mjs only reads a {key} that ends the line, so the whole step —
    // performance note included — has to stay on one line or the step loses its key.
    assert.ok(line, `skills/gate/playbooks.md: the ${name} playbook has no step ending in {plan}`);
    const where = `skills/gate/playbooks.md ${name} {plan} step`;
    for (const [re, why] of [
      [/hot path/i, "the plan names the hot paths"],
      [/data size/i, "the plan names the data sizes"],
      [/cost shape/i, "the plan names the cost shape"],
      [/no hot path/i, "'no hot path' in one line is an allowed answer"],
    ]) {
      matches(line, re, where, why);
    }
    // it is still the step that writes Task and Plan
    matches(line, /gate note task\|plan|note task/i, where, "the plan step still names `gate note task|plan`");
  }

  // the feature and refactor case steps list performance rows among the kinds they ask for
  for (const name of ["feature", "refactor"]) {
    const line = stepLines(name).find((l) => keyOf(l) === "cases");
    assert.ok(line, `skills/gate/playbooks.md: the ${name} playbook has no step ending in {cases}`);
    matches(line, /performance/i, `skills/gate/playbooks.md ${name} {cases} step`, "the case step lists performance rows");
  }
});

// ---------------------------------------------------------------------------
// C7 — nothing else about the playbooks moved
// ---------------------------------------------------------------------------

test("C7 idempotent: every playbook section still has the same step count and the same keys in the same order, and `gate open` still copies them into the ledger", () => {
  for (const [name, keys] of Object.entries(PLAYBOOKS_BEFORE)) {
    assert.deepEqual(
      keysOf(name),
      keys,
      `skills/gate/playbooks.md: the ${name} playbook's steps changed count, order or {key}.\n` +
        `A step whose text grew past one line loses its {key}, because scripts/lib/ledger.mjs only reads a {key} that ends the line.`,
    );
  }

  // and what `gate open` copies in matches the file, for a keyed playbook and the unkeyed one
  for (const name of ["feature", "bugfix", "refactor", "plan", "investigation"]) {
    const repo = opened(`perf-c7-${name}`, name);
    const steps = ledgerOf(repo).steps;
    assert.deepEqual(steps.map((s) => s.key), PLAYBOOKS_BEFORE[name], `gate open ${name}: ledger step keys`);
    assert.deepEqual(steps.map((s) => s.n), PLAYBOOKS_BEFORE[name].map((_, i) => i + 1), `gate open ${name}: ledger step numbers`);
    assert.ok(steps.every((s) => s.state === null), `gate open ${name}: every copied step starts blank`);
    assert.ok(steps.every((s) => typeof s.text === "string" && s.text.length > 0), `gate open ${name}: a step was copied with no text`);
  }
});

// ---------------------------------------------------------------------------
// C8 — the shipped prose lists exactly the kinds the CLI accepts
// ---------------------------------------------------------------------------

test("C8 boundary: CASE_KINDS gains performance and nothing else, and SKILL.md and README.md list exactly those kinds", () => {
  assert.deepEqual(CASE_KINDS, [...KINDS_BEFORE, NEW_KIND], "scripts/lib/verbs.mjs CASE_KINDS: the task adds performance to the six kinds that existed");

  // SKILL.md: the kind list is on the `gate case add` line, so it stays one line
  const skill = read("skills", "gate", "SKILL.md");
  const kindLine = linesOf(skill).find((l) => l.includes("gate case add") && l.includes("--kind"));
  assert.ok(kindLine, "skills/gate/SKILL.md has no `gate case add … --kind` line");
  for (const kind of CASE_KINDS) {
    assert.ok(kindLine.includes(kind), `skills/gate/SKILL.md's \`gate case add\` line does not list the kind ${JSON.stringify(kind)}:\n${kindLine}`);
  }

  // the `next:` hint after `gate note plan` lists the kinds too (reviewer H1.1)
  const hint = linesOf(read("scripts", "lib", "next.mjs")).find((l) => l.includes("--kind"));
  assert.ok(hint, "scripts/lib/next.mjs has no `--kind` hint");
  for (const kind of CASE_KINDS) assert.ok(hint.includes(kind), `scripts/lib/next.mjs hint does not list the kind ${JSON.stringify(kind)}`);

  // README: the kinds are listed together on the `--kind` line of the verb table (a plain
  // indexOf over the whole file matched "edge" inside "badge" and "refused" in prose)
  const readmeLine = linesOf(read("README.md")).find((l) => l.includes("--kind"));
  assert.ok(readmeLine, "README.md has no `--kind` line");
  for (const kind of CASE_KINDS) {
    assert.ok(new RegExp(`\\b${kind}\\b`).test(readmeLine), `README.md's \`--kind\` line does not list the kind ${JSON.stringify(kind)}:\n${readmeLine}`);
  }
});
