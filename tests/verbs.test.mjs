import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, lookedUp, waiveArgs, naArgs, abandonArgs } from "./helpers.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { saveLedger } from "../scripts/lib/ledger.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { evaluate, lateOrder, waiverWordsProblem } from "../scripts/lib/rules.mjs";
import { nextHint } from "../scripts/lib/next.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

function cli(repo, verb, args = [], input = "") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" },
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", (({ current, lastClosed }) => current ?? lastClosed)(loadSession(path.join(repo, ".claude", "gate"), "S1")));
const ledgerOf = (repo) => loadLedger(runDir(repo));
const CONTEXT = "Traced: src/a.ts:1 exports a0, read by src/app/page.tsx:1\nRelated: tests/a.test.ts pins a\nResearch: none needed: a fixture";
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
  write(repo, "tests/CourtCard.test.tsx", "test('renders the badge', () => {});\n");
  cli(repo, "case", ["close", "C1", "--test", "tests/CourtCard.test.tsx:renders the badge"]);
  cli(repo, "case", naArgs(repo, "C2", "covered by C1's fixture"));
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
  // only gate note context closes {context} on a stamped ledger, after the lead's lookups
  lookedUp(repo);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "step", ["schema", "skipped", "no schema files touched"]);
  cli(repo, "step", ["6", "na", "nothing to implement in this fixture"]);
  const steps = ledgerOf(repo).steps;
  assert.equal(steps.find((s) => s.key === "context").state, "DONE");
  assert.equal(steps.find((s) => s.key === "context").evidence, "ledger.md#context");
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
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n- none\n");
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
  cli(repo, "waive", waiveArgs(repo, "driver", "skip the phone pass this time, chrome is disconnected"));
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

test("close closes a clean run itself, marks the close step and clears the session's current run", () => {
  const repo = opened("verbs-close", "plan");
  cli(repo, "note", ["task", "t"]);
  cli(repo, "note", ["plan", "p"]);
  lookedUp(repo);
  cli(repo, "note", ["context", CONTEXT]);
  write(runDir(repo), "skeptic-1.md", "# Skeptic 1\n\n## Act on\n- none\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  cli(repo, "step", ["skeptic", "done", "no findings", "--evidence", "ledger.md"]);
  cli(repo, "step", ["implement", "done", "spec written", "--evidence", "docs/notes.md"]);
  const dir = runDir(repo);
  cli(repo, "close");
  assert.equal(loadLedger(dir).status, "closed");
  assert.equal(loadLedger(dir).steps.find((s) => s.key === "close").state, "DONE");
  assert.ok(existsSync(path.join(dir, "report.md")), "close writes the report");
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

test("the verify hints tell the lead to run gate verify with a long Bash timeout, and why", () => {
  const steps = (key) => [{ n: 1, key, text: key, state: null, note: null, evidence: null, seq: 1 }];
  const base = { status: "open", playbook: "refactor", taskSeq: 1, contextSeq: 1, planSeq: 2, cases: [{ id: "C1", status: "closed" }], huddles: [], waivers: [] };
  for (const key of ["verify", "verify-before"]) {
    const h = nextHint({ ...base, steps: steps(key) });
    assert.match(h, /gate verify/, h);
    assert.match(h, /600000/, `${key}: the hint does not name the Bash timeout: ${h}`);
    assert.match(h, /background/, `${key}: the hint does not offer the background run for long verifies: ${h}`);
  }
  {
    const h = nextHint({ ...base, steps: steps("verify") });
    assert.match(h, /minutes/, `the verify hint does not say why: ${h}`);
  }
});

test("the three manifests agree on the version, gate --version prints it, and SKILL.md stays under its byte budget", () => {
  const version = (rel) => JSON.parse(readFileSync(path.join(pluginRoot, rel), "utf8")).version;
  const plugin = version(".claude-plugin/plugin.json");
  assert.match(plugin, /^\d+\.\d+\.\d+$/, plugin);
  assert.equal(version("package.json"), plugin, "package.json version drifted from plugin.json");
  const marketplace = JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin/marketplace.json"), "utf8"));
  const entry = (marketplace.plugins ?? []).find((p) => p.name === "done-gate") ?? marketplace.plugins?.[0];
  assert.equal(entry?.version, plugin, "marketplace.json version drifted from plugin.json");
  const r = spawnSync(process.execPath, [gate, "--version"], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), plugin);
  assert.ok(statSync(path.join(pluginRoot, "skills", "gate", "SKILL.md")).size < 4096, "SKILL.md is over 4096 bytes");
});

test("close refuses an unclean run: exit 1, the unmet list on stdout, the run stays open and the close step is blank again", () => {
  const repo = opened("verbs-close-unclean", "plan");
  cli(repo, "note", ["task", "t"]);
  cli(repo, "note", ["plan", "p"]);
  const r = spawnSync(process.execPath, [gate, "close"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /R8/);
  assert.match(r.stderr, /not closed: \d+ unmet/);
  const l = ledgerOf(repo);
  assert.equal(l.status, "open");
  assert.equal(l.steps.find((s) => s.key === "close").state, null);
});

test("3.6 waive --user-ok stores the words beside the reason; with no words it is refused; with no flag it still records", () => {
  const repo = opened("verbs-waive-words");
  cli(repo, "waive", waiveArgs(repo, "driver", "chrome is disconnected"));
  const [waiver] = ledgerOf(repo).waivers;
  assert.equal(waiver.reason, "chrome is disconnected");
  assert.equal(waiver.words, "you may skip the driver check");

  for (const args of [["schema", "no db", "--user-ok"], ["schema", "no db", "--user-ok", "   "], ["schema", "no db", "--user-ok", "--other"]]) {
    const r = spawnSync(process.execPath, [gate, "waive", ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
    assert.match(r.stderr, /--user-ok/, args.join(" "));
  }
  assert.equal(ledgerOf(repo).waivers.length, 1);

});

// Second part of 3.6: only the user's own words give up a check.
const waive = (repo, ...args) => spawnSync(process.execPath, [gate, "waive", ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
const hook = (repo, payload) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
const says = (repo, prompt) => hook(repo, { hook_event_name: "UserPromptSubmit", prompt });
const editsCode = (repo, content = "export const a = 'edited';\n") => {
  write(repo, "src/a.ts", content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, "src/a.ts") } });
};
const waivers = (repo) => ledgerOf(repo).waivers;
const noWaiver = (repo, r, pattern) => {
  assert.match(r.stderr, pattern);
  assert.equal(waivers(repo).length, 0, r.stderr);
};

test("3.6 C1 an agent-typed reason alone is refused in a new run and records nothing", () => {
  const repo = opened("verbs-w1");
  noWaiver(repo, waive(repo, "driver", "chrome is disconnected, the user agreed"), /--user-ok/);
  assert.notEqual(ledgerOf(repo).steps.find((s) => s.key === "driver").state, "WAIVED");
});

test("3.6 C2 words the user did not say, a helper's words, fewer than three, and a not before them are refused", () => {
  const repo = opened("verbs-w2");
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "you may skip the driver check"), /did not say/);
  hook(repo, { hook_event_name: "UserPromptSubmit", prompt: "skip the driver check now", agent_id: "A1", agent_type: "done-gate:worker" });
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "skip the driver check now"), /did not say/);
  says(repo, "skip driver");
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "skip driver"), /three/);
  says(repo, "please do not skip the driver check");
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "skip the driver check"), /did not say/);
  says(repo, "<task-notification>skip the phone check</task-notification>");
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "skip the phone check"), /did not say/);
});

