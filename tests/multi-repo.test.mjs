// multi-repo: one run names further repo roots; their files are part of the run under their
// ../name/... path. Written from the task's case table (C1-C4, C6-C24; C5 is superseded by
// C17 and C18), blind to the implementation.
//
// Sources of truth for the literals asserted here:
//   tier sizes (tiny 15 lines, standard 10 files), piece cap 400 ... models.json policy
//   "measured <tier>: n files, n lines", "files: a n · b n" ........ scripts/lib/size.mjs renderTierBlock
//   "tier predicted <tier> (n file)" ............................... scripts/lib/verbs.mjs note plan
//   "slop: 1 slop line", "<path>:<line> step narration" ............ tests/measure-and-click.test.mjs C4
//   "<n> changed lines" on a piece over the cap .................... tests/measure-and-click.test.mjs C7
//   "does not resolve in the repo" ................. scripts/lib/verbs.mjs checkContext
//   "✗ <cmd> — exit n", "n of m red", skipped rows ................. scripts/lib/verify.mjs
//   "## Changed files" ............................................. scripts/lib/report.mjs
//   ledger.repos {prefix, root}, baseline.heads, base/@<n>/<rel>.base, verify row `repo`,
//   "HEAD" on a late declaration, the R13 line for a missing repo .. the Plan and the lead's notes

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, here } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { loadPolicy } from "../scripts/lib/size.mjs";

const NODE = JSON.stringify(process.execPath);

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
// A relative --repo path is read from the main root, whatever the shell's cwd.
const run = (repo, verb, args = [], { env = envFor(repo) } = {}) => spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env, cwd: repo });
const REFUSAL = /^done-gate: /m;
function cli(repo, verb, args = [], opts) {
  const r = run(repo, verb, args, opts);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r.stdout;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.notEqual(r.status, 0, `gate ${verb} ${args.join(" ")} was refused but exited 0`);
  return r.stderr;
}
const check = (repo, opts) => cli(repo, "check", [], opts);
const blocks = (out, rule) => out.split("\n").some((l) => new RegExp(`\\b${rule}\\b`).test(l));
const ruleLine = (out, rule) => out.split("\n").find((l) => new RegExp(`\\b${rule}\\b`).test(l)) ?? "";

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", (({ current, lastClosed }) => current ?? lastClosed)(loadSession(stateDir(repo), "S1")));
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const reposOf = (repo) => ledgerOf(repo).repos;
const prefixesOf = (repo) => (reposOf(repo) ?? []).map((r) => r.prefix);
const editPaths = (repo) => readEvents(stateDir(repo), "S1").filter((e) => e.kind === "edit").map((e) => e.path);
const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const commitArgs = ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm"];
const lines = (n, name) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`).join("\n") + "\n";
const py = (n, name = "x") => Array.from({ length: n }, (_, i) => `${name}${i} = ${i}`).join("\n") + "\n";
const tagged = (tag, code = 0) => `${NODE} -e "console.log('${tag}'); process.exit(${code})"`;
const CWD_CMD = `${NODE} -e "console.log(process.cwd())"`;

const GATE_JSON = { source: ["src/**", "tests/**"], tests: ["tests/**"], verify: ["true"] };
const CONTEXT = "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local";

// The main fixture repo, committed.
function committed(name, files = {}, config = GATE_JSON) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify(config, null, 2), "src/b.ts": lines(10, "b"), ...files });
  git(repo, ["add", "-A"]);
  git(repo, [...commitArgs, "init"]);
  return repo;
}
// A second git repo beside the main one: tests/.tmp/<name>-<suffix>, so its prefix from the
// main root is ../<name>-<suffix>. No package.json and no gate.json unless a test adds one.
function sibling(name, files = {}, suffix = "other") {
  const dir = path.join(here, ".tmp", `${name}-${suffix}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  for (const [rel, content] of Object.entries({ "src/a.py": py(20), ...files })) write(dir, rel, content);
  git(dir, ["add", "-A"]);
  git(dir, [...commitArgs, "init"]);
  return dir;
}
const prefixOf = (repo, other) => path.relative(repo, other).split(path.sep).join("/");

// open (with the declared repos), then task, context and plan
function openRun(repo, slug, { files = "src/a.ts,src/b.ts", playbook = "feature", repos = [] } = {}) {
  cli(repo, "open", [slug, playbook, ...repos.flatMap((p) => ["--repo", p])]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  return cli(repo, "note", ["plan", "The plan.", "--files", files]);
}
// The usual pair: a main repo and one declared sibling, the run open. `p` is the prefix.
function pair(name, { main = {}, config = GATE_JSON, otherFiles = {}, files } = {}) {
  const repo = committed(name, main, config);
  const other = sibling(name, otherFiles);
  const p = prefixOf(repo, other);
  assert.equal(p, `../${name}-other`);
  openRun(repo, name, { repos: [p], files: files ?? `${p}/src/a.py` });
  assert.deepEqual(prefixesOf(repo), [p], `the run declares ${p}: ledger.repos is ${JSON.stringify(reposOf(repo))}`);
  return { repo, other, p };
}

// A hook payload piped to a hook verb; the parsed stdout, or null when the hook printed nothing.
function hook(repo, payload, { verb = "log", env = envFor(repo) } = {}) {
  const r = spawnSync(process.execPath, [gate, verb], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env, cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}
const agentOf = (agent) => (agent ? { agent_id: "A1", agent_type: agent } : {});
// An edit as Claude Code reports it after the bytes landed; `dir` is the repo the file is in.
function edit(repo, dir, rel, content, { agent = null, env } = {}) {
  write(dir, rel, content);
  return hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, rel) }, tool_output: "ok", ...agentOf(agent) }, { env });
}
const command = (repo, cmd, { env } = {}) => hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: { exitCode: 0 } }, { env });
// null when the fence allows the call, else its deny reason
function fence(repo, tool, tool_input, agent = null) {
  const out = hook(repo, { hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...agentOf(agent) }, { verb: "fence" });
  if (out === null || !out.hookSpecificOutput) return null;
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  return out.hookSpecificOutput.permissionDecisionReason;
}

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
const verifyJson = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8"));
const rowFor = (v, tag) => v.commands.find((c) => c.cmd.includes(tag));
const foreignOf = (repo) => (ledgerOf(repo).foreign ?? []).map((f) => (typeof f === "string" ? f : f.path));

// Another session's commit: the bytes land and are committed with no hook event in S1.
function otherCommit(dir, rel, content) {
  write(dir, rel, content);
  git(dir, ["add", rel]);
  git(dir, [...commitArgs, "other session"]);
}

