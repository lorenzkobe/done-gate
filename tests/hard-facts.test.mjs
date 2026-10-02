import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo, gate, pluginRoot } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { nextHint } from "../scripts/lib/next.mjs";

// A step that claims something was run closes on the recorded run; a pointer resolves; a
// context note cites real lines and real dependants; a finding that cites nothing real is flagged.

const REFUSAL = /^done-gate: /m;
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));
const stepOf = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key);

function run(repo, verb, args = [], input = "") {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" },
  });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.notEqual(r.status, 0, `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.match(r.stderr, REFUSAL);
  return r.stderr;
}
// The PostToolUse hook for a Bash call by the lead; returns the seq it was recorded under.
function logged(repo, payload) {
  assert.equal(run(repo, "log", [], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PostToolUse", ...payload })).status, 0);
  return readEvents(stateDir(repo), "S1").pop().seq;
}
function ranCommand(repo, command, exit = 1, extra = {}) {
  return logged(repo, { tool_name: "Bash", tool_input: { command, ...extra.input }, tool_response: { exit_code: exit }, ...extra.payload });
}
function committed(name) {
  const repo = makeRepo(name);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
function opened(name, playbook = "bugfix") {
  const repo = committed(name);
  cli(repo, "open", ["t", playbook]);
  return repo;
}
const context = ({ traced = "src/a.ts:1 exports a, read by src/app/page.tsx:1", related = "tests/a.test.ts pins a" } = {}) =>
  [`Traced: ${traced}`, `Related: ${related}`, "Research: none needed: a one-line constant change."].join("\n");

test("C1 happy: gate step repro done --ran closes on the newest matching command recorded after the run opened and stores events#<seq>", () => {
  const repo = opened("hf-c1");
  ranCommand(repo, "npm test -- badge");
  const seq = ranCommand(repo, "npm test -- badge");
  const out = cli(repo, "step", ["repro", "done", "the badge test fails with null venue", "--ran", "npm test -- badge"]);
  assert.match(out, new RegExp(`events#${seq}`), out);
  assert.equal(stepOf(repo, "repro").state, "DONE");
  assert.equal(stepOf(repo, "repro").evidence, `events#${seq}`);
});

test("C2 reported-surface: gate step repro done --evidence decisions#1 or a file path is refused and the refusal names --ran", () => {
  const repo = opened("hf-c2");
  cli(repo, "decide", ["repro", "reproduced it", "saw it fail", "ledger.md", "open"]);
  for (const ptr of ["decisions#1", "src/a.ts:1"]) {
    const err = refused(repo, "step", ["repro", "done", "reproduced", "--evidence", ptr]);
    assert.match(err, /--ran/, err);
  }
  assert.equal(stepOf(repo, "repro").state ?? null, null, "a refused close was stored");
});

test("C3 boundary: --ran text that matches only a command recorded before the run opened, or none, is refused", () => {
  const repo = committed("hf-c3");
  ranCommand(repo, "npm test -- early");
  cli(repo, "open", ["t", "bugfix"]);
  refused(repo, "step", ["repro", "done", "fails", "--ran", "npm test -- early"]);
  refused(repo, "step", ["repro", "done", "fails", "--ran", "never typed"]);
  ranCommand(repo, "ls");
  assert.match(refused(repo, "step", ["repro", "done", "fails", "--ran", "l"]), /four/);
  assert.equal(stepOf(repo, "repro").state ?? null, null);
});

test("C4 refused: gate step rootcause done needs a resolving file:line in its note as well as a recorded run", () => {
  const repo = opened("hf-c4");
  ranCommand(repo, "node probe.mjs");
  const noPointer = refused(repo, "step", ["rootcause", "done", "the venue is null for old rows", "--ran", "node probe.mjs"]);
  assert.match(noPointer, /file:line/, noPointer);
  refused(repo, "step", ["rootcause", "done", "src/a.ts:999 reads the wrong column", "--ran", "node probe.mjs"]);
  refused(repo, "step", ["rootcause", "done", "src/a.ts:3 reads the wrong column", "--evidence", "src/a.ts:3"]);
  cli(repo, "step", ["rootcause", "done", "src/a.ts:3 reads the wrong column", "--ran", "node probe.mjs"]);
  assert.equal(stepOf(repo, "rootcause").state, "DONE");
});

