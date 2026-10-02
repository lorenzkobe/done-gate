// measure-and-click: count from open, ignore whitespace-only lines, leave out other
// sessions' commits, warn the lead at the edit that crosses into the delegated size, click
// cases, and a caveats line. Written from the task's case table (C3-C5, C7-C12, C14-C28),
// blind to the implementation.
//
// Sources of truth for the literals asserted here:
//   piece cap 400, standard.maxLines 400, delegatesAt large ... models.json policy
//   the silent hook output ..................................... scripts/lib/events.mjs SILENT
//   "(line-delta estimate)", "measured <tier>: n files, n lines" scripts/lib/size.mjs renderTierBlock
//   "(unreliable for this task: ..." ........................... scripts/lib/brief.mjs unifiedDiff
//   "case(s) not closed: ..." .................................. scripts/lib/rules.mjs R8
//   chrome tool names and tool_input shapes .................... the lead's notes for this task
//   base/<rel>, baseline.based, ledger.foreign, case.event,
//   "Caveats:", "other commits", additionalContext ............. the Plan and the lead's notes

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, here } from "./helpers.mjs";
import { ensureSession, loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { appendEvents, eventsFromHookInput, nextSeq, readEvents } from "../scripts/lib/events.mjs";
import { loadPolicy } from "../scripts/lib/size.mjs";
import { CASE_KINDS } from "../scripts/lib/verbs.mjs";
import { isDraft, isPartial, parseFindings, parseReplies } from "../scripts/lib/rules.mjs";

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env: envFor(repo) });
const REFUSAL = /^done-gate: /m;
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r.stdout;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  return r.stderr;
}
const check = (repo) => cli(repo, "check");
const blocks = (out, rule) => out.split("\n").some((l) => new RegExp(`\\b${rule}\\b`).test(l));
const ruleLine = (out, rule) => out.split("\n").find((l) => new RegExp(`\\b${rule}\\b`).test(l)) ?? "";
const openCasesLine = (out) => out.split("\n").find((l) => l.includes("case(s) not closed")) ?? "";

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", (({ current, lastClosed }) => current ?? lastClosed)(loadSession(stateDir(repo), "S1")));
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const eventsOf = (repo) => readEvents(stateDir(repo), "S1");
const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const commitArgs = ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm"];
const lines = (n, name) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`).join("\n") + "\n";

const GATE_JSON = { source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"] };
const CONTEXT = "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local";

function committed(name, files = {}, config = GATE_JSON) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify(config, null, 2), "src/b.ts": lines(10, "b"), ...files });
  git(repo, ["add", "-A"]);
  git(repo, [...commitArgs, "init"]);
  return repo;
}
function openRun(repo, slug, { files = "src/a.ts,src/b.ts", playbook = "feature" } = {}) {
  cli(repo, "open", [slug, playbook]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  return cli(repo, "note", ["plan", "The plan.", "--files", files]);
}
function opened(name, { files, playbook, extra = {}, config = GATE_JSON } = {}) {
  const repo = committed(name, extra, config);
  openRun(repo, name, { files, playbook });
  return repo;
}

// A hook payload piped to a hook verb; the parsed stdout, or null when the hook printed nothing.
function hook(repo, payload, { verb = "log", env = envFor(repo) } = {}) {
  const r = spawnSync(process.execPath, [gate, verb], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}
const SILENT = { continue: true, suppressOutput: true };
const agentOf = (agent) => (agent ? { agent_id: "A1", agent_type: agent } : {});
// An edit as Claude Code reports it after the bytes landed.
function edit(repo, rel, content, { agent = null, env } = {}) {
  write(repo, rel, content);
  return hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_output: "ok", ...agentOf(agent) }, { env });
}
const command = (repo, cmd, { agent = null, exit = null, env } = {}) =>
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, ...(exit === null ? {} : { tool_response: { exitCode: exit } }), ...agentOf(agent) }, { env });
const chrome = (repo, short, tool_input, { agent = null } = {}) =>
  hook(repo, { hook_event_name: "PostToolUse", tool_name: `mcp__claude-in-chrome__${short}`, tool_input, tool_output: "ok", ...agentOf(agent) });
const click = (repo, ref, opts) => chrome(repo, "computer", { action: "left_click", ref }, opts);
const lastBrowser = (repo) => eventsOf(repo).filter((e) => e.kind === "browser").pop();

// `gate size`, read back: the measured line and the per-file rows of its files: line.
function sizeOf(repo) {
  const out = cli(repo, "size");
  const m = /measured (\w+): (\d+) files?, (\d+) lines?/.exec(out);
  const filesLine = out.split("\n").find((l) => l.startsWith("files: ")) ?? "files: ";
  const rows = {};
  for (const cell of filesLine.slice(7).split(" · ").filter(Boolean)) {
    const x = /^(.*?) (\d+)( \(.*\))?$/.exec(cell);
    assert.ok(x, `unreadable files cell ${JSON.stringify(cell)} in:\n${out}`);
    rows[x[1]] = { lines: Number(x[2]), estimate: /estimate/.test(x[3] ?? "") };
  }
  return { out, tier: m?.[1] ?? null, files: m ? Number(m[2]) : null, lines: m ? Number(m[3]) : null, rows };
}
const packetOf = (out) => readFileSync(out.split("\n").find((l) => l.startsWith("packet: ")).slice(8), "utf8");
const basedOf = (repo) => ledgerOf(repo).baseline.based;
const baseCopy = (repo, rel) => path.join(runDir(repo), "base", `${rel}.base`);
const foreignOf = (repo) => (ledgerOf(repo).foreign ?? []).map((f) => (typeof f === "string" ? f : f.path));
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// Another session's commit: the bytes land and are committed with no hook event in S1.
function otherCommit(repo, rel, content) {
  write(repo, rel, content);
  git(repo, ["add", rel]);
  git(repo, [...commitArgs, "other session"]);
}

// A git on PATH that logs each call's arguments and then runs the real one.
function gitShim(repo, name) {
  const dir = path.join(here, ".tmp", `${name}-shim`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const log = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${real}" "$@"\n`);
  chmodSync(path.join(dir, "git"), 0o755);
  const env = { ...envFor(repo), PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const reset = () => rmSync(log, { force: true });
  return { env, calls, reset };
}
const diffCalls = (calls) => calls.filter((c) => /(^|\s)diff(\s|$)/.test(c));

const reviewFile = (n) => `# Review ${n} — x\n\n## Act on\n- none\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: npm test exit 0\n`;
function reviewRound(repo, files) {
  const out = cli(repo, "brief", files ? ["reviewer", "--files", files] : ["reviewer"]);
  const own = /Your file is .*\/(review-\d+\.md)/.exec(out)[1];
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "A-reviewer", agent_type: "done-gate:reviewer" });
  writeFileSync(path.join(runDir(repo), own), reviewFile(Number(/-(\d+)\.md$/.exec(own)[1])));
  cli(repo, "huddle", ["add", "reviewer", "--file", own]);
}

// ---------------------------------------------------------------------------
// count from open
// ---------------------------------------------------------------------------