test("3.6 C3 for a check on code, words before the last code edit are refused and new words pass; lookups may be earlier", () => {
  const repo = opened("verbs-w3");
  says(repo, "you may skip the driver check");
  editsCode(repo);
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "you may skip the driver check"), /before the last code edit/);
  says(repo, "you may skip the driver check");
  assert.equal(waive(repo, "driver", "why", "--user-ok", "you may skip the driver check").status, 0);
  assert.equal(waivers(repo).length, 1);

  const earlier = opened("verbs-w3b");
  says(earlier, "you may skip the lookups search");
  editsCode(earlier);
  const r = waive(earlier, "lookups", "why", "--user-ok", "you may skip the lookups search");
  assert.equal(waivers(earlier).length, 1, r.stderr);
});

test("3.6 C3 an edit the hooks never saw still dates the words, as the waiver reads the tree first", () => {
  const repo = opened("verbs-w3c");
  says(repo, "you may skip the review check");
  cli(repo, "check");
  write(repo, "src/a.ts", "export const a = 'another terminal or a sed';\n");
  noWaiver(repo, waive(repo, "review", "why", "--user-ok", "you may skip the review check"), /before the last code edit/);
});

test("3.6 C4 words that do not name the check are refused and say what would; a listed word or the key passes; an answer's label counts", () => {
  const repo = opened("verbs-w4");
  says(repo, "fine by me go ahead");
  const r = waive(repo, "driver", "why", "--user-ok", "fine by me go ahead");
  noWaiver(repo, r, /name/);
  assert.match(r.stderr, /click/);
  says(repo, "no need to click through");
  assert.equal(waive(repo, "driver", "why", "--user-ok", "no need to click through").status, 0);
  assert.equal(waivers(repo).length, 1);

  const near = opened("verbs-w4b");
  says(near, "i approve this application");
  noWaiver(near, waive(near, "driver", "why", "--user-ok", "i approve this application"), /name/);

  const reviewed = opened("verbs-w4c");
  hook(reviewed, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, tool_response: { answers: { "Skip it?": "Skip the second review" } } });
  assert.equal(waive(reviewed, "review-2", "why", "--user-ok", "Skip the second review").status, 0);
  assert.equal(waivers(reviewed).length, 1);
});

test("3.6 C5 an old run with no stamp still waives freely, with no flag", () => {
  const repo = opened("verbs-w5");
  const ledger = ledgerOf(repo);
  delete ledger.rules;
  saveLedger(runDir(repo), ledger);
  assert.equal(waive(repo, "driver", "no flag at all").status, 0);
  assert.equal(waivers(repo)[0].reason, "no flag at all");
  assert.equal(waivers(repo)[0].words, undefined);
});

test("3.6 C6 the report prints the user's words, in full and in For you", () => {
  const repo = opened("verbs-w6");
  cli(repo, "waive", waiveArgs(repo, "driver", "chrome is disconnected"));
  assert.match(cli(repo, "report").stdout, /waived driver: chrome is disconnected \(the user: "you may skip the driver check"\)/);
  assert.match(cli(repo, "report", ["--brief"]).stdout, /chrome is disconnected \(you said: "you may skip the driver check"\)/);
});