test("C5 refused: gate step schema done with a prose pointer is refused; --evidence events#<seq> of a recorded command closes it", () => {
  const repo = opened("hf-c5", "feature");
  const seq = ranCommand(repo, "curl -s localhost:3000/api/courts", 0);
  refused(repo, "step", ["schema", "done", "hit the endpoint", "--evidence", "ran the query in dev"]);
  refused(repo, "step", ["schema", "done", "hit the endpoint", "--evidence", "events#99999"]);
  cli(repo, "step", ["schema", "done", "hit the endpoint", "--evidence", `events#${seq}`]);
  assert.equal(stepOf(repo, "schema").evidence, `events#${seq}`);
});

test("C6 refused: gate step implement done --evidence nope-nothing is refused; a file that exists is accepted", () => {
  const repo = opened("hf-c6", "feature");
  const err = refused(repo, "step", ["implement", "done", "built it", "--evidence", "nope-nothing"]);
  assert.match(err, /nope-nothing/, err);
  cli(repo, "step", ["implement", "done", "built it", "--evidence", "src/a.ts"]);
  assert.equal(stepOf(repo, "implement").state, "DONE");
});

test("C7 boundary: gate note context refuses a Traced pointer past the end of its file or to a missing file, and names it", () => {
  const repo = opened("hf-c7", "feature");
  cli(repo, "note", ["task", "Do the thing."]);
  const past = refused(repo, "note", ["context", context({ traced: "src/a.ts:1 exports a; src/a.ts:21 is the caller" })]);
  assert.match(past, /src\/a\.ts:21/, past);
  assert.match(refused(repo, "note", ["context", context({ traced: "src/a.ts:1 exports a, read by gone.ts:4" })]), /gone\.ts:4/);
  const missing = refused(repo, "note", ["context", context({ traced: "src/a.ts:1 exports a, read by src/gone.ts:4" })]);
  assert.match(missing, /src\/gone\.ts:4/, missing);
  cli(repo, "note", ["context", context({ traced: "src/a.ts:20 is the last line" })]);
  writeFileSync(path.join(repo, "src/app/page.tsx"), "one\ntwo\n");
  execFileSync("mkdir", ["-p", path.join(repo, "src/app/[slug]/(tabs)")]);
  writeFileSync(path.join(repo, "src/app/[slug]/(tabs)/page.tsx"), "one\ntwo\n");
  cli(repo, "note", ["context", context({ traced: "the route (src/app/[slug]/(tabs)/page.tsx:2) renders a" })]);
  assert.match(refused(repo, "note", ["context", context({ traced: "src/app/[slug]/(tabs)/page.tsx:3" })]), /\[slug\]\/\(tabs\)\/page\.tsx:3/);
  cli(repo, "note", ["context", context({ traced: "ranEvents(src/a.ts:2) accepts; see [a.ts](src/a.ts:1) and x(src/app/[slug]/(tabs)/page.tsx:2); rows[0].id:1 is code" })]);
  assert.match(refused(repo, "note", ["context", context({ traced: "fn(src/gone.ts:2) and ([slug]/gone.tsx:9)" })]), /Traced: src\/gone\.ts:2, \[slug\]\/gone\.tsx:9 does/);
});

test("C8 refused: gate note context refuses a Related part that names no existing file and is not none: with a backticked search", () => {
  const repo = opened("hf-c8", "feature");
  cli(repo, "note", ["task", "Do the thing."]);
  for (const related of ["nothing else depends on it", "none", "none: I looked around", "src/gone.ts reads it"]) {
    const err = refused(repo, "note", ["context", context({ related })]);
    assert.match(err, /Related/, err);
  }
  cli(repo, "note", ["context", context({ related: "none: `grep -rn a0 src tests` finds src/a.ts only" })]);
  cli(repo, "note", ["context", context({ related: "docs/notes.md describes the page." })]);
});

