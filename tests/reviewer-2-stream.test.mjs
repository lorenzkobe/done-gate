import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { pointerResolver } from "../scripts/lib/rules.mjs";

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
  return r;
}
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const runRel = (repo) => path.relative(repo, runDir(repo));
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));

function hook(repo, payload) {
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
}
function shellWrite(repo, rel, content) {
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `cat > ${rel}` }, tool_output: "" });
  write(repo, rel, content);
}
const stopped = (repo, role) => hook(repo, { hook_event_name: "SubagentStop", agent_id: `A-${role}`, agent_type: `done-gate:${role}` });

const FIND = (n) => `finding ${n} — src/a.ts:1 — the join runs on an empty array — []`;
const reviewFile = (n, actOn) => `# Review ${n} — x\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: npm test exit 0\n`;
const helperFile = (repo, name, body) => writeFileSync(path.join(runDir(repo), name), body);

function opened(name, files = {}) {
  const repo = makeRepo(name, files);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  shellWrite(repo, "src/a.ts", "export const a = 2;\nexport const venue = null;\n");
  return repo;
}
const packet = (repo, role) => {
  const r = cli(repo, "brief", [role]);
  const p = r.stdout.split("\n").find((l) => l.startsWith("packet: ")).slice(8);
  return { path: p, text: readFileSync(p, "utf8"), stdout: r.stdout };
};

test("C1 brief reviewer then brief reviewer-2 with no file written name review-1.md and review2-1.md", () => {
  const repo = opened("r2s-c1");
  const first = packet(repo, "reviewer");
  assert.match(first.stdout, /Your file is .*review-1\.md/);
  const second = packet(repo, "reviewer-2");
  assert.match(second.stdout, /Your file is .*review2-1\.md/);
  assert.match(second.text, /## Write your findings to\n\n.*review2-1\.md/);
  assert.match(second.text, /## You may write\n\nonly .*review2-1\.md/);
});

test("C2 huddle add reviewer-2 takes review2-<n>.md, refuses a skeptic file, still takes review-<n>.md from a ledger from before", () => {
  const repo = opened("r2s-c2");
  helperFile(repo, "review2-1.md", reviewFile(1, [FIND(1)]));
  cli(repo, "huddle", ["add", "reviewer-2", "--file", "review2-1.md"]);
  const h = ledgerOf(repo).huddles.find((x) => x.role === "reviewer-2");
  assert.equal(h.file, "review2-1.md");
  assert.equal(h.actOn.length, 1);
  assert.match(run(repo, "huddle", ["add", "reviewer-2", "--file", "skeptic-1.md"]).stderr, REFUSAL);
  helperFile(repo, "review-2.md", reviewFile(2, []));
  cli(repo, "huddle", ["add", "reviewer-2", "--file", "review-2.md"]);
  assert.equal(ledgerOf(repo).huddles.filter((x) => x.role === "reviewer-2").length, 2);
});

test("C2 once a reviewer-2 was briefed on the new stream, review-<n>.md is refused for it, and a file recorded under one role is refused for another", () => {
  const repo = opened("r2s-c2b");
  helperFile(repo, "review-1.md", reviewFile(1, [FIND(1)]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  packet(repo, "reviewer-2");
  assert.match(run(repo, "huddle", ["add", "reviewer-2", "--file", "review-1.md"]).stderr, /own review2-<n>\.md/);
  helperFile(repo, "review-2.md", reviewFile(2, []));
  assert.match(run(repo, "huddle", ["add", "reviewer-2", "--file", "review-2.md"]).stderr, /own review2-<n>\.md/);
  helperFile(repo, "review2-1.md", reviewFile(1, []));
  cli(repo, "huddle", ["add", "reviewer-2", "--file", "review2-1.md"]);
  assert.equal(ledgerOf(repo).huddles.filter((x) => x.role === "reviewer-2").length, 1);
});

test("C3 the fence: each reviewer writes only its own stream, the lead neither, and a shell write to review2 is denied", () => {
  const repo = makeRepo("r2s-c3");
  const cfg = loadConfig(repo);
  const current = ".claude/gate/runs/2026-09-27-x";
  const input = (tool, rel, agent) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path.join(repo, rel) }, cwd: repo, session_id: "S1", ...(agent ? { agent_id: "A1", agent_type: `done-gate:${agent}` } : {}) });
  const deny = (tool, rel, agent) => decide(input(tool, rel, agent), repo, cfg, current, null).deny;
  assert.equal(deny("Write", `${current}/review2-1.md`, "reviewer-2"), false);
  assert.equal(deny("Write", `${current}/review-1.md`, "reviewer-2"), true);
  assert.equal(deny("Write", `${current}/review-1.md`, "reviewer"), false);
  assert.equal(deny("Write", `${current}/review2-1.md`, "reviewer"), true);
  assert.equal(deny("Write", `${current}/review2-1.md`, null), true);
  assert.equal(deny("Write", `${current}/review2-1.md`, "worker"), true);
  const bash = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `echo x > ${current}/review2-1.md` }, cwd: repo, session_id: "S1" };
  assert.equal(decide(bash, repo, cfg, current, null).deny, true);
});

