import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

// The three slow parts: a review loop that ran on after a clean round, a size that counted
// other sessions' work, and a build that ran on test-only changes.

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

const REFUSAL = /^done-gate: /m;
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const check = (repo) => run(repo, "check").stdout;
const blocks = (out, rule) => out.split("\n").some((l) => new RegExp(`\\b${rule}\\b`).test(l));

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));

function hook(repo, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
}
// an edit-tool edit: the bytes land, then PostToolUse fires
function edit(repo, rel, content, session = "S1") {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) } }, session);
}
const stop = (repo, role) => hook(repo, { hook_event_name: "SubagentStop", agent_id: `A-${role}`, agent_type: `done-gate:${role}` });
const reviewFile = (n, actOn) => `# Review ${n}\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n\n## Consider\n- rename the helper\n`;

function committed(name, files) {
  const repo = makeRepo(name, files);
  const git = (args) => execFileSync("git", args, { cwd: repo });
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

function opened(name, { files = {}, planFiles = "src/a.ts" } = {}) {
  const repo = committed(name, files);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: none\nResearch: none needed: tiny"]);
  cli(repo, "note", ["plan", "One module. No hot path.", "--files", planFiles]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  return repo;
}

// One reviewer round: the helper stops, its file lands, the lead records it.
function round(repo, role, n, actOn = []) {
  cli(repo, "brief", [role]);
  stop(repo, role);
  writeFileSync(path.join(runDir(repo), `review-${n}.md`), reviewFile(n, actOn));
  cli(repo, "huddle", ["add", role, "--file", `review-${n}.md`]);
}
const closeAll = (repo) => {
  for (const h of ledgerOf(repo).huddles) for (const a of h.actOn) if (!a.closed) cli(repo, "huddle", ["resolve", a.id, "--evidence", "src/a.ts:1"]);
};

// ---------------------------------------------------------------- review loop

test("C1 happy: a clean reviewer round, then an edit to a file the reviewer saw: R5 asks for no new round", () => {
  const repo = opened("fl-c1");
  edit(repo, "src/a.ts", "export const a = 2;\n");
  round(repo, "reviewer", 1);
  assert.ok(!blocks(check(repo), "R5"), check(repo));
  edit(repo, "src/a.ts", "export const a = 3; // polish from Consider\n");
  assert.ok(!blocks(check(repo), "R5"), `a clean round should end the loop:\n${check(repo)}`);
});

test("C2 refused: a clean round, then a new implementation file: R5 demands a fresh round", () => {
  const repo = opened("fl-c2");
  edit(repo, "src/a.ts", "export const a = 2;\n");
  round(repo, "reviewer", 1);
  edit(repo, "src/b.ts", "export const b = 1;\n");
  assert.ok(blocks(check(repo), "R5"), `a file the reviewer never saw must be reviewed:\n${check(repo)}`);
});

test("C3 refused: a round with Act-on items, fixed and closed below the cap: R5 demands a round that sees the fix", () => {
  const repo = opened("fl-c3");
  edit(repo, "src/a.ts", "export const a = 2;\n");
  round(repo, "reviewer", 1, ["the badge is wrong — src/a.ts:1"]);
  edit(repo, "src/a.ts", "export const a = 4;\n");
  closeAll(repo);
  assert.ok(blocks(check(repo), "R5"), `a fix below the cap is verified by another round:\n${check(repo)}`);
});

test("C4 boundary: round three has items; fixed and closed in seen files, R5 passes and no fourth round is asked", () => {
  const repo = opened("fl-c4");
  edit(repo, "src/a.ts", "export const a = 2;\n");
  for (const n of [1, 2, 3]) {
    round(repo, "reviewer", n, [`finding ${n} — src/a.ts:1`]);
    edit(repo, "src/a.ts", `export const a = ${10 + n};\n`);
    closeAll(repo);
  }
  assert.ok(!blocks(check(repo), "R5"), `after the cap, closed items are enough:\n${check(repo)}`);
});

test("C5 edge: reviewer-2 on a high-risk path: a clean round then an edit in a seen file passes R9; a fourth reviewer-2 round is refused", () => {
  const repo = opened("fl-c5", { files: { "src/lib/auth/x.ts": "export const x = 1;\n" }, planFiles: "src/lib/auth/x.ts" });
  edit(repo, "src/lib/auth/x.ts", "export const x = 2;\n");
  round(repo, "reviewer", 1);
  round(repo, "reviewer-2", 2);
  edit(repo, "src/lib/auth/x.ts", "export const x = 3;\n");
  const out = check(repo);
  assert.ok(!blocks(out, "R9"), `a clean second review should end its loop:\n${out}`);
  assert.ok(!blocks(out, "R5"), out);

  const capped = opened("fl-c5b", { files: { "src/lib/auth/x.ts": "export const x = 1;\n" }, planFiles: "src/lib/auth/x.ts" });
  edit(capped, "src/lib/auth/x.ts", "export const x = 2;\n");
  for (const n of [1, 2, 3]) {
    round(capped, "reviewer-2", n, [`finding ${n} — src/lib/auth/x.ts:1`]);
    closeAll(capped);
  }
  const r = run(capped, "brief", ["reviewer-2"]);
  assert.match(r.stderr, REFUSAL, `a fourth reviewer-2 round should be refused:\n${r.stdout}${r.stderr}`);
});

test("C6 idempotent: a huddle recorded before this change (no files) keeps the old rule: an edit after it needs a fresh round", () => {
  const repo = opened("fl-c6");
  edit(repo, "src/a.ts", "export const a = 2;\n");
  round(repo, "reviewer", 1);
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const h of ledger.huddles) delete h.files;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  edit(repo, "src/a.ts", "export const a = 3;\n");
  assert.ok(blocks(check(repo), "R5"), `an old huddle cannot vouch for later edits:\n${check(repo)}`);
});

test("C16 boundary: past the cap a round is briefed only when a file no round saw exists", () => {
  const repo = opened("fl-c16");
  edit(repo, "src/a.ts", "export const a = 2;\n");
  for (const n of [1, 2, 3]) {
    round(repo, "reviewer", n, [`finding ${n} — src/a.ts:1`]);
    edit(repo, "src/a.ts", `export const a = ${10 + n};\n`);
    closeAll(repo);
  }
  assert.match(run(repo, "brief", ["reviewer"]).stderr, REFUSAL);
  edit(repo, "src/b.ts", "export const b = 1;\n");
  assert.ok(blocks(check(repo), "R5"), check(repo));
  cli(repo, "brief", ["reviewer"]);
});

test("C2b refused: a clean review file with no reviewer stop after its brief does not end the loop", () => {
  const repo = opened("fl-c2b");
  edit(repo, "src/a.ts", "export const a = 2;\n");
  stop(repo, "reviewer"); // a stop before the brief proves nothing about this round
  cli(repo, "brief", ["reviewer"]);
  writeFileSync(path.join(runDir(repo), "review-1.md"), reviewFile(1, []));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  edit(repo, "src/a.ts", "export const a = 3;\n");
  assert.ok(blocks(check(repo), "R5"), `a hand-written review must not end the loop:\n${check(repo)}`);
});

test("C17 refused: re-adding an old clean review file does not widen what that round saw", () => {
  const repo = opened("fl-c17");
  edit(repo, "src/a.ts", "export const a = 2;\n");
  round(repo, "reviewer", 1);
  edit(repo, "src/b.ts", "export const b = 1;\n");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.ok(blocks(check(repo), "R5"), `a re-add must not vouch for src/b.ts:\n${check(repo)}`);
});

// ---------------------------------------------------------------- sizing

const measured = (repo) => Number(/measured \w+: (\d+) files?/.exec(cli(repo, "size"))?.[1]);
const commitAll = (repo) => {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "earlier task"], { cwd: repo });
};
// The session starts (its baseline is taken), an earlier task's work lands and is committed
// without a clean close, then the new task opens.
function afterEarlierWork(name, earlier, extra = () => {}) {
  const repo = committed(name, {});
  cli(repo, "check"); // the session's baseline is taken here
  for (const [rel, content] of Object.entries(earlier)) write(repo, rel, content);
  commitAll(repo);
  extra(repo);
  cli(repo, "open", [name, "feature"]);
  return repo;
}
const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/earlier${i}.ts`, `export const e${i} = 1;\n`]));

test("C12 reported surface: work committed before the task opened is not counted in its size", () => {
  const repo = afterEarlierWork("fl-c12", { ...many, "src/a.ts": "export const a = 9;\n" });
  write(repo, "src/b.ts", "export const b = 2;\n");
  assert.equal(measured(repo), 1, cli(repo, "size"));
  assert.doesNotMatch(cli(repo, "size"), /earlier\d+\.ts|src\/a\.ts/);
});

test("C13 edge: an uncommitted edit made in this session before gate open still counts", () => {
  const repo = afterEarlierWork("fl-c13", many, (r) => write(r, "src/a.ts", "export const a = 5; // before open\n"));
  write(repo, "src/b.ts", "export const b = 2;\n");
  assert.equal(measured(repo), 2, cli(repo, "size"));
});

test("C14 boundary: a committed deletion does not count; an untracked file created before open does", () => {
  const repo = afterEarlierWork("fl-c14", {}, (r) => {
    rmSync(path.join(r, "src/a.ts"));
    commitAll(r);
    write(r, "src/new.ts", "export const n = 1;\n");
  });
  assert.equal(measured(repo), 1, cli(repo, "size"));
  assert.match(cli(repo, "size"), /src\/new\.ts/);
});

test("C15 idempotent: with no git the session baseline is kept as before", () => {
  const repo = makeRepo("fl-c15");
  rmSync(path.join(repo, ".git"), { recursive: true, force: true });
  cli(repo, "check");
  write(repo, "src/a.ts", "export const a = 7;\n");
  cli(repo, "open", ["fl-c15", "feature"]);
  assert.equal(measured(repo), 1, cli(repo, "size"));
});

// ---------------------------------------------------------------- build skip

test("C9 happy: a build entry with no `when` (string or object) is skipped on a tests-only change; `when: always` still runs", () => {
  for (const build of ["npm run build", { cmd: "pnpm build", timeout: 60 }]) {
    const repo = makeRepo("fl-c9", { ".claude/gate.json": JSON.stringify({ verify: ["npm run lint", build] }) });
    const v = loadConfig(repo).verify;
    assert.equal(v[1].when, "source", JSON.stringify(v));
  }
  const always = makeRepo("fl-c9b", { ".claude/gate.json": JSON.stringify({ verify: [{ cmd: "npm run build", when: "always" }] }) });
  assert.equal(loadConfig(always).verify[0].when, "always");
});

test("C10 refused: entries that do not run a build keep `when: always` by default", () => {
  const repo = makeRepo("fl-c10", { ".claude/gate.json": JSON.stringify({ verify: ["npm run lint", { cmd: "npm run test" }, "npx tsc --noEmit", "npm run rebuild-index"] }) });
  for (const e of loadConfig(repo).verify) assert.equal(e.when, "always", JSON.stringify(e));
});

test("C18 refused: a compound command that includes a build keeps `when: always`", () => {
  const repo = makeRepo("fl-c18", { ".claude/gate.json": JSON.stringify({ verify: ["npm run build && npm test", "yarn build; yarn lint", "make build | tee log", "./gradlew build", "make build"] }) });
  for (const e of loadConfig(repo).verify) assert.equal(e.when, "always", JSON.stringify(e));
});

test("C9b happy: gate verify skips a hand-written build entry on a tests-only change", () => {
  const repo = opened("fl-c9b", { files: { ".claude/gate.json": JSON.stringify({ verify: ["true", "npm run build"] }) } });
  edit(repo, "tests/a.test.ts", "test('a', () => { /* more */ });\n");
  const out = cli(repo, "verify");
  assert.match(out, /npm run build — skipped/, out);
});

test("C15b idempotent: a project root below the git top level keeps the session baseline", () => {
  const top = committed("fl-c15b", { "app/src/a.ts": "export const a = 1;\n", "app/package.json": "{}" });
  const repo = path.join(top, "app");
  cli(repo, "check");
  write(repo, "src/a.ts", "export const a = 9;\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "earlier"], { cwd: top });
  cli(repo, "open", ["fl-c15b", "feature"]);
  assert.equal(measured(repo), 1, cli(repo, "size"));
});
