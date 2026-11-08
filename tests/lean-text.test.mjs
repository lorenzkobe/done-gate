// lean-text: the bugfix order, the skeptic's question, the always-loaded rules, the research
// line and the playbook text. Cases C1-C3, C5, C6 of the lean-text run (C4 is in review-loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, pluginRoot, doneArgs, lookedUp } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

const read = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");
function cli(repo, ...args) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [gate, ...args], { input: "", encoding: "utf8", env });
  assert.equal(r.status, 0, `gate ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(repo, ".claude/gate/runs", loadSession(path.join(repo, ".claude/gate"), "S1").current, "ledger.json"), "utf8"));

test("C1 reported-surface: a bugfix ledger orders repro, context, rootcause, and the hint after repro asks for the context", () => {
  const repo = makeRepo("lt-bugfix-order");
  cli(repo, "open", "lt-order", "bugfix");
  const keys = ledgerOf(repo).steps.map((s) => s.key).filter(Boolean);
  assert.deepEqual(keys.slice(0, 3), ["repro", "context", "rootcause"]);
  cli(repo, "note", "task", "A bug. [inferred]");
  const hint = cli(repo, "step", ...doneArgs(repo, "repro", "repro", "it fails", "x")).split("\n").find((l) => l.startsWith("next:"));
  assert.match(hint, /understand first/);
});

test("C2 reported-surface: the skeptic hint puts a non-empty 'The one question' to the user before code", () => {
  const hint = read("scripts/lib/next.mjs").split("\n").find((l) => /^\s*skeptic:/.test(l));
  assert.match(hint, /The one question/);
  assert.match(hint, /AskUserQuestion/);
});

test("C3 happy: session-start carries run-when-cheap and config-alone-is-unverified, has no slop list, and allows hand edits of ledger.md only", () => {
  const text = read("hooks/session-start.md");
  assert.match(text, /cheap/);
  assert.match(text, /config alone/);
  assert.doesNotMatch(text, /No slop/);
  assert.match(text, /except `?ledger\.md`?/);
});

test("C5 reported-surface: the brief says research noted when Context is written on one line with · separators", () => {
  const repo = makeRepo("lt-research-line");
  cli(repo, "open", "lt-research", "feature");
  lookedUp(repo);
  cli(repo, "note", "task", "A thing. [inferred]");
  cli(repo, "note", "context", "Traced: src/a.ts:1 the entry · Related: tests/a.test.ts · Research: the framework docs on caching");
  assert.match(cli(repo, "report", "--brief"), /research noted/);
});

test("the skill holds the seven common sense rules, the ladder, and the edit-once and trace-first advice, under the byte limit", () => {
  const skill = read("skills/gate/SKILL.md");
  const flat = skill.replace(/\s+/g, " ");
  for (const rule of [
    "Do what was agreed, the simplest way that works",
    "If the plan has to change, say so first",
    "Answer the question you were asked before anything else",
    "If you are told to stop, stop",
    "If a rule gets in the way of doing the obvious right thing, say so",
    "Do not do work nobody asked for",
    "Before a slow step, ask whether a quicker one answers the same question",
    "Never reshape work to fit a rule",
    "Same failure twice: stop and work out why",
    "Only the user accepts a known gap",
    "needed at all, already here, standard library, installed dependency, one line, then the minimum",
    "End with what you skipped or did not check",
    "Plan so each file is edited once",
    "When unsure, trace the code and the task first, and ask only what they can't answer",
  ]) assert.ok(flat.includes(rule), `SKILL.md is missing: ${rule}`);
  assert.ok(Buffer.byteLength(skill) < 4096, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
});

test("QA is told to write tests with the Write tool", () => {
  assert.match(read("agents/qa.md"), /with the Write tool/);
});

test("the reviewer, second reviewer and plan check write one bullet per finding, detail indented beneath it", () => {
  for (const role of ["reviewer", "reviewer-2", "skeptic"]) {
    assert.match(read(`agents/${role}.md`), /One bullet per finding, with any detail indented beneath it and its `file:line` on the top bullet/, role);
  }
});

const TAMPER = /tamper-evident: a determined agent can still write its evidence/;

test("doctor, session start and the README say the gate is tamper-evident, and the README no longer claims evidence can't be forged", () => {
  const repo = makeRepo("lt-tamper");
  assert.match(cli(repo, "doctor"), TAMPER);
  assert.match(read("hooks/session-start.md"), TAMPER);
  const readme = read("README.md").replace(/\s+/g, " ");
  assert.match(readme, TAMPER);
  assert.doesNotMatch(readme, /Can't forge/);
});

test("C6 boundary: playbooks.md has no paragraph the parser drops, and the dead read hint is gone", () => {
  const dropped = read("skills/gate/playbooks.md").split("\n").filter((l) => l.trim() && !/^#/.test(l) && !/^\d+\.\s/.test(l));
  assert.deepEqual(dropped, [], "every line in playbooks.md is a numbered step that reaches a ledger");
  assert.doesNotMatch(read("scripts/lib/next.mjs"), /^\s*read:/m);
});

test("C7 reported-surface: the plan check asks whether the plan covers the whole design or ticket and whether it can be coded without guessing, and stays read-only", () => {
  const body = read("agents/skeptic.md").replace(/^---\n[\s\S]*?\n---\n/, "");
  const asked = body.split("\n").filter((l) => /^\d+\. \*\*/.test(l));
  assert.ok(asked.some((l) => /whole design or ticket/.test(l)), asked.join("\n"));
  assert.ok(asked.some((l) => /without guessing/.test(l) && /vague step/.test(l)), asked.join("\n"));
  assert.match(asked.at(-1), /The one question/, "the one question stays last, as the file shape ends with it");
  assert.match(body, /read-only, one pass: no prototypes, no builds/i);
});

// Test files run in parallel and a fixture rebuilds tests/.tmp/<name> by name, so two files that
// pick one name break each other (steps-from-facts and small-friction did, 2026-11-08).
test("C8 refused: no two test files name the same scratch repo", () => {
  const BUILDER = /\b(?:makeRepo|committed|committedRepo|opened|openedWith|openedLarge|planned|standard|standardFixture|cleanClosingFixture|changed|large|pair|withE2e)\(\s*["'`]([\w.-]+)["'`]/g;
  const owners = new Map();
  for (const file of readdirSync(path.join(pluginRoot, "tests")).filter((f) => f.endsWith(".test.mjs"))) {
    for (const [, name] of read(`tests/${file}`).matchAll(BUILDER)) owners.set(name, new Set([...(owners.get(name) ?? []), file]));
  }
  const shared = [...owners].filter(([, files]) => files.size > 1).map(([name, files]) => `${name}: ${[...files].sort().join(", ")}`);
  assert.deepEqual(shared, []);
});
