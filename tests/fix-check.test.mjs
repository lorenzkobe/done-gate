import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, lookedUp, pinnedBefore } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { sliceEnd } from "../scripts/lib/tree.mjs";

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

test("C1 happy: a whole-file round's fixed finding re-opens only the edited lines; a round on them clears R5", () => {
  const repo = opened("fc-c1");
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:30"]);
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.length > 0, check(repo));
  assert.ok(entries.every((e) => /^src\/mid\.ts:3[12]-3[12]$/.test(e)), `R5 asks for more than the fixed lines: ${entries.join(", ")}`);
  round(repo, "reviewer", entries[0].slice(MID.length + 1) ? entries[0] : MID);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C3 refused: an open finding keeps the whole file uncovered; closed items with no edit after the round cover it, as today", () => {
  const repo = opened("fc-c3");
  pinnedBefore(repo);
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID], "an open finding: the whole file");

  const quiet = opened("fc-c3-quiet");
  pinnedBefore(quiet);
  round(quiet, "reviewer", null, [FINDING]);
  cli(quiet, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:30"]);
  assert.ok(!blocks(check(quiet), "R5"), check(quiet));
});

test("C4 edge: a fix that only deletes lines re-opens the whole file", () => {
  const repo = opened("fc-c4");
  round(repo, "reviewer", null, ["dead line — src/mid.ts:60 — x — []"]);
  edit(repo, MID, body(59, "mid"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:59"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID]);
  round(repo, "reviewer", null);
  assert.ok(!blocks(check(repo), "R5"), `a clean round after the deleting fix must clear R5:\n${check(repo)}`);
});

test("C5 idempotent: a clean round still covers the file after an edit; a ledger with no recorded line keys keeps the whole-file rule", () => {
  const repo = opened("fc-c5");
  pinnedBefore(repo); // the rule a run pinned before keeps; 6.4 L1 below is the new one
  round(repo, "reviewer", null);
  fixLine30(repo);
  assert.ok(!blocks(check(repo), "R5"), check(repo));

  const legacy = opened("fc-c5-legacy");
  pinnedBefore(legacy);
  round(legacy, "reviewer", null, [FINDING]);
  const file = path.join(runDir(legacy), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const h of ledger.huddles) delete h.units;
  for (const s of Object.values(ledger.seen ?? {})) delete s.units;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  fixLine30(legacy);
  cli(legacy, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:30"]);
  assert.deepEqual(entriesOf(ruleLine(check(legacy), "R5")), [MID]);
});

test("C6 reported-surface: the fix-check packet lists the findings to re-check with how each closed; a first round's packet has none", () => {
  const repo = opened("fc-c6");
  const first = packetOf(round(repo, "reviewer", null, [FINDING]));
  assert.doesNotMatch(first, /## Findings to re-check/);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:30"]);
  const entry = entriesOf(ruleLine(check(repo), "R5"))[0];
  const packet = packetOf(cli(repo, "brief", ["reviewer", "--files", entry]));
  const section = /## Findings to re-check\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1] ?? "";
  assert.match(section, /H1\.1/, packet);
  assert.match(section, /off by one/);
  assert.match(section, /src\/mid\.ts:30/, "how it was closed");
  assert.match(section, /ADDRESSED or NOT ADDRESSED/);
});

test("C7 boundary: three whole-file rounds, each with a fixed finding, leave only the fixed lines for one fix-check round, which ends the review", () => {
  const repo = opened("fc-c7");
  pinnedBefore(repo);
  for (let i = 1; i <= 3; i++) {
    round(repo, "reviewer", null, [FINDING]);
    fixLine30(repo, 1000 + i);
    cli(repo, "huddle", ["resolve", `H${i}.1`, "--evidence", "src/mid.ts:30"]);
  }
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.length > 0 && entries.every((e) => /^src\/mid\.ts:\d+-\d+$/.test(e)), entries.join(", "));
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo, 2000);
  cli(repo, "huddle", ["resolve", "H4.1", "--evidence", "src/mid.ts:30"]);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C8 edge: a clean round then a round with a fixed finding: only the fixed lines re-open", () => {
  const repo = opened("fc-c8");
  pinnedBefore(repo);
  round(repo, "reviewer", null);
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "src/mid.ts:30"]);
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.length > 0, "the earlier clean round covered lines a later fix changed");
  assert.ok(entries.every((e) => /^src\/mid\.ts:3[12]-3[12]$/.test(e)), entries.join(", "));
});

test("C9 edge: a fix that deletes one line and edits another re-opens the whole file", () => {
  const repo = opened("fc-c9");
  round(repo, "reviewer", null, [FINDING]);
  edit(repo, MID, body(60, "mid").replace("mid30 = 30", "mid30 = 999").replace("export const mid10 = 10;\n", ""));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:29"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID]);
});

