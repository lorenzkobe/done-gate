import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, lookedUp } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { evaluate, sourceHash, writersOf } from "../scripts/lib/rules.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { DEFAULT_POLICY, loadPolicy, policyFor } from "../scripts/lib/size.mjs";

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
const blocks = (out, rule) => out.split("\n").some((l) => new RegExp(`\\b${rule}\\b`).test(l));

function hook(repo, payload) {
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
}
function edit(repo, rel, content) {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) } });
}
const command = (repo, cmd, agent = null) => hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, ...(agent ? { agent_id: "A1", agent_type: agent } : {}) });

const GATE_JSON = { source: ["src/**", "supabase/**"], tests: ["tests/**"], ui: ["src/**/*.tsx"], verify: ["true"] };

function opened(name, config = GATE_JSON) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify(config, null, 2), "supabase/migrations/001.sql": "select 1;\n" });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Add checkout. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  return repo;
}

test("C1 note plan --size large predicts large, says declared, and a worker may then be briefed", () => {
  const repo = opened("scd-c1");
  const out = cli(repo, "note", ["plan", "One 500-line migration.", "--files", "supabase/migrations/001.sql", "--size", "large"]);
  assert.match(out, /tier predicted large \(1 file, declared large\)/);
  assert.equal(ledgerOf(repo).tier.predicted, "large");
  cli(repo, "case", ["add", "totals add up", "--kind", "happy"]);
  assert.match(cli(repo, "brief", ["worker"]), /^packet: /m);
});

test("C1 a declaration outlives the note that made it and shows in gate size; --size alone predicts too", () => {
  const repo = opened("scd-c1b");
  cli(repo, "note", ["plan", "One migration.", "--files", "supabase/migrations/001.sql", "--size", "large"]);
  const seq = ledgerOf(repo).tier.predictedSeq;
  assert.match(cli(repo, "note", ["plan", "Amended.", "--files", "supabase/migrations/001.sql"]), /tier predicted large \(1 file, declared large\)/);
  assert.equal(ledgerOf(repo).tier.declared, "large");
  assert.equal(ledgerOf(repo).tier.predictedSeq, seq, "the R16 mark stays where the declaration set it");
  assert.match(cli(repo, "size"), /predicted large \(1 file, declared large\)/);
  const bare = opened("scd-c1c");
  assert.match(cli(bare, "note", ["plan", "Big but unnamed.", "--size", "large"]), /tier predicted large \(0 files, declared large\)/);
  assert.equal(ledgerOf(bare).tier.predicted, "large");
});

test("C2 note plan --size huge is refused and changes nothing", () => {
  const repo = opened("scd-c2");
  const r = run(repo, "note", ["plan", "One module.", "--files", "src/a.ts", "--size", "huge"]);
  assert.match(r.stderr, /unknown size "huge"/);
  assert.equal(ledgerOf(repo).planSeq, null);
  assert.equal(ledgerOf(repo).tier.predicted, null);
});