test("C4 draft debts are per role: both packets out, the reviewer owes review-1.md and reviewer-2 owes review2-1.md, independently", () => {
  const repo = opened("r2s-c4");
  packet(repo, "reviewer");
  packet(repo, "reviewer-2");
  const cfg = loadConfig(repo);
  const current = runRel(repo);
  const ledger = ledgerOf(repo);
  const call = (tool, agent, rel) => decide({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path.join(repo, rel) }, cwd: repo, session_id: "S1", agent_id: "A1", agent_type: `done-gate:${agent}` }, repo, cfg, current, ledger);
  assert.match(call("Read", "reviewer", "src/a.ts").reason, /review-1\.md/);
  assert.match(call("Read", "reviewer-2", "src/a.ts").reason, /review2-1\.md/);
  assert.equal(call("Write", "reviewer-2", `${current}/review2-1.md`).deny, false);
  helperFile(repo, "review2-1.md", "# Review 1\n\n## Act on\n- unverified\n");
  assert.equal(call("Read", "reviewer-2", "src/a.ts").deny, false);
  assert.match(call("Read", "reviewer", "src/a.ts").reason, /review-1\.md/);
  assert.equal(call("Write", "reviewer", `${current}/review-1.md`).deny, false);
});

test("C4b two reviewer packets out at once: each reviewer owes a number, and the one that wrote its draft is free while the other still owes its own", () => {
  const repo = opened("r2s-c4b");
  packet(repo, "reviewer");
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "done-gate:reviewer" });
  assert.match(packet(repo, "reviewer").stdout, /review-2\.md/, "the second packet takes the next number while the first reviewer runs");
  const cfg = loadConfig(repo);
  const current = runRel(repo);
  const ledger = ledgerOf(repo);
  const where = { stateDir: path.join(repo, ".claude", "gate"), session: "S1" };
  const call = (tool, agent, rel) => decide({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path.join(repo, rel) }, cwd: repo, session_id: "S1", agent_id: agent, agent_type: "done-gate:reviewer" }, repo, cfg, current, ledger, where);
  assert.match(call("Read", "A1", "src/a.ts").reason, /review-1\.md or .*review-2\.md/);
  assert.equal(call("Write", "A2", `${current}/review-2.md`).deny, false);
  helperFile(repo, "review-1.md", "# Review 1\n\n## Act on\n- unverified\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(repo, current, "review-1.md") }, agent_id: "A1", agent_type: "done-gate:reviewer" });
  assert.equal(call("Read", "A1", "src/a.ts").deny, false, "A1 wrote its draft and may investigate");
  const still = call("Read", "A2", "src/a.ts").reason;
  assert.match(still, /review-2\.md/);
  assert.doesNotMatch(still, /review-1\.md/, "A2 is not sent to A1's file");
});

test("C5 an unrecorded review2-1.md raises R15 naming reviewer-2, and the file resolves as evidence", () => {
  const repo = opened("r2s-c5");
  helperFile(repo, "review2-1.md", reviewFile(1, [FIND(1)]));
  const out = run(repo, "check").stdout;
  assert.match(out, /R15.*review2-1\.md.*gate huddle add reviewer-2 --file review2-1\.md/);
  assert.equal(pointerResolver({ reviews: ["review2-1.md"] })("review2-1.md"), true);
  assert.equal(pointerResolver({ reviews: [] })("review2-1.md"), false);
});

