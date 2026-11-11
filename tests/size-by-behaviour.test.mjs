// Size by behaviour: on the plan note the lead states a risk (`--risk`, sized up as a listed
// high-risk path is) or that the change is mechanical (`--mechanical`, a lead's call that sizes it
// down to one reviewer, who checks the claim).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gate, lookedUp, makeRepo, readyToEdit, write } from "./helpers.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { effectiveTier, loadPolicy, tierOf } from "../scripts/lib/size.mjs";

const envFor = (repo) => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
};
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const stepState = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key)?.state ?? null;
const ruleLines = (repo, rule) => cli(repo, "check").split("\n").filter((l) => new RegExp(`\\b${rule}\\b`).test(l)).join("\n");
const hook = (repo, payload) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
function edit(repo, rel, content) {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_response: {} });
}

const CONFIG = { source: ["src/**", "tests/**", "db/**"], tests: ["tests/**"], ui: ["src/app/**"], schema: ["db/**"], highRisk: ["src/pay/**"], verify: ["true"], testFiles: null };
const MANY = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts`);
const WHY = "the same import path renamed in every file";
const RISK = "changes how the payment total is rounded";
function opened(name, { playbook = "feature", plan = ["--files", "src/a.ts"], files = {} } = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify(CONFIG), ...files });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, playbook]);
  readyToEdit(repo, { plan });
  return repo;
}
const mechanical = (name, files = MANY, extra = {}) => opened(name, { plan: ["--files", files.join(","), "--mechanical", WHY], ...extra });
const editAll = (repo, files = MANY) => {
  for (const f of files) edit(repo, f, `export const v = "${f}";\n`);
  edit(repo, "tests/a.test.ts", "test('a', () => { 1; });\n");
};
const packetOf = (out) => readFileSync(/packet: (\S+)/.exec(out)[1], "utf8");
let helpers = 0;
function recorded(repo, briefOut, { actOn = [] } = {}) {
  const who = { agent_id: `H${++helpers}`, agent_type: "done-gate:reviewer" };
  const file = /Your file is (\S+\.md)/.exec(briefOut)[1];
  hook(repo, { hook_event_name: "SubagentStart", ...who });
  lookedUp(repo, { agent: who.agent_id, role: "reviewer" });
  writeFileSync(file, `# Review\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n## Can't verify\n- none\n## Lessons\n- none\n## Dismissed\n- none\n`);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, tool_response: {}, ...who });
  hook(repo, { hook_event_name: "SubagentStop", ...who });
  cli(repo, "huddle", ["add", "reviewer", "--file", path.basename(file)]);
}

test("C1 happy: a stated risk on a one-file plan predicts standard, says so, survives a later gate check, and gate size and the report show it", () => {
  const repo = makeRepo("sbb-c1", { ".claude/gate.json": JSON.stringify(CONFIG) });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["sbb-c1", "feature"]);
  readyToEdit(repo);
  const out = cli(repo, "note", ["plan", "Round half up.", "--files", "src/a.ts", "--risk", RISK]);
  assert.match(out, new RegExp(`tier predicted standard \\(1 file, stated risk: ${RISK}\\)`));
  cli(repo, "check");
  cli(repo, "check");
  assert.equal(ledgerOf(repo).tier.risk, RISK);
  assert.equal(stepState(repo, "skeptic"), null, "the plan check is owed");
  assert.match(cli(repo, "size"), new RegExp(`tier: standard[^\\n]*stated risk: ${RISK}`));
  assert.match(cli(repo, "report"), new RegExp(`stated risk: ${RISK}`));
});

test("C2 happy: a stated risk on a small diff outside any listed folder owes the second reviewer and the plan check", () => {
  const repo = opened("sbb-c2", { plan: ["--files", "src/a.ts", "--risk", RISK] });
  edit(repo, "src/a.ts", "export const a = 1;\n");
  const r9 = ruleLines(repo, "R9");
  assert.match(r9, new RegExp(`the plan states a risk \\(${RISK}\\)[^\\n]*done-gate:reviewer-2`), r9);
  assert.match(cli(repo, "size"), /requires: skeptic, reviewer/);
  const plain = opened("sbb-c2-plain");
  edit(plain, "src/a.ts", "export const a = 1;\n");
  assert.equal(ruleLines(plain, "R9"), "", "anchor: with no risk stated the same diff owes no second review");
});