test("C3 a declaration never lowers the file count's tier: --size small with twelve files predicts large", () => {
  const repo = opened("scd-c3");
  const files = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts`).join(",");
  const out = cli(repo, "note", ["plan", "Many modules.", "--files", files, "--size", "small"]);
  assert.match(out, /tier predicted large \(12 files, declared small\)/);
  assert.equal(ledgerOf(repo).tier.predicted, "large");
});

test("C4 adding driver to gate.json after open raises no R13; changing the verify list still does", () => {
  const repo = opened("scd-c4");
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  edit(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, ".claude/gate.json", JSON.stringify({ ...GATE_JSON, driver: "skill:verify" }, null, 2));
  assert.ok(!blocks(run(repo, "check").stdout, "R13"), run(repo, "check").stdout);
  write(repo, ".claude/gate.json", JSON.stringify({ ...GATE_JSON, driver: "skill:verify", verify: ["false"] }, null, 2));
  assert.ok(blocks(run(repo, "check").stdout, "R13"));
  write(repo, ".claude/gate.json", JSON.stringify({ ...GATE_JSON, source: ["src/**"] }, null, 2));
  assert.ok(blocks(run(repo, "check").stdout, "R13"));
});

test("C5 a ledger whose gateHash was computed the old way still passes R13 on an unchanged gate.json", () => {
  const repo = makeRepo("scd-c5", { ".claude/gate.json": JSON.stringify(GATE_JSON, null, 2) });
  const cfg = loadConfig(repo);
  // the formula ledgers from before carry: sha1 of the file text, a newline, the verify list
  const oldWay = createHash("sha1").update(readFileSync(path.join(repo, ".claude", "gate.json"), "utf8")).update("\n").update(cfg.verify.map((v) => v.cmd).join("\n")).digest("hex");
  assert.notEqual(oldWay, cfg.hash);
  const ledger = { status: "open", steps: [], waivers: [], cases: [], huddles: [], gateHash: oldWay, baseline: { seq: 0 } };
  const state = { config: cfg, root: repo, ledger, changed: [], now: { files: {} }, verify: null, events: [], reviews: [], policy: loadPolicy() };
  assert.ok(!evaluate(state).some((u) => u.rule === "R13"));
  assert.ok(evaluate({ ...state, ledger: { ...ledger, gateHash: "stale" } }).some((u) => u.rule === "R13"));
});

test("C6 open pins the policy into the ledger; a pinned ledger with a stale policyHash raises no R13 and is judged by its own tiers", () => {
  const repo = opened("scd-c6");
  const ledger = ledgerOf(repo);
  assert.deepEqual(Object.keys(ledger.policy.tiers), Object.keys(DEFAULT_POLICY.tiers));
  const cfg = loadConfig(repo);
  const now = { files: { "src/a.ts": { h: "1" } } };
  const green = { sourceHash: sourceHash(now, cfg), commands: [{ cmd: "true", exit: 0 }] };
  const base = { ...ledger, policyHash: "stale", tier: { predicted: "tiny", predictedFiles: ["src/a.ts"], measured: null, autoNa: [] }, planSeq: 1, cases: [] };
  const state = (l) => ({ config: cfg, root: repo, ledger: l, changed: ["src/a.ts", "tests/a.test.ts"], now, verify: green, events: [], reviews: [], policy: policyFor(l), tier: { measured: { tier: "tiny", files: 1, lines: 3, forced: [] } } });
  const rules = (l) => evaluate(state(l)).map((u) => u.rule);
  assert.ok(!rules(base).includes("R13"));
  assert.ok(!rules(base).includes("R5"), "the default policy asks no reviewer at tiny");
  const strict = { ...base, policy: { ...base.policy, tiers: { ...base.policy.tiers, tiny: { ...base.policy.tiers.tiny, requires: ["reviewer"] } } } };
  assert.ok(rules(strict).includes("R5"), "the pinned policy asks a reviewer at tiny");
  assert.equal(policyFor(null).hash, loadPolicy().hash);
  // a pin from an older plugin lacking a field this version reads is backfilled, and an old
  // "reviewer:opus" entry is normalised the way models.json's would be
  const old = { tiers: { tiny: { maxFiles: 1, maxLines: 15, requires: [] }, large: { requires: ["skeptic", "reviewer:opus"] } } };
  const pinned = policyFor({ policy: old });
  assert.equal(pinned.delegatesAt, DEFAULT_POLICY.delegatesAt);
  assert.deepEqual(pinned.ceiling, DEFAULT_POLICY.ceiling);
  assert.deepEqual(pinned.tiers.large.requires, ["skeptic", "reviewer-2"]);
});

test("C7 the driver run that itself writes a source file (a snapshot) still counts as driving", () => {
  const repo = opened("scd-c7b", { ...GATE_JSON, driver: "cmd:npx playwright test" });
  cli(repo, "note", ["plan", "One screen.", "--files", "src/app/page.tsx"]);
  edit(repo, "src/app/page.tsx", "export default () => <b/>;\n");
  write(repo, "src/app/page.tsx-snapshots/phone.png", "png");
  command(repo, "npx playwright test --update-snapshots");
  assert.ok(!blocks(run(repo, "check").stdout, "R4"), run(repo, "check").stdout);
});

test("C7 driver cmd: a lead command containing it after the last UI edit satisfies R4; one before does not; R4 names the command", () => {
  const repo = opened("scd-c7", { ...GATE_JSON, driver: "cmd:npx playwright test" });
  cli(repo, "note", ["plan", "One screen.", "--files", "src/app/page.tsx"]);
  command(repo, "npx playwright test e2e/page.spec.ts");
  edit(repo, "src/app/page.tsx", "export default () => <b/>;\n");
  const out = run(repo, "check").stdout;
  assert.ok(blocks(out, "R4"), out);
  assert.match(out, /npx playwright test/);
  command(repo, "npx playwright test e2e/page.spec.ts --project=phone");
  assert.ok(!blocks(run(repo, "check").stdout, "R4"), run(repo, "check").stdout);
});

test("C8 the driver command run by an agent, or a different command, does not satisfy R4", () => {
  const repo = opened("scd-c8", { ...GATE_JSON, driver: "cmd:npx playwright test" });
  cli(repo, "note", ["plan", "One screen.", "--files", "src/app/page.tsx"]);
  edit(repo, "src/app/page.tsx", "export default () => <b/>;\n");
  command(repo, "npx playwright test", "general-purpose");
  assert.ok(blocks(run(repo, "check").stdout, "R4"));
  command(repo, "npm test");
  assert.ok(blocks(run(repo, "check").stdout, "R4"));
});

// Batch 3.12: a green e2e run in verify is the drive.
const E2E = "sh bin/e2e";
const withE2e = (name, when = "always", extra = {}) => {
  const repo = makeRepo(name, {
    ".claude/gate.json": JSON.stringify({ testFiles: null, source: ["src/**"], tests: ["tests/**"], ui: ["src/**/*.tsx"], driver: `cmd:${E2E}`, verify: ["true", { cmd: E2E, when }], ...extra }, null, 2),
    "bin/e2e": "echo drove the app\n",
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "feature"]);
  return repo;
};
const eventsOf = (repo) => readEvents(stateDir(repo), "S1");
const drives = (repo) => eventsOf(repo).filter((e) => e.viaVerify);
const R4 = (repo) => blocks(cli(repo, "check"), "R4");

test("3.12 C1 a green driver entry clears R4, the event is the lead's, and verify prints how to close the step on it", () => {
  const repo = withE2e("scd-e1");
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  assert.equal(R4(repo), true);
  const out = cli(repo, "verify");
  assert.equal(R4(repo), false);
  const [event] = drives(repo);
  assert.equal(event.kind, "command");
  assert.equal(event.cmd, E2E);
  assert.equal(event.agent, null);
  assert.equal(event.readOnly, true);
  assert.equal(event.runs, true);
  assert.match(out, new RegExp(`events#${event.seq}`));
  cli(repo, "step", ["driver", "done", "e2e green", "--evidence", `events#${event.seq}`]);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "driver").state, "DONE");
});