test("C3 boundary: a dirty file edited between session start and open, a binary file, a file over 1 MB and the 201st dirty file get no base copy and keep the estimate", () => {
  const blob = (seed) => Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * seed) % 251));
  const repo = committed("mc-c3", { "src/ok.ts": lines(5, "ok"), "src/mid.ts": lines(5, "mid"), "src/big.ts": "export const big = 0;\n", "src/blob.bin": blob(3) });
  // dirt from before the session: the session baseline holds exactly these bytes
  const okAtOpen = lines(6, "ok");
  write(repo, "src/ok.ts", okAtOpen);
  const big = Array.from({ length: 30000 }, (_, i) => `export const big${String(i).padStart(6, "0")} = "0123456789012345678901";`).join("\n") + "\n";
  assert.ok(Buffer.byteLength(big) > 1024 * 1024, "the fixture must be over 1 MB");
  write(repo, "src/big.ts", big);
  write(repo, "src/blob.bin", blob(7));
  ensureSession(stateDir(repo), repo, "S1");
  // edited in this session before open: its content no longer equals the baseline hash
  write(repo, "src/mid.ts", lines(6, "mid"));
  openRun(repo, "mc-c3");

  const based = basedOf(repo);
  assert.ok(Array.isArray(based), `ledger.baseline.based is ${JSON.stringify(based)}`);
  assert.ok(based.includes("src/ok.ts"), `the plain dirty file is based: ${JSON.stringify(based)}`);
  assert.equal(readFileSync(baseCopy(repo, "src/ok.ts"), "utf8"), okAtOpen, "the copy is the content at open");
  for (const rel of ["src/mid.ts", "src/big.ts", "src/blob.bin"]) {
    assert.ok(!based.includes(rel), `${rel} must not be based`);
    assert.equal(existsSync(baseCopy(repo, rel)), false, `${rel} must have no base copy`);
  }

  write(repo, "src/ok.ts", okAtOpen.replace("ok2 = 2", "ok2 = 22"));
  write(repo, "src/mid.ts", lines(6, "mid").replace("mid2 = 2", "mid2 = 22"));
  write(repo, "src/big.ts", `${big}export const tail = 1;\n`);
  write(repo, "src/blob.bin", blob(11));
  const { rows, out } = sizeOf(repo);
  assert.deepEqual(rows["src/ok.ts"], { lines: 2, estimate: false }, out);
  assert.deepEqual(rows["src/mid.ts"], { lines: 1, estimate: true }, out);
  assert.deepEqual(rows["src/big.ts"], { lines: 1, estimate: true }, out);
  assert.deepEqual(rows["src/blob.bin"], { lines: 1, estimate: true }, out);

  // 201 eligible dirty files: 200 are based, one keeps the estimate
  const names = Array.from({ length: 201 }, (_, i) => `src/d/f${String(i).padStart(3, "0")}.ts`);
  const many = committed("mc-c3-many", Object.fromEntries(names.map((f) => [f, "export const x = 1;\n"])));
  for (const f of names) write(many, f, "export const x = 2;\n");
  openRun(many, "mc-c3-many");
  const manyBased = basedOf(many);
  assert.equal(manyBased?.length, 200, "at most 200 files are based");
  assert.equal(filesUnder(path.join(runDir(many), "base")).length, 200);
  const left = names.filter((f) => !manyBased.includes(f));
  assert.equal(left.length, 1);
  write(many, left[0], "export const x = 3;\n");
  write(many, manyBased[0], "export const x = 3;\n");
  const sized = sizeOf(many);
  assert.deepEqual(sized.rows[left[0]], { lines: 1, estimate: true }, sized.out);
  assert.deepEqual(sized.rows[manyBased[0]], { lines: 2, estimate: false }, sized.out);
});

test("C4 edge: a slop line added before open in a dirty file is not reported; one added after open is", () => {
  const repo = committed("mc-c4", { "src/s.ts": "export const s = 1;\n" }, { source: ["src/**"], tests: ["tests/**"], verify: ["true"] });
  write(repo, "src/s.ts", "export const s = 1;\n// ===== OLD =====\n");
  cli(repo, "open", ["mc-c4", "feature"]);
  const r10 = (out) => out.split("\n").filter((l) => /\bR10\b/.test(l));
  assert.deepEqual(r10(check(repo)), [], "nothing changed since open");

  write(repo, "src/s.ts", "export const s = 1;\n// ===== OLD =====\n// Step 1: go\n");
  const hits = r10(check(repo));
  assert.equal(hits.length, 1, check(repo));
  assert.match(hits[0], /slop: 1 slop line/);
  assert.match(hits[0], /src\/s\.ts:3 step narration/);
  assert.doesNotMatch(hits[0], /OLD|src\/s\.ts:2/);
});

test("C5 refused: a shell command or an edit-tool write naming <run>/base/ is refused by the fence; reading it and editing source are not", () => {
  const repo = opened("mc-c5", { files: "src/a.ts" });
  const fence = (payload) => {
    const out = hook(repo, { hook_event_name: "PreToolUse", ...payload }, { verb: "fence" });
    if (out === null) return null;
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    return out.hookSpecificOutput.permissionDecisionReason;
  };
  const copy = baseCopy(repo, "src/a.ts");
  const rel = path.relative(repo, copy).split(path.sep).join("/");
  assert.match(rel, /^\.claude\/gate\/runs\/[^/]+\/base\/src\/a\.ts\.base$/);

  assert.ok(fence({ tool_name: "Write", tool_input: { file_path: copy } }), "Write");
  assert.ok(fence({ tool_name: "Edit", tool_input: { file_path: copy } }), "Edit");
  assert.ok(fence({ tool_name: "Bash", tool_input: { command: `echo x > ${rel}` } }), "shell redirect");
  assert.ok(fence({ tool_name: "Bash", tool_input: { command: `cp src/a.ts ${rel}` } }), "shell cp");
  // the directory itself, named with no trailing slash
  const baseDir = rel.slice(0, rel.indexOf("/base/") + "/base".length);
  assert.ok(fence({ tool_name: "Bash", tool_input: { command: `rm -rf ${baseDir}` } }), "rm -rf of the directory");
  assert.ok(fence({ tool_name: "Bash", tool_input: { command: `mv ${baseDir} /tmp/gone` } }), "mv of the directory");
  assert.ok(fence({ tool_name: "Bash", tool_input: { command: `cp -r /tmp/forged ${baseDir}` } }), "cp -r onto the directory");
  assert.ok(fence({ tool_name: "Bash", tool_input: { command: `rm -rf "${baseDir}"` } }), "quoted");
  for (const cmd of [`rm -rf ${baseDir}; true`, `rm -rf ${baseDir}&& ls`, `rm -rf ${baseDir}|| true`, `(mv ${baseDir} /tmp/gone)`]) {
    assert.ok(fence({ tool_name: "Bash", tool_input: { command: cmd } }), cmd);
  }
  assert.equal(fence({ tool_name: "Bash", tool_input: { command: `ls ${baseDir}` } }), null, "listing the directory is fine");
  assert.equal(fence({ tool_name: "Bash", tool_input: { command: `touch ${baseDir}line.txt` } }), null, "a name that only starts with base is not the copies");

  assert.equal(fence({ tool_name: "Bash", tool_input: { command: `cat ${rel}` } }), null, "reading a copy is fine");
  assert.equal(fence({ tool_name: "Edit", tool_input: { file_path: path.join(repo, "src/a.ts") } }), null, "source stays writable");
});

