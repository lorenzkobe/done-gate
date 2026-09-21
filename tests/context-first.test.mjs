import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { nextHint } from "../scripts/lib/next.mjs";

// context-first: understand before touching anything. A Context section (Traced / Related /
// Research) is written before the plan, shown to every helper, and its order is checked.
// Cases C1–C8 of the task's case table.

const envFor = (repo, session = "S1") => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session });
const REFUSAL = /^done-gate: /m;
function run(repo, verb, args = [], input = "") {
  return spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", input, env: envFor(repo) });
}
function cli(repo, verb, args = [], input = "") {
  const r = run(repo, verb, args, input);
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
  return r;
}
const leadEdit = (repo, file) => hook(repo, "log", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, file) }, tool_output: "" });

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));
const ledgerMd = (repo) => readFileSync(path.join(runDir(repo), "ledger.md"), "utf8");
const lastLine = (out) => out.trim().split("\n").pop();
const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);

const CONTEXT = [
  "Traced: src/a.ts:1 exports a, read by src/app/page.tsx:1; no other caller (grep -a).",
  "Related: tests/a.test.ts pins a; docs/notes.md describes the page.",
  "Research: none needed: a one-line constant change with no known pattern to compare.",
].join("\n");

function opened(name, { playbook = "feature", files = ["src/a.ts"], task = true } = {}) {
  const repo = makeRepo(name, Object.fromEntries(files.map((f) => [f, "export const x = 1;\n"])));
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, playbook]);
  if (task) cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  return repo;
}
function planned(name, opts = {}) {
  const repo = opened(name, opts);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "The plan.", "--files", (opts.files ?? ["src/a.ts"]).join(",")]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1 happy — the note lands
// ---------------------------------------------------------------------------

