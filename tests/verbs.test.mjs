import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, lookedUp, waiveArgs } from "./helpers.mjs";
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
  const lessons = teaches.filter((l) => /gate waive [^`\n]*"<|gate waive <key[^`]*"/.test(l));
  assert.ok(lessons.length > 5, `${lessons.length} lines`);
  for (const line of lessons) assert.match(line, /--user-ok/, line.slice(0, 160));
});
