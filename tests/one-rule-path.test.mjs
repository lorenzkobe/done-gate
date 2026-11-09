// One rule path: a run this release opens has no older branch to fall into, and a run still open
// from before it is told to finish on its own version or be given up in the user's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { abandonArgs, asOldRun, gate, lookedUp, makeRepo, waiveArgs, write } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDirOf = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerFile = (repo) => path.join(runDirOf(repo), "ledger.json");
const rulesIn = (out) => [...out.matchAll(/^\d+\. (R\d+)/gm)].map((m) => m[1]);

function opened(name, files = {}) {
  return openIn(makeRepo(name, files), name);
}
// the repo's files committed first, so only what the run changes counts against it
function committed(name) {
  const repo = makeRepo(name, { ".gitignore": "node_modules/\nignored.txt\n.claude/gate/\n" });
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return openIn(repo, name);
}
function openIn(repo, name) {
  cli(repo, "open", [name, "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Change a. [inferred]"]);
  return repo;
}
function stamped(repo, rules) {
  const ledger = JSON.parse(readFileSync(ledgerFile(repo), "utf8"));
  writeFileSync(ledgerFile(repo), JSON.stringify({ ...ledger, rules }, null, 2));
}

test("C1 happy: a run this copy opens is stamped 2 and asks for the user's words to waive a step", () => {
  const repo = opened("orp-c1");
  assert.equal(JSON.parse(readFileSync(ledgerFile(repo), "utf8")).rules, 2);
  const r = run(repo, "waive", ["driver", "no time"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--user-ok/);
});

test("C2 refused: an open run with no rules stamp gets one R13 item naming abandon with the user's words, and close is refused", () => {
  const repo = opened("orp-c2");
  write(repo, "src/a.ts", "export const a0 = 2;\n");
  asOldRun(repo);
  const out = run(repo, "check").stdout;
  assert.deepEqual(rulesIn(out), ["R13"], out);
  assert.match(out, /older done-gate/);
  assert.match(out, /gate abandon orp-c2 "<why>" --user-ok "<their words>"/);
  const close = run(repo, "close");
  assert.notEqual(close.status, 0, close.stdout);
  assert.equal(JSON.parse(readFileSync(ledgerFile(repo), "utf8")).status, "open");
});

test("C3 boundary: a run stamped rules 1 is an older run too; one stamped 2 is not", () => {
  const repo = opened("orp-c3");
  stamped(repo, 1);
  assert.deepEqual(rulesIn(run(repo, "check").stdout), ["R13"]);
  stamped(repo, 2);
  assert.ok(!rulesIn(run(repo, "check").stdout).includes("R13"));
});

test("C4 happy: an older open run abandoned in the user's words leaves a clean check", () => {
  const repo = opened("orp-c4");
  asOldRun(repo);
  assert.deepEqual(rulesIn(run(repo, "check").stdout), ["R13"]);
  cli(repo, "abandon", abandonArgs(repo, "orp-c4", "opened on the older gate"));
  const after = run(repo, "check");
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  assert.deepEqual(rulesIn(after.stdout), []);
});

test("C10 edge: an old run abandoned with its change still dirty leaves R1; with the change committed the check is clean", () => {
  const git = (repo, args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  const dirty = committed("orp-c10a");
  write(dirty, "src/a.ts", "export const a0 = 2;\n");
  asOldRun(dirty);
  cli(dirty, "abandon", abandonArgs(dirty, "orp-c10a", "opened on the older gate"));
  assert.deepEqual(rulesIn(run(dirty, "check").stdout), ["R1"]);

  const clean = committed("orp-c10b");
  write(clean, "src/a.ts", "export const a0 = 2;\n");
  git(clean, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "the old run's change"]);
  asOldRun(clean);
  cli(clean, "abandon", abandonArgs(clean, "orp-c10b", "opened on the older gate"));
  assert.deepEqual(rulesIn(run(clean, "check").stdout), []);
});

test("C9 refused: no waiver is taken on an older open run, so the user's words never go to one that clears nothing", () => {
  const repo = opened("orp-c9");
  asOldRun(repo);
  for (const key of ["gate-config", "driver"]) {
    const r = run(repo, "waive", waiveArgs(repo, key, "the gate changed"));
    assert.notEqual(r.status, 0, `${key}: ${r.stdout}`);
    assert.match(r.stderr, /older done-gate/, key);
    assert.match(r.stderr, /gate abandon orp-c9/, key);
  }
  assert.deepEqual(JSON.parse(readFileSync(ledgerFile(repo), "utf8")).waivers, []);
});

test("C11 boundary: an older open run whose repo check fails still shows the R13 item alone", () => {
  const repo = opened("orp-c11", { ".claude/gate.json": JSON.stringify({ testFiles: null, checks: ["no-such-check"] }) });
  assert.ok(rulesIn(run(repo, "check").stdout).includes("R10"), "premise: the check fails on a new run");
  asOldRun(repo);
  assert.deepEqual(rulesIn(run(repo, "check").stdout), ["R13"]);
});

test("C5 edge: a closed ledger with no rules stamp still reports and counts in stats, with no R13", () => {
  const repo = opened("orp-c5");
  const dir = runDirOf(repo);
  cli(repo, "abandon", abandonArgs(repo, "orp-c5", "made only to be read back"));
  const file = path.join(dir, "ledger.json");
  const { rules: _gone, ...ledger } = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...ledger, status: "closed", closedAt: new Date().toISOString() }, null, 2));
  const report = run(repo, "report");
  assert.equal(report.status, 0, report.stderr);
  assert.doesNotMatch(report.stdout, /R13|older done-gate/);
  const stats = run(repo, "stats");
  assert.equal(stats.status, 0, stats.stderr);
  assert.match(stats.stdout, /\b1 run/);
});

test("C12 edge: this copy closes no step of an older open run: a green verify works out nothing and settles nothing", () => {
  const repo = committed("orp-c12");
  write(repo, "docs/notes.md", "# notes, changed\n");
  asOldRun(repo);
  cli(repo, "verify");
  run(repo, "check");
  const steps = JSON.parse(readFileSync(ledgerFile(repo), "utf8")).steps;
  for (const key of ["driver", "schema", "implement"]) assert.equal(steps.find((s) => s.key === key).state, null, key);

  const fresh = committed("orp-c12-new");
  write(fresh, "docs/notes.md", "# notes, changed\n");
  cli(fresh, "verify");
  const worked = JSON.parse(readFileSync(ledgerFile(fresh), "utf8")).steps;
  assert.equal(worked.find((s) => s.key === "driver").state, "N/A", "premise: a new run works the step out");
});

test("C7 refused: reviewer-2 is recorded only from review2-<n>.md, with no review2 brief before", () => {
  const repo = opened("orp-c7");
  write(runDirOf(repo), "review-1.md", "## Act on\n\n- nothing\n");
  const r = run(repo, "huddle", ["add", "reviewer-2", "--file", "review-1.md"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be that role's own review2-<n>\.md, not review-1\.md/);
});

test("C8 edge: R13 reads the config's current hash: unchanged raises nothing, a change raises it", () => {
  const repo = opened("orp-c8");
  assert.ok(!rulesIn(run(repo, "check").stdout).includes("R13"));
  write(repo, ".claude/gate.json", JSON.stringify({ testFiles: null, verify: ["true", "true --again"] }));
  const out = run(repo, "check").stdout;
  assert.ok(rulesIn(out).includes("R13"), out);
  assert.match(out, /\.claude\/gate\.json changed since this ledger opened/);
});
