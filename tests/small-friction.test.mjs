import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here, pluginRoot } from "./helpers.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { pointerResolver } from "../scripts/lib/rules.mjs";
import { nextHint } from "../scripts/lib/next.mjs";

// Group 3 of 0.13.0, the smaller friction items. One test per open case of the task's case
// table (C7, C9 and C10 were superseded by C18, C19 and C20).

const NODE = JSON.stringify(process.execPath);
const REFUSAL = /^done-gate: /m;
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") => path.join(stateDir(repo), "runs", (({ current, lastClosed }) => current ?? lastClosed)(loadSession(stateDir(repo), session)));
const ledgerOf = (repo, session = "S1") => loadLedger(runDir(repo, session));
const lastLine = (out) => out.trim().split("\n").pop();
const nextLines = (out) => out.split("\n").filter((l) => l.startsWith("next:"));
const ruleLines = (out, rule) => out.split("\n").filter((l) => new RegExp(`^\\d+\\. ${rule} — `).test(l)).join("\n");

function run(repo, verb, args = [], { session = "S1", input = "" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session },
  });
}
function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}
function refused(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.notEqual(r.status, 0, `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.match(r.stderr, REFUSAL, `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  return r.stderr;
}
function hook(repo, verb, payload, session = "S1") {
  const r = run(repo, verb, [], { session, input: JSON.stringify({ session_id: session, cwd: repo, ...payload }) });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
// The model's own shell: no session id in the environment and nothing on stdin.
function bare(repo, verb, args = [], extra = {}, input = "") {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo };
  delete env.DONE_GATE_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DONE_GATE_STATE_DIR;
  return spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: { ...env, ...extra } });
}
const sessionStart = (repo, session, source = "startup") => hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: source }, session);
const leadEdit = (repo, file) => hook(repo, "log", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, file) }, tool_output: "" });
const REWRITE = Array.from({ length: 20 }, (_, i) => `export const b${i} = ${i * 2};`).join("\n") + "\n";

const CONTEXT = [
  "Traced: src/a.ts:1 exports a, read by src/app/page.tsx:1; no other caller (grep -a).",
  "Related: tests/a.test.ts pins a; docs/notes.md describes the page.",
  "Research: none needed: a one-line constant change with no known pattern to compare.",
].join("\n");
const DECIDE = ["plan", "kept the badge in the card", "one consumer", "ledger.md#Plan", "open"];

function repoOf(name, files = {}) {
  const repo = makeRepo(name, files);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
function opened(name, files = {}, playbook = "feature") {
  const repo = repoOf(name, files);
  cli(repo, "open", ["t", playbook]);
  return repo;
}
function planned(name, files = {}, planArgs = ["--files", "src/a.ts"]) {
  const repo = opened(name, files);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "One constant changes; no data, no hot path.", ...planArgs]);
  return repo;
}
const config = (obj) => ({ ".claude/gate.json": JSON.stringify(obj) });
// a plan naming more than ten files is size large: QA and the worker are briefed, the lead delegates
const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
const LARGE_FILES = Object.fromEntries(LARGE.map((f) => [f, "export const x = 1;\n"]));
const packetOf = (repo, role) => readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", [role]).stdout)[1], "utf8");
const verifyJson = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8"));

// A verify command that leaves one mark per run in a file outside the repo, so "ran" and
// "skipped" are counted from what happened and not from what verify.json says.
const COUNT_SRC = 'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], "x");\nprocess.exit(process.argv[3] === "fail" ? 1 : 0);\n';
function counter(name) {
  const file = path.join(here, ".tmp", `${name}.count`);
  rmSync(file, { force: true });
  return { file, cmd: `${NODE} count.mjs ${JSON.stringify(file)}`, runs: () => (existsSync(file) ? readFileSync(file, "utf8").length : 0) };
}

const VALID_KEYS = ["delegate", "driver", "review", "review-2", "schema", "tests", "slop", "gate-config"];

test("C1 reported-surface: gate waive worker is refused, lists the valid keys and points at delegate; delegate and a step key are accepted", () => {
  const repo = opened("sf-c1");
  const err = refused(repo, "waive", ["worker", "x"]);
  for (const key of VALID_KEYS) assert.ok(err.includes(key), `the refusal does not list "${key}":\n${err}`);
  assert.match(err, /worker[\s\S]*delegate/, `the refusal does not point worker at delegate:\n${err}`);
  assert.deepEqual(ledgerOf(repo).waivers, [], "a refused waiver was stored");

  // a made-up key is refused the same way
  refused(repo, "waive", ["anything-at-all", "x"]);
  assert.deepEqual(ledgerOf(repo).waivers, []);

  cli(repo, "waive", ["delegate", "user said the lead edits this one"]);
  assert.deepEqual(ledgerOf(repo).waivers.map((w) => w.key), ["delegate"]);

  // skeptic is a step key of the feature playbook (skills/gate/playbooks.md, step 4) and not a rule key
  cli(repo, "waive", ["skeptic", "user said skip the design round"]);
  assert.deepEqual(ledgerOf(repo).waivers.map((w) => w.key), ["delegate", "skeptic"]);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "skeptic").state, "WAIVED");
});

test("C2 happy: the unmet texts of R5, R6, R9 and R16 each name the gate waive key that clears them", () => {
  const repo = opened("sf-c2", { "db/schema.sql": "create table a (id int);\n", ...config({ schema: ["db/**"], highRisk: ["src/a.ts"] }) });
  write(repo, "src/a.ts", REWRITE);
  write(repo, "db/schema.sql", "create table a (id int, name text);\n");
  const out = cli(repo, "check").stdout;
  for (const [rule, key] of [["R5", "review"], ["R6", "schema"], ["R9", "review-2"]]) {
    const lines = ruleLines(out, rule);
    assert.ok(lines, `premise: ${rule} is unmet\n${out}`);
    assert.match(lines, new RegExp(`gate waive ${key}(?![\\w-])`), `${rule} does not name its key:\n${lines}`);
  }

  const large = planned("sf-c2-large", LARGE_FILES, ["--files", LARGE.join(",")]);
  leadEdit(large, "src/f0.ts");
  write(large, "src/f0.ts", REWRITE);
  const r16 = ruleLines(cli(large, "check").stdout, "R16");
  assert.ok(r16, "premise: R16 is unmet for a lead edit at size large");
  assert.match(r16, /gate waive delegate/, r16);
});

