// lean-text: the bugfix order, the skeptic's question, the always-loaded rules, the research
// line and the playbook text. Cases C1-C3, C5, C6 of the lean-text run (C4 is in review-loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, pluginRoot, doneArgs } from "./helpers.mjs";
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
  cli(repo, "note", "task", "A thing. [inferred]");
  cli(repo, "note", "context", "Traced: src/a.ts:1 the entry · Related: tests/a.test.ts · Research: the framework docs on caching");
  assert.match(cli(repo, "report", "--brief"), /research noted/);
});

test("C6 boundary: playbooks.md has no paragraph the parser drops, and the dead read hint is gone", () => {
  const dropped = read("skills/gate/playbooks.md").split("\n").filter((l) => l.trim() && !/^#/.test(l) && !/^\d+\.\s/.test(l));
  assert.deepEqual(dropped, [], "every line in playbooks.md is a numbered step that reaches a ledger");
  assert.doesNotMatch(read("scripts/lib/next.mjs"), /^\s*read:/m);
});