test("C19 reported-surface: a run closes leaving 300 uncommitted lines in a tracked file; a second run in the same session edits 3 lines: gate size counts 3, the packet shows only those, the cap does not refuse", () => {
  const repo = committed("mc-c19");
  const dirty = lines(320, "a"); // makeRepo's 20 lines plus 300 uncommitted
  write(repo, "src/a.ts", dirty);

  // run 1: a one-line change elsewhere, closed clean, the 300 lines still uncommitted
  openRun(repo, "first", { files: "src/b.ts" });
  cli(repo, "case", ["add", "b changes", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--na", "covered by the existing fixture"]);
  edit(repo, "src/b.ts", lines(10, "b").replace("b0 = 0", "b0 = 100"));
  edit(repo, "tests/a.test.ts", "test('a', () => { /* b0 */ });\n");
  cli(repo, "verify");
  check(repo);
  for (const step of ledgerOf(repo).steps) {
    if (step.state !== null || step.key === "close") continue;
    cli(repo, "step", [step.key ?? String(step.n), "na", "not needed for a one-line change"]);
  }
  const closing = run(repo, "close");
  assert.equal(ledgerOf(repo).status, "closed", `run 1 did not close:\n${closing.stdout}${closing.stderr}`);
  assert.equal(git(repo, ["diff", "--numstat", "HEAD", "--", "src/a.ts"]).split("\t")[0], "300", "300 lines are still uncommitted");

  // run 2, same session
  openRun(repo, "second", { files: "src/a.ts" });
  cli(repo, "case", ["add", "three more constants", "--kind", "happy"]);
  assert.ok(basedOf(repo)?.includes("src/a.ts"), `src/a.ts is based: ${JSON.stringify(basedOf(repo))}`);
  assert.equal(readFileSync(baseCopy(repo, "src/a.ts"), "utf8"), dirty);

  edit(repo, "src/a.ts", dirty + lines(3, "z"));
  const size = sizeOf(repo);
  assert.equal(size.files, 1, size.out);
  assert.equal(size.lines, 3, size.out);
  assert.deepEqual(size.rows["src/a.ts"], { lines: 3, estimate: false }, size.out);
  assert.doesNotMatch(size.out, /estimate/);

  const packet = packetOf(cli(repo, "brief", ["reviewer"]));
  assert.ok(packet.includes("diff --git a/src/a.ts b/src/a.ts"), "the header names the repo path");
  for (const l of ["+export const z0 = 0;", "+export const z1 = 1;", "+export const z2 = 2;"]) assert.ok(packet.includes(l), `${l} is missing`);
  assert.ok(!packet.includes("+export const a150 = 150;"), "the earlier run's lines are not shown as added");
  assert.ok(!packet.includes("unreliable for this task"), "a based file's diff is not marked unreliable");
});

test("C20 edge: an untracked file whose baseline entry matches its content at open is measured by what changed; one created this session before open is counted whole", () => {
  const repo = committed("mc-c20");
  write(repo, "src/u.ts", lines(10, "u")); // untracked, from before the session
  ensureSession(stateDir(repo), repo, "S1");
  write(repo, "src/v.ts", lines(10, "v")); // untracked, created in this session before open
  openRun(repo, "mc-c20", { files: "src/u.ts,src/v.ts" });

  assert.ok(basedOf(repo)?.includes("src/u.ts"), JSON.stringify(basedOf(repo)));
  assert.ok(!basedOf(repo).includes("src/v.ts"));
  assert.equal(existsSync(baseCopy(repo, "src/v.ts")), false);

  write(repo, "src/u.ts", lines(10, "u").replace("u3 = 3", "u3 = 33")); // one line replaced: 1 added, 1 deleted
  const size = sizeOf(repo);
  assert.deepEqual(size.rows["src/u.ts"], { lines: 2, estimate: false }, size.out);
  assert.deepEqual(size.rows["src/v.ts"], { lines: 10, estimate: true }, size.out);
  assert.equal(size.lines, 12, size.out);
});

test("C23 edge: a based file measured through --no-index is not treated as a rename; a based file deleted after open counts the lines of its copy", () => {
  const repo = committed("mc-c23");
  write(repo, "src/a.ts", lines(25, "a"));
  write(repo, "src/b.ts", lines(30, "b"));
  openRun(repo, "mc-c23");
  assert.deepEqual([...(basedOf(repo) ?? [])].sort(), ["src/a.ts", "src/b.ts"]);

  write(repo, "src/a.ts", lines(25, "a").replace("a3 = 3", "a3 = 33"));
  rmSync(path.join(repo, "src/b.ts"));
  const size = sizeOf(repo);
  assert.deepEqual(Object.keys(size.rows).sort(), ["src/a.ts", "src/b.ts"], size.out);
  assert.deepEqual(size.rows["src/a.ts"], { lines: 2, estimate: false }, size.out);
  assert.equal(size.rows["src/b.ts"].lines, 30, size.out);
  assert.equal(size.files, 2, size.out);
  assert.equal(size.lines, 32, size.out);
  assert.doesNotMatch(size.out, /base\/|=>/, "no rename form and no copy path in the output");
});

test("C18 boundary: a ledger from before this change (no baseline.based, browser events with no action) sizes, briefs and checks as before", () => {
  const repo = committed("mc-c18", {}, { ...GATE_JSON, ui: ["src/app/**"] });
  write(repo, "src/a.ts", lines(21, "a"));
  openRun(repo, "mc-c18", { files: "src/a.ts,src/app/page.tsx" });
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  const dir = runDir(repo);
  const ledger = loadLedger(dir);
  delete ledger.baseline.based;
  saveLedger(dir, ledger);
  rmSync(path.join(dir, "base"), { recursive: true, force: true });

  write(repo, "src/a.ts", lines(23, "a"));
  const size = sizeOf(repo);
  assert.deepEqual(size.rows["src/a.ts"], { lines: 2, estimate: true }, size.out);
  assert.ok(packetOf(cli(repo, "brief", ["reviewer"])).includes("(unreliable for this task: "), "the old note stays for a ledger with no base copies");

  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  assert.ok(blocks(check(repo), "R4"));
  appendEvents(stateDir(repo), "S1", [{ seq: nextSeq(), ts: new Date().toISOString(), session: "S1", agent: null, agentType: null, kind: "browser", tool: "mcp__claude-in-chrome__computer" }]);
  assert.ok(!blocks(check(repo), "R4"), "a browser event with no action still drives R4");

  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:a"]);
  const row = ledgerOf(repo).cases[0];
  assert.equal(row.status, "closed");
  assert.equal(row.test, "tests/a.test.ts:a");
  assert.doesNotMatch(openCasesLine(check(repo)), /\bC1\b/);
});

// ---------------------------------------------------------------------------
// whitespace
// ---------------------------------------------------------------------------

const indented = (text, pad) => text.split("\n").map((l) => (l ? `${pad}${l}` : l)).join("\n");

// src/a.ts: 50 lines re-indented (100 changed lines, whitespace only) plus 350 new lines.
function wsRepo(name) {
  const repo = opened(name, { extra: { "src/a.ts": lines(50, "a") } });
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  edit(repo, "src/a.ts", indented(lines(50, "a"), "  ") + lines(350, "n"));
  return repo;
}

test("C7 boundary: a piece of 450 changed lines of which 100 are whitespace-only is accepted by the 400 cap; 450 real lines are refused", () => {
  assert.equal(loadPolicy().reviewMaxLines, 400);
  const repo = wsRepo("mc-c7");
  const stat = git(repo, ["diff", "--numstat", "HEAD", "--", "src/a.ts"]).split("\t");
  assert.equal(Number(stat[0]) + Number(stat[1]), 450, "the fixture is a 450-line change");
  assert.match(cli(repo, "brief", ["reviewer"]), /^packet: /m);

  const real = opened("mc-c7-real", { extra: { "src/a.ts": lines(50, "a") } });
  edit(real, "src/a.ts", lines(50, "q") + lines(350, "n"));
  assert.match(refused(real, "brief", ["reviewer"]), /450 changed lines/);
});

test("C24 boundary: gate brief reviewer and the piece R5 prints agree: a file whose non-whitespace changed lines fit the cap is one piece in both", () => {
  const repo = wsRepo("mc-c24");
  const r5 = ruleLine(check(repo), "R5");
  assert.ok(r5, "R5 asks for a review of the change");
  assert.doesNotMatch(r5, /src\/a\.ts:\d+-\d+/, `R5 must not slice a file that fits the cap:\n${r5}`);
  reviewRound(repo, "src/a.ts");
  assert.ok(!blocks(check(repo), "R5"), `one clean round on the whole file covers it:\n${check(repo)}`);
});

test("C21 reported-surface: re-indenting 100 lines of a .ts file plus one real line measures 1 line; the same in a .py file measures every line; the packet shows the re-indented lines in both", () => {
  const py = Array.from({ length: 100 }, (_, i) => `x${i} = ${i}`).join("\n") + "\n";
  const repo = opened("mc-c21", { files: "src/w.ts,src/p.py", extra: { "src/w.ts": lines(100, "w"), "src/p.py": py }, config: { source: ["src/**"], tests: ["tests/**"], verify: ["true"] } });
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  edit(repo, "src/w.ts", `${indented(lines(100, "w"), "  ")}export const extra = 1;\n`);
  edit(repo, "src/p.py", `${indented(py, "    ")}extra = 1\n`);

  const size = sizeOf(repo);
  assert.deepEqual(size.rows["src/w.ts"], { lines: 1, estimate: false }, size.out);
  assert.deepEqual(size.rows["src/p.py"], { lines: 201, estimate: false }, size.out);
  assert.equal(size.lines, 202, size.out);

  // one packet per file: together the two diffs are past the packet's inline diff cap
  const ts = packetOf(cli(repo, "brief", ["reviewer", "--files", "src/w.ts"]));
  assert.ok(ts.includes("+  export const w5 = 5;"), "the .ts re-indent is shown");
  assert.ok(ts.includes("-export const w5 = 5;"));
  assert.ok(ts.includes("+export const extra = 1;"));
  const pyPacket = packetOf(cli(repo, "brief", ["reviewer", "--files", "src/p.py"]));
  assert.ok(pyPacket.includes("+    x5 = 5"), "the .py re-indent is shown");
  assert.ok(pyPacket.includes("-x5 = 5"));
});

// ---------------------------------------------------------------------------
// other sessions' commits
// ---------------------------------------------------------------------------

const SLOPPY = "// ===== ROUTES =====\nexport const o = 1;\n";

test("C8 reported-surface: another session commits a file this run never edited: it is not sized, not scanned for slop, and the report says 1 file from other commits was left out", () => {
  const repo = opened("mc-c8");
  edit(repo, "src/a.ts", lines(21, "a"));
  otherCommit(repo, "src/other.ts", SLOPPY);

  const out = check(repo);
  assert.doesNotMatch(out, /src\/other\.ts/, "no rule names the other session's file");
  assert.deepEqual(foreignOf(repo), ["src/other.ts"]);
  const size = sizeOf(repo);
  assert.deepEqual(Object.keys(size.rows), ["src/a.ts"], size.out);
  assert.equal(size.files, 1, size.out);
  assert.equal(size.lines, 1, size.out);

  const line = cli(repo, "report").split("\n").find((l) => l.includes("other commits"));
  assert.ok(line, "the report has no line about other commits");
  assert.match(line, /\b1 file\b/);
});

test("C9 refused: when this run itself ran git commit, or the moved file has an edit event from this run, or the file is dirty against the new HEAD, nothing is left out", () => {
  const kept = (repo, why) => {
    const out = check(repo);
    assert.deepEqual(foreignOf(repo), [], why);
    const size = sizeOf(repo);
    assert.ok("src/other.ts" in size.rows, `${why}: src/other.ts is still sized\n${size.out}`);
    assert.match(ruleLine(out, "R10"), /src\/other\.ts:1 banner/, `${why}: still scanned`);
    assert.doesNotMatch(cli(repo, "report"), /other commits/, why);
  };

  const own = opened("mc-c9-own");
  otherCommit(own, "src/other.ts", SLOPPY);
  command(own, "git commit -qm wip", { exit: 0 });
  kept(own, "this run ran git commit");

  const edited = opened("mc-c9-edited");
  edit(edited, "src/other.ts", SLOPPY);
  git(edited, ["add", "src/other.ts"]);
  git(edited, [...commitArgs, "someone commits it"]);
  kept(edited, "this run edited the file");

  const dirty = opened("mc-c9-dirty");
  otherCommit(dirty, "src/other.ts", SLOPPY);
  write(dirty, "src/other.ts", `${SLOPPY}export const more = 2;\n`);
  kept(dirty, "the file is dirty against the new HEAD");
});

test("C25 reported-surface: after another session's commit is absorbed, gate check shows no R4, R5 or R16 for it, lastSourceChangeSeq is unchanged and ledger.foreign lists the file", () => {
  const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i + 1}.ts`);
  const repo = opened("mc-c25", { files: LARGE.join(","), extra: Object.fromEntries(LARGE.map((f) => [f, "export const x = 1;\n"])), config: { ...GATE_JSON, ui: ["src/app/**"] } });
  assert.equal(ledgerOf(repo).tier.predicted, "large");
  const before = ledgerOf(repo).lastSourceChangeSeq;

  otherCommit(repo, "src/app/page.tsx", "export default () => 1;\n");
  command(repo, "ls src", { exit: 0 }); // the next lead tool call: the hook stamps here
  assert.equal(ledgerOf(repo).lastSourceChangeSeq, before, "the hook did not date a change this run did not make");

  const out = check(repo);
  for (const rule of ["R4", "R5", "R16"]) assert.ok(!blocks(out, rule), `${rule} must stay quiet:\n${out}`);
  const ledger = ledgerOf(repo);
  assert.equal(ledger.lastSourceChangeSeq, before);
  assert.deepEqual(ledger.unexplainedChanges ?? [], []);
  assert.deepEqual(foreignOf(repo), ["src/app/page.tsx"]);
});

test("C26 refused: a file this run changed through the shell and someone else then committed is kept; a git commit at character 250 of a long command still counts as a git write by this run", () => {
  const shell = opened("mc-c26-shell");
  command(shell, "sed -i '' s/1/2/ src/a.ts", { exit: 0 });
  write(shell, "src/a.ts", lines(21, "a"));
  check(shell);
  assert.equal(ledgerOf(shell).unexplainedChanges?.length, 1, "the shell edit is recorded as unexplained");
  git(shell, ["add", "src/a.ts"]);
  git(shell, [...commitArgs, "someone commits it"]);
  check(shell);
  assert.deepEqual(foreignOf(shell), []);
  assert.deepEqual(sizeOf(shell).rows["src/a.ts"], { lines: 1, estimate: false });

  const long = opened("mc-c26-long");
  otherCommit(long, "src/other.ts", SLOPPY);
  const cmd = `echo ${"x".repeat(245)} && git commit -qm wip`;
  assert.equal(cmd.indexOf("git commit"), 254);
  command(long, cmd, { exit: 0 });
  const ev = eventsOf(long).filter((e) => e.kind === "command").pop();
  assert.equal(ev.cmd.length, 200, "the stored command is still cut to 200 characters");
  assert.equal(ev.git, true, "the event records the git write from the full text");
  check(long);
  assert.deepEqual(foreignOf(long), []);
  assert.ok("src/other.ts" in sizeOf(long).rows);
});

test("C29 edge: another session's uncommitted edit seen at a read-only call of this run is still absorbed once committed; the same file written by this run's sed is kept", () => {
  const seen = opened("mc-c29-seen");
  write(seen, "src/other.ts", SLOPPY); // the other session, not yet committed
  command(seen, "ls src", { exit: 0 }); // this run's hook fires in between
  const entry = ledgerOf(seen).unexplainedChanges?.[0];
  assert.deepEqual(entry?.paths, ["src/other.ts"], JSON.stringify(entry));
  assert.equal(entry.writes, false);
  const stamped = ledgerOf(seen).lastSourceChangeSeq;
  assert.ok(stamped > 0, "the hook dated the change before it could know whose it was");
  git(seen, ["add", "src/other.ts"]);
  git(seen, [...commitArgs, "other session"]);
  const out = check(seen);
  assert.deepEqual(foreignOf(seen), ["src/other.ts"]);
  assert.doesNotMatch(out, /src\/other\.ts/);
  assert.deepEqual(ledgerOf(seen).unexplainedChanges, [], "the entry is explained by the commit");
  assert.equal(ledgerOf(seen).lastSourceChangeSeq, 0, "and so is its stamp");
  assert.ok(!("src/other.ts" in sizeOf(seen).rows));

  const gateVerb = opened("mc-c29-gate");
  write(gateVerb, "src/other.ts", SLOPPY);
  check(gateVerb); // seen first by a gate verb: no command caused it
  assert.equal(ledgerOf(gateVerb).unexplainedChanges?.[0]?.writes, false);
  git(gateVerb, ["add", "src/other.ts"]);
  git(gateVerb, [...commitArgs, "other session"]);
  check(gateVerb);
  assert.deepEqual(foreignOf(gateVerb), ["src/other.ts"]);

  const own = opened("mc-c29-own");
  write(own, "src/other.ts", SLOPPY);
  command(own, "sed -i '' s/1/2/ src/other.ts", { exit: 0 });
  assert.equal(ledgerOf(own).unexplainedChanges?.[0]?.writes, true);
  git(own, ["add", "src/other.ts"]);
  git(own, [...commitArgs, "someone commits it"]);
  check(own);
  assert.deepEqual(foreignOf(own), [], "a file this run wrote through the shell stays this run's");
  assert.ok("src/other.ts" in sizeOf(own).rows);

  // sighted twice at read-only calls, the second time with new content, then committed
  const twice = opened("mc-c29-twice", { config: { ...GATE_JSON, ui: ["src/app/**"] } });
  write(twice, "src/app/page.tsx", "export default () => 1;\n");
  command(twice, "ls src", { exit: 0 });
  write(twice, "src/app/page.tsx", "export default () => 2;\n");
  command(twice, "git status", { exit: 0 });
  assert.equal(ledgerOf(twice).unexplainedChanges.length, 2);
  git(twice, ["add", "src/app/page.tsx"]);
  git(twice, [...commitArgs, "other session"]);
  const quietOut = check(twice);
  assert.deepEqual(foreignOf(twice), ["src/app/page.tsx"]);
  assert.deepEqual(ledgerOf(twice).unexplainedChanges, []);
  assert.equal(ledgerOf(twice).lastSourceChangeSeq, 0, "the stamp walks back past both sightings");
  for (const rule of ["R4", "R5", "R16"]) assert.ok(!blocks(quietOut, rule), `${rule} must stay quiet:\n${quietOut}`);

  // sighted once, then changed again and committed with no call of this run in between
  const late = opened("mc-c29-late", { config: { ...GATE_JSON, ui: ["src/app/**"] } });
  edit(late, "src/a.ts", lines(21, "a"));
  const stampBefore = ledgerOf(late).lastSourceChangeSeq;
  write(late, "src/app/x.tsx", "export default () => 1;\n");
  command(late, "ls src", { exit: 0 });
  assert.notEqual(ledgerOf(late).lastSourceChangeSeq, stampBefore, "the sighting was stamped");
  otherCommit(late, "src/app/x.tsx", "export default () => 2;\n");
  command(late, "git status", { exit: 0 });
  const afterHook = ledgerOf(late);
  assert.deepEqual(afterHook.foreign, ["src/app/x.tsx"]);
  assert.deepEqual(afterHook.unexplainedChanges, []);
  assert.equal(afterHook.lastSourceChangeSeq, stampBefore, "the stamp is back at this run's own edit");
  const lateOut = check(late);
  assert.deepEqual(ledgerOf(late).unexplainedChanges, []);
  assert.equal(ledgerOf(late).lastSourceChangeSeq, stampBefore);
  for (const rule of ["R4", "R16"]) assert.ok(!blocks(lateOut, rule), `${rule} must stay quiet:\n${lateOut}`);
  assert.doesNotMatch(lateOut, /x\.tsx/, "no rule names the other session's file");

  // a read-only sighting, then this run's own shell write of the same file
  const later = opened("mc-c29-later");
  write(later, "src/other.ts", SLOPPY);
  command(later, "ls src", { exit: 0 });
  write(later, "src/other.ts", `${SLOPPY}export const more = 2;\n`);
  command(later, "sed -i '' s/1/2/ src/other.ts", { exit: 0 });
  git(later, ["add", "src/other.ts"]);
  git(later, [...commitArgs, "someone commits it"]);
  check(later);
  assert.deepEqual(foreignOf(later), [], "the later shell write makes it this run's");

  // a worker's shell write is not stamped by its own hook; the lead's next read-only call must not clear it
  const worker = opened("mc-c29-worker");
  command(worker, "sed -i '' s/1/2/ src/other.ts", { exit: 0, agent: "done-gate:worker" });
  write(worker, "src/other.ts", SLOPPY);
  command(worker, "git status", { exit: 0 });
  assert.equal(ledgerOf(worker).unexplainedChanges?.[0]?.writes, true);
  git(worker, ["add", "src/other.ts"]);
  git(worker, [...commitArgs, "someone commits it"]);
  check(worker);
  assert.deepEqual(foreignOf(worker), []);

  // an entry from before paths were recorded keeps the old, conservative answer
  const legacy = opened("mc-c29-legacy");
  const dir = runDir(legacy);
  const ledger = loadLedger(dir);
  ledger.unexplainedChanges = [{ seq: 1, cmd: "ls", agentType: null }];
  saveLedger(dir, ledger);
  otherCommit(legacy, "src/other.ts", SLOPPY);
  check(legacy);
  assert.deepEqual(foreignOf(legacy), []);
});

test("C30 refused: any git subcommand that can move HEAD marks the command event; text that only mentions one does not", () => {
  const ev = (cmd) => eventsFromHookInput({ hook_event_name: "PostToolUse", session_id: "S1", tool_name: "Bash", tool_input: { command: cmd } }, "/repo")[0];
  const wrapped = ["git revert --no-edit HEAD~1", "git am < p.patch", "npm test && git commit -qm wip", "FOO=1 git -C sub cherry-pick abc", "git pull", "rtk proxy git revert --no-edit HEAD~1", 'bash -c "git add -A && git commit -m x"', "env GIT_EDITOR=true git commit -m x", "command git commit -m x", "/usr/bin/git commit -m x", "ls | xargs git checkout", "git stash"];
  for (const cmd of wrapped) assert.equal(ev(cmd).git, true, cmd);
  const gateCall = `node "${gate}" note plan "then git commit the lot" --files src/a.ts`;
  for (const cmd of [gateCall, 'grep -rn "git commit" docs', "git status", "git log --oneline | head", "git diff HEAD -- src", "echo git commit", "git stash list > /tmp/s.txt", "git worktree list > /tmp/w.txt"]) assert.equal(ev(cmd).git, undefined, cmd);
  assert.equal(ev(gateCall).readOnly, true);
  assert.equal(ev("gate generate src").readOnly, undefined, "a program that is only named gate is not the gate");

  const repo = opened("mc-c30");
  otherCommit(repo, "src/other.ts", SLOPPY);
  command(repo, "git revert --no-edit HEAD~1", { exit: 0 });
  check(repo);
  assert.deepEqual(foreignOf(repo), [], "a run that moved HEAD itself absorbs nothing");
});

test("C31 edge: a numbered list is read like a bulleted one: findings, replies, the empty marker and the draft and partial checks", () => {
  assert.deepEqual(parseFindings("## Act on\n\n1. x breaks\n2) y is missing\n\n## Consider\n- none\n").map((f) => f.text), ["x breaks", "y is missing"]);
  assert.deepEqual(parseFindings("## Act on\n1. none\n"), []);
  assert.deepEqual(parseFindings("## Act on\n1. x\n   1. a detail of x\n"), [{ text: "x" }], "a deeper item is a sub-point");
  assert.deepEqual(parseReplies("## Replies\n1. H1.1 — fixed: src/a.ts:3\n"), [{ id: "H1.1", kind: "fixed", pointer: "src/a.ts:3" }]);
  const draft = "# Review 1 — x\n\n## Act on\n1. unverified\n## Consider\n1. unverified\n## Evidence verdict\n1. tests: unverified\n";
  assert.equal(isDraft(draft), true);
  assert.equal(isPartial(draft), false);
  const partial = "# Review 1 — x\n\n## Act on\n1. x breaks\n## Consider\n1. unverified\n";
  assert.equal(isDraft(partial), false);
  assert.equal(isPartial(partial), true);
});

// ---------------------------------------------------------------------------
// the early warning
// ---------------------------------------------------------------------------

function warningOf(out) {
  assert.ok(out?.hookSpecificOutput, `the hook did not warn: ${JSON.stringify(out)}`);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  return out.hookSpecificOutput.additionalContext;
}

test("C10 happy: the lead edit that takes a standard-predicted run past 400 lines returns additionalContext naming the size and gate brief worker; the next edit is silent; a run predicted large, a test-file edit and a helper edit never warn", () => {
  const policy = loadPolicy();
  assert.equal(policy.tiers.standard.maxLines, 400);
  assert.equal(policy.delegatesAt, "large");

  const repo = opened("mc-c10");
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  assert.deepEqual(edit(repo, "src/b.ts", lines(110, "b")), SILENT, "100 lines: still standard");
  const text = warningOf(edit(repo, "src/b.ts", lines(420, "b")));
  assert.match(text, /\b410\b/, text);
  assert.match(text, /large/, text);
  assert.match(text, /gate brief worker/, text);
  assert.deepEqual(edit(repo, "src/b.ts", lines(430, "b")), SILENT, "once per run");

  const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i + 1}.ts`);
  const large = opened("mc-c10-large", { files: LARGE.join(",") });
  assert.equal(ledgerOf(large).tier.predicted, "large");
  assert.deepEqual(edit(large, "src/b.ts", lines(420, "b")), SILENT, "predicted large: the fence already says it");

  const quiet = opened("mc-c10-quiet");
  write(quiet, "src/b.ts", lines(420, "b")); // past 400 with no lead edit event
  assert.deepEqual(edit(quiet, "tests/big.test.ts", "test('x', () => {});\n".repeat(50)), SILENT, "a test-file edit");
  assert.deepEqual(edit(quiet, "src/b.ts", lines(425, "b"), { agent: "done-gate:worker" }), SILENT, "a helper edit");
  const armed = warningOf(edit(quiet, "src/b.ts", lines(430, "b")));
  assert.match(armed, /\b420\b/, armed);
});

