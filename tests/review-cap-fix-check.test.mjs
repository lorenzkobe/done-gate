import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, lookedUp, write } from "./helpers.mjs";
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
  for (const n of [1, 2]) round(repo, "reviewer-2", n);
  round(repo, "reviewer-2", 3, { fix: false });
  assert.ok(capped(run(repo, "brief", "reviewer-2")));
  // what R9 prints can be run: resolve the finding, not brief a round the cap refuses
  assert.match(ruleLine(repo, "R9"), /Act-on item\(s\) still open: H\d+\.1.*gate huddle resolve/);
  assert.doesNotMatch(ruleLine(repo, "R9"), /gate brief/);
});

test("C4 edge: round 3 clean: no R9 and round 4 is refused", () => {
  const repo = opened("rcf-c4");
  for (const n of [1, 2]) round(repo, "reviewer-2", n);
  round(repo, "reviewer-2", 3, { finding: false });
  assert.equal(ruleLine(repo, "R9"), "");
  assert.ok(capped(run(repo, "brief", "reviewer-2")));
});

test("C5 happy: the reviewer follows the same rule", () => {
  const repo = opened("rcf-c5");
  for (const n of [1, 2, 3]) round(repo, "reviewer", n);
  assert.match(ruleLine(repo, "R5"), /src\/pay\.ts/);
  assert.equal(run(repo, "brief", "reviewer").status, 0);
});

test("C6 refused: a fix-check that leaves out part of a file's unreviewed lines is refused and names them all", () => {
  const repo = opened("rcf-c6");
  for (const n of [1, 2, 3]) round(repo, "reviewer-2", n);
  edit(repo, 20);
  const entries = /--files (\S+?)`/.exec(ruleLine(repo, "R9"))[1].split(",");
  assert.ok(entries.length > 1, entries.join(","));
  const part = run(repo, "brief", "reviewer-2", "--files", entries[0]);
  assert.notEqual(part.status, 0);
  assert.ok(part.stderr.includes(`--files ${entries.join(",")}`), part.stderr);
  assert.equal(run(repo, "brief", "reviewer-2", "--files", entries.join(",")).status, 0);
});
