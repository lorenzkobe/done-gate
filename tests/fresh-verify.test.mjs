// fresh-verify: a reviewer packet says whether verify.json is the gate's own green run on
// exactly the code under review; when it is, helpers run the case tests, not the whole test
// command again. Cases C1–C6 (C5, R3 unchanged, is held by tests/rules.test.mjs and
// tests/verify.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, lookedUp, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env: envFor(repo) });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

const CONTEXT = "Traced: src/a.ts:1 · Related: tests/a.test.ts · Research: none needed: a test fixture";
// a plan naming more than ten files is size large: the worker is briefed too
const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);

function planned(name, { verify = null, large = false } = {}) {
  const repo = makeRepo(name, {
    ...(large ? Object.fromEntries(LARGE.map((f) => [f, "export const x = 1;\n"])) : {}),
    ...(verify ? { ".claude/gate.json": JSON.stringify({ verify }) } : {}),
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "One constant changes; no hot path.", "--files", large ? LARGE.join(",") : "src/a.ts"]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  cli(repo, "case", ["add", "it refuses", "--kind", "refused"]);
  write(repo, "src/a.ts", "export const a = 2;\n");
  return repo;
}

const packetOf = (repo, role) => readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", [role]).stdout)[1], "utf8");
const sectionOf = (packet, name) => new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(packet)?.[1] ?? "";
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
const FRESH = /verify\.json is fresh/;
const NOT_FRESH = /verify\.json is not fresh \(([^)]+)\): run the test command yourself/;
const RERUN_BAN = /do not run the whole test command again/i;

test("C1 happy: verify green on the current source: both reviewer packets say fresh, not to re-run the whole command, and list each case test file once", () => {
  const repo = planned("fv-c1");
  write(repo, "tests/b.test.ts", "test('b', () => {});\n");
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:a"]);
  cli(repo, "case", ["close", "C2", "--test", "tests/a.test.ts:a"]);
  cli(repo, "verify");
  for (const role of ["reviewer", "reviewer-2"]) {
    const verify = sectionOf(packetOf(repo, role), "Verify");
    assert.match(verify, FRESH, `${role}:\n${verify}`);
    assert.match(verify, RERUN_BAN, `${role}:\n${verify}`);
    assert.doesNotMatch(verify, NOT_FRESH, role);
    const files = verify.split("\n").filter((l) => /^- tests\//.test(l));
    assert.deepEqual(files, ["- tests/a.test.ts", "- tests/b.test.ts"], `${role}:\n${verify}`);
    assert.match(verify, /with the test command's runner, naming these files instead of the whole suite/, verify);
  }
});

test("C2 refused: a source edit after verify: the packet says not fresh (stale) and to run the test command", () => {
  const repo = planned("fv-c2");
  cli(repo, "verify");
  write(repo, "src/a.ts", "export const a = 3;\n");
  const verify = sectionOf(packetOf(repo, "reviewer"), "Verify");
  assert.match(verify, NOT_FRESH, verify);
  assert.match(NOT_FRESH.exec(verify)[1], /stale/);
  assert.doesNotMatch(verify, FRESH);
  assert.doesNotMatch(verify, RERUN_BAN);
});

test("C3 edge: red, never finished, or an added command not run: not fresh, with the reason", () => {
  const red = planned("fv-c3-red", { verify: ["false"] });
  run(red, "verify");
  assert.match(NOT_FRESH.exec(sectionOf(packetOf(red, "reviewer"), "Verify"))?.[1] ?? "", /red/);

  const died = planned("fv-c3-died");
  cli(died, "verify");
  // a verify that started after the green one and whose shell died: no live pid
  const startedAt = new Date(Date.now() + 1000).toISOString();
  writeFileSync(path.join(runDir(died), "verify.started.json"), JSON.stringify({ startedAt, pid: 999999, session: "S1", commands: [] }));
  assert.match(NOT_FRESH.exec(sectionOf(packetOf(died, "reviewer"), "Verify"))?.[1] ?? "", /never finished/);

  const pending = planned("fv-c3-pending");
  cli(pending, "verify");
  cli(pending, "verify", ["--add", "true"]);
  assert.match(NOT_FRESH.exec(sectionOf(packetOf(pending, "reviewer"), "Verify"))?.[1] ?? "", /has not run/);

  const never = planned("fv-c3-never");
  assert.match(NOT_FRESH.exec(sectionOf(packetOf(never, "reviewer"), "Verify"))?.[1] ?? "", /no verify\.json/);
});

test("C4 boundary: fresh verify with no closed case and no changed test file says there are no case tests to run", () => {
  const repo = planned("fv-c4");
  cli(repo, "verify");
  const verify = sectionOf(packetOf(repo, "reviewer"), "Verify");
  assert.match(verify, FRESH, verify);
  assert.match(verify, /no case tests to run/, verify);
  assert.equal(verify.split("\n").filter((l) => /^- tests\//.test(l)).length, 0, verify);
});

test("C6 reported-surface: the worker packet and the agent docs say the lead's gate verify runs the whole command and helpers run their own tests", () => {
  const repo = planned("fv-c6", { large: true });
  const worker = sectionOf(packetOf(repo, "worker"), "Test command");
  assert.match(worker, /`gate verify` runs these/, worker);
  assert.match(worker, /run the tests QA wrote and the tests of the files you own/, worker);

  const doc = (name) => readFileSync(path.join(pluginRoot, "agents", `${name}.md`), "utf8");
  for (const name of ["reviewer", "reviewer-2"]) {
    assert.match(doc(name), /verify\.json is fresh/, name);
    assert.match(doc(name), /case tests/, name);
  }
  assert.match(doc("reviewer"), /\(ran it myself \| fresh verify\.json \+ case tests \| unverified\)/);
  assert.match(doc("worker"), /tests QA wrote and the tests of the files you own/);
  assert.match(doc("qa"), /run only the tests you wrote/i);
});

test("C7 idempotent: with no source change, a pending --add command still makes R3 say it has not run", () => {
  const repo = makeRepo("fv-c7");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature"]);
  cli(repo, "verify", ["--add", "true"]);
  const out = run(repo, "check").stdout;
  assert.match(out.split("\n").find((l) => /R3/.test(l)) ?? "", /`true` has not run/, out);
});

test("C8 edge: a test command verify skipped (when: source, only tests changed since) is not fresh: the new tests never ran under it", () => {
  const repo = planned("fv-c8", { verify: [{ cmd: "npm run test", when: "source" }] });
  cli(repo, "verify");
  write(repo, "tests/b.test.ts", "test('b', () => {});\n");
  cli(repo, "verify");
  const verify = sectionOf(packetOf(repo, "reviewer"), "Verify");
  assert.match(NOT_FRESH.exec(verify)?.[1] ?? "", /skipped/, verify);
});

test("C9 boundary: case test files come from closed pointers that exist and changed test files that still exist; n/a cases and deleted files add none", () => {
  const repo = planned("fv-c9");
  write(repo, "tests/b.test.ts", "test('b', () => {});\n");
  cli(repo, "case", ["close", "C1", "--test", "tests/b.test.ts::b"]);
  cli(repo, "case", ["close", "C2", "--na", "covered by C1's test"]);
  execFileSync("git", ["rm", "-q", "tests/a.test.ts"], { cwd: repo });
  cli(repo, "verify");
  const verify = sectionOf(packetOf(repo, "reviewer"), "Verify");
  assert.deepEqual(verify.split("\n").filter((l) => /^- tests\//.test(l)), ["- tests/b.test.ts"], verify);
});
