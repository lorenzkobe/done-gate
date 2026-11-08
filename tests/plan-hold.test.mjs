// plan-hold: at a size that needs the plan check, code and tests wait for it; the check cannot be
// marked not applicable or run twice, and it closes itself once every finding is answered. One test
// per row of the plan's table (Change 1, "Where it applies"), plus the stamp: old runs keep the old flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asOldRun, gate, lookedUp, makeRepo, pluginRoot, readyToEdit, waiveArgs } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

const TWO = "src/a.ts,src/app/page.tsx";

function envFor(repo) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}
const run = (repo, args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, ...args) {
  const r = run(repo, args);
  assert.equal(r.status, 0, `gate ${args.join(" ")}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}
function refused(repo, ...args) {
  const r = run(repo, args);
  assert.notEqual(r.status, 0, `gate ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.match(r.stderr, /^done-gate: /m);
  return r.stderr;
}
const hook = (repo, payload) => execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), env: envFor(repo) });

// null when the call is allowed, else the reason the model is shown
function fence(repo, tool, tool_input, agent = null) {
  const payload = { hook_event_name: "PreToolUse", session_id: "S1", cwd: repo, tool_name: tool, tool_input, ...(agent ? { agent_id: `${agent}-1`, agent_type: `done-gate:${agent}` } : {}) };
  const r = spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify(payload), encoding: "utf8", env: envFor(repo) });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : null;
}
const edit = (repo, rel, agent = null) => fence(repo, "Edit", { file_path: path.join(repo, rel), old_string: "a", new_string: "b" }, agent);
const writeTool = (repo, rel, agent = null) => fence(repo, "Write", { file_path: path.join(repo, rel), content: "x" }, agent);
const shell = (repo, command, agent = null) => fence(repo, "Bash", { command }, agent);

// an edit the gate saw: the bytes land and the PostToolUse hook logs it
function edited(repo, rel) {
  writeFileSync(path.join(repo, rel), `${readFileSync(path.join(repo, rel), "utf8")}export const more = 1;\n`);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_response: {} });
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const stepOf = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key);

