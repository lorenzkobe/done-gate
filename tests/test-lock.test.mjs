// test-lock: `gate test <test files>` runs gate.json's testFiles template on those files and,
// with serialTests, takes one repo-wide lock that `gate verify` shares, so helpers wait their
// turn instead of polling. Cases C1–C8.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, lookedUp } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { input: "", encoding: "utf8", env: envFor(repo), cwd: repo });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}
// a gate verb running in the background, resolved with its exit code and output
function background(repo, verb, args = []) {
  const child = spawn(process.execPath, [gate, verb, ...args], { env: envFor(repo), cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, out })));
  return { child, done };
}

// waits for a condition, failing the test after `ms` instead of hanging it
async function until(cond, what, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const NODE = JSON.stringify(process.execPath);
// a stand-in test runner: logs "start <files>" and "end <files>" with times to probe.log,
// sleeps, then exits 1 when a file name contains "red"
const PROBE = `import { appendFileSync } from "node:fs";
const files = process.argv.slice(2);
const ms = Number(process.env.PROBE_MS ?? 600);
appendFileSync("probe.log", JSON.stringify({ at: "start", files, t: Date.now() }) + "\\n");
setTimeout(() => {
  appendFileSync("probe.log", JSON.stringify({ at: "end", files, t: Date.now() }) + "\\n");
  console.log("PROBE RAN " + files.join(" | "));
  process.exit(files.some((f) => f.includes("red")) ? 1 : 0);
}, ms);
`;
const TEMPLATE = `${NODE} probe.mjs {files}`;

function repoWith(name, config = {}) {
  const repo = makeRepo(name, {
    "probe.mjs": PROBE,
    "tests/red.test.ts": "test('red', () => {});\n",
    ".claude/gate.json": JSON.stringify({ tests: ["tests/**"], ...config }),
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
const probeLog = (repo) => (existsSync(path.join(repo, "probe.log")) ? readFileSync(path.join(repo, "probe.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lockFile = (repo) => path.join(repo, ".claude", "gate", "test.lock");
function deadLock(repo) {
  mkdirSync(path.dirname(lockFile(repo)), { recursive: true });
  writeFileSync(lockFile(repo), JSON.stringify({ pid: 2147483000, pgid: 2147483000, label: "gone", startedAt: new Date().toISOString() }));
}
// [start, end] per run, in start order
function spans(repo) {
  const log = probeLog(repo);
  return log.filter((e) => e.at === "start").map((s) => [s.t, log.find((e) => e.at === "end" && e.files.join() === s.files.join() && e.t >= s.t)?.t]);
}

test("C1 happy: gate test runs testFiles on the named file, streams its output and passes its exit code through", () => {
  const repo = repoWith("tl-c1", { testFiles: TEMPLATE });
  const green = cli(repo, "test", ["tests/a.test.ts"]);
  assert.match(green.stdout, /PROBE RAN tests\/a\.test\.ts/);
  assert.deepEqual(probeLog(repo).find((e) => e.at === "start").files, ["tests/a.test.ts"]);

  const red = run(repo, "test", ["tests/red.test.ts", "tests/a.test.ts"]);
  assert.equal(red.status, 1, `${red.stdout}${red.stderr}`);
  assert.match(red.stdout, /PROBE RAN tests\/red\.test\.ts \| tests\/a\.test\.ts/);
});

test("C2 refused: no file, a missing file, a file outside the repo, a non-test file, or no testFiles: refused and nothing runs", () => {
  const repo = repoWith("tl-c2", { testFiles: TEMPLATE });
  write(path.dirname(repo), "tl-c2-outside.test.ts", "x\n");
  for (const args of [[], ["tests/nope.test.ts"], ["../tl-c2-outside.test.ts"], ["src/a.ts"], ["tests/a.test.ts", "src/a.ts"]]) {
    const r = run(repo, "test", args);
    assert.equal(r.status, 1, `gate test ${args.join(" ")} was not refused:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^done-gate: /m, args.join(" "));
  }
  const none = repoWith("tl-c2-none");
  const r = run(none, "test", ["tests/a.test.ts"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /testFiles/);
  assert.deepEqual([...probeLog(repo), ...probeLog(none)], [], "a refused gate test ran the probe");
});

test("C3 edge: with serialTests a second gate test waits, naming the holder, and never overlaps; gate verify waits the same way", async () => {
  const repo = repoWith("tl-c3", { testFiles: TEMPLATE, serialTests: true, verify: [`${NODE} probe.mjs verify-run`] });
  const first = background(repo, "test", ["tests/a.test.ts"]);
  await until(() => probeLog(repo).length, "the first run to start");
  const second = background(repo, "test", ["tests/red.test.ts"]);
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 1, b.out);
  assert.match(b.out, /waiting.*tests\/a\.test\.ts/i, `the waiter did not name the holder:\n${b.out}`);
  const [s1, s2] = spans(repo);
  assert.ok(s1[1] <= s2[0], `the runs overlapped: ${JSON.stringify(spans(repo))}`);
  assert.equal(existsSync(lockFile(repo)), false, "the lock outlived both runs");

  // gate verify takes the same lock
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/a.ts", "export const a = 2;\n");
  const holder = background(repo, "test", ["tests/a.test.ts"]);
  await until(() => probeLog(repo).length >= 5, "the third run to start");
  const verify = background(repo, "verify");
  const [h, v] = await Promise.all([holder.done, verify.done]);
  assert.equal(h.code, 0, h.out);
  assert.match(v.out, /waiting/i, v.out);
  const all = spans(repo);
  const testSpan = all[2];
  const verifySpan = all[3];
  assert.ok(testSpan[1] <= verifySpan[0], `verify overlapped a gate test: ${JSON.stringify(all)}`);
});

test("C4 edge: a dead holder's lock is taken over; the lock is gone after a red run and after SIGTERM", async () => {
  const repo = repoWith("tl-c4", { testFiles: TEMPLATE, serialTests: true });
  deadLock(repo);
  const r = run(repo, "test", ["tests/red.test.ts"]);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /PROBE RAN/);
  assert.equal(existsSync(lockFile(repo)), false, "a red run left the lock behind");

  const slow = spawn(process.execPath, [gate, "test", "tests/a.test.ts"], { env: { ...envFor(repo), PROBE_MS: "5000" }, cwd: repo, stdio: "ignore" });
  await until(() => existsSync(lockFile(repo)) && probeLog(repo).some((e) => e.at === "start" && e.files[0] === "tests/a.test.ts"), "the slow run to start");
  slow.kill("SIGTERM");
  await new Promise((res) => slow.on("exit", res));
  assert.equal(existsSync(lockFile(repo)), false, "SIGTERM left the lock behind");
});

test("C5 boundary: without serialTests no lock is made and two gate test runs overlap", async () => {
  const repo = repoWith("tl-c5", { testFiles: TEMPLATE });
  const first = background(repo, "test", ["tests/a.test.ts"]);
  const second = background(repo, "test", ["tests/red.test.ts"]);
  let sawLock = false;
  const watching = setInterval(() => (sawLock ||= existsSync(lockFile(repo))), 10);
  await Promise.all([first.done, second.done]);
  clearInterval(watching);
  assert.equal(sawLock, false, "a lock file was made with serialTests off");
  const [s1, s2] = spans(repo);
  assert.ok(s2[0] < s1[1] && s1[0] < s2[1], `the runs did not overlap: ${JSON.stringify(spans(repo))}`);
});

test("C6 refused: a file name with shell metacharacters is one quoted argument; nothing else runs", () => {
  const repo = repoWith("tl-c6", { testFiles: TEMPLATE });
  const name = "tests/x;touch PWNED $(touch PWNED2) 'q'.test.ts";
  write(repo, name, "x\n");
  cli(repo, "test", [name]);
  assert.deepEqual(probeLog(repo).find((e) => e.at === "start").files, [name]);
  assert.equal(existsSync(path.join(repo, "PWNED")), false);
  assert.equal(existsSync(path.join(repo, "PWNED2")), false);
});

const CONTEXT = "Traced: src/a.ts:1 · Related: tests/a.test.ts · Research: none needed: a test fixture";
const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
const packetOf = (repo, role) => readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", [role]).stdout)[1], "utf8");

test("C7 reported-surface: packets give the concrete gate test line and the one-run-at-a-time rule; the fence lets a reviewer run gate test", () => {
  const repo = makeRepo("tl-c7", {
    ...Object.fromEntries(LARGE.map((f) => [f, "export const x = 1;\n"])),
    ".claude/gate.json": JSON.stringify({ testFiles: "npx vitest run {files}", serialTests: true }),
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", ["t", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "One constant per file; no hot path.", "--files", LARGE.join(",")]);
  cli(repo, "case", ["add", "it works", "--kind", "happy"]);
  write(repo, "src/f0.ts", "export const x = 2;\n");
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:a"]);
  cli(repo, "verify", ["--drop", "npm run lint"]);
  cli(repo, "verify");

  const reviewer = packetOf(repo, "reviewer");
  assert.match(reviewer, /`gate test tests\/a\.test\.ts`/, reviewer);
  for (const role of ["reviewer", "worker", "qa"]) {
    const p = packetOf(repo, role);
    assert.match(p, /one test run at a time/i, role);
    assert.match(p, /600000/, role);
    assert.match(p, /never poll/i, role);
    assert.match(p, /run it again/i, role);
    assert.doesNotMatch(p, /through `gate test` or `gate verify`/, role);
  }

  // a reviewer writes its draft before anything else (agents/reviewer.md)
  const draft = /Your file is (\S+review-\d+\.md)/.exec(cli(repo, "brief", ["reviewer"]).stdout)[1];
  writeFileSync(draft, "# Review\n\n## Act on\n- unverified\n## Consider\n- unverified\n## Noted\n- unverified\n## Dismissed\n- none\n## Evidence verdict\n- unverified\n");
  const payload = { session_id: "S1", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `node ${gate} test tests/a.test.ts` }, agent_id: "A1", agent_type: "done-gate:reviewer" };
  const f = spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify(payload), encoding: "utf8", env: envFor(repo), cwd: repo });
  assert.doesNotMatch(f.stdout, /"deny"/, f.stdout);
});

test("C8 idempotent: a gate.json without the new keys keeps its hash; adding one moves it", () => {
  const plain = { tests: ["tests/**"], verify: ["npm test"] };
  const a = makeRepo("tl-c8a", { ".claude/gate.json": JSON.stringify(plain) });
  const b = makeRepo("tl-c8b", { ".claude/gate.json": JSON.stringify({ ...plain, serialTests: true }) });
  const before = createHashOf(plain);
  assert.equal(loadConfig(a).hash, before);
  assert.notEqual(loadConfig(b).hash, before);
  assert.equal(loadConfig(a).serialTests, false);
  assert.equal(loadConfig(a).testFiles, null);
});

test("C9 edge: after gate test is killed with SIGKILL, its tests still hold the lock until they end", async () => {
  const repo = repoWith("tl-c9", { testFiles: TEMPLATE, serialTests: true });
  const slow = spawn(process.execPath, [gate, "test", "tests/a.test.ts"], { env: { ...envFor(repo), PROBE_MS: "1500" }, cwd: repo, stdio: "ignore" });
  await until(() => probeLog(repo).some((e) => e.at === "start"), "the slow run to start");
  slow.kill("SIGKILL");
  await new Promise((res) => slow.on("exit", res));
  const next = background(repo, "test", ["tests/red.test.ts"]);
  const r = await next.done;
  assert.equal(r.code, 1, r.out);
  const [s1, s2] = spans(repo);
  assert.ok(s1[1] && s1[1] <= s2[0], `a waiter ran beside the orphaned tests: ${JSON.stringify(spans(repo))}`);
});

test("C10 edge: two waiters on a dead holder's lock: one takes it over, the runs do not overlap", async () => {
  const repo = repoWith("tl-c10", { testFiles: TEMPLATE, serialTests: true });
  deadLock(repo);
  const a = background(repo, "test", ["tests/a.test.ts"]);
  const b = background(repo, "test", ["tests/red.test.ts"]);
  await Promise.all([a.done, b.done]);
  const [s1, s2] = spans(repo);
  assert.ok(s1[1] <= s2[0], `both waiters took the dead lock: ${JSON.stringify(spans(repo))}`);
});

test("C11 boundary: past the wait limit gate test exits 75 with a busy line naming the holder and runs nothing", async () => {
  const repo = repoWith("tl-c11", { testFiles: TEMPLATE, serialTests: true });
  const holder = spawn(process.execPath, [gate, "test", "tests/a.test.ts"], { env: { ...envFor(repo), PROBE_MS: "3000" }, cwd: repo, stdio: "ignore" });
  await until(() => probeLog(repo).some((e) => e.at === "start"), "the holder to start");
  const r = spawnSync(process.execPath, [gate, "test", "tests/red.test.ts"], { encoding: "utf8", env: { ...envFor(repo), DONE_GATE_TEST_WAIT: "1" }, cwd: repo });
  assert.equal(r.status, 75, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /busy.*tests\/a\.test\.ts.*run it again/i, r.stderr);
  assert.equal(probeLog(repo).filter((e) => e.at === "start").length, 1, "the busy waiter ran its tests");
  await new Promise((res) => holder.on("exit", res));
});

test("C12 refused: a declared repo's test file is refused by gate test, pointing at gate verify", () => {
  const repo = repoWith("tl-c12", { testFiles: TEMPLATE });
  const other = makeRepo("tl-c12-other", { "tests/b.test.ts": "x\n" });
  cli(repo, "open", ["t", "feature", "--repo", "../tl-c12-other"]);
  const r = run(repo, "test", ["../tl-c12-other/tests/b.test.ts"]);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /gate verify/);
  assert.deepEqual(probeLog(repo), []);
  assert.ok(other);
});

test("C13 edge: four waiters on a dead holder's lock never overlap", async () => {
  const repo = repoWith("tl-c13", { testFiles: TEMPLATE, serialTests: true });
  for (const f of ["c", "d"]) write(repo, `tests/${f}.test.ts`, "x\n");
  deadLock(repo);
  const runs = ["a", "red", "c", "d"].map((f) => background(repo, "test", [`tests/${f}.test.ts`]));
  await Promise.all(runs.map((r) => r.done));
  const all = spans(repo).sort((x, y) => x[0] - y[0]);
  assert.equal(all.length, 4, JSON.stringify(all));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1][1] <= all[i][0], `runs overlapped: ${JSON.stringify(all)}`);
});

test("C14 edge: a verify command that calls gate test runs inside verify's lock; a testFiles without {files} is named", () => {
  const repo = repoWith("tl-c14", { testFiles: TEMPLATE, serialTests: true, verify: [`${NODE} ${JSON.stringify(gate)} test tests/a.test.ts`] });
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/a.ts", "export const a = 2;\n");
  const started = Date.now();
  const r = spawnSync(process.execPath, [gate, "verify"], { encoding: "utf8", env: { ...envFor(repo), DONE_GATE_TEST_WAIT: "2" }, cwd: repo });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /waiting|busy/i);
  assert.ok(Date.now() - started < 15000);

  const bad = repoWith("tl-c14-bad", { testFiles: "npx vitest run" });
  const b = run(bad, "test", ["tests/a.test.ts"]);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /testFiles.*\{files\}/);
});

// the hash loadConfig has always taken: the raw config's JSON, then the verify list
import { createHash } from "node:crypto";
function createHashOf(raw) {
  return createHash("sha1").update(JSON.stringify(raw)).update("\n").update(raw.verify.join("\n")).digest("hex");
}