test("C3 edge: --risk alone keeps the planned files; a later plan note without --risk keeps the risk", () => {
  const repo = opened("sbb-c3", { plan: ["--files", "src/a.ts,src/b.ts"] });
  cli(repo, "note", ["plan", "It touches the stored balance.", "--risk", RISK]);
  assert.deepEqual(ledgerOf(repo).tier.predictedFiles, ["src/a.ts", "src/b.ts"]);
  cli(repo, "note", ["plan", "Same plan, reworded.", "--files", "src/a.ts,src/b.ts"]);
  assert.equal(ledgerOf(repo).tier.risk, RISK);
});

test("C4 C12 refused: --risk with empty words, with no value, while a mechanical call holds, or on note task or context is refused; --risk none takes a stated risk back", () => {
  const repo = opened("sbb-c4");
  assert.match(run(repo, "note", ["plan", "p", "--risk", " "]).stderr, /--risk needs what the change touches/);
  assert.match(run(repo, "note", ["plan", "p", "--risk"]).stderr, /--risk needs what the change touches/);
  assert.match(run(repo, "note", ["task", "t", "--risk", RISK]).stderr, /belong to gate note plan/);
  assert.match(run(repo, "note", ["context", "Traced: src/a.ts:1 · Related: none · Research: none needed: x", "--mechanical", WHY]).stderr, /belong to gate note plan/);
  assert.equal(ledgerOf(repo).tier.risk ?? null, null);
  cli(repo, "note", ["plan", "p", "--risk", RISK]);
  assert.match(cli(repo, "note", ["plan", "p", "--risk", "none"]), /stated risk taken back/);
  assert.equal(ledgerOf(repo).tier.risk ?? null, null);
  assert.equal(ledgerOf(repo).tier.predicted, "tiny");
  const held = mechanical("sbb-c12");
  assert.match(run(held, "note", ["plan", "p", "--risk", RISK]).stderr, /risky or mechanical, not both/);
  assert.equal(ledgerOf(held).tier.risk ?? null, null);
});

