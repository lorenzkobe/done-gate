import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, lookedUp, capRounds, pluginRoot, resealRun } from "./helpers.mjs";
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

function opened(name, config = {}, files = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"], ...config }, null, 2), "src/b.ts": "export const b = 0;\n", ...files });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  lookedUp(repo);
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
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
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
  // three rounds on one piece: a cap past one
  capRounds(repo, 3);
  bigChange(repo);
  for (let i = 0; i < 3; i++) {
    round(repo, "reviewer", "src/a.ts", [`finding ${i} — src/a.ts:1 — x — []`]);
    cli(repo, "huddle", ["resolve", `H${i + 1}.1`, "--evidence", "doc"]);
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
  cli(repo, "plan", ["add", "src/c.ts", "the third module"]);
  let n = 0;
  for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
    round(repo, "reviewer", f, [`finding — ${f}:1 — x — []`]);
    n += 1;
    edit(repo, f, lines(301, f.slice(4, 5)));
    cli(repo, "huddle", ["resolve", `H${n}.1`, "--evidence", "doc"]);
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

// Travel: a changed test or doc goes with one packet per reviewer role, and a piece's own diff is inlined.
const importing = (...names) => names.map((n) => `import "../src/${n}";`).join("\n") + "\ntest('x', () => {});\n";
const NOT_HERE = "Tests and docs not in this packet";
const sectionOf = (packet, heading) => {
  const from = packet.indexOf(`## ${heading}`);
  if (from < 0) return "";
  const to = packet.indexOf("\n## ", from + 1);
  return packet.slice(from, to < 0 ? undefined : to);
};
const diffOf = (packet, rel) => packet.includes(`diff --git a/${rel}`);
// the fixture's own .gitignore is a changed file too
const carriedBy = (repo, file) => Object.keys(ledgerOf(repo).seen[file].carried).filter((p) => p !== ".gitignore").sort();
const briefed = (repo, role, files) => packetOf(cli(repo, "brief", files ? [role, "--files", files] : [role]));
// two 250-line pieces, a test importing each, and a doc that names neither
function twoPieces(repo) {
  edit(repo, "src/alpha.ts", lines(250, "alpha"));
  edit(repo, "src/beta.ts", lines(250, "beta"));
  edit(repo, "tests/alpha.test.ts", importing("alpha"));
  edit(repo, "tests/beta.test.ts", importing("beta"));
  edit(repo, "docs/notes.md", "# notes\n\nA paragraph about nothing in the change.\n");
}

test("travel C1 C3 C17: a piece's packet inlines its own diff and its test; the other piece's test is only listed; a doc naming no changed file goes with the first of two packets briefed back to back", () => {
  const repo = opened("rp-travel-c1");
  twoPieces(repo);
  const first = briefed(repo, "reviewer", "src/alpha.ts");
  assert.ok(diffOf(first, "src/alpha.ts"), "the piece's own diff");
  assert.ok(diffOf(first, "tests/alpha.test.ts"), "the test that imports the piece");
  assert.ok(diffOf(first, "docs/notes.md"), "a doc naming no changed file goes with the first packet");
  assert.ok(!diffOf(first, "tests/beta.test.ts"), "the other piece's test waits for its piece");
  assert.match(sectionOf(first, NOT_HERE), /- tests\/beta\.test\.ts/);
  assert.deepEqual(carriedBy(repo, "review-1.md"), ["docs/notes.md", "tests/alpha.test.ts"]);
  const second = briefed(repo, "reviewer", "src/beta.ts");
  assert.ok(diffOf(second, "src/beta.ts") && diffOf(second, "tests/beta.test.ts"));
  assert.ok(!diffOf(second, "docs/notes.md") && !diffOf(second, "tests/alpha.test.ts"), "what the first packet carries is not carried again");
  assert.match(sectionOf(second, NOT_HERE), /- docs\/notes\.md/);
  assert.match(sectionOf(second, NOT_HERE), /- tests\/alpha\.test\.ts/);
  assert.deepEqual(carriedBy(repo, "review-2.md"), ["tests/beta.test.ts"]);
});

test("travel C2: a whole-file piece whose own diff is over 300 lines is inlined in full, with its small test beside it", () => {
  const repo = opened("rp-travel-c2");
  edit(repo, "src/alpha.ts", lines(350, "alpha"));
  edit(repo, "tests/alpha.test.ts", importing("alpha"));
  const packet = briefed(repo, "reviewer", "src/alpha.ts");
  assert.ok(packet.includes("+export const alpha0 = 0;") && packet.includes("+export const alpha349 = 349;"), "first and last line of the piece");
  assert.ok(diffOf(packet, "tests/alpha.test.ts"));
  assert.doesNotMatch(packet, /diff too long to inline/);
});

test("travel C14: a whole-file piece whose raw diff is past three times the piece cap is listed with its line count, not inlined", () => {
  const base = Array.from({ length: 700 }, (_, i) => `export const wide${i} = ${i};`);
  const repo = opened("rp-travel-c14", {}, { "src/wide.ts": base.join("\n") + "\n" });
  edit(repo, "src/wide.ts", base.map((l, i) => (i === 5 ? "  export const wide5 = 500;" : `  ${l}`)).join("\n") + "\n");
  const packet = briefed(repo, "reviewer", "src/wide.ts");
  assert.ok(!diffOf(packet, "src/wide.ts"), "1400 raw diff lines are not inlined");
  assert.match(packet, /## Changed files \(diff too long to inline: \d+ lines\)/);
  assert.match(packet, /- src\/wide\.ts \(source, 700 lines now\)/);
});

test("travel C4: a file reviewed in two slices: its test goes with the first slice and is only listed with the second", () => {
  const repo = opened("rp-travel-c4");
  edit(repo, "src/alpha.ts", lines(600, "alpha"));
  edit(repo, "tests/alpha.test.ts", importing("alpha"));
  assert.ok(diffOf(briefed(repo, "reviewer", "src/alpha.ts:1-400"), "tests/alpha.test.ts"));
  const second = briefed(repo, "reviewer", "src/alpha.ts:401-600");
  assert.ok(!diffOf(second, "tests/alpha.test.ts"));
  assert.match(sectionOf(second, NOT_HERE), /- tests\/alpha\.test\.ts/);
});

test("travel C15 C5: a test naming only another piece's file waits while that piece is owed a round; edited after its piece's clean round, it goes with the next packet", () => {
  const repo = opened("rp-travel-c15");
  twoPieces(repo);
  const waiting = briefed(repo, "reviewer", "src/beta.ts");
  assert.ok(!diffOf(waiting, "tests/alpha.test.ts"), "alpha is still owed a round");
  round(repo, "reviewer", "src/alpha.ts");
  assert.ok(ledgerOf(repo).seen["review-2.md"].carried["tests/alpha.test.ts"]);
  edit(repo, "tests/alpha.test.ts", importing("alpha") + "test('added by a fix', () => {});\n");
  const next = briefed(repo, "reviewer", "src/beta.ts");
  assert.ok(next.includes("+test('added by a fix', () => {});"), "alpha has no round left, so its changed test goes with the next packet");
});

test("travel C6: the second reviewer has its own carry", () => {
  const repo = opened("rp-travel-c6");
  twoPieces(repo);
  briefed(repo, "reviewer", "src/alpha.ts");
  const packet = briefed(repo, "reviewer-2", "src/alpha.ts");
  assert.ok(diffOf(packet, "tests/alpha.test.ts") && diffOf(packet, "docs/notes.md"));
  assert.deepEqual(carriedBy(repo, "review2-1.md"), ["docs/notes.md", "tests/alpha.test.ts"]);
});

test("travel C7: briefing the same packet file again carries the same files again", () => {
  const repo = opened("rp-travel-c7");
  twoPieces(repo);
  briefed(repo, "reviewer", "src/alpha.ts");
  const out = cli(repo, "brief", ["reviewer", "--files", "src/alpha.ts"]);
  assert.match(out, /^packet: .*brief-reviewer-1\.md$/m);
  assert.ok(diffOf(packetOf(out), "tests/alpha.test.ts") && diffOf(packetOf(out), "docs/notes.md"));
});

test("travel C16: a packet whose helper stopped on a draft carried nothing: the next piece's packet takes the unclaimed doc", () => {
  const repo = opened("rp-travel-c16");
  twoPieces(repo);
  briefed(repo, "reviewer", "src/alpha.ts");
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "A-reviewer", agent_type: "done-gate:reviewer" });
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1 — x\n\n## Act on\n- unverified\n## Can't verify\n- unverified\n## Lessons\n- unverified\n## Dismissed\n- unverified\n");
  stop(repo, "reviewer");
  const packet = briefed(repo, "reviewer", "src/beta.ts");
  assert.ok(diffOf(packet, "docs/notes.md"), "the cut-off packet showed it to nobody");
  assert.ok(!diffOf(packet, "tests/alpha.test.ts"), "alpha's test still waits for alpha");
});

test("travel C8: one piece holding the whole change carries every changed test and doc and has no list of files left out", () => {
  const repo = opened("rp-travel-c8");
  edit(repo, "src/alpha.ts", lines(40, "alpha"));
  edit(repo, "src/beta.ts", lines(40, "beta"));
  edit(repo, "tests/alpha.test.ts", importing("alpha"));
  edit(repo, "tests/beta.test.ts", importing("beta"));
  edit(repo, "docs/notes.md", "# notes\n\nA paragraph.\n");
  const packet = briefed(repo, "reviewer");
  for (const f of ["src/alpha.ts", "src/beta.ts", "tests/alpha.test.ts", "tests/beta.test.ts", "docs/notes.md"]) assert.ok(diffOf(packet, f), f);
  assert.ok(!packet.includes(NOT_HERE));
});

test("travel C9: a test naming files of two pieces goes with whichever is briefed first, once", () => {
  const repo = opened("rp-travel-c9");
  twoPieces(repo);
  edit(repo, "tests/both.test.ts", importing("alpha", "beta"));
  assert.ok(diffOf(briefed(repo, "reviewer", "src/beta.ts"), "tests/both.test.ts"));
  assert.ok(!diffOf(briefed(repo, "reviewer", "src/alpha.ts"), "tests/both.test.ts"));
});

test("travel C10: travelling tests over 300 diff lines are listed with line counts while the piece's own diff stays inlined", () => {
  const repo = opened("rp-travel-c10");
  edit(repo, "src/alpha.ts", lines(50, "alpha"));
  edit(repo, "tests/alpha.test.ts", importing("alpha") + Array.from({ length: 350 }, (_, i) => `test('t${i}', () => {});`).join("\n") + "\n");
  const packet = briefed(repo, "reviewer", "src/alpha.ts");
  assert.ok(diffOf(packet, "src/alpha.ts"));
  assert.match(packet, /## Other changed files \(diff too long to inline: \d+ lines\)/);
  assert.match(packet, /- tests\/alpha\.test\.ts \(test, 352 lines now\)/);
  assert.ok(!diffOf(packet, "tests/alpha.test.ts"));
});

test("travel C11: a packet record with no carry list, or a damaged one, carried nothing and does not crash the brief", () => {
  for (const damage of [undefined, "oops", null]) {
    const repo = opened(`rp-travel-c11-${String(damage)}`);
    twoPieces(repo);
    briefed(repo, "reviewer", "src/alpha.ts");
    const file = path.join(runDir(repo), "ledger.json");
    const ledger = JSON.parse(readFileSync(file, "utf8"));
    if (damage === undefined) delete ledger.seen["review-1.md"].carried;
    else ledger.seen["review-1.md"].carried = damage;
    writeFileSync(file, JSON.stringify(ledger, null, 2));
    resealRun(repo);
    assert.ok(diffOf(briefed(repo, "reviewer", "src/beta.ts"), "docs/notes.md"), `carried: ${String(damage)}`);
  }
});

test("travel C12: the list of files left out says who checks them, and a deleted test is carried as a deletion line", () => {
  const repo = opened("rp-travel-c12", {}, { "tests/old.test.ts": "test('old', () => {});\n" });
  twoPieces(repo);
  execFileSync("rm", [path.join(repo, "tests/old.test.ts")]);
  const first = briefed(repo, "reviewer", "src/alpha.ts");
  assert.match(first, /deleted: tests\/old\.test\.ts/);
  assert.match(sectionOf(first, NOT_HERE), /An earlier round of yours, or the round on another piece, checks these files and the cases whose tests they hold\. Read one only when a finding of yours depends on it\./);
  const second = briefed(repo, "reviewer", "src/beta.ts");
  assert.doesNotMatch(second, /deleted: tests\/old\.test\.ts/);
  assert.match(sectionOf(second, NOT_HERE), /- tests\/old\.test\.ts/);
});

test("travel C18: a re-check of the same piece under a new packet number lists its unchanged test as left out, and carries it again once it changes", () => {
  const repo = opened("rp-travel-c18");
  edit(repo, "src/alpha.ts", lines(40, "alpha"));
  edit(repo, "tests/alpha.test.ts", importing("alpha"));
  round(repo, "reviewer", null, ["off by one — src/alpha.ts:3 — x — []"]);
  edit(repo, "src/alpha.ts", lines(40, "alpha").replace("alpha2 = 2", "alpha2 = 22"));
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  const out = cli(repo, "brief", ["reviewer"]);
  assert.match(out, /^packet: .*brief-reviewer-2\.md$/m);
  assert.ok(!diffOf(packetOf(out), "tests/alpha.test.ts"));
  assert.match(sectionOf(packetOf(out), NOT_HERE), /- tests\/alpha\.test\.ts/);
});

test("travel C19: a test naming a piece file with a generic or one-letter stem goes with that piece", () => {
  const repo = opened("rp-travel-c19");
  edit(repo, "src/a.ts", lines(250, "a"));
  edit(repo, "src/api/views.ts", lines(250, "views"));
  edit(repo, "tests/one.test.ts", importing("a"));
  edit(repo, "tests/two.test.ts", importing("api/views"));
  const first = briefed(repo, "reviewer", "src/a.ts");
  assert.ok(diffOf(first, "tests/one.test.ts") && !diffOf(first, "tests/two.test.ts"));
  assert.ok(diffOf(briefed(repo, "reviewer", "src/api/views.ts"), "tests/two.test.ts"));
});

test("travel C20: the reviewer's instructions limit the case check to the tests the packet shows", () => {
  assert.match(readFileSync(path.join(pluginRoot, "agents", "reviewer.md"), "utf8"), /For each case in the table whose test file the packet shows/);
});

test("travel C21: a packet replaced before any helper started carried nothing, so the packet that replaces it carries the piece's test", () => {
  const repo = opened("rp-travel-c21");
  edit(repo, "src/alpha.ts", lines(250, "alpha"));
  edit(repo, "tests/alpha.test.ts", importing("alpha"));
  briefed(repo, "reviewer", "src/alpha.ts:1-100");
  const out = cli(repo, "brief", ["reviewer", "--files", "src/alpha.ts"]);
  assert.match(out, /^packet: .*brief-reviewer-2\.md$/m);
  assert.ok(diffOf(packetOf(out), "tests/alpha.test.ts"), "no helper read the first packet");
});

test("travel C22: a test beside its source, a test named after it, a Python from-import and an index file named by its folder each go with their own piece", () => {
  const repo = opened("rp-travel-c22", { source: ["src/**", "app/**"], tests: ["**/*.test.ts", "**/test_*.py"] });
  edit(repo, "src/other/thing.ts", lines(150, "thing"));
  edit(repo, "src/api/views.ts", lines(150, "views"));
  edit(repo, "src/api/spec.test.ts", 'import { views0 } from "./views";\ntest("x", () => {});\n');
  edit(repo, "tests/views.test.ts", "test('named after its source, importing nothing', () => {});\n");
  edit(repo, "app/booking.py", Array.from({ length: 150 }, (_, i) => `b${i} = ${i}`).join("\n") + "\n");
  edit(repo, "app/test_rates.py", "from app import booking\n\ndef test_x():\n    assert booking.b0 == 0\n");
  edit(repo, "src/Button/index.ts", lines(150, "button"));
  edit(repo, "src/ui.test.ts", 'import { button0 } from "@/src/Button";\ntest("x", () => {});\n');
  const first = briefed(repo, "reviewer", "src/other/thing.ts");
  for (const f of ["src/api/spec.test.ts", "tests/views.test.ts", "app/test_rates.py", "src/ui.test.ts"]) assert.ok(!diffOf(first, f), `${f} waits for its own piece`);
  const views = briefed(repo, "reviewer", "src/api/views.ts");
  assert.ok(diffOf(views, "src/api/spec.test.ts") && diffOf(views, "tests/views.test.ts"));
  assert.ok(diffOf(briefed(repo, "reviewer", "app/booking.py"), "app/test_rates.py"));
  assert.ok(diffOf(briefed(repo, "reviewer", "src/Button/index.ts"), "src/ui.test.ts"));
});
