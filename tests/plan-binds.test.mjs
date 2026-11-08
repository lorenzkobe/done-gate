// plan-binds: on a run under the new rules the plan's file list binds the lead's edits. A file
// outside it is added with `gate plan add <files> "<why>"`, which re-sizes the task and is shown
// to reviewers and the user; `--files` takes files only, and once code changed no note can
// change the list. Old runs keep the old growth limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asOldRun, gate, makeRepo, planChecked, readyToEdit } from "./helpers.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { IGNORE_CASE } from "../scripts/lib/paths.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

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
const writeTool = (repo, rel) => fence(repo, "Write", { file_path: path.join(repo, rel), content: "x" });

function edited(repo, rel) {
  writeFileSync(path.join(repo, rel), "export const changed = 1;\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_response: {} });
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));

function committed(name, files = {}) {
  const repo = makeRepo(name, { "src/b.ts": "export const b = 1;\n", "notes.txt": "notes\n", ...files });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
// a run whose plan names `files`, with the plan check already run when it is owed
function planned(name, files = "src/a.ts", { playbook = "feature", extra = {} } = {}) {
  const repo = committed(name, extra);
  cli(repo, "open", name, playbook);
  readyToEdit(repo, { plan: files === null ? [] : ["--files", files] });
  if (ledgerOf(repo).checkHold) planChecked(repo);
  return repo;
}
const NOT_PLANNED = /not in this task's plan|outside this task's plan/;

test("C1 refused: an unplanned source edit by the lead is refused and names gate plan add, by Edit, Write and MultiEdit", () => {
  const repo = planned("pb-c1");
  for (const why of [
    edit(repo, "src/b.ts"),
    writeTool(repo, "src/new.ts"),
    fence(repo, "MultiEdit", { file_path: path.join(repo, "src/b.ts"), edits: [{ old_string: "b", new_string: "c" }] }),
    fence(repo, "NotebookEdit", { notebook_path: path.join(repo, "src/nb.ipynb"), new_source: "x" }),
  ]) {
    assert.match(why ?? "", NOT_PLANNED, why);
    assert.match(why, /gate plan add/);
  }
});

test("C2 happy: a planned file, a test, docs and a .txt file stay editable", () => {
  const repo = planned("pb-c2");
  for (const rel of ["src/a.ts", "tests/a.test.ts", "tests/new.test.ts", "docs/notes.md", "notes.txt", "src/readme.rst"]) assert.equal(edit(repo, rel), null, rel);
});

test("C3 happy: after gate plan add the file is planned and the addition is kept with its reason", () => {
  const repo = planned("pb-c3");
  cli(repo, "plan", "add", "src/b.ts", "the helper a.ts calls lives there");
  // two files is standard: the check is owed before code (C11)
  planChecked(repo);
  assert.equal(edit(repo, "src/b.ts"), null);
  const l = ledgerOf(repo);
  assert.ok(l.tier.predictedFiles.includes("src/b.ts"));
  assert.equal(l.planAdds.length, 1);
  assert.deepEqual(l.planAdds[0].files, ["src/b.ts"]);
  assert.equal(l.planAdds[0].why, "the helper a.ts calls lives there");
  assert.equal(typeof l.planAdds[0].seq, "number");
});

test("C4 edge: a worker's edit of an unplanned file is not refused by the plan", () => {
  assert.equal(edit(planned("pb-c4"), "src/b.ts", "worker"), null);
});

test("C5 boundary: where the file system ignores case another spelling of a planned file matches it, and where it does not the spelling is another file", () => {
  const repo = planned("pb-c5");
  if (IGNORE_CASE) assert.equal(edit(repo, "SRC/A.ts"), null);
  else assert.match(edit(repo, "SRC/A.ts") ?? "", NOT_PLANNED);
  cli(repo, "plan", "add", "SRC/A.ts", "the other spelling");
  assert.equal(ledgerOf(repo).planAdds?.length ?? 0, IGNORE_CASE ? 0 : 1, "an already planned spelling is no addition");
});

test("C6 edge: an empty plan list refuses code and says to name the files", () => {
  const repo = planned("pb-c6", null);
  const why = edit(repo, "src/a.ts");
  assert.match(why ?? "", /names no files/, why);
  assert.match(why, /gate plan add/);
});

test("C7 edge: an unreadable run lets the edit through, and plan and investigation runs are not bound", () => {
  const repo = planned("pb-c7");
  const input = { hook_event_name: "PreToolUse", session_id: "S1", cwd: repo, tool_name: "Edit", tool_input: { file_path: path.join(repo, "src/b.ts") } };
  assert.equal(decide(input, repo, loadConfig(repo), null, null, { unreadable: true }).deny, false);
  assert.equal(edit(planned("pb-c7-plan", "src/a.ts", { playbook: "plan" }), "src/b.ts"), null);
  const inv = committed("pb-c7-inv");
  cli(inv, "open", "pb-c7-inv", "investigation");
  assert.equal(edit(inv, "src/b.ts"), null);
});

test("C8 happy: an old run keeps the growth limit only, and gate plan add is refused there, naming gate note plan", () => {
  const repo = committed("pb-c8");
  cli(repo, "open", "pb-c8", "feature");
  asOldRun(repo);
  readyToEdit(repo, { plan: ["--files", "src/a.ts"] });
  assert.equal(edit(repo, "src/b.ts"), null);
  assert.match(refused(repo, "plan", "add", "src/b.ts", "why"), /gate note plan/);
});

test("C9 refused: gate plan add with no reason, a folder, a glob, a path outside the repo or past 40 code files records nothing", () => {
  const repo = planned("pb-c9");
  refused(repo, "plan", "add", "src/b.ts");
  for (const bad of ["src", "src/", "src/*.ts", "../elsewhere.ts"]) refused(repo, "plan", "add", bad, "a reason");
  const many = Array.from({ length: 39 }, (_, i) => `src/m${i}.ts`).join(",");
  cli(repo, "note", "plan", "Many files.", "--files", many);
  assert.match(refused(repo, "plan", "add", "src/x.ts,src/y.ts", "two more"), /40/);
  assert.equal(ledgerOf(repo).planAdds ?? undefined, undefined, "a refused add recorded something");
});

test("C10 idempotent: adding a file already planned adds nothing", () => {
  const repo = planned("pb-c10");
  cli(repo, "plan", "add", "src/a.ts", "again");
  assert.equal(ledgerOf(repo).planAdds ?? undefined, undefined);
  cli(repo, "plan", "add", "src/b.ts", "once");
  cli(repo, "plan", "add", "src/b.ts", "twice");
  assert.equal(ledgerOf(repo).planAdds.length, 1);
});

test("C11 happy: an addition that grows the plan to standard gives the skeptic step back and, before code, holds edits for the check", () => {
  const repo = planned("pb-c11");
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "skeptic").state, "N/A", "premise: tiny");
  cli(repo, "plan", "add", "src/app/page.tsx", "the badge renders there");
  const l = ledgerOf(repo);
  assert.equal(l.tier.predicted, "standard");
  assert.equal(l.steps.find((s) => s.key === "skeptic").state, null);
  assert.match(edit(repo, "src/a.ts") ?? "", /plan check/);
});