test("3.6 C7 the rule texts, refusals and the skill's waive line name --user-ok, under the byte cap", () => {
  const repo = opened("verbs-w7");
  editsCode(repo);
  const check = cli(repo, "check").stdout;
  for (const line of check.split("\n").filter((l) => /gate waive /.test(l))) assert.match(line, /gate waive [^\n]*--user-ok/, line);
  const skill = readFileSync(path.join(pluginRoot, "skills", "gate", "SKILL.md"), "utf8");
  assert.match(skill, /gate waive <key> "<why>" --user-ok/);
  assert.ok(Buffer.byteLength(skill) < 4096, `${Buffer.byteLength(skill)} bytes`);
});

test("3.6 C8 an unknown key, a key with no waiver and a slop waiver with nothing flagged still say that first", () => {
  const repo = opened("verbs-w8");
  assert.match(waive(repo, "anything-at-all", "x").stderr, /unknown waiver key/);
  assert.match(waive(repo, "verify", "x").stderr, /cannot be waived/);
  assert.match(waive(repo, "slop", "x").stderr, /nothing to waive/);
});

test("3.6 C9 a code change first seen by this waive dates the words as too old, even with a logged command before them", () => {
  const repo = opened("verbs-w9");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm run build" }, tool_response: {} });
  says(repo, "you may skip the review check");
  write(repo, "src/a.ts", "export const a = 'another terminal or a sed';\n");
  noWaiver(repo, waive(repo, "review", "why", "--user-ok", "you may skip the review check"), /before the last code edit/);
  says(repo, "you may skip the review check");
  assert.equal(waive(repo, "review", "why", "--user-ok", "you may skip the review check").status, 0);
  assert.equal(waivers(repo).length, 1);
});

test("3.6 C10 words that say the opposite are refused though the user said them", () => {
  const repo = opened("verbs-w10");
  says(repo, "please do not skip the driver check");
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "do not skip the driver check"), /says not to give it up/);
  says(repo, "never waive the browser pass");
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "never waive the browser pass"), /says not to give it up/);
  for (const words of ["no problem skip the driver check", "i dont care skip the driver check"]) assert.equal(waiverWordsProblem("driver", words), null, words);
  assert.match(waive(repo, "driver").stderr, /^done-gate: usage: gate waive [^\n]*"<their words>"$/m);
  assert.doesNotMatch(waive(repo, "driver").stderr, /--user-ok[^\n]*--user-ok/);
  says(repo, "the app needs no drive today");
  assert.equal(waive(repo, "driver", "why", "--user-ok", "the app needs no drive today").status, 0);
  assert.equal(waivers(repo).length, 1);
});

test("3.6 C11 coverage is a check on code; skeptic and rootcause take earlier words", () => {
  const coverage = opened("verbs-w11");
  says(coverage, "you may skip the coverage check");
  editsCode(coverage);
  noWaiver(coverage, waive(coverage, "coverage", "why", "--user-ok", "you may skip the coverage check"), /before the last code edit/);

  const skeptic = opened("verbs-w11b");
  says(skeptic, "skip the design round please");
  editsCode(skeptic);
  assert.equal(waive(skeptic, "skeptic", "why", "--user-ok", "skip the design round please").status, 0);
  assert.equal(waivers(skeptic).length, 1);

  const bug = opened("verbs-w11c", "bugfix");
  says(bug, "leave the root cause open");
  editsCode(bug);
  assert.equal(waive(bug, "rootcause", "why", "--user-ok", "leave the root cause open").status, 0);
  assert.equal(waivers(bug).length, 1);
});

test("3.6 C12 no line in the gate's code teaches gate waive with a reason and no --user-ok", () => {
  const dir = path.join(pluginRoot, "scripts", "lib");
  const teaches = readdirSync(dir).filter((f) => f.endsWith(".mjs")).flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n"));
  // ending a standing waiver gives nothing up, so it takes no words
  const lessons = teaches.filter((l) => /gate waive (?!--end)[^`\n]*"<|gate waive <key[^`]*"/.test(l));
  assert.ok(lessons.length > 5, `${lessons.length} lines`);
  for (const line of lessons) assert.match(line, /--user-ok/, line.slice(0, 160));
});

// Batch 3.7: a waiver on code covers that code only; tests are not waived; and a surface that could
// not run says so.
const check = (repo) => cli(repo, "check").stdout;
const ruleIn = (out, rule) => new RegExp(`\\b${rule}\\b`).test(out);
const stepState = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key).state;
const gitIn = (repo, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
const committed = (name, files = {}) => {
  const repo = makeRepo(name, { ".gitignore": "node_modules/\nignored.txt\n.claude/gate/\n", ...files });
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "base");
  return repo;
};
const uiChanged = (name) => {
  const repo = opened(name);
  write(repo, "src/app/page.tsx", "export default () => 1;\n");
  cli(repo, "check");
  return repo;
};
const age = (repo) => {
  const ledger = ledgerOf(repo);
  delete ledger.rules;
  saveLedger(runDir(repo), ledger);
};

test("3.7 C1 an edit lapses a driver waiver: R4 returns, the step goes blank, the record stays marked lapsed", () => {
  const repo = uiChanged("verbs-l1");
  cli(repo, "waive", waiveArgs(repo, "driver", "chrome is disconnected"));
  assert.equal(ruleIn(check(repo), "R4"), false);
  write(repo, "src/app/page.tsx", "export default () => 2;\n");
  assert.equal(ruleIn(check(repo), "R4"), true);
  assert.equal(stepState(repo, "driver"), null);
  const [w] = waivers(repo);
  assert.equal(w.lapsed, true);
  assert.equal(w.reason, "chrome is disconnected");
});

