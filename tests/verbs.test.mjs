import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { evaluate, lateOrder } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

function cli(repo, verb, args = [], input = "") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" },
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));
const opened = (name, playbook = "feature") => {
  const repo = makeRepo(name);
  cli(repo, "open", ["t", playbook]);
  return repo;
};

test("note task/plan fills the ledger.md section and stamps taskSeq/planSeq; '-' reads stdin", () => {
  const repo = opened("verbs-note");
  cli(repo, "note", ["task", "Add a badge to the venue card."]);
  cli(repo, "note", ["plan", "-"], "Touch CourtCard.tsx.\nNo data change.\n");
  const md = readFileSync(path.join(runDir(repo), "ledger.md"), "utf8");
  assert.match(md, /## Task\n\nAdd a badge/);
  assert.match(md, /## Plan\n\nTouch CourtCard\.tsx\.\nNo data change\./);
  assert.ok(!/<!-- The user's ask/.test(md), "placeholder replaced");
  const l = ledgerOf(repo);
  assert.equal(typeof l.taskSeq, "number");
  assert.equal(typeof l.planSeq, "number");
  assert.equal(l.steps.find((s) => s.key === "plan").state, "DONE");
});

test("case add/close builds the case table; close needs a test pointer or --na", () => {
  const repo = opened("verbs-case");
  const r = cli(repo, "case", ["add", "happy path renders the badge", "--kind", "happy"]);
  assert.match(r.stdout, /C1/);
  cli(repo, "case", ["add", "hidden when venue has no rating", "--kind", "edge"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/CourtCard.test.tsx:renders the badge"]);
  cli(repo, "case", ["close", "C2", "--na", "covered by C1's fixture"]);
  const cases = ledgerOf(repo).cases;
  assert.equal(cases.length, 2);
  assert.equal(cases[0].test, "tests/CourtCard.test.tsx:renders the badge");
  assert.equal(cases[0].status, "closed");
  assert.equal(cases[1].na, "covered by C1's fixture");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "cases").state, "DONE");
  const bad = spawnSync(process.execPath, [gate, "case", "close", "C1"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
  assert.match(bad.stderr, /--test|--na/);
});

test("step marks a step DONE/SKIPPED/N-A with a note; evidenced steps refuse SKIPPED; DONE needs --evidence", () => {
  const repo = opened("verbs-step");
  cli(repo, "step", ["context", "done", "traced it", "--evidence", "events#1"]);
  cli(repo, "step", ["schema", "skipped", "no schema files touched"]);
  cli(repo, "step", ["6", "na", "nothing to implement in this fixture"]);
  const steps = ledgerOf(repo).steps;
  assert.equal(steps.find((s) => s.key === "context").state, "DONE");
  assert.equal(steps.find((s) => s.key === "context").evidence, "events#1");
  assert.equal(steps.find((s) => s.key === "schema").state, "SKIPPED");
  assert.equal(steps.find((s) => s.n === 6).state, "N/A");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  const refuse = spawnSync(process.execPath, [gate, "step", "verify", "skipped", "busy"], { encoding: "utf8", env });
  assert.match(refuse.stderr, /cannot be SKIPPED/);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "verify").state, null);
  const noEvidence = spawnSync(process.execPath, [gate, "step", "implement", "done", "did it"], { encoding: "utf8", env });
  assert.match(noEvidence.stderr, /--evidence/);
});

test("huddle add / acton / resolve track a review round and its Act-on items", () => {
  const repo = opened("verbs-huddle");
  const r = cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.match(r.stdout, /H1/);
  cli(repo, "huddle", ["acton", "H1", "null venue crashes the badge"]);
  cli(repo, "huddle", ["acton", "H1", "missing refused-side test"]);
  // `huddle resolve` requires a pointer that actually resolves; tests/a.test.ts is in the fixture
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:null venue"]);
  const [h] = ledgerOf(repo).huddles;
  assert.equal(h.role, "reviewer");
  assert.equal(h.file, "review-1.md");
  assert.equal(h.actOn.length, 2);
  assert.equal(h.actOn[0].closed, "tests/a.test.ts:null venue");
  assert.equal(h.actOn[1].closed, null);
});

test("waive records a reason against a step key or rule", () => {
  const repo = opened("verbs-waive");
  cli(repo, "waive", ["driver", "skip the phone pass this time, chrome is disconnected"]);
  const [w] = ledgerOf(repo).waivers;
  assert.equal(w.key, "driver");
  assert.match(w.reason, /chrome is disconnected/);
  assert.equal("found" in w, false);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "driver").state, "WAIVED");
});

test("decide appends a sanitised TSV row", () => {
  const repo = opened("verbs-decide");
  cli(repo, "decide", ["plan", "kept the badge in CourtCard", "one consumer\tonly", "=events#3", "open"]);
  const tsv = readFileSync(path.join(runDir(repo), "decisions.tsv"), "utf8").split("\n");
  assert.equal(tsv[0], "ts\tphase\tdecision\twhy\tevidence\tresult");
  const cells = tsv[1].split("\t");
  assert.equal(cells.length, 6);
  assert.equal(cells[3], "one consumer only");
  assert.equal(cells[4], "'=events#3");
});

test("close sets status closing and marks the close step; the stop gate then finalises when clean", () => {
  const repo = opened("verbs-close", "plan");
  cli(repo, "note", ["task", "t"]);
  cli(repo, "note", ["plan", "p"]);
  cli(repo, "step", ["context", "done", "traced it", "--evidence", "events#1"]);
  cli(repo, "step", ["skeptic", "done", "no findings", "--evidence", "events#2"]);
  cli(repo, "step", ["implement", "done", "spec written", "--evidence", "docs/spec.md"]);
  cli(repo, "close");
  assert.equal(ledgerOf(repo).status, "closing");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "close").state, "DONE");
  const dir = runDir(repo);
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, last_assistant_message: "report" }),
    encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
  assert.equal(r.stdout.trim(), "", r.stdout);
  assert.equal(loadLedger(dir).status, "closed");
  assert.equal(loadSession(path.join(repo, ".claude", "gate"), "S1").current, null);
});

