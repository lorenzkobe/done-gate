import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, lookedUp, noLateCalls, pluginRoot, resealRun } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { sliceDiff, sliceEnd } from "../scripts/lib/tree.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
const REFUSAL = /^done-gate: /m;
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const check = (repo) => run(repo, "check").stdout;
const blocks = (out, rule) => out.split("\n").some((l) => new RegExp(`\\b${rule}\\b`).test(l));
const ruleLine = (out, rule) => out.split("\n").find((l) => new RegExp(`\\b${rule}\\b`).test(l)) ?? "";

function hook(repo, payload) {
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
}
function edit(repo, rel, content) {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) } });
}
const stop = (repo, role) => hook(repo, { hook_event_name: "SubagentStop", agent_id: `A-${role}`, agent_type: `done-gate:${role}` });
const body = (n, name, from = 0) => Array.from({ length: n }, (_, i) => `export const ${name}${from + i} = ${from + i};`).join("\n") + "\n";
const reviewFile = (n, actOn) => `# Review ${n} — x\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: npm test exit 0\n`;

// fix-check: after a round's findings are fixed and closed, only the lines the fix changed need
// another round, and that round's packet lists the findings it re-checks. Cases C1–C7 (C2 is
// tests/review-ranges.test.mjs C3, narrowed).

const MID = "src/mid.ts";
function opened(name) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"] }, null, 2), [MID]: "export const mid0 = 0;\n" });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "One module. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One module.", "--files", MID]);
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  edit(repo, MID, body(60, "mid"));
  return repo;
}
function round(repo, role, files, actOn = []) {
  const out = cli(repo, "brief", files ? [role, "--files", files] : [role]);
  const own = /Your file is .*\/((?:review2?)-\d+\.md)/.exec(out)[1];
  const n = Number(/-(\d+)\.md$/.exec(own)[1]);
  stop(repo, role);
  writeFileSync(path.join(runDir(repo), own), reviewFile(n, actOn));
  cli(repo, "huddle", ["add", role, "--file", own]);
  return out;
}
const packetOf = (out) => readFileSync(out.split("\n").find((l) => l.startsWith("packet: ")).slice(8), "utf8");
const FINDING = "off by one — src/mid.ts:30 — x — []";
const fixLine30 = (repo, v = 999) => edit(repo, MID, body(60, "mid").replace("mid30 = 30", `mid30 = ${v}`));
// the R5 line's entries for the file: the bare path, or path:from-to spans
const entriesOf = (line) => [...new Set([...line.matchAll(/src\/mid\.ts(:\d+-\d+)?/g)].map((m) => m[0]))];
// whether the entries owe a line: the bare path owes every line
const owes = (entries, pos) => entries.some((e) => e === MID || ((m) => m && Number(m[1]) <= pos && pos <= Number(m[2]))(/:(\d+)-(\d+)$/.exec(e)));

test("C1 happy: a whole-file round's fixed finding re-opens only the edited lines; a round on them clears R5", () => {
  const repo = opened("fc-c1");
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.length > 0, check(repo));
  assert.ok(entries.every((e) => /^src\/mid\.ts:3[12]-3[12]$/.test(e)), `R5 asks for more than the fixed lines: ${entries.join(", ")}`);
  round(repo, "reviewer", entries[0].slice(MID.length + 1) ? entries[0] : MID);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C3 refused: an open finding keeps the whole file uncovered; closed items with no edit after the round cover it, as today", () => {
  const repo = opened("fc-c3");
  noLateCalls(repo);
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID], "an open finding: the whole file");

  const quiet = opened("fc-c3-quiet");
  noLateCalls(quiet);
  round(quiet, "reviewer", null, [FINDING]);
  cli(quiet, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.ok(!blocks(check(quiet), "R5"), check(quiet));
});

test("C4 edge: a fix that only deletes lines re-opens the whole file", () => {
  const repo = opened("fc-c4");
  round(repo, "reviewer", null, ["dead line — src/mid.ts:60 — x — []"]);
  edit(repo, MID, body(59, "mid"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID]);
  round(repo, "reviewer", null);
  assert.ok(!blocks(check(repo), "R5"), `a clean round after the deleting fix must clear R5:\n${check(repo)}`);
});

test("C5 idempotent: a clean round still covers the file after an edit; a ledger with no recorded line keys keeps the whole-file rule", () => {
  const repo = opened("fc-c5");
  noLateCalls(repo); // the no-calls policy's rule; 6.4 L1 below is the shipped one
  round(repo, "reviewer", null);
  fixLine30(repo);
  assert.ok(!blocks(check(repo), "R5"), check(repo));

  const legacy = opened("fc-c5-legacy");
  noLateCalls(legacy);
  round(legacy, "reviewer", null, [FINDING]);
  const file = path.join(runDir(legacy), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const h of ledger.huddles) delete h.units;
  for (const s of Object.values(ledger.seen ?? {})) delete s.units;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  fixLine30(legacy);
  cli(legacy, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(legacy), "R5")), [MID]);
});

test("C6 reported-surface: the fix-check packet lists the findings to re-check with how each closed; a first round's packet has none", () => {
  const repo = opened("fc-c6");
  const first = packetOf(round(repo, "reviewer", null, [FINDING]));
  assert.doesNotMatch(first, /## Findings to re-check/);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const entry = entriesOf(ruleLine(check(repo), "R5"))[0];
  const packet = packetOf(cli(repo, "brief", ["reviewer", "--files", entry]));
  const section = /## Findings to re-check\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1] ?? "";
  assert.match(section, /H1\.1/, packet);
  assert.match(section, /off by one/);
  assert.match(section, /src\/mid\.ts:30/, "how it was closed");
  assert.match(section, /ADDRESSED or NOT ADDRESSED/);
});

test("C7 boundary: a whole-file round at the cap with a fixed finding leaves only the fixed lines for one fix-check round, which ends the review", () => {
  const repo = opened("fc-c7");
  noLateCalls(repo);
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo, 1001);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.length > 0 && entries.every((e) => /^src\/mid\.ts:\d+-\d+$/.test(e)), entries.join(", "));
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo, 2000);
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "doc"]);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C8 edge: a clean round then a round with a fixed finding: only the fixed lines re-open", () => {
  const repo = opened("fc-c8");
  noLateCalls(repo, { rounds: 2 });
  round(repo, "reviewer", null);
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "doc"]);
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.length > 0, "the earlier clean round covered lines a later fix changed");
  assert.ok(entries.every((e) => /^src\/mid\.ts:3[12]-3[12]$/.test(e)), entries.join(", "));
});

