// old-version: a run opened by 0.21.0 (8218139, the last release) is read by this copy, and a run
// opened here is read and closed by 0.21.0, so a plugin update mid-task strands no ledger either way.
// Later batches that add a ledger field add it to these runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AT_GIT_TOPLEVEL, gate, here, lookedUp, makeRepo, planChecked, pluginRoot } from "./helpers.mjs";

const OLD_COMMIT = "8218139";
const hasOld = AT_GIT_TOPLEVEL && spawnSync("git", ["cat-file", "-e", `${OLD_COMMIT}^{commit}`], { cwd: pluginRoot }).status === 0;
const skip = hasOld ? false : `needs the plugin's git history with ${OLD_COMMIT}`;

const oldRoot = path.join(here, ".tmp", "old-0.21.0");
function oldGate() {
  const g = path.join(oldRoot, "scripts", "gate.mjs");
  if (existsSync(g)) return g;
  // extracted beside it and renamed, so a run killed mid-extract leaves no half copy to reuse
  const part = `${oldRoot}.part`;
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  const tar = path.join(here, ".tmp", "old-0.21.0.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, OLD_COMMIT], { cwd: pluginRoot });
  execFileSync("tar", ["-xf", tar, "-C", part]);
  rmSync(tar);
  rmSync(oldRoot, { recursive: true, force: true });
  renameSync(part, oldRoot);
  return g;
}

function committed(name) {
  const repo = makeRepo(name, { ".gitignore": "node_modules/\nignored.txt\n.claude/gate/\n" });
  const git = (args) => execFileSync("git", args, { cwd: repo });
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

function envFor(repo) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}
function run(g, repo, args) {
  const r = spawnSync(process.execPath, [g, ...args], { encoding: "utf8", env: envFor(repo) });
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!/GATE ERROR/.test(out), `${g === gate ? "new" : "old"} gate ${args.join(" ")}:\n${out}`);
  return r;
}
function ok(g, repo, args) {
  const r = run(g, repo, args);
  assert.equal(r.status, 0, `${g === gate ? "new" : "old"} gate ${args.join(" ")}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}
const hook = (g, repo, payload) =>
  execFileSync(process.execPath, [g, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), env: envFor(repo) });
const ruleIds = (out) => [...out.matchAll(/^\d+\. (R\d+)/gm)].map((m) => m[1]);
// by slug, since a closed run is no longer the session's current one
const ledgerOf = (repo) => {
  const runs = path.join(repo, ".claude", "gate", "runs");
  const dir = readdirSync(runs).find((d) => d.endsWith(`-${path.basename(repo)}`));
  return JSON.parse(readFileSync(path.join(runs, dir, "ledger.json"), "utf8"));
};

// The lead's part up to the code: task, context, plan, one case, then the edit and its test.
function planAndEdit(g, repo, files = "src/a.ts") {
  ok(g, repo, ["note", "task", "Change a. [inferred]"]);
  ok(g, repo, ["note", "context", "Traced: src/a.ts:1 · Related: none: `grep -rn a src` · Research: none needed: a test fixture"]);
  ok(g, repo, ["note", "plan", "Change a.", "--files", files]);
  ok(g, repo, ["case", "add", "a is 2", "--kind", "happy"]);
}
// one line changed, so the run stays tiny and needs no reviewer
function edit(g, repo, rel, from, to) {
  writeFileSync(path.join(repo, rel), readFileSync(path.join(repo, rel), "utf8").replace(from, to));
  hook(g, repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_response: {} });
}
function opened(g, repo, slug) {
  hook(g, repo, { hook_event_name: "UserPromptSubmit", prompt: "change a" });
  ok(g, repo, ["open", slug, "feature"]);
  lookedUp(repo);
}

test("C1 happy: a run the old copy opened is checked by this copy with the rules the old copy lists, and no error", { skip }, () => {
  const old = oldGate();
  const repo = committed("ov-c1");
  opened(old, repo, "ov-c1");
  planAndEdit(old, repo);
  edit(old, repo, "src/a.ts", "a0 = 0", "a0 = 2");
  edit(old, repo, "tests/a.test.ts", "'a'", "'a0 is 2'");
  const before = ruleIds(run(old, repo, ["check"]).stdout);
  assert.ok(before.length > 0, "premise: the old copy lists open items");
  assert.deepEqual(ruleIds(run(gate, repo, ["check"]).stdout), before);
  assert.equal(ledgerOf(repo).rules, undefined, "the new copy stamped a run it did not open");
});

test("C2 happy: a run this copy opened is checked, verified and closed by the old copy", { skip }, () => {
  const old = oldGate();
  const repo = committed("ov-c2");
  opened(gate, repo, "ov-c2");
  assert.equal(ledgerOf(repo).rules, 1, "premise: this copy stamps the run");
  planAndEdit(gate, repo);
  edit(gate, repo, "src/a.ts", "a0 = 0", "a0 = 2");
  edit(gate, repo, "tests/a.test.ts", "'a'", "'a0 is 2'");
  assert.deepEqual(ruleIds(run(old, repo, ["check"]).stdout), ruleIds(run(gate, repo, ["check"]).stdout));
  ok(old, repo, ["case", "close", "C1", "--test", "tests/a.test.ts:1"]);
  ok(old, repo, ["verify"]);
  for (const key of ["tests", "implement"]) ok(old, repo, ["step", key, "done", `${key} done`, "--evidence", "tests/a.test.ts"]);
  for (const key of ["driver", "schema"]) ok(old, repo, ["step", key, "na", "no UI or schema changed"]);
  const close = run(old, repo, ["close"]);
  assert.equal(close.status, 0, `${close.stdout}${close.stderr}`);
  assert.equal(ledgerOf(repo).status, "closed");
});

test("C3 happy: planChecked closes the skeptic step on a standard run, and the old copy reading that run no longer lists it", { skip }, () => {
  const old = oldGate();
  const repo = committed("ov-c3");
  opened(gate, repo, "ov-c3");
  planAndEdit(gate, repo, "src/a.ts,src/app/page.tsx");
  assert.equal(ledgerOf(repo).tier.predicted, "standard", "premise: a two-file plan needs the check");
  assert.match(run(old, repo, ["check"]).stdout, /\{skeptic\}/, "premise: the check is open before planChecked");
  assert.equal(ledgerOf(repo).checkHold, true, "premise: this copy holds code for the check");
  planChecked(repo);
  const step = ledgerOf(repo).steps.find((s) => s.key === "skeptic");
  assert.equal(step.state, "DONE");
  assert.equal(step.auto, "fact", "the gate closed the check itself");
  for (const g of [old, gate]) assert.doesNotMatch(run(g, repo, ["check"]).stdout, /\{skeptic\}/);
});

// A copy of the plugin with no git history of its own, as the plugin cache holds it.
test("C4 edge: without the plugin's own git history the old-version tests skip instead of failing", { skip: AT_GIT_TOPLEVEL ? false : "runs from the plugin's own checkout only" }, () => {
  const copy = path.join(here, ".tmp", "ov-c4-nogit");
  rmSync(copy, { recursive: true, force: true });
  for (const rel of ["scripts", "models.json", "package.json", "tests/helpers.mjs", "tests/old-version.test.mjs"]) {
    mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
    execFileSync("cp", ["-R", path.join(pluginRoot, rel), path.join(copy, rel)]);
  }
  // the parent's test runner would take the child's report over its own channel
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "tests/old-version.test.mjs"], { cwd: copy, encoding: "utf8", env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const total = /# tests (\d+)/.exec(r.stdout)?.[1];
  assert.ok(Number(total) > 1, r.stdout);
  assert.match(r.stdout, new RegExp(`# skipped ${total}\\b`), r.stdout);
  assert.match(r.stdout, /# fail 0/, r.stdout);
});

test("C5 happy: the old copy reads a run with a plan addition and lists the same rules", { skip }, () => {
  const old = oldGate();
  const repo = committed("ov-c5");
  opened(gate, repo, "ov-c5");
  planAndEdit(gate, repo);
  ok(gate, repo, ["plan", "add", "src/app/page.tsx", "the badge renders there"]);
  assert.equal(ledgerOf(repo).planAdds.length, 1, "premise: the addition is recorded");
  assert.deepEqual(ruleIds(run(old, repo, ["check"]).stdout), ruleIds(run(gate, repo, ["check"]).stdout));
});

test("C6 happy: the old copy reads a run with a recorded plan drift and a pinned guards policy", { skip }, () => {
  const old = oldGate();
  const repo = committed("ov-c6");
  opened(gate, repo, "ov-c6");
  planAndEdit(gate, repo);
  edit(gate, repo, "src/app/page.tsx", "null", "1");
  run(gate, repo, ["check"]);
  const l = ledgerOf(repo);
  assert.equal(l.policy.guards.planDiff, "shadow", "premise: the mode is pinned");
  assert.deepEqual(l.planDrift, ["src/app/page.tsx"], "premise: the drift is recorded");
  assert.deepEqual(ruleIds(run(old, repo, ["check"]).stdout), ruleIds(run(gate, repo, ["check"]).stdout));
});

test("C7 happy: the old copy reads and closes a run whose steps the gate closed", { skip }, () => {
  const old = oldGate();
  const repo = committed("ov-c7");
  opened(gate, repo, "ov-c7");
  planAndEdit(gate, repo);
  edit(gate, repo, "src/a.ts", "a0 = 0", "a0 = 2");
  edit(gate, repo, "tests/a.test.ts", "'a'", "'a0 is 2'");
  ok(gate, repo, ["case", "close", "C1", "--test", "tests/a.test.ts:1"]);
  ok(gate, repo, ["verify"]);
  const auto = ledgerOf(repo).steps.filter((s) => s.auto === "fact").map((s) => s.key);
  assert.ok(auto.includes("implement"), `premise: the gate closed it: ${auto.join(", ")}`);
  // what is left is closed by hand with the old copy: tests (no run came before the code), driver, schema
  ok(old, repo, ["step", "tests", "done", "ran after the edit", "--evidence", "tests/a.test.ts"]);
  for (const key of ["driver", "schema"]) if (!ledgerOf(repo).steps.find((s) => s.key === key).state) ok(old, repo, ["step", key, "na", "no UI or schema changed"]);
  const close = run(old, repo, ["close"]);
  assert.equal(close.status, 0, `${close.stdout}${close.stderr}`);
});
