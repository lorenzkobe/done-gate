import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { evaluate, sourceHash } from "../scripts/lib/rules.mjs";
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
  cli(repo, "note", ["task", "Add checkout. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: none\nResearch: none needed: local"]);
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