test("C3 reported-surface: gate case amend keeps the old text in history and reopens the case; the report shows the new text and that it was amended; an unknown id or empty text is refused", () => {
  const repo = opened("sf-c3");
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  cli(repo, "case", ["add", "hides the badge when the venue is closed", "--kind", "edge"]);
  cli(repo, "case", ["close", "C2", "--test", "tests/a.test.ts:hides the badge"]);
  const before = ledgerOf(repo).cases[1];
  assert.equal(before.status, "closed");

  cli(repo, "case", ["amend", "C2", "greys the badge when the venue is closed"]);
  const after = ledgerOf(repo).cases[1];
  assert.equal(after.case, "greys the badge when the venue is closed");
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].text, "hides the badge when the venue is closed");
  assert.equal(typeof after.history[0].seq, "number");
  assert.equal(after.status, "open");
  assert.equal(after.test ?? null, null);
  assert.equal(after.na ?? null, null);
  assert.equal(after.event ?? null, null);
  assert.equal(after.closedSeq ?? null, null);
  assert.equal(after.seq, before.seq, "amend must leave case.seq alone");
  assert.equal(after.kind, "edge");
  assert.equal(ledgerOf(repo).cases[0].case, "renders the badge", "C1 was touched");

  const report = cli(repo, "report").stdout;
  const row = report.split("\n").find((l) => l.startsWith("| C2 |"));
  assert.match(row, /greys the badge when the venue is closed/);
  assert.doesNotMatch(row, /hides the badge/);
  assert.match(report, /amended/, "the full report does not mark the amended case");
  assert.doesNotMatch(report.split("\n").find((l) => l.startsWith("| C1 |")), /amended/);

  refused(repo, "case", ["amend", "C9", "no such case"]);
  refused(repo, "case", ["amend", "C2", ""]);
  refused(repo, "case", ["amend", "C2"]);
  const still = ledgerOf(repo).cases;
  assert.equal(still.length, 2);
  assert.equal(still[1].case, "greys the badge when the venue is closed");
  assert.equal(still[1].history.length, 1, "a refused amend added to the history");
});

test("C4 reported-surface: a test pointer that already closes another case prints a note naming it; the reviewer packet lists the test with both ids; a test closing one case prints nothing", () => {
  const repo = planned("sf-c4");
  for (const text of ["renders the badge", "hides the badge", "refuses an unknown venue"]) cli(repo, "case", ["add", text, "--kind", "happy"]);
  write(repo, "src/a.ts", REWRITE);

  const first = cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:renders the badge"]).stdout;
  assert.doesNotMatch(first, /also closes/);
  const second = cli(repo, "case", ["close", "C2", "--test", "tests/a.test.ts:renders the badge"]).stdout;
  assert.match(second, /also closes/, second);
  assert.match(second, /\bC1\b/, second);
  const third = cli(repo, "case", ["close", "C3", "--test", "tests/a.test.ts:refuses an unknown venue"]).stdout;
  assert.doesNotMatch(third, /also closes/, third);

  const packet = packetOf(repo, "reviewer");
  const shared = /## Shared tests\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1];
  assert.ok(shared, `the reviewer packet has no "## Shared tests" section:\n${packet.slice(0, 1500)}`);
  assert.ok(shared.includes("tests/a.test.ts:renders the badge"), shared);
  assert.match(shared, /\bC1\b/);
  assert.match(shared, /\bC2\b/);
  assert.doesNotMatch(shared, /\bC3\b/);
  assert.ok(!shared.includes("refuses an unknown venue"), "a test that closes one case is listed as shared");

  // no shared test, no section
  const single = planned("sf-c4-single");
  cli(single, "case", ["add", "renders the badge", "--kind", "happy"]);
  write(single, "src/a.ts", REWRITE);
  cli(single, "case", ["close", "C1", "--test", "tests/a.test.ts:renders the badge"]);
  assert.doesNotMatch(packetOf(single, "reviewer"), /## Shared tests/);
});

test("C5 refused: gate case add --batch adds every kind TAB text line and prints one next line; an unknown kind or a line with no text refuses the whole file", () => {
  const repo = planned("sf-c5");
  // CASE_KINDS in scripts/lib/verbs.mjs: happy, edge, refused, ...
  write(repo, "cases.tsv", "happy\trenders the badge\n\nedge\thides the badge when closed\nrefused\tan unknown venue is refused\n");
  const out = cli(repo, "case", ["add", "--batch", path.join(repo, "cases.tsv")]).stdout;
  assert.deepEqual(ledgerOf(repo).cases.map((c) => [c.id, c.kind, c.case, c.status]), [
    ["C1", "happy", "renders the badge", "open"],
    ["C2", "edge", "hides the badge when closed", "open"],
    ["C3", "refused", "an unknown venue is refused", "open"],
  ]);
  assert.equal(nextLines(out).length, 1, `one next line for the whole batch:\n${out}`);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "cases").state, "DONE");

  write(repo, "bad-kind.tsv", "happy\tfourth case\nsurprise\tfifth case\n");
  refused(repo, "case", ["add", "--batch", path.join(repo, "bad-kind.tsv")]);
  assert.equal(ledgerOf(repo).cases.length, 3, "a file with an unknown kind added a case");

  write(repo, "no-text.tsv", "happy\tfourth case\nedge\t\n");
  refused(repo, "case", ["add", "--batch", path.join(repo, "no-text.tsv")]);
  assert.equal(ledgerOf(repo).cases.length, 3, "a file with a textless line added a case");

  write(repo, "no-tab.tsv", "happy fourth case\n");
  refused(repo, "case", ["add", "--batch", path.join(repo, "no-tab.tsv")]);
  assert.equal(ledgerOf(repo).cases.length, 3, "a line with no TAB added a case");

  refused(repo, "case", ["add", "--batch", path.join(repo, "missing.tsv")]);
  // a directory is a usage refusal, not a gate error
  refused(repo, "case", ["add", "--batch", path.join(repo, "src")]);
  assert.equal(ledgerOf(repo).cases.length, 3);
  assert.ok(!existsSync(path.join(stateDir(repo), "gate-error.log")), "a directory given to --batch logged a gate error");
});

