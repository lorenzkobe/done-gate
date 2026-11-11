// plan-drift: the diff is compared with the plan. In shadow (the default) code outside the plan is
// recorded, logged when the set changes, reported and counted by gate stats, and nothing blocks.
// In active mode it is R19, whose only exit is `gate plan add`. The mode is pinned per run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gate, here, makeRepo, planChecked, readyToEdit, waiveArgs } from "./helpers.mjs";
import { DEFAULT_POLICY, loadPolicy, policyFor } from "../scripts/lib/size.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function envFor(repo) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}
const run = (repo, args, input) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: envFor(repo), input });
function cli(repo, ...args) {
  const r = run(repo, args);
  assert.equal(r.status, 0, `gate ${args.join(" ")}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}
const hook = (repo, payload) => execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), env: envFor(repo) });

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerFile = (repo) => path.join(runDir(repo), "ledger.json");
const ledgerOf = (repo) => JSON.parse(readFileSync(ledgerFile(repo), "utf8"));
const drifts = (repo) => readEvents(stateDir(repo), "S1").filter((e) => e.kind === "plan-drift");

function committed(name, files = {}) {
  const repo = makeRepo(name, { "src/b.ts": "export const b = 1;\n", ...files });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
// a run planned on src/a.ts, with the pinned mode set by hand when given
function planned(name, mode = null, { playbook = "feature", files = {} } = {}) {
  const repo = committed(name, files);
  cli(repo, "open", name, playbook);
  if (mode) {
    const l = ledgerOf(repo);
    l.policy.guards = { planDiff: mode };
    writeFileSync(ledgerFile(repo), JSON.stringify(l, null, 2));
  }
  readyToEdit(repo, { plan: ["--files", "src/a.ts"] });
  if (ledgerOf(repo).checkHold) planChecked(repo);
  return repo;
}
// a write the fence does not refuse: the shell, as the PostToolUse hook logs it
function shellWrite(repo, rel, content = "export const changed = 1;\n") {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `echo x > ${rel}` }, tool_response: {} });
}
const rules = (out) => [...out.matchAll(/^\d+\. (R\d+)/gm)].map((m) => m[1]);

test("C1 boundary: planDiff is shadow by default, keeps off and active, and is shadow for a broken value, a broken file, no file and an old pin", () => {
  assert.equal(DEFAULT_POLICY.guards.planDiff, "shadow");
  assert.equal(loadPolicy().guards.planDiff, "shadow", "models.json ships shadow");
  const dir = path.join(here, ".tmp", "pd-c1");
  mkdirSync(dir, { recursive: true });
  const at = (name, body) => {
    writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
    return path.join(dir, name);
  };
  for (const mode of ["off", "shadow", "active"]) assert.equal(loadPolicy(at(`${mode}.json`, { policy: { guards: { planDiff: mode } } })).guards.planDiff, mode);
  for (const bad of ["loud", 1, null, ["active"]]) assert.equal(loadPolicy(at("bad.json", { policy: { guards: { planDiff: bad } } })).guards.planDiff, "shadow", String(bad));
  assert.equal(loadPolicy(at("broken.json", "{ not json")).guards.planDiff, "shadow");
  assert.equal(loadPolicy(path.join(dir, "nope.json")).guards.planDiff, "shadow");
  assert.equal(policyFor({ policy: { tiers: DEFAULT_POLICY.tiers } }).guards.planDiff, "shadow", "a pin from before guards");
});

test("C2 edge: in off mode an unplanned shell edit logs nothing and records nothing", () => {
  const repo = planned("pd-c2", "off");
  shellWrite(repo, "src/b.ts");
  cli(repo, "check");
  assert.deepEqual(drifts(repo), []);
  assert.equal(ledgerOf(repo).planDrift, undefined);
});

test("C3 happy: in shadow an unplanned shell edit is recorded and logged once over two checks, and gate check adds no rule", () => {
  const repo = planned("pd-c3");
  const before = rules(cli(repo, "check"));
  shellWrite(repo, "src/b.ts");
  const after = rules(cli(repo, "check"));
  cli(repo, "check");
  assert.deepEqual(ledgerOf(repo).planDrift, ["src/b.ts"]);
  assert.equal(drifts(repo).length, 1);
  assert.deepEqual(drifts(repo)[0].files, ["src/b.ts"]);
  assert.equal(drifts(repo)[0].mode, "shadow");
  assert.ok(!after.includes("R19"), after.join(", "));
  assert.deepEqual(after.filter((r) => !before.includes(r)).filter((r) => !["R3", "R5", "R7"].includes(r)), [], `shadow added a rule: ${after.join(", ")}`);
});

test("C4 edge: a rename of a planned file counts the new name; a revert empties the drift and logs the change", () => {
  const repo = planned("pd-c4");
  execFileSync("git", ["mv", "src/a.ts", "src/a2.ts"], { cwd: repo });
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git mv src/a.ts src/a2.ts" }, tool_response: {} });
  cli(repo, "check");
  assert.deepEqual(ledgerOf(repo).planDrift, ["src/a2.ts"]);
  execFileSync("git", ["mv", "src/a2.ts", "src/a.ts"], { cwd: repo });
  cli(repo, "check");
  assert.deepEqual(ledgerOf(repo).planDrift, []);
  assert.deepEqual(drifts(repo).map((e) => e.files), [["src/a2.ts"], []]);
});

test("C5 edge: a worker's edit of an unplanned file is drift", () => {
  const repo = planned("pd-c5");
  writeFileSync(path.join(repo, "src/b.ts"), "export const b = 2;\n");
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, "src/b.ts") }, tool_response: {}, agent_id: "W1", agent_type: "done-gate:worker" });
  cli(repo, "check");
  assert.deepEqual(ledgerOf(repo).planDrift, ["src/b.ts"]);
});

test("C6 reported-surface: the full report names the files outside the plan and that nothing was blocked", () => {
  const repo = planned("pd-c6");
  shellWrite(repo, "src/b.ts");
  cli(repo, "check");
  assert.match(cli(repo, "report"), /outside the plan: src\/b\.ts \(noted, nothing blocked\)/);
});

test("C7 happy: gate stats counts plan drift among the closed runs that recorded it", () => {
  const repo = committed("pd-c7");
  const closed = (name, over) => {
    const dir = path.join(stateDir(repo), "runs", name);
    mkdirSync(dir, { recursive: true });
    const at = (m) => new Date(Date.now() - 864e5 + m * 6e4).toISOString();
    writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({ status: "closed", version: "0.22.0", rules: 1, playbook: "feature", openedAt: at(0), closedAt: at(10), policy: { tiers: DEFAULT_POLICY.tiers, guards: { planDiff: "shadow" } }, tier: { predictedFiles: ["src/a.ts"], measured: { tier: "standard" } }, huddles: [], waivers: [], changedAtClose: [], ...over }));
  };
  // a run that drifted and was cleared by plan add still counts: the flip bar judges every flag
  closed("2026-11-01-a", { planDrift: [], planDriftSeen: ["src/b.ts", "src/c.ts"], planAdds: [{ files: ["src/b.ts"], why: "needed", seq: 9 }] });
  closed("2026-11-01-b", {});
  closed("2026-11-01-c", { policy: { tiers: DEFAULT_POLICY.tiers } });
  closed("2026-11-01-d", { policy: { tiers: DEFAULT_POLICY.tiers, guards: { planDiff: "off" } } });
  const out = cli(repo, "stats");
  const line = out.split("\n").find((l) => l.trimStart().startsWith("plan drift"));
  assert.match(line ?? "", /1 of 2 runs/, out);
  assert.match(line, /2 files flagged/);
  assert.match(line, /1 later added to the plan/);
});

test("8.2 C12 reported-surface: a run left open on R19 names its plain meaning in the brief, with no rule number", () => {
  const repo = planned("pd-82-c12", "active");
  shellWrite(repo, "src/b.ts");
  cli(repo, "check");
  const brief = cli(repo, "report", "--brief");
  assert.match(brief, /code outside the plan changed and was not added to it/);
  assert.doesNotMatch(brief, /\bR19\b/);
});

test("C8 C9 refused then happy: in active mode an unplanned shell edit is R19 at check, at stop and at close; gate plan add clears it", () => {
  const repo = planned("pd-c8", "active");
  shellWrite(repo, "src/b.ts");
  const out = cli(repo, "check");
  const r19 = out.split("\n").find((l) => / R19 — /.test(l));
  assert.ok(r19, out);
  assert.match(r19, /src\/b\.ts/);
  assert.match(r19, /gate plan add/);
  assert.match(r19, /ask/);
  const stop = run(repo, ["stop"], JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done." }));
  assert.match(stop.stdout, /R19/);
  assert.notEqual(run(repo, ["close"]).status, 0);
  assert.match(r19, /revert/);
  assert.match(r19, /open a new one/);
  const added = cli(repo, "plan", "add", "src/b.ts", "the helper a.ts calls lives there");
  assert.doesNotMatch(added, /^warning:/m, "plan add warned about the file it added");
  assert.deepEqual(ledgerOf(repo).planDrift, []);
  assert.deepEqual(ledgerOf(repo).planDriftSeen, ["src/b.ts"], "the record of what was flagged stays");
  assert.doesNotMatch(cli(repo, "check"), /R19/);
});

test("C17 boundary: a bracketed route file is a file, so plan add clears its drift", () => {
  const repo = planned("pd-c17", "active");
  shellWrite(repo, "src/app/[id]/page.tsx");
  assert.match(cli(repo, "check"), /R19[^\n]*src\/app\/\[id\]\/page\.tsx/);
  cli(repo, "plan", "add", "src/app/[id]/page.tsx", "the detail route");
  assert.doesNotMatch(cli(repo, "check"), /R19/);
});

test("C19 reported-surface: the short report names the files outside the plan, and a driver file never counts", () => {
  const repo = planned("pd-c19", null, { files: { ".claude/gate.json": JSON.stringify({ testFiles: null, driver: "skill:verify" }) } });
  shellWrite(repo, "src/b.ts");
  shellWrite(repo, ".claude/skills/verify/drive.mjs", "export const drive = 1;\n");
  cli(repo, "check");
  assert.deepEqual(ledgerOf(repo).planDrift, ["src/b.ts"]);
  const forYou = cli(repo, "report", "--brief").split("\n").find((l) => l.startsWith("For you:")) ?? "";
  assert.match(forYou, /outside the plan: src\/b\.ts/);
});

test("C10 refused: gate waive R19 is refused", () => {
  const repo = planned("pd-c10", "active");
  shellWrite(repo, "src/b.ts");
  const r = run(repo, ["waive", ...waiveArgs(repo, "R19", "the user is fine with it")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /R19 has no waiver/);
});

test("C11 happy: in active mode a verb prints one warning line about the drift", () => {
  const repo = planned("pd-c11", "active");
  shellWrite(repo, "src/b.ts");
  cli(repo, "check");
  const out = cli(repo, "case", "add", "another case", "--kind", "edge");
  const warnings = out.split("\n").filter((l) => l.startsWith("warning:"));
  assert.equal(warnings.length, 1, out);
  assert.match(warnings[0], /src\/b\.ts/);
  assert.match(warnings[0], /gate plan add/);
  assert.doesNotMatch(cli(planned("pd-c11-shadow"), "case", "add", "x", "--kind", "edge"), /^warning:/m, "shadow prints nothing");
});

test("C12 edge: a run pinned before guards existed records drift in shadow, and an investigation has no drift", () => {
  // a stamped run pinned before guards existed: the re-merged pin is shadow
  const pinned = committed("pd-c12-pin");
  cli(pinned, "open", "pd-c12-pin", "feature");
  const p = ledgerOf(pinned);
  delete p.policy.guards;
  writeFileSync(ledgerFile(pinned), JSON.stringify(p, null, 2));
  readyToEdit(pinned, { plan: ["--files", "src/a.ts"] });
  shellWrite(pinned, "src/b.ts");
  assert.doesNotMatch(cli(pinned, "check"), /R19/);
  assert.deepEqual(ledgerOf(pinned).planDrift, ["src/b.ts"], "shadow still records it");

  const inv = committed("pd-c12-inv");
  cli(inv, "open", "pd-c12-inv", "investigation");
  shellWrite(inv, "src/b.ts");
  cli(inv, "check");
  assert.equal(ledgerOf(inv).planDrift, undefined);
});

test("C14 reported-surface: README's rule table and SKILL.md name R19", () => {
  const readme = readFileSync(path.join(here, "..", "README.md"), "utf8");
  assert.match(readme, /^\| R19 \|[^\n]*gate plan add/m);
  assert.match(readFileSync(path.join(here, "..", "skills/gate/SKILL.md"), "utf8"), /R17-R21\)/);
});
