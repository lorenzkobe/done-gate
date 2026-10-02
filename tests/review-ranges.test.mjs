import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
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

const BIG = "src/big.ts";

function opened(name, files = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"] }, null, 2), [BIG]: "export const big0 = 0;\n", ...files });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "One big module. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One big module.", "--files", BIG]);
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  return repo;
}
// src/big.ts becomes 1200 lines: every line is a change
function bigEdit(repo, n = 1200) {
  edit(repo, BIG, body(n, "big"));
  edit(repo, "tests/a.test.ts", "test('a', () => {});\ntest('big', () => {});\n");
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

test("C1 a 1200-line single-file diff: the whole file is refused and the first range named; a 400-line range briefs with only its span in the diff; a 900-line range is refused", () => {
  const repo = opened("rr-c1");
  bigEdit(repo);
  const whole = run(repo, "brief", ["reviewer", "--files", BIG]);
  assert.match(whole.stderr, new RegExp(`Slice it by line: .*${BIG}:\\d+-\\d+`));
  const r = run(repo, "brief", ["reviewer", "--files", `${BIG}:1-900`]);
  assert.match(r.stderr, /8\d\d changed lines/);
  const packet = packetOf(cli(repo, "brief", ["reviewer", "--files", `${BIG}:1-400`]));
  assert.match(packet, /## Piece\n\n.*src\/big\.ts:1-400/);
  assert.ok(packet.includes("+export const big399 = 399;"), "the last line of the span is in the diff");
  assert.ok(!packet.includes("+export const big400 = 400;"), "the line after the span is not");
  assert.match(packet, /read the code around/i);
  assert.deepEqual(ledgerOf(repo).seen["review-1.md"].files, [`${BIG}:1-400`]);
});

test("C2 three clean range rounds covering every changed line pass R5; with 801-1200 unseen, R5 names the span and prints its --files", () => {
  const repo = opened("rr-c2");
  bigEdit(repo);
  round(repo, "reviewer", `${BIG}:1-400`);
  round(repo, "reviewer", `${BIG}:401-800`);
  const out = check(repo);
  assert.ok(blocks(out, "R5"), out);
  assert.match(ruleLine(out, "R5"), /big\.ts:801-1200/);
  assert.match(ruleLine(out, "R5"), new RegExp(`--files ${BIG}:801-1200`));
  round(repo, "reviewer", `${BIG}:801-1200`);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C3 a range round with a finding, fixed by an edit inside the range, leaves only that span uncovered", () => {
  const repo = opened("rr-c3");
  bigEdit(repo);
  round(repo, "reviewer", `${BIG}:1-400`);
  round(repo, "reviewer", `${BIG}:401-800`, ["off by one — src/big.ts:500 — x — []"]);
  round(repo, "reviewer", `${BIG}:801-1200`);
  edit(repo, BIG, body(1200, "big").replace("big500 = 500", "big500 = 501"));
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "src/big.ts:500"]);
  const line = ruleLine(check(repo), "R5");
  assert.match(line, /big\.ts:401-800/);
  assert.doesNotMatch(line, /big\.ts:1-400/);
  assert.doesNotMatch(line, /big\.ts:801-1200/);
  round(repo, "reviewer", `${BIG}:401-800`);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C4 a new untracked 1000-line file: its changed lines are 1-1000, ranges slice it, coverage completes at 1000", () => {
  const repo = opened("rr-c4");
  edit(repo, "src/fresh.ts", body(1000, "f"));
  edit(repo, "tests/a.test.ts", "test('f', () => {});\n");
  cli(repo, "note", ["plan", "A fresh module.", "--files", "src/fresh.ts"]);
  assert.match(run(repo, "brief", ["reviewer", "--files", "src/fresh.ts"]).stderr, /src\/fresh\.ts:1-\d+/);
  round(repo, "reviewer", "src/fresh.ts:1-400");
  round(repo, "reviewer", "src/fresh.ts:401-800");
  assert.match(ruleLine(check(repo), "R5"), /fresh\.ts:801-1000/);
  round(repo, "reviewer", "src/fresh.ts:801-1000");
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C5 a malformed range is refused and changes nothing", () => {
  const repo = opened("rr-c5");
  bigEdit(repo);
  for (const bad of [`${BIG}:0-10`, `${BIG}:50-20`, `${BIG}:a-b`, `${BIG}:5`]) {
    assert.match(run(repo, "brief", ["reviewer", "--files", bad]).stderr, /range/, bad);
  }
  assert.equal(ledgerOf(repo).seen, undefined);
});