test("C12 happy: a 35-file list works through --files", () => {
  const many = Array.from({ length: 35 }, (_, i) => `src/m${i}.ts`).join(",");
  const repo = planned("pb-c12", many);
  assert.equal(ledgerOf(repo).tier.predictedFiles.length, 35);
});

test("C13 refused: --files takes files only: src/, src/** and the folder src are refused; a new file and ./src/a.ts are not", () => {
  const repo = planned("pb-c13");
  for (const bad of ["src/", "src/**", "src"]) assert.match(refused(repo, "note", "plan", "p", "--files", bad), /folder|pattern/, bad);
  cli(repo, "note", "plan", "p", "--files", "./src/a.ts,src/brand-new.ts");
  assert.deepEqual(ledgerOf(repo).tier.predictedFiles, ["src/a.ts", "src/brand-new.ts"]);
});

test("C14 edge: --size alone keeps the planned files", () => {
  const repo = planned("pb-c14", "src/a.ts,src/b.ts");
  cli(repo, "note", "plan", "Same files, declared large.", "--size", "large");
  assert.deepEqual(ledgerOf(repo).tier.predictedFiles, ["src/a.ts", "src/b.ts"]);
});

test("C15 refused: after code changed a note cannot add or remove a file; the same set, --size alone and a pre-code change are allowed", () => {
  const before = planned("pb-c15-before");
  cli(before, "note", "plan", "Two files.", "--files", "src/a.ts,src/b.ts");

  const repo = planned("pb-c15");
  edited(repo, "src/a.ts");
  assert.match(refused(repo, "note", "plan", "More.", "--files", "src/a.ts,src/b.ts"), /gate plan add/);
  const two = planned("pb-c15-two", "src/a.ts,src/b.ts");
  edited(two, "src/a.ts");
  assert.match(refused(two, "note", "plan", "Less.", "--files", "src/a.ts"), /gate plan add/);
  cli(two, "note", "plan", "Same.", "--files", "src/b.ts,src/a.ts");
  cli(two, "note", "plan", "Declared.", "--size", "standard");
  cli(two, "note", "plan", "Words only.");
  assert.deepEqual([...ledgerOf(two).tier.predictedFiles].sort(), ["src/a.ts", "src/b.ts"]);
});

