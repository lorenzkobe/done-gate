import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, lookedUp, write, threeRounds } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// From the 0.20.0 review, 3.8: on high-risk files reviewer-2 hit the three-round cap and the
// fix to its third round's finding was never reviewed. Three full rounds stay; a fix after the
// third gets one fix-check round over the lines it changed, and that round's fixes need no fifth.

const env = (repo) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" });
const run = (repo, ...args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: env(repo) });
const hook = (repo, payload) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: env(repo) });
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const ruleLine = (repo, rule) => run(repo, "check").stdout.split("\n").filter((l) => new RegExp(`\\b${rule}\\b`).test(l)).join("\n");
const FILE = "src/pay.ts";

function opened(name) {
  const repo = makeRepo(name, {
    [FILE]: Array.from({ length: 30 }, (_, i) => `export const p${i} = ${i};`).join("\n") + "\n",
    ".claude/gate.json": JSON.stringify({ testFiles: null, highRisk: ["src/pay.ts"] }),
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  assert.equal(run(repo, "open", "t", "feature").status, 0);
  lookedUp(repo);
  run(repo, "note", "task", "Pay totals.");
  run(repo, "note", "context", "Traced: src/pay.ts:1 · Related: none: `grep -rn p src` · Research: none needed: a test fixture");
  run(repo, "note", "plan", "One file.", "--files", FILE);
  run(repo, "case", "add", "totals add up", "--kind", "happy");
  edit(repo, 0);
  return repo;
}
function edit(repo, n) {
  const abs = path.join(repo, FILE);
  write(repo, FILE, readFileSync(abs, "utf8").replace(`p${n} = ${n};`, `p${n} = ${n + 100};`));
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs }, tool_response: {} });
}
// one briefed round of the role, run by a helper that searched first, recorded, its finding fixed
// by an edit and resolved unless asked to leave it open
function round(repo, role, n, { finding = true, fix = true } = {}) {
  const brief = run(repo, "brief", role);
  assert.equal(brief.status, 0, brief.stderr);
  const file = /Your file is .*\/((?:review2?)-\d+\.md)/.exec(brief.stdout)[1];
  const agent = { agent_id: `${role}-${n}`, agent_type: `done-gate:${role}` };
  hook(repo, { hook_event_name: "SubagentStart", ...agent });
  lookedUp(repo, { agent: agent.agent_id, role });
  const body = `# Review ${n}\n\n## Act on\n${finding ? `- off by one at src/pay.ts:${n} — the total skips the last row` : "- none"}\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: ok\n`;
  writeFileSync(path.join(runDir(repo), file), body);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(runDir(repo), file) }, tool_response: {}, ...agent });
  hook(repo, { hook_event_name: "SubagentStop", ...agent });
  assert.equal(run(repo, "huddle", "add", role, "--file", file).status, 0);
  if (!finding || !fix) return brief;
  edit(repo, n);
  const id = ledgerOf(repo).huddles.at(-1).actOn[0].id;
  assert.equal(run(repo, "huddle", "resolve", id, "--evidence", "src/pay.ts:1", "fixed").status, 0);
  return brief;
}
const capped = (r) => /three rounds is the cap/.test(r.stderr);

