import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadPolicy, policyFor } from "../scripts/lib/size.mjs";

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
const lines = (n, name) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`).join("\n") + "\n";
const reviewFile = (n, actOn) => `# Review ${n} — x\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: npm test exit 0\n`;

function opened(name, config = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"], ...config }, null, 2), "src/b.ts": "export const b = 0;\n" });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Two modules. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "Two modules.", "--files", "src/a.ts,src/b.ts"]);
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  return repo;
}

// a 450-line change: src/a.ts grows to 150 lines, src/b.ts to 300
function bigChange(repo) {
  edit(repo, "src/a.ts", lines(150, "a"));
  edit(repo, "src/b.ts", lines(300, "b"));
  edit(repo, "tests/a.test.ts", "test('a', () => {});\ntest('b', () => {});\n");
}

// one reviewer round on a piece: brief, the helper stops, its file lands, the lead records it
function round(repo, role, files, actOn = []) {
  const out = cli(repo, "brief", files ? [role, "--files", files] : [role]);
  const own = /Your file is .*\/((?:review2?)-\d+\.md)/.exec(out)[1];
  const n = Number(/-(\d+)\.md$/.exec(own)[1]);
  stop(repo, role);
  writeFileSync(path.join(runDir(repo), own), reviewFile(n, actOn));
  cli(repo, "huddle", ["add", role, "--file", own]);
  return own;
}
const packetOf = (out) => readFileSync(out.split("\n").find((l) => l.startsWith("packet: ")).slice(8), "utf8");

