// read-first: what an agent remembers of a file points at it; the file decides. The log hook
// records each file an agent opened (a Read, a shell command that shows it, its own edit) with a
// hash of the content; the fence refuses an edit, and `gate note context` a citation, of a file
// the agent has not opened as it is now. Cases C1–C24 of the task's case table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, lookedUp } from "./helpers.mjs";
import { readEvents, seen } from "../scripts/lib/events.mjs";

const envFor = (repo, session = "S1") => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
};
const run = (repo, args, session = "S1") => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: envFor(repo, session) });
function cli(repo, args, session = "S1") {
  const r = run(repo, args, session);
  assert.equal(r.status, 0, `gate ${args.slice(0, 2).join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function hook(repo, verb, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, verb], { input: JSON.stringify({ session_id: session, cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo, session) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().startsWith("{") ? (JSON.parse(r.stdout).hookSpecificOutput?.permissionDecisionReason ?? null) : null;
}
const as = (agent, role) => (agent ? { agent_id: agent, agent_type: `done-gate:${role}` } : {});
const who = ({ agent = null, role = "worker", session = "S1" } = {}) => [as(agent, role), session];

// null when the fence lets the edit through, else its reason
function editFence(repo, file, opts = {}, tool = "Edit", tool_input = { file_path: path.join(repo, file) }) {
  const [agent, session] = who(opts);
  return hook(repo, "fence", { hook_event_name: "PreToolUse", tool_name: tool, tool_input, ...agent }, session);
}
function logged(repo, tool, tool_input, opts = {}, extra = {}) {
  const [agent, session] = who(opts);
  hook(repo, "log", { hook_event_name: "PostToolUse", tool_name: tool, tool_input, tool_response: { exit_code: 0, stdout: "", stderr: "" }, ...agent, ...extra }, session);
}
const read = (repo, file, opts) => logged(repo, "Read", { file_path: path.join(repo, file) }, opts);
const edited = (repo, file, opts) => logged(repo, "Edit", { file_path: path.join(repo, file) }, opts);
const shell = (repo, command, opts, extra) => logged(repo, "Bash", { command }, opts, extra);

const OPEN_FIRST = (file) => new RegExp(`^done-gate: open ${file.replace(/[.]/g, "\\.")} as it is now before editing it`);
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const NOTE = (traced) => ["note", "context", `Traced: ${traced} · Related: none: \`grep -rn a src\` · Research: none needed: a test fixture`];

const docs = (name) => makeRepo(name, { "docs/other.md": "# other\n" });
// a run with its Task, the lead's two searches made and no file opened yet
function searched(name) {
  const repo = makeRepo(name);
  cli(repo, ["open", name, "feature"]);
  cli(repo, ["note", "task", "the task"]);
  lookedUp(repo, { opens: [] });
  return repo;
}

test("C1 happy: the lead Reads a file, then edits it", () => {
  const repo = docs("rf-c1");
  read(repo, "docs/other.md");
  assert.equal(editFence(repo, "docs/other.md"), null);
});

test("C2 refused: an existing file the lead never opened; the message names it and says how to open it", () => {
  const repo = docs("rf-c2");
  const reason = editFence(repo, "docs/other.md");
  assert.match(reason, OPEN_FIRST("docs/other.md"));
  assert.match(reason, /Read it, or cat, sed -n or grep it/);
});

test("C3 refused: a file changed on disk after the lead opened it, until it is opened again", () => {
  const repo = docs("rf-c3");
  read(repo, "docs/other.md");
  write(repo, "docs/other.md", "# other, by someone else\n");
  assert.match(editFence(repo, "docs/other.md"), OPEN_FIRST("docs/other.md"));
  read(repo, "docs/other.md");
  assert.equal(editFence(repo, "docs/other.md"), null);
});

test("C4 happy: the lead's own edit counts as seen, so a second edit needs no read", () => {
  const repo = docs("rf-c4");
  read(repo, "docs/other.md");
  write(repo, "docs/other.md", "# other, edited\n");
  edited(repo, "docs/other.md");
  assert.equal(editFence(repo, "docs/other.md"), null);
});

test("C5 edge: a file changed and put back to the content the lead opened", () => {
  const repo = docs("rf-c5");
  read(repo, "docs/other.md");
  write(repo, "docs/other.md", "# changed\n");
  write(repo, "docs/other.md", "# other\n");
  assert.equal(editFence(repo, "docs/other.md"), null);
});

test("C6 boundary: a Write that creates a file needs no read", () => {
  const repo = docs("rf-c6");
  assert.equal(editFence(repo, "docs/new.md", {}, "Write"), null);
});

test("C7 boundary: scratch, the run's ledger.md and a file outside the repo are not checked", () => {
  const repo = searched("rf-c7");
  write(repo, "tests/.tmp/probe.txt", "x\n");
  assert.equal(editFence(repo, "tests/.tmp/probe.txt"), null);
  const runs = path.join(stateDir(repo), "runs");
  assert.equal(editFence(repo, path.join(".claude", "gate", "runs", readdirSync(runs)[0], "ledger.md")), null);
  const outside = path.join(os.tmpdir(), `rf-c7-${process.pid}.txt`);
  writeFileSync(outside, "x\n");
  assert.equal(editFence(repo, "", {}, "Edit", { file_path: outside }), null);
});

test("C8 happy: a shell command that shows the file counts, beside other commands and from a folder inside the repo", () => {
  for (const [i, command] of ["cat docs/other.md", "sed -n 1,5p docs/other.md", "head -3 docs/other.md", "tail -n 2 docs/other.md", "grep -n other docs/other.md", "git status --short; npm test 2>&1 | tail -3; cat docs/other.md", "sed -n 1,5p docs/other.md | cut -c1-200", "grep -n other docs/other.md | head -5", "cat docs/other.md 2>/dev/null", "grep -A 2 -e other docs/other.md", "rtk read docs/other.md"].entries()) {
    const repo = docs(`rf-c8-${i}`);
    shell(repo, command);
    assert.equal(editFence(repo, "docs/other.md"), null, command);
  }
  const repo = docs("rf-c8-cwd");
  shell(repo, "cat other.md", {}, { cwd: path.join(repo, "docs") });
  assert.equal(editFence(repo, "docs/other.md"), null);
  // a command that starts by changing folder, once, to a literal path: its files are read from there
  for (const [i, command] of [(root) => `cd ${root} && cat docs/other.md`, (root) => `cd ${root}; sed -n 1,3p docs/other.md | head`, () => "cd docs && grep -n other other.md", (root) => `cd docs && cat ${root}/docs/other.md`].entries()) {
    const led = docs(`rf-c8-cd-${i}`);
    shell(led, command(led));
    assert.equal(editFence(led, "docs/other.md"), null, command(led));
  }
});

test("C9 edge: a command that does not show the file does not count", () => {
  for (const [i, command] of ["sed -i '' s/other/more/ docs/other.md", "cat docs/other.md > /tmp/rf-c9-copy.md", "ls docs/other.md", "wc -l docs/other.md", "grep -rn other docs", "echo docs/other.md", "grep -n docs/other.md docs/notes.md", "grep -A 2 docs/other.md docs/notes.md", "grep -c other docs/other.md", "grep -q other docs/other.md", "grep -l other docs/other.md", "cat docs/other.md > /dev/null", "cat docs/other.md | wc -l", "sed -n 1,5p docs/other.md | grep -c other"].entries()) {
    const repo = docs(`rf-c9-${i}`);
    shell(repo, command);
    assert.match(editFence(repo, "docs/other.md"), OPEN_FIRST("docs/other.md"), command);
  }
});

test("C9 edge: a folder change is followed only when it leads the command, once, to a literal path; a same-named file elsewhere is not taken for opened", () => {
  const two = (name) => makeRepo(name, { "README.md": "# top\n", "docs/README.md": "# docs\n" });
  const followed = two("rf-c9-cd-followed");
  shell(followed, "cd docs && cat README.md");
  assert.match(editFence(followed, "README.md"), OPEN_FIRST("README.md"));
  assert.equal(editFence(followed, "docs/README.md"), null);
  for (const [i, command] of ["(cd docs; cat README.md)", "(cd docs); cat README.md", "pushd docs; head README.md", "cd docs && cd .. && cat README.md", "cd docs && cd .. && cat docs/README.md; cat README.md", "ls; cd docs; cat ../README.md", "cd $HOME/x && cat README.md"].entries()) {
    const repo = two(`rf-c9-cd-${i}`);
    shell(repo, command);
    assert.deepEqual(readEvents(stateDir(repo), "S1").filter((e) => e.kind === "read"), [], command);
  }
});

test("C10 refused: each agent opens a file itself", () => {
  const repo = searched("rf-c10");
  write(repo, "docs/other.md", "# other\n");
  read(repo, "docs/other.md", { agent: "R1", role: "reviewer" });
  read(repo, "src/a.ts", { agent: "R1", role: "reviewer" });
  assert.match(editFence(repo, "docs/other.md"), OPEN_FIRST("docs/other.md"));
  assert.match(run(repo, NOTE("src/a.ts:1")).stderr, /src\/a\.ts not opened as it is now/);

  read(repo, "docs/notes.md");
  assert.match(editFence(repo, "docs/notes.md", { agent: "W1" }), OPEN_FIRST("docs/notes.md"));
  read(repo, "docs/notes.md", { agent: "W1" });
  assert.equal(editFence(repo, "docs/notes.md", { agent: "W1" }), null);
});

test("C11 refused: a context note citing files the lead did not open names each; once opened the same note is recorded", () => {
  const repo = searched("rf-c11");
  read(repo, "tests/a.test.ts");
  const note = NOTE("src/a.ts:1 is the entry, read by src/app/page.tsx:1 and tested in tests/a.test.ts:1");
  const r = run(repo, note);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Traced: src\/a\.ts, src\/app\/page\.tsx not opened as they are now/);
  assert.match(r.stderr, /Read, or cat, sed -n or grep/);
  assert.doesNotMatch(r.stderr, /tests\/a\.test\.ts/);
  read(repo, "src/a.ts");
  shell(repo, "cat src/app/page.tsx");
  assert.match(cli(repo, note), /context noted/);
});