test("3.7 C2 a test-only edit does not lapse it, and no assess right after the waiver does", () => {
  const repo = uiChanged("verbs-l2");
  cli(repo, "waive", waiveArgs(repo, "driver", "chrome is disconnected"));
  check(repo);
  check(repo);
  assert.equal(waivers(repo)[0].lapsed, undefined);
  write(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  assert.equal(ruleIn(check(repo), "R4"), false);
  assert.equal(waivers(repo)[0].lapsed, undefined);
  assert.equal(stepState(repo, "driver"), "WAIVED");
});

test("3.7 C3 a later waiver with new words clears the lapsed check", () => {
  const repo = uiChanged("verbs-l3");
  cli(repo, "waive", waiveArgs(repo, "driver", "first"));
  write(repo, "src/app/page.tsx", "export default () => 2;\n");
  check(repo);
  cli(repo, "waive", waiveArgs(repo, "driver", "second"));
  assert.equal(ruleIn(check(repo), "R4"), false);
  assert.equal(stepState(repo, "driver"), "WAIVED");
  assert.deepEqual(waivers(repo).map((w) => w.lapsed ?? false), [true, false]);
});

test("3.7 C4 an old waiver with no code never lapses", () => {
  const repo = uiChanged("verbs-l4");
  age(repo);
  cli(repo, "waive", ["driver", "an old run's waiver"]);
  assert.equal(waivers(repo)[0].code, undefined);
  write(repo, "src/app/page.tsx", "export default () => 2;\n");
  assert.equal(ruleIn(check(repo), "R4"), false);
  assert.equal(waivers(repo)[0].lapsed, undefined);
});

test("3.7 C5 the report lists a lapsed waiver as lapsed, not as skipped with your OK, and stats counts both kinds", () => {
  const repo = uiChanged("verbs-l5");
  cli(repo, "waive", waiveArgs(repo, "driver", "chrome is disconnected"));
  write(repo, "src/app/page.tsx", "export default () => 2;\n");
  check(repo);
  const full = cli(repo, "report").stdout;
  assert.match(full, /waived driver: chrome is disconnected[^\n]*lapsed/);
  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.doesNotMatch(brief, /skipped with your OK: chrome is disconnected/);
  assert.match(brief, /no longer holds/);

  const closed = opened("verbs-l5b");
  const ledger = ledgerOf(closed);
  saveLedger(runDir(closed), { ...ledger, status: "closed", closedAt: new Date().toISOString(), waivers: [{ key: "driver", reason: "a", lapsed: true }, { key: "schema", reason: "b", could: true }, { key: "driver", reason: "c" }] });
  const stats = cli(closed, "stats").stdout;
  assert.match(stats, /could-not-run waivers: 1/);
  assert.match(stats, /lapsed waivers: 1/);
});

test("3.7 C6 in a run with a tests step tests, qa and R7 are refused, pointing at qa-pass", () => {
  const repo = opened("verbs-t1");
  editsCode(repo);
  for (const key of ["tests", "qa", "R7"]) {
    says(repo, `you may skip the ${key} check`);
    const r = waive(repo, key, "why", "--user-ok", `you may skip the ${key} check`);
    assert.match(r.stderr, /cannot be waived/, key);
    assert.match(r.stderr, /qa-pass/, key);
  }
  assert.equal(waivers(repo).length, 0);
  assert.equal(ruleIn(check(repo), "R7"), true);
});

test("3.7 C7 a version bump and CSS need no test; one .ts beside them fires R7, and its text offers no waiver", () => {
  const bump = opened("verbs-t2");
  write(bump, "package.json", JSON.stringify({ name: "x", version: "2.0.0" }));
  write(bump, "src/app.css", "a { color: red; }\n");
  write(bump, "src/logo.png", "not really a png\n");
  write(bump, "config.yaml", "a: 1\n");
  assert.equal(ruleIn(check(bump), "R7"), false);

  write(bump, "src/a.ts", "export const a = 'code';\n");
  const line = check(bump).split("\n").find((l) => /\bR7\b/.test(l));
  assert.ok(line, "one .ts brings R7 back");
  assert.match(line, /src\/a\.ts/);
  assert.doesNotMatch(line, /package\.json/);
  assert.doesNotMatch(line, /gate waive/);
});

test("3.7 C8 a plan run may still waive tests, an old run may too, and an old qa waiver still counts", () => {
  const plan = opened("verbs-t3", "plan");
  editsCode(plan);
  assert.match(check(plan), /gate waive tests/);
  cli(plan, "waive", waiveArgs(plan, "tests", "a throwaway prototype"));
  assert.equal(ruleIn(check(plan), "R7"), false);

  const old = opened("verbs-t4");
  age(old);
  editsCode(old);
  assert.match(check(old), /gate waive tests/);
  cli(old, "waive", ["tests", "an old run's waiver"]);
  assert.equal(ruleIn(check(old), "R7"), false);

  const qa = opened("verbs-t5");
  age(qa);
  editsCode(qa);
  cli(qa, "waive", ["qa", "an older ledger's key"]);
  assert.equal(ruleIn(check(qa), "R7"), false);
});

const couldNotRun = (repo, key, reason) => {
  const args = waiveArgs(repo, key, reason);
  return cli(repo, "waive", [...args, "--could-not-run"]);
};

test("3.7 C9 --could-not-run needs the user's words, clears R4 and R6, lapses on an edit, and R8 does not call it blank", () => {
  const repo = uiChanged("verbs-c1");
  assert.match(waive(repo, "driver", "chrome is down", "--could-not-run").stderr, /--user-ok/);
  couldNotRun(repo, "driver", "chrome is down");
  assert.equal(stepState(repo, "driver"), "COULD NOT RUN");
  const out = check(repo);
  assert.equal(ruleIn(out, "R4"), false);
  assert.doesNotMatch(out, /\{driver\}/);
  write(repo, "src/app/page.tsx", "export default () => 2;\n");
  assert.equal(ruleIn(check(repo), "R4"), true);
  assert.equal(stepState(repo, "driver"), null);

  const schema = makeRepo("verbs-c2", { ".claude/gate.json": JSON.stringify({ testFiles: null, schema: ["db/**"], source: ["db/**", "src/**"] }), "db/001.sql": "select 1;\n" });
  cli(schema, "open", ["t", "feature"]);
  write(schema, "db/001.sql", "select 2;\n");
  assert.equal(ruleIn(check(schema), "R6"), true);
  couldNotRun(schema, "schema", "no database here");
  assert.equal(ruleIn(check(schema), "R6"), false);
  assert.equal(stepState(schema, "schema"), "COULD NOT RUN");
});

test("3.7 C10 the summary, Steps and For you say could not run with the user's words, and never N/A", () => {
  const repo = uiChanged("verbs-c3");
  couldNotRun(repo, "driver", "chrome is down");
  const full = cli(repo, "report").stdout;
  assert.match(full, /COULD NOT RUN 1/);
  assert.match(full, /\*\*COULD NOT RUN\*\*/);
  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.match(brief, /could not run[^\n]*chrome is down[^\n]*you said: "you may skip the driver check"/);
  assert.doesNotMatch(brief, /skipped with your OK: chrome is down/);
  assert.doesNotMatch(full, /driver[^\n]*N\/A/);
});

test("3.7 C11 --could-not-run is refused on any key but driver and schema", () => {
  const repo = opened("verbs-c4");
  says(repo, "you may skip the review check");
  const r = waive(repo, "review", "why", "--user-ok", "you may skip the review check", "--could-not-run");
  assert.match(r.stderr, /--could-not-run/);
  assert.match(r.stderr, /driver/);
  assert.equal(waivers(repo).length, 0);
});

test("3.7 C12 another session's commit folded with no stamp keeps the waiver: the task's code did not move", () => {
  const repo = committed("verbs-l6", { "src/other.ts": "export const o = 1;\n" });
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/app/page.tsx", "export default () => 1;\n");
  cli(repo, "check");
  cli(repo, "waive", waiveArgs(repo, "driver", "chrome is disconnected"));
  write(repo, "src/other.ts", "export const o = 'another session';\n");
  gitIn(repo, "add", "src/other.ts");
  gitIn(repo, "commit", "-qm", "another session's work");
  assert.equal(ruleIn(check(repo), "R4"), false);
  assert.equal(waivers(repo)[0].lapsed, undefined);
  assert.deepEqual(ledgerOf(repo).foreign, ["src/other.ts"]);
  write(repo, "src/app/page.tsx", "export default () => 2;\n");
  assert.equal(ruleIn(check(repo), "R4"), true, "the task's own edit still lapses it");
});

test("3.7 C13 a change with no code runs through to gate close; the hints name how; a large lockfile asks for no QA pass", () => {
  const repo = committed("verbs-t6");
  cli(repo, "open", ["t", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Bump the version. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "A version bump.", "--files", "package.json"]);
  cli(repo, "case", ["add", "the version reads 2.0.0", "--kind", "happy"]);
  assert.match(cli(repo, "next").stdout, /gate step tests na/);
  write(repo, "package.json", JSON.stringify({ name: "verbs-t6", version: "2.0.0", scripts: { lint: "true", test: "true", build: "true" } }));
  cli(repo, "step", ["tests", "na", "a version bump holds no code"]);
  cli(repo, "step", ["implement", "done", "bumped", "--evidence", "package.json"]);
  cli(repo, "case", naArgs(repo, "C1", "read the file"));
  cli(repo, "verify");
  for (const key of ["skeptic", "driver", "schema", "review"]) spawnSync(process.execPath, [gate, "step", key, "na", "a version bump"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
  cli(repo, "close");
  assert.equal(ledgerOf(repo).status, "closed");

  const big = opened("verbs-t7");
  write(big, "package-lock.json", JSON.stringify(Array.from({ length: 2000 }, (_, i) => `line ${i}`), null, 1));
  const out = check(big);
  assert.equal(ruleIn(out, "R7"), false, out);
});

// Batch 3.8: a recommended answer is not consent, and a planned case, the last test command and a
// test pointer each need something real behind them.
const answers = (repo, label) => hook(repo, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, tool_response: { answers: { "Which way?": label } } });
const question = (question, label, description = "") => ({ tool_name: "AskUserQuestion", tool_input: { questions: [{ question, options: [{ label, description }, { label: "Other way", description: "" }] }] } });
const NEW = { rules: 1 };
const closeCase = (repo, ...args) => spawnSync(process.execPath, [gate, "case", "close", ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
const caseOf = (repo, id = "C1") => ledgerOf(repo).cases.find((c) => c.id === id);
const planned = (name) => {
  const repo = opened(name);
  cli(repo, "case", ["add", "the badge renders", "--kind", "happy"]);
  return repo;
};

test("3.8 C1 an answer holding (Recommended) is not a waiver's words; a plain answer is", () => {
  const repo = opened("verbs-r1");
  answers(repo, "Skip the driver check (Recommended)");
  noWaiver(repo, waive(repo, "driver", "why", "--user-ok", "Skip the driver check"), /did not say/);
  answers(repo, "Skip the driver check");
  assert.equal(waive(repo, "driver", "why", "--user-ok", "Skip the driver check").status, 0);
  assert.equal(waivers(repo).length, 1);
});

test("3.8 C2 the fence refuses a (Recommended) option that skips a check, waives one or abandons a run", () => {
  const root = makeRepo("verbs-r2");
  for (const q of [
    question("How do we handle the rebase?", "Skip the review for rebases (Recommended)"),
    question("How do we go on?", "Waive the driver step (Recommended)"),
    question("Ship it?", "Ship without tests (Recommended)"),
    question("Next?", "Go on (Recommended)", "gives up the schema probe"),
    question("Next?", "Abandon this run (Recommended)"),
    question("What now?", "Drop this run (Recommended)"),
  ]) {
    const verdict = decide(q, root, null, null, NEW);
    assert.equal(verdict.deny, true, JSON.stringify(q));
    assert.match(verdict.reason, /\(Recommended\)/);
  }
  const hooks = JSON.parse(readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.PreToolUse.some((h) => /AskUserQuestion/.test(h.matcher)));
});

test("4.6 C10 a recommendation to abandon or drop a run is refused even with no run open", () => {
  const root = makeRepo("verbs-46-c10");
  for (const label of ["Abandon this run (Recommended)", "Drop this run (Recommended)"]) {
    assert.equal(decide(question("What now?", label), root, null, null, null).deny, true, label);
  }
  assert.equal(decide(question("Which migration?", "Drop the users column (Recommended)"), root, null, null, null).deny, false);
});

test("3.8 C3 a recommendation that gives up no check passes; a bare yes on a question skipping one is refused; an old run or no run passes", () => {
  const root = makeRepo("verbs-r3");
  for (const q of [
    question("Which migration?", "Drop the users column (Recommended)"),
    question("Should I skip the review?", "No, keep the review (Recommended)"),
    question("Which test runner?", "Vitest (Recommended)"),
  ]) assert.equal(decide(q, root, null, null, NEW).deny, false, JSON.stringify(q));
  const bare = question("Should I skip the review?", "Yes (Recommended)");
  assert.equal(decide(bare, root, null, null, NEW).deny, true);
  const giving = question("How do we handle the rebase?", "Skip the review for rebases (Recommended)");
  assert.equal(decide(giving, root, null, null, {}).deny, false, "old run");
  assert.equal(decide(giving, root, null, null, null).deny, false, "no run");
});

test("3.8 C4 --na on a planned case needs the user's words; with them it closes and the report shows them", () => {
  const repo = planned("verbs-n1");
  assert.match(closeCase(repo, "C1", "--na", "covered elsewhere").stderr, /--user-ok/);
  assert.equal(caseOf(repo).status, "open");
  assert.match(closeCase(repo, "C1", "--na", "covered elsewhere", "--user-ok", "no case for this one").stderr, /did not say/);
  answers(repo, "No case for this one (Recommended)");
  assert.match(closeCase(repo, "C1", "--na", "covered elsewhere", "--user-ok", "No case for this one").stderr, /did not say/);
  says(repo, "no case for this one");
  assert.equal(closeCase(repo, "C1", "--na", "covered elsewhere", "--user-ok", "no case for this one").status, 0);
  assert.equal(caseOf(repo).status, "closed");
  assert.equal(caseOf(repo).words, "no case for this one");
  assert.match(cli(repo, "report").stdout, /n\/a: covered elsewhere \(the user: "no case for this one"\)/);
});

test("3.8 C5 a case written after the first code edit stays free with --na, and an old run is unchanged", () => {
  const later = opened("verbs-n2");
  editsCode(later);
  cli(later, "case", ["add", "found while building", "--kind", "edge"]);
  assert.equal(closeCase(later, "C1", "--na", "covered by the fix").status, 0);

  const old = planned("verbs-n3");
  age(old);
  assert.equal(closeCase(old, "C1", "--na", "covered elsewhere").status, 0);
});

test("3.8 C6 --ran closes a case on the lead's successful recorded run, with no words, and shows in the table", () => {
  const repo = planned("verbs-a1");
  const runs = (extra = {}, event = "PostToolUse", command = "node probe.mjs measured") => hook(repo, { hook_event_name: event, tool_name: "Bash", tool_input: { command }, ...(event === "PostToolUse" ? { tool_response: {} } : { tool_error: "Exit code 1" }), ...extra });
  runs({}, "PostToolUseFailure");
  assert.match(closeCase(repo, "C1", "--ran", "probe.mjs measured").stderr, /recorded/);
  runs({ agent_id: "A1", agent_type: "done-gate:reviewer" });
  assert.match(closeCase(repo, "C1", "--ran", "probe.mjs measured").stderr, /recorded/);
  assert.match(closeCase(repo, "C1", "--ran", "abc").stderr, /four characters/);
  runs();
  assert.equal(closeCase(repo, "C1", "--ran", "probe.mjs measured").status, 0);
  assert.equal(caseOf(repo).status, "closed");
  assert.match(caseOf(repo).event, /^events#\d+$/);
  assert.match(cli(repo, "report").stdout, /probe\.mjs measured/);

  cli(repo, "case", ["add", "the tab opens", "--kind", "click"]);
  assert.match(closeCase(repo, "C2", "--ran", "probe.mjs measured").stderr, /click/);
});

test("3.8 C7 --drop of the last configured test command needs words; add then drop, a lint drop and one of two stay free; an old run is unchanged", () => {
  const verifyWith = (name, verify) => {
    const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ testFiles: null, verify }) });
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "base");
    cli(repo, "open", ["t", "feature"]);
    return repo;
  };
  const drop = (repo, ...args) => spawnSync(process.execPath, [gate, "verify", "--drop", ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
  const last = verifyWith("verbs-d1", ["npx eslint .", "npx vitest run"]);
  assert.match(drop(last, "npx vitest run").stderr, /--user-ok/);
  assert.equal(ledgerOf(last).verifyDropped, undefined);
  assert.match(drop(last, "npx vitest run", "--user-ok", "drop the test suite").stderr, /did not say/);
  says(last, "drop the test suite");
  assert.equal(drop(last, "npx vitest run", "--user-ok", "drop the test suite").status, 0);
  assert.deepEqual(ledgerOf(last).verifyDropped, ["npx vitest run"]);
  assert.match(cli(last, "report").stdout, /npx vitest run[^\n]*the user: "drop the test suite"/);

  const lint = verifyWith("verbs-d2", ["npx eslint .", "npx vitest run"]);
  assert.equal(drop(lint, "npx eslint .").status, 0);

  const two = verifyWith("verbs-d3", ["npx vitest run a", "npx jest b"]);
  assert.equal(drop(two, "npx jest b").status, 0);

  const added = verifyWith("verbs-d4", ["npx eslint ."]);
  cli(added, "verify", ["--add", "npx vitest run"]);
  assert.equal(drop(added, "npx vitest run").status, 0);

  const old = verifyWith("verbs-d5", ["npx vitest run"]);
  age(old);
  assert.equal(drop(old, "npx vitest run").status, 0);
});

test("3.8 C8 --test refuses a pointer whose file does not exist or names no file; file:line and file:name pass; an old run is unchanged", () => {
  const repo = planned("verbs-p1");
  for (const pointer of ["tests/nothing-here.test.mjs:no such test", "tests/nothing-here.test.mjs", "the tests pass"]) {
    assert.match(closeCase(repo, "C1", "--test", pointer).stderr, /does not exist|no test file/, pointer);
    assert.equal(caseOf(repo).status, "open", pointer);
  }
  assert.equal(closeCase(repo, "C1", "--test", "tests/a.test.ts:12").status, 0);
  cli(repo, "case", ["add", "another", "--kind", "edge"]);
  assert.equal(closeCase(repo, "C2", "--test", "tests/a.test.ts:the named test").status, 0);
  cli(repo, "case", ["add", "a third", "--kind", "edge"]);
  assert.equal(closeCase(repo, "C3", "--test", "tests/a.test.ts::named").status, 0);

  const old = planned("verbs-p2");
  age(old);
  assert.equal(closeCase(old, "C1", "--test", "tests/nothing-here.test.mjs:no such test").status, 0);
});

test("3.8 C9 a run from before the last edit cannot close a case, one run closes one case, and an edit opens it again", () => {
  const repo = planned("verbs-a2");
  cli(repo, "case", ["add", "another", "--kind", "edge"]);
  const runs = (command) => hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: {} });
  runs("node probe.mjs before");
  editsCode(repo);
  assert.match(closeCase(repo, "C1", "--ran", "probe.mjs before").stderr, /after the last edit/);
  runs("node probe.mjs after");
  assert.equal(closeCase(repo, "C1", "--ran", "probe.mjs after").status, 0);
  assert.match(closeCase(repo, "C2", "--ran", "probe.mjs after").stderr, /no other case holds/);
  editsCode(repo, "export const a = 'again';\n");
  assert.match(check(repo), /C1/);
  assert.match(cli(repo, "report").stdout, /open: edited after the run/);
  runs("node probe.mjs third");
  assert.equal(closeCase(repo, "C1", "--ran", "probe.mjs third").status, 0);
  assert.doesNotMatch(check(repo).split("\n").find((l) => /not closed/.test(l)) ?? "", /C1\b/);
});