test("C1 reported-surface: after reviewer-2 round 3's finding is fixed, R9 names the fixed lines and round 4 is briefed with it to re-check", () => {
  const repo = opened("rcf-c1");
  threeRounds(repo);
  for (const n of [1, 2, 3]) round(repo, "reviewer-2", n);
  assert.match(ruleLine(repo, "R9"), /src\/pay\.ts/);
  const fourth = run(repo, "brief", "reviewer-2");
  assert.equal(fourth.status, 0, fourth.stderr);
  const packet = readFileSync(/packet: (\S+)/.exec(fourth.stdout)[1], "utf8");
  assert.match(packet, /## Findings to re-check/);
  assert.match(packet, /off by one at src\/pay\.ts:3/);
});

test("C2 boundary: a fix after the fix-check round clears R9 with no fifth round, and a fifth brief is refused", () => {
  const repo = opened("rcf-c2");
  threeRounds(repo);
  for (const n of [1, 2, 3]) round(repo, "reviewer-2", n);
  round(repo, "reviewer-2", 4, { fix: false });
  assert.match(ruleLine(repo, "R9"), /still open/, "the fix-check's finding is fixed and resolved");
  assert.doesNotMatch(ruleLine(repo, "R9"), /gate brief/);
  edit(repo, 4);
  assert.equal(run(repo, "huddle", "resolve", ledgerOf(repo).huddles.at(-1).actOn[0].id, "--evidence", "src/pay.ts:1", "fixed").status, 0);
  assert.equal(ruleLine(repo, "R9"), "");
  assert.ok(capped(run(repo, "brief", "reviewer-2")));
});

test("C3 refused: with round 3's finding still open, round 4 is refused at the cap", () => {
  const repo = opened("rcf-c3");
  threeRounds(repo);
  for (const n of [1, 2]) round(repo, "reviewer-2", n);
  round(repo, "reviewer-2", 3, { fix: false });
  assert.ok(capped(run(repo, "brief", "reviewer-2")));
  // what R9 prints can be run: resolve the finding, not brief a round the cap refuses
  assert.match(ruleLine(repo, "R9"), /Act-on item\(s\) still open: H\d+\.1.*gate huddle resolve/);
  assert.doesNotMatch(ruleLine(repo, "R9"), /gate brief/);
});

test("C4 edge: round 3 clean: no R9 and round 4 is refused", () => {
  const repo = opened("rcf-c4");
  threeRounds(repo);
  for (const n of [1, 2]) round(repo, "reviewer-2", n);
  round(repo, "reviewer-2", 3, { finding: false });
  assert.equal(ruleLine(repo, "R9"), "");
  assert.ok(capped(run(repo, "brief", "reviewer-2")));
});

test("C5 happy: the reviewer follows the same rule", () => {
  const repo = opened("rcf-c5");
  threeRounds(repo);
  for (const n of [1, 2, 3]) round(repo, "reviewer", n);
  assert.match(ruleLine(repo, "R5"), /src\/pay\.ts/);
  assert.equal(run(repo, "brief", "reviewer").status, 0);
});

test("C6 refused: a fix-check that leaves out part of a file's unreviewed lines is refused and names them all", () => {
  const repo = opened("rcf-c6");
  threeRounds(repo);
  for (const n of [1, 2, 3]) round(repo, "reviewer-2", n);
  edit(repo, 20);
  const entries = /--files (\S+?)`/.exec(ruleLine(repo, "R9"))[1].split(",");
  assert.ok(entries.length > 1, entries.join(","));
  const part = run(repo, "brief", "reviewer-2", "--files", entries[0]);
  assert.notEqual(part.status, 0);
  assert.ok(part.stderr.includes(`--files ${entries.join(",")}`), part.stderr);
  assert.equal(run(repo, "brief", "reviewer-2", "--files", entries.join(",")).status, 0);
});

// From docs/after-0.21.0.md, limits 3 and 4: a fix gives its lines new keys, so rounds on a slice
// never reached the cap; and a fix-check cut off before its helper stopped used up the file's one.
const BIG = "src/big.ts";
function sliced(name) {
  const repo = opened(name);
  threeRounds(repo);
  const abs = path.join(repo, BIG);
  write(repo, BIG, Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs }, tool_response: {} });
  return repo;
}
function sliceRound(repo, n, entry, { stop = true } = {}) {
  const brief = run(repo, "brief", "reviewer", "--files", entry);
  if (brief.status !== 0) return brief;
  const file = /Your file is .*\/(review-\d+\.md)/.exec(brief.stdout)[1];
  const agent = { agent_id: `rs-${n}`, agent_type: "done-gate:reviewer" };
  hook(repo, { hook_event_name: "SubagentStart", ...agent });
  lookedUp(repo, { agent: agent.agent_id, role: "reviewer" });
  writeFileSync(path.join(runDir(repo), file), `# Review ${n}\n\n## Act on\n- off by one at ${BIG}:6 — wrong\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: ok\n`);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(runDir(repo), file) }, tool_response: {}, ...agent });
  if (stop) hook(repo, { hook_event_name: "SubagentStop", ...agent });
  assert.equal(run(repo, "huddle", "add", "reviewer", "--file", file).status, 0);
  const abs = path.join(repo, BIG);
  write(repo, BIG, readFileSync(abs, "utf8").replace(/^export const v5 = .*$/m, `export const v5 = ${1000 + n};`));
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs }, tool_response: {} });
  assert.equal(run(repo, "huddle", "resolve", ledgerOf(repo).huddles.at(-1).actOn[0].id, "--evidence", "src/pay.ts:1", "fixed").status, 0);
  return brief;
}
const slicePending = (repo) => /--files (\S+?)`/.exec(ruleLine(repo, "R5"))?.[1];

test("C1 reported-surface: a slice whose fixed lines keep coming back gets three rounds and one fix-check, then the cap", () => {
  const repo = sliced("rcf-s1");
  assert.equal(sliceRound(repo, 1, `${BIG}:1-400`).status, 0);
  for (const n of [2, 3]) assert.equal(sliceRound(repo, n, slicePending(repo).split(",").find((e) => e.startsWith(BIG))).status, 0, `round ${n}`);
  const fixCheck = sliceRound(repo, 4, slicePending(repo).split(",").filter((e) => e.startsWith(BIG)).join(","));
  assert.equal(fixCheck.status, 0, fixCheck.stderr);
  assert.equal(ledgerOf(repo).huddles.at(-1).fixCheck, true, "round 4 is the fix-check");
  assert.doesNotMatch(ruleLine(repo, "R5"), new RegExp(`${BIG}:`), "the fix-check ended the slice's review");
  assert.ok(capped(run(repo, "brief", "reviewer", "--files", `${BIG}:6-7`)));
});

test("C2 boundary: a range no earlier slice round overlapped is still briefed", () => {
  const repo = sliced("rcf-s2");
  assert.equal(sliceRound(repo, 1, `${BIG}:1-400`).status, 0);
  for (const n of [2, 3]) assert.equal(sliceRound(repo, n, `${BIG}:6-7`).status, 0, `round ${n}`);
  const other = run(repo, "brief", "reviewer", "--files", `${BIG}:401-600`);
  assert.equal(other.status, 0, other.stderr);
});

test("C3 refused: a fix-check cut off before its helper stopped can be briefed again, and ends the file once one stops", () => {
  const repo = opened("rcf-s3");
  threeRounds(repo);
  for (const n of [1, 2, 3]) round(repo, "reviewer", n);
  const cut = run(repo, "brief", "reviewer");
  assert.equal(cut.status, 0, cut.stderr);
  const file = /Your file is .*\/(review-\d+\.md)/.exec(cut.stdout)[1];
  writeFileSync(path.join(runDir(repo), file), "# Review 4\n\n## Act on\n- none\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: ok\n");
  assert.equal(run(repo, "huddle", "add", "reviewer", "--file", file).status, 0);
  assert.match(ruleLine(repo, "R5"), /src\/pay\.ts/, "the cut-off round covers nothing");
  round(repo, "reviewer", 5, { finding: false });
  assert.equal(ledgerOf(repo).huddles.at(-1).fixCheck, true);
  assert.equal(ruleLine(repo, "R5"), "");
  assert.ok(capped(run(repo, "brief", "reviewer")));
});

test("C5 refused: a fix-check whose own helper has not stopped is not ended by another reviewer's stop, and a second one is refused while it runs", () => {
  const repo = opened("rcf-s5");
  threeRounds(repo);
  for (const n of [1, 2, 3]) round(repo, "reviewer", n);
  const live = run(repo, "brief", "reviewer");
  assert.equal(live.status, 0, live.stderr);
  const file = /Your file is .*\/(review-\d+\.md)/.exec(live.stdout)[1];
  const mine = { agent_id: "fc-live", agent_type: "done-gate:reviewer" };
  hook(repo, { hook_event_name: "SubagentStart", ...mine });
  lookedUp(repo, { agent: mine.agent_id, role: "reviewer" });
  writeFileSync(path.join(runDir(repo), file), "# Review 4\n\n## Act on\n- none\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: ok\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(runDir(repo), file) }, tool_response: {}, ...mine });
  const added = run(repo, "huddle", "add", "reviewer", "--file", file);
  assert.equal(added.status, 0, added.stderr);
  const other = { agent_id: "rv-other", agent_type: "done-gate:reviewer" };
  hook(repo, { hook_event_name: "SubagentStart", ...other });
  hook(repo, { hook_event_name: "SubagentStop", ...other });
  assert.match(ruleLine(repo, "R5"), /src\/pay\.ts/, "another reviewer's stop does not end the file");
  const again = run(repo, "brief", "reviewer");
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /still running/);
  hook(repo, { hook_event_name: "SubagentStop", ...mine });
  assert.equal(ruleLine(repo, "R5"), "", "its own stop ends the file");
});

function appended(repo, count) {
  const abs = path.join(repo, FILE);
  const added = Array.from({ length: count }, (_, i) => `export const late${i} = ${i};`).join("\n") + "\n";
  write(repo, FILE, readFileSync(abs, "utf8") + added);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs }, tool_response: {} });
}
const printedPiece = (repo) => /--files (\S+?)`/.exec(ruleLine(repo, "R9"))?.[1] ?? null;
function piece(repo, n, files, { finding = false } = {}) {
  const brief = run(repo, "brief", "reviewer-2", "--files", files);
  assert.equal(brief.status, 0, brief.stderr);
  const file = /Your file is .*\/(review2-\d+\.md)/.exec(brief.stdout)[1];
  const agent = { agent_id: `reviewer-2-${n}`, agent_type: "done-gate:reviewer-2" };
  hook(repo, { hook_event_name: "SubagentStart", ...agent });
  lookedUp(repo, { agent: agent.agent_id, role: "reviewer-2" });
  const body = `# Review ${n}\n\n## Act on\n${finding ? `- off by one at src/pay.ts:${n} — the total skips the last row` : "- none"}\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: x exit 0, 1 passed (unverified)\n- cases: 1/1 tests match their case\n`;
  writeFileSync(path.join(runDir(repo), file), body);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(runDir(repo), file) }, tool_response: {}, ...agent });
  hook(repo, { hook_event_name: "SubagentStop", ...agent });
  assert.equal(run(repo, "huddle", "add", "reviewer-2", "--file", file).status, 0);
}
function atCapWith(name, late) {
  const repo = opened(name);
  threeRounds(repo);
  for (const n of [1, 2, 3]) round(repo, "reviewer-2", n);
  appended(repo, late);
  return repo;
}