test("C11 performance: the log hook on a non-edit tool call, with no ledger, or on an untiered playbook measures nothing and prints the silent output", () => {
  const repo = opened("mc-c11");
  const shim = gitShim(repo, "mc-c11");
  write(repo, "src/b.ts", lines(420, "b"));
  assert.deepEqual(command(repo, "npm test", { exit: 0, env: shim.env }), SILENT);
  assert.deepEqual(hook(repo, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: path.join(repo, "src/b.ts") } }, { env: shim.env }), SILENT);
  assert.deepEqual(diffCalls(shim.calls()), [], "no git diff for a non-edit tool call");
  // the shim does see a measurement when there is one
  shim.reset();
  warningOf(edit(repo, "src/b.ts", lines(421, "b"), { env: shim.env }));
  assert.equal(shim.calls().filter((c) => c.includes("--numstat")).length, 1, shim.calls().join("\n"));

  const none = committed("mc-c11-none");
  const noneShim = gitShim(none, "mc-c11-none");
  assert.deepEqual(edit(none, "src/b.ts", lines(420, "b"), { env: noneShim.env }), SILENT);
  assert.deepEqual(diffCalls(noneShim.calls()), [], "no git diff with no ledger");

  const plan = opened("mc-c11-plan", { playbook: "plan" });
  assert.equal(ledgerOf(plan).tier ?? null, null, "the plan playbook is untiered");
  const planShim = gitShim(plan, "mc-c11-plan");
  assert.deepEqual(edit(plan, "src/b.ts", lines(420, "b"), { env: planShim.env }), SILENT);
  assert.deepEqual(diffCalls(planShim.calls()), [], "no git diff on an untiered playbook");
});