test("C6 happy: the next line is the full text the first time a step is hinted and a short form naming the step and gate next afterwards; gate next prints the full text; a new step gets its full text once", () => {
  const repo = opened("sf-c6");
  const full = lastLine(cli(repo, "note", ["task", "Do the thing. [inferred]"]).stdout);
  assert.match(full, /^next: step 1: understand first/);
  assert.ok(full.includes("Traced: <file:line pointers>"), full);

  const short = lastLine(cli(repo, "decide", DECIDE).stdout);
  assert.match(short, /^next: /, short);
  assert.ok(short.length < 200, `the second hint for the same step is ${short.length} characters:\n${short}`);
  assert.ok(short.includes("gate next"), short);
  assert.match(short, /step 1\b|context/, `the short form does not name the step:\n${short}`);
  assert.ok(JSON.stringify(ledgerOf(repo).hinted ?? null).includes("context"), "ledger.hinted does not record the context step");

  const again = cli(repo, "next").stdout;
  assert.ok(again.includes("Traced: <file:line pointers>"), `gate next did not print the full text:\n${again}`);
  assert.match(again, /^next: step 1: understand first/m);
  // asking for the full text does not make the next verb long again
  assert.ok(lastLine(cli(repo, "decide", DECIDE).stdout).length < 200);

  cli(repo, "note", ["context", CONTEXT]);
  // two files predict size standard, the smallest size that keeps the skeptic step (models.json)
  cli(repo, "note", ["plan", "One constant changes.", "--files", "src/a.ts,src/b.ts"]);
  const newStep = lastLine(cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]).stdout);
  assert.match(newStep, /^next: step 4: /, newStep);
  assert.ok(newStep.includes("gate huddle add skeptic --file skeptic-<n>.md"), `a new step did not get its full text:\n${newStep}`);
  const newShort = lastLine(cli(repo, "case", ["add", "hides the badge", "--kind", "edge"]).stdout);
  assert.ok(newShort.length < 200, newShort);
  assert.ok(newShort.includes("gate next"), newShort);
  assert.match(newShort, /step 4\b|skeptic/, newShort);
  assert.ok(!newShort.includes("gate huddle add skeptic"), newShort);
});

test("C8 reported-surface: the brief For-you line drops pauses and blocked writes while the full report keeps them; waivers, disputes and unmet rules stay", () => {
  const repo = repoOf("sf-c8");
  sessionStart(repo, "S1");
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "One constant changes.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  write(repo, "src/a.ts", REWRITE);

  hook(repo, "stop", { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Some progress.\n\nPAUSED: need the API key from you" });
  assert.equal(ledgerOf(repo).pauses.length, 1, "premise: the pause was recorded");
  const denied = hook(repo, "fence", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(runDir(repo), "verify.json"), content: "{}" } });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny", "premise: the write to an evidence file was blocked");
  cli(repo, "waive", ["driver", "chrome is disconnected, the phone pass waits"]);
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), "# Skeptic 1\n\n## Act on\n- the plan misses the empty venue list\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  cli(repo, "huddle", ["dispute", "H1.1", "the list is never empty here", "--evidence", "ledger.md#Plan"]);

  const brief = cli(repo, "report", ["--brief"]).stdout;
  const forYou = brief.split("\n").find((l) => l.startsWith("For you:"));
  assert.ok(forYou, brief);
  assert.ok(forYou.includes("skipped with your OK: chrome is disconnected, the phone pass waits"), forYou);
  assert.ok(forYou.includes('"the plan misses the empty venue list": disputed, waiting for the reviewer\'s answer'), forYou);
  assert.match(forYou, /missing: /, forYou);
  assert.doesNotMatch(forYou, /paused for/, forYou);
  assert.doesNotMatch(forYou, /API key/, forYou);
  assert.doesNotMatch(forYou, /blocked write/, forYou);

  const full = cli(repo, "report").stdout;
  assert.match(full, /## Pauses\n\n- .*need the API key from you/);
  assert.match(full, /tampering attempts 1 /);
});

test("C11 happy: gate verify --add stores the command on the ledger, runs it after the config commands, and doctor and the report show it as added by this run; twice keeps one; R13 stays quiet", () => {
  const first = counter("sf-c11-config");
  const added = counter("sf-c11-added");
  const repo = opened("sf-c11", { "count.mjs": COUNT_SRC, ...config({ verify: [first.cmd] }) });

  cli(repo, "verify", ["--add", added.cmd]);
  assert.deepEqual(ledgerOf(repo).verifyAdded, [added.cmd]);
  cli(repo, "verify", ["--add", added.cmd]);
  assert.deepEqual(ledgerOf(repo).verifyAdded, [added.cmd], "adding the same command twice kept two");

  const out = cli(repo, "verify").stdout;
  assert.match(out, /all 2 green/, out);
  assert.deepEqual(verifyJson(repo).commands.map((c) => [c.cmd, c.exit]), [[first.cmd, 0], [added.cmd, 0]]);
  assert.equal(first.runs(), 1);
  assert.equal(added.runs(), 1);

  const doctor = cli(repo, "doctor").stdout.split("\n").filter((l) => l.includes("added by this run")).join("\n");
  assert.ok(doctor.includes(added.cmd), `gate doctor does not list the run-added command:\n${doctor}`);
  const report = cli(repo, "report").stdout.split("\n").filter((l) => l.includes("added by this run")).join("\n");
  assert.ok(report.includes(added.cmd), `the report does not list the run-added command:\n${report}`);

  assert.equal(ruleLines(cli(repo, "check").stdout, "R13"), "", "a run-added verify command tripped R13");
  assert.deepEqual(JSON.parse(readFileSync(path.join(repo, ".claude", "gate.json"), "utf8")), { verify: [first.cmd] }, "the repo config was rewritten");
});

test("C12 refused: a red added command makes verify red", () => {
  const good = counter("sf-c12-config");
  const bad = counter("sf-c12-added");
  const repo = opened("sf-c12", { "count.mjs": COUNT_SRC, ...config({ verify: [good.cmd] }) });
  cli(repo, "verify", ["--add", `${bad.cmd} fail`]);
  const out = run(repo, "verify").stdout;
  assert.match(out, /1 of 2 red/, out);
  assert.equal(bad.runs(), 1);
  assert.deepEqual(verifyJson(repo).commands.map((c) => c.exit), [0, 1]);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "verify").state, null, "a red verify closed the verify step");
  assert.match(ruleLines(cli(repo, "check").stdout, "R3") + ruleLines(cli(repo, "check").stdout, "R8"), /\S/, "a red verify left nothing unmet");
});