test("3.8 C10 a run another case closed on stays free for a click case, and amending clears a case's run and words", () => {
  const config = { testFiles: null, driver: "cmd:npm run e2e" };
  const repo = makeRepo("verbs-a3", { ".claude/gate.json": JSON.stringify(config) });
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "case", ["add", "a measured thing", "--kind", "performance"]);
  cli(repo, "case", ["add", "the tab opens", "--kind", "click"]);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm run e2e" }, tool_response: {} });
  assert.equal(closeCase(repo, "C1", "--ran", "npm run e2e").status, 0);
  assert.equal(closeCase(repo, "C2", "--click").status, 0, "the driver run stays free for the click case");
  cli(repo, "case", ["amend", "C1", "a better wording"]);
  assert.equal(caseOf(repo).ran, undefined);
  assert.equal(caseOf(repo).event, undefined);

  const na = planned("verbs-a4");
  says(na, "no case for this one");
  closeCase(na, "C1", "--na", "covered", "--user-ok", "no case for this one");
  cli(na, "case", ["amend", "C1", "a better wording"]);
  assert.equal(caseOf(na).words, undefined);
});

test("3.8 C11 a Recommended answer is no words for skipping a search either", () => {
  const repo = opened("verbs-s1");
  answers(repo, "Carry on without socraticode (Recommended)");
  const refused = spawnSync(process.execPath, [gate, "note", "context", CONTEXT, "--no-code", "socraticode: not indexed", "--user-ok", "Carry on without socraticode"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
  assert.match(refused.stderr, /did not say/);
});

test("3.8 C12 the words for --na come after the case and do not say the opposite; the words for --drop name the tests", () => {
  const repo = opened("verbs-n4");
  says(repo, "no case for this one");
  cli(repo, "case", ["add", "written later", "--kind", "happy"]);
  assert.match(closeCase(repo, "C1", "--na", "covered", "--user-ok", "no case for this one").stderr, /after this case was written/);
  says(repo, "do not skip this case");
  assert.match(closeCase(repo, "C1", "--na", "covered", "--user-ok", "do not skip this case").stderr, /says not to give it up/);

  const drop = makeRepo("verbs-d6", { ".claude/gate.json": JSON.stringify({ testFiles: null, verify: ["npx vitest run"] }) });
  cli(drop, "open", ["t", "feature"]);
  says(drop, "fine by me go ahead");
  const r = spawnSync(process.execPath, [gate, "verify", "--drop", "npx vitest run", "--user-ok", "fine by me go ahead"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: drop, DONE_GATE_SESSION: "S1" } });
  assert.match(r.stderr, /does not name/);
});

test("3.8 C13 a related entry counts as a test command, and an added test command left behind makes the drop free until it goes too", () => {
  const dropIn = (repo, ...args) => spawnSync(process.execPath, [gate, "verify", "--drop", ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } });
  const related = makeRepo("verbs-d7", { ".claude/gate.json": JSON.stringify({ testFiles: "npx vitest run {files}", verify: [{ related: true }, "npx eslint ."] }) });
  cli(related, "open", ["t", "feature"]);
  assert.match(dropIn(related, "related tests").stderr, /--user-ok/);

  const beside = makeRepo("verbs-d8", { ".claude/gate.json": JSON.stringify({ testFiles: "npx vitest run {files}", verify: [{ related: true }, "npx jest"] }) });
  cli(beside, "open", ["t", "feature"]);
  assert.equal(dropIn(beside, "npx jest").status, 0, "the related entry is still a test command");

  const swapped = makeRepo("verbs-d9", { ".claude/gate.json": JSON.stringify({ testFiles: null, verify: ["npx vitest run"] }) });
  cli(swapped, "open", ["t", "feature"]);
  cli(swapped, "verify", ["--add", "npx jest"]);
  assert.equal(dropIn(swapped, "npx vitest run").status, 0);
  assert.match(dropIn(swapped, "npx jest").stderr, /--user-ok/, "the second drop leaves none");
});