test("489 unreviewed lines past the cap close through the printed commands, read in order", () => {
  const repo = atCapWith("rcf-489", 489);
  const whole = run(repo, "brief", "reviewer-2");
  assert.notEqual(whole.status, 0, "a whole round over the cap stays refused");
  const seen = [];
  for (let n = 4; n < 12 && printedPiece(repo); n++) {
    const files = printedPiece(repo);
    seen.push(files);
    piece(repo, n, files);
  }
  assert.equal(ruleLine(repo, "R9"), "", `the file closes: ${seen.join(" then ")}`);
  assert.ok(seen.length >= 2, seen.join(" then "));
  const rounds = ledgerOf(repo).huddles.filter((h) => h.fixCheck);
  assert.deepEqual(rounds.map((h) => Boolean(h.part)), rounds.map((_, i) => i < rounds.length - 1), "every round but the last is a part");
  assert.ok(capped(run(repo, "brief", "reviewer-2", "--files", `${FILE}:1-2`)), "the last round ended the file");
});

test("a fix inside a part reopens only the lines it changed, and the last round ends the file", () => {
  const repo = atCapWith("rcf-part-fix", 489);
  const first = printedPiece(repo);
  piece(repo, 4, first, { finding: true });
  assert.match(ruleLine(repo, "R9"), /still open/);
  assert.equal(printedPiece(repo), null, "a part's open finding is closed before the next part");
  const abs = path.join(repo, FILE);
  write(repo, FILE, readFileSync(abs, "utf8").replace("late3 = 3;", "late3 = 300;"));
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs }, tool_response: {} });
  assert.equal(run(repo, "huddle", "resolve", ledgerOf(repo).huddles.at(-1).actOn[0].id, "--evidence", "src/pay.ts:1", "fixed").status, 0);
  const left = /--files (\S+?)`/.exec(ruleLine(repo, "R9"))[1].split(",");
  const fixedLine = readFileSync(abs, "utf8").split("\n").findIndex((l) => l.includes("late3 = 300")) + 1;
  const reviewed = readFileSync(abs, "utf8").split("\n").findIndex((l) => l.includes("late10 = 10")) + 1;
  const covers = (entry, line) => { const m = /:(\d+)-(\d+)$/.exec(entry); return m ? +m[1] <= line && line <= +m[2] : true; };
  assert.ok(ruleLine(repo, "R9").includes(`:${fixedLine}`) || left.some((e) => covers(e, fixedLine)), `the fixed line is asked for: ${left}`);
  assert.ok(!left.some((e) => covers(e, reviewed)), `a line the part read stays read: ${left}`);
  for (let n = 5; n < 12 && printedPiece(repo); n++) piece(repo, n, printedPiece(repo));
  assert.equal(ruleLine(repo, "R9"), "");
  assert.ok(capped(run(repo, "brief", "reviewer-2", "--files", `${FILE}:1-2`)));
});

test("under the cap a piece of the fix-check stays refused, and a part holding no unreviewed line is refused", () => {
  const small = atCapWith("rcf-small", 300);
  const whole = /--files (\S+?)`/.exec(ruleLine(small, "R9"))[1];
  const line = Number(/:(\d+)-/.exec(whole)?.[1] ?? 40);
  assert.notEqual(run(small, "brief", "reviewer-2", "--files", `${FILE}:${line}-${line + 5}`).status, 0, "it fits, so it takes them all");
  const big = atCapWith("rcf-big", 489);
  const stale = run(big, "brief", "reviewer-2", "--files", `${FILE}:2-3`);
  assert.notEqual(stale.status, 0, "those lines were all read");
  assert.match(stale.stderr, /no unreviewed line/);
});

