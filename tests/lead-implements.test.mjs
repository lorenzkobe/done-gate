import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, lookedUp, planChecked } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadPolicy } from "../scripts/lib/size.mjs";
import { nextHint } from "../scripts/lib/next.mjs";
import { scratchOnly } from "../scripts/lib/guard.mjs";

// lead-implements: the lead edits source at small and standard; the worker hand-off, the
// fence and R16 apply at tier large only. Cases C1–C8 of the task's case table.

const MODELS = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
const STANDARD_FILES = Array.from({ length: MODELS.policy.tiers.small.maxFiles + 1 }, (_, i) => `src/f${i}.ts`);
const LARGE_FILES = Array.from({ length: MODELS.policy.tiers.standard.maxFiles + 1 }, (_, i) => `src/f${i}.ts`);

const envFor = (repo, session = "S1") => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session });
const REFUSAL = /^done-gate: /m;

function run(repo, verb, args = []) {
  return spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  return r.stderr;
}
function hook(repo, verb, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, verb], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null;
}
// null when allowed, else the deny reason
function fence(repo, tool, file, extra = {}) {
  const out = hook(repo, "fence", { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path.join(repo, file) }, ...extra });
  return out ? out.hookSpecificOutput.permissionDecisionReason : null;
}
const leadEdit = (repo, file) => hook(repo, "log", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, file) }, tool_output: "" });

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));
const r16 = (repo) => cli(repo, "check").stdout.split("\n").filter((l) => /\bR16\b/.test(l));