test("C1 a 450-line change refuses a whole-diff review, names the files with lines, and briefs a 150-line piece whose packet holds only that piece", () => {
  const repo = opened("rp-c1");
  bigChange(repo);
  const r = run(repo, "brief", ["reviewer"]);
  assert.match(r.stderr, /changed lines/);
  assert.match(r.stderr, /src\/b\.ts \(30\d lines\)/);
  assert.match(r.stderr, /--files/);
  const out = cli(repo, "brief", ["reviewer", "--files", "src/a.ts"]);
  const packet = packetOf(out);
  assert.match(packet, /## Piece\n/);
  assert.match(packet, /src\/a\.ts/);
  assert.ok(packet.includes("diff --git a/src/a.ts"), "the piece's diff is in the packet");
  assert.ok(!packet.includes("diff --git a/src/b.ts"), "the other piece's diff is not");
  assert.ok(packet.includes("tests/a.test.ts"), "changed tests travel with every piece");
  assert.deepEqual(ledgerOf(repo).seen["review-1.md"].files, ["src/a.ts"]);
});

test("C2 --files naming a file outside the change, or a multi-file piece over the cap, is refused; one file over the cap is refused with its first slice", () => {
  const repo = opened("rp-c2");
  bigChange(repo);
  assert.match(run(repo, "brief", ["reviewer", "--files", "src/nope.ts"]).stderr, /src\/nope\.ts/);
  assert.match(run(repo, "brief", ["reviewer", "--files", "tests/a.test.ts"]).stderr, /tests\/a\.test\.ts/);
  assert.match(run(repo, "brief", ["reviewer", "--files", "src/a.ts,src/b.ts"]).stderr, /\d{3} changed lines is more than one review round can read well/);
  edit(repo, "src/b.ts", lines(600, "b"));
  assert.match(run(repo, "brief", ["reviewer", "--files", "src/b.ts"]).stderr, /Slice it by line: `gate brief reviewer --files src\/b\.ts:\d+-\d+`/);
});

test("C3 two pieces reviewed clean in turn pass R5; with only the first done, R5 names the second piece and the --files command", () => {
  const repo = opened("rp-c3");
  bigChange(repo);
  round(repo, "reviewer", "src/a.ts");
  const out = check(repo);
  assert.ok(blocks(out, "R5"), out);
  assert.match(ruleLine(out, "R5"), /src\/b\.ts/);
  assert.match(ruleLine(out, "R5"), /--files src\/b\.ts/);
  round(repo, "reviewer", "src/b.ts");
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C4 a piece with a fixed finding stays uncovered until a clean round sees it; a clean round on A is not undone by a round on B", () => {
  const repo = opened("rp-c4");
  bigChange(repo);
  round(repo, "reviewer", "src/a.ts", ["stray comma — src/a.ts:1 — join on empty — []"]);
  edit(repo, "src/a.ts", lines(151, "a"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/a.ts:1"]);
  assert.match(ruleLine(check(repo), "R5"), /src\/a\.ts/);
  round(repo, "reviewer", "src/b.ts");
  assert.match(ruleLine(check(repo), "R5"), /src\/a\.ts/, "a clean round on B does not cover A");
  assert.doesNotMatch(ruleLine(check(repo), "R5"), /src\/b\.ts/);
  round(repo, "reviewer", "src/a.ts");
  assert.ok(!blocks(check(repo), "R5"), check(repo));
});

test("C5 a change under the cap is briefed with no --files as before, and a ledger with no seen sets keeps the old rule", () => {
  const repo = opened("rp-c5");
  edit(repo, "src/a.ts", lines(30, "a"));
  edit(repo, "tests/a.test.ts", "test('a', () => {});\n");
  round(repo, "reviewer", null);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const h of ledger.huddles) delete h.files;
  delete ledger.seen;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  assert.ok(!blocks(check(repo), "R5"), "a stop after the last edit still counts for a ledger from before");
  edit(repo, "src/a.ts", lines(31, "a"));
  assert.ok(blocks(check(repo), "R5"), "and an edit after it asks for a fresh round, as before");
});

test("C7 reviewer-2 takes --files the same way and R9 reads coverage the same way", () => {
  const repo = opened("rp-c7", { highRisk: ["src/**"] });
  bigChange(repo);
  round(repo, "reviewer", "src/a.ts");
  round(repo, "reviewer", "src/b.ts");
  round(repo, "reviewer-2", "src/a.ts");
  const out = check(repo);
  assert.ok(!blocks(out, "R5"), out);
  assert.match(ruleLine(out, "R9"), /src\/b\.ts/);
  assert.match(ruleLine(out, "R9"), /--files src\/b\.ts/);
  round(repo, "reviewer-2", "src/b.ts");
  assert.ok(!blocks(check(repo), "R9"), check(repo));
});

test("C2 a second piece for the same role is briefed while the first reviewer is still writing: it takes the next number, and the two run side by side", () => {
  const repo = opened("rp-c2b");
  bigChange(repo);
  cli(repo, "brief", ["reviewer", "--files", "src/a.ts"]);
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "A-reviewer", agent_type: "done-gate:reviewer" });
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1 — x\n\n## Act on\n- unverified\n");
  const r = cli(repo, "brief", ["reviewer", "--files", "src/b.ts"]);
  assert.match(r, /^packet: .*brief-reviewer-2\.md$/m, `the second piece did not get packet 2:\n${r}`);
  assert.match(r, /Your file is .*review-2\.md/, `the second reviewer is not told review-2.md:\n${r}`);
  assert.deepEqual(ledgerOf(repo).seen["review-1.md"].files, ["src/a.ts"], "piece A's seen set is untouched");
  assert.deepEqual(ledgerOf(repo).seen["review-2.md"].files, ["src/b.ts"]);
  assert.match(cli(repo, "brief", ["reviewer-2", "--files", "src/b.ts"]), /^packet: /m, "the other role may still run beside it");
  stop(repo, "reviewer");
  // once that reviewer stopped, its draft is a cut-off round and its number is re-briefed
  assert.match(cli(repo, "brief", ["reviewer", "--files", "src/a.ts"]), /^packet: .*brief-reviewer-1\.md$/m);
});

