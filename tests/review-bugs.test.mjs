import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, lookedUp } from "./helpers.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { DEFAULT_POLICY, loadPolicy } from "../scripts/lib/size.mjs";

// The bugs from the 0.16.0 review (docs: done-gate-review-0.16.0-2026-10-15.md, items 2.1,
// 2.2, 2.5, 2.8, 2.9 and 2.10). One test per case of the run's case table.

const NODE = JSON.stringify(process.execPath);
const REFUSAL = /^done-gate: /m;
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") => path.join(stateDir(repo), "runs", (({ current, lastClosed }) => current ?? lastClosed)(loadSession(stateDir(repo), session)));
const ledgerOf = (repo) => loadLedger(runDir(repo));
const stepOf = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key);
const errLog = (repo) => path.join(stateDir(repo), "gate-error.log");

function run(repo, verb, args = [], { session = "S1", input = "" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session },
  });
}
function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.notEqual(r.status, 0, `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.match(r.stderr, REFUSAL, `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  return r;
}
function hook(repo, verb, payload) {
  const r = run(repo, verb, [], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }) });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const stop = (repo) => {
  const out = hook(repo, "stop", { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done." }).stdout.trim();
  return out.startsWith("{") ? JSON.parse(out) : null;
};
// the fence denies a shell write into the gate's own evidence files: a "blocked write"
const denied = (repo) => {
  const out = hook(repo, "fence", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo x >> .claude/gate/runs/x/events.jsonl" } }).stdout;
  assert.match(out, /deny/, `premise: the fence denies the write:\n${out}`);
};

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
function opened(name, playbook = "feature", files = {}) {
  const repo = committed(name, { ".claude/gate.json": JSON.stringify({ verify: [`${NODE} -e "process.exit(0)"`] }), ...files });
  cli(repo, "open", ["t", playbook]);
  return repo;
}

test("C1 reported-surface: `gate verify --step` with a step that is not a verify step is refused before anything runs, and the step stays open", () => {
  const repo = opened("rb-c1", "bugfix");
  for (const key of ["repro", "rootcause", "skeptic", "close", "context"]) {
    const r = refused(repo, "verify", ["--step", key]);
    assert.match(r.stderr, /verify/, r.stderr);
    assert.equal(stepOf(repo, key).state, null, `{${key}} was closed by verify`);
  }
  assert.ok(!existsSync(path.join(runDir(repo), "verify.json")), "a refused verify still ran the commands");
});

test("C2 refused: `gate verify --step` with no value is refused with the usage and never prints {undefined}", () => {
  const repo = opened("rb-c2", "bugfix");
  const r = refused(repo, "verify", ["--step"]);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /undefined/);
  assert.match(r.stderr, /--step/, r.stderr);
  assert.ok(!existsSync(path.join(runDir(repo), "verify.json")), "a refused verify still ran the commands");
  assert.ok(ledgerOf(repo).steps.every((s) => s.state === null), "a step was closed");
});

test("C3 happy: `gate verify --step verify-before` still closes {verify-before} on refactor, and a plain `gate verify` closes {verify}", () => {
  const refactor = opened("rb-c3-refactor", "refactor");
  assert.match(cli(refactor, "verify", ["--step", "verify-before"]).stdout, /step \{verify-before\} closed/);
  assert.equal(stepOf(refactor, "verify-before").state, "DONE");
  assert.equal(stepOf(refactor, "verify").state, null);

  const feature = opened("rb-c3-feature");
  assert.match(cli(feature, "verify").stdout, /step \{verify\} closed/);
  assert.equal(stepOf(feature, "verify").state, "DONE");
});

test("C4 edge: `gate verify --step verify-before` on a playbook without that step is refused", () => {
  const repo = opened("rb-c4");
  refused(repo, "verify", ["--step", "verify-before"]);
  assert.ok(!existsSync(path.join(runDir(repo), "verify.json")));
});

test("C5 reported-surface: the full report shows GATE ERROR only for lines logged since the run opened", () => {
  const repo = committed("rb-c5");
  mkdirSync(stateDir(repo), { recursive: true });
  writeFileSync(errLog(repo), "2026-09-30T00:00:00.000Z verb=stop Error: GATE OVERRIDDEN after 6 identical blocks: R1\n");
  cli(repo, "open", ["t", "feature"]);
  const report = cli(repo, "report").stdout;
  assert.doesNotMatch(report, /GATE ERROR/, report);
  assert.doesNotMatch(report, /2026-09-30/, report);
});

test("C6 happy: an error logged during the run shows in the full report and in For you", () => {
  const repo = committed("rb-c6");
  mkdirSync(stateDir(repo), { recursive: true });
  writeFileSync(errLog(repo), "2026-09-30T00:00:00.000Z verb=stop old one\n");
  cli(repo, "open", ["t", "feature"]);
  appendFileSync(errLog(repo), `${new Date().toISOString()} verb=check Error: boom during the run\n`);
  const report = cli(repo, "report").stdout;
  assert.match(report, /GATE ERROR[\s\S]*boom during the run/, report);
  assert.doesNotMatch(report, /old one/, report);
  assert.match(cli(repo, "report", ["--brief"]).stdout, /the gate itself logged 1 error/);
});

test("C7 edge: a stop override is recorded on the ledger and in the report, not in gate-error.log; with no ledger it is an override event", () => {
  const repo = committed("rb-c7");
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/a.ts", "changed\n");
  let last;
  for (let i = 0; i < 6; i++) last = stop(repo);
  assert.equal(last, null, "premise: the sixth identical block falls open");
  assert.ok(ledgerOf(repo).overridden, "override stamped on the ledger");
  assert.match(cli(repo, "report").stdout, /GATE OVERRIDDEN/);
  assert.ok(!existsSync(errLog(repo)) || !/OVERRIDDEN/.test(readFileSync(errLog(repo), "utf8")), "the override went to gate-error.log");

  const bare = committed("rb-c7-bare");
  hook(bare, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });
  write(bare, "src/a.ts", "changed\n");
  for (let i = 0; i < 6; i++) last = stop(bare);
  assert.equal(last, null, "premise: R1 falls open after six identical blocks");
  assert.ok(!existsSync(errLog(bare)) || !/OVERRIDDEN/.test(readFileSync(errLog(bare), "utf8")), "the override went to gate-error.log");
  const override = readEvents(stateDir(bare), "S1").find((e) => e.kind === "override");
  assert.ok(override, "no override event was logged");
  assert.deepEqual(override.rules, ["R1"]);
});

test("C8 reported-surface: denied writes from before the run opened or after it ended are not counted in its report", () => {
  const repo = committed("rb-c8");
  hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });
  denied(repo);
  denied(repo);
  cli(repo, "open", ["t", "feature"]);
  assert.match(cli(repo, "report").stdout, /blocked writes to gate files 0/);
  cli(repo, "abandon", ["t", "user moved on"]);
  denied(repo);
  const ledger = loadLedger(path.join(stateDir(repo), "runs", readdirSync(path.join(stateDir(repo), "runs"))[0]));
  assert.equal(ledger.status, "abandoned");
  cli(repo, "open", ["u", "feature"]);
  // the next run in the same session sees none of the three either
  assert.match(cli(repo, "report").stdout, /blocked writes to gate files 0/);
});