test("two files whose unreviewed lines together pass the cap close through the printed commands, spans and all", () => {
  const OTHER = "src/tax.ts";
  const lines = (name, n) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`).join("\n") + "\n";
  const repo = makeRepo("rcf-two", {
    [FILE]: lines("p", 30),
    [OTHER]: lines("t", 40),
    ".claude/gate.json": JSON.stringify({ testFiles: null, highRisk: ["src/pay.ts", "src/tax.ts"] }),
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  assert.equal(run(repo, "open", "t", "feature").status, 0);
  threeRounds(repo);
  lookedUp(repo);
  run(repo, "note", "task", "Pay totals.");
  run(repo, "note", "context", "Traced: src/pay.ts:1 · Related: none: `grep -rn p src` · Research: none needed: a test fixture");
  run(repo, "note", "plan", "Two files.", "--files", `${FILE},${OTHER}`);
  run(repo, "case", "add", "totals add up", "--kind", "happy");
  edit(repo, 0);
  const editOther = (body) => {
    write(repo, OTHER, body);
    hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, OTHER) }, tool_response: {} });
  };
  editOther(readFileSync(path.join(repo, OTHER), "utf8").replace("t0 = 0;", "t0 = 100;"));
  for (const n of [1, 2, 3]) round(repo, "reviewer-2", n);
  appended(repo, 300);
  editOther(lines("top", 50) + readFileSync(path.join(repo, OTHER), "utf8") + lines("end", 100));
  const seen = [];
  for (let n = 4; n < 12 && printedPiece(repo); n++) {
    seen.push(printedPiece(repo));
    piece(repo, n, printedPiece(repo));
  }
  assert.equal(ruleLine(repo, "R9"), "", `closes: ${seen.join(" then ")}`);
});

test("a bare brief over the cap prints the next uncovered piece, not the file's start", () => {
  const repo = atCapWith("rcf-bare", 489);
  piece(repo, 4, printedPiece(repo));
  const next = printedPiece(repo);
  assert.ok(next);
  const bare = run(repo, "brief", "reviewer-2");
  assert.notEqual(bare.status, 0);
  assert.ok(bare.stderr.includes(`--files ${next}`), `${next}\n${bare.stderr}`);
});

test("a fix inside a part that deletes a line does not reopen lines earlier rounds read", () => {
  const repo = atCapWith("rcf-part-delete", 489);
  piece(repo, 4, printedPiece(repo), { finding: true });
  const abs = path.join(repo, FILE);
  write(repo, FILE, readFileSync(abs, "utf8").replace("export const late3 = 3;\n", ""));
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs }, tool_response: {} });
  assert.equal(run(repo, "huddle", "resolve", ledgerOf(repo).huddles.at(-1).actOn[0].id, "--evidence", "src/pay.ts:1", "fixed").status, 0);
  const pending = ruleLine(repo, "R9");
  assert.doesNotMatch(pending, /src\/pay\.ts:2-|src\/pay\.ts:1-\d{2,}/, pending);
});

// 6.3: the cap comes from the pinned policy, and a dispute reaches the last round
function pinCap(repo, n) {
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  ledger.policy = { ...ledger.policy, reviewRounds: n };
  writeFileSync(file, JSON.stringify(ledger, null, 2));
}
const packetOf = (r) => readFileSync(/packet: (\S+)/.exec(r.stdout)[1], "utf8");
// a stopped helper's file for the round its brief named
function answer(repo, brief, role, body, n) {
  const file = /Your file is .*\/((?:review2?)-\d+\.md)/.exec(brief.stdout)[1];
  const agent = { agent_id: `${role}-d${n}`, agent_type: `done-gate:${role}` };
  hook(repo, { hook_event_name: "SubagentStart", ...agent });
  lookedUp(repo, { agent: agent.agent_id, role });
  writeFileSync(path.join(runDir(repo), file), body);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(runDir(repo), file) }, tool_response: {}, ...agent });
  hook(repo, { hook_event_name: "SubagentStop", ...agent });
  return run(repo, "huddle", "add", role, "--file", file);
}
const disputed = (repo) => {
  const id = ledgerOf(repo).huddles.at(-1).actOn[0].id;
  const r = run(repo, "huddle", "dispute", id, "the total already counts the last row", "--evidence", "src/pay.ts:2");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /^done-gate: /m, r.stderr);
  return id;
};

test("6.3 C3 happy: at a pinned cap of 1, a disputed finding with no edit is briefed, and the packet lists it to answer", () => {
  const repo = opened("rcf-63-c3");
  pinCap(repo, 1);
  round(repo, "reviewer", 1, { fix: false });
  assert.doesNotMatch(ruleLine(repo, "R5"), /gate brief/, "anchor: before the dispute R5 says fix and resolve");
  const id = disputed(repo);
  assert.match(ruleLine(repo, "R5"), new RegExp(`${id.replace(".", "\\.")}[^\\n]*\`gate brief reviewer\``), "6.3 C8: R5 sends the waiting dispute to the reviewer");
  const brief = run(repo, "brief", "reviewer");
  assert.equal(brief.status, 0, brief.stderr);
  assert.doesNotMatch(brief.stderr, /^done-gate: /m, brief.stderr);
  const packet = packetOf(brief);
  const section = packet.slice(packet.indexOf("\n## Disputes to answer\n"));
  assert.ok(packet.includes("\n## Disputes to answer\n"), packet.slice(0, 1500));
  assert.match(section, new RegExp(`- ${id.replace(".", "\\.")} — off by one at src/pay\\.ts:1.*disputed: the total already counts the last row`));
});