test("3.8 C14 common give-up shapes are refused, several questions are read, and malformed input never throws", () => {
  const root = makeRepo("verbs-r4");
  for (const q of [
    question("Should I skip the review?", "Yes, skip it (Recommended)"),
    question("Should I run the review?", "No (Recommended)"),
    question("Skip the tests here?", "Go ahead (Recommended)"),
    question("Skip the tests here?", "OK (Recommended)"),
    question("Skip the drive?", "Sure (Recommended)"),
    question("Skip the drive?", "Proceed (Recommended)"),
  ]) assert.equal(decide(q, root, null, null, NEW).deny, true, JSON.stringify(q));
  const several = { tool_name: "AskUserQuestion", tool_input: { questions: [question("Which runner?", "Vitest (Recommended)").tool_input.questions[0], question("Next?", "Skip the review (Recommended)").tool_input.questions[0]] } };
  assert.equal(decide(several, root, null, null, NEW).deny, true);
  assert.equal(decide(question("Should I run the review?", "Yes (Recommended)"), root, null, null, NEW).deny, false, "a yes to running it");
  for (const tool_input of [undefined, {}, { questions: "x" }, { questions: [null] }, { questions: [{ options: "x" }] }, { questions: [{ options: [null] }] }]) {
    assert.equal(decide({ tool_name: "AskUserQuestion", tool_input }, root, null, null, NEW).deny, false, JSON.stringify(tool_input));
  }
});