test("C9 edge: gate huddle add notes an Act-on finding whose only file:line does not resolve and stores unresolved on it", () => {
  const repo = opened("hf-c9", "feature");
  cli(repo, "note", ["task", "Do the thing."]);
  cli(repo, "note", ["context", context()]);
  cli(repo, "note", ["plan", "One constant changes; no hot path.", "--files", "src/a.ts,src/app/page.tsx"]);
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), [
    "# Skeptic 1 — t", "", "## Act on",
    "- the plan misses a second caller — src/gone.ts:12",
    "- a0 is read by the page — src/app/page.tsx:1",
    "- the ask names no size", "## Consider", "- none", "## Noted", "- none", "## The one question", "- none", "",
  ].join("\n"));
  const out = cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  assert.match(out, /H1\.1[^\n]*src\/gone\.ts:12[^\n]*does not resolve/, out);
  assert.doesNotMatch(out, /H1\.2[^\n]*does not resolve|H1\.3[^\n]*does not resolve/, out);
  const [first, second, third] = ledgerOf(repo).huddles[0].actOn;
  assert.deepEqual(first.unresolved, ["src/gone.ts:12"]);
  assert.equal(second.unresolved, undefined);
  assert.equal(third.unresolved, undefined);
});

test("C10 happy: the always-loaded text, the investigation playbook and the hints carry the cite-or-unverified wording; SKILL.md stays under 4096 bytes", () => {
  const read = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");
  assert.match(read("hooks/session-start.md"), /"unverified"/);
  assert.match(read("hooks/session-start.md"), /read-only/);
  const investigation = read("skills/gate/playbooks.md").split("## investigation")[1];
  assert.match(investigation, /"unverified"/);
  assert.ok(investigation.includes("from config, unverified"), investigation);
  for (const [playbook, key] of [["bugfix", "repro"], ["bugfix", "rootcause"]]) {
    const repo = opened(`hf-c10-${key}`, playbook);
    if (key === "rootcause") {
      ranCommand(repo, "npm test");
      cli(repo, "step", ["repro", "done", "fails", "--ran", "npm test"]);
    }
    cli(repo, "note", ["task", "Fix it."]);
    assert.match(cli(repo, "next"), /--ran/, `the ${key} hint does not name --ran`);
  }
  const atSchema = { taskSeq: 1, planSeq: 1, cases: [{ id: "C1", status: "closed" }], steps: [{ n: 9, key: "schema", state: null, text: "probe" }] };
  assert.match(nextHint(atSchema), /--ran/, "the schema hint does not name --ran");
  assert.ok(statSync(path.join(pluginRoot, "skills/gate/SKILL.md")).size < 4096);
});

test("C11 edge: --ran skips a gate step call that quotes the text and a background run; a helper's command counts", () => {
  const repo = opened("hf-c11");
  ranCommand(repo, 'node scripts/gate.mjs step repro done "x" --ran "npm test -- badge"');
  ranCommand(repo, 'node "/p/scripts/gate.mjs" note task "npm test -- badge fails"');
  ranCommand(repo, "npm test -- badge", 0, { input: { run_in_background: true } });
  refused(repo, "step", ["repro", "done", "fails", "--ran", "npm test -- badge"]);
  ranCommand(repo, 'node scripts/gate.mjs verify --add "npm test -- badge"');
  ranCommand(repo, "cat notes-on-npm test -- badge.txt", 0);
  logged(repo, { tool_name: "Skill", tool_input: { skill: "notes:npm test -- badge" } });
  refused(repo, "step", ["repro", "done", "fails", "--ran", "npm test -- badge"]);
  const seq = ranCommand(repo, "npm test -- badge", 1, { payload: { agent_id: "A1", agent_type: "done-gate:worker" } });
  cli(repo, "step", ["repro", "done", "fails", "--ran", "npm test -- badge"]);
  assert.equal(stepOf(repo, "repro").evidence, `events#${seq}`);
  const drove = logged(repo, { tool_name: "Skill", tool_input: { skill: "verify" } });
  cli(repo, "step", ["rootcause", "done", "src/a.ts:3 reads the wrong column", "--ran", "verify"]);
  assert.equal(stepOf(repo, "rootcause").evidence, `events#${drove}`);
});

test("C12 refused: repro and rootcause cannot be closed skipped or na; the user's waiver closes them", () => {
  const repo = opened("hf-c12");
  for (const key of ["repro", "rootcause"]) {
    for (const how of ["skipped", "na"]) assert.match(refused(repo, "step", [key, how, "could not"]), /waive/);
  }
  cli(repo, "waive", ["repro", "intermittent in production only, the user agreed"]);
  assert.equal(stepOf(repo, "repro").state, "WAIVED");
});