test("6.3 C4 refused: at a pinned cap of 1, an undisputed open finding is refused, and the refusal names the cap", () => {
  const repo = opened("rcf-63-c4");
  pinCap(repo, 1);
  round(repo, "reviewer", 1, { fix: false });
  const r = run(repo, "brief", "reviewer");
  assert.match(r.stderr, /one round is the cap/, r.stderr);
});

test("6.3 C5 C6: the re-check's withdrawn answer closes the finding and clears R5; a second re-check is refused", () => {
  const repo = opened("rcf-63-c5");
  pinCap(repo, 1);
  round(repo, "reviewer", 1, { fix: false });
  const id = disputed(repo);
  const brief = run(repo, "brief", "reviewer");
  assert.equal(brief.status, 0, brief.stderr);
  const added = answer(repo, brief, "reviewer", `# Review 2\n\n## Act on\n- none\n## Can't verify\n- none\n## Lessons\n- none\n## Dismissed\n- none\n## Disputes\n- ${id} — withdrawn: the total does count the last row\n`, 2);
  assert.equal(added.status, 0, added.stderr);
  const item = ledgerOf(repo).huddles.flatMap((h) => h.actOn).find((a) => a.id === id);
  assert.match(String(item.closed), /withdrawn/);
  assert.equal(ruleLine(repo, "R5"), "", "R5 still waits");
  const again = run(repo, "brief", "reviewer");
  assert.match(again.stderr, /one round is the cap/, `a second re-check was briefed:\n${again.stdout}${again.stderr}`);
});