test("C12 edge: a cited file that changed after the lead opened it is refused; one the lead edited since is accepted", () => {
  const repo = searched("rf-c12");
  read(repo, "src/a.ts");
  write(repo, "src/a.ts", "export const a0 = 1;\n");
  assert.match(run(repo, NOTE("src/a.ts:1")).stderr, /src\/a\.ts not opened as it is now/);
  edited(repo, "src/a.ts");
  assert.match(cli(repo, NOTE("src/a.ts:1")), /context noted/);
});

test("C13 boundary: a new session opens the file again", () => {
  const repo = docs("rf-c13");
  read(repo, "docs/other.md");
  assert.match(editFence(repo, "docs/other.md", { session: "S2" }), OPEN_FIRST("docs/other.md"));
  assert.equal(editFence(repo, "docs/other.md"), null);
});

test("C14 refused: a MultiEdit over two files names the one not opened", () => {
  const repo = docs("rf-c14");
  read(repo, "docs/other.md");
  const input = { file_path: path.join(repo, "docs/other.md"), edits: [{ file_path: path.join(repo, "docs/notes.md"), old_string: "a", new_string: "b" }] };
  const reason = editFence(repo, "", {}, "MultiEdit", input);
  assert.match(reason, OPEN_FIRST("docs/notes.md"));
  assert.doesNotMatch(reason, /other\.md/);
});