function opened(name, files) {
  const repo = makeRepo(name, Object.fromEntries(files.map((f) => [f, "export const x = 1;\n"])));
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  lookedUp(repo);
  cli(repo, "note", ["context", "Traced: src/a.ts:1 · Related: none: `grep -rn a src` · Research: none needed: a test fixture"]);
  cli(repo, "note", ["plan", "The plan.", "--files", files.join(",")]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  // these tests are about who edits once code may be edited, so the plan check is run first
  if (ledgerOf(repo).checkHold) planChecked(repo);
  return repo;
}

// ---------------------------------------------------------------------------
// C1 happy — standard: the lead edits
// ---------------------------------------------------------------------------

test("C1 happy: at predicted standard the lead's Edit/Write on source and tests is allowed and R16 stays silent", () => {
  const repo = opened("li-c1-standard", STANDARD_FILES);
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  assert.equal(fence(repo, "Edit", "src/f0.ts"), null, "Edit on source at standard");
  assert.equal(fence(repo, "Write", "tests/a.test.ts"), null, "Write on tests at standard");
  write(repo, "src/f0.ts", "export const x = 2;\n");
  leadEdit(repo, "src/f0.ts");
  assert.deepEqual(r16(repo), [], "R16 at standard");
  assert.equal(ledgerOf(repo).tier.predictedSeq, null, "no delegation mark below large");
});

// ---------------------------------------------------------------------------
// C2 happy — large: still fenced and still R16
// ---------------------------------------------------------------------------

test("C2 happy: at predicted large the lead edits source by tool or shell and no rule asks for a worker", () => {
  const repo = opened("li-c2-large", LARGE_FILES);
  assert.equal(ledgerOf(repo).tier.predicted, "large");
  assert.equal(fence(repo, "Edit", "src/f0.ts"), null);
  write(repo, "src/f0.ts", "export const x = 2;\n");
  leadEdit(repo, "src/f0.ts");
  write(repo, "src/f1.ts", "export const x = 3;\n");
  hook(repo, "log", { hook_event_name: "PostToolUse", tool_response: { exit_code: 0 }, tool_name: "Bash", tool_input: { command: "sed -i '' 's/1/3/' src/f1.ts" } });
  assert.deepEqual(r16(repo), []);
  assert.doesNotMatch(cli(repo, "check").stdout, /worker/);
  assert.equal(typeof ledgerOf(repo).tier.predictedSeq, "number", "the mark is stamped at large");
});

// ---------------------------------------------------------------------------
// C3 boundary — growth: only a measured large fences
// ---------------------------------------------------------------------------

test("C3 boundary: a small task that grows to a measured large still owes QA and the second reviewer, with no fence and nothing printed at the crossing", () => {
  const repo = opened("li-c3-large", ["src/a.ts"]);
  for (const f of LARGE_FILES) write(repo, f, "export const y = 2;\n");
  const crossing = hook(repo, "log", { hook_event_name: "PostToolUse", tool_response: {}, tool_name: "Edit", tool_input: { file_path: path.join(repo, LARGE_FILES[0]) } });
  assert.equal(crossing?.hookSpecificOutput, undefined, JSON.stringify(crossing));
  const out = cli(repo, "check").stdout;
  assert.equal(ledgerOf(repo).tier.measured.tier, "large");
  assert.equal(fence(repo, "Edit", "src/a.ts"), null);
  assert.match(out, /\bR7\b[^\n]*qa/i, out);
  assert.match(out, /\bR9\b/, out);
  assert.match(cli(repo, "report", ["--brief"]).stdout, /grew to large mid-task/);
});

// ---------------------------------------------------------------------------
// C4 refused — gate brief worker below large
// ---------------------------------------------------------------------------


test("C9 edge: mv and rsync are never scratch-only, since they can remove the source they read", () => {
  for (const cmd of ["mv src/a.ts /tmp/x/", "rsync --remove-source-files src/ /tmp/x/"]) assert.equal(scratchOnly(cmd), false, cmd);
  assert.equal(scratchOnly("S=/tmp/x; mkdir -p $S && cp src/a.ts $S/"), true);
});

test("C7 happy: at size large a general-purpose implementer and the lead edit source; a reviewer stays fenced", () => {
  const repo = opened("li-credit-fence", LARGE_FILES);
  assert.equal(fence(repo, "Edit", "src/f0.ts", { agent_id: "G1", agent_type: "general-purpose" }), null);
  assert.equal(fence(repo, "Edit", "src/f0.ts"), null, "the lead edits");
  assert.ok(fence(repo, "Edit", "src/f0.ts", { agent_id: "R1", agent_type: "done-gate:reviewer" }), "a reviewer is fenced");
});

test("C4 happy: gate brief worker writes a packet at any size; gate brief qa stays refused below large", () => {
  for (const [name, files, tier] of [["li-c4-tiny", ["src/a.ts"], "tiny"], ["li-c4-standard", STANDARD_FILES, "standard"], ["li-c4-large", LARGE_FILES, "large"]]) {
    const repo = opened(name, files);
    assert.equal(ledgerOf(repo).tier.predicted, tier, name);
    assert.match(cli(repo, "brief", ["worker"]).stdout, /packet: .*brief-worker-1\.md/, name);
  }
  const standard = opened("li-c4-qa", STANDARD_FILES);
  const err = refused(standard, "brief", ["qa"]);
  assert.match(err, /write the tests yourself/i);
  assert.match(err, /\blarge\b/);
  assert.match(cli(opened("li-c4-qa-large", LARGE_FILES), "brief", ["qa"]).stdout, /packet: .*brief-qa-1\.md/);
});

test("below large a worker takes a piece, answers a finding, and a path outside the repo stays refused", () => {
  const repo = opened("li-worker-flow", STANDARD_FILES);
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  assert.ok(refused(repo, "brief", ["worker", "--files", "../elsewhere.ts"]).includes("--files"));
  const review = `# Review 1\n\n## Act on\n- f0 drops the null case — ${STANDARD_FILES[0]}:1\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: x exit 0, 1 passed (unverified)\n- cases: 1/1 tests match their case\n`;
  writeFileSync(path.join(runDir(repo), "review-1.md"), review);
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const packet = cli(repo, "brief", ["worker", "--files", STANDARD_FILES[0]]).stdout;
  const text = readFileSync(/packet: (\S+)/.exec(packet)[1], "utf8");
  assert.match(text, /## Tests so far/);
  assert.doesNotMatch(text, /QA wrote/);
  // the plan check is H1, so the reviewer's finding is H2.1
  assert.match(text, /H2\.1/);
  writeFileSync(path.join(runDir(repo), "worker-1.md"), `# Worker 1\n\n## Replies\n- H2.1 — fixed: doc\n`);
  cli(repo, "huddle", ["reply", "--file", "worker-1.md"]);
  assert.ok(ledgerOf(repo).huddles.find((h) => h.role === "reviewer").actOn[0].closed, "the worker's answer closes the finding");
});

// ---------------------------------------------------------------------------
// C5 happy — the policy knob
// ---------------------------------------------------------------------------

test("C5 happy: models.json carries delegatesAt: large, loadPolicy exposes it, and a models.json without it defaults to large", () => {
  assert.equal(MODELS.policy.delegatesAt, "large");
  assert.equal(loadPolicy().delegatesAt, "large");
  const repo = makeRepo("li-c5-policy", { "models.json": JSON.stringify({ policy: { tiers: MODELS.policy.tiers } }) });
  assert.equal(loadPolicy(path.join(repo, "models.json")).delegatesAt, "large");
  const custom = makeRepo("li-c5-custom", { "models.json": JSON.stringify({ policy: { delegatesAt: "standard" } }) });
  assert.equal(loadPolicy(path.join(custom, "models.json")).delegatesAt, "standard", "a repo may still delegate at standard");
});

// ---------------------------------------------------------------------------
// C6 idempotent — large is unchanged
// ---------------------------------------------------------------------------

test("C6 idempotent: at large a worker edits source and tests, and another role does not", () => {
  const repo = opened("li-c6-large", LARGE_FILES);
  const worker = { agent_id: "W1", agent_type: "done-gate:worker" };
  assert.equal(fence(repo, "Edit", "src/f0.ts", worker), null, "worker edits source");
  assert.equal(fence(repo, "Write", "tests/a.test.ts", worker), null, "worker edits tests");
  assert.ok(fence(repo, "Edit", "src/f0.ts", { agent_id: "R1", agent_type: "done-gate:reviewer" }), "a reviewer never edits source");
});

// ---------------------------------------------------------------------------
// C7 happy — the review hint
// ---------------------------------------------------------------------------

test("C7 happy: the review hint tells the lead to fix and resolve what it edited and to brief the worker for a worker's piece", () => {
  const steps = [{ n: 1, key: "review", text: "review", state: null, note: null, evidence: null, seq: 1 }];
  const h = nextHint({ status: "open", playbook: "feature", taskSeq: 1, planSeq: 2, cases: [{ id: "C1", status: "closed" }], steps, huddles: [], waivers: [] });
  assert.match(h, /fix the items yourself[^;]*gate huddle resolve/i, h);
  assert.match(h, /a worker's piece[^;]*gate brief worker/i, h);
  assert.match(h, /gate huddle reply/, h);
  assert.doesNotMatch(h, /at size large `gate brief worker`|below large/, h);
});

// ---------------------------------------------------------------------------
// C8 happy — the prose
// ---------------------------------------------------------------------------

test("C8 happy: SKILL.md, hooks/session-start.md, README and agents/worker.md say the lead edits at any size and workers are for independent pieces; SKILL.md stays under 4096 bytes and lists no R16", () => {
  const read = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");
  const flat = (rel) => read(rel).replace(/\s+/g, " ");
  const skill = read("skills/gate/SKILL.md");
  assert.ok(Buffer.byteLength(skill) < 4096, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  assert.doesNotMatch(skill, /\bR16\b/, "SKILL: the rule is gone");
  for (const [rel, text] of [["skills/gate/SKILL.md", flat("skills/gate/SKILL.md")], ["hooks/session-start.md", flat("hooks/session-start.md")], ["README.md", flat("README.md")]]) {
    assert.match(text, /independent/i, `${rel}: workers are for independent pieces`);
    assert.match(text, /worker/i, rel);
    assert.doesNotMatch(text, /never edits? source|lead does not edit|a worker per piece/i, `${rel}: old wording`);
  }
  assert.match(flat("hooks/session-start.md"), /lead edits (source )?(itself )?at any size/i);
  assert.match(flat("README.md"), /The lead may edit at any size/);
  const readme = read("README.md");
  assert.doesNotMatch(readme, /\bR16\b/, "README: the rule is gone");
  assert.doesNotMatch(readme, /delegates at size standard and up/i, "README: old wording");
  assert.doesNotMatch(readme, /Outgrowing the size is said at the edit/, "README: the crossing note is gone");
  const worker = read("agents/worker.md");
  assert.match(worker, /independent/i, "worker.md description");
  assert.doesNotMatch(worker, /size large|standard and above/i, "worker.md old wording");
});

test("gate waive delegate and gate waive R16 are refused, and worker gets no pointer", () => {
  const repo = opened("li-no-delegate", LARGE_FILES);
  for (const key of ["delegate", "R16", "worker"]) assert.match(refused(repo, "waive", [key, "x"]), /unknown waiver key|no waiver/, key);
  assert.doesNotMatch(refused(repo, "waive", ["worker", "x"]), /delegate/);
  assert.deepEqual(ledgerOf(repo).waivers, []);
});

test("an old ledger with a delegate waiver and a delegate deny event reads and reports clean", () => {
  const repo = opened("li-old-delegate", LARGE_FILES);
  const dir = runDir(repo);
  const ledger = JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8"));
  ledger.waivers.push({ key: "delegate", reason: "user said so", seq: 1 });
  writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(ledger));
  appendFileSync(path.join(stateDir(repo), "sessions", "S1", "events.jsonl"), `${JSON.stringify({ seq: Date.now() * 1000, ts: new Date().toISOString(), session: "S1", kind: "deny", delegate: true, tool: "Edit", path: "src/f0.ts", reason: "old" })}\n`);
  assert.doesNotMatch(cli(repo, "check").stdout, /GATE ERROR|R16/);
  const report = cli(repo, "report").stdout;
  assert.match(report, /delegate/, "the old waiver still shows");
  assert.match(report, /1 lead edit\(s\) fenced off/, "the old deny still reads as a hand-off");
  assert.match(report, /blocked writes to gate files 0/);
});

test("a large run whose lead fixed the findings itself closes with no worker and no waiver", () => {
  const repo = makeRepo("li-large-closes", {
    ...Object.fromEntries(LARGE_FILES.map((f) => [f, "export const x = 1;\n"])),
    "tests/a.test.ts": "x\n",
    ".claude/gate.json": JSON.stringify({ testFiles: null, tests: ["tests/**"], verify: [{ cmd: "npm test" }] }),
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["big", "feature"]);
  cli(repo, "note", ["task", "A big change. [inferred]"]);
  lookedUp(repo);
  cli(repo, "note", ["context", "Traced: src/f0.ts:1 · Related: none: `grep -rn x src` · Research: none needed: a test fixture"]);
  cli(repo, "note", ["plan", "Many files.", "--files", LARGE_FILES.join(",")]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  const helper = (role, n, body) => {
    const brief = run(repo, "brief", [role]);
    assert.equal(brief.status, 0, brief.stderr);
    const file = /Your file is .*\/([\w-]+\.md)/.exec(brief.stdout)?.[1];
    const agent = { agent_id: `${role}-${n}`, agent_type: `done-gate:${role}` };
    hook(repo, "log", { hook_event_name: "SubagentStart", ...agent });
    lookedUp(repo, { agent: agent.agent_id, role });
    if (file) {
      writeFileSync(path.join(runDir(repo), file), body);
      hook(repo, "log", { hook_event_name: "PostToolUse", tool_response: {}, tool_name: "Write", tool_input: { file_path: path.join(runDir(repo), file) }, ...agent });
    }
    hook(repo, "log", { hook_event_name: "SubagentStop", ...agent });
    return file;
  };
  const clean = "# Skeptic\n\n## Act on\n- none\n## Consider\n- none\n## Noted\n- none\n## The one question\n- none\n";
  const round = (act) => `# Review\n\n## Act on\n${act}\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: x exit 0, 1 passed (unverified)\n- cases: 1/1 tests match their case\n`;
  cli(repo, "huddle", ["add", "skeptic", "--file", helper("skeptic", 1, clean)]);
  cli(repo, "step", ["skeptic", "done", "no findings", "--evidence", "skeptic-1.md"]);
  helper("qa", 1, "");
  cli(repo, "huddle", ["add", "qa", "--summary", "tests written"]);
  for (const f of LARGE_FILES) {
    write(repo, f, "export const x = 2;\n");
    leadEdit(repo, f);
  }
  write(repo, "tests/a.test.ts", "y\n");
  leadEdit(repo, "tests/a.test.ts");
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:it works"]);
  cli(repo, "step", ["tests", "done", "written", "--evidence", "tests/a.test.ts"]);
  cli(repo, "step", ["implement", "done", "edited by the lead", "--evidence", "src/f0.ts"]);
  cli(repo, "verify", []);
  for (const key of ["driver", "schema"]) cli(repo, "step", [key, "na", "no such surface"]);
  const first = helper("reviewer", 1, round("- off by one at src/f0.ts:1 — the total skips the last row"));
  cli(repo, "huddle", ["add", "reviewer", "--file", first]);
  cli(repo, "huddle", ["add", "reviewer-2", "--file", helper("reviewer-2", 1, round("- none"))]);
  write(repo, "src/f0.ts", "export const x = 3;\n");
  leadEdit(repo, "src/f0.ts");
  cli(repo, "huddle", ["resolve", ledgerOf(repo).huddles.find((h) => h.file === first).actOn[0].id, "--evidence", "doc"]);
  cli(repo, "verify", []);
  for (const [role, n] of [["reviewer", 2], ["reviewer-2", 2]]) cli(repo, "huddle", ["add", role, "--file", helper(role, n, round("- none"))]);
  cli(repo, "step", ["review", "done", "clean", "--evidence", "review-2.md"]);
  const dir = runDir(repo);
  const closed = run(repo, "close", []);
  assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}\n${cli(repo, "check").stdout}`);
  assert.equal(loadLedger(dir).status, "closed");
  assert.deepEqual(loadLedger(dir).waivers, []);
  assert.match(cli(repo, "report").stdout, /helpers: spawned 4 of 4 required/);
});