const clean = (disputes = "") => `# Review\n\n## Act on\n- none\n## Can't verify\n- none\n## Lessons\n- none\n## Dismissed\n- none\n${disputes}`;
const itemOf = (repo, id) => ledgerOf(repo).huddles.flatMap((h) => h.actOn).find((a) => a.id === id);

test("6.3 C9 edge: a dispute the answers round leaves unanswered reads upheld, not answered in its file", () => {
  const repo = opened("rcf-63-c9");
  pinCap(repo, 1);
  round(repo, "reviewer", 1, { fix: false });
  const id = disputed(repo);
  const brief = run(repo, "brief", "reviewer");
  assert.equal(answer(repo, brief, "reviewer", clean(), 2).status, 0);
  const item = itemOf(repo, id);
  assert.equal(item.dispute.verdict, "upheld");
  assert.match(item.dispute.reviewerReason, /not answered in review-2\.md/);
  assert.equal(item.closed, null, "silence keeps the finding open");
});

test("6.3 C10 edge: a dispute citing only a test file, and one on the fix-check round's own finding, are briefed at the cap", () => {
  const onTest = opened("rcf-63-c10a");
  pinCap(onTest, 1);
  const first = run(onTest, "brief", "reviewer");
  answer(onTest, first, "reviewer", `# Review 1\n\n## Act on\n- tests/a.test.ts:1 asserts nothing about the total\n## Dismissed\n- none\n`, 1);
  const id = ledgerOf(onTest).huddles.at(-1).actOn[0].id;
  assert.equal(run(onTest, "huddle", "dispute", id, "the total is asserted in the next test", "--evidence", "tests/a.test.ts:1").status, 0);
  const brief = run(onTest, "brief", "reviewer", "--files", FILE);
  assert.doesNotMatch(brief.stderr, /^done-gate: /m, brief.stderr);
  assert.match(packetOf(brief), new RegExp(`## Disputes to answer[\\s\\S]*${id.replace(".", "\\.")}`));

  const own = opened("rcf-63-c10b");
  pinCap(own, 1);
  round(own, "reviewer", 1);
  const check = run(own, "brief", "reviewer");
  assert.match(packetOf(check), /This is a fix-check/, "anchor: round 2 is the fix-check");
  answer(own, check, "reviewer", `# Review 2\n\n## Act on\n- the fix at src/pay.ts:1 drops the sign\n## Dismissed\n- none\n`, 2);
  const fid = ledgerOf(own).huddles.at(-1).actOn[0].id;
  assert.equal(run(own, "huddle", "dispute", fid, "the sign is kept on the next line", "--evidence", "src/pay.ts:2").status, 0);
  const again = run(own, "brief", "reviewer");
  assert.doesNotMatch(again.stderr, /^done-gate: /m, again.stderr);
  assert.match(packetOf(again), new RegExp(`## Disputes to answer[\\s\\S]*${fid.replace(".", "\\.")}`));
});