test("C15 edge: an unreadable run fails open", () => {
  const repo = searched("rf-c15");
  write(repo, "docs/other.md", "# other\n");
  assert.match(editFence(repo, "docs/other.md"), OPEN_FIRST("docs/other.md"));
  const runs = path.join(stateDir(repo), "runs");
  writeFileSync(path.join(runs, readdirSync(runs)[0], "ledger.json"), "{ not json");
  assert.equal(editFence(repo, "docs/other.md"), null);
});

test("C16 idempotent: the same Read twice", () => {
  const repo = docs("rf-c16");
  read(repo, "docs/other.md");
  read(repo, "docs/other.md");
  const reads = readEvents(stateDir(repo), "S1").filter((e) => e.kind === "read");
  assert.deepEqual(reads.map((e) => e.path), ["docs/other.md", "docs/other.md"]);
  assert.equal(reads[0].hash, reads[1].hash);
  assert.match(reads[0].hash, /^[0-9a-f]{16}$/);
  assert.equal(editFence(repo, "docs/other.md"), null);
});

test("C17 reported-surface: the refusal is a deny event the report does not count as a blocked write to gate files", () => {
  const repo = searched("rf-c17");
  write(repo, "docs/other.md", "# other\n");
  editFence(repo, "docs/other.md");
  const deny = readEvents(stateDir(repo), "S1").filter((e) => e.kind === "deny");
  assert.equal(deny.length, 1);
  assert.equal(deny[0].path, "docs/other.md");
  assert.equal(deny[0].unopened, true);
  assert.match(cli(repo, ["report"]), /blocked writes to gate files 0\b/);
});