test("C27 performance: the edit-hook warning leaves ledger.tier.measured untouched and a test-file edit spawns no git diff", () => {
  const repo = opened("mc-c27");
  const shim = gitShim(repo, "mc-c27");
  write(repo, "src/b.ts", lines(60, "b"));
  check(repo); // the source hash moved, so this check saves the measurement
  const measured = ledgerOf(repo).tier.measured;
  assert.equal(measured?.lines, 50, JSON.stringify(measured));

  assert.deepEqual(edit(repo, "tests/big.test.ts", "test('x', () => {});\n".repeat(500), { env: shim.env }), SILENT);
  assert.deepEqual(diffCalls(shim.calls()), [], "a test-file edit measures nothing");

  shim.reset();
  warningOf(edit(repo, "src/b.ts", lines(420, "b"), { env: shim.env }));
  assert.equal(shim.calls().filter((c) => c.includes("--numstat")).length, 1, `one numstat process:\n${shim.calls().join("\n")}`);
  assert.deepEqual(ledgerOf(repo).tier.measured, measured, "the warning does not save its measurement");
});

// ---------------------------------------------------------------------------
// click cases
// ---------------------------------------------------------------------------

test("C12 happy: browser events record action, url and target: a computer left_click keeps action left_click, navigate keeps its url", () => {
  const ev = (short, tool_input) => eventsFromHookInput({ hook_event_name: "PostToolUse", session_id: "S1", tool_name: `mcp__claude-in-chrome__${short}`, tool_input }, "/repo")[0];

  const byRef = ev("computer", { action: "left_click", ref: "ref_12" });
  assert.equal(byRef.kind, "browser");
  assert.equal(byRef.tool, "mcp__claude-in-chrome__computer");
  assert.equal(byRef.action, "left_click");
  assert.match(String(byRef.target), /ref_12/);

  const byPoint = ev("computer", { action: "left_click", coordinate: [312, 648] });
  assert.equal(byPoint.action, "left_click");
  assert.match(String(byPoint.target), /312\D+648/);

  assert.equal(ev("computer", { action: "screenshot" }).action, "screenshot");

  const nav = ev("navigate", { url: "https://example.com/venues" });
  assert.equal(nav.action, "navigate");
  assert.equal(nav.url, "https://example.com/venues");

  const form = ev("form_input", { ref: "ref_7", value: "Riverside" });
  assert.equal(form.action, "form_input");
  assert.match(String(form.target), /ref_7/);

  assert.equal(ev("javascript_tool", { text: "document.querySelector('a').click()" }).action, "javascript_tool");

  // the real batch shape: {name, input} per item
  const actionsOf = (e) => e.actions.map((a) => (typeof a === "string" ? a : a.action));
  const batch = ev("browser_batch", { actions: [{ name: "computer", input: { action: "left_click", ref: "ref_3" } }, { name: "navigate", input: { url: "https://example.com" } }] });
  assert.equal(batch.action, "browser_batch");
  assert.ok(Array.isArray(batch.actions), JSON.stringify(batch));
  assert.deepEqual(actionsOf(batch), ["left_click", "navigate"], JSON.stringify(batch.actions));
  // a flat {tool, ...input} item is read the same way
  const flat = ev("browser_batch", { actions: [{ tool: "computer", action: "left_click", ref: "ref_3" }, { tool: "navigate", url: "https://example.com" }] });
  assert.deepEqual(actionsOf(flat), ["left_click", "navigate"], JSON.stringify(flat.actions));
});