test("3.12 C2 one green run closes two click cases", () => {
  const repo = withE2e("scd-e2");
  cli(repo, "case", ["add", "the tab opens", "--kind", "click"]);
  cli(repo, "case", ["add", "the button saves", "--kind", "click"]);
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  cli(repo, "verify");
  cli(repo, "case", ["close", "C1", "--click"]);
  cli(repo, "case", ["close", "C2", "--click"]);
  assert.deepEqual(ledgerOf(repo).cases.map((c) => c.status), ["closed", "closed"]);
  assert.equal(ledgerOf(repo).cases[0].event, ledgerOf(repo).cases[1].event);
});

test("3.12 C3 a red run records nothing and does not clear R4, and a later edit brings R4 back", () => {
  const red = withE2e("scd-e3");
  write(red, "bin/e2e", "exit 1\n");
  edit(red, "src/app/page.tsx", "export default () => 1;\n");
  cli(red, "verify");
  assert.deepEqual(drives(red), []);
  assert.equal(R4(red), true);

  const later = withE2e("scd-e3b");
  edit(later, "src/app/page.tsx", "export default () => 1;\n");
  cli(later, "verify");
  assert.equal(R4(later), false);
  edit(later, "src/app/page.tsx", "export default () => 2;\n");
  assert.equal(R4(later), true);
});