test("C13 edge: a when:source command green at one verify is skipped at the next when only test files changed since, and runs again after a non-test source edit; a red one is never skipped", () => {
  const build = counter("sf-c13");
  const repo = opened("sf-c13", { "count.mjs": COUNT_SRC, ...config({ verify: [{ cmd: build.cmd, when: "source" }, "true"] }) });
  write(repo, "src/a.ts", REWRITE);
  assert.match(cli(repo, "verify").stdout, /all 2 green/);
  assert.equal(build.runs(), 1, "premise: the source command ran once after an implementation edit");

  write(repo, "tests/a.test.ts", "test('a', () => {});\ntest('b', () => {});\n");
  const second = cli(repo, "verify").stdout;
  assert.equal(build.runs(), 1, `only a test file changed since the command was green, yet it ran again:\n${second}`);
  assert.match(second, /all 1 green/, second);
  const row = verifyJson(repo).commands.find((c) => c.cmd === build.cmd);
  assert.ok(row.skipped, "verify.json does not mark the command skipped");
  assert.equal(row.exit, undefined);

  write(repo, "src/a.ts", REWRITE.replace("b0", "c0"));
  assert.match(cli(repo, "verify").stdout, /all 2 green/);
  assert.equal(build.runs(), 2, "a non-test source edit did not run the source command again");

  const red = counter("sf-c13-red");
  const other = opened("sf-c13-red", { "count.mjs": COUNT_SRC, ...config({ verify: [{ cmd: `${red.cmd} fail`, when: "source" }, "true"] }) });
  write(other, "src/a.ts", REWRITE);
  assert.match(run(other, "verify").stdout, /1 of 2 red/);
  write(other, "tests/a.test.ts", "test('a', () => {});\ntest('b', () => {});\n");
  assert.match(run(other, "verify").stdout, /1 of 2 red/, "a command that was red was skipped");
  assert.equal(red.runs(), 2);
});

test("C14 happy: helperNote in gate.json appears in every helper packet under Standing note; changing it mid-run trips R13; absent, packets have no such section", () => {
  const NOTE = "Never run two test runs at once: they share tests/.tmp.";
  const repo = planned("sf-c14", { ...LARGE_FILES, ...config({ helperNote: NOTE }) }, ["--files", LARGE.join(",")]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  for (const role of ["skeptic", "qa", "worker"]) {
    const packet = packetOf(repo, role);
    const section = /## Standing note\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1];
    assert.ok(section, `the ${role} packet has no "## Standing note" section`);
    assert.ok(section.includes(NOTE), `${role}: ${section}`);
  }
  assert.equal(ruleLines(cli(repo, "check").stdout, "R13"), "", "premise: R13 is quiet before the note changes");
  write(repo, ".claude/gate.json", JSON.stringify({ helperNote: "Run whatever you like." }));
  assert.match(ruleLines(cli(repo, "check").stdout, "R13"), /gate\.json changed/);

  const plain = planned("sf-c14-none", LARGE_FILES, ["--files", LARGE.join(",")]);
  cli(plain, "case", ["add", "renders the badge", "--kind", "happy"]);
  for (const role of ["skeptic", "qa", "worker"]) assert.doesNotMatch(packetOf(plain, role), /Standing note/, role);
});

test("C15 boundary: a pointer to an existing absolute file or ../ file resolves; a directory, an empty path and a missing file do not", () => {
  const repo = opened("sf-c15");
  const outside = path.join(here, ".tmp", "sf-c15-plan.md");
  writeFileSync(outside, "# the plan\n");
  const resolves = pointerResolver({ dir: runDir(repo), root: repo, events: [], reviews: [], verify: null });

  assert.equal(resolves(outside), true, "an existing absolute file does not resolve");
  assert.equal(resolves(`${outside}:1`), true, "an absolute file:line does not resolve");
  assert.equal(resolves("../sf-c15-plan.md"), true, "an existing ../ file does not resolve");
  assert.equal(resolves("src/a.ts:3"), true, "a repo file:line stopped resolving");
  assert.equal(resolves("tests/a.test.ts:a"), true, "a test pointer stopped resolving");

  assert.equal(resolves("src"), false, "a directory in the repo resolves");
  assert.equal(resolves(repo), false, "an absolute directory resolves");
  assert.equal(resolves(".."), false, "the parent directory resolves");
  assert.equal(resolves(""), false, "an empty pointer resolves");
  assert.equal(resolves(":12"), false, "an empty path with a line resolves");
  assert.equal(resolves("src/nope.ts:12"), false, "a missing repo file resolves");
  assert.equal(resolves(path.join(here, ".tmp", "sf-c15-nope.md")), false, "a missing absolute file resolves");
  assert.equal(resolves("../sf-c15-nope.md"), false, "a missing ../ file resolves");
  // prose given as a pointer answers false, it does not throw
  assert.equal(resolves(`ran the reader and saw ${"x".repeat(300)}`), false, "a 300-character name resolves or throws");
  assert.equal(resolves("src/a\0.ts"), false, "a NUL byte resolves or throws");

  // the reported surface: an absolute plan path as huddle evidence
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), "# Skeptic 1\n\n## Act on\n- the plan misses the empty case\n- the plan misses the closed venue\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", outside]);
  assert.equal(ledgerOf(repo).huddles[0].actOn[0].closed, outside);
  refused(repo, "huddle", ["resolve", "H1.2", "--evidence", "src"]);
  assert.match(refused(repo, "huddle", ["resolve", "H1.2", "--evidence", `saw ${"x".repeat(300)}`]), /does not resolve/);
  assert.ok(!existsSync(path.join(stateDir(repo), "gate-error.log")), "a long prose pointer logged a gate error");
  assert.equal(ledgerOf(repo).huddles[0].actOn[1].closed, null, "a directory closed a finding");
});