test("C13 boundary: --evidence events#<seq> of an edit event or of a command from before the run opened is refused", () => {
  const repo = committed("hf-c13");
  const early = ranCommand(repo, "npm test -- early");
  cli(repo, "open", ["t", "bugfix"]);
  const edit = logged(repo, { tool_name: "Edit", tool_input: { file_path: path.join(repo, "docs/notes.md") } });
  for (const seq of [early, edit]) refused(repo, "step", ["repro", "done", "fails", "--evidence", `events#${seq}`]);
});

test("C14 happy: a probe through another MCP tool or WebFetch is recorded and closes the schema step", () => {
  const repo = opened("hf-c14", "feature");
  const { matcher } = JSON.parse(readFileSync(path.join(pluginRoot, "hooks/hooks.json"), "utf8")).hooks.PostToolUse[0];
  for (const tool of ["mcp__supabase__execute_sql", "WebFetch", "Bash"]) assert.match(tool, new RegExp(`^(?:${matcher})$`), `the log hook does not fire for ${tool}`);
  const seq = logged(repo, { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "select venue from courts limit 1" } });
  cli(repo, "step", ["schema", "done", "one row, venue is text", "--ran", "select venue from courts"]);
  assert.equal(stepOf(repo, "schema").evidence, `events#${seq}`);
  logged(repo, { tool_name: "WebFetch", tool_input: { url: "http://localhost:3000/api/courts" } });
  cli(repo, "step", ["schema", "done", "200 with the new column", "--ran", "localhost:3000/api/courts"]);
});

test("C15 boundary: an address or a version in Traced is no pointer, and an absolute path outside the repo is checked where it is", () => {
  const repo = opened("hf-c15", "feature");
  cli(repo, "note", ["task", "Do the thing."]);
  cli(repo, "note", ["context", context({ traced: "src/a.ts:1 calls 127.0.0.1:3000, db.internal:5432, deploy@db.internal:5432, git@github.com:22 and api.example.com:443 on pkg@0.13.0:5" })]);
  const outside = path.join(os.tmpdir(), "hf-c15-outside.txt");
  writeFileSync(outside, "one\n");
  cli(repo, "note", ["context", context({ traced: `src/a.ts:1 reads ${outside}:1` })]);
  refused(repo, "note", ["context", context({ traced: `src/a.ts:1 reads ${outside}:2` })]);
  rmSync(outside);
  const home = path.join(os.homedir(), ".hf-c15-home.txt");
  writeFileSync(home, "one\n");
  try {
    cli(repo, "note", ["context", context({ traced: "src/a.ts:1 reads ~/.hf-c15-home.txt:1" })]);
  } finally {
    rmSync(home);
  }
});

test("C16 boundary: --ran text past the 200 characters the gate keeps of a command is refused and the refusal names the limit", () => {
  const repo = opened("hf-c16");
  ranCommand(repo, `npm test -- ${"x".repeat(200)} tail-marker`);
  assert.match(refused(repo, "step", ["repro", "done", "fails", "--ran", "tail-marker"]), /200/);
});

test("G1 refused: a memory-search or docs MCP call does not close repro or rootcause; a database MCP call still does", () => {
  const repo = opened("hf-g1");
  logged(repo, { tool_name: "mcp__plugin_claude-mem_mcp-search__search", tool_input: { query: "badge null venue" } });
  logged(repo, { tool_name: "mcp__claude_ai_Claude_Docs__read", tool_input: { id: "badge null venue" } });
  logged(repo, { tool_name: "mcp__context7__get-library-docs", tool_input: { topic: "badge null venue" } });
  const lookup = logged(repo, { tool_name: "mcp__plugin_claude-mem_mcp-search__search", tool_input: { query: "badge null venue" } });
  assert.match(refused(repo, "step", ["repro", "done", "fails", "--ran", "badge null venue"]), /memory or docs lookup/);
  refused(repo, "step", ["repro", "done", "fails", "--evidence", `events#${lookup}`]);
  logged(repo, { tool_name: "mcp__elasticsearch__search", tool_input: { query: "venue in the index" } });
  cli(repo, "step", ["rootcause", "done", "src/a.ts:3 writes null", "--ran", "venue in the index"]);
  const seq = logged(repo, { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "select badge null venue" } });
  cli(repo, "step", ["repro", "done", "fails", "--ran", "badge null venue"]);
  assert.equal(stepOf(repo, "repro").evidence, `events#${seq}`);
});