test("C6 the round cap counts the rounds that saw a line: whole-file and slice rounds together, per line", () => {
  const repo = opened("rr-c6", { "src/other.ts": "export const o = 0;\n" });
  bigEdit(repo, 300);
  edit(repo, "src/other.ts", body(30, "o"));
  cli(repo, "note", ["plan", "Two modules.", "--files", `${BIG},src/other.ts`]);
  round(repo, "reviewer", BIG, ["a — src/big.ts:1 — x — []"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/big.ts:1"]);
  round(repo, "reviewer", BIG, ["b — src/big.ts:200 — x — []"]);
  cli(repo, "huddle", ["resolve", "H2.1", "--evidence", "src/big.ts:200"]);
  round(repo, "reviewer", `${BIG}:1-150`, ["c — src/big.ts:5 — x — []"]);
  cli(repo, "huddle", ["resolve", "H3.1", "--evidence", "src/big.ts:5"]);
  assert.match(run(repo, "brief", ["reviewer", "--files", `${BIG}:1-150`]).stderr, /three rounds is the cap/, "lines 1-150 were seen three times");
  assert.match(cli(repo, "brief", ["reviewer", "--files", `${BIG}:151-300`]), /^packet: /m, "lines 151-300 were seen twice: one more round is allowed");
  stop(repo, "reviewer");
  assert.match(cli(repo, "brief", ["reviewer", "--files", "src/other.ts"]), /^packet: /m);
});

test("C7 a whole-file round still covers the file, and a file under the cap is briefed whole as before", () => {
  const repo = opened("rr-c7");
  bigEdit(repo, 200);
  const out = round(repo, "reviewer", null);
  assert.match(out, /^packet: /m);
  assert.deepEqual(ledgerOf(repo).seen["review-1.md"].files, [BIG]);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  edit(repo, BIG, body(201, "big"));
  assert.ok(!blocks(check(repo), "R5"), "a later edit to a file a clean round saw needs no new round");
});

test("C8 an edit that adds lines in a span no range saw makes only that span uncovered", () => {
  const repo = opened("rr-c8");
  bigEdit(repo, 800);
  round(repo, "reviewer", `${BIG}:1-400`);
  round(repo, "reviewer", `${BIG}:401-800`);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  edit(repo, BIG, body(800, "big") + body(50, "tail", 800));
  const line = ruleLine(check(repo), "R5");
  assert.match(line, /big\.ts:801-850/);
  assert.doesNotMatch(line, /big\.ts:1-400/);
});

test("C9 an edit above a covered slice moves its lines but keeps them covered; only the new lines are uncovered", () => {
  const repo = opened("rr-c9");
  bigEdit(repo, 800);
  round(repo, "reviewer", `${BIG}:1-400`);
  round(repo, "reviewer", `${BIG}:401-800`);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  edit(repo, BIG, body(10, "top") + body(800, "big"));
  const line = ruleLine(check(repo), "R5");
  assert.match(line, /big\.ts:1-10/);
  assert.doesNotMatch(line, /big\.ts:11-/, "the shifted lines a clean round saw stay covered");
  round(repo, "reviewer", `${BIG}:1-10`);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C1 keys are unique within a file: repeated line pairs in a covered slice do not cover their twins elsewhere", () => {
  const repo = opened("rr-c1b");
  const twin = Array.from({ length: 200 }, () => "export {};\n").join("");
  edit(repo, BIG, "export const big0 = 0;\n" + twin + body(400, "mid") + twin);
  edit(repo, "tests/a.test.ts", "test('a', () => {});\n");
  round(repo, "reviewer", `${BIG}:1-201`);
  const line = ruleLine(check(repo), "R5");
  assert.match(line, /big\.ts:202-801/, "the twin block at the end is still uncovered");
});

test("C1 the printed first slice never holds more units than the cap when several units share a position", () => {
  const units = [...Array.from({ length: 399 }, (_, i) => ({ pos: i + 2, key: `k${i}` })), ...Array.from({ length: 5 }, (_, i) => ({ pos: 401, key: `d${i}` }))];
  assert.equal(sliceEnd(units, 400), 400, "the shared position 401 would push the slice to 404 units");
  assert.equal(sliceEnd(Array.from({ length: 900 }, (_, i) => ({ pos: 7, key: `x${i}` })), 400), 7, "one position over the cap is the slice");
  assert.equal(sliceEnd([{ pos: 3, key: "a" }, { pos: 9, key: "b" }], 400), 9);
});

test("C10 a block of 900 deleted lines sits at one position: that one-position range is a piece as it is", () => {
  const repo = opened("rr-c10", { "src/old.ts": body(900, "o") });
  edit(repo, "src/old.ts", "export const o0 = 0;\n");
  edit(repo, "tests/a.test.ts", "test('o', () => {});\n");
  cli(repo, "note", ["plan", "Shrink old.", "--files", "src/old.ts"]);
  const r = run(repo, "brief", ["reviewer", "--files", "src/old.ts"]);
  assert.match(r.stderr, /src\/old\.ts:(\d+)-\1\b/);
  const slice = /--files (src\/old\.ts:\d+-\d+)/.exec(r.stderr)[1];
  assert.match(cli(repo, "brief", ["reviewer", "--files", slice]), /^packet: /m);
});