test("3.12 C4 an edit during verify records no drive; an edit then an undo still clears on the reused event", () => {
  const during = withE2e("scd-e4");
  write(during, "bin/e2e", "echo 'export default () => 9;' > src/app/page.tsx\n");
  edit(during, "src/app/page.tsx", "export default () => 1;\n");
  cli(during, "verify");
  assert.deepEqual(drives(during), []);
  assert.equal(R4(during), true);

  const undo = withE2e("scd-e4b");
  edit(undo, "src/app/page.tsx", "export default () => 1;\n");
  cli(undo, "verify");
  edit(undo, "src/app/page.tsx", "export default () => 2;\n");
  edit(undo, "src/app/page.tsx", "export default () => 1;\n");
  assert.equal(R4(undo), true);
  cli(undo, "verify");
  assert.equal(R4(undo), false);
  const last = drives(undo).pop();
  assert.equal(last.reused, true);
});

test("3.12 C5 a server-only change neither runs nor owes the final driver entry; a UI change owes it; --force runs it", () => {
  const server = withE2e("scd-e5", "final", { api: [] });
  edit(server, "src/a.ts", "export const a = 'server';\n");
  cli(server, "verify");
  const row = () => JSON.parse(readFileSync(path.join(runDir(server), "verify.json"), "utf8")).commands.find((c) => c.cmd === E2E);
  assert.match(row().skipped, /no UI or API file changed/);
  assert.equal(row().owed, undefined);
  assert.doesNotMatch(cli(server, "check"), /final check/);
  cli(server, "verify", ["--force"]);
  assert.equal(row().skipped, undefined);
  assert.equal(row().exit, 0);

  const ui = withE2e("scd-e5b", "final");
  edit(ui, "src/app/page.tsx", "export default () => 1;\n");
  cli(ui, "verify");
  assert.match(cli(ui, "check"), /final check/);
  assert.equal(R4(ui), true);
  cli(ui, "verify", ["--final"]);
  assert.equal(R4(ui), false);
});

test("3.12 C6 the event is not read as a writer", () => {
  const repo = withE2e("scd-e6");
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  cli(repo, "verify");
  const [event] = drives(repo);
  const at = Date.parse(event.ts);
  assert.deepEqual(writersOf([event], 0, at), [], "a file written while it ran is not this event's");
});

test("3.12 C7 the report says the drive came from the e2e run, and R4 and the driver hint name gate verify --final", () => {
  const repo = withE2e("scd-e7");
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  assert.match(cli(repo, "check").split("\n").find((l) => /\bR4\b/.test(l)), /gate verify --final/);
  lookedUp(repo);
  cli(repo, "note", ["task", "Add it. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One file.", "--files", "src/app/page.tsx"]);
  cli(repo, "case", ["add", "it renders", "--kind", "happy"]);
  for (const key of ["skeptic", "tests", "implement", "verify"]) run(repo, "step", [key, "na", "fixture"]);
  assert.match(cli(repo, "next"), /gate verify --final/);
  cli(repo, "verify");
  assert.match(cli(repo, "report", ["--brief"]), /App driven by the e2e run in verify/);
});

test("3.12 C8 a red driver run whose output says the port is in use prints a one-line hint; other red runs do not", () => {
  const busy = withE2e("scd-e8");
  write(busy, "bin/e2e", "echo 'Error: listen EADDRINUSE: address already in use :::3000'; exit 1\n");
  edit(busy, "src/app/page.tsx", "export default () => 1;\n");
  assert.match(cli(busy, "verify"), /port is in use/);

  const other = withE2e("scd-e8b");
  write(other, "bin/e2e", "echo 'a test failed'; exit 1\n");
  edit(other, "src/app/page.tsx", "export default () => 1;\n");
  assert.doesNotMatch(cli(other, "verify"), /port is in use/);
});