test("C5 happy: --mechanical on a twelve-file plan sizes it small: plan check N/A, no blind QA and no second reviewer owed, one reviewer owed", () => {
  const repo = makeRepo("sbb-c5", { ".claude/gate.json": JSON.stringify(CONFIG) });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["sbb-c5", "feature"]);
  readyToEdit(repo);
  const out = cli(repo, "note", ["plan", "Rename the import.", "--files", MANY.join(","), "--mechanical", WHY]);
  assert.match(out, /tier predicted large \(12 files\) · sized small as mechanical \(the lead's call\): a reviewer checks it/);
  assert.equal(stepState(repo, "skeptic"), "N/A");
  const [w] = ledgerOf(repo).waivers;
  assert.deepEqual({ key: w.key, by: w.by, reason: w.reason, files: w.files }, { key: "mechanical", by: "lead", reason: WHY, files: MANY });
  editAll(repo);
  assert.doesNotMatch(ruleLines(repo, "R7"), /blind QA/);
  assert.equal(ruleLines(repo, "R9"), "");
  assert.match(ruleLines(repo, "R5"), /no reviewer pass/);
  assert.match(cli(repo, "size"), /tier: small[^\n]*mechanical \(the lead's call\)[^\n]*measured large/);
  assert.equal(ledgerOf(repo).tier.predicted, "large", "the counted prediction is kept");
});

test("C6 happy: a full review packet lists the mechanical call and its reason; once that round is recorded R21 is quiet", () => {
  const repo = mechanical("sbb-c6");
  editAll(repo);
  assert.match(ruleLines(repo, "R21"), /the lead's call on mechanical was shown to no reviewer/);
  const piece = packetOf(cli(repo, "brief", ["reviewer", "--files", "src/m0.ts,src/m1.ts"]));
  assert.ok(piece.includes(`- mechanical — ${WHY}`), "a piece lists it too");
  const out = cli(repo, "brief", ["reviewer"]);
  const packet = packetOf(out);
  assert.ok(packet.includes(`- mechanical — ${WHY}`), packet);
  assert.match(packet, /A `mechanical` call says[^\n]*Call: mechanical/);
  recorded(repo, out);
  assert.equal(ruleLines(repo, "R21"), "");
});

test("C7 edge: a mechanical call no reviewer round was shown blocks close; the light check packet shows the whole diff for it", () => {
  const repo = mechanical("sbb-c7");
  editAll(repo);
  assert.match(run(repo, "close").stderr + run(repo, "close").stdout, /R21/);
  const packet = packetOf(cli(repo, "brief", ["reviewer", "--calls"]));
  assert.ok(packet.includes(`- mechanical — ${WHY}`), packet);
  for (const f of ["src/m0.ts", "src/m11.ts"]) assert.ok(packet.includes(`+export const v = "${f}";`), `${f} is in the light check's diff`);
});

test("C8 happy: gate call mechanical --withdraw gives the counted size back: plan check reopened, blind QA and second reviewer owed again", () => {
  const repo = mechanical("sbb-c8");
  editAll(repo);
  assert.match(cli(repo, "call", ["mechanical", "--withdraw"]), /taken back/);
  cli(repo, "check");
  assert.equal(stepState(repo, "skeptic"), null);
  assert.match(ruleLines(repo, "R7"), /blind QA/);
  assert.match(ruleLines(repo, "R9"), /size large/);
  assert.match(cli(repo, "size"), /tier: large/);
  assert.match(cli(repo, "report"), /the lead's call on mechanical: [^\n]* — taken back/);
});

test("C9 boundary: a mechanical call with a ui file sizes small; with a schema or a high-risk file it sizes standard, and a high-risk file still owes the second reviewer", () => {
  const ui = mechanical("sbb-c9-ui", [...MANY, "src/app/page.tsx"]);
  assert.equal(stepState(ui, "skeptic"), "N/A");
  assert.match(cli(ui, "size"), /tier: small/);
  const schema = mechanical("sbb-c9-schema", [...MANY, "db/schema.sql"], { files: { "db/schema.sql": "create table a (id int);\n" } });
  assert.equal(stepState(schema, "skeptic"), null);
  assert.match(cli(schema, "size"), /tier: standard/);
  const pay = mechanical("sbb-c9-pay", [...MANY, "src/pay/charge.ts"]);
  assert.equal(stepState(pay, "skeptic"), null);
  editAll(pay, [...MANY, "src/pay/charge.ts"]);
  assert.match(cli(pay, "size"), /tier: standard/);
  assert.match(ruleLines(pay, "R9"), /high-risk paths changed/);
  assert.doesNotMatch(ruleLines(pay, "R7"), /blind QA/);
});

test("C10 edge: a one-file plan is already under the cap: --mechanical there is refused as nothing to lower", () => {
  const repo = opened("sbb-c10");
  assert.match(run(repo, "note", ["plan", "p", "--mechanical", WHY]).stderr, /nothing to lower/);
  assert.deepEqual(ledgerOf(repo).waivers, []);
  const three = opened("sbb-c10-schema", { plan: ["--files", "src/a.ts,src/b.ts,db/schema.sql"], files: { "db/schema.sql": "create table a (id int);\n" } });
  assert.match(run(three, "note", ["plan", "p", "--mechanical", WHY]).stderr, /nothing to lower/, "standard by the schema floor stays standard");
  const two = opened("sbb-c10-two", { plan: ["--files", "src/a.ts,src/b.ts"] });
  cli(two, "note", ["plan", "p", "--mechanical", WHY]);
  assert.equal(stepState(two, "skeptic"), "N/A", "two files go from standard to small");
});

test("C11 refused: the mechanical flag on a bugfix run, on a run that is not tiered, under six words, with no value, with --risk, while a risk is stated, with no code file planned, or while a call holds", () => {
  const files = ["--files", MANY.join(",")];
  const bug = opened("sbb-c11-bug", { playbook: "bugfix", plan: files });
  assert.match(run(bug, "note", ["plan", "p", "--mechanical", WHY]).stderr, /a bug fix changes behaviour/);
  const inv = makeRepo("sbb-c11-inv", { ".claude/gate.json": JSON.stringify(CONFIG) });
  cli(inv, "open", ["sbb-c11-inv", "investigation"]);
  for (const f of [["--mechanical", WHY], ["--risk", RISK]]) assert.match(run(inv, "note", ["plan", "p", ...f]).stderr, /has no size/, f[0]);
  const repo = opened("sbb-c11", { plan: files });
  assert.match(run(repo, "note", ["plan", "p", "--mechanical", "just a rename"]).stderr, /too short/);
  assert.match(run(repo, "note", ["plan", "p", "--mechanical"]).stderr, /--mechanical needs the one edit/);
  assert.match(run(repo, "note", ["plan", "p", "--mechanical", WHY, "--risk", RISK]).stderr, /risky or mechanical, not both/);
  assert.deepEqual(ledgerOf(repo).waivers, []);
  assert.equal(stepState(repo, "skeptic"), null);
  const risky = opened("sbb-c11-risky", { plan: [...files, "--risk", RISK] });
  assert.match(run(risky, "note", ["plan", "p", "--mechanical", WHY]).stderr, /risky or mechanical, not both/);
  const docs = opened("sbb-c11-docs", { plan: ["--files", "tests/a.test.ts"] });
  assert.match(run(docs, "note", ["plan", "p", "--mechanical", WHY]).stderr, /names no code file/);
  const held = mechanical("sbb-c11-held");
  assert.match(run(held, "note", ["plan", "p", "--mechanical", WHY]).stderr, /a mechanical call already holds/);
  assert.equal(ledgerOf(held).waivers.length, 1);
});

test("C13 refused: a helper's gate note plan --mechanical is denied by the guard; the lead's is allowed, and a helper's plain note is not denied for it", () => {
  const repo = opened("sbb-c13");
  const who = { agent_id: "W1", agent_type: "done-gate:worker" };
  for (const command of [`node ${gate} note plan "p" --mechanical "${WHY}"`, `gate() { node "${gate}" "$@"; }; gate note plan "p" --files a.ts --mechanical "${WHY}"`, `bash -c "node /p/gate.mjs note plan p --mechanical x"`]) {
    const denied = decide({ tool_name: "Bash", tool_input: { command }, ...who }, repo);
    assert.equal(denied.deny, true, command);
    assert.match(denied.reason, /only the lead/);
    assert.notEqual(decide({ tool_name: "Bash", tool_input: { command } }, repo).deny, true, `the lead: ${command}`);
  }
  for (const command of [`node ${gate} note plan "p" --risk none`, `node ${gate} note plan "p" --risk "the payment total"`]) {
    assert.equal(decide({ tool_name: "Bash", tool_input: { command }, ...who }, repo).deny, true, command);
    assert.notEqual(decide({ tool_name: "Bash", tool_input: { command } }, repo).deny, true, `the lead: ${command}`);
  }
  for (const command of ['grep -rn -- "--mechanical" README.md', `node ${gate} check`, `node ${gate} note caveat "not driven on a phone"`]) assert.notEqual(decide({ tool_name: "Bash", tool_input: { command }, ...who }, repo).deny, true, command);
});

test("C14 edge: a ledger from before this change sizes as it did", () => {
  const policy = loadPolicy();
  const old = { playbook: "feature", tier: { predicted: "large", predictedFiles: ["src/a.ts"], predictedSized: 1 }, waivers: [{ key: "driver", by: "lead", reason: "r" }] };
  assert.equal(effectiveTier(policy, old, null), "large");
  assert.equal(effectiveTier(policy, { playbook: "feature", tier: { predicted: "small" } }, { tier: "standard", files: 2, lines: 3, forced: [] }), "standard");
  assert.equal(tierOf(old).risk, null);
  assert.deepEqual(tierOf(old).forced, []);
});

test("C15 happy: the report and the final message show the mechanical call as the lead's", () => {
  const repo = mechanical("sbb-c15");
  editAll(repo);
  assert.match(cli(repo, "report"), new RegExp(`- the lead's call on mechanical: ${WHY}`));
  assert.match(cli(repo, "report", ["--brief"]), new RegExp(`decided without asking: sized as mechanical \\(${WHY}\\)`));
});

test("C16 edge: a stated risk or a mechanical call stops the small UI trial: review N/A under it is refused, and one closed earlier comes back", () => {
  const REASON = "colours only: the button turns blue, no logic or data path changed";
  const ui = { "src/app/page.css": ".b { color: red; }\n" };
  const repo = opened("sbb-c16", { plan: ["--files", "src/app/page.css"], files: ui });
  edit(repo, "src/app/page.css", ".b { color: blue; }\n");
  cli(repo, "step", ["review", "na", REASON]);
  assert.equal(ruleLines(repo, "R5"), "", "anchor: the trial holds");
  cli(repo, "note", ["plan", "It is the pay button.", "--risk", RISK]);
  assert.match(ruleLines(repo, "R5"), /R5/);
  assert.equal(stepState(repo, "review"), null);
  assert.match(run(repo, "step", ["review", "na", REASON]).stderr, /UI trial/);
  const many = Array.from({ length: 3 }, (_, i) => `src/app/p${i}.css`);
  const mech = mechanical("sbb-c16-mech", many, { files: Object.fromEntries(many.map((f) => [f, ".b { color: red; }\n"])) });
  for (const f of many) edit(mech, f, ".b { color: blue; }\n");
  assert.match(run(mech, "step", ["review", "na", REASON]).stderr, /UI trial/);
});

test("C17 edge: a mechanical call lapses when a changed code file is not among its files: the counted size is back, the report says why, and it can be stated again", () => {
  const repo = mechanical("sbb-c17");
  editAll(repo);
  edit(repo, "src/extra.ts", "export const extra = 1;\n");
  cli(repo, "check");
  assert.equal(ledgerOf(repo).waivers[0].lapsed, true);
  assert.match(cli(repo, "size"), /tier: large/);
  assert.equal(stepState(repo, "skeptic"), null);
  assert.match(cli(repo, "report"), /the lead's call on mechanical: [^\n]* — no longer holds: a file it was not made on changed after it/);
  cli(repo, "plan", ["add", "src/extra.ts", "the rename reaches it too"]);
  cli(repo, "note", ["plan", "Rename, one more file.", "--mechanical", WHY]);
  cli(repo, "check");
  assert.match(cli(repo, "size"), /tier: small/);
  assert.equal(ledgerOf(repo).waivers.filter((w) => !w.lapsed).length, 1);
});

test("C18 refused: gate call mechanical with a reason points at the plan note; gate brief qa under a held call names the capped size", () => {
  const repo = mechanical("sbb-c18");
  const r = run(repo, "call", ["mechanical", WHY]);
  assert.match(r.stderr, /stated on the plan[^\n]*gate note plan[^\n]*--mechanical/);
  assert.doesNotMatch(r.stderr, /is not the lead's call/);
  assert.equal(ledgerOf(repo).waivers.length, 1);
  assert.match(run(repo, "brief", ["qa"]).stderr, /size small: write the tests yourself/);
});

test("C19 edge: a later plan note without --mechanical keeps the call and the capped size", () => {
  const repo = mechanical("sbb-c19");
  cli(repo, "note", ["plan", "Same rename, reworded.", "--files", MANY.join(",")]);
  assert.equal(stepState(repo, "skeptic"), "N/A");
  assert.equal(ledgerOf(repo).waivers.filter((w) => w.key === "mechanical" && !w.lapsed).length, 1);
  assert.match(cli(repo, "size"), /tier: small/);
});

test("RV1 edge: a one-file plan whose diff measures large takes --mechanical, and the refusal names the size the run has now", () => {
  const repo = opened("sbb-rv1");
  edit(repo, "src/a.ts", Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  assert.match(cli(repo, "size"), /tier: large/);
  cli(repo, "note", ["plan", "Generated constants.", "--mechanical", WHY]);
  assert.match(cli(repo, "size"), /tier: small[^\n]*mechanical/);
  const small = opened("sbb-rv1-small");
  edit(small, "src/a.ts", "export const a = 1;\nexport const b = 2;\n");
  cli(small, "check");
  assert.match(run(small, "note", ["plan", "p", "--mechanical", WHY]).stderr, /nothing to lower, the run is size small with or without it/);
});