test("C16 happy: the helper prompts carry the real-data, fixture, audience and unverified-from-config rules, the driver hint names the endpoint, and SKILL.md stays under 4096 bytes", () => {
  const read = (...rel) => readFileSync(path.join(pluginRoot, ...rel), "utf8");
  const skeptic = read("agents", "skeptic.md");
  const premise = skeptic.split("\n").find((l) => l.includes("**Premise.**"));
  assert.ok(premise, "skeptic.md lost its Premise item");
  assert.match(premise, /real data/, premise);
  assert.match(premise, /[Cc]ite/, premise);

  const qa = read("agents", "qa.md");
  assert.match(qa, /fixture/);
  assert.match(qa, /hand-made/);

  const reviewer = read("agents", "reviewer.md");
  assert.match(reviewer, /audience/);
  assert.match(reviewer, /callers/);

  const playbooks = read("skills", "gate", "playbooks.md");
  const at = playbooks.search(/^#+ .*investigation.*$/im);
  assert.ok(at >= 0, "playbooks.md has no investigation heading");
  const investigation = playbooks.slice(at).split(/\n(?=#+ )/)[0];
  assert.ok(investigation.includes("from config, unverified"), investigation);

  // the pure renderer: a ledger whose only blank step is {driver}
  const steps = [{ n: 1, key: "driver", text: "drive the real surface", state: null, note: null, evidence: null, seq: null }];
  const hint = nextHint({ status: "open", playbook: "feature", taskSeq: 1, planSeq: 2, contextSeq: 1, cases: [{ id: "C1", case: "x", kind: "happy", test: "t:x", na: null, status: "closed", seq: 3 }], steps, huddles: [], waivers: [] });
  assert.match(hint, /^next: step 1: /, hint);
  assert.match(hint, /endpoint/, hint);

  const size = statSync(path.join(pluginRoot, "skills", "gate", "SKILL.md")).size;
  assert.ok(size < 4096, `skills/gate/SKILL.md is ${size} bytes`);
});

test("C17 boundary: a ledger from before this change (an unknown waiver key stored, no hinted map, no added commands) still checks, verifies and closes", () => {
  const repo = planned("sf-c17");
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  const dir = runDir(repo);
  const old = loadLedger(dir);
  delete old.hinted;
  delete old.verifyAdded;
  for (const c of old.cases) delete c.history;
  old.waivers.push({ key: "worker", reason: "user said the lead edits this one", seq: 1 });
  old.waivers.push({ key: "R16", reason: "same, by rule number", seq: 2 });
  saveLedger(dir, old);

  const check = cli(repo, "check");
  assert.match(check.stdout, /^1\. R\d+ — /m, check.stdout);
  assert.match(cli(repo, "verify").stdout, /green — step \{verify\} closed/);
  for (const s of ledgerOf(repo).steps) if (!s.state && s.key !== "close") cli(repo, "step", [s.key ?? String(s.n), "na", "fixture"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:a"]);
  // only the close step is left, and `gate close` is what closes it
  assert.match(cli(repo, "check").stdout.trim(), /^1\. R8 — step\(s\) blank: 11 \{close\}[^\n]*$/);
  assert.match(cli(repo, "close").stdout, /^t closed$/m);
  assert.equal(ledgerOf(repo).status, "closed");
  assert.deepEqual(ledgerOf(repo).waivers.map((w) => w.key), ["worker", "R16"], "the stored waivers were rewritten");
  assert.match(cli(repo, "report").stdout, /user said the lead edits this one/);
  assert.ok(!existsSync(path.join(stateDir(repo), "gate-error.log")), "the old ledger logged a gate error");
});

test("C18 boundary: a blank close step is named in gate check with `gate close`; gate step close done is refused and says to run gate close", () => {
  const repo = planned("sf-c18");
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:a"]);
  for (const s of ledgerOf(repo).steps) if (!s.state && s.key !== "close") cli(repo, "step", [s.key ?? String(s.n), "na", "fixture"]);
  assert.deepEqual(ledgerOf(repo).steps.filter((s) => !s.state).map((s) => s.key), ["close"], "premise: only the close step is blank");

  const r8 = ruleLines(cli(repo, "check").stdout, "R8");
  assert.match(r8, /\{close\}/, r8);
  assert.ok(r8.includes("`gate close`"), `R8 does not name \`gate close\` for the blank close step:\n${r8}`);

  for (const args of [["close", "done", "closed by hand", "--evidence", "report.md"], ["close", "done", "closed by hand"], ["close", "done"]]) {
    const err = refused(repo, "step", args);
    assert.match(err, /gate close/, err);
    assert.equal(ledgerOf(repo).steps.find((s) => s.key === "close").state, null, `gate step ${args.join(" ")} closed the step`);
  }
  // every other step keeps its evidence rule
  const other = planned("sf-c18-other");
  assert.match(refused(other, "step", ["implement", "done", "did it"]), /--evidence/);
});

// Two sessions in one repo: S1 owns the run, S2 started later, so the newest-wins marker
// names S2. A verb with no id of its own must find S1 through the pid file of its ancestor.
function twoSessions(name) {
  const repo = repoOf(name);
  sessionStart(repo, "S1");
  cli(repo, "open", ["mine", "feature"]);
  sessionStart(repo, "S2");
  assert.equal(readFileSync(path.join(stateDir(repo), "current-session"), "utf8").trim(), "S2", "premise: the marker names the newer session");
  assert.ok(!loadSession(stateDir(repo), "S2").current, "premise: S2 did not join S1's run");
  return repo;
}
const pidsDir = (repo) => path.join(stateDir(repo), "pids");
const sessionLine = (out) => out.split("\n").find((l) => l.startsWith("session: ")) ?? "";

test("C19 reported-surface: with no session id on stdin or in the environment a gate verb started below a process whose fence recorded session S works on the run of S, though the marker names another; with no pid file it falls back to the marker; with CLAUDE_CODE_SESSION_ID set the pid files are not read", () => {
  const repo = twoSessions("sf-c19");
  mkdirSync(pidsDir(repo), { recursive: true });
  // this test process is the parent of every verb it spawns
  writeFileSync(path.join(pidsDir(repo), String(process.pid)), "S1");
  // nearest first: the file of a farther ancestor names another session and loses
  writeFileSync(path.join(pidsDir(repo), String(process.ppid)), "S2");

  assert.match(sessionLine(bare(repo, "doctor").stdout), /^session: S1\b/);
  const noted = bare(repo, "note", ["task", "Do the thing. [inferred]"]);
  assert.equal(noted.status, 0, `the verb did not find S1's run:\n${noted.stderr}`);
  assert.equal(typeof ledgerOf(repo, "S1").taskSeq, "number", "the task note did not land on S1's run");
  assert.match(readFileSync(path.join(runDir(repo, "S1"), "ledger.md"), "utf8"), /## Task\n\nDo the thing\./);

  // the same two files swapped: distance decides, not the order the files are listed in
  writeFileSync(path.join(pidsDir(repo), String(process.pid)), "S2");
  writeFileSync(path.join(pidsDir(repo), String(process.ppid)), "S1");
  assert.match(sessionLine(bare(repo, "doctor").stdout), /^session: S2\b/, "a farther ancestor's pid file beat the nearer one");
  writeFileSync(path.join(pidsDir(repo), String(process.pid)), "S1");
  writeFileSync(path.join(pidsDir(repo), String(process.ppid)), "S2");

  // CLAUDE_CODE_SESSION_ID is exact: the pid file is not read
  assert.match(sessionLine(bare(repo, "doctor", [], { CLAUDE_CODE_SESSION_ID: "S2" }).stdout), /^session: S2\b/);
  assert.match(sessionLine(bare(repo, "doctor", [], { DONE_GATE_SESSION: "S2" }).stdout), /^session: S2\b/);
  // so is the id a hook carries on stdin
  const stdinId = bare(repo, "fence", [], {}, JSON.stringify({ session_id: "S2", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(runDir(repo, "S1"), "verify.json"), content: "{}" } }));
  // an evidence write is denied for every session; the deny event shows whose call it was
  assert.match(stdinId.stdout, /"permissionDecision":"deny"/);
  const denies = (session) => readEvents(stateDir(repo), session).filter((e) => e.kind === "deny").length;
  assert.deepEqual([denies("S2"), denies("S1")], [1, 0], "a hook with S2 on stdin was logged under S1");

  // no pid file for any ancestor: the old marker decides
  rmSync(pidsDir(repo), { recursive: true, force: true });
  assert.match(sessionLine(bare(repo, "doctor").stdout), /^session: S2\b/);
  const fallback = bare(repo, "note", ["plan", "x"]);
  assert.notEqual(fallback.status, 0, "with no pid file the verb still found S1's run");
  assert.match(fallback.stderr, /no open ledger for this session/);
});

test("C20 boundary: the fence writes pid files only for a lead Bash command naming gate.mjs, never for a helper agent call or another command, and never for pid 1", () => {
  const gateCall = `node "${gate}" note task "Do the thing."`;
  const pre = (tool_name, tool_input, extra = {}) => ({ session_id: "S1", hook_event_name: "PreToolUse", tool_name, tool_input, ...extra });
  const fence = (repo, payload) => {
    const r = bare(repo, "fence", [], {}, JSON.stringify({ cwd: repo, ...payload }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "", `the fence denied the call:\n${r.stdout}`);
  };
  const pids = (repo) => (existsSync(pidsDir(repo)) ? readdirSync(pidsDir(repo)) : []);

  const helper = twoSessions("sf-c20-helper");
  fence(helper, pre("Bash", { command: gateCall }, { agent_id: "agent-1", agent_type: "done-gate:worker" }));
  assert.deepEqual(pids(helper), [], "a helper's gate call wrote a pid file");

  const otherCmd = twoSessions("sf-c20-other");
  fence(otherCmd, pre("Bash", { command: "npm test" }));
  fence(otherCmd, pre("Bash", { command: "cat scripts/gate.mjs.bak; echo gate" }));
  fence(otherCmd, pre("Read", { file_path: gate }));
  assert.deepEqual(pids(otherCmd), [], "a call that is not a gate call wrote a pid file");

  const repo = twoSessions("sf-c20");
  fence(repo, pre("Bash", { command: gateCall }));
  const written = pids(repo);
  assert.ok(written.includes(String(process.pid)), `no pid file for the fence's parent (${process.pid}): ${written.join(", ") || "none"}`);
  assert.ok(!written.includes("1"), "a pid file was written for pid 1");
  assert.ok(written.length <= 4, `more than four ancestor levels: ${written.join(", ")}`);
  for (const name of written) {
    assert.match(name, /^\d+$/);
    assert.equal(readFileSync(path.join(pidsDir(repo), name), "utf8").trim(), "S1");
  }
  // end to end: the verb the fence let through finds S1's run with nothing in its environment
  const noted = bare(repo, "note", ["task", "Do the thing. [inferred]"]);
  assert.equal(noted.status, 0, noted.stderr);
  assert.equal(typeof ledgerOf(repo, "S1").taskSeq, "number");

  // a file left by a process that is gone is removed at the next write
  const dead = String(spawnSync(process.execPath, ["-e", ""]).pid);
  writeFileSync(path.join(pidsDir(repo), dead), "S9");
  fence(repo, pre("Bash", { command: gateCall }));
  assert.ok(!pids(repo).includes(dead), `the pid file of a dead process (${dead}) was kept`);
  assert.ok(pids(repo).includes(String(process.pid)));

  // DONE_GATE_SESSION is an override the verb's shell inherits: nothing is written. A hook
  // may have CLAUDE_CODE_SESSION_ID where the shell does not, so that one still writes.
  for (const [name, writes] of [["DONE_GATE_SESSION", false], ["CLAUDE_CODE_SESSION_ID", true]]) {
    const withEnv = twoSessions(`sf-c20-env-${name.length}`);
    const r = bare(withEnv, "fence", [], { [name]: "S1" }, JSON.stringify({ cwd: withEnv, ...pre("Bash", { command: gateCall }) }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pids(withEnv).includes(String(process.pid)), writes, `${name} set: ${pids(withEnv).join(", ") || "no pid files"}`);
  }

  // a fence whose parent is a direct child of pid 1: the walk stops there
  if (process.platform !== "win32") {
    const orphan = twoSessions("sf-c20-orphan");
    const payload = path.join(here, ".tmp", "sf-c20-orphan.json");
    const done = path.join(here, ".tmp", "sf-c20-orphan.done");
    rmSync(done, { force: true });
    writeFileSync(payload, JSON.stringify({ cwd: orphan, ...pre("Bash", { command: gateCall }) }));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: orphan };
    for (const name of ["DONE_GATE_SESSION", "CLAUDE_CODE_SESSION_ID", "DONE_GATE_STATE_DIR"]) delete env[name];
    // the outer sh exits at once, so the subshell that runs the fence is adopted by pid 1
    spawnSync("sh", ["-c", `(sleep 0.3; ${NODE} "${gate}" fence < "${payload}"; touch "${done}") >/dev/null 2>&1 &`], { env, stdio: "ignore" });
    for (let i = 0; i < 100 && !existsSync(done); i += 1) spawnSync("sleep", ["0.1"]);
    assert.ok(existsSync(done), "the orphaned fence did not finish");
    assert.equal(pids(orphan).length, 1, `expected the subshell's pid only: ${pids(orphan).join(", ")}`);
    assert.ok(!pids(orphan).includes("1"), "a pid file was written for pid 1");
  }
});

test("H3.1: a verify command added after a green verify blocks the close until it has run; a dropped one stays in the report", () => {
  const cfg = counter("sf-h31-config");
  const added = counter("sf-h31-added");
  const repo = planned("sf-h31", { "count.mjs": COUNT_SRC, ...config({ verify: [cfg.cmd] }) });
  assert.match(cli(repo, "verify").stdout, /all 1 green/);
  assert.equal(ruleLines(cli(repo, "check").stdout, "R3"), "", "premise: R3 is quiet after a green verify");

  cli(repo, "verify", ["--add", ` ${added.cmd} `]);
  assert.deepEqual(ledgerOf(repo).verifyAdded, [added.cmd], "the command was stored untrimmed");
  const r3 = ruleLines(cli(repo, "check").stdout, "R3");
  assert.match(r3, /has not run/, r3);
  assert.ok(r3.includes(added.cmd), r3);
  const close = run(repo, "close");
  assert.notEqual(close.status, 0, "the run closed with an added command that never ran");
  assert.notEqual(ledgerOf(repo).status, "closed");

  assert.match(cli(repo, "verify").stdout, /all 2 green/);
  assert.equal(added.runs(), 1);
  assert.equal(ruleLines(cli(repo, "check").stdout, "R3"), "");

  const other = counter("sf-h31-dropped");
  cli(repo, "verify", ["--add", other.cmd]);
  cli(repo, "verify", ["--drop", other.cmd]);
  assert.equal(ruleLines(cli(repo, "check").stdout, "R3"), "", "a dropped command is still owed");
  const dropped = cli(repo, "report").stdout.split("\n").filter((l) => l.includes("dropped by this run")).join("\n");
  assert.ok(dropped.includes(other.cmd), `the report does not show the dropped command:\n${dropped}`);
  assert.equal(other.runs(), 0);
});

test("C21 refused: gate waive verify is refused and says to run gate verify; gate waive R16 is recorded as delegate; gate waive R3 is refused; waive prints what the key clears", () => {
  const repo = opened("sf-c21");
  const verifyErr = refused(repo, "waive", ["verify", "x"]);
  assert.match(verifyErr, /gate verify/, verifyErr);
  for (const key of ["verify-before", "context", "close"]) refused(repo, "waive", [key, "x"]);
  const closeErr = refused(repo, "waive", ["close", "x"]);
  assert.match(closeErr, /gate close/, closeErr);
  assert.deepEqual(ledgerOf(repo).waivers, []);
  assert.deepEqual(ledgerOf(repo).steps.filter((s) => s.state === "WAIVED"), [], "a refused waiver waived a step");

  // R3 (verify.json) has no waiver: scripts/lib/rules.mjs reads no waived() key for it
  refused(repo, "waive", ["R3", "x"]);
  refused(repo, "waive", ["R99", "x"]);
  assert.deepEqual(ledgerOf(repo).waivers, []);

  // a step closed by hand has no waiver, and an Object prototype name is no key
  for (const key of ["plan", "cases", "implement"]) assert.match(refused(repo, "waive", [key, "x"]), new RegExp(`gate step ${key}`), key);
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.match(refused(repo, "waive", [key, "x"]), /unknown waiver key/, key);
  assert.deepEqual(ledgerOf(repo).waivers, []);
  assert.deepEqual(ledgerOf(repo).steps.filter((s) => s.state === "WAIVED"), []);
  assert.ok(!existsSync(path.join(stateDir(repo), "gate-error.log")), "a refused waiver logged a gate error");

  // a step that cannot be skipped names what to do, never a waiver that is refused
  for (const key of ["verify", "verify-before", "context"]) {
    if (!ledgerOf(repo).steps.some((s) => s.key === key)) continue;
    const err = refused(repo, "step", [key, "skipped", "x"]);
    assert.doesNotMatch(err, /gate waive/, err);
    assert.match(err, /gate (verify|note context)/, err);
  }
  assert.match(refused(repo, "step", ["verify", "skipped", "x"]), /Run `gate verify`/);
  assert.match(refused(repo, "step", ["review", "skipped", "x"]), /gate waive review/);

  const byRule = cli(repo, "waive", ["R16", "user said the lead edits this one"]).stdout;
  assert.deepEqual(ledgerOf(repo).waivers.map((w) => [w.key, w.reason]), [["delegate", "user said the lead edits this one"]]);
  assert.match(byRule, /delegate/, byRule);
  assert.match(byRule, /R16/, `waive does not print what the key clears:\n${byRule}`);

  const byKey = cli(repo, "waive", ["schema", "no database in this repo"]).stdout;
  assert.match(byKey, /R6/, `waive does not print what the key clears:\n${byKey}`);
});

test("C22 edge: gate verify --add records without running; gate verify --drop removes a run-added command and refuses a config command; added commands run when the config has none", () => {
  const cfg = counter("sf-c22-config");
  const added = counter("sf-c22-added");
  const repo = opened("sf-c22", { "count.mjs": COUNT_SRC, ...config({ verify: [cfg.cmd] }) });
  const out = cli(repo, "verify", ["--add", added.cmd]).stdout;
  assert.equal(added.runs(), 0, "--add ran the command");
  assert.equal(cfg.runs(), 0, "--add ran the config commands");
  assert.ok(!existsSync(path.join(runDir(repo), "verify.json")), "--add wrote verify.json");
  assert.equal(nextLines(out).length, 1, out);

  refused(repo, "verify", ["--drop", cfg.cmd]);
  assert.deepEqual(ledgerOf(repo).verifyAdded, [added.cmd]);
  refused(repo, "verify", ["--drop", "never added"]);
  cli(repo, "verify", ["--drop", added.cmd]);
  assert.deepEqual(ledgerOf(repo).verifyAdded ?? [], []);
  assert.equal(added.runs() + cfg.runs(), 0, "--drop ran a command");
  assert.match(cli(repo, "verify").stdout, /all 1 green/);
  assert.deepEqual([cfg.runs(), added.runs()], [1, 0], "a dropped command still ran, or the config command did not");

  const only = counter("sf-c22-only");
  const empty = opened("sf-c22-empty", { "count.mjs": COUNT_SRC, ...config({ verify: [] }) });
  assert.match(refused(empty, "verify"), /nothing to verify/);
  cli(empty, "verify", ["--add", only.cmd]);
  assert.match(cli(empty, "verify").stdout, /all 1 green/);
  assert.equal(only.runs(), 1);
  assert.deepEqual(verifyJson(empty).commands.map((c) => [c.cmd, c.exit]), [[only.cmd, 0]]);
});

test("C23 idempotent: green, then two verifies with only test edits in between: the source-only command is skipped both times", () => {
  const build = counter("sf-c23");
  const repo = opened("sf-c23", { "count.mjs": COUNT_SRC, ...config({ verify: [{ cmd: build.cmd, when: "source" }, "true"] }) });
  write(repo, "src/a.ts", REWRITE);
  assert.match(cli(repo, "verify").stdout, /all 2 green/);
  assert.equal(build.runs(), 1);
  for (const n of [2, 3]) {
    write(repo, "tests/a.test.ts", `test('a', () => {});\n// pass ${n}\n`);
    assert.match(cli(repo, "verify").stdout, /all 1 green/, `verify ${n}`);
    assert.equal(build.runs(), 1, `verify ${n} ran the source-only command`);
    assert.ok(verifyJson(repo).commands.find((c) => c.cmd === build.cmd).skipped, `verify ${n}`);
  }
  // the green hash was carried through both skips: a real edit still runs it
  write(repo, "src/a.ts", REWRITE.replace("b0", "c0"));
  cli(repo, "verify");
  assert.equal(build.runs(), 2);
});

test("C24 edge: amending C1 after the first source edit does not mark the case table late in the report", () => {
  const LATE = /case table written after the first source edit/;
  // control: the same edit with the case table written after it is late
  const control = planned("sf-c24-control");
  leadEdit(control, "src/a.ts");
  write(control, "src/a.ts", REWRITE);
  cli(control, "case", ["add", "renders the badge", "--kind", "happy"]);
  assert.match(cli(control, "report").stdout, LATE, "premise: a case table written after the edit reads as late");

  const repo = planned("sf-c24");
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  leadEdit(repo, "src/a.ts");
  write(repo, "src/a.ts", REWRITE);
  assert.doesNotMatch(cli(repo, "report").stdout, LATE, "premise: on time before the amend");
  cli(repo, "case", ["amend", "C1", "renders the badge in the card header"]);
  assert.equal(ledgerOf(repo).cases[0].case, "renders the badge in the card header");
  assert.doesNotMatch(cli(repo, "report").stdout, LATE);
  assert.equal(ruleLines(cli(repo, "check").stdout, "R2"), "");
  assert.doesNotMatch(cli(repo, "report", ["--brief"]).stdout, /list of test cases was written after/);
});

test("C25 edge: after a session joins the run again (clear, resume, compact or gate attach) the next line is the full text once more", () => {
  const repo = repoOf("sf-c25");
  sessionStart(repo, "S1");
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  const FULL = "Traced: <file:line pointers>";
  assert.ok(lastLine(cli(repo, "decide", DECIDE).stdout).length < 200, "premise: the second hint is short");

  for (const source of ["clear", "resume", "compact"]) {
    const session = `S-${source}`;
    sessionStart(repo, session, source);
    assert.match(loadSession(stateDir(repo), session).current ?? "", /-t$/, `premise: ${source} joined the run`);
    const first = lastLine(cli(repo, "decide", DECIDE, { session }).stdout);
    assert.ok(first.includes(FULL), `after ${source} the hint is not the full text:\n${first}`);
    const second = lastLine(cli(repo, "decide", DECIDE, { session }).stdout);
    assert.ok(second.length < 200 && second.includes("gate next"), `after ${source} the full text came twice:\n${second}`);
  }

  // the same session id starting again: only the reset can make the hint long again
  for (const source of ["clear", "resume", "compact"]) {
    assert.ok(lastLine(cli(repo, "decide", DECIDE).stdout).length < 200, `premise: S1 is on the short form before ${source}`);
    sessionStart(repo, "S1", source);
    const first = lastLine(cli(repo, "decide", DECIDE).stdout);
    assert.ok(first.includes(FULL), `after ${source} of the same session the hint is not the full text:\n${first}`);
  }

  sessionStart(repo, "S9", "startup");
  const attach = cli(repo, "attach", ["t"], { session: "S9" }).stdout;
  assert.ok(lastLine(attach).includes(FULL), `gate attach did not print the full text:\n${attach}`);
  assert.ok(lastLine(cli(repo, "decide", DECIDE, { session: "S9" }).stdout).length < 200);
  const again = cli(repo, "attach", ["t"], { session: "S9" }).stdout;
  assert.ok(lastLine(again).includes(FULL), `gate attach by a session that already saw the step did not print the full text:\n${again}`);
});

test("C26 happy: gate help names case amend, case add --batch, next, verify --add and --drop", () => {
  const help = cli(repo26(), "help").stdout;
  assert.match(help, /case amend/);
  assert.match(help, /case add[^\n]*--batch|--batch <file>/);
  assert.match(help, /^\s*next\b/m, "gate help has no line for the next verb");
  assert.match(help, /verify[^\n]*--add/);
  assert.match(help, /--drop/);
});
function repo26() {
  return makeRepo("sf-c26");
}