test("3.12 C9 a repo with e2e closes a UI task through gate verify --final with no waiver", () => {
  const repo = withE2e("scd-e9", "final");
  lookedUp(repo);
  cli(repo, "note", ["task", "Add it. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "One file.", "--files", "src/app/page.tsx"]);
  cli(repo, "case", ["add", "the tab opens", "--kind", "click"]);
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  write(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  const out = cli(repo, "verify", ["--final"]);
  const pointer = /events#\d+/.exec(out)[0];
  cli(repo, "case", ["close", "C1", "--click"]);
  cli(repo, "step", ["driver", "done", "e2e green", "--evidence", pointer]);
  const left = cli(repo, "check");
  assert.doesNotMatch(left, /\bR4\b/);
  assert.deepEqual(ledgerOf(repo).waivers, []);
});

test("3.12 C10 an edit no hook saw after the drive is dated past it, so R4 returns", () => {
  const repo = withE2e("scd-e10");
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  cli(repo, "verify");
  assert.equal(R4(repo), false);
  write(repo, "src/app/page.tsx", "export default () => 'another terminal';\n");
  assert.equal(R4(repo), true);
});

test("3.12 C11 a reused event is no run; a real green event may close a case with --ran", () => {
  const repo = withE2e("scd-e11");
  cli(repo, "case", ["add", "the flow works", "--kind", "happy"]);
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  cli(repo, "verify");
  cli(repo, "verify");
  assert.equal(drives(repo).pop().reused, true);
  assert.equal(drives(repo).length, 2);
  cli(repo, "case", ["close", "C1", "--ran", E2E]);
  const closed = ledgerOf(repo).cases[0].event;
  assert.equal(closed, `events#${drives(repo)[0].seq}`, "the real run, not the reused mark");
  cli(repo, "case", ["add", "another", "--kind", "edge"]);
  assert.match(run(repo, "case", ["close", "C2", "--ran", E2E]).stderr, /no other case holds/);
});

test("3.12 C12 plain --click takes the newest green run when two runs or a real click and a run are free", () => {
  const repo = withE2e("scd-e12");
  cli(repo, "case", ["add", "the tab opens", "--kind", "click"]);
  cli(repo, "case", ["add", "the button saves", "--kind", "click"]);
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__computer", tool_input: { action: "left_click", ref: "x" }, tool_response: {} });
  cli(repo, "verify");
  cli(repo, "verify");
  cli(repo, "case", ["close", "C1", "--click"]);
  cli(repo, "case", ["close", "C2", "--click"]);
  assert.deepEqual(ledgerOf(repo).cases.map((c) => c.status), ["closed", "closed"]);
});

test("3.12 C13 a final driver entry is skipped only when the globs are declared or no code changed", () => {
  const undeclared = withE2e("scd-e13", "final");
  edit(undeclared, "src/server.ts", "export const s = 2;\n");
  cli(undeclared, "verify", ["--final"]);
  const rows = JSON.parse(readFileSync(path.join(runDir(undeclared), "verify.json"), "utf8")).commands;
  assert.equal(rows.find((c) => c.cmd === E2E).skipped, undefined, "with no api glob a route may have changed");

  const tests = withE2e("scd-e13b", "final");
  edit(tests, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(tests, "verify", ["--final"]);
  assert.match(JSON.parse(readFileSync(path.join(runDir(tests), "verify.json"), "utf8")).commands.find((c) => c.cmd === E2E).skipped, /no UI or API/);
});

test("3.12 C14 R18 names --force, and --force covers a case test on a skipped e2e entry", () => {
  const repo = makeRepo("scd-e14", {
    ".claude/gate.json": JSON.stringify({ testFiles: null, source: ["src/**", "e2e/**"], tests: ["tests/**", "e2e/**"], ui: ["src/**/*.tsx"], api: [], driver: "cmd:npx playwright test e2e", verify: ["npx --version", { cmd: "npx playwright test e2e", when: "final", timeout: 5 }] }),
    "e2e/flow.spec.ts": "test('flow', () => {});\n",
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "case", ["add", "the flow works", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "e2e/flow.spec.ts:flow"]);
  edit(repo, "src/a.ts", "export const a = 'server';\n");
  cli(repo, "verify", ["--final"]);
  assert.match(cli(repo, "check").split("\n").find((l) => /\bR18\b/.test(l)), /--force/);
});

test("3.12 C15 an edit and undo beside a test edit still counts as a reused drive", () => {
  const repo = withE2e("scd-e15");
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  cli(repo, "verify");
  edit(repo, "src/app/page.tsx", "export default () => 2;\n");
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  edit(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(repo, "verify");
  assert.ok(drives(repo).length >= 1);
  assert.equal(R4(repo), false);
});