function plannedFeature(name) {
  const repo = opened(name, "feature");
  cli(repo, "note", ["task", "Do the thing."]);
  cli(repo, "note", ["context", context()]);
  return repo;
}

test("G2 refused: step evidence ledger.md#Nonsense is refused; ledger.md#Plan resolves once the plan is written, in any letter case", () => {
  const repo = plannedFeature("hf-g2");
  assert.match(refused(repo, "step", ["implement", "done", "built", "--evidence", "ledger.md#Nonsense"]), /ledger\.md#Nonsense/);
  refused(repo, "step", ["implement", "done", "built", "--evidence", "ledger.md#Plan"]);
  cli(repo, "note", ["plan", "One constant changes; no hot path.", "--files", "src/a.ts,src/app/page.tsx"]);
  cli(repo, "step", ["implement", "done", "built", "--evidence", "ledger.md#plan"]);
  assert.equal(stepOf(repo, "implement").state, "DONE");
});

test("G3 boundary: ledger.json#nokey is refused and ledger.json#cases accepted; report.md and decisions.tsv are refused until the file exists", () => {
  const repo = plannedFeature("hf-g3");
  for (const ptr of ["ledger.json#nokey", "ledger.json#slug", "ledger.json#steps", "ledger.json#baseline", "ledger.json#cases", "report.md", "decisions.tsv"]) refused(repo, "step", ["implement", "done", "built", "--evidence", ptr]);
  cli(repo, "decide", ["plan", "kept it small", "one consumer", "ledger.md", "open"]);
  cli(repo, "step", ["implement", "done", "built", "--evidence", "decisions.tsv"]);
  cli(repo, "note", ["plan", "One constant changes; no hot path.", "--files", "src/a.ts,src/app/page.tsx"]);
  cli(repo, "case", ["add", "a renders", "--kind", "happy"]);
  cli(repo, "step", ["tests", "done", "red", "--evidence", "ledger.json#cases"]);
});

test("G4 boundary: a file pointer with a line past the end of the file is refused; file:testname and a line inside the file resolve", () => {
  const repo = plannedFeature("hf-g4");
  refused(repo, "step", ["implement", "done", "built", "--evidence", "src/a.ts:21"]);
  refused(repo, "step", ["implement", "done", "built", "--evidence", "src/a.ts:0"]);
  refused(repo, "step", ["implement", "done", "built", "--evidence", "src/a.ts:99:1"]);
  cli(repo, "step", ["implement", "done", "built", "--evidence", "src/a.ts:20:1"]);
  cli(repo, "step", ["implement", "done", "built", "--evidence", "src/a.ts:20"]);
  cli(repo, "step", ["tests", "done", "red", "--evidence", "tests/a.test.ts:404 returns the page"]);
  refused(repo, "step", ["driver", "done", "drove it", "--evidence", "src/a.ts:19-21"]);
  cli(repo, "step", ["driver", "done", "drove it", "--evidence", "src/a.ts:1-20"]);
  cli(repo, "note", ["plan", "One constant changes; no hot path.", "--files", "src/a.ts,src/app/page.tsx"]);
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), "# Skeptic 1 — t\n\n## Act on\n- a0 is read by the page — src/app/page.tsx:1\n## Consider\n- none\n## Noted\n- none\n## The one question\n- none\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  refused(repo, "huddle", ["dispute", "H1.1", "the page reads a1", "--evidence", "src/a.ts:21"]);
  refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/a.ts:21"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/a.ts:20"]);
});

test("G5 happy: package.json, plugin.json and marketplace.json all read 0.13.1", () => {
  const json = (rel) => JSON.parse(readFileSync(path.join(pluginRoot, rel), "utf8"));
  assert.equal(json("package.json").version, "0.13.1");
  assert.equal(json(".claude-plugin/plugin.json").version, "0.13.1");
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].version, "0.13.1");
});