test("C16 reported-surface: the reviewer's packet and both reports show each added file and its reason", () => {
  const repo = planned("pb-c16");
  cli(repo, "plan", "add", "src/b.ts", "the helper a.ts calls lives there");
  edited(repo, "src/b.ts");
  const packet = /packet: (\S+)/.exec(cli(repo, "brief", "reviewer"))[1];
  const text = readFileSync(packet, "utf8");
  assert.match(text, /## Plan additions\n+- src\/b\.ts — the helper a\.ts calls lives there/);
  const forYou = cli(repo, "report", "--brief").split("\n").find((l) => l.startsWith("For you:")) ?? "";
  assert.match(forYou, /src\/b\.ts/);
  assert.match(forYou, /the helper a\.ts calls lives there/);
  assert.match(cli(repo, "report"), /added to the plan: src\/b\.ts — the helper a\.ts calls lives there/);
});

test("C18 reported-surface: the shell growth refusal names gate plan add on a run under the new rules; help and the implement hint name it", () => {
  const files = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`src/m${i}.ts`, `export const m${i} = 0;\n`]));
  const repo = planned("pb-c18", "src/m0.ts,src/m1.ts,src/m2.ts", { extra: files });
  for (let i = 0; i < 13; i++) writeFileSync(path.join(repo, `src/m${i}.ts`), `export const m${i} = 1;\n`);
  cli(repo, "check");
  const why = fence(repo, "Bash", { command: "echo x > src/m13.ts" });
  assert.match(why ?? "", /outside this task's plan/, why);
  assert.match(why, /gate plan add/);
  assert.doesNotMatch(why, /gate note plan/);
  assert.match(cli(repo, "help"), /plan add <a,b> "<why>"/);
  assert.match(readFileSync(new URL("../scripts/lib/next.mjs", import.meta.url), "utf8").split("\n").find((l) => /^\s*implement:/.test(l)), /gate plan add/);
});

test("C19 refused: an unplanned package.json edit is refused like code; config files stay code until the diff check's numbers say otherwise", () => {
  assert.match(edit(planned("pb-c19"), "package.json") ?? "", NOT_PLANNED);
});

test("C20 edge: the lead's shell write to an unplanned file under the growth limit is left to the diff check", () => {
  assert.equal(fence(planned("pb-c20"), "Bash", { command: "echo x > src/b.ts" }), null);
});

test("C21 refused: an empty --files value is refused on a run under the new rules and the list is kept", () => {
  const repo = planned("pb-c21");
  assert.match(refused(repo, "note", "plan", "p", "--files", ""), /leave --files out/);
  assert.deepEqual(ledgerOf(repo).tier.predictedFiles, ["src/a.ts"]);
});

test("C22 edge: a run with no Plan yet is told to write the Plan, not to add files to it", () => {
  const repo = committed("pb-c22");
  cli(repo, "open", "pb-c22", "feature");
  const why = edit(repo, "src/b.ts");
  assert.match(why ?? "", /Plan \(`gate note plan`\)/, why);
  assert.doesNotMatch(why, /gate plan add/);
});

test("C23 edge: the fence and gate stats read one rule for what is outside the plan", async () => {
  const { outsidePlan } = await import("../scripts/lib/size.mjs");
  const repo = planned("pb-c23");
  const config = loadConfig(repo);
  const changed = ["src/a.ts", "SRC/A.ts", "src/b.ts", "tests/a.test.ts", "notes.txt", "docs/notes.md", "package.json"];
  const outside = outsidePlan(["src/a.ts"], changed, config);
  assert.deepEqual(outside, [...(IGNORE_CASE ? [] : ["SRC/A.ts"]), "src/b.ts", "package.json"]);
  for (const rel of changed) assert.equal(Boolean(edit(repo, rel)), outside.includes(rel), rel);
});

test("C15 edge: a plan that named no files may still name them once code changed (a late plan)", () => {
  const repo = committed("pb-c15-late");
  cli(repo, "open", "pb-c15-late", "feature");
  edited(repo, "src/a.ts");
  readyToEdit(repo, { plan: ["--files", "src/a.ts"] });
  assert.deepEqual(ledgerOf(repo).tier.predictedFiles, ["src/a.ts"]);
});

test("C10 idempotent: a repeated --files entry is the same set, one add of two spellings records one file where case is ignored, and an empty add names no file", () => {
  const repo = planned("pb-c10-dup", "src/a.ts,src/b.ts");
  edited(repo, "src/a.ts");
  cli(repo, "note", "plan", "Same.", "--files", "src/a.ts,src/b.ts,src/a.ts");
  cli(repo, "plan", "add", "src/c.ts,SRC/C.ts", "the third module");
  assert.deepEqual(ledgerOf(repo).planAdds[0].files, IGNORE_CASE ? ["src/c.ts"] : ["src/c.ts", "SRC/C.ts"]);
  assert.match(refused(repo, "plan", "add", ",", "why"), /names no file/);
});
