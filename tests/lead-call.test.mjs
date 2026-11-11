// The lead's call: `gate call <key> "<why>"` records the lead's own decision to skip the app
// drive, the real-schema check, the blind QA pass or a helper's missed search. No user words;
// the reason has to name something of this task, and the report shows it as the lead's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gate, lookedUp, makeRepo, pluginRoot, readyToEdit, waiveArgs, write } from "./helpers.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { stageOutcome } from "../scripts/lib/report.mjs";
import { lapseWaivers } from "../scripts/lib/rules.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

const envFor = (repo) => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
};
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const stepState = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key)?.state ?? null;
const ruleLines = (repo, rule) => cli(repo, "check").split("\n").filter((l) => new RegExp(`\\b${rule}\\b`).test(l)).join("\n");
const hook = (repo, payload) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
function edit(repo, rel, content, agent = null) {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_response: {}, ...(agent ?? {}) });
}

const PAGE = "src/app/page.tsx";
const SCHEMA = "db/schema.sql";
const CONFIG = { source: ["src/**", "tests/**", "db/**"], tests: ["tests/**"], ui: ["src/app/**"], schema: ["db/**"], verify: ["true"], testFiles: null };
function opened(name, { playbook = "feature", plan = ["--files", PAGE], config = CONFIG } = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify(config), [SCHEMA]: "create table a (id int);\n" });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, playbook]);
  readyToEdit(repo, { plan });
  return repo;
}
const uiEdit = (repo, value = 1) => edit(repo, PAGE, `export default () => ${value};\n`);
const DRIVE_WHY = "the change to page.tsx is a text tweak that tests/a.test.ts covers";
const helper = (id, role) => ({ agent_id: id, agent_type: `done-gate:${role}` });
function skippingWorker(repo, id) {
  hook(repo, { hook_event_name: "SubagentStart", ...helper(id, "worker") });
  edit(repo, "src/a.ts", `export const a = "${id}";\n`, helper(id, "worker"));
  hook(repo, { hook_event_name: "SubagentStop", ...helper(id, "worker") });
}