function committed(name) {
  const repo = makeRepo(name);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
// a run whose plan names `files`; two files is standard, so the check is owed
function planned(name, files = TWO, { playbook = "feature", size = null } = {}) {
  const repo = committed(name);
  cli(repo, "open", name, playbook);
  readyToEdit(repo, { plan: ["--files", files, ...(size ? ["--size", size] : [])] });
  return repo;
}

const FINDING = "the plan misses the empty list — src/a.ts:1";
const skepticFile = (actOn = []) =>
  `# Skeptic 1\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n## Consider\n- none\n## Noted\n- none\n## The one question\n- none\n`;
const DRAFT = "# Skeptic 1\n\n## Act on\n- unverified\n## Consider\n- unverified\n## Noted\n- unverified\n## The one question\n- unverified\n";
const PARTIAL = "# Skeptic 1\n\n## Act on\n- none\n## Consider\n- unverified\n## Noted\n- none\n## The one question\n- none\n";

// the real brief, then the helper's file as `body`; returns the file's name
function checked(repo, body) {
  const file = /Your file is (\S+\.md)/.exec(cli(repo, "brief", "skeptic"))[1];
  writeFileSync(file, body);
  return path.basename(file);
}

test("C1 C2 refused then happy: at standard an Edit waits for the plan check and passes right after the last finding is answered, with no gate step", () => {
  const repo = planned("ph-c1");
  const why = edit(repo, "src/a.ts");
  assert.match(why ?? "", /plan check/, why);
  assert.match(why, /gate brief skeptic/);

  const file = checked(repo, skepticFile([FINDING]));
  cli(repo, "huddle", "add", "skeptic", "--file", file);
  assert.match(edit(repo, "src/a.ts") ?? "", /plan check/, "an open finding still holds code");
  cli(repo, "huddle", "resolve", "H1.1", "--evidence", "ledger.md#plan");
  assert.equal(edit(repo, "src/a.ts"), null);
  assert.equal(stepOf(repo, "skeptic").state, "DONE");
  assert.equal(stepOf(repo, "skeptic").auto, "fact");
});

test("C3 refused: at standard a test file waits for the check too", () => {
  const repo = planned("ph-c3");
  assert.match(writeTool(repo, "tests/b.test.ts") ?? "", /plan check/);
  assert.match(edit(repo, "tests/a.test.ts") ?? "", /plan check/);
});

test("C4 happy: tiny and small runs owe no check, so nothing waits", () => {
  assert.equal(edit(planned("ph-c4-tiny", "src/a.ts"), "src/a.ts"), null);
  const small = planned("ph-c4-small", "src/a.ts", { size: "small" });
  assert.equal(ledgerOf(small).tier.predicted, "small", "premise: declared small");
  assert.equal(edit(small, "src/a.ts"), null);
});

test("C5 happy: a plan run and an investigation are not held", () => {
  const plan = committed("ph-c5-plan");
  cli(plan, "open", "ph-c5-plan", "plan");
  readyToEdit(plan, { plan: ["--files", TWO] });
  assert.ok(ledgerOf(plan).steps.some((s) => s.key === "skeptic"), "premise: the plan playbook has a skeptic step");
  assert.equal(edit(plan, "src/a.ts"), null);
  const inv = committed("ph-c5-inv");
  cli(inv, "open", "ph-c5-inv", "investigation");
  assert.equal(edit(inv, "tests/repro.test.ts"), null);
});

test("C6 edge: a plan that grows from tiny to standard before any code holds code until the check", () => {
  const repo = planned("ph-c6", "src/a.ts");
  assert.equal(edit(repo, "src/a.ts"), null, "premise: tiny is free");
  cli(repo, "note", "plan", "Two files now.", "--files", TWO);
  assert.match(edit(repo, "src/a.ts") ?? "", /plan check/);
});

test("C7 edge: a run that grows to standard after code changed is not stalled mid-edit, and gate check still asks for the check", () => {
  const repo = planned("ph-c7", "src/a.ts");
  edited(repo, "src/a.ts");
  cli(repo, "plan", "add", "src/app/page.tsx", "the badge renders there");
  assert.equal(stepOf(repo, "skeptic").state, null, "premise: the check is owed now");
  assert.equal(edit(repo, "src/app/page.tsx"), null);
  assert.match(cli(repo, "check"), /step\(s\) blank:[^\n]*\{skeptic\}/);
});

test("C8 refused: gate step skeptic na is refused at a size that needs the check and accepted below it", () => {
  const repo = planned("ph-c8");
  assert.match(refused(repo, "step", "skeptic", "na", "not needed"), /skeptic/);
  assert.equal(stepOf(repo, "skeptic").state, null);
  const tiny = planned("ph-c8-tiny", "src/a.ts");
  cli(tiny, "step", "skeptic", "na", "one line");
  assert.equal(stepOf(tiny, "skeptic").state, "N/A");
});

test("C9 happy: a waiver of the check in the user's words releases the hold", () => {
  const repo = planned("ph-c9");
  cli(repo, "waive", ...waiveArgs(repo, "skeptic", "the user ran the check by hand"));
  assert.equal(stepOf(repo, "skeptic").state, "WAIVED");
  assert.equal(edit(repo, "src/a.ts"), null);
});

test("C10 happy: the checker writes its own findings file during the hold", () => {
  const repo = planned("ph-c10");
  const file = /Your file is (\S+\.md)/.exec(cli(repo, "brief", "skeptic"))[1];
  hook(repo, { hook_event_name: "SubagentStart", agent_id: "skeptic-1", agent_type: "done-gate:skeptic" });
  assert.equal(fence(repo, "Write", { file_path: file, content: DRAFT }, "skeptic"), null);
});

test("C11 refused: during the hold the lead's and a worker's shell writes to code, and QA's test write, are refused", () => {
  const repo = planned("ph-c11");
  assert.match(shell(repo, "echo x > src/a.ts") ?? "", /plan check/);
  assert.match(shell(repo, "echo x > src/a.ts", "worker") ?? "", /plan check/);
  assert.match(writeTool(repo, "tests/b.test.ts", "qa") ?? "", /plan check/);
  assert.match(edit(repo, "src/a.ts", "worker") ?? "", /plan check/);
});

test("C12 refused: a second brief is refused once the newest skeptic file is finished, and allowed while it is a draft or partial", () => {
  for (const [name, body] of [["ph-c12-draft", DRAFT], ["ph-c12-partial", PARTIAL]]) {
    const repo = planned(name);
    const first = checked(repo, body);
    const again = /Your file is (\S+\.md)/.exec(cli(repo, "brief", "skeptic"))[1];
    assert.equal(path.basename(again), first, `${name}: a cut-off helper's file is briefed again under its own number`);
  }
  const repo = planned("ph-c12");
  checked(repo, skepticFile([FINDING]));
  assert.match(refused(repo, "brief", "skeptic"), /skeptic-1\.md/);
});

test("C13 happy: a skeptic file with nothing to act on closes the step at huddle add, marked as the gate's", () => {
  const repo = planned("ph-c13");
  cli(repo, "huddle", "add", "skeptic", "--file", checked(repo, skepticFile()));
  const step = stepOf(repo, "skeptic");
  assert.equal(step.state, "DONE");
  assert.equal(step.auto, "fact");
  assert.equal(step.evidence, "skeptic-1.md");
  assert.equal(edit(repo, "src/a.ts"), null);
});

test("C14 edge: an open item or a partial file leaves the step blank; a worker reply that fixes the last item closes it", () => {
  const partial = planned("ph-c14-partial");
  refused(partial, "huddle", "add", "skeptic", "--file", checked(partial, PARTIAL));
  assert.equal(stepOf(partial, "skeptic").state, null);

  const repo = planned("ph-c14");
  cli(repo, "huddle", "add", "skeptic", "--file", checked(repo, skepticFile([FINDING, "the second caller is missed — src/app/page.tsx:1"])));
  cli(repo, "huddle", "resolve", "H1.1", "--evidence", "ledger.md#plan");
  assert.equal(stepOf(repo, "skeptic").state, null, "one item is still open");
  writeFileSync(path.join(runDir(repo), "worker-1.md"), "# Worker 1\n\n## Replies\n- H1.2 — fixed: src/app/page.tsx:1\n");
  cli(repo, "huddle", "reply", "--file", "worker-1.md");
  assert.equal(stepOf(repo, "skeptic").state, "DONE");
});

test("C15 edge: a WAIVED step stays WAIVED after huddle add, a hand close still works, and an old run's step waits for the hand close", () => {
  const waived = planned("ph-c15-waived");
  cli(waived, "waive", ...waiveArgs(waived, "skeptic", "the user ran the check by hand"));
  writeFileSync(path.join(runDir(waived), "skeptic-1.md"), skepticFile());
  cli(waived, "huddle", "add", "skeptic", "--file", "skeptic-1.md");
  assert.equal(stepOf(waived, "skeptic").state, "WAIVED");

  const byHand = planned("ph-c15-hand");
  cli(byHand, "huddle", "add", "skeptic", "--file", checked(byHand, skepticFile()));
  cli(byHand, "step", "skeptic", "done", "checked", "--evidence", "skeptic-1.md");
  assert.equal(stepOf(byHand, "skeptic").state, "DONE");
  assert.equal(stepOf(byHand, "skeptic").auto, undefined, "a hand close is the lead's");

  const old = planned("ph-c15-old");
  asOldRun(old);
  cli(old, "huddle", "add", "skeptic", "--file", checked(old, skepticFile()));
  assert.equal(stepOf(old, "skeptic").state, null, "an old run closes the check by hand");
  cli(old, "step", "skeptic", "done", "checked", "--evidence", "skeptic-1.md");
  assert.equal(stepOf(old, "skeptic").state, "DONE");
});

test("C16 happy: an old run is never held, and its skeptic can be briefed again after a finished file", () => {
  const repo = committed("ph-c16");
  cli(repo, "open", "ph-c16", "feature");
  asOldRun(repo);
  readyToEdit(repo, { plan: ["--files", TWO] });
  assert.equal(edit(repo, "src/a.ts"), null);
  assert.match(cli(repo, "step", "skeptic", "na", "an old run") , /N\/A/, "an old run keeps its old N/A");
  const again = planned("ph-c16-brief");
  asOldRun(again);
  checked(again, skepticFile());
  assert.match(cli(again, "brief", "skeptic"), /skeptic-2\.md/);
});

test("C18 reported-surface: the hint leads with the one question and says code and tests wait; an old run's hint keeps the hand close; the skill and session start agree", () => {
  const repo = committed("ph-c18");
  cli(repo, "open", "ph-c18", "feature");
  lookedUp(repo);
  cli(repo, "note", "task", "the task");
  cli(repo, "note", "context", "Traced: src/a.ts:1 · Related: none: `grep -rn a src` · Research: none needed: a test fixture");
  cli(repo, "note", "plan", "the plan", "--files", TWO);
  const hint = cli(repo, "case", "add", "the case", "--kind", "happy").split("\n").find((l) => l.startsWith("next:"));
  assert.ok(hint.indexOf("The one question") >= 0 && hint.indexOf("The one question") < hint.indexOf("gate brief skeptic"), hint);
  assert.match(hint, /code and tests wait/);
  assert.match(hint, /closes itself/);
  assert.doesNotMatch(hint, /same turn|gate step skeptic done/);

  const old = committed("ph-c18-old");
  cli(old, "open", "ph-c18-old", "feature");
  asOldRun(old);
  lookedUp(old);
  cli(old, "note", "task", "the task");
  cli(old, "note", "context", "Traced: src/a.ts:1 · Related: none: `grep -rn a src` · Research: none needed: a test fixture");
  cli(old, "note", "plan", "the plan", "--files", TWO);
  assert.match(cli(old, "case", "add", "the case", "--kind", "happy"), /gate step skeptic done/);

  const skill = readFileSync(path.join(pluginRoot, "skills/gate/SKILL.md"), "utf8");
  assert.ok(Buffer.byteLength(skill) < 4096, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  assert.match(skill, /tests wait for the skeptic/i);
  assert.match(readFileSync(path.join(pluginRoot, "hooks/session-start.md"), "utf8"), /code and tests wait for (?:the plan check|the skeptic)/i);
});

test("C19 edge: a skeptic question for the user keeps code held after the last finding: huddle add prints it, and the hand close after asking releases it", () => {
  const repo = planned("ph-c19");
  const body = skepticFile().replace("## The one question\n- none", "## The one question\n- Should an empty list show the badge?");
  const out = cli(repo, "huddle", "add", "skeptic", "--file", checked(repo, body));
  assert.match(out, /Should an empty list show the badge\?/);
  assert.match(out, /AskUserQuestion/);
  assert.equal(stepOf(repo, "skeptic").state, null, "the gate cannot tell the user was asked");
  assert.match(edit(repo, "src/a.ts") ?? "", /plan check/);
  cli(repo, "step", "skeptic", "done", "asked: no badge on an empty list", "--evidence", "skeptic-1.md");
  assert.equal(edit(repo, "src/a.ts"), null);
});

test("C20 edge: a plan noted with no --files holds code at the fallback size", () => {
  const repo = committed("ph-c20");
  cli(repo, "open", "ph-c20", "feature");
  readyToEdit(repo);
  assert.equal(ledgerOf(repo).tier.predicted, null, "premise: nothing predicted");
  assert.match(edit(repo, "src/a.ts") ?? "", /plan check/);
});

test("C21 boundary: a disputed skeptic item with no verdict lets the skeptic be briefed again; once the next file answers it, a third brief is refused", () => {
  const repo = planned("ph-c21");
  cli(repo, "huddle", "add", "skeptic", "--file", checked(repo, skepticFile([FINDING])));
  cli(repo, "huddle", "dispute", "H1.1", "the list is never empty here", "--evidence", "src/a.ts:1");
  const next = checked(repo, `${skepticFile()}## Disputes\n- H1.1 — withdrawn: the caller filters empty lists\n`.replace("Skeptic 1", "Skeptic 2"));
  assert.equal(next, "skeptic-2.md");
  cli(repo, "huddle", "add", "skeptic", "--file", next);
  assert.equal(stepOf(repo, "skeptic").state, "DONE", "the withdrawn item was the last one");
  refused(repo, "brief", "skeptic");
});

test("C8 boundary: the check's N/A is refused by its step number too", () => {
  const repo = planned("ph-c8-number");
  const n = String(stepOf(repo, "skeptic").n);
  assert.match(refused(repo, "step", n, "na", "not needed"), /skeptic/);
});