test("C9 boundary: a deny inside the run is counted; a block from before the run is not", () => {
  const repo = committed("rb-c9");
  hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });
  write(repo, "src/a.ts", "changed\n");
  assert.equal(stop(repo)?.decision, "block", "premise: R1 blocks with no run open");
  cli(repo, "open", ["t", "feature"]);
  denied(repo);
  const report = cli(repo, "report").stdout;
  assert.match(report, /blocked writes to gate files 1/, report);
  assert.match(report, /1 denied write/, report);
  assert.doesNotMatch(report, /the gate blocked the turn/, report);
});

test("C10 reported-surface: a slug that starts with a date gets the date once", () => {
  const repo = committed("rb-c10");
  cli(repo, "open", ["2026-10-14-ticket-3523-lambda", "feature"]);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(path.basename(runDir(repo)), `${today}-ticket-3523-lambda`);
  assert.equal(ledgerOf(repo).slug, "ticket-3523-lambda");
});

test("C11 edge: a slug that is only a date keeps a usable name", () => {
  const repo = committed("rb-c11");
  cli(repo, "open", ["2026-10-14", "feature"]);
  const name = path.basename(runDir(repo));
  assert.match(name, /^\d{4}-\d{2}-\d{2}-[a-z0-9]/, name);
  assert.ok(ledgerOf(repo).slug.length > 0);
});