test("C10 edge: deleting one line and inserting another elsewhere re-opens the whole file", () => {
  const repo = opened("fc-c10");
  round(repo, "reviewer", null, [FINDING]);
  edit(repo, MID, body(59, "mid").replace("export const mid30 = 30;\n", "export const extra = 1;\nexport const mid30 = 30;\n"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:31"]);
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
    cli(repo, "huddle", ["resolve", `H${n}.1`, "--evidence", `src/mid.ts:${at}`]);
  }
  const entries = entriesOf(ruleLine(check(repo), "R5"));
  assert.ok(entries.some((e) => /:9[01]-100$/.test(e)), `lines 91-100 were never reviewed: ${entries.join(", ")}`);
});

test("C12 reported-surface: a finding whose fix landed in the piece's file is re-checked there", () => {
  const repo = opened("fc-c12");
  round(repo, "reviewer", null, ["caller passes null — src/other.ts:1 — x — []"]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:31"]);
  const packet = packetOf(cli(repo, "brief", ["reviewer", "--files", "src/mid.ts:31-32"]));
  assert.match(/## Findings to re-check\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1] ?? "", /H1\.1/, packet);
});

test("C13 happy: a fix-check slice round with a finding, fixed again, re-opens only the lines edited the second time", () => {
  const repo = opened("fc-c13");
  pinnedBefore(repo);
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo, 999);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:31"]);
  round(repo, "reviewer", "src/mid.ts:31-32", ["still off — src/mid.ts:31 — x — []"]);
  fixLine30(repo, 777);
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "src/mid.ts:31"]);
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
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:7"]);
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
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:13"]);
  assert.deepEqual(entriesOf(ruleLine(check(repo), "R5")), [MID], "the deleted A3 was hidden by an unrelated insertion");
});

// reviewer-2's repros X6 and X7 (round 2), kept as tests
test("C16 edge: deleting one twin line while inserting a copy of it elsewhere does not narrow the round", () => {
  const repo = opened("fc-c16");
  const trio = "export const p = gate();\nif (!ok) {\n  throw new Error('no');\n";
  edit(repo, MID, "export const mid0 = 0;\n" + body(20, "mid", 1) + trio + body(20, "mid", 30) + trio);
  round(repo, "reviewer", null, [FINDING]);
  edit(repo, MID, "export const mid0 = 0;\n" + body(20, "mid", 1) + trio + "if (!ok) {\n  throw new Error('no');\n" + body(20, "mid", 30) + "export const p = gate();\nif (!ok) {\n");
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:25"]);
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
  cli(repo, "huddle", ["resolve", "H3.1", "--evidence", "src/mid.ts:30"]);
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
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:50"]);
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
    cli(repo, "huddle", ["resolve", `H${i}.1`, "--evidence", "src/mid.ts:30"]);
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
  // the line after an edit is owed too: its key holds the line before it
  assert.match(r5, /src\/mid\.ts:10-13/, r5);
  const printed = /`gate brief reviewer --files ([^`]+)`/.exec(r5)?.[1];
  assert.equal(printed, "src/mid.ts:10-13", r5);
  round(repo, "reviewer", printed);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("6.4 L2 edge: a 3-line change after a finished re-check is held the same way", () => {
  const repo = opened("fc-64-l2");
  round(repo, "reviewer", null, [FINDING]);
  fixLine30(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/mid.ts:30"]);
  round(repo, "reviewer", null);
  assert.ok(!blocks(check(repo), "R5"), "anchor: the re-check clears R5");
  let text = body(60, "mid").replace("mid30 = 30", "mid30 = 999");
  for (const i of [40, 41, 42]) text = text.replace(`mid${i} = ${i};`, `mid${i} = ${i + 5000};`);
  edit(repo, MID, text);
  assert.match(ruleLine(check(repo), "R5"), /src\/mid\.ts:41-44/);
});

test("6.4 L3 happy: gate huddle unchanged with a reason clears the hold, and the report lists the reason", () => {
  const repo = opened("fc-64-l3");
  round(repo, "reviewer", null);
  lateEdit(repo, 10, 12);
  const out = cli(repo, "huddle", ["unchanged", "src/mid.ts:10-13", "renamed constants only, no caller reads them"]);
  assert.match(out, /4 lines/);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  assert.match(reportOf(repo), /unchanged after review: src\/mid\.ts:10-13 — renamed constants only, no caller reads them/);
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
  cli(repo, "huddle", ["resolve", id, "--evidence", `${MID}:70`]);
  const r5 = ruleLine(check(repo), "R5");
  assert.match(r5, /src\/mid\.ts:70-71/, `the part's fixed line is still owed:\n${r5}`);
  const rest = /`gate brief reviewer --files ([^`]+)`/.exec(r5)[1];
  round(repo, "reviewer", rest);
  assert.ok(!blocks(check(repo), "R5"), `the part that takes the rest ends the file:\n${check(repo)}`);
});