test("3.8 C15 --na with --test or with --click still needs the words on a planned case", () => {
  const repo = planned("verbs-n5");
  assert.match(closeCase(repo, "C1", "--test", "tests/a.test.ts:a", "--na", "why").stderr, /--user-ok/);
  cli(repo, "case", ["add", "the tab opens", "--kind", "click"]);
  assert.match(closeCase(repo, "C2", "--click", "--na", "why").stderr, /--user-ok/);
});

test("3.8 C16 hints, usage, help and the README name --ran and the user's words on --na", () => {
  const repo = planned("verbs-h1");
  const usage = spawnSync(process.execPath, [gate, "case", "close", "C1"], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" } }).stderr;
  assert.match(usage, /--ran/);
  assert.match(usage, /--user-ok/);
  const r8 = check(repo).split("\n").find((l) => /not closed/.test(l)) ?? "";
  assert.match(r8, /--ran/);
  assert.match(r8, /--user-ok/);
  assert.match(cli(repo, "help").stdout, /--ran/);
  const readme = readFileSync(path.join(pluginRoot, "README.md"), "utf8");
  assert.match(readme, /case close C<n> --ran/);
});

test("3.8 C17 an earlier run's edit in the same session does not make this run's cases late", () => {
  const repo = opened("verbs-n6");
  editsCode(repo);
  cli(repo, "abandon", abandonArgs(repo, "t", "this case needs a second run"));
  cli(repo, "open", ["t2", "feature"]);
  cli(repo, "case", ["add", "planned in the second run", "--kind", "happy"]);
  assert.match(closeCase(repo, "C1", "--na", "covered").stderr, /--user-ok/);
});