test("C1 happy: gate note context with the three parts and a resolving pointer writes ## Context, stamps contextSeq and closes step {context}", () => {
  const repo = opened("ctx-c1");
  const r = cli(repo, "note", ["context", CONTEXT]);
  assert.match(r.stdout, /context noted/);
  const md = ledgerMd(repo);
  assert.match(md, /## Context\n\nTraced: src\/a\.ts:1/);
  assert.ok(md.indexOf("## Context") < md.indexOf("## Plan"), "Context sits before Plan in ledger.md");
  const l = ledgerOf(repo);
  assert.equal(typeof l.contextSeq, "number");
  const step = l.steps.find((s) => s.key === "context");
  assert.equal(step.state, "DONE");
  assert.equal(step.evidence, "ledger.md#context");
  // stdin works like the other notes
  const repo2 = opened("ctx-c1-stdin");
  cli(repo2, "note", ["context", "-"], CONTEXT);
  assert.match(ledgerMd(repo2), /Research: none needed/);
});

// ---------------------------------------------------------------------------
// C2 refused — the shape is checked
// ---------------------------------------------------------------------------

test("C2 refused: a missing part, no resolving pointer under Traced (prose, a missing file, a path outside the repo, a directory), or empty text is refused", () => {
  // src/dir.ts/ is a directory whose name looks like a file, so the pointer regex matches it
  const repo = opened("ctx-c2", { files: ["src/a.ts", "src/dir.ts/inner.txt"] });
  const noResearch = refused(repo, "note", ["context", "Traced: src/a.ts:1 exports a.\nRelated: none."]);
  assert.match(noResearch, /Traced/); assert.match(noResearch, /Related/); assert.match(noResearch, /Research/);
  const noPointer = refused(repo, "note", ["context", "Traced: I looked at the module.\nRelated: none.\nResearch: none needed: trivial."]);
  assert.match(noPointer, /file:line/);
  const ghost = refused(repo, "note", ["context", "Traced: src/nope.ts:3 is the entry.\nRelated: none.\nResearch: none needed: trivial."]);
  assert.match(ghost, /file:line|resolve|exist/);
  const traversal = refused(repo, "note", ["context", "Traced: ../package.json:1 is outside.\nRelated: none.\nResearch: none needed: trivial."]);
  assert.match(traversal, /file:line|resolve|exist/);
  const directory = refused(repo, "note", ["context", "Traced: src/dir.ts:1 is a folder.\nRelated: none.\nResearch: none needed: trivial."]);
  assert.match(directory, /file:line|resolve|exist/);
  refused(repo, "note", ["context", ""]);
  const l = ledgerOf(repo);
  assert.equal(l.contextSeq ?? null, null, "a refused note stamped contextSeq");
  assert.equal(l.steps.find((s) => s.key === "context").state, null);
  assert.doesNotMatch(ledgerMd(repo), /\nTraced: /, "a refused note wrote the section");
});

// ---------------------------------------------------------------------------
// C3 happy — the playbooks
// ---------------------------------------------------------------------------

test("C3 happy: feature, refactor and plan open with {context}; bugfix has it as step 3; no {read} step remains; skipping it is refused", () => {
  const text = readFileSync(path.join(pluginRoot, "skills", "gate", "playbooks.md"), "utf8");
  assert.doesNotMatch(text, /\{read\}/, "a playbook still has a {read} step");
  for (const [playbook, n] of [["feature", 1], ["refactor", 1], ["plan", 1], ["bugfix", 3]]) {
    const repo = opened(`ctx-c3-${playbook}`, { playbook, task: false });
    const steps = ledgerOf(repo).steps;
    const ctx = steps.find((s) => s.key === "context");
    assert.ok(ctx, `${playbook}: no {context} step: ${steps.map((s) => s.key)}`);
    assert.equal(ctx.n, n, `${playbook}: {context} is step ${ctx.n}, expected ${n}`);
    assert.match(ctx.text, /trace/i, `${playbook}: the step does not say to trace: ${ctx.text}`);
    assert.match(ctx.text, /research/i, `${playbook}: the step does not mention research: ${ctx.text}`);
    assert.match(ctx.text, /gate note context/, `${playbook}: the step does not name the verb: ${ctx.text}`);
    assert.ok(!steps.some((s) => s.key === "read"), `${playbook}: a read step was copied`);
  }
  const repo = opened("ctx-c3-skip");
  assert.match(refused(repo, "step", ["context", "skipped", "no time"]), /DONE or WAIVED|cannot be skipped|evidenced/i);
});

// ---------------------------------------------------------------------------
// C4 happy — the hints
// ---------------------------------------------------------------------------

test("C4 happy: after the task the hint is the context step; after the context it is the plan", () => {
  const repo = opened("ctx-c4");
  const afterTask = lastLine(cli(repo, "note", ["task", "Again. [inferred]"]).stdout);
  assert.match(afterTask, /gate note context/, afterTask);
  for (const word of ["Traced", "Related", "Research"]) assert.match(afterTask, new RegExp(word), afterTask);
  const afterContext = lastLine(cli(repo, "note", ["context", CONTEXT]).stdout);
  assert.match(afterContext, /gate note plan/, afterContext);
  // the pure renderer: a ledger with a blank context step and no contextSeq hints the context
  const steps = [{ n: 1, key: "context", text: "understand", state: null, note: null, evidence: null, seq: 1 }];
  const h = nextHint({ status: "open", playbook: "feature", taskSeq: 1, planSeq: null, contextSeq: null, cases: [], steps, huddles: [], waivers: [] });
  assert.match(h, /gate note context/, h);
  // an old ledger with no context step goes straight to the plan
  const old = nextHint({ status: "open", playbook: "feature", taskSeq: 1, planSeq: null, cases: [], steps: [{ n: 1, key: "read", text: "read", state: null }], huddles: [], waivers: [] });
  assert.match(old, /gate note plan/, old);
});

// ---------------------------------------------------------------------------
// C5 happy — every packet carries the Context
// ---------------------------------------------------------------------------

test("C5 happy: every packet carries a ## Context section with the note's text, after ## Plan", () => {
  const std = planned("ctx-c5-standard");
  for (const role of ["skeptic", "reviewer"]) {
    const r = cli(std, "brief", [role]);
    const file = /^packet: (.+)$/m.exec(r.stdout)[1];
    const text = readFileSync(file, "utf8");
    assert.match(text, /^## Context$/m, `${role}: no Context section`);
    assert.ok(text.indexOf("## Plan") < text.indexOf("## Context"), `${role}: Context is not after Plan`);
    assert.match(text, /Traced: src\/a\.ts:1/, `${role}: the trace is missing`);
    assert.match(text, /Research: none needed/, `${role}: the research line is missing`);
  }
  const large = planned("ctx-c5-large", { files: LARGE });
  for (const role of ["qa", "worker"]) {
    const r = cli(large, "brief", [role]);
    const text = readFileSync(/^packet: (.+)$/m.exec(r.stdout)[1], "utf8");
    assert.match(text, /^## Context$/m, `${role}: no Context section`);
    assert.match(text, /Traced: src\/a\.ts:1/, `${role}: the trace is missing`);
  }
});

// ---------------------------------------------------------------------------
// C6 edge — the order rule
// ---------------------------------------------------------------------------

test("C6 edge: R2 blocks while Context is missing after a source edit; a late Context is recorded; an old ledger without the step is exempt", () => {
  const repo = opened("ctx-c6");
  write(repo, "src/a.ts", "export const x = 2;\n");
  leadEdit(repo, "src/a.ts");
  const check = cli(repo, "check").stdout;
  const r2 = check.split("\n").find((l) => /\bR2\b/.test(l)) ?? "";
  assert.match(r2, /Context/, `R2 does not name Context:\n${check}`);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "The plan.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  assert.doesNotMatch(cli(repo, "check").stdout, /\bR2\b/, "R2 still blocks with everything written");
  const report = cli(repo, "report").stdout;
  assert.match(report, /Context and Plan and case table written after the first source edit|Context[^\n]*written after the first source edit/, report);

  // an old ledger: no {context} step at all
  const old = opened("ctx-c6-old");
  const dir = runDir(old);
  const ledger = loadLedger(dir);
  ledger.steps = ledger.steps.filter((s) => s.key !== "context");
  saveLedger(dir, ledger); // a test may write ledger.json: the fence governs the model's tools, not node
  cli(old, "note", ["plan", "The plan.", "--files", "src/a.ts"]);
  cli(old, "case", ["add", "it works", "--kind", "happy"]);
  write(old, "src/a.ts", "export const x = 2;\n");
  leadEdit(old, "src/a.ts");
  assert.doesNotMatch(cli(old, "check").stdout, /\bR2\b/, "an old ledger was asked for a Context");
});

// ---------------------------------------------------------------------------
// C7 happy — the prose and the brief
// ---------------------------------------------------------------------------

test("C7 happy: the skeptic asks what the trace missed; the brief's first line says what was understood first and its For-you line says when no context was written; README, SKILL.md and session-start name the Context; SKILL.md stays under 4096 bytes", () => {
  const read = (rel) => readFileSync(path.join(pluginRoot, rel), "utf8");
  assert.match(read("agents/skeptic.md"), /trace[^.]{0,80}miss|miss[^.]{0,80}trace/i, "skeptic.md: what the trace missed");
  assert.match(read("agents/skeptic.md"), /Context/, "skeptic.md names the Context section");
  const skill = read("skills/gate/SKILL.md");
  assert.ok(Buffer.byteLength(skill) < 4096, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  assert.match(skill, /gate note context/, "SKILL.md names the verb");
  assert.match(skill, /Traced/, "SKILL.md names the parts");
  assert.match(read("hooks/session-start.md"), /Context/, "session-start names the Context");
  const readme = read("README.md");
  assert.match(readme, /note task\\\|context\\\|plan|note context/, "README verbs table");
  assert.match(readme, /\| R2 \|[^\n]*Context/, "README R2 row");

  // the brief stays five lines: line 1 carries the understood-first summary, line 5 flags an absence
  const repo = planned("ctx-c7-brief");
  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.match(brief, /^Changed no source files\. Understood first: 2 pointers traced, research not needed\.$/m, brief);
  assert.doesNotMatch(brief, /no context/i, brief);
  const researched = opened("ctx-c7-researched");
  cli(researched, "note", ["context", "Traced: src/a.ts:1 is the entry.\nRelated: none.\nResearch: read the Node docs on process.hrtime; a monotonic clock orders events better than Date.now."]);
  assert.match(cli(researched, "report", ["--brief"]).stdout, /Understood first: 1 pointer traced, research noted\./);
  assert.match(cli(repo, "report").stdout, /^## Context\n\nTraced: src\/a\.ts:1/m, "the full report carries the Context section");
  const none = opened("ctx-c7-none");
  cli(none, "note", ["plan", "The plan."]);
  assert.match(cli(none, "report", ["--brief"]).stdout, /no context was written/);
});

// ---------------------------------------------------------------------------
// C8 idempotent — a second note appends
// ---------------------------------------------------------------------------

test("C8 idempotent: a second gate note context appends under the same heading and keeps the newer contextSeq", () => {
  const repo = opened("ctx-c8");
  cli(repo, "note", ["context", CONTEXT]);
  const first = ledgerOf(repo).contextSeq;
  cli(repo, "note", ["context", "Traced: src/app/page.tsx:1 renders a.\nRelated: none.\nResearch: none needed: same change."]);
  const md = ledgerMd(repo);
  assert.equal((md.match(/^## Context$/gm) ?? []).length, 1, "two Context headings");
  assert.match(md, /Traced: src\/a\.ts:1[\s\S]*Traced: src\/app\/page\.tsx:1/);
  assert.ok(ledgerOf(repo).contextSeq > first, "contextSeq did not move to the newer note");
});