test("C9 edge: a fix that deletes one line and edits another re-opens the whole file", () => {
  const repo = opened("fc-c9");
  round(repo, "reviewer", null, [FINDING]);
  edit(repo, MID, body(60, "mid").replace("mid30 = 30", "mid30 = 999").replace("export const mid10 = 10;\n", ""));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID]);
});

test("C10 edge: deleting one line and inserting another elsewhere re-opens the whole file", () => {
  const repo = opened("fc-c10");
  round(repo, "reviewer", null, [FINDING]);
  edit(repo, MID, body(59, "mid").replace("export const mid30 = 30;\n", "export const extra = 1;\nexport const mid30 = 30;\n"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID]);
});

test("C11 refused: three slice rounds with fixed findings leave the lines no round saw uncovered", () => {
  const repo = opened("fc-c11");
  edit(repo, MID, body(100, "mid"));
  let n = 0;
  for (const span of ["1-30", "31-60", "61-90"]) {
    n += 1;
    round(repo, "reviewer", `${MID}:${span}`, [`slip — src/mid.ts:${span.split("-")[0]} — x — []`]);
    const at = Number(span.split("-")[0]) + 5;
    edit(repo, MID, readFileSync(path.join(repo, MID), "utf8").replace(`mid${at - 1} = ${at - 1};`, `mid${at - 1} = ${at - 1 + 1000};`));
    cli(repo, "huddle", ["resolve", `H${n}.1`, "--evidence", "doc"]);
  }
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.some((e) => /:9[01]-100$/.test(e)), `lines 91-100 were never reviewed: ${entries.join(", ")}`);
});

test("C12 reported-surface: a finding whose fix landed in the piece's file is re-checked there", () => {
  const repo = opened("fc-c12");
  round(repo, "reviewer", null, ["caller passes null — src/other.ts:1 — x — []"]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const packet = packetOf(cli(repo, "brief", ["reviewer", "--files", "src/mid.ts:31-31"]));
  assert.match(/## Findings to re-check\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1] ?? "", /H1\.1/, packet);
});

test("C13 happy: a fix-check slice round with a finding, fixed again, re-opens only the lines edited the second time", () => {
  const repo = opened("fc-c13");
  noLateCalls(repo, { rounds: 2 });
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo, 999);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  round(repo, "reviewer", "src/mid.ts:31-32", ["still off — src/mid.ts:31 — x — []"]);
  fixLine30(repo, 777);
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "doc"]);
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.length > 0, check(repo));
  assert.ok(entries.every((e) => /^src\/mid\.ts:3[12]-3[12]$/.test(e)), `the second fix re-opened more than its lines: ${entries.join(", ")}`);
});