// A git on PATH that logs each call's directory and arguments and then runs the real one.
function gitShim(repo, name) {
  const dir = path.join(here, ".tmp", `${name}-shim`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const log = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "git"), `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "${log}"\nexec "${real}" "$@"\n`);
  chmodSync(path.join(dir, "git"), 0o755);
  const env = { ...envFor(repo), PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => ({ cwd: l.split("\t")[0], args: l.split("\t").slice(1).join("\t") })) : []);
  const reset = () => rmSync(log, { force: true });
  return { env, calls, reset };
}

const reviewFile = (n) => `# Review ${n} — x\n\n## Act on\n- none\n## Consider\n- none\n## Noted\n- none\n## Dismissed\n- none\n## Evidence verdict\n- tests: npm test exit 0\n`;
function reviewRound(repo, files) {
  const out = cli(repo, "brief", ["reviewer", "--files", files]);
  const own = /Your file is .*\/(review-\d+\.md)/.exec(out)[1];
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "A-reviewer", agent_type: "done-gate:reviewer" });
  writeFileSync(path.join(runDir(repo), own), reviewFile(Number(/-(\d+)\.md$/.exec(own)[1])));
  cli(repo, "huddle", ["add", "reviewer", "--file", own]);
  return out;
}

// Closes the current run the way a tiny run closes: case N/A, verify, the open steps N/A.
function closeRun(repo) {
  cli(repo, "case", ["add", "it changes", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--na", "covered by the existing fixture"]);
  edit(repo, repo, "tests/a.test.ts", `test('a', () => { /* ${path.basename(runDir(repo))} */ });\n`);
  cli(repo, "verify");
  check(repo);
  for (const step of ledgerOf(repo).steps) {
    if (step.state !== null || step.key === "close") continue;
    cli(repo, "step", [step.key ?? String(step.n), "na", "not needed for a one-line change"]);
  }
  const closing = run(repo, "close");
  assert.equal(ledgerOf(repo).status, "closed", `the run did not close:\n${closing.stdout}${closing.stderr}`);
}

// ---------------------------------------------------------------------------
// declaring
// ---------------------------------------------------------------------------

test("C1 refused: gate open --repo stores the repo with its ../ prefix and prints it, gate repo add does the same later; a missing path, one inside the main root, one that is not a git work tree root and one already declared are refused", () => {
  const repo = committed("mr-c1");
  const other = sibling("mr-c1");
  const third = sibling("mr-c1", {}, "third");

  const opened = cli(repo, "open", ["mr-c1", "feature", "--repo", "../mr-c1-other"]);
  const repos = reposOf(repo);
  assert.ok(Array.isArray(repos), `ledger.repos is ${JSON.stringify(repos)}`);
  assert.deepEqual(repos.map((r) => r.prefix), ["../mr-c1-other"]);
  assert.ok(path.isAbsolute(repos[0].root), repos[0].root);
  assert.equal(realpathSync(repos[0].root), realpathSync(other));
  const names = (out, prefix) => out.split("\n").some((l) => /repo/i.test(l) && l.includes(prefix));
  assert.ok(names(opened, "../mr-c1-other"), `gate open does not print the repo:\n${opened}`);
  assert.equal(ledgerOf(repo).baseline.heads?.["../mr-c1-other"], git(other, ["rev-parse", "HEAD"]).trim(), "baseline.heads keeps the repo HEAD");

  cli(repo, "repo", ["add", "../mr-c1-third"]);
  assert.deepEqual(prefixesOf(repo), ["../mr-c1-other", "../mr-c1-third"]);
  assert.equal(realpathSync(reposOf(repo)[1].root), realpathSync(third));
  const doctor = cli(repo, "doctor");
  for (const prefix of ["../mr-c1-other", "../mr-c1-third"]) assert.ok(names(doctor, prefix), `gate doctor does not print ${prefix}:\n${doctor}`);

  // the refused side: nothing below changes the declared list
  write(repo, "vendor/in/x.txt", "x\n");
  git(path.join(repo, "vendor/in"), ["init", "-q"]); // a git root, but inside the main root
  mkdirSync(path.join(here, ".tmp", "mr-c1-plain"), { recursive: true }); // a directory, no git root
  sibling("mr-c1", {}, "fourth"); // a git root whose subdirectory is not one
  for (const [bad, why] of [
    ["../mr-c1-nope", "does not exist"],
    ["vendor/in", "inside the main root"],
    ["../mr-c1-plain", "not a git work tree root"],
    ["../mr-c1-fourth/src", "a subdirectory of a work tree"],
    ["../mr-c1-other", "already declared"],
  ]) {
    refused(repo, "repo", ["add", bad]);
    assert.deepEqual(prefixesOf(repo), ["../mr-c1-other", "../mr-c1-third"], `${why}: the list is unchanged`);
  }
});

test("C16 idempotent: the same directory declared again with a trailing slash, as an absolute path and through a symlink stays one repo", () => {
  const repo = committed("mr-c16");
  const other = sibling("mr-c16");
  cli(repo, "open", ["mr-c16", "feature", "--repo", "../mr-c16-other"]);
  assert.deepEqual(prefixesOf(repo), ["../mr-c16-other"]);

  const link = path.join(here, ".tmp", "mr-c16-link");
  rmSync(link, { recursive: true, force: true });
  symlinkSync(other, link);
  // another letter case names the same directory only on a case-insensitive volume
  const upper = "../MR-C16-OTHER";
  const caseBlind = existsSync(path.join(repo, upper));
  for (const spelling of ["../mr-c16-other/", other, `${other}/`, "../mr-c16-link", link, "../mr-c16/../mr-c16-other", ...(caseBlind ? [upper] : [])]) {
    const r = run(repo, "repo", ["add", spelling]); // refused or a no-op: either way it is not a second repo
    assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
    assert.deepEqual(prefixesOf(repo), ["../mr-c16-other"], `${spelling} must not add a second repo`);
  }
});

test("C22 boundary: --repo before the slug or between slug and playbook parses; on a slug whose run is open, gate open --repo attaches and declares the repo", () => {
  const before = committed("mr-c22a");
  sibling("mr-c22a");
  cli(before, "open", ["--repo", "../mr-c22a-other", "mr-c22a", "feature"]);
  assert.equal(ledgerOf(before).slug, "mr-c22a");
  assert.equal(ledgerOf(before).playbook, "feature");
  assert.deepEqual(prefixesOf(before), ["../mr-c22a-other"]);

  const between = committed("mr-c22b");
  sibling("mr-c22b");
  cli(between, "open", ["mr-c22b", "--repo", "../mr-c22b-other", "bugfix"]);
  assert.equal(ledgerOf(between).slug, "mr-c22b");
  assert.equal(ledgerOf(between).playbook, "bugfix");
  assert.deepEqual(prefixesOf(between), ["../mr-c22b-other"]);

  const late = committed("mr-c22c");
  sibling("mr-c22c");
  cli(late, "open", ["mr-c22c", "feature"]);
  const dir = runDir(late);
  assert.deepEqual(prefixesOf(late), []);
  cli(late, "open", ["mr-c22c", "--repo", "../mr-c22c-other"]);
  assert.equal(runDir(late), dir, "the open run is joined, not replaced");
  assert.equal(readdirSync(path.join(stateDir(late), "runs")).length, 1, "no second run");
  assert.equal(ledgerOf(late).playbook, "feature");
  assert.deepEqual(prefixesOf(late), ["../mr-c22c-other"]);
});

test("C23 refused: an ancestor of the main root, a path nested inside a declared repo and one containing a declared repo are refused", () => {
  const { repo, other, p } = pair("mr-c23");
  // done-gate's own checkout is a git work tree root and an ancestor of tests/.tmp/mr-c23
  assert.equal(realpathSync(git(pluginRoot, ["rev-parse", "--show-toplevel"]).trim()), realpathSync(pluginRoot));
  refused(repo, "repo", ["add", pluginRoot]);
  refused(repo, "repo", ["add", prefixOf(repo, pluginRoot)]);
  assert.deepEqual(prefixesOf(repo), [p]);

  write(other, "sub/x.py", "x = 1\n");
  git(path.join(other, "sub"), ["init", "-q"]);
  refused(repo, "repo", ["add", `${p}/sub`]);
  assert.deepEqual(prefixesOf(repo), [p], "a repo nested in a declared one");

  const outer = committed("mr-c23-outer");
  const holder = sibling("mr-c23-outer");
  write(holder, "sub/x.py", "x = 1\n");
  git(path.join(holder, "sub"), ["init", "-q"]);
  cli(outer, "open", ["mr-c23-outer", "feature", "--repo", "../mr-c23-outer-other/sub"]);
  assert.deepEqual(prefixesOf(outer), ["../mr-c23-outer-other/sub"]);
  refused(outer, "repo", ["add", "../mr-c23-outer-other"]);
  assert.deepEqual(prefixesOf(outer), ["../mr-c23-outer-other/sub"], "a repo containing a declared one");
});

// ---------------------------------------------------------------------------
// edits, size, review, slop
// ---------------------------------------------------------------------------

test("C2 reported-surface: an Edit hook event for a file in a declared repo is recorded with its ../other/... path; one in an undeclared sibling is dropped", () => {
  const { repo, other, p } = pair("mr-c2");
  const stranger = sibling("mr-c2", {}, "stranger");
  edit(repo, other, "src/a.py", py(21));
  edit(repo, stranger, "src/a.py", py(21));
  edit(repo, repo, "src/a.ts", lines(21, "a"));
  assert.deepEqual(editPaths(repo), [`${p}/src/a.py`, "src/a.ts"]);
});

test("C3 reported-surface: after 20 new lines in ../other/src/a.py, gate size counts the file and its 20 lines, and gate note plan --files ../other/src/a.py predicts from it", () => {
  const repo = committed("mr-c3");
  const other = sibling("mr-c3");
  const p = "../mr-c3-other";
  cli(repo, "open", ["mr-c3", "feature", "--repo", p]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  const planned = cli(repo, "note", ["plan", "The plan.", "--files", `${p}/src/a.py`]);
  assert.match(planned, /tier predicted tiny \(1 file\)/, planned);
  assert.deepEqual(ledgerOf(repo).tier.predictedFiles, [`${p}/src/a.py`]);

  edit(repo, other, "src/a.py", py(20) + py(20, "y"));
  const size = sizeOf(repo);
  assert.equal(size.files, 1, size.out);
  assert.equal(size.lines, 20, size.out);
  assert.deepEqual(size.rows, { [`${p}/src/a.py`]: { lines: 20, estimate: false } }, size.out);
});

test("C4 reported-surface: gate brief reviewer --files ../other/src/a.py is accepted, the packet shows the diff taken in that repo, a clean round on it satisfies R5, and a piece over the 400 cap is refused", () => {
  assert.equal(loadPolicy().reviewMaxLines, 400);
  const { repo, other, p } = pair("mr-c4", { files: "../mr-c4-other/src/a.py,src/a.ts,src/b.ts" });
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);
  edit(repo, other, "src/a.py", py(20) + py(20, "y"));
  assert.ok(ruleLine(check(repo), "R5"), `R5 asks for a review of the sibling repo's change:\n${check(repo)}`);

  const packet = packetOf(reviewRound(repo, `${p}/src/a.py`));
  assert.ok(packet.includes(`diff --git a/${p}/src/a.py b/${p}/src/a.py`), `the diff header carries the prefixed path:\n${packet}`);
  for (const l of ["+y0 = 0", "+y19 = 19"]) assert.ok(packet.includes(l), `${l} is missing`);
  assert.ok(!packet.includes("+x0 = 0"), "the committed lines are not shown as added");
  assert.ok(!blocks(check(repo), "R5"), `one clean round on the file covers it:\n${check(repo)}`);

  const big = pair("mr-c4-big");
  edit(big.repo, big.other, "src/a.py", py(20) + py(450, "y"));
  assert.match(refused(big.repo, "brief", ["reviewer", "--files", `${big.p}/src/a.py`]), /450 changed lines/);
});

test("C6 happy: a slop line added in the declared repo is reported by the slop check with its prefixed path", () => {
  const { repo, other, p } = pair("mr-c6", { config: { source: ["src/**"], tests: ["tests/**"], verify: ["true"] }, otherFiles: { "src/s.ts": "export const s = 1;\n" } });
  const r10 = (out) => out.split("\n").filter((l) => /\bR10\b/.test(l));
  assert.deepEqual(r10(check(repo)), []);
  edit(repo, other, "src/s.ts", "export const s = 1;\n// Step 1: go\n");
  const hits = r10(check(repo));
  assert.equal(hits.length, 1, check(repo));
  assert.match(hits[0], /slop: 1 slop line/);
  assert.ok(hits[0].includes(`${p}/src/s.ts:2 step narration`), hits[0]);
});

test("C7 refused: at the delegated size the lead's Edit of ../other/src/a.py is refused and a worker's is allowed; below it the lead's is allowed; a reviewer may not edit it at either size", () => {
  const policy = loadPolicy();
  assert.equal(policy.delegatesAt, "large");
  const LARGE = Array.from({ length: policy.tiers.standard.maxFiles }, (_, i) => `src/f${i}.ts`);
  const big = pair("mr-c7", { main: Object.fromEntries(LARGE.map((f) => [f, "export const x = 1;\n"])), files: [...LARGE, "../mr-c7-other/src/a.py"].join(",") });
  assert.equal(ledgerOf(big.repo).tier.predicted, "large");
  const target = { file_path: path.join(big.other, "src/a.py") };
  const reason = fence(big.repo, "Edit", target);
  assert.ok(reason, "the lead's Edit of a declared repo's source file at large must be denied");
  assert.match(reason, /\blarge\b/);
  assert.ok(reason.includes(`${big.p}/src/a.py`), reason);
  assert.ok(fence(big.repo, "Write", target), "Write too");
  assert.equal(fence(big.repo, "Edit", target, "done-gate:worker"), null, "the worker edits it");
  assert.ok(fence(big.repo, "Edit", target, "done-gate:reviewer"), "a reviewer does not");

  const small = pair("mr-c7-small");
  assert.equal(ledgerOf(small.repo).tier.predicted, "tiny", "one planned file");
  const smallTarget = { file_path: path.join(small.other, "src/a.py") };
  assert.equal(fence(small.repo, "Edit", smallTarget), null, "below the delegated size the lead edits it");
  const denied = fence(small.repo, "Edit", smallTarget, "done-gate:reviewer");
  assert.ok(denied, "a reviewer may not edit a declared repo's file");
  assert.ok(denied.includes(`${small.p}/src/a.py`), denied);
});

test("C12 edge: another session's commit in the declared repo to a file this run never touched is left out, as in the main repo", () => {
  const { repo, other, p } = pair("mr-c12");
  edit(repo, other, "src/a.py", py(21));
  otherCommit(other, "src/other.ts", "// ===== ROUTES =====\nexport const o = 1;\n");

  const out = check(repo);
  assert.doesNotMatch(out, /src\/other\.ts/, "no rule names the other session's file");
  assert.deepEqual(foreignOf(repo), [`${p}/src/other.ts`]);
  const size = sizeOf(repo);
  assert.deepEqual(size.rows, { [`${p}/src/a.py`]: { lines: 1, estimate: false } }, size.out);
  const line = cli(repo, "report").split("\n").find((l) => l.includes("other commits"));
  assert.ok(line, "the report has no line about other commits");
  assert.match(line, /\b1 file\b/);
});

test("C13 happy: the report lists the changed files of both repos with their prefixes and names the declared repos", () => {
  const { repo, other, p } = pair("mr-c13");
  edit(repo, repo, "src/a.ts", lines(21, "a"));
  edit(repo, other, "src/a.py", py(21));
  const full = cli(repo, "report");
  const changed = full.slice(full.indexOf("## Changed files"));
  assert.ok(full.includes("## Changed files"), full);
  assert.ok(changed.split("\n").some((l) => l.split(/[\s,]+/).includes("src/a.ts")), `src/a.ts is not listed:\n${changed}`);
  assert.ok(changed.includes(`${p}/src/a.py`), `${p}/src/a.py is not listed:\n${changed}`);
  const named = full.split("\n").find((l) => /\brepos?\b/i.test(l) && l.includes(p) && !l.includes(`${p}/`));
  assert.ok(named, `no line names the declared repo ${p}:\n${full}`);
});

// ---------------------------------------------------------------------------
// baselines
// ---------------------------------------------------------------------------

test("C17 edge: declared at gate open on a new run, a repo file already modified and an untracked one are measured from their base copies (0 lines until edited); the copies sit under <run>/base/@0/ and the fence refuses writes there", () => {
  const repo = committed("mr-c17");
  const other = sibling("mr-c17");
  const p = "../mr-c17-other";
  const dirty = py(20) + py(30, "d");
  const fresh = py(12, "u");
  write(other, "src/a.py", dirty); // modified before the run
  write(other, "src/u.py", fresh); // untracked before the run
  openRun(repo, "mr-c17", { repos: [p], files: `${p}/src/a.py` });

  const based = ledgerOf(repo).baseline.based;
  for (const rel of ["src/a.py", "src/u.py"]) assert.ok(based?.includes(`${p}/${rel}`), `${p}/${rel} is based: ${JSON.stringify(based)}`);
  const copy = (rel) => path.join(runDir(repo), "base", "@0", `${rel}.base`);
  assert.equal(readFileSync(copy("src/a.py"), "utf8"), dirty, "the copy is the content at open");
  assert.equal(readFileSync(copy("src/u.py"), "utf8"), fresh);

  const atOpen = sizeOf(repo);
  assert.equal(atOpen.files, 0, atOpen.out);
  assert.equal(atOpen.lines, 0, atOpen.out);

  edit(repo, other, "src/a.py", dirty + py(1, "z"));
  edit(repo, other, "src/u.py", fresh.replace("u3 = 3", "u3 = 33")); // one line replaced: 1 added, 1 deleted
  const size = sizeOf(repo);
  assert.deepEqual(size.rows, { [`${p}/src/a.py`]: { lines: 1, estimate: false }, [`${p}/src/u.py`]: { lines: 2, estimate: false } }, size.out);

  const rel = path.relative(repo, copy("src/a.py")).split(path.sep).join("/");
  assert.match(rel, /^\.claude\/gate\/runs\/[^/]+\/base\/@0\/src\/a\.py\.base$/);
  assert.ok(fence(repo, "Write", { file_path: copy("src/a.py") }), "Write");
  assert.ok(fence(repo, "Edit", { file_path: copy("src/u.py") }), "Edit");
  assert.ok(fence(repo, "Bash", { command: `echo x > ${rel}` }), "shell redirect");
  assert.equal(fence(repo, "Bash", { command: `cat ${rel}` }), null, "reading a copy is fine");
});

test("C18 reported-surface: declared later with gate repo add after the run edited ../other/src/a.py, the file's whole uncommitted change counts, an untracked file counts whole, and the output says the repo is measured from its HEAD", () => {
  const repo = committed("mr-c18");
  const other = sibling("mr-c18");
  const p = "../mr-c18-other";
  openRun(repo, "mr-c18", { files: "src/a.ts" });
  edit(repo, other, "src/a.py", py(20) + py(5, "y")); // the run's own edit, dropped: the repo is not declared yet
  write(other, "src/n.py", py(7, "n"));
  assert.deepEqual(editPaths(repo), []);

  const out = cli(repo, "repo", ["add", p]);
  assert.ok(out.split("\n").some((l) => l.includes("HEAD")), `gate repo add does not say the repo is measured from its HEAD:\n${out}`);
  const ledger = ledgerOf(repo);
  assert.deepEqual(ledger.repos.map((r) => r.prefix), [p]);
  assert.equal(ledger.baseline.heads?.[p], git(other, ["rev-parse", "HEAD"]).trim());
  assert.ok(!(ledger.baseline.based ?? []).some((f) => f.startsWith(`${p}/`)), `a late repo gets no base copies: ${JSON.stringify(ledger.baseline.based)}`);
  assert.equal(existsSync(path.join(runDir(repo), "base", "@0")), false);

  const size = sizeOf(repo);
  assert.equal(size.rows[`${p}/src/a.py`]?.lines, 5, size.out);
  assert.equal(size.rows[`${p}/src/n.py`]?.lines, 7, size.out);
  assert.equal(size.files, 2, size.out);
  assert.equal(size.lines, 12, size.out);
});

test("C19 boundary: closing a run with a declared repo leaves no ../ key in the session baseline: gate check afterwards reports nothing of it, and a plain run opened next has 0 changed files", () => {
  const { repo, other, p } = pair("mr-c19");
  edit(repo, other, "src/a.py", py(20) + py(1, "y"));
  const during = sizeOf(repo);
  assert.deepEqual(during.rows, { [`${p}/src/a.py`]: { lines: 1, estimate: false } }, during.out);
  closeRun(repo);

  const session = loadSession(stateDir(repo), "S1");
  const outside = (tree) => Object.keys(tree?.files ?? {}).filter((k) => k.startsWith("../"));
  assert.deepEqual(outside(session.baseline), [], "the session baseline holds main-root keys only");
  assert.deepEqual(outside(session.lastTree), [], "and so does the last tree");
  const after = run(repo, "check");
  assert.ok(!/GATE ERROR/.test(`${after.stdout}${after.stderr}`), `${after.stdout}${after.stderr}`);
  assert.ok(!`${after.stdout}${after.stderr}`.includes("../"), `gate check with no ledger names the sibling repo:\n${after.stdout}${after.stderr}`);

  openRun(repo, "mr-c19-next", { files: "src/a.ts" });
  assert.deepEqual(prefixesOf(repo), [], "the next run declares nothing");
  const next = sizeOf(repo);
  assert.equal(next.files, 0, next.out);
  assert.equal(next.lines, 0, next.out);
  assert.deepEqual(next.rows, {}, next.out);
});

// ---------------------------------------------------------------------------
// config and verify
// ---------------------------------------------------------------------------

test("C8 happy: a declared repo with its own .claude/gate.json is classified by its own globs and its verify commands run in its directory after the main ones; with no gate.json the main globs apply to the repo-relative path", () => {
  const own = { source: ["lib/**", "spec/**"], tests: ["spec/**"], verify: [`${NODE} -e "console.log('OTHER-RAN ' + process.cwd())"`] };
  const { repo, other, p } = pair("mr-c8", {
    config: { ...GATE_JSON, verify: [tagged("MAIN-RAN")] },
    otherFiles: { ".claude/gate.json": JSON.stringify(own, null, 2), "lib/x.js": "module.exports = 1;\n", "src/y.ts": "export const y = 1;\n", "spec/x.spec.js": "it('x', () => {});\n" },
  });
  edit(repo, other, "lib/x.js", "module.exports = 1;\nmodule.exports.a = 2;\nmodule.exports.b = 3;\n");
  edit(repo, other, "src/y.ts", "export const y = 1;\nexport const z = 2;\n"); // source by the main globs, not by its own
  edit(repo, other, "spec/x.spec.js", "it('x', () => {});\nit('y', () => {});\n"); // a test by its own globs
  const size = sizeOf(repo);
  assert.deepEqual(size.rows, { [`${p}/lib/x.js`]: { lines: 2, estimate: false } }, size.out);

  cli(repo, "verify");
  const v = verifyJson(repo);
  assert.equal(v.commands.length, 2, JSON.stringify(v.commands));
  assert.ok(v.commands[0].cmd.includes("MAIN-RAN"), "the main command runs first");
  assert.equal(v.commands[0].repo, undefined, "a main command carries no repo");
  assert.ok(v.commands[1].cmd.includes("OTHER-RAN"));
  assert.equal(v.commands[1].repo, p);
  assert.equal(v.commands[1].exit, 0);
  assert.equal(v.commands[1].tail.trim(), `OTHER-RAN ${realpathSync(other)}`, "it ran in the repo's own directory");

  // no gate.json there: the main globs (src/**, tests/**) read the repo-relative path
  const plain = pair("mr-c8-plain", { otherFiles: { "lib/x.js": "module.exports = 1;\n" } });
  edit(plain.repo, plain.other, "src/a.py", py(22));
  edit(plain.repo, plain.other, "lib/x.js", "module.exports = 2;\n");
  const plainSize = sizeOf(plain.repo);
  assert.deepEqual(plainSize.rows, { [`${plain.p}/src/a.py`]: { lines: 2, estimate: false } }, plainSize.out);
});

test("C9 refused: a red verify command of the declared repo makes verify red and names the repo", () => {
  const { repo, other, p } = pair("mr-c9", {
    config: { ...GATE_JSON, verify: [tagged("MAIN-RAN")] },
    otherFiles: { ".claude/gate.json": JSON.stringify({ verify: [tagged("OTHER-RED", 1)] }) },
  });
  edit(repo, other, "src/a.py", py(21)); // R3 judges verify only once source changed
  const r = run(repo, "verify");
  const row = rowFor(verifyJson(repo), "OTHER-RED");
  assert.ok(row, `the repo's command was not run: ${JSON.stringify(verifyJson(repo).commands)}`);
  assert.equal(row.exit, 1);
  assert.equal(row.repo, p);
  assert.match(r.stdout, /1 of 2 red/);
  const redLine = r.stdout.split("\n").find((l) => l.includes("✗"));
  assert.ok(redLine?.includes(p), `the red line does not name ${p}:\n${r.stdout}`);
  assert.equal(ledgerOf(repo).steps.find((s) => s.key === "verify").state, null, "the verify step stays open");
  assert.ok(ruleLine(check(repo), "R3").includes(p), check(repo));
});

test("C10 boundary: changing the declared repo's gate.json mid-run trips R13", () => {
  const first = { source: ["src/**"], tests: ["tests/**"], verify: [tagged("OTHER-RAN")] };
  const { repo, other } = pair("mr-c10", { otherFiles: { ".claude/gate.json": JSON.stringify(first) } });
  assert.ok(!blocks(check(repo), "R13"), check(repo));
  write(other, ".claude/gate.json", JSON.stringify({ ...first, verify: [tagged("SOMETHING-ELSE")] }));
  assert.ok(blocks(check(repo), "R13"), `editing the declared repo's gate.json mid-task must block:\n${check(repo)}`);
});

test("C20 edge: the same verify command text in the main repo and the declared repo runs in both, is recorded twice with its prefix, and the green main run does not make the repo command skipped", () => {
  const entry = [{ cmd: CWD_CMD, when: "source" }];
  const { repo, other, p } = pair("mr-c20", {
    config: { ...GATE_JSON, verify: entry },
    otherFiles: { ".claude/gate.json": JSON.stringify({ source: ["src/**"], tests: ["tests/**"], verify: entry }) },
  });
  edit(repo, repo, "src/a.ts", lines(21, "a"));
  edit(repo, other, "src/a.py", py(21));
  cli(repo, "verify");
  const v = verifyJson(repo);
  assert.deepEqual(v.commands.map((c) => [c.cmd, c.repo]), [[CWD_CMD, undefined], [CWD_CMD, p]]);
  for (const c of v.commands) assert.equal(c.skipped, undefined, `nothing is skipped: ${JSON.stringify(c)}`);
  assert.deepEqual(v.commands.map((c) => c.exit), [0, 0]);
  assert.equal(v.commands[0].tail.trim(), realpathSync(repo));
  assert.equal(v.commands[1].tail.trim(), realpathSync(other));
});

test("C21 edge: a when:source command of the declared repo runs when only that repo's source changed and is skipped when only main source changed", () => {
  const setup = (name) => pair(name, {
    config: { ...GATE_JSON, verify: [tagged("MAIN-ALWAYS")] },
    otherFiles: { ".claude/gate.json": JSON.stringify({ source: ["src/**"], tests: ["tests/**"], verify: [{ cmd: tagged("OTHER-SOURCE"), when: "source" }] }) },
  });
  const theirs = setup("mr-c21-theirs");
  edit(theirs.repo, theirs.other, "src/a.py", py(21));
  cli(theirs.repo, "verify");
  const ran = rowFor(verifyJson(theirs.repo), "OTHER-SOURCE");
  assert.ok(ran, JSON.stringify(verifyJson(theirs.repo).commands));
  assert.equal(ran.skipped, undefined, JSON.stringify(ran));
  assert.equal(ran.exit, 0);
  assert.match(ran.tail, /OTHER-SOURCE/);

  const ours = setup("mr-c21-ours");
  edit(ours.repo, ours.repo, "src/a.ts", lines(21, "a"));
  cli(ours.repo, "verify");
  const v = verifyJson(ours.repo);
  assert.equal(rowFor(v, "MAIN-ALWAYS").exit, 0);
  const skipped = rowFor(v, "OTHER-SOURCE");
  assert.ok(skipped, JSON.stringify(v.commands));
  assert.equal(typeof skipped.skipped, "string", `main source alone must not run it: ${JSON.stringify(skipped)}`);
  assert.equal(skipped.ms, 0);
});

// ---------------------------------------------------------------------------
// pointers
// ---------------------------------------------------------------------------

test("C11 boundary: a Traced pointer and a huddle evidence pointer into the declared repo resolve; into an undeclared sibling the Traced pointer is refused as today and a missing file never resolves", () => {
  const { repo, p } = pair("mr-c11");
  const traced = (ptr) => `Traced: ${ptr}\nRelated: tests/a.test.ts\nResearch: none needed: local`;
  cli(repo, "note", ["context", traced(`${p}/src/a.py:3`)]);
  assert.match(refused(repo, "note", ["context", traced(`${p}/src/missing.py:3`)]), /does not resolve/);

  cli(repo, "huddle", ["add", "qa", "--summary", "wrote the tests"]);
  const acton = (text) => /H\d+\.\d+/.exec(cli(repo, "huddle", ["acton", "H1", text]))[0];
  cli(repo, "huddle", ["resolve", acton("the parser drops a row"), "--evidence", `${p}/src/a.py:3`]);
  refused(repo, "huddle", ["resolve", acton("the parser drops a column"), "--evidence", `${p}/src/missing.py:3`]);

  // an undeclared sibling: today's behaviour
  const plain = committed("mr-c11-plain");
  sibling("mr-c11-plain");
  openRun(plain, "mr-c11-plain", { files: "src/a.ts" });
  assert.match(refused(plain, "note", ["context", traced("../mr-c11-plain-other/src/a.py:3")]), /does not resolve/);
  // evidence may leave the repo (a plan kept outside it): a ../ pointer to an existing file resolves
  cli(plain, "huddle", ["add", "qa", "--summary", "wrote the tests"]);
  const plainItem = /H\d+\.\d+/.exec(cli(plain, "huddle", ["acton", "H1", "the parser drops a row"]))[0];
  cli(plain, "huddle", ["resolve", plainItem, "--evidence", "../mr-c11-plain-other/src/a.py:3"]);

  // the main root reached through a symlink in another directory: <link>/../<repo> is not the
  // repo, so both pointers resolve only through the declared repo's stored root
  const real = committed("mr-c11-sym");
  const realOther = sibling("mr-c11-sym");
  const holder = path.join(here, ".tmp", "mr-c11-lnk");
  rmSync(holder, { recursive: true, force: true });
  mkdirSync(holder, { recursive: true });
  const link = path.join(holder, "main");
  symlinkSync(real, link);
  openRun(link, "mr-c11-sym", { repos: [realOther], files: "src/a.ts" });
  const sp = "../mr-c11-sym-other";
  assert.deepEqual(prefixesOf(link), [sp]);
  assert.equal(existsSync(path.join(link, sp)), false, "the prefix does not resolve from the link");
  cli(link, "note", ["context", traced(`${sp}/src/a.py:3`)]);
  cli(link, "huddle", ["add", "qa", "--summary", "wrote the tests"]);
  const linkItem = /H\d+\.\d+/.exec(cli(link, "huddle", ["acton", "H1", "the parser drops a row"]))[0];
  cli(link, "huddle", ["resolve", linkItem, "--evidence", `${sp}/src/a.py:3`]);
});

test("H3.3 refused: --files naming a file in a sibling nobody declared is refused by gate brief reviewer and by gate note plan with the path as given and gate repo add; next to a path that counts, the plan note says it was not counted", () => {
  const repo = committed("mr-h33");
  sibling("mr-h33");
  const given = "../mr-h33-other/src/a.py";
  cli(repo, "open", ["mr-h33", "feature"]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  const plan = refused(repo, "note", ["plan", "The plan.", "--files", given]);
  assert.ok(plan.includes(given) && plan.includes("gate repo add"), plan);
  assert.equal(ledgerOf(repo).planSeq, null, "a refused plan note writes nothing");

  const mixed = cli(repo, "note", ["plan", "The plan.", "--files", `${given},src/a.ts`]);
  assert.match(mixed, /tier predicted tiny \(1 file\)/);
  const note = mixed.split("\n").find((l) => l.includes(given));
  assert.ok(note?.includes("gate repo add"), mixed);
  assert.deepEqual(ledgerOf(repo).tier.predictedFiles, ["src/a.ts"]);

  edit(repo, repo, "src/a.ts", lines(21, "a"));
  for (const files of [given, `${given}:3-9`]) {
    const brief = refused(repo, "brief", ["reviewer", "--files", files]);
    assert.ok(brief.includes(given) && brief.includes("gate repo add"), brief);
    assert.doesNotMatch(brief, /null/);
  }
});

// ---------------------------------------------------------------------------
// no declared repo, cost, a repo that goes away
// ---------------------------------------------------------------------------

test("C14 boundary: a run with no declared repo snapshots, sizes, briefs and closes as before, and a ledger with no repos key works", () => {
  const repo = committed("mr-c14");
  const stranger = sibling("mr-c14");
  openRun(repo, "mr-c14", { files: "src/a.ts" });
  const strip = () => {
    const ledger = loadLedger(runDir(repo));
    delete ledger.repos;
    delete ledger.baseline.heads;
    saveLedger(runDir(repo), ledger);
  };
  strip(); // a ledger from before this change
  edit(repo, repo, "src/a.ts", lines(20, "a") + lines(3, "z"));
  edit(repo, stranger, "src/a.py", py(25)); // a sibling nobody declared
  assert.deepEqual(editPaths(repo), ["src/a.ts"]);
  const size = sizeOf(repo);
  assert.equal(size.files, 1, size.out);
  assert.equal(size.lines, 3, size.out);
  assert.deepEqual(size.rows, { "src/a.ts": { lines: 3, estimate: false } }, size.out);
  const packet = packetOf(cli(repo, "brief", ["reviewer"]));
  assert.ok(packet.includes("diff --git a/src/a.ts b/src/a.ts"));
  assert.ok(packet.includes("+export const z2 = 2;"));
  assert.ok(!packet.includes("../"), "nothing of the sibling is in the packet");
  assert.doesNotMatch(check(repo), /\.\.\/|R13/);

  const closing = committed("mr-c14-close");
  openRun(closing, "mr-c14-close", { files: "src/b.ts" });
  const ledger = loadLedger(runDir(closing));
  delete ledger.repos;
  delete ledger.baseline.heads;
  saveLedger(runDir(closing), ledger);
  edit(closing, closing, "src/b.ts", lines(10, "b").replace("b0 = 0", "b0 = 100"));
  closeRun(closing);
  assert.doesNotMatch(cli(closing, "report"), /\.\.\//);
  assert.ok(Object.keys(loadSession(stateDir(closing), "S1").baseline.files).includes("src/b.ts"));
});

test("C15 performance: with one declared repo, gate check and the hook stamp list the repo once per snapshot, not once per file", () => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/f${i}.py`, py(3, `f${i}_`)]));
  const { repo, other } = pair("mr-c15", { otherFiles: many });
  const shim = gitShim(repo, "mr-c15");
  const root = realpathSync(other);
  const mainRoot = realpathSync(repo);
  const listings = (where) => shim.calls().filter((c) => /(^|\s)ls-files(\s|$)/.test(c.args) && (c.cwd === where || c.args.split(/\s+/).includes(where))).length;
  const touch = (n) => {
    for (let i = 0; i < n; i++) write(other, `src/f${i}.py`, py(3, `f${i}_`) + `changed${n} = ${i}\n`);
  };

  touch(3);
  shim.reset();
  check(repo, { env: shim.env });
  const few = listings(root);
  const fewMain = listings(mainRoot);
  assert.ok(fewMain > 0, "the shim sees the main repo's listing");
  assert.ok(few > 0, `gate check never listed the declared repo:\n${shim.calls().map((c) => `${c.cwd} ${c.args}`).join("\n")}`);
  assert.ok(few <= fewMain, `the declared repo is listed ${few} times, the main one ${fewMain}`);

  touch(30);
  shim.reset();
  check(repo, { env: shim.env });
  assert.equal(listings(root), few, "30 changed files cost the same listings as 3");

  // the hook stamp: one snapshot, so one ls-files pair for the repo
  touch(3);
  shim.reset();
  command(repo, "ls src", { env: shim.env });
  const stamped = listings(root);
  assert.ok(stamped >= 1 && stamped <= 2, `the hook listed the declared repo ${stamped} times`);
  assert.ok(stamped <= listings(mainRoot), "no more often than the main repo");
});

test("C24 edge: a declared repo whose directory is removed mid-run crashes neither the hook nor gate check; gate check lists it as unmet under R13", () => {
  const { repo, other, p } = pair("mr-c24");
  edit(repo, other, "src/a.py", py(21));
  rmSync(other, { recursive: true, force: true });

  const out = command(repo, "ls src"); // the hook exits 0 and prints valid JSON or nothing
  assert.ok(out === null || typeof out === "object");
  edit(repo, repo, "src/a.ts", lines(21, "a"));
  assert.equal(existsSync(path.join(stateDir(repo), "gate-error.log")), false, "the hook logged no crash");

  const checked = check(repo);
  const line = checked.split("\n").find((l) => /\bR13\b/.test(l) && l.includes(p));
  assert.ok(line, `no R13 line names ${p}:\n${checked}`);
  assert.equal(existsSync(path.join(stateDir(repo), "gate-error.log")), false);
  cli(repo, "size");
  cli(repo, "report");
});

// ---------------------------------------------------------------------------
// review round 1
// ---------------------------------------------------------------------------

test("H4.1 edge: what a late-declared repo held uncommitted at declaration stays this run's when it is committed outside the run", () => {
  const repo = committed("mr-h41");
  const other = sibling("mr-h41");
  const p = "../mr-h41-other";
  openRun(repo, "mr-h41", { files: "src/a.ts" });
  write(other, "src/a.py", py(20) + py(5, "y"));
  write(other, "src/n.py", py(7, "n"));
  cli(repo, "repo", ["add", p]);
  otherCommit(other, "src/a.py", py(20) + py(5, "y"));
  otherCommit(other, "src/n.py", py(7, "n"));

  check(repo);
  assert.deepEqual(foreignOf(repo), [], "neither file is another session's");
  const size = sizeOf(repo);
  assert.equal(size.rows[`${p}/src/a.py`]?.lines, 5, size.out);
  assert.equal(size.rows[`${p}/src/n.py`]?.lines, 7, size.out);
  cli(repo, "brief", ["reviewer", "--files", `${p}/src/a.py,${p}/src/n.py`]); // refused when a file is outside the review scope
});

test("H2.1 edge: at a late declaration a modified, a deleted and a staged-new tracked file count; put back to the committed content, a file leaves the run", () => {
  const repo = committed("mr-h21");
  const other = sibling("mr-h21", { "src/d.py": py(4, "d") });
  const p = "../mr-h21-other";
  openRun(repo, "mr-h21", { files: "src/a.ts" });
  write(other, "src/a.py", py(20) + py(2, "y"));
  rmSync(path.join(other, "src/d.py"));
  write(other, "src/s.py", py(5, "s"));
  git(other, ["add", "src/s.py"]);
  cli(repo, "repo", ["add", p]);
  const lineCounts = () => Object.fromEntries(Object.entries(sizeOf(repo).rows).map(([f, r]) => [f, r.lines]));
  assert.deepEqual(lineCounts(), { [`${p}/src/a.py`]: 2, [`${p}/src/d.py`]: 4, [`${p}/src/s.py`]: 5 });

  write(other, "src/a.py", py(20));
  write(other, "src/d.py", py(4, "d"));
  assert.deepEqual(lineCounts(), { [`${p}/src/s.py`]: 5 });
  assert.doesNotMatch(check(repo), /src\/a\.py|src\/d\.py/);

  edit(repo, other, "src/a.py", py(20) + py(3, "z")); // changed again, it is measured like any clean file
  assert.equal(lineCounts()[`${p}/src/a.py`], 3);
});

test("H4.2 edge: a tracked, modified file the snapshot never lists (.claude/settings.local.json) gets no baseline entry at a late declaration", () => {
  const repo = committed("mr-h42");
  const other = sibling("mr-h42", { ".claude/settings.local.json": "{}\n" });
  const p = "../mr-h42-other";
  openRun(repo, "mr-h42", { files: "src/a.ts" });
  write(other, ".claude/settings.local.json", '{ "a": 1 }\n');
  cli(repo, "repo", ["add", p]);
  check(repo);
  assert.deepEqual(Object.keys(ledgerOf(repo).baseline.files).filter((f) => f.includes("settings.local.json")), []);
  assert.doesNotMatch(cli(repo, "report"), /settings\.local\.json/);
});

test("H2.2 refused: --repo=<path> declares the repo like --repo <path>; an unknown option to gate open is refused and opens nothing", () => {
  const repo = committed("mr-h22");
  sibling("mr-h22");
  cli(repo, "open", ["mr-h22", "feature", "--repo=../mr-h22-other"]);
  assert.deepEqual(prefixesOf(repo), ["../mr-h22-other"]);

  const plain = committed("mr-h22-plain");
  sibling("mr-h22-plain");
  assert.match(refused(plain, "open", ["mr-h22-plain", "feature", "--repos", "../mr-h22-plain-other"]), /--repos/);
  refused(plain, "open", ["mr-h22-plain", "feature", "--repo="]);
  assert.equal(existsSync(path.join(stateDir(plain), "runs")), false, "no run was opened");
});

test("H5 boundary: a relative repo path is read from the main root whatever the shell's cwd; one refused --repo on an open run declares none; a declared repo's malformed gate.json is refused with its path", () => {
  const repo = committed("mr-h5");
  sibling("mr-h5");
  const elsewhere = spawnSync(process.execPath, [gate, "open", "mr-h5", "feature", "--repo", "../mr-h5-other"], { input: "", encoding: "utf8", env: envFor(repo), cwd: here });
  assert.ok(!REFUSAL.test(elsewhere.stderr), elsewhere.stderr);
  assert.deepEqual(prefixesOf(repo), ["../mr-h5-other"]);

  const late = committed("mr-h5-late");
  sibling("mr-h5-late");
  cli(late, "open", ["mr-h5-late", "feature"]);
  refused(late, "open", ["mr-h5-late", "--repo", "../mr-h5-late-other", "--repo", "../mr-h5-late-nope"]);
  assert.deepEqual(prefixesOf(late), [], "the good path is not declared when the other is refused");

  sibling("mr-h5-late", { ".claude/gate.json": "{ nope" }, "broken");
  assert.match(refused(late, "repo", ["add", "../mr-h5-late-broken"]), /mr-h5-late-broken\/\.claude\/gate\.json/);
  assert.deepEqual(prefixesOf(late), []);
});

// A sibling git repo with no commit yet: two files written and staged.
function unborn(name) {
  const dir = path.join(here, ".tmp", `${name}-other`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  write(dir, "src/a.py", py(6));
  write(dir, "src/b.py", py(4, "b"));
  git(dir, ["add", "-A"]);
  return dir;
}

test("H11.1 edge: a repo with no commit yet, declared late, has every staged file counted whole, and committing them outside the run does not make them leave; declared at gate open, what it holds is the baseline", () => {
  const repo = committed("mr-h111");
  const other = unborn("mr-h111");
  const p = "../mr-h111-other";
  openRun(repo, "mr-h111", { files: "src/a.ts" });
  cli(repo, "repo", ["add", p]);
  const lineCounts = () => Object.fromEntries(Object.entries(sizeOf(repo).rows).map(([f, r]) => [f, r.lines]));
  assert.deepEqual(lineCounts(), { [`${p}/src/a.py`]: 6, [`${p}/src/b.py`]: 4 });
  git(other, [...commitArgs, "outside the run"]);
  check(repo);
  assert.deepEqual(foreignOf(repo), []);
  assert.deepEqual(lineCounts(), { [`${p}/src/a.py`]: 6, [`${p}/src/b.py`]: 4 });

  // at gate open on a new run: the files are there before the run, an edit is a line-delta estimate
  const fresh = committed("mr-h111-open");
  const freshOther = unborn("mr-h111-open");
  const q = "../mr-h111-open-other";
  openRun(fresh, "mr-h111-open", { repos: [q], files: `${q}/src/a.py` });
  assert.equal(sizeOf(fresh).files, 0);
  assert.deepEqual(ledgerOf(fresh).baseline.based, [], "no base copies without a HEAD");
  edit(fresh, freshOther, "src/a.py", py(6) + py(3, "z"));
  assert.deepEqual(sizeOf(fresh).rows, { [`${q}/src/a.py`]: { lines: 3, estimate: true } });
});

test("H11 boundary: a refused --repo on an open run does not attach the session", () => {
  const repo = committed("mr-h11-attach");
  cli(repo, "open", ["mr-h11-attach", "feature"]);
  const second = envFor(repo, "S2");
  const r = run(repo, "open", ["mr-h11-attach", "--repo", "../mr-h11-attach-nope"], { env: second });
  assert.ok(REFUSAL.test(r.stderr), r.stdout);
  assert.deepEqual(ledgerOf(repo).sessions, ["S1"]);
  assert.equal(loadSession(stateDir(repo), "S2"), null);
});