test("C18 performance: the seen check on a 5 MB session file of 20000 events answers within 200 ms", () => {
  const dir = path.join(stateDir(makeRepo("rf-c18")), "sessions", "S1");
  mkdirSync(dir, { recursive: true });
  const filler = "x".repeat(180);
  const lines = Array.from({ length: 20000 }, (_, i) => JSON.stringify({ seq: i + 1, session: "S1", agent: null, kind: i % 50 ? "command" : "read", path: i % 50 ? undefined : `src/f${i}.ts`, hash: "0".repeat(16), cmd: filler }));
  lines.push(JSON.stringify({ seq: 20001, session: "S1", agent: null, kind: "read", path: "docs/other.md", hash: "abcdef0123456789" }));
  appendFileSync(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
  const start = process.hrtime.bigint();
  const found = seen(path.dirname(path.dirname(dir)), "S1", null, "docs/other.md", "abcdef0123456789");
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(found, true);
  assert.equal(seen(path.dirname(path.dirname(dir)), "S1", "W1", "docs/other.md", "abcdef0123456789"), false);
  assert.ok(ms < 200, `seen took ${ms.toFixed(0)} ms`);
});

test("C19 refused: a Read that failed or was denied records nothing", () => {
  const repo = docs("rf-c19");
  hook(repo, "fence", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(repo, "docs/other.md") } });
  hook(repo, "log", { hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_input: { file_path: path.join(repo, "docs/other.md") }, error: "File content exceeds maximum allowed tokens" });
  assert.deepEqual(readEvents(stateDir(repo), "S1").filter((e) => e.kind === "read"), []);
  assert.match(editFence(repo, "docs/other.md"), OPEN_FIRST("docs/other.md"));
});

test("C20 edge: the hash is taken after the command; a failed and a background command record no read", () => {
  const written = docs("rf-c20-written");
  write(written, "docs/other.md", "# more\n");
  shell(written, "sed -i '' s/other/more/ docs/other.md && cat docs/other.md");
  assert.equal(editFence(written, "docs/other.md"), null);

  const failed = docs("rf-c20-failed");
  hook(failed, "log", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "cat docs/other.md && false" }, error: "Exit code 1\n# other" });
  assert.match(editFence(failed, "docs/other.md"), OPEN_FIRST("docs/other.md"));

  const background = docs("rf-c20-background");
  logged(background, "Bash", { command: "cat docs/other.md", run_in_background: true });
  assert.match(editFence(background, "docs/other.md"), OPEN_FIRST("docs/other.md"));
});

test("C21 happy: a MultiEdit with its file at the top logs an edit event with the hash", () => {
  const repo = docs("rf-c21");
  logged(repo, "MultiEdit", { file_path: path.join(repo, "docs/other.md"), edits: [{ old_string: "a", new_string: "b" }] });
  const edits = readEvents(stateDir(repo), "S1").filter((e) => e.kind === "edit");
  assert.deepEqual(edits.map((e) => e.path), ["docs/other.md"]);
  assert.match(edits[0].hash, /^[0-9a-f]{16}$/);
  assert.equal(editFence(repo, "docs/other.md"), null);
});

test("C22 boundary: a context note in a new session of the run does not count the earlier session's reads", () => {
  const repo = searched("rf-c22");
  read(repo, "src/a.ts");
  cli(repo, ["attach", "rf-c22"], "S2");
  assert.match(run(repo, NOTE("src/a.ts:1"), "S2").stderr, /src\/a\.ts not opened as it is now/);
  read(repo, "src/a.ts", { session: "S2" });
  assert.match(cli(repo, NOTE("src/a.ts:1"), "S2"), /context noted/);
});

test("C23 boundary: a Traced pointer to an absolute path outside every repo is not checked", () => {
  const repo = searched("rf-c23");
  assert.match(cli(repo, NOTE(`${path.join(pluginRoot, "package.json")}:1 is the plugin's own`)), /context noted/);
});

test("C24 refused: with no run open, an edit of a file the session did not open; allowed after a Read", () => {
  const repo = makeRepo("rf-c24", { "README.md": "# readme\n" });
  assert.match(editFence(repo, "README.md"), OPEN_FIRST("README.md"));
  read(repo, "README.md");
  assert.equal(editFence(repo, "README.md"), null);
});