test("6.3 C11 boundary: an upheld finding fixed after its answers round still gets its fix-check", () => {
  const repo = opened("rcf-63-c11");
  pinCap(repo, 1);
  round(repo, "reviewer", 1, { fix: false });
  const id = disputed(repo);
  const brief = run(repo, "brief", "reviewer");
  answer(repo, brief, "reviewer", clean(`## Disputes\n- ${id} — upheld: the last row is still skipped\n`), 2);
  assert.equal(itemOf(repo, id).dispute.verdict, "upheld");
  edit(repo, 1);
  assert.equal(run(repo, "huddle", "resolve", id, "--evidence", "src/pay.ts:1", "fixed").status, 0);
  assert.match(ruleLine(repo, "R5"), /gate brief reviewer/, "the fix waits for its review");
  const check = run(repo, "brief", "reviewer");
  assert.doesNotMatch(check.stderr, /^done-gate: /m, check.stderr);
  assert.match(packetOf(check), /This is a fix-check/);
});

// 6.4: one pass plus one re-check, the default for a new run
const bigFile = (repo, n) => {
  const abs = path.join(repo, BIG);
  write(repo, BIG, Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs }, tool_response: {} });
};
const fixBig = (repo, n, line) => {
  const abs = path.join(repo, BIG);
  write(repo, BIG, readFileSync(abs, "utf8").replace(`v${line - 1} = ${line - 1};`, `v${line - 1} = ${line + 1000};`));
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs }, tool_response: {} });
};
const reviewOf = (n, finding) => `# Review ${n}\n\n## Act on\n${finding ? `- ${finding}` : "- none"}\n## Can't verify\n- none\n## Lessons\n- none\n## Dismissed\n- none\n`;