test("C4 the three-round cap is counted per file: a fourth round on piece A is refused while piece B, never seen, can still be briefed", () => {
  const repo = opened("rp-c4b");
  bigChange(repo);
  for (let i = 0; i < 3; i++) {
    round(repo, "reviewer", "src/a.ts", [`finding ${i} — src/a.ts:1 — x — []`]);
    cli(repo, "huddle", ["resolve", `H${i + 1}.1`, "--evidence", "src/a.ts:1"]);
  }
  assert.doesNotMatch(ruleLine(check(repo), "R5"), /src\/a\.ts/, "three rounds saw A: the cap closes it");
  assert.match(ruleLine(check(repo), "R5"), /src\/b\.ts/);
  assert.match(run(repo, "brief", ["reviewer", "--files", "src/a.ts"]).stderr, /three rounds is the cap/);
  assert.match(cli(repo, "brief", ["reviewer", "--files", "src/b.ts"]), /^packet: /m);
});

test("C4 three pieces, each with one fixed finding, never deadlock: the cap counts the rounds that saw a piece, and R5's command fits the cap", () => {
  const repo = opened("rp-c4c");
  edit(repo, "src/a.ts", lines(300, "a"));
  edit(repo, "src/b.ts", lines(300, "b"));
  edit(repo, "src/c.ts", lines(300, "c"));
  edit(repo, "tests/a.test.ts", "test('a', () => {});\n");
  cli(repo, "note", ["plan", "Three modules.", "--files", "src/a.ts,src/b.ts,src/c.ts"]);
  let n = 0;
  for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
    round(repo, "reviewer", f, [`finding — ${f}:1 — x — []`]);
    n += 1;
    edit(repo, f, lines(301, f.slice(4, 5)));
    cli(repo, "huddle", ["resolve", `H${n}.1`, "--evidence", `${f}:1`]);
  }
  const line = ruleLine(check(repo), "R5");
  assert.match(line, /--files src\/a\.ts\b/);
  assert.doesNotMatch(line, /--files src\/a\.ts,src\/b\.ts/, "the printed command itself fits the cap");
  assert.match(cli(repo, "brief", ["reviewer", "--files", "src/a.ts"]), /^packet: /m, "a fourth round of the role is fine: piece A was seen once");
});

test("C2 another piece briefed before the first packet's reviewer ran takes the next number and leaves the first packet as it is; the same piece re-briefs in place", () => {
  const repo = opened("rp-c2c");
  bigChange(repo);
  cli(repo, "brief", ["reviewer", "--files", "src/a.ts"]);
  assert.match(cli(repo, "brief", ["reviewer", "--files", "src/b.ts"]), /^packet: .*brief-reviewer-2\.md$/m);
  assert.deepEqual(ledgerOf(repo).seen["review-1.md"].files, ["src/a.ts"]);
  assert.deepEqual(ledgerOf(repo).seen["review-2.md"].files, ["src/b.ts"]);
  assert.match(cli(repo, "brief", ["reviewer", "--files", "src/a.ts,src/a.ts"]), /^packet: .*brief-reviewer-1\.md$/m);
  assert.deepEqual(ledgerOf(repo).seen["review-1.md"].files, ["src/a.ts"], "duplicates in --files are one file");
});

test("C8 the piece cap comes from the policy, is never below 1, and gate size shows it", () => {
  assert.equal(loadPolicy().reviewMaxLines, 400);
  assert.equal(policyFor({ policy: { tiers: loadPolicy().tiers, reviewMaxLines: 0 } }).reviewMaxLines, 1);
  assert.equal(policyFor({ policy: { tiers: loadPolicy().tiers, reviewMaxLines: null } }).reviewMaxLines, 400);
  assert.equal(policyFor({ policy: { tiers: loadPolicy().tiers, reviewMaxLines: 250 } }).reviewMaxLines, 250);
  const repo = opened("rp-c8");
  assert.match(cli(repo, "size"), /piece cap 400 lines/);
});
