import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

// refactor-schema-step: a refactor that touches a schema file must be able to close its
// real-schema probe with `gate step schema`, the same as feature and bugfix. Cases C1–C4.

const envFor = (repo) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" });
const REFUSAL = /^done-gate: /m;
function run(repo, verb, args = []) {
  return spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const stepKeys = (repo) => loadLedger(runDir(repo)).steps.map((s) => s.key);

function openedRefactor(name) {
  const repo = makeRepo(name, {
    "src/a.ts": "export const x = 1;\n",
    "supabase/migrations/001_init.sql": "select 1;\n",
    ".claude/gate.json": JSON.stringify({ schema: ["supabase/migrations/**"], source: ["src/**", "supabase/**"], tests: ["tests/**"] }),
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, "refactor"]);
  cli(repo, "note", ["task", "Reword a migration comment. [inferred]"]);
  cli(repo, "note", ["plan", "Comment only.", "--files", "supabase/migrations/001_init.sql"]);
  return repo;
}
function unmetRules(repo) {
  const config = loadConfig(repo);
  const ledger = loadLedger(runDir(repo));
  const session = loadSession(stateDir(repo), "S1");
  return evaluate({ repo, config, ledger, session, changed: ["supabase/migrations/001_init.sql"] }).map((u) => u.rule);
}

test("C1 reported-surface: a refactor ledger has a {schema} step between {driver} and {review}", () => {
  const repo = openedRefactor("rs-c1");
  const keys = stepKeys(repo);
  assert.ok(keys.includes("schema"), `refactor steps lack schema: ${keys.join(", ")}`);
  assert.ok(keys.indexOf("driver") < keys.indexOf("schema") && keys.indexOf("schema") < keys.indexOf("review"), keys.join(", "));
});

test("C2 happy: `gate step schema done` is accepted on a refactor run and R6 stops firing for a changed schema file", () => {
  const repo = openedRefactor("rs-c2");
  write(repo, "supabase/migrations/001_init.sql", "select 2;\n");
  assert.ok(unmetRules(repo).includes("R6"), "R6 should fire before the probe step is closed");
  cli(repo, "step", ["schema", "done", "ran select 2 against the local db", "--evidence", "supabase/migrations/001_init.sql:1"]);
  assert.ok(!unmetRules(repo).includes("R6"), "R6 still fires after the schema step closed with evidence");
});

test("C3 edge: `gate step schema na` is accepted on a refactor run when no schema file changed", () => {
  const repo = openedRefactor("rs-c3");
  cli(repo, "step", ["schema", "na", "no schema file changed"]);
  assert.equal(loadLedger(runDir(repo)).steps.find((s) => s.key === "schema").state, "N/A");
});