test("C12 refused: `gate open` of a new slug with no playbook is refused with the list; an existing slug re-attaches without one", () => {
  const repo = committed("rb-c12");
  const r = refused(repo, "open", ["t"]);
  for (const p of ["feature", "bugfix", "refactor", "plan", "investigation"]) assert.match(r.stderr, new RegExp(p), r.stderr);
  assert.ok(!existsSync(path.join(stateDir(repo), "runs")) || readdirSync(path.join(stateDir(repo), "runs")).length === 0, "a run was created");

  cli(repo, "open", ["t", "bugfix"]);
  const other = run(repo, "open", ["t"], { session: "S2" });
  assert.equal(other.status, 0, other.stderr);
  assert.doesNotMatch(other.stderr, REFUSAL, other.stderr);
  assert.equal(loadSession(stateDir(repo), "S2").current, path.basename(runDir(repo)));
});

function withSkepticItem(name) {
  const repo = opened(name);
  lookedUp(repo, { agent: "sk1", role: "skeptic" });
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), "# Skeptic 1\n\n## Act on\n- the plan misses the null venue\n\n## Noted\n- none\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  return repo;
}
const r15 = (repo) => cli(repo, "check").stdout.split("\n").filter((l) => /^\d+\. R15 — /.test(l)).join("\n");

test("C13 reported-surface: an Act-on item left open blocks with its id, whatever step it came through", () => {
  const repo = withSkepticItem("rb-c13");
  // the huddle step set N/A no longer checks the item, so only the rule can
  cli(repo, "step", ["skeptic", "na", "fixture: the item must still be answered"]);
  assert.match(r15(repo), /H1\.1/, r15(repo));
});

