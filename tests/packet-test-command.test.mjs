// packet-test-command: a helper packet's "## Test command" is the list `gate verify` runs for
// this run, gate.json's commands minus the ones dropped, plus the ones added. Cases C1–C4;
// C5 (declared repos) is in tests/multi-repo.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, lookedUp } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function cli(repo, verb, args = []) {
  const r = spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env: envFor(repo) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

const NODE = JSON.stringify(process.execPath);
const tagged = (tag) => `${NODE} -e "console.log('${tag}')"`;
const CONFIG_TEST = tagged("CONFIG-TEST");
const CONFIG_LINT = tagged("CONFIG-LINT");
const ADDED = tagged("RUN-ADDED");
// a plan naming more than ten files is size large: the worker is briefed too
const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
const CONTEXT = "Traced: src/a.ts:1 · Related: tests/a.test.ts · Research: none needed: a test fixture";

function planned(name, verify) {
  const repo = makeRepo(name, {
    ...Object.fromEntries(LARGE.map((f) => [f, "export const x = 1;\n"])),
    ...(verify ? { ".claude/gate.json": JSON.stringify({ verify }) } : {}),
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "One constant per file; no hot path.", "--files", LARGE.join(",")]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  return repo;
}

const packetOf = (repo, role) => readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", [role]).stdout)[1], "utf8");
// the bullet lines under "## Test command", backticks removed
function testCommandOf(packet) {
  const body = /## Test command\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1];
  assert.ok(body !== undefined, `the packet has no "## Test command" section:\n${packet}`);
  return body.split("\n").filter((l) => l.startsWith("- ") || /^_.*_$/.test(l)).map((l) => l.replace(/^- `(.*)`$/, "$1"));
}
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
const verifiedCmds = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8")).commands.map((c) => c.cmd);

test("C1 happy: a command added with --add is in the reviewer and worker packets' Test command, after the gate.json ones", () => {
  const repo = planned("ptc-c1", [CONFIG_TEST, CONFIG_LINT]);
  cli(repo, "verify", ["--add", ADDED]);
  for (const role of ["reviewer", "worker"]) {
    assert.deepEqual(testCommandOf(packetOf(repo, role)), [CONFIG_TEST, CONFIG_LINT, ADDED], role);
  }
});

test("C2 refused: a gate.json command dropped for the run is not in the packets' Test command", () => {
  const repo = planned("ptc-c2", [CONFIG_TEST, CONFIG_LINT]);
  cli(repo, "verify", ["--drop", CONFIG_TEST]);
  for (const role of ["reviewer", "reviewer-2", "worker"]) {
    assert.deepEqual(testCommandOf(packetOf(repo, role)), [CONFIG_LINT], role);
  }
});

test("C3 idempotent: a dropped gate.json command restored with --add is listed once, in its gate.json place", () => {
  const repo = planned("ptc-c3", [CONFIG_TEST, CONFIG_LINT]);
  cli(repo, "verify", ["--drop", CONFIG_TEST]);
  cli(repo, "verify", ["--add", CONFIG_TEST]);
  assert.deepEqual(testCommandOf(packetOf(repo, "reviewer")), [CONFIG_TEST, CONFIG_LINT]);
});

test("C4 boundary: no verify commands at all keeps the 'no verify command' line; only added commands lists them", () => {
  const none = planned("ptc-c4-none", []);
  assert.deepEqual(testCommandOf(packetOf(none, "reviewer")), ["_no verify command in gate.json_"]);

  const only = planned("ptc-c4-added", []);
  cli(only, "verify", ["--add", ADDED]);
  assert.deepEqual(testCommandOf(packetOf(only, "reviewer")), [ADDED]);
});

test("C5 edge (main repo half): the packet's list is the same list, in the same order, that gate verify runs", () => {
  const repo = planned("ptc-c5", [CONFIG_TEST, CONFIG_LINT]);
  cli(repo, "verify", ["--drop", CONFIG_LINT]);
  cli(repo, "verify", ["--add", ADDED]);
  const listed = testCommandOf(packetOf(repo, "reviewer"));
  cli(repo, "verify");
  assert.deepEqual(listed, verifiedCmds(repo));
});

test("C6 edge: every gate.json command dropped and none added: the packet says there is no verify command for this run, not that gate.json has none", () => {
  const repo = planned("ptc-c6", [CONFIG_TEST]);
  cli(repo, "verify", ["--drop", CONFIG_TEST]);
  assert.deepEqual(testCommandOf(packetOf(repo, "reviewer")), ["_no verify command for this run: gate.json's are all dropped_"]);
});