function clickRepo(name, config = GATE_JSON) {
  const repo = opened(name, { config });
  assert.match(cli(repo, "case", ["add", "the chip opens the hold sheet", "--kind", "click"]), /C1 added \(click\)/);
  return repo;
}
const caseOf = (repo, id) => ledgerOf(repo).cases.find((c) => c.id === id);

test("C22 refused: gate case close <id> --click takes the newest lead left_click after the last implementation edit and prints it; navigate, screenshot, javascript_tool, a helper's click, an older click and --test are refused", () => {
  const repo = clickRepo("mc-c22");
  click(repo, "ref_1"); // before the edit
  edit(repo, "src/a.ts", lines(21, "a"));
  refused(repo, "case", ["close", "C1", "--click"]);

  chrome(repo, "navigate", { url: "https://example.com/venues" });
  chrome(repo, "computer", { action: "screenshot" });
  chrome(repo, "javascript_tool", { text: "document.querySelector('.chip').click()" });
  refused(repo, "case", ["close", "C1", "--click"]);

  click(repo, "ref_5", { agent: "general-purpose" });
  refused(repo, "case", ["close", "C1", "--click"]);

  refused(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:chip"]);
  assert.equal(caseOf(repo, "C1").status, "open");

  click(repo, "ref_11");
  click(repo, "ref_12");
  const newest = lastBrowser(repo);
  const out = cli(repo, "case", ["close", "C1", "--click"]);
  assert.match(out, /left_click/);
  assert.match(out, /ref_12/);
  const row = caseOf(repo, "C1");
  assert.equal(row.status, "closed");
  assert.equal(row.event, `events#${newest.seq}`);
});

test("C14 idempotent: a click case closed, then a source edit: gate check lists the case as open again until a newer click closes it", () => {
  const repo = clickRepo("mc-c14");
  edit(repo, "src/a.ts", lines(21, "a"));
  click(repo, "ref_2");
  cli(repo, "case", ["close", "C1", "--click"]);
  assert.doesNotMatch(openCasesLine(check(repo)), /\bC1\b/);
  assert.doesNotMatch(openCasesLine(check(repo)), /\bC1\b/, "a second check says the same");

  edit(repo, "src/a.ts", lines(22, "a"));
  assert.match(openCasesLine(check(repo)), /\bC1\b/, "the click is older than the last edit");
  refused(repo, "case", ["close", "C1", "--click"]);

  click(repo, "ref_2");
  const newest = lastBrowser(repo);
  cli(repo, "case", ["close", "C1", "--click"]);
  assert.doesNotMatch(openCasesLine(check(repo)), /\bC1\b/);
  assert.equal(caseOf(repo, "C1").event, `events#${newest.seq}`);
});

test("C14 idempotent: a click case reopened by a later edit counts as open in the brief, the full report and the next hint", () => {
  const repo = clickRepo("mc-c14-open");
  edit(repo, "src/a.ts", lines(21, "a"));
  click(repo, "ref_2");
  cli(repo, "case", ["close", "C1", "--click"]);
  const dir = runDir(repo);
  const ledger = loadLedger(dir);
  for (const s of ledger.steps) if (s.key !== "close") Object.assign(s, { state: "DONE", note: "not under test", evidence: "ledger.md", seq: nextSeq() });
  saveLedger(dir, ledger);
  assert.match(cli(repo, "report", ["--brief"]), /Tested 1 case, all covered\./);
  assert.doesNotMatch(cli(repo, "note", ["caveat", "desktop only"]), /--click/);

  edit(repo, "src/a.ts", lines(22, "a"));
  assert.match(cli(repo, "report", ["--brief"]), /Tested 1 case, 1 still open\./);
  const full = cli(repo, "report");
  assert.match(full, /cases 0\/1 closed/);
  assert.match(full, /\| C1 \|.*\| open: edited after the click \|/);
  assert.match(packetOf(cli(repo, "brief", ["reviewer"])), /\| C1 \|.*\| open: edited after the click \|/, "a helper's packet shows it open too");
  const hint = cli(repo, "note", ["caveat", "phone not driven"]).split("\n").find((l) => l.startsWith("next:"));
  assert.match(hint, /close C1 with/);
  assert.match(hint, /gate case close C<n> --click/);

  click(repo, "ref_2");
  cli(repo, "case", ["close", "C1", "--click"]);
  assert.match(cli(repo, "report", ["--brief"]), /Tested 1 case, all covered\./);
});

test("C22 refused: a click from before the run opened does not close a click case; --click before the id still names the case", () => {
  const repo = committed("mc-c22-open");
  check(repo); // the session starts here, so its baseline predates the click
  click(repo, "ref_1");
  openRun(repo, "mc-c22-open");
  cli(repo, "case", ["add", "the chip opens the hold sheet", "--kind", "click"]);
  refused(repo, "case", ["close", "C1", "--click"]);
  assert.equal(caseOf(repo, "C1").status, "open");

  click(repo, "ref_4");
  const newest = lastBrowser(repo);
  assert.match(cli(repo, "case", ["close", "--click", "C1"]), /C1 closed by left_click ref_4/);
  assert.equal(caseOf(repo, "C1").event, `events#${newest.seq}`);
});

test("C15 edge: a click case can be closed by a green run of the cmd: driver after the last edit, and with --na and a reason", () => {
  const repo = clickRepo("mc-c15", { ...GATE_JSON, driver: "cmd:npx playwright test" });
  command(repo, "npx playwright test e2e/chip.spec.ts", { exit: 0 }); // before the edit
  edit(repo, "src/a.ts", lines(21, "a"));
  refused(repo, "case", ["close", "C1", "--click"]);
  command(repo, "npx playwright test e2e/chip.spec.ts", { exit: 1 });
  refused(repo, "case", ["close", "C1", "--click"]);

  command(repo, "npx playwright test e2e/chip.spec.ts", { exit: 0 });
  const green = eventsOf(repo).filter((e) => e.kind === "command").pop();
  cli(repo, "case", ["close", "C1", "--click"]);
  assert.equal(caseOf(repo, "C1").status, "closed");
  assert.equal(caseOf(repo, "C1").event, `events#${green.seq}`);

  cli(repo, "case", ["add", "the footer link", "--kind", "click"]);
  cli(repo, "case", ["close", "C2", "--na", "the link is unchanged, only its colour moved"]);
  assert.equal(caseOf(repo, "C2").status, "closed");
  assert.equal(caseOf(repo, "C2").na, "the link is unchanged, only its colour moved");
  assert.doesNotMatch(openCasesLine(check(repo)), /\bC[12]\b/);
});

test("C28 edge: a browser_batch event holding a left_click qualifies for --click; one click event closes one click case, a second case needs a second click", () => {
  const repo = clickRepo("mc-c28");
  cli(repo, "case", ["add", "the tab switches season", "--kind", "click"]);
  edit(repo, "src/a.ts", lines(21, "a"));

  chrome(repo, "browser_batch", { actions: [{ name: "navigate", input: { url: "https://example.com" } }, { name: "computer", input: { action: "screenshot" } }] });
  refused(repo, "case", ["close", "C1", "--click"]);

  chrome(repo, "browser_batch", { actions: [{ name: "computer", input: { action: "left_click", ref: "ref_3" } }, { name: "computer", input: { action: "screenshot" } }] });
  const batch = lastBrowser(repo);
  cli(repo, "case", ["close", "C1", "--click"]);
  assert.equal(caseOf(repo, "C1").event, `events#${batch.seq}`);

  refused(repo, "case", ["close", "C2", "--click"]);
  assert.equal(caseOf(repo, "C2").status, "open", "the same click cannot close a second case");

  click(repo, "ref_9");
  const second = lastBrowser(repo);
  cli(repo, "case", ["close", "C2", "--click"]);
  assert.equal(caseOf(repo, "C2").event, `events#${second.seq}`);
  assert.notEqual(caseOf(repo, "C1").event, caseOf(repo, "C2").event);
});

test("C16 happy: gate case add accepts --kind click; the usage, the next hint, the playbooks' cases steps, skeptic.md and reviewer.md name it; SKILL.md stays under 4096 bytes", () => {
  assert.ok(CASE_KINDS.includes("click"), JSON.stringify(CASE_KINDS));
  const repo = committed("mc-c16");
  const planned = openRun(repo, "mc-c16");
  const hint = planned.split("\n").find((l) => l.startsWith("next:") && l.includes("--kind"));
  assert.ok(hint, planned);
  assert.match(hint, /\bclick\b/);

  assert.match(cli(repo, "case", ["add", "the chip opens the hold sheet", "--kind", "click"]), /C1 added \(click\)/);
  assert.equal(ledgerOf(repo).cases[0].kind, "click");
  assert.match(refused(repo, "case", ["add"]), /\bclick\b/, "the usage line");
  assert.match(refused(repo, "case", ["add", "x", "--kind", "tap"]), /\bclick\b/, "the have-list");

  const read = (...p) => readFileSync(path.join(pluginRoot, ...p), "utf8");
  const caseSteps = read("skills", "gate", "playbooks.md").split("\n").filter((l) => l.includes("{cases}"));
  assert.equal(caseSteps.length, 3, "feature, bugfix and refactor each have a cases step");
  for (const l of caseSteps) assert.match(l, /\bclick\b/, l);
  for (const role of ["skeptic", "reviewer"]) {
    const text = read("agents", `${role}.md`).replace(/\s+/g, " ");
    assert.match(text, /\bclick case/, `agents/${role}.md does not ask for a click case`);
    for (const word of [/\blink\b/, /\bbutton\b/, /\btab\b/]) assert.match(text, word, `agents/${role}.md lacks ${word}`);
  }
  const skill = read("skills", "gate", "SKILL.md");
  assert.ok(Buffer.byteLength(skill) < 4096, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  const kindLine = skill.split("\n").find((l) => l.includes("gate case add") && l.includes("--kind"));
  assert.match(kindLine ?? "", /\bclick\b/);
});

// ---------------------------------------------------------------------------
// caveats
// ---------------------------------------------------------------------------

test("C17 happy: gate note caveat twice gives a Caveats line with both texts in the brief and the full report; with none the line is absent", () => {
  const ONE = "the chip was clicked on desktop only";
  const TWO = "the phone viewport was not driven";
  const repo = opened("mc-c17");
  assert.doesNotMatch(cli(repo, "report", ["--brief"]), /caveats/i);
  assert.doesNotMatch(cli(repo, "report"), /caveats/i);

  cli(repo, "note", ["caveat", ONE]);
  cli(repo, "note", ["caveat", TWO]);
  const stored = JSON.stringify(ledgerOf(repo).caveats);
  assert.equal(ledgerOf(repo).caveats.length, 2);
  assert.ok(stored.includes(ONE) && stored.includes(TWO), stored);

  const brief = cli(repo, "report", ["--brief"]);
  const line = brief.split("\n").find((l) => l.startsWith("Caveats:"));
  assert.ok(line, `no Caveats: line in the brief:\n${brief}`);
  assert.ok(line.includes(ONE) && line.includes(TWO), line);

  const full = cli(repo, "report");
  assert.match(full, /^.*Caveats.*$/m);
  assert.ok(full.includes(ONE) && full.includes(TWO), "the full report carries both caveats");

  refused(repo, "note", ["caveat"]);
});

test("C17 edge: a caveat already recorded is not added twice; --files and --size are refused; the brief line flattens newlines and ends with one full stop; SKILL.md asks for a caveat only when something was not shown", () => {
  const repo = opened("mc-c17-edge");
  cli(repo, "note", ["caveat", "the phone viewport\nwas not driven."]);
  cli(repo, "note", ["caveat", "the phone viewport\nwas not driven."]);
  assert.equal(ledgerOf(repo).caveats.length, 1);
  refused(repo, "note", ["caveat", "desktop only", "--files", "src/a.ts"]);
  refused(repo, "note", ["caveat", "desktop only", "--size", "large"]);
  assert.equal(ledgerOf(repo).caveats.length, 1);

  cli(repo, "note", ["caveat", "desktop only"]);
  const line = cli(repo, "report", ["--brief"]).split("\n").find((l) => l.startsWith("Caveats:"));
  assert.equal(line, "Caveats: the phone viewport was not driven; desktop only.");

  const skill = readFileSync(path.join(pluginRoot, "skills", "gate", "SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.match(skill, /Not everything shown\? `gate note caveat/);
});