test("6.4 C1 happy: at the default cap of one, a fixed round gets one re-check over the fixed lines, which clears R5, and a further round is refused", () => {
  const repo = opened("rcf-64-c1");
  assert.equal(ledgerOf(repo).policy.reviewRounds, 1, "anchor: a new run pins one round");
  round(repo, "reviewer", 1);
  assert.match(ruleLine(repo, "R5"), /src\/pay\.ts/, "the fixed lines wait for the re-check");
  const check = run(repo, "brief", "reviewer");
  assert.match(packetOf(check), /This is a fix-check/);
  answer(repo, check, "reviewer", reviewOf(2), 2);
  assert.equal(ruleLine(repo, "R5"), "", "the re-check clears R5");
  edit(repo, 7);
  assert.match(run(repo, "brief", "reviewer").stderr, /one round is the cap/, "no second full round");
});

test("6.4 C2 refused: a clean first round refuses a second round", () => {
  const repo = opened("rcf-64-c2");
  round(repo, "reviewer", 1, { finding: false });
  assert.match(run(repo, "brief", "reviewer").stderr, /one round is the cap/);
});

test("6.4 C3 boundary: a 900-line file in slices: the re-check of a fixed line runs as a part and leaves the never-read lines pending and briefable", () => {
  const repo = opened("rcf-64-c3");
  bigFile(repo, 900);
  const first = run(repo, "brief", "reviewer", "--files", `${BIG}:1-400`);
  assert.equal(first.status, 0, first.stderr);
  answer(repo, first, "reviewer", reviewOf(1, `off by one at ${BIG}:30 — wrong`), 1);
  fixBig(repo, 1, 30);
  assert.equal(run(repo, "huddle", "resolve", ledgerOf(repo).huddles.at(-1).actOn[0].id, "--evidence", `${BIG}:30`, "fixed").status, 0);
  const part = run(repo, "brief", "reviewer", "--files", `${BIG}:30-30`);
  assert.doesNotMatch(part.stderr, /^done-gate: /m, part.stderr);
  assert.match(packetOf(part), /This is a fix-check/);
  answer(repo, part, "reviewer", reviewOf(2), 2);
  const r5 = ruleLine(repo, "R5");
  assert.match(r5, /src\/big\.ts:(?:4\d\d|[5-9]\d\d)-/, `the never-read lines are still pending:\n${r5}`);
  const next = /`gate brief reviewer --files ([^`]+)`/.exec(r5)?.[1];
  assert.ok(next, r5);
  assert.doesNotMatch(run(repo, "brief", "reviewer", "--files", next).stderr, /^done-gate: /m, "R5's printed command runs");
});

test("6.4 C6 boundary: a 500-line file in slices: the fixed line alone is refused, naming the never-read lines that fit with it; with them it is briefed", () => {
  const repo = opened("rcf-64-c6");
  bigFile(repo, 500);
  const first = run(repo, "brief", "reviewer", "--files", `${BIG}:1-400`);
  assert.equal(first.status, 0, first.stderr);
  answer(repo, first, "reviewer", reviewOf(1, `off by one at ${BIG}:30 — wrong`), 1);
  fixBig(repo, 1, 30);
  assert.equal(run(repo, "huddle", "resolve", ledgerOf(repo).huddles.at(-1).actOn[0].id, "--evidence", `${BIG}:30`, "fixed").status, 0);
  const alone = run(repo, "brief", "reviewer", "--files", `${BIG}:30-30`);
  assert.match(alone.stderr, /takes all of its unreviewed lines at once: `gate brief reviewer --files ([^`]+)`/, alone.stderr);
  const all = /--files ([^`]+)`/.exec(alone.stderr)[1];
  assert.match(all, /src\/big\.ts:4\d\d-500/, all);
  const both = run(repo, "brief", "reviewer", "--files", all);
  assert.doesNotMatch(both.stderr, /^done-gate: /m, both.stderr);
});