test("C6 three reviewer rounds are still the cap; review2 files do not count toward it", () => {
  const repo = opened("r2s-c6");
  for (const n of [1, 2]) {
    packet(repo, "reviewer");
    helperFile(repo, `review-${n}.md`, reviewFile(n, [FIND(n)]));
    cli(repo, "huddle", ["add", "reviewer", "--file", `review-${n}.md`]);
  }
  for (const n of [1, 2, 3]) helperFile(repo, `review2-${n}.md`, reviewFile(n, [FIND(n)]));
  // a ledger from before recorded a reviewer-2 round on review-<n>.md; it is not the reviewer's
  helperFile(repo, "review-9.md", reviewFile(9, []));
  cli(repo, "huddle", ["add", "reviewer-2", "--file", "review-9.md"]);
  const third = packet(repo, "reviewer");
  const own = /Your file is .*\/(review-\d+\.md)/.exec(third.stdout)[1];
  assert.equal(third.path.split("/").pop(), `brief-reviewer-${/\d+/.exec(own)[0]}.md`, "packet and file numbers agree");
  helperFile(repo, own, reviewFile(3, [FIND(3)]));
  cli(repo, "huddle", ["add", "reviewer", "--file", own]);
  assert.match(run(repo, "brief", ["reviewer"]).stderr, /three rounds is the cap/);
});

test("C7 the reviewer-2 packet embeds the newest finished review-<n>.md, never a draft", () => {
  const repo = opened("r2s-c7");
  helperFile(repo, "review-1.md", reviewFile(1, [FIND(1)]));
  helperFile(repo, "review-2.md", reviewFile(2, [FIND(2)]));
  helperFile(repo, "review-3.md", "# Review 3 — x\n\n## Act on\n- unverified\n## Consider\n- unverified\n");
  const p = packet(repo, "reviewer-2");
  assert.match(p.text, /## Review 2\n/);
  assert.ok(p.text.includes(FIND(2)));
  assert.ok(!p.text.includes(FIND(1)));
  assert.ok(!p.text.includes("- unverified"));
});

test("C7 with only a draft on the reviewer's side the packet says so", () => {
  const repo = opened("r2s-c7b");
  helperFile(repo, "review-1.md", "# Review 1 — x\n\n## Act on\n- unverified\n");
  assert.match(packet(repo, "reviewer-2").text, /no finished review-<n>\.md yet/);
});

test("C4 review numbers past 2 are read from the end of the name: after review2-1..3 the next is review2-4", () => {
  const repo = opened("r2s-c4b");
  for (const n of [1, 2, 3]) helperFile(repo, `review2-${n}.md`, reviewFile(n, [FIND(n)]));
  for (const n of [1, 2, 3, 4]) helperFile(repo, `brief-reviewer-2-${n}.md`, "# Brief\n");
  const cfg = loadConfig(repo);
  const owed = decide({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(repo, "src/a.ts") }, cwd: repo, session_id: "S1", agent_id: "A1", agent_type: "done-gate:reviewer-2" }, repo, cfg, runRel(repo), ledgerOf(repo));
  assert.match(owed.reason, /review2-4\.md/);
});

test("C8 R9 is met by a reviewer-2 huddle on review2-1.md after its stop, with no open item", () => {
  const repo = opened("r2s-c8", { ".claude/gate.json": JSON.stringify({ highRisk: ["src/pay/**"], tests: ["tests/**"] }) });
  shellWrite(repo, "src/pay/x.ts", "export const pay = 1;\n");
  assert.match(run(repo, "check").stdout, /R9/);
  packet(repo, "reviewer-2");
  helperFile(repo, "review2-1.md", reviewFile(1, []));
  cli(repo, "huddle", ["add", "reviewer-2", "--file", "review2-1.md"]);
  stopped(repo, "reviewer-2");
  assert.ok(existsSync(path.join(runDir(repo), "review2-1.md")));
  assert.doesNotMatch(run(repo, "check").stdout, /R9/);
});