test("C1 happy: a UI file changed and not driven: gate call driver naming the file clears the drive check with no user words", () => {
  const repo = opened("lc-c1");
  uiEdit(repo);
  const r4 = ruleLines(repo, "R4");
  assert.match(r4, /gate call driver/, r4);
  assert.doesNotMatch(r4, /user's waiver|--user-ok/, r4);
  assert.match(cli(repo, "call", ["driver", DRIVE_WHY]), /called driver \(clears R4 and step \{driver\}\)/);
  assert.equal(ruleLines(repo, "R4"), "");
  const [w, ...rest] = ledgerOf(repo).waivers;
  assert.equal(rest.length, 0);
  assert.deepEqual({ key: w.key, by: w.by, reason: w.reason, files: w.files }, { key: "driver", by: "lead", reason: DRIVE_WHY, files: [PAGE] });
  assert.ok(!("words" in w) && !("code" in w), JSON.stringify(w));
  assert.equal(stepState(repo, "driver"), "WAIVED");
});

test("C2 happy: a schema file changed: gate call schema naming it clears the probe check", () => {
  const repo = opened("lc-c2", { plan: ["--files", SCHEMA] });
  edit(repo, SCHEMA, "-- the id\ncreate table a (id int);\n");
  const r6 = ruleLines(repo, "R6");
  assert.match(r6, /gate call schema/, r6);
  assert.doesNotMatch(r6, /user's waiver|--user-ok/, r6);
  cli(repo, "call", ["schema", "schema.sql only gains a comment line, no reader changes"]);
  assert.equal(ruleLines(repo, "R6"), "");
  assert.deepEqual(ledgerOf(repo).waivers[0].files, [SCHEMA]);
});

test("C3 happy: a large run with no QA helper: gate call qa-pass naming a test file, or a case id, clears the blind QA check", () => {
  for (const [name, why] of [["lc-c3", "tests/a.test.ts already holds every row of the case table"], ["lc-c3b", "C1 is the only case and its test is written"]]) {
    const repo = opened(name, { plan: ["--files", "src/a.ts", "--size", "large"] });
    edit(repo, "src/a.ts", "export const a = 1;\n");
    edit(repo, "tests/a.test.ts", "test('a', () => { 1; });\n");
    const r7 = ruleLines(repo, "R7");
    assert.match(r7, /blind QA pass is due[^\n]*gate call qa-pass/, r7);
    assert.doesNotMatch(r7, /user's waiver|--user-ok/, r7);
    cli(repo, "call", ["qa-pass", why]);
    assert.doesNotMatch(ruleLines(repo, "R7"), /blind QA/);
  }
});

test("C4 happy: a helper that skipped its search: gate call lookups naming its id clears it; a later helper that skips is asked again", () => {
  const repo = opened("lc-c4", { plan: ["--files", "src/a.ts"] });
  skippingWorker(repo, "W1");
  const r17 = ruleLines(repo, "R17");
  assert.match(r17, /W1[^\n]*gate call lookups/, r17);
  assert.doesNotMatch(r17, /user's waiver|--user-ok/, r17);
  assert.match(run(repo, "call", ["lookups", "the worker was cut off by a network error"]).stderr, /names nothing of this task/);
  cli(repo, "call", ["lookups", "worker W1 was cut off by a network error"]);
  assert.equal(ruleLines(repo, "R17"), "");
  assert.deepEqual(ledgerOf(repo).waivers[0].helpers, ["W1"]);
  skippingWorker(repo, "W2");
  const again = ruleLines(repo, "R17");
  assert.match(again, /W2/, again);
  assert.doesNotMatch(again, /W1/, again);
  cli(repo, "call", ["lookups", "worker W2 only reformatted the file W1 wrote"]);
  assert.equal(ruleLines(repo, "R17"), "");
  assert.match(run(repo, "call", ["lookups", "worker W2 only reformatted the file W1 wrote"]).stderr, /nothing to call/);
});

test("C5 refused: every key that is not the lead's call is refused with what to do instead, and nothing is recorded", () => {
  const repo = opened("lc-c5");
  uiEdit(repo);
  for (const key of ["review", "review-2", "tests", "verify", "gate-config", "evidence", "slop", "coverage", "repro", "skeptic", "nonsense"]) {
    const r = run(repo, "call", [key, DRIVE_WHY]);
    assert.equal(r.status, 1, key);
    assert.match(r.stderr, /is not the lead's call/, `${key}: ${r.stderr}`);
  }
  assert.match(run(repo, "call", ["review", DRIVE_WHY]).stderr, /one round and one re-check/);
  assert.match(run(repo, "call", ["tests", DRIVE_WHY]).stderr, /no skip/);
  assert.match(run(repo, "call", ["gate-config", DRIVE_WHY]).stderr, /the user's/);
  assert.match(run(repo, "call", ["driver"]).stderr, /usage: gate call/);
  assert.deepEqual(ledgerOf(repo).waivers, []);
});

test("C6 refused: a call for a check that is not owed is refused", () => {
  const repo = opened("lc-c6", { plan: ["--files", "src/a.ts"] });
  edit(repo, "src/a.ts", "export const a = 1;\n");
  for (const key of ["driver", "schema", "qa-pass", "lookups"]) {
    assert.match(run(repo, "call", [key, "src/a.ts is one constant and tests/a.test.ts covers it"]).stderr, /nothing to call/, key);
  }
  assert.deepEqual(ledgerOf(repo).waivers, []);
});

test("C7 refused: a reason under six words, or one naming nothing of this task, is refused", () => {
  const repo = opened("lc-c7");
  uiEdit(repo);
  assert.match(run(repo, "call", ["driver", "page.tsx is a tweak"]).stderr, /at least six words/);
  assert.match(run(repo, "call", ["driver", "this change is small and needs no drive at all"]).stderr, /names nothing of this task/);
  assert.match(run(repo, "call", ["driver", "the homepage.tsx file is a small text tweak only"]).stderr, /names nothing of this task/, "a longer name holding the basename is not it");
  assert.deepEqual(ledgerOf(repo).waivers, []);
});

test("C8 boundary: a reason of exactly six words naming the file by its basename is taken", () => {
  const repo = opened("lc-c8");
  uiEdit(repo);
  cli(repo, "call", ["driver", "page.tsx copy tweak, tests cover it"]);
  assert.equal(ruleLines(repo, "R4"), "");
});

test("C9 edge: --could-not-run on driver takes a reason naming no file and reports could not run; on qa-pass it is refused", () => {
  const repo = opened("lc-c9");
  uiEdit(repo);
  assert.match(run(repo, "call", ["qa-pass", DRIVE_WHY, "--could-not-run"]).stderr, /driver or schema/);
  assert.match(run(repo, "call", ["driver", "chrome is down", "--could-not-run"]).stderr, /at least six words/);
  cli(repo, "call", ["driver", "Chrome cannot reach localhost on this laptop", "--could-not-run"]);
  assert.equal(stepState(repo, "driver"), "COULD NOT RUN");
  assert.equal(ruleLines(repo, "R4"), "");
  assert.match(cli(repo, "report"), /could not run driver: Chrome cannot reach localhost on this laptop \(the lead's call\)/);
});

test("C10 refused: a second call on a key that still holds is refused", () => {
  const repo = opened("lc-c10");
  uiEdit(repo);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  assert.match(run(repo, "call", ["driver", DRIVE_WHY]).stderr, /already holds/);
  assert.equal(ledgerOf(repo).waivers.length, 1);
});

test("C11 C23 edge: a fix inside the same UI file keeps the call; a second UI file lapses it, reopens the step and brings the check back", () => {
  const repo = opened("lc-c11");
  uiEdit(repo);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  uiEdit(repo, 2);
  assert.equal(ruleLines(repo, "R4"), "", "a fix in the same file");
  assert.equal(stepState(repo, "driver"), "WAIVED");
  edit(repo, "src/app/other.tsx", "export default () => 3;\n");
  assert.match(ruleLines(repo, "R4"), /gate call driver/);
  assert.equal(stepState(repo, "driver"), null);
  assert.equal(ledgerOf(repo).waivers[0].lapsed, true);
  const report = cli(repo, "report");
  assert.match(report, /the lead's call on driver: [^\n]*no longer holds: another UI, API or schema file changed after it/);
  assert.doesNotMatch(cli(repo, "report", ["--brief"]), /your OK/);
  cli(repo, "call", ["driver", "other.tsx and page.tsx are both text tweaks under test"]);
  assert.equal(ruleLines(repo, "R4"), "");
});

test("C12 idempotent: gate waive driver still needs the user's words, still works with them and still lapses on a code edit", () => {
  const repo = opened("lc-c12");
  uiEdit(repo);
  assert.match(run(repo, "waive", ["driver", "no need"]).stderr, /--user-ok/);
  cli(repo, "waive", waiveArgs(repo, "driver", "the user said to skip it"));
  assert.equal(ruleLines(repo, "R4"), "");
  assert.equal(ledgerOf(repo).waivers[0].by, undefined);
  uiEdit(repo, 2);
  assert.match(ruleLines(repo, "R4"), /R4/);
});

test("C13 reported-surface: the review messages and the review N/A refusal offer no skip; the driver N/A refusal offers the call", () => {
  const repo = opened("lc-c13", { plan: ["--files", `src/a.ts,${PAGE}`], config: { ...CONFIG, highRisk: ["src/a.ts"] } });
  edit(repo, "src/a.ts", Array.from({ length: 20 }, (_, i) => `export const b${i} = ${i};`).join("\n") + "\n");
  uiEdit(repo);
  for (const rule of ["R5", "R9"]) {
    const text = ruleLines(repo, rule);
    assert.ok(text, `${rule} is not unmet`);
    assert.doesNotMatch(text, /waiver|--user-ok|gate call/, text);
  }
  const reviewNa = run(repo, "step", ["review", "na", "not needed"]).stderr;
  assert.match(reviewNa, /the review is owed/);
  assert.doesNotMatch(reviewNa, /waiver|--user-ok/, reviewNa);
  const driverNa = run(repo, "step", ["driver", "na", "not needed"]).stderr;
  assert.match(driverNa, /gate call driver/);
  assert.doesNotMatch(driverNa, /waiver|--user-ok/, driverNa);
});

test("C14 reported-surface: the report, the step outcome and the For you line show the call as the lead's decision", () => {
  const repo = opened("lc-c14");
  uiEdit(repo);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  assert.match(cli(repo, "report"), new RegExp(`- the lead's call on driver: ${DRIVE_WHY.replace(/[.]/g, "\\.")}`));
  const brief = cli(repo, "report", ["--brief"]);
  assert.match(brief, /decided without asking: no app drive \(the change to page\.tsx is a text tweak/);
  assert.doesNotMatch(brief, /your OK/);
  const state = { ledger: { waivers: [{ key: "driver", by: "lead", reason: "r" }, { key: "schema", by: "lead", could: true, reason: "no db here" }], huddles: [] } };
  assert.equal(stageOutcome(state, { key: "driver", state: "WAIVED" }), "skipped: the lead's call — r");
  assert.equal(stageOutcome(state, { key: "schema", state: "COULD NOT RUN" }), "skipped: could not run — no db here (the lead's call)");
});

test("C17 reported-surface: SKILL.md, the help text and the README say the lead makes the call and never asks the user to skip a check", () => {
  const skill = readFileSync(path.join(pluginRoot, "skills/gate/SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.match(skill, /gate call <key> "<why>"/);
  assert.match(skill, /never ask the user to skip a check/i);
  assert.doesNotMatch(skill, /ask, then `gate waive/);
  assert.match(cli(makeRepo("lc-c17"), "help"), /call <driver\|schema\|qa-pass\|lookups> "<why>"/);
  const readme = readFileSync(path.join(pluginRoot, "README.md"), "utf8").replace(/\s+/g, " ");
  assert.match(readme, /`gate call <driver\|schema\|qa-pass\|lookups> "<why>"`/);
  assert.match(readme, /in a bug-fix run the app drive has no call/);
});

test("C19 performance: 1000 call records lapse-check in under 50 ms and none lapses while its files still cover the surface", () => {
  const ledger = { steps: [], waivers: Array.from({ length: 1000 }, (_, i) => ({ key: i % 2 ? "driver" : "schema", by: "lead", reason: "r", files: ["a.tsx", "b.tsx"] })) };
  const started = performance.now();
  const moved = lapseWaivers(ledger, "h", Date.now(), () => ["a.tsx"]);
  assert.ok(performance.now() - started < 50);
  assert.equal(moved, false);
  assert.equal(lapseWaivers(ledger, "h", Date.now(), () => ["a.tsx", "c.tsx"]), true);
  assert.ok(ledger.waivers.every((w) => w.lapsed));
});

test("C20 refused: a helper running gate call is denied by the guard; the lead running it is not", () => {
  const repo = opened("lc-c20");
  for (const command of [`node ${gate} call driver "${DRIVE_WHY}"`, `gate() { node "${gate}" "$@"; }; gate call lookups "worker W1 was cut off by the network"`, `cd ${repo} && G="node ${gate}"; $G call driver "x"`]) {
    const denied = decide({ tool_name: "Bash", tool_input: { command }, ...helper("W1", "worker") }, repo);
    assert.equal(denied.deny, true, command);
    assert.match(denied.reason, /only the lead makes a call/);
    assert.notEqual(decide({ tool_name: "Bash", tool_input: { command } }, repo).deny, true, `the lead: ${command}`);
  }
  const shapes = [`"$G" call driver "x"`, `env FOO=1 node /p/gate.mjs call driver "x"`, `DONE_GATE_SESSION=S1 node /p/gate.mjs call driver "x"`, `if true; then node /p/gate.mjs call driver "x"; fi`, `bash -c "node /p/gate.mjs call driver x"`, `node --no-warnings /p/gate.mjs call driver "x"`, `node "/Users/a b/scripts/gate.mjs" call driver "x"`, `time node /p/gate.mjs call driver "x"`];
  for (const command of shapes) assert.equal(decide({ tool_name: "Bash", tool_input: { command }, ...helper("W1", "worker") }, repo).deny, true, command);
  const reads = ['grep -rn "gate call" README.md', "cat <<'EOF' > /dev/null\ngate call driver x\nEOF", `node ${gate} check`];
  for (const command of reads) assert.notEqual(decide({ tool_name: "Bash", tool_input: { command }, ...helper("R1", "reviewer") }, repo).deny, true, command);
});

test("C21 refused: in a bug-fix run gate call driver is refused unless the app could not run", () => {
  const repo = opened("lc-c21", { playbook: "bugfix" });
  uiEdit(repo);
  for (const text of [run(repo, "step", ["driver", "na", "not needed"]).stderr, run(repo, "step", ["driver", "skipped", "not needed"]).stderr, ruleLines(repo, "R4")]) {
    assert.match(text, /gate call driver "<why>" --could-not-run/, text);
    assert.doesNotMatch(text, /decide it yourself/, text);
  }
  const r = run(repo, "call", ["driver", DRIVE_WHY]);
  assert.match(r.stderr, /a bug fix is driven again[^\n]*--could-not-run/);
  assert.deepEqual(ledgerOf(repo).waivers, []);
  cli(repo, "call", ["driver", "Chrome cannot reach localhost on this laptop", "--could-not-run"]);
  assert.equal(stepState(repo, "driver"), "COULD NOT RUN");
});

test("C22 edge: huddle add of a file whose writer skipped its search offers the call, and is taken once a call names that helper", () => {
  const repo = opened("lc-c22", { plan: ["--files", "src/a.ts"] });
  edit(repo, "src/a.ts", Array.from({ length: 20 }, (_, i) => `export const b${i} = ${i};`).join("\n") + "\n");
  const file = /Your file is (\S+\.md)/.exec(cli(repo, "brief", ["reviewer"]))[1];
  hook(repo, { hook_event_name: "SubagentStart", ...helper("R1", "reviewer") });
  writeFileSync(file, "# Review 1\n\n## Act on\n- none\n## Can't verify\n- none\n## Lessons\n- none\n## Dismissed\n- none\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, tool_response: {}, ...helper("R1", "reviewer") });
  hook(repo, { hook_event_name: "SubagentStop", ...helper("R1", "reviewer") });
  const refused = run(repo, "huddle", ["add", "reviewer", "--file", path.basename(file)]);
  assert.match(refused.stderr, /without searching first[^\n]*gate call lookups/);
  cli(repo, "call", ["lookups", "reviewer R1 lost its connection before it could search"]);
  assert.equal(run(repo, "huddle", ["add", "reviewer", "--file", path.basename(file)]).status, 0);
});

// A reviewer checks the lead's calls: a full packet that shows the call's file lists it, and a
// call no recorded round was shown blocks until a light check (`gate brief reviewer --calls`).
const BODY = Array.from({ length: 20 }, (_, i) => `export const b${i} = ${i};`).join("\n") + "\n";
const packetOf = (out) => readFileSync(/packet: (\S+)/.exec(out)[1], "utf8");
const ownFile = (out) => /Your file is (\S+\.md)/.exec(out)[1];
let helpers = 0;
function recorded(repo, briefOut, { role = "reviewer", actOn = [] } = {}) {
  const who = helper(`H${++helpers}`, role);
  const file = ownFile(briefOut);
  hook(repo, { hook_event_name: "SubagentStart", ...who });
  lookedUp(repo, { agent: who.agent_id, role });
  writeFileSync(file, `# Review\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n## Can't verify\n- none\n## Lessons\n- none\n## Dismissed\n- none\n`);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, tool_response: {}, ...who });
  hook(repo, { hook_event_name: "SubagentStop", ...who });
  cli(repo, "huddle", ["add", role, "--file", path.basename(file)]);
  return file;
}
const BOTH = { plan: ["--files", `src/a.ts,${PAGE}`] };
const CALLS_HEAD = "## The lead's calls";

test("RV1 happy: a call made before the review rides in the reviewer's packet with its reason, and once that round is recorded it waits for nothing", () => {
  const repo = opened("lc-rv1", BOTH);
  edit(repo, "src/a.ts", BODY);
  uiEdit(repo);
  assert.match(cli(repo, "call", ["driver", DRIVE_WHY]), /A reviewer checks it/);
  assert.match(ruleLines(repo, "R21"), /the lead's call on driver was shown to no reviewer[^\n]*gate brief reviewer --calls/);
  const out = cli(repo, "brief", ["reviewer"]);
  const packet = packetOf(out);
  assert.ok(packet.includes(`${CALLS_HEAD}\n`), packet);
  assert.ok(packet.includes(`- driver — ${DRIVE_WHY}`), packet);
  assert.match(packet, /put it under Act on as `Call: <key> — /);
  assert.match(ruleLines(repo, "R21"), /driver/, "a packet out is not a round recorded");
  recorded(repo, out);
  assert.equal(ruleLines(repo, "R21"), "");
});

test("RV2 happy: on a tiny run the call waits for a light check; its packet holds the calls and the diff only and says low effort", () => {
  const repo = opened("lc-rv2");
  uiEdit(repo);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  assert.match(ruleLines(repo, "R21"), /gate brief reviewer --calls/);
  assert.match(run(repo, "brief", ["skeptic", "--calls"]).stderr, /the reviewer's light check/);
  assert.match(run(repo, "brief", ["reviewer-2", "--calls"]).stderr, /the reviewer's light check/);
  assert.match(run(repo, "brief", ["reviewer", "--calls", "--files", PAGE]).stderr, /takes no --files/);
  const out = cli(repo, "brief", ["reviewer", "--calls"]);
  assert.match(out, /effort[^\n]*low/);
  const packet = packetOf(out);
  assert.match(packet, /## Light check\n\nJudge the lead's calls below and nothing else: run no tests and do not review the code\./);
  assert.ok(packet.includes(`- driver — ${DRIVE_WHY}`), packet);
  assert.match(packet, /\+export default \(\) => 1;/);
  assert.doesNotMatch(packet, /## Test command|## Verify/);
  recorded(repo, out);
  assert.equal(ruleLines(repo, "R21"), "");
  assert.match(run(repo, "brief", ["reviewer", "--calls"]).stderr, /no call waits for a reviewer/);
  const brief = cli(repo, "report", ["--brief"]);
  assert.match(brief, /No code review; a reviewer checked the lead's calls/);
  assert.doesNotMatch(brief, /Review: 1 round/);
});

test("RV3 edge: the light round covers no line, so the code review is still owed; a finding it raises on a call blocks until closed", () => {
  const repo = opened("lc-rv3", BOTH);
  edit(repo, "src/a.ts", BODY);
  uiEdit(repo);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  recorded(repo, cli(repo, "brief", ["reviewer", "--calls"]), { actOn: ["Call: driver — the page's only button moved — src/app/page.tsx:1"] });
  assert.equal(ruleLines(repo, "R21"), "");
  assert.match(ruleLines(repo, "R5"), /no reviewer pass after the last edit/);
  assert.match(cli(repo, "check"), /still open[^:\n]*: H1\.1 \(Call: driver/);
});

test("RV4 happy: gate call --withdraw takes a call back: the step reopens, the check returns, the report says taken back, and it may be made again", () => {
  const repo = opened("lc-rv4");
  uiEdit(repo);
  assert.match(run(repo, "call", ["driver", "--withdraw"]).stderr, /no call on driver holds/);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  assert.match(cli(repo, "call", ["driver", "--withdraw"]), /taken back/);
  assert.equal(stepState(repo, "driver"), null);
  assert.match(ruleLines(repo, "R4"), /R4/);
  assert.equal(ruleLines(repo, "R21"), "", "a call that no longer holds asks for no check");
  assert.match(cli(repo, "report"), /the lead's call on driver: [^\n]* — taken back/);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  assert.match(ruleLines(repo, "R21"), /driver/);
  assert.doesNotMatch(packetOf(cli(repo, "brief", ["reviewer", "--calls"])).split(CALLS_HEAD)[1], /driver[^\n]*\n- driver/, "the withdrawn call is not listed beside the new one");
});

test("RV5 idempotent: a run with no call gets no section in its packet and no R21; a lookups call asks for no reviewer", () => {
  const repo = opened("lc-rv5", { plan: ["--files", "src/a.ts"] });
  edit(repo, "src/a.ts", BODY);
  assert.equal(ruleLines(repo, "R21"), "");
  assert.ok(!packetOf(cli(repo, "brief", ["reviewer"])).includes(CALLS_HEAD));
  skippingWorker(repo, "W1");
  cli(repo, "call", ["lookups", "worker W1 was cut off by a network error"]);
  assert.equal(ruleLines(repo, "R21"), "");
});

test("RV6 reported-surface: both reviewer briefs, SKILL.md and the README name the calls section, the light check and R21", () => {
  for (const role of ["reviewer", "reviewer-2"]) {
    const text = readFileSync(path.join(pluginRoot, "agents", `${role}.md`), "utf8").replace(/\s+/g, " ");
    assert.match(text, /`## The lead's calls`/, role);
    assert.match(text, /`Call: <key> — /, role);
  }
  assert.match(readFileSync(path.join(pluginRoot, "agents/reviewer.md"), "utf8"), /`## Light check`/);
  const skill = readFileSync(path.join(pluginRoot, "skills/gate/SKILL.md"), "utf8");
  assert.match(skill, /R17-R21\)/);
  assert.ok(Buffer.byteLength(skill) < 4096);
  const readme = readFileSync(path.join(pluginRoot, "README.md"), "utf8");
  assert.match(readme, /^\| R21 \| a call of the lead's that holds and that no recorded reviewer round was shown/m);
  assert.match(readme.replace(/\s+/g, " "), /`gate brief reviewer --calls`/);
  assert.match(readme.replace(/\s+/g, " "), /`gate call <key> --withdraw`/);
});

test("RV7 edge: the second reviewer's packet lists the calls too, and its recorded round counts", () => {
  const repo = opened("lc-rv7", { ...BOTH, config: { ...CONFIG, highRisk: ["src/a.ts"] } });
  edit(repo, "src/a.ts", BODY);
  uiEdit(repo);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  const out = cli(repo, "brief", ["reviewer-2"]);
  assert.ok(packetOf(out).includes(`- driver — ${DRIVE_WHY}`));
  recorded(repo, out, { role: "reviewer-2" });
  assert.equal(ruleLines(repo, "R21"), "");
});

test("RV8 performance: 200 calls against 50 recorded rounds are judged in under 50 ms", async () => {
  const { unseenCalls } = await import("../scripts/lib/rules.mjs");
  const waivers = Array.from({ length: 200 }, (_, i) => ({ key: "driver", by: "lead", reason: "r", seq: i }));
  const huddles = Array.from({ length: 50 }, (_, i) => ({ role: "reviewer", file: `review-${i}.md`, actOn: [], calls: [i * 2] }));
  const started = performance.now();
  const waiting = unseenCalls({ waivers, huddles });
  assert.ok(performance.now() - started < 50);
  assert.equal(waiting.length, 150);
});

test("RV9 edge: a piece packet that does not show the call's file does not list it, and that round does not clear the wait; a fix-check lists none", () => {
  const repo = opened("lc-rv9", BOTH);
  edit(repo, "src/a.ts", BODY);
  uiEdit(repo);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  const piece = cli(repo, "brief", ["reviewer", "--files", "src/a.ts"]);
  assert.ok(!packetOf(piece).includes(CALLS_HEAD));
  recorded(repo, piece, { actOn: ["off by one — src/a.ts:3 — x"] });
  assert.match(ruleLines(repo, "R21"), /driver/);
  recorded(repo, cli(repo, "brief", ["reviewer", "--files", PAGE]));
  assert.equal(ruleLines(repo, "R21"), "", "the piece that shows page.tsx lists the call");
  cli(repo, "call", ["driver", "--withdraw"]);
  edit(repo, "src/a.ts", BODY.replace("b2 = 2", "b2 = 3"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  const fixCheck = packetOf(cli(repo, "brief", ["reviewer", "--files", "src/a.ts"]));
  assert.match(fixCheck, /## Findings to re-check/);
  assert.ok(!fixCheck.includes(CALLS_HEAD), "a re-check judges fixed lines, not calls");
});

test("RV10 edge: a light check takes its own number while a review packet is out, keeps it when briefed again, and a cut-off one is re-briefed with --calls", () => {
  const repo = opened("lc-rv10", BOTH);
  edit(repo, "src/a.ts", BODY);
  uiEdit(repo);
  const review = ownFile(cli(repo, "brief", ["reviewer", "--files", "src/a.ts"]));
  cli(repo, "call", ["driver", DRIVE_WHY]);
  const light = ownFile(cli(repo, "brief", ["reviewer", "--calls"]));
  assert.notEqual(path.basename(light), path.basename(review));
  assert.equal(ownFile(cli(repo, "brief", ["reviewer", "--calls"])), light);
  const who = helper("CUT", "reviewer");
  hook(repo, { hook_event_name: "SubagentStart", ...who });
  writeFileSync(light, "# Review\n\n## Act on\n- unverified\n## Can't verify\n- unverified\n## Lessons\n- unverified\n## Dismissed\n- unverified\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: light }, tool_response: {}, ...who });
  hook(repo, { hook_event_name: "SubagentStop", ...who });
  const draft = run(repo, "huddle", ["add", "reviewer", "--file", path.basename(light)]).stderr;
  assert.match(draft, /is a draft[^\n]*`gate brief reviewer --calls`/, draft);
  const r15 = cli(repo, "check").split(/\n| · /).filter((l) => l.includes(path.basename(light))).join("\n");
  assert.match(r15, /gate brief reviewer --calls`/, r15);
  assert.doesNotMatch(r15, /--files/, r15);
});

test("RV11 edge: a call made after a reviewer was briefed still waits once that round is recorded; of two calls only the one not shown waits", () => {
  const repo = opened("lc-rv11", { plan: ["--files", `src/a.ts,${PAGE},${SCHEMA}`] });
  edit(repo, "src/a.ts", BODY);
  uiEdit(repo);
  edit(repo, SCHEMA, "-- the id\ncreate table a (id int);\n");
  cli(repo, "call", ["driver", DRIVE_WHY]);
  const out = cli(repo, "brief", ["reviewer"]);
  cli(repo, "call", ["schema", "schema.sql only gains a comment line, no reader changes"]);
  recorded(repo, out);
  const r21 = ruleLines(repo, "R21");
  assert.match(r21, /the lead's call on schema/, r21);
  assert.doesNotMatch(r21, /driver/, r21);
});

test("RV12 edge: a call on a file outside the source globs rides the full packet that shows that file's diff", () => {
  const repo = opened("lc-rv12", { plan: ["--files", `src/a.ts,${SCHEMA}`], config: { ...CONFIG, source: ["src/**", "tests/**"] } });
  edit(repo, "src/a.ts", BODY);
  edit(repo, SCHEMA, "-- the id\ncreate table a (id int);\n");
  cli(repo, "call", ["schema", "schema.sql only gains a comment line, no reader changes"]);
  const out = cli(repo, "brief", ["reviewer"]);
  assert.ok(packetOf(out).includes(CALLS_HEAD), packetOf(out));
  recorded(repo, out);
  assert.equal(ruleLines(repo, "R21"), "");
});

test("RV13 edge: the review step never closes on the light check's file", () => {
  const repo = opened("lc-rv13", BOTH);
  edit(repo, "src/a.ts", BODY);
  uiEdit(repo);
  const full = recorded(repo, cli(repo, "brief", ["reviewer"]), { actOn: ["a stale comment — src/a.ts:3 — x"] });
  cli(repo, "call", ["driver", DRIVE_WHY]);
  const light = recorded(repo, cli(repo, "brief", ["reviewer", "--calls"]));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  cli(repo, "check");
  const step = ledgerOf(repo).steps.find((s) => s.key === "review");
  assert.equal(step.state, "DONE", JSON.stringify(step));
  assert.equal(step.evidence, path.basename(full));
  assert.notEqual(step.evidence, path.basename(light));
});

test("RV14 edge: a light check alone never stands in for the review when no changed file is in the review scope", () => {
  const repo = opened("lc-rv14", { plan: ["--files", `tests/big.test.ts,${PAGE}`, "--size", "small"], config: { ...CONFIG, source: ["tests/**"] } });
  edit(repo, "tests/big.test.ts", BODY);
  uiEdit(repo);
  assert.match(ruleLines(repo, "R5"), /no reviewer pass/);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  recorded(repo, cli(repo, "brief", ["reviewer", "--calls"]));
  assert.match(ruleLines(repo, "R5"), /no reviewer pass/, "the light round reviewed no code");
});

test("RV15 edge: a light check whose helper left no file is sent back to --calls", () => {
  const repo = opened("lc-rv15");
  uiEdit(repo);
  cli(repo, "call", ["driver", DRIVE_WHY]);
  const light = ownFile(cli(repo, "brief", ["reviewer", "--calls"]));
  const gone = run(repo, "huddle", ["add", "reviewer", "--file", path.basename(light)]).stderr;
  assert.match(gone, /left no file[^\n]*`gate brief reviewer --calls`/, gone);
});