test("C14 happy: an item closed by resolve, by a withdrawn dispute or by an arbiter ruling for the implementer does not block", () => {
  const resolved = withSkepticItem("rb-c14-resolve");
  cli(resolved, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:1"]);
  assert.equal(r15(resolved), "");

  const withdrawn = withSkepticItem("rb-c14-withdrawn");
  cli(withdrawn, "huddle", ["dispute", "H1.1", "the venue is never null here", "--evidence", "src/a.ts:1"]);
  assert.match(r15(withdrawn), /H1\.1/, "an unanswered dispute is still open");
  writeFileSync(path.join(runDir(withdrawn), "skeptic-2.md"), "# Skeptic 2\n\n## Act on\n- none\n\n## Disputes\n- H1.1 — withdrawn: the caller checks it first\n");
  cli(withdrawn, "huddle", ["add", "skeptic", "--file", "skeptic-2.md"]);
  assert.match(ledgerOf(withdrawn).huddles[0].actOn[0].closed ?? "", /withdrawn/, "premise: the dispute was withdrawn");
  assert.equal(r15(withdrawn), "");

  const overruled = withSkepticItem("rb-c14-arbiter");
  cli(overruled, "huddle", ["dispute", "H1.1", "the venue is never null here", "--evidence", "src/a.ts:1"]);
  lookedUp(overruled, { agent: "ar1", role: "arbiter" });
  writeFileSync(path.join(runDir(overruled), "arbiter-1.md"), "# Arbiter 1\n\n## Ruling\n- H1.1 — implementer: the null check runs first\n");
  cli(overruled, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);
  assert.match(ledgerOf(overruled).huddles[0].actOn[0].closed ?? "", /overruled/, "premise: the arbiter ruled for the implementer");
  assert.equal(r15(overruled), "");
});

test("C13b reported-surface: an open reviewer item blocks even where R5 does not run (no source change), unless the review was waived", () => {
  const repo = opened("rb-c13b");
  lookedUp(repo, { agent: "rv1", role: "reviewer" });
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n- the doc names the wrong flag\n\n## Consider\n- none\n\n## Dismissed\n- none\n");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const out = cli(repo, "check").stdout;
  assert.doesNotMatch(out, /^\d+\. R5 — /m, `premise: R5 does not run with no source change:\n${out}`);
  assert.match(r15(repo), /H1\.1/, out);
  cli(repo, "waive", ["review", "user: the doc item is out of scope"]);
  assert.equal(r15(repo), "");
});

test("C15 happy: the policy carries no escalate or ceiling keys; `gate size` prints no ceiling and the report no round 2 line", () => {
  const models = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
  assert.ok(!("escalate" in models.policy) && !("ceiling" in models.policy), JSON.stringify(models.policy));
  assert.ok(!("escalate" in DEFAULT_POLICY) && !("ceiling" in DEFAULT_POLICY));
  const policy = loadPolicy();
  assert.ok(!("escalate" in policy) && !("ceiling" in policy));
  const repo = opened("rb-c15");
  assert.doesNotMatch(cli(repo, "size").stdout, /ceiling|round 2/);
  assert.doesNotMatch(cli(repo, "report").stdout, /^round 2:/m);
});

test("C16 idempotent: a ledger pinned with the old escalate and ceiling keys still loads, sizes and reports", () => {
  const repo = opened("rb-c16");
  const ledger = ledgerOf(repo);
  ledger.policy = { ...ledger.policy, escalate: { reviewerRound2: { whenActOnAtLeast: 2, orTier: "large" } }, ceiling: { helpersPerTask: 10 } };
  saveLedger(runDir(repo), ledger);
  assert.match(cli(repo, "size").stdout, /^tier: /m);
  assert.doesNotMatch(cli(repo, "report").stdout, /^round 2:/m);
  cli(repo, "check");
});

test("C18 happy: SKILL.md lists investigation among the playbooks and stays under 4096 bytes", () => {
  const file = path.join(pluginRoot, "skills", "gate", "SKILL.md");
  assert.match(readFileSync(file, "utf8"), /gate open <slug> <feature\|bugfix\|refactor\|plan\|investigation>/);
  assert.ok(statSync(file).size < 4096, `SKILL.md is ${statSync(file).size} bytes`);
});

test("C19 edge: a full dated folder name still finds that exact run, not another day's run with the same tail", () => {
  const repo = committed("rb-c19");
  const runs = path.join(stateDir(repo), "runs");
  cli(repo, "open", ["x", "feature"]);
  const today = path.basename(runDir(repo));
  // an older run of the same slug, still open, left by another session
  mkdirSync(path.join(runs, "2026-01-02-x"), { recursive: true });
  const older = { ...ledgerOf(repo), openedAt: "2026-01-02T00:00:00.000Z", sessions: ["S0"] };
  saveLedger(path.join(runs, "2026-01-02-x"), older);
  const r = run(repo, "attach", ["2026-01-02-x"], { session: "S2" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadSession(stateDir(repo), "S2").current, "2026-01-02-x");
  assert.notEqual(today, "2026-01-02-x");
});

test("C20 edge: a run that ended counts no denies and shows no gate errors logged after it; an error keeps its stack lines", () => {
  const repo = committed("rb-c20");
  hook(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });
  cli(repo, "open", ["t", "feature"]);
  appendFileSync(errLog(repo), `${new Date().toISOString()} verb=check Error: inside\n    at frame (gate.mjs:1:1)\n`);
  cli(repo, "abandon", ["t", "user moved on"]);
  denied(repo);
  appendFileSync(errLog(repo), `${new Date(Date.now() + 1000).toISOString()} verb=check Error: after the end\n`);
  const report = cli(repo, "report").stdout;
  assert.match(report, /ABANDONED/, "premise: the report is the abandoned run's");
  assert.match(report, /blocked writes to gate files 0/, report);
  assert.match(report, /Error: inside\n\s+at frame/, report);
  assert.doesNotMatch(report, /after the end/, report);
});
