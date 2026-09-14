import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { sourceHash } from "../scripts/lib/rules.mjs";
import { snapshot } from "../scripts/lib/tree.mjs";

const node = JSON.stringify(process.execPath);

function cli(repo, verb, args = []) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" },
  });
}

function runDir(repo) {
  return path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
}

function repoWithVerify(name, verify) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ verify }) });
  cli(repo, "open", ["t", "feature"]);
  return repo;
}

test("verify records exit codes, durations and output tails per command, and the source hash", () => {
  const repo = repoWithVerify("verify-basic", [
    `${node} -e "console.log('first ok')"`,
    `${node} -e "console.error('boom'); process.exit(3)"`,
  ]);
  const r = cli(repo, "verify");
  assert.equal(r.status, 0);
  const v = JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8"));
  assert.equal(v.commands.length, 2);
  assert.equal(v.commands[0].exit, 0);
  assert.match(v.commands[0].tail, /first ok/);
  assert.equal(v.commands[1].exit, 3);
  assert.match(v.commands[1].tail, /boom/);
  assert.ok(v.commands.every((c) => typeof c.ms === "number" && c.timedOut === false));
  assert.equal(v.sourceHash, sourceHash(snapshot(repo), loadConfig(repo)));
  assert.match(r.stdout, /1 of 2 red/);
});

test("a command past its timeout is killed and recorded as timedOut", () => {
  const repo = repoWithVerify("verify-timeout", [
    { cmd: `${node} -e "setInterval(() => {}, 1000)"`, timeout: 1 },
  ]);
  const started = Date.now();
  cli(repo, "verify");
  assert.ok(Date.now() - started < 8000, "returned promptly");
  const v = JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8"));
  assert.equal(v.commands[0].timedOut, true);
  assert.notEqual(v.commands[0].exit, 0);
});

test("a command that leaves a background child holding stdout still returns when the command exits", () => {
  const repo = repoWithVerify("verify-bg", [
    `${node} -e "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}).unref(); console.log('parent done'); process.exit(0)"`,
  ]);
  const started = Date.now();
  cli(repo, "verify");
  assert.ok(Date.now() - started < 8000, "did not wait for the orphaned child");
  const v = JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8"));
  assert.equal(v.commands[0].exit, 0);
  assert.match(v.commands[0].tail, /parent done/);
});

test("a green verify closes the {verify} step with script evidence; a red one leaves it open", () => {
  const green = repoWithVerify("verify-green", [`${node} -e "process.exit(0)"`]);
  cli(green, "verify");
  const step = loadLedger(runDir(green)).steps.find((s) => s.key === "verify");
  assert.equal(step.state, "DONE");
  assert.equal(step.evidence, "verify.json");

  const red = repoWithVerify("verify-red", [`${node} -e "process.exit(1)"`]);
  cli(red, "verify");
  assert.equal(loadLedger(runDir(red)).steps.find((s) => s.key === "verify").state, null);
});

test("`--step verify-before` targets the refactor playbook's baseline step instead", () => {
  const repo = makeRepo("verify-before", { ".claude/gate.json": JSON.stringify({ verify: [`${node} -e "process.exit(0)"`] }) });
  cli(repo, "open", ["r", "refactor"]);
  cli(repo, "verify", ["--step", "verify-before"]);
  const steps = loadLedger(runDir(repo)).steps;
  assert.equal(steps.find((s) => s.key === "verify-before").state, "DONE");
  assert.equal(steps.find((s) => s.key === "verify").state, null);
});

test("verify without an open ledger explains what to do and writes nothing", () => {
  const repo = makeRepo("verify-noledger");
  const r = cli(repo, "verify");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /gate open/);
});

test("the stop gate accepts a green, fresh verify and rejects it again after a further source edit", () => {
  const repo = repoWithVerify("verify-stop", [`${node} -e "process.exit(0)"`]);
  write(repo, "src/a.ts", "changed\n");
  write(repo, "tests/a.test.ts", "changed\n");
  cli(repo, "verify");
  const stop = () => JSON.parse(spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, last_assistant_message: "done" }),
    encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  }).stdout || "null");
  const first = stop();
  assert.ok(!(first?.reason ?? "").includes("R3"), first?.reason);
  write(repo, "src/a.ts", "changed again\n");
  assert.match(stop().reason, /R3 — verify\.json is stale/);
});
