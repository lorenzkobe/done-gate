import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, lookedUp, pluginRoot, write } from "./helpers.mjs";

// From the 0.20.0 review, 3.7: a worker's shell edit that landed while the lead's own command was
// running was credited to the lead (R16). The command that names the file says who wrote it.

const MODELS = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
const FILES = Array.from({ length: MODELS.policy.tiers.standard.maxFiles + 1 }, (_, i) => `src/f${i}.ts`);
const env = (repo) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" });
const cli = (repo, ...args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: env(repo) });
const hook = (repo, verb, payload) => spawnSync(process.execPath, [gate, verb], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: env(repo) });
const worker = { agent_id: "W1", agent_type: "done-gate:worker" };
const r16 = (repo) => cli(repo, "check").stdout.split("\n").filter((l) => /\bR16\b/.test(l));

function opened(name) {
  const repo = makeRepo(name, Object.fromEntries(FILES.map((f) => [f, "export const x = 1;\n"])));
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", name, "feature");
  lookedUp(repo);
  cli(repo, "note", "task", "Do the thing.");
  cli(repo, "note", "context", "Traced: src/f0.ts:1 · Related: none: `grep -rn x src` · Research: none needed: a test fixture");
  cli(repo, "note", "plan", "The plan.", "--files", FILES.join(","));
  cli(repo, "case", "add", "it works", "--kind", "happy");
  hook(repo, "log", { hook_event_name: "SubagentStart", ...worker });
  return repo;
}

// Two Bash calls whose runs overlap: both start, the file changes, then both end.
function overlapping(repo, leadCmd, workerCmd, file = "src/f0.ts") {
  const lead = { tool_name: "Bash", tool_input: { command: leadCmd }, tool_use_id: "L1" };
  const work = { tool_name: "Bash", tool_input: { command: workerCmd }, tool_use_id: "W1c", ...worker };
  hook(repo, "fence", { hook_event_name: "PreToolUse", ...lead });
  hook(repo, "fence", { hook_event_name: "PreToolUse", ...work });
  write(repo, file, "export const x = 2;\n");
  hook(repo, "log", { hook_event_name: "PostToolUse", ...work, tool_response: {} });
  hook(repo, "log", { hook_event_name: "PostToolUse", ...lead, tool_response: {} });
  hook(repo, "log", { hook_event_name: "SubagentStop", ...worker });
}

test("C1 reported-surface: a worker's sed on the file inside a concurrent lead npm run test is the worker's", () => {
  const repo = opened("wc-c1");
  overlapping(repo, "npm run test", "sed -i '' 's/1/2/' src/f0.ts");
  assert.deepEqual(r16(repo), []);
});

test("C2 refused: the lead's sed on the file inside a worker command that does not name it stays the lead's", () => {
  const repo = opened("wc-c2");
  overlapping(repo, "sed -i '' 's/1/2/' src/f0.ts", "npm run test");
  assert.equal(r16(repo).length, 1);
});

test("C3 refused: when both commands name the file it stays the lead's", () => {
  const repo = opened("wc-c3");
  overlapping(repo, "grep -n x src/f0.ts && npm run test", "sed -i '' 's/1/2/' src/f0.ts");
  assert.equal(r16(repo).length, 1);
});

test("C4 edge: a worker naming the file by its bare name after cd counts", () => {
  const repo = opened("wc-c4");
  overlapping(repo, "npm run test", "cd src && sed -i '' 's/1/2/' f0.ts");
  assert.deepEqual(r16(repo), []);
});

test("C5 boundary: a concurrent lead command and a worker command naming nothing stays the lead's", () => {
  const repo = opened("wc-c5");
  overlapping(repo, "npm run test", "python3 fix.py");
  assert.equal(r16(repo).length, 1);
});