test("R8: blank steps and open cases block; R2: the Plan and case table must exist at all, and a late one is recorded rather than blocked", () => {
  const cfg = loadConfig(makeRepo("verbs-rules"));
  const base = { config: cfg, changed: ["src/a.ts", "tests/a.test.ts"], now: { hash: "x", files: {} }, verify: { sourceHash: "n/a", commands: [] }, events: [], reviews: [], lastMessage: "" };
  const ledger = {
    status: "open", waivers: [], planSeq: 10, taskSeq: 9,
    cases: [{ id: "C1", status: "closed", test: "t:x", seq: 11 }, { id: "C2", status: "open", seq: 12 }],
    steps: [{ n: 1, key: "read", state: "DONE" }, { n: 2, key: "plan", state: null }],
  };
  const ids = evaluate({ ...base, ledger }).map((u) => u.rule);
  assert.ok(ids.includes("R8"));
  // R2 matches its own message: it blocks only while the Plan or the case table is missing
  // altogether. A plan written after the first source edit is recorded, not blocked.
  const edited = { ...base, ledger: { ...ledger, planSeq: 100, cases: [{ id: "C1", status: "closed", test: "t", seq: 101 }], steps: [] }, events: [{ seq: 50, kind: "edit", path: "src/a.ts", agent: null }] };
  assert.ok(!evaluate(edited).map((u) => u.rule).includes("R2"), "a late Plan that exists does not block");
  // lateOrder names what was written late and the path of the first source edit
  assert.deepEqual(
    lateOrder(edited),
    { late: ["Plan", "case table"], path: "src/a.ts" },
    "the late order is recorded instead",
  );

  assert.ok(evaluate({ ...edited, ledger: { ...edited.ledger, planSeq: null } }).map((u) => u.rule).includes("R2"), "no Plan at all blocks");
  assert.ok(evaluate({ ...edited, ledger: { ...edited.ledger, cases: [] } }).map((u) => u.rule).includes("R2"), "no case table at all blocks");

  const fine = { ...edited, ledger: { ...edited.ledger, planSeq: 1, cases: [{ id: "C1", status: "closed", test: "t", seq: 2 }] } };
  assert.ok(!evaluate(fine).map((u) => u.rule).includes("R2"));
  // `path` names the first source edit whenever there is one, so what says "nothing is
  // late" is an empty `late` list, not a null path.
  assert.deepEqual(lateOrder(fine), { late: [], path: "src/a.ts" }, "a plan written before the first edit is not late");
  assert.deepEqual(lateOrder({ ...fine, events: [] }), { late: [], path: null }, "no source edit at all: nothing to be late against");
});