test("C14 edge: an inserted copy of reviewed lines is asked for, not counted as reviewed", () => {
  const repo = opened("fc-c14");
  round(repo, "reviewer", null, [FINDING]);
  const lines = body(60, "mid").split("\n");
  lines.splice(6, 0, "export const new1 = 1;", lines[19], lines[20], lines[21]);
  edit(repo, MID, lines.join("\n"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const asked = entriesOf(ruleLine(check(repo), "R5")).flatMap((e) => {
    const m = /:(\d+)-(\d+)$/.exec(e);
    return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i) : [];
  });
  for (const at of [8, 9, 10]) assert.ok(asked.includes(at) || entriesOf(ruleLine(check(repo), "R5")).includes(MID), `inserted copy at line ${at} counted as reviewed: ${asked.join(",")}`);
});

test("C15 edge: a deletion and a far insertion in the same gap still re-open the whole file", () => {
  const base = body(100, "b");
  const repo = makeRepo("fc-c15", { ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"] }, null, 2), [MID]: base });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["fc-c15", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "One module. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One module.", "--files", MID]);
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  const lines = base.split("\n");
  const task = [...lines.slice(0, 10), "export const A1 = 1;", "export const A2 = 2;", "export const A3 = 3;", ...lines.slice(10, 80), ...body(20, "t").split("\n").filter(Boolean), ...lines.slice(80)];
  edit(repo, MID, task.join("\n"));
  round(repo, "reviewer", null, ["A3 is wrong — src/mid.ts:13 — x — []"]);
  const fixed = task.filter((l) => l !== "export const A3 = 3;");
  fixed.splice(50, 0, "export const Z = 0;");
  edit(repo, MID, fixed.join("\n"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID], "the deleted A3 was hidden by an unrelated insertion");
});

// reviewer-2's repros X6 and X7 (round 2), kept as tests
test("C16 edge: deleting one twin line while inserting a copy of it elsewhere does not narrow the round", () => {
  const repo = opened("fc-c16");
  const trio = "export const p = gate();\nif (!ok) {\n  throw new Error('no');\n";
  edit(repo, MID, "export const mid0 = 0;\n" + body(20, "mid", 1) + trio + body(20, "mid", 30) + trio);
  round(repo, "reviewer", null, [FINDING]);
  edit(repo, MID, "export const mid0 = 0;\n" + body(20, "mid", 1) + trio + "if (!ok) {\n  throw new Error('no');\n" + body(20, "mid", 30) + "export const p = gate();\nif (!ok) {\n");
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID], "the deleted twin at the end reached no reviewer");
});

test("C17 edge: in a round over two slices of one file, a deletion at one slice's end is not paid for by an insertion in the gap", () => {
  const base = body(60, "mid");
  const repo = makeRepo("fc-c17", { ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"] }, null, 2), [MID]: base });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["fc-c17", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "One module. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One module.", "--files", MID]);
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  const lines = base.split("\n");
  edit(repo, MID, [...lines.slice(0, 4), "export const top = 1;", ...lines.slice(4, 20), "if (!isAdmin(user)) throw new Forbidden();", ...lines.slice(20, 40), "export const added = 1;", ...lines.slice(40)].join("\n"));
  // past tiny, so a review is required
  edit(repo, "src/other.ts", body(80, "other"));
  round(repo, "reviewer", "src/other.ts", []);
  round(repo, "reviewer", "src/mid.ts:5-5", []);
  round(repo, "reviewer", "src/mid.ts:22-22,src/mid.ts:43-43", ["x — src/mid.ts:42 — x — []"]);
  edit(repo, MID, [...lines.slice(0, 4), "export const top = 1;", ...lines.slice(4, 29), "export const gap = 1;", ...lines.slice(29, 40), "export const added = 1;", ...lines.slice(40)].join("\n"));
  cli(repo, "huddle", ["resolve", "H3.1", "--evidence", "doc"]);
  const asked = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(asked.includes(MID) || asked.some((e) => /:43-43$|:\d+-4[3-9]$/.test(e)), `the round was narrowed past the deleted guard: ${asked.join(", ")}`);
});

// reviewer-2's X8 (round 3): twins that lead the round's recorded order
test("C18 edge: moving a guard added after several blank lines (twins before any other recorded line) does not narrow the round", () => {
  const lines = Array.from({ length: 60 }, (_, i) => (i % 10 === 9 ? "" : `export const mid${i} = ${i};`));
  const repo = makeRepo("fc-c18", { ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"] }, null, 2), [MID]: lines.join("\n") + "\n" });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["fc-c18", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "One module. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One module.", "--files", MID]);
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  const guard = ["if (!isAdmin(user)) {", "  throw new Forbidden();", "}"];
  const at = (spots) => {
    const out = [];
    lines.forEach((l, i) => { out.push(l); if (spots.includes(i + 1)) out.push(...guard); if (i + 1 === 45) out.push("export const added = 1;"); });
    return out.join("\n") + "\n";
  };
  edit(repo, MID, at([10, 20]));
  edit(repo, "src/other.ts", body(80, "other"));
  round(repo, "reviewer", null, ["x — src/mid.ts:50 — x — []"]);
  edit(repo, MID, at([20, 30]));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.ok(entriesOf(ruleLine(check(repo), "R5")).length > 0, "the moved guard reached no reviewer");
});

// 6.1: a fix-check runs only named test files; `gate verify` owns the full run
const sectionIn = (packet, name) => {
  const at = packet.indexOf(`\n## ${name}\n`);
  if (at < 0) return "";
  const rest = packet.slice(at + name.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
};
const WHOLE_RUN = /run the test command yourself/i;
const OWNS = /`gate verify` owns the full run/;

test("6.1 C5 refused: a fix-check packet with stale verify never tells the reviewer to run the whole test command", () => {
  const repo = opened("fc-61-c5");
  // at the default cap of one, the round after a fixed round is the fix-check
  for (let i = 1; i <= 1; i++) {
    round(repo, "reviewer", null, [FINDING]);
    fixLine30(repo, 1000 + i);
    cli(repo, "huddle", ["resolve", `H${i}.1`, "--evidence", "doc"]);
  }
  const packet = packetOf(cli(repo, "brief", ["reviewer"]));
  assert.match(packet, /## Findings to re-check/, "anchor: round 4 is the fix-check");
  const verify = sectionIn(packet, "Verify");
  assert.match(verify, /not fresh/, `anchor: verify is stale:\n${verify}`);
  assert.doesNotMatch(verify, WHOLE_RUN, verify);
  assert.match(verify, OWNS, verify);
  const command = sectionIn(packet, "Test command");
  assert.match(command, OWNS, command);
  assert.match(command, /only (?:the )?named test files/i, command);
  assert.match(command, /^\s*This is a fix-check/, "the Test command section opens with the words the role files key on");
  for (const role of ["reviewer", "reviewer-2"]) {
    const doc = readFileSync(path.join(import.meta.dirname, "..", "agents", `${role}.md`), "utf8");
    assert.match(doc, /Test command section opens with "This is a fix-check"/, role);
    assert.doesNotMatch(doc, /fix-check round \(the packet has `## Findings to re-check`\)/, `${role}: keyed on a header ordinary rounds print too`);
  }
});

test("6.1 C6 idempotent: a first round with stale verify still tells the reviewer to run the test command itself", () => {
  const repo = opened("fc-61-c6");
  const packet = packetOf(cli(repo, "brief", ["reviewer"]));
  assert.doesNotMatch(packet, /## Findings to re-check/, "anchor: a first round");
  assert.match(sectionIn(packet, "Verify"), WHOLE_RUN);
  assert.doesNotMatch(packet, OWNS, "a first round's packet speaks of a fix-check");
});

// 6.4: after a clean round or a re-check, a line no round saw needs a call: a round, or the
// lead's one-line reason that behaviour did not change, which the report lists
const lateEdit = (repo, from, to, v = 7) => {
  let text = body(60, "mid");
  for (let i = from; i <= to; i++) text = text.replace(`mid${i - 1} = ${i - 1};`, `mid${i - 1} = ${i - 1 + v * 1000};`);
  edit(repo, MID, text);
};
const reportOf = (repo) => cli(repo, "report");
const oldPin = (repo) => {
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  delete ledger.policy.lateLines;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
};

test("6.4 L1 happy: a 3-line change after a clean round is held until a round reviews it, and R5's printed command runs past the cap", () => {
  const repo = opened("fc-64-l1");
  round(repo, "reviewer", null);
  assert.ok(!blocks(check(repo), "R5"), "anchor: the clean round covers the file");
  lateEdit(repo, 10, 12);
  const r5 = ruleLine(check(repo), "R5");
  // the line after the edit kept its text, so it is not owed though its key holds the line before it
  assert.match(r5, /src\/mid\.ts:10-12\b/, r5);
  const printed = /`gate brief reviewer --files ([^`]+)`/.exec(r5)?.[1];
  assert.equal(printed, "src/mid.ts:10-12", r5);
  round(repo, "reviewer", printed);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("6.4 L1g edge: two edits apart owe each edited line, and neither unchanged line after them", () => {
  const repo = opened("fc-64-l1g");
  round(repo, "reviewer", null);
  edit(repo, MID, body(60, "mid").replace("mid9 = 9;", "mid9 = 9000;").replace("mid19 = 19;", "mid19 = 19000;"));
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), ["src/mid.ts:10-10", "src/mid.ts:20-20"]);
});

test("6.4 L1h boundary: a line inserted after a clean round leaves the unchanged line after it owed", () => {
  const repo = opened("fc-64-l1h");
  round(repo, "reviewer", null);
  edit(repo, MID, body(60, "mid").replace("export const mid10 = 10;", "export const added = 1;\nexport const mid10 = 10;"));
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  for (const pos of [11, 12]) assert.ok(owes(entries, pos), `line ${pos} not owed: ${entries.join(", ")}`);
});

test("6.4 L1b edge: a reviewed line moved after a clean round is owed where it went, and so are the lines its move pulled apart", () => {
  const repo = opened("fc-64-l1b");
  round(repo, "reviewer", null);
  // mid9 (line 10) moves below mid39: line 10 and the lines either side of its new place are owed
  const lines = body(60, "mid").split("\n");
  const [moved] = lines.splice(9, 1);
  lines.splice(39, 0, moved);
  edit(repo, MID, lines.join("\n"));
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  for (const pos of [10, 40, 41]) assert.ok(owes(entries, pos), `line ${pos} not owed: ${entries.join(", ")}`);
});

test("6.4 L1c boundary: a round recorded before own keys were kept still owes the line after an edit", () => {
  const repo = opened("fc-64-l1c");
  round(repo, "reviewer", null);
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const h of ledger.huddles) delete h.owns;
  for (const v of Object.values(ledger.seen ?? {})) delete v.owns;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  resealRun(repo);
  lateEdit(repo, 10, 12);
  assert.match(ruleLine(check(repo), "R5"), /src\/mid\.ts:10-13/);
});

test("6.4 L1d edge: a reviewed line deleted after a clean round leaves the line after it owed", () => {
  const repo = opened("fc-64-l1d");
  round(repo, "reviewer", null);
  edit(repo, MID, body(60, "mid").replace("export const mid20 = 20;\n", ""));
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(owes(entries, 21), `line 21 not owed: ${entries.join(", ")}`);
});

test("6.4 L1e edge: a reviewed line moved up to sit after a new line stays owed, since its old neighbour is still in the file", () => {
  const repo = opened("fc-64-l1e");
  round(repo, "reviewer", null);
  // lines 11-14 hold mid10..mid13: mid10 is rewritten and mid12 moves above mid11
  const lines = body(60, "mid").split("\n");
  lines.splice(10, 3, "export const fresh = 1;", lines[12], lines[11]);
  edit(repo, MID, lines.join("\n"));
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  for (const pos of [11, 12, 13]) assert.ok(owes(entries, pos), `line ${pos} not owed: ${entries.join(", ")}`);
});

test("6.4 L1f boundary: a round whose finding was fixed and closed narrows to the fixed line alone", () => {
  const repo = opened("fc-64-l1f");
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), ["src/mid.ts:31-31"]);
});

test("6.4 L2 edge: a 3-line change after a finished re-check is held the same way", () => {
  const repo = opened("fc-64-l2");
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  round(repo, "reviewer", null);
  assert.ok(!blocks(check(repo), "R5"), "anchor: the re-check clears R5");
  let text = body(60, "mid").replace("mid30 = 30", "mid30 = 999");
  for (const i of [40, 41, 42]) text = text.replace(`mid${i} = ${i};`, `mid${i} = ${i + 5000};`);
  edit(repo, MID, text);
  assert.match(ruleLine(check(repo), "R5"), /src\/mid\.ts:41-43\b/);
});

test("6.4 L3 happy: gate huddle unchanged with a reason clears the hold, and the report lists the reason", () => {
  const repo = opened("fc-64-l3");
  round(repo, "reviewer", null);
  lateEdit(repo, 10, 12);
  const out = cli(repo, "huddle", ["unchanged", "src/mid.ts:10-12", "renamed constants only, no caller reads them"]);
  assert.match(out, /3 lines/);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  assert.match(reportOf(repo), /unchanged after review: src\/mid\.ts:10-12 — renamed constants only, no caller reads them/);
  lateEdit(repo, 10, 12, 8);
  assert.match(ruleLine(check(repo), "R5"), /src\/mid\.ts:10-1[23]/, "a later edit to excused lines is a new change");
});

test("6.4 L5 boundary: 500 late lines are owed in pieces under the cap, and each printed piece is briefed", () => {
  const repo = opened("fc-64-l5");
  round(repo, "reviewer", null);
  edit(repo, MID, body(60, "mid") + body(500, "late", 1000));
  const first = /`gate brief reviewer --files ([^`]+)`/.exec(ruleLine(check(repo), "R5"))?.[1];
  assert.match(first ?? "", /^src\/mid\.ts:61-\d+$/, ruleLine(check(repo), "R5"));
  assert.ok(Number(first.split("-")[1]) - 61 + 1 <= 400, first);
  round(repo, "reviewer", first);
  const second = /`gate brief reviewer --files ([^`]+)`/.exec(ruleLine(check(repo), "R5"))?.[1];
  assert.match(second ?? "", /^src\/mid\.ts:\d+-560$/, `the rest is still owed after the first part:\n${check(repo)}`);
  round(repo, "reviewer", second);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("6.4 L6 edge: a formatter re-indent after a clean round needs no call", () => {
  const repo = opened("fc-64-l6");
  round(repo, "reviewer", null);
  edit(repo, MID, body(60, "mid").split("\n").map((l) => (l ? `  ${l}` : l)).join("\n"));
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("6.4 L7 boundary: a file's second return ends it: new late lines after a finished late round are listed, not held", () => {
  const repo = opened("fc-64-l7");
  round(repo, "reviewer", null);
  lateEdit(repo, 10, 12);
  round(repo, "reviewer", "src/mid.ts:10-13");
  lateEdit(repo, 10, 12, 9);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  assert.match(reportOf(repo), /changed after its last review, not reviewed: src\/mid\.ts:10-1[23]/);
});

test("6.4 L8 refused: gate huddle unchanged with no reason, for a file no round saw, for lines that owe nothing, and on an old pin", () => {
  const repo = opened("fc-64-l8");
  edit(repo, "src/other.ts", "export const o = 1;\n");
  round(repo, "reviewer", MID);
  lateEdit(repo, 10, 12);
  const refusedWith = (args) => run(repo, "huddle", ["unchanged", ...args]).stderr;
  assert.match(refusedWith(["src/mid.ts:10-12"]), REFUSAL, "no reason");
  assert.match(refusedWith(["src/other.ts", "a new file"]), /no round saw/, "a file no round saw needs a round");
  assert.match(refusedWith(["src/mid.ts:50-55", "nothing changed there"]), /owe/, "lines that owe nothing");
  assert.equal(ledgerOf(repo).unchanged ?? undefined, undefined, "nothing recorded");
  const old = opened("fc-64-l8-old");
  oldPin(old);
  round(old, "reviewer", null);
  lateEdit(old, 10, 12);
  assert.match(run(old, "huddle", ["unchanged", "src/mid.ts:10-12", "renamed"]).stderr, /pinned/, "an old pin has no calls");
});

test("6.4 L9 idempotent: a run pinned before keeps today's rule: a clean round covers later edits", () => {
  const repo = opened("fc-64-l9");
  oldPin(repo);
  round(repo, "reviewer", null);
  lateEdit(repo, 10, 12);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("6.4 L10 edge: a reviewed line deleted after a clean round is held until a round sees the file again, or a call excuses it", () => {
  const repo = opened("fc-64-l10");
  round(repo, "reviewer", null);
  edit(repo, MID, body(60, "mid").replace("export const mid59 = 59;\n", ""));
  assert.match(ruleLine(check(repo), "R5"), /src\/mid\.ts/, "a deleted reviewed line owes a call");
  cli(repo, "huddle", ["unchanged", MID, "the last constant had no reader"]);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  edit(repo, MID, body(60, "mid").replace("export const mid59 = 59;\n", "").replace("export const mid58 = 58;\n", ""));
  assert.match(ruleLine(check(repo), "R5"), /src\/mid\.ts/, "a second deletion after the call owes a call of its own");
});

test("6.4 L11 boundary: a late round in parts ends the file only with the part that takes the rest", () => {
  const repo = opened("fc-64-l11");
  round(repo, "reviewer", null);
  edit(repo, MID, body(60, "mid") + body(500, "late", 1000));
  const first = /`gate brief reviewer --files ([^`]+)`/.exec(ruleLine(check(repo), "R5"))[1];
  round(repo, "reviewer", first, [`off by one — ${MID}:70 — x — []`]);
  const id = ledgerOf(repo).huddles.at(-1).actOn[0].id;
  edit(repo, MID, (body(60, "mid") + body(500, "late", 1000)).replace("late1009 = 1009", "late1009 = 77"));
  cli(repo, "huddle", ["resolve", id, "--evidence", "doc"]);
  const r5 = ruleLine(check(repo), "R5");
  assert.match(r5, /src\/mid\.ts:70-70\b/, `the part's fixed line is still owed:\n${r5}`);
  const rest = /`gate brief reviewer --files ([^`]+)`/.exec(r5)[1];
  round(repo, "reviewer", rest);
  assert.ok(!blocks(check(repo), "R5"), `the part that takes the rest ends the file:\n${check(repo)}`);
});

// 6.5: comment and blank lines need no round: deleting one is no deletion, and adding one is
// no change a review must see
const commented = (lines = body(60, "mid")) => lines.split("\n").map((l, i) => (i === 20 ? `// helpers\n${l}` : l)).join("\n");
const unpin = (repo) => {
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const r of [...ledger.huddles, ...Object.values(ledger.seen ?? {})]) { delete r.notes; delete r.flats; }
  writeFileSync(file, JSON.stringify(ledger, null, 2));
};

test("6.5 K1 happy: a fix that deletes a comment clears R5 with no re-check", () => {
  const repo = opened("fc-65-k1");
  edit(repo, MID, commented());
  round(repo, "reviewer", null, ["slop comment — src/mid.ts:21 — labels a block — []"]);
  edit(repo, MID, body(60, "mid"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("6.5 K2 edge: a fix that adds a comment and edits code names only the code lines", () => {
  const repo = opened("fc-65-k2");
  edit(repo, MID, commented());
  round(repo, "reviewer", null, [FINDING]);
  const fixed = commented(body(60, "mid").replace("mid44 = 44", "mid44 = 4400")).split("\n");
  fixed.splice(40, 0, "// why the total skips the header row");
  edit(repo, MID, fixed.join("\n"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.deepEqual(entries, ["src/mid.ts:47-47"], entries.join(", ")); // the edited line; not the comment at 41, the line below it or the unchanged line after the edit
});

test("6.5 K3 happy: a comment-only change after a clean round owes no call", () => {
  const repo = opened("fc-65-k3");
  round(repo, "reviewer", null);
  const lines = body(60, "mid").split("\n");
  lines.splice(9, 0, "// the first block holds the defaults", "");
  edit(repo, MID, lines.join("\n"));
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("6.5 K4 refused: an unread slice still needs a round even when it holds comments", () => {
  const repo = opened("fc-65-k4");
  edit(repo, MID, commented());
  round(repo, "reviewer", "src/mid.ts:1-30");
  assert.match(ruleLine(check(repo), "R5"), /src\/mid\.ts:31-61/);
});

test("6.5 K5 idempotent: an old round with no comment keys keeps the old rule: a deleted comment reopens the file", () => {
  const repo = opened("fc-65-k5");
  edit(repo, MID, commented());
  round(repo, "reviewer", null, ["slop comment — src/mid.ts:21 — labels a block — []"]);
  unpin(repo);
  edit(repo, MID, body(60, "mid"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID]);
});

test("6.5 K6 boundary: noteLine reads comments by file type", async () => {
  const { noteLine } = await import("../scripts/lib/tree.mjs");
  const yes = [["a.ts", "  // x"], ["a.tsx", "/* x */"], ["a.py", "# x"], ["a.yaml", "  # x"], ["a.sql", "-- x"], ["a.css", "/* x */"], ["a.html", "<!-- x -->"], ["a.ts", ""], ["a.go", "   "], ["a.unknown", ""], ["a.go", "// x"]];
  const no = [["a.ts", "const a = 1; // x"], ["a.css", "#main { color: red; }"], ["a.py", "x = '#'"], ["a.ts", "'// not a comment'"], ["a.sql", "select 1"], ["a.unknown", "# x"], ["a.py", "// x"],
    // a marker that opens or closes a block can hide or reveal code; * starts code in C-like files
    ["a.ts", " * x"], ["a.ts", "/*"], ["a.ts", "*/"], ["a.ts", "*[Symbol.iterator]() {"], ["a.html", "<!--"], ["a.css", "/* open"],
    // directives change what builds or runs
    ["a.go", "//go:build linux"], ["a.go", "// +build linux"], ["a.go", "//nolint:errcheck"], ["a.rs", "/// assert_eq!(f(), 1);"], ["a.rs", "//! crate docs"],
    ["a.ts", "// @ts-ignore"], ["a.ts", "/// <reference types=\"node\" />"], ["a.js", "// eslint-disable-next-line no-console"], ["a.ts", "/* webpackChunkName: \"x\" */"],
    ["a.py", "#!/usr/bin/env python"], ["a.py", "# type: ignore"], ["a.py", "# noqa"], ["a.py", "# -*- coding: utf-8 -*-"], ["a.rb", "# frozen_string_literal: true"],
    ["a.sql", "-- +goose Up"], ["a.lua", "--[[ opens a block"], ["a.lua", "--[==[ x"], ["a.sql", "-- migrate:up"], ["a.html", "<!--[if IE]> x <![endif]-->"]];
  for (const [rel, text] of yes) assert.equal(noteLine(rel, text), true, `${rel}: ${JSON.stringify(text)}`);
  for (const [rel, text] of no) assert.equal(noteLine(rel, text), false, `${rel}: ${JSON.stringify(text)}`);
});

test("6.5 K7 edge: a .py fix that deletes a comment and re-indents a code line names the re-indented line", () => {
  const repo = makeRepo("fc-65-k7", { ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"] }, null, 2), "src/m.py": "x = 0\n" });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["fc-65-k7", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "One module. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/m.py:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One module.", "--files", "src/m.py"]);
  cli(repo, "case", ["add", "runs", "--kind", "happy"]);
  const py = (lines) => lines.join("\n") + "\n";
  const code = Array.from({ length: 20 }, (_, i) => `    y${i} = ${i}`);
  edit(repo, "src/m.py", py(["x = 0", "def f():", "    # the loop below", ...code]));
  round(repo, "reviewer", null, ["slop comment — src/m.py:3 — narrates — []"]);
  const fixed = [...code];
  fixed[5] = `        y5 = 5`;
  edit(repo, "src/m.py", py(["x = 0", "def f():", ...fixed]));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.match(ruleLine(check(repo), "R5"), /src\/m\.py:8-/, `the re-indented line is owed:\n${check(repo)}`);
});

// A narrowed round (the fix-check, or the round on lines changed after review) is shown only the
// lines its reviewer is still owed, and each closed finding is listed for re-check once per role.
const NARROWED = "Diff of the lines changed since your last round";
const recheckOf = (packet) => /## Findings to re-check\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1] ?? "";
const added = (packet, name, i, v = i) => packet.includes(`+export const ${name}${i} = ${v};`);
const blocksOf = (packet) => (packet.match(/^@@ lines \d+-\d+ of the new file @@$/gm) ?? []).length;
const briefed = (repo, files, role = "reviewer") => packetOf(cli(repo, "brief", files ? [role, "--files", files] : [role]));
const OTHER = "src/other.ts";
const fixOther40 = (repo) => edit(repo, OTHER, body(80, "other").replace("other39 = 39", "other39 = 3900"));
function fixedFinding(name) {
  const repo = opened(name);
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  return repo;
}

test("narrow C1 C12: a fix-check named with the whole file after a one-line fix shows that line and three lines of context; a first round shows the whole piece and no re-check words", () => {
  const repo = opened("fc-narrow-c1");
  const first = packetOf(round(repo, "reviewer", null, [FINDING]));
  assert.ok(added(first, "mid", 10) && added(first, "mid", 50), "a first round shows the whole piece");
  assert.doesNotMatch(first, /re-check, not a new review/);
  assert.ok(!first.includes(NARROWED));
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const packet = briefed(repo, MID);
  assert.ok(packet.includes(`## ${NARROWED}`), packet);
  assert.ok(added(packet, "mid", 30, 999), "the fixed line");
  assert.ok(added(packet, "mid", 27) && added(packet, "mid", 33), "three lines of context each side");
  assert.ok(!added(packet, "mid", 26) && !added(packet, "mid", 34) && !added(packet, "mid", 10), "nothing beyond the context");
});

test("narrow C2: with two files each holding a fixed finding, each fix-check lists its own file's finding only", () => {
  const repo = opened("fc-narrow-c2");
  edit(repo, OTHER, body(80, "other"));
  round(repo, "reviewer", MID, [FINDING]);
  round(repo, "reviewer", OTHER, ["wrong default — src/other.ts:40 — x — []"]);
  fixLine30(repo);
  fixOther40(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "doc"]);
  const mid = recheckOf(briefed(repo, MID));
  assert.match(mid, /H1\.1/);
  assert.doesNotMatch(mid, /H2\.1/, "the other file's finding waits for its own re-check");
  const other = recheckOf(briefed(repo, OTHER));
  assert.match(other, /H2\.1/);
  assert.doesNotMatch(other, /H1\.1/);
  assert.deepEqual(ledgerOf(repo).seen["review-3.md"].rechecked.map((k) => k.split("@")[0]), ["H1.1"]);
});

test("narrow C3: a finding citing a file outside the change is listed by the first re-check briefed and not by the round after it", () => {
  const repo = opened("fc-narrow-c3");
  round(repo, "reviewer", null, ["caller passes null — src/zzz.ts:1 — x — []"]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.match(recheckOf(packetOf(round(repo, "reviewer", MID))), /H1\.1/);
  edit(repo, MID, body(60, "mid").replace("mid30 = 30", "mid30 = 999").replace("mid50 = 50", "mid50 = 5000"));
  const late = briefed(repo, MID);
  assert.ok(added(late, "mid", 50, 5000), "anchor: the late round was briefed");
  assert.doesNotMatch(recheckOf(late), /H1\.1/, "re-checked once already");
});

test("narrow C4: a finding closed, reopened and closed again is listed again", () => {
  const repo = fixedFinding("fc-narrow-c4");
  assert.match(recheckOf(packetOf(round(repo, "reviewer", MID))), /H1\.1/);
  cli(repo, "huddle", ["reopen", "H1.1", "the fix missed a case"]);
  fixLine30(repo, 777);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.match(recheckOf(briefed(repo, MID)), /H1\.1/, "a new close is a new thing to re-check");
});

test("narrow C5: a fix that deletes a reviewed line leaves the whole file owed, and the fix-check keeps the whole diff with the finding listed", () => {
  const repo = opened("fc-narrow-c5");
  round(repo, "reviewer", null, [FINDING]);
  edit(repo, MID, body(60, "mid").replace("export const mid30 = 30;\n", ""));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID], "anchor: R5 owes the whole file");
  const packet = briefed(repo, MID);
  assert.ok(added(packet, "mid", 10) && added(packet, "mid", 50), "the whole file, as R5 asks");
  assert.match(recheckOf(packet), /H1\.1/);
  const both = briefed(repo, `${MID},${MID}:5-9`);
  assert.ok(added(both, "mid", 10) && added(both, "mid", 50), "a slice named beside the whole file does not narrow it");
});

test("narrow C6: a fix-check in parts shows each part its own owed lines, cut to the part, and the first part briefed lists the finding", () => {
  const repo = opened("fc-narrow-c6");
  const BIG = "src/big.ts";
  edit(repo, BIG, body(900, "big"));
  round(repo, "reviewer", MID);
  round(repo, "reviewer", `${BIG}:1-400`, ["off by one — src/big.ts:30 — x — []"]);
  round(repo, "reviewer", `${BIG}:401-800`);
  round(repo, "reviewer", `${BIG}:801-900`);
  // the fix rewrites lines 1-450: more than one round reads, so the re-check runs in parts
  edit(repo, BIG, body(900, "big").split("\n").map((l, i) => (i < 450 ? l.replace(/= (\d+);/, "= $1000;") : l)).join("\n"));
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "doc"]);
  const first = briefed(repo, `${BIG}:1-400`);
  assert.ok(added(first, "big", 399, 399000) && !added(first, "big", 400, 400000), "cut at the part's last line");
  assert.match(recheckOf(first), /H2\.1/);
  const second = briefed(repo, `${BIG}:401-800`);
  assert.ok(added(second, "big", 400, 400000) && added(second, "big", 449, 449000) && added(second, "big", 452) && !added(second, "big", 453), "the rest of the owed lines and three lines of context");
  assert.doesNotMatch(recheckOf(second), /H2\.1/, "listed once, by the first part");
  assert.doesNotMatch(second, /a finding listed above/, "no list, so no words about one");
  assert.match(second, /This is a re-check, not a new review\. Under Act on, report only something the lines shown below break\./);
});

test("narrow C7 C16: owed lines close together print as one block, far apart as two, each under its own header; one range prints one block per hunk as before", () => {
  const near = opened("fc-narrow-c7-near");
  round(near, "reviewer", null, [FINDING]);
  edit(near, MID, body(60, "mid").replace("mid30 = 30", "mid30 = 999").replace("mid36 = 36", "mid36 = 999"));
  cli(near, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.equal(blocksOf(briefed(near, MID)), 1);
  const far = opened("fc-narrow-c7-far");
  round(far, "reviewer", null, [FINDING]);
  edit(far, MID, body(60, "mid").replace("mid10 = 10", "mid10 = 999").replace("mid50 = 50", "mid50 = 999"));
  cli(far, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const packet = briefed(far, MID);
  assert.equal(blocksOf(packet), 2);
  assert.match(packet, /^@@ lines 8-14 of the new file @@$/m);
  assert.match(packet, /^@@ lines 48-54 of the new file @@$/m);
  const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -0,0 +1,60 @@", ...Array.from({ length: 60 }, (_, i) => `+line ${i + 1}`)].join("\n");
  assert.equal((sliceDiff(diff, [[5, 9]]).match(/^@@ lines/gm) ?? []).length, 1);
  assert.equal((sliceDiff(diff, [[5, 6], [7, 9]]).match(/^@@ lines/gm) ?? []).length, 1, "neighbouring ranges are one block");
  const two = sliceDiff(diff, [[5, 6], [45, 46]]);
  assert.deepEqual(two.match(/^@@ lines .*$/gm), ["@@ lines 5-6 of the new file @@", "@@ lines 45-46 of the new file @@"]);
  assert.ok(two.includes("+line 6\n@@ lines 45-46"), "each block follows its own header");
});

test("narrow C8: a late round named with the whole file shows only the line changed after the clean round and says to review the shown lines", () => {
  const repo = opened("fc-narrow-c8");
  round(repo, "reviewer", null);
  edit(repo, MID, body(60, "mid").replace("mid50 = 50", "mid50 = 5000"));
  const packet = briefed(repo, MID);
  assert.ok(added(packet, "mid", 50, 5000) && !added(packet, "mid", 10));
  assert.match(packet, /These lines changed after your review\. Review the lines shown, nothing else\./);
});

test("narrow C9: a round recorded without line keys leaves the whole file owed: the fix-check shows the whole diff", () => {
  const repo = opened("fc-narrow-c9");
  noLateCalls(repo);
  round(repo, "reviewer", null, [FINDING]);
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const h of ledger.huddles) delete h.units;
  for (const s of Object.values(ledger.seen ?? {})) delete s.units;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  resealRun(repo);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const packet = briefed(repo, MID);
  assert.ok(added(packet, "mid", 10) && added(packet, "mid", 50));
});

test("narrow C10 C13: a re-check briefed again lists the same findings and lines; one whose helper stopped on a draft listed nothing, so the packet after it lists them", () => {
  const repo = fixedFinding("fc-narrow-c10");
  const once = cli(repo, "brief", ["reviewer", "--files", MID]);
  const again = cli(repo, "brief", ["reviewer", "--files", MID]);
  assert.equal(/packet: (\S+)/.exec(once)[1], /packet: (\S+)/.exec(again)[1], "the same packet file");
  assert.match(recheckOf(packetOf(again)), /H1\.1/);
  assert.ok(added(packetOf(again), "mid", 30, 999) && !added(packetOf(again), "mid", 10));
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "A-reviewer", agent_type: "done-gate:reviewer" });
  writeFileSync(path.join(runDir(repo), "review-2.md"), "# Review 2 — x\n\n## Act on\n- unverified\n## Can't verify\n- unverified\n## Lessons\n- unverified\n## Dismissed\n- unverified\n");
  stop(repo, "reviewer");
  const next = cli(repo, "brief", ["reviewer", "--files", `${MID}:31-31`]);
  assert.match(next, /^packet: .*brief-reviewer-3\.md$/m, "anchor: another packet");
  assert.match(recheckOf(packetOf(next)), /H1\.1/);
});

test("narrow C11: the narrowed packet says it is a re-check and what Act on takes, and both reviewer instruction files point at the packet", () => {
  const packet = briefed(fixedFinding("fc-narrow-c11"), MID);
  assert.match(packet, /This is a re-check, not a new review\. Under Act on, report only a finding listed above that is NOT ADDRESSED, or something the lines shown below break\. Your earlier round covered the rest of the file\./);
  for (const role of ["reviewer", "reviewer-2"]) {
    assert.match(readFileSync(path.join(pluginRoot, "agents", `${role}.md`), "utf8"), /On a re-check or a round on lines changed after review, the packet narrows this to the lines it shows: follow the packet\./, role);
  }
});

test("narrow C14: a finding raised in one file's round about another file, fixed there after that file's clean round, is listed by its late round", () => {
  const repo = opened("fc-narrow-c14");
  edit(repo, OTHER, body(80, "other"));
  round(repo, "reviewer", MID, ["caller wrong — src/other.ts:40 — x — []"]);
  round(repo, "reviewer", OTHER);
  fixOther40(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const packet = briefed(repo, OTHER);
  assert.ok(added(packet, "other", 39, 3900) && !added(packet, "other", 10));
  assert.match(recheckOf(packet), /H1\.1/);
  assert.doesNotMatch(packet, /nothing else/, "the late words must not tell the reviewer to skip the list");
  assert.match(packet, /These lines changed after your review\. Under Act on, report only a finding listed above that is NOT ADDRESSED, or a fault in the lines shown below\./);
});

test("narrow C15: a piece file with no owed line in a re-check is left out of the diff and named", () => {
  const repo = opened("fc-narrow-c15");
  edit(repo, OTHER, body(80, "other"));
  round(repo, "reviewer", `${MID},${OTHER}`, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const packet = briefed(repo, `${MID},${OTHER}`);
  assert.ok(added(packet, "mid", 30, 999) && !added(packet, "other", 10));
  assert.match(packet, /- src\/other\.ts: nothing changed since your last round/);
});
