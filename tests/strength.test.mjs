import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, here } from "./helpers.mjs";
import { capRun, pickBreaks, runBreaks } from "../scripts/lib/strength.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { acquireTestLock } from "../scripts/lib/testlock.mjs";

// 6.10: breaks are picked from added code lines and run against the related tests on a copy

const cfg = (over = {}) => ({ isSchema: () => false, isHighRisk: () => false, ...over });
const at = (texts) => texts.map((text, i) => ({ pos: i + 1, text }));

test("6.10 S1 happy: the leftmost operator outside strings and comments is swapped, skipped lines are skipped, and the picks repeat", () => {
  const lines = at([
    "import { x } from \"./x.mjs\";",
    "console.log(a === b);",
    "const label = \"a >= b\"; const ok = a >= b;",
    "if (a && b) return true;",
    "const cls = <div className={a === b ? \"x\" : \"y\"} />;",
    "const url = process.env.API === \"x\";",
    "// a === b in a comment",
    "const same = a == b; // was !==",
    "const flag = false;",
    "if (a <= b) go();",
  ]);
  const picks = pickBreaks("src/a.ts", lines, cfg(), { perFile: 10 });
  const byPos = Object.fromEntries(picks.map((b) => [b.pos, b.now]));
  assert.equal(byPos[3], "const label = \"a >= b\"; const ok = a < b;", "the operator inside the string is left");
  assert.equal(byPos[4], "if (a || b) return true;");
  assert.equal(byPos[8], "const same = a != b; // was !==");
  assert.equal(byPos[9], "const flag = true;");
  assert.equal(byPos[10], "if (a > b) go();");
  for (const skipped of [1, 2, 5, 6, 7]) assert.ok(!(skipped in byPos), `line ${skipped} should be skipped`);
  assert.deepEqual(pickBreaks("src/a.ts", lines, cfg(), { perFile: 10 }), picks, "the same lines give the same picks");
  const three = pickBreaks("src/a.ts", lines, cfg());
  assert.equal(three.length, 3);
  assert.deepEqual(three.map((b) => b.pos), [3, 8, 10], "three picks spread over the five candidates");
  const many = Array.from({ length: 5 }, (_, i) => ({ file: `f${i}`, pos: 1 })).flatMap((b) => [b, { ...b, pos: 2 }, { ...b, pos: 3 }]);
  assert.equal(capRun(many, 9).length, 9);
  assert.deepEqual(capRun(many, 9), capRun(many, 9));
});

test("6.10 S2 edge: no break for a file with no candidate, a non-JS file, or a schema or high-risk file", () => {
  assert.deepEqual(pickBreaks("src/a.ts", at(["const a = 1;", "export default a;"]), cfg()), []);
  assert.deepEqual(pickBreaks("src/a.py", at(["if a >= b: pass"]), cfg()), []);
  assert.deepEqual(pickBreaks("src/a.ts", at(["if (a >= b) go();"]), cfg({ isSchema: () => true })), []);
  assert.deepEqual(pickBreaks("src/a.ts", at(["if (a >= b) go();"]), cfg({ isHighRisk: () => true })), []);
});

// a repo with a real module and node tests, the tests' runs logged where the test says
function calcRepo(name, { config = {}, strong = true, extra = [] } = {}) {
  const log = path.join(here, ".tmp", `${name}.log`);
  rmSync(log, { force: true });
  const testBody = [
    "import { test } from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { appendFileSync } from \"node:fs\";",
    "import { atLeast, both } from \"../src/calc.mjs\";",
    `appendFileSync(${JSON.stringify(log)}, "test\\n");`,
    strong ? "test(\"atLeast\", () => { assert.equal(atLeast(2, 1), true); assert.equal(atLeast(1, 2), false); });" : "",
    "test(\"both\", () => { assert.equal(both(true, true), true); });",
    ...extra,
  ].join("\n");
  const repo = makeRepo(name, {
    "src/calc.mjs": "export const atLeast = (n, m) => n >= m;\nexport const both = (a, b) => a && b;\n",
    "tests/calc.test.mjs": `${testBody}\n`,
    ".claude/gate.json": JSON.stringify({ source: ["src/**", "tests/**"], tests: ["tests/**"], testFiles: "node --test {files}", ...config }),
    ".gitignore": "node_modules/\nignored.txt\nscratch/\n",
    "scratch/keep.txt": "real\n",
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  const breaks = pickBreaks("src/calc.mjs", at(readFileSync(path.join(repo, "src/calc.mjs"), "utf8").split("\n").filter(Boolean)), cfg());
  const go = (over = {}) => runBreaks({ root: repo, stateDir: path.join(repo, ".claude", "gate"), config: loadConfig(repo), tests: ["tests/calc.test.mjs"], breaks, ...over });
  const logged = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { repo, breaks, go, log, logged };
}
const treeOf = (repo) => ["src/calc.mjs", "tests/calc.test.mjs"].map((f) => readFileSync(path.join(repo, f), "utf8")).join("\n---\n");

test("6.10 S3 happy: a break the tests notice and one they miss are both found, and the real tree is unchanged", async () => {
  const { repo, breaks, go } = calcRepo("st-s3");
  assert.equal(breaks.length, 2, "anchor: one break per line");
  const before = treeOf(repo);
  const r = await go();
  assert.equal(r.skipped, undefined, r.skipped);
  assert.deepEqual(r.noticed.map((b) => b.pos), [1], `the strong test notices >= turned into <: ${JSON.stringify(r)}`);
  assert.deepEqual(r.survivors.map((b) => b.pos), [2], "no test notices && turned into ||");
  assert.equal(treeOf(repo), before);
});

test("6.10 S4 refused: a red baseline, no testFiles, a template naming the repo, no related test, and serialTests with no reset each skip with the reason", async () => {
  const red = calcRepo("st-s4-red");
  write(red.repo, "tests/calc.test.mjs", "import { test } from \"node:test\";\ntest(\"red\", () => { throw new Error(\"red\"); });\n");
  assert.match((await red.go()).skipped ?? "", /fail/i);
  const none = calcRepo("st-s4-none", { config: { testFiles: null } });
  assert.match((await none.go()).skipped ?? "", /testFiles/);
  const own = calcRepo("st-s4-own");
  const ownCfg = { ...loadConfig(own.repo), testFiles: `node --test ${own.repo}/{files}` };
  assert.match((await own.go({ config: ownCfg })).skipped ?? "", /path/);
  const empty = calcRepo("st-s4-empty");
  assert.match((await empty.go({ tests: [] })).skipped ?? "", /related test/);
  const serial = calcRepo("st-s4-serial", { config: { serialTests: true } });
  assert.match((await serial.go()).skipped ?? "", /strengthReset/);
});

test("6.10 S5 edge: under serialTests the reset runs before the clean run and after each break; a failed reset is reported; a busy lock skips", async () => {
  const resetLog = path.join(here, ".tmp", "st-s5-reset.log");
  const reset = `node -e "require('fs').appendFileSync(${JSON.stringify(resetLog).replace(/"/g, "'")}, 'reset\\n')"`;
  rmSync(resetLog, { force: true });
  const s = calcRepo("st-s5", { config: { serialTests: true, strengthReset: reset } });
  const r = await s.go();
  assert.equal(r.skipped, undefined, r.skipped);
  assert.equal(readFileSync(resetLog, "utf8").trim().split("\n").length, 3, "once before the clean run, once after each of two breaks");
  const failing = calcRepo("st-s5-fail", { config: { serialTests: true, strengthReset: "exit 3" } });
  assert.match((await failing.go()).skipped ?? "", /reset/);
  const busy = calcRepo("st-s5-busy", { config: { serialTests: true, strengthReset: "true" } });
  const lock = await acquireTestLock(path.join(busy.repo, ".claude", "gate"), "another run");
  try {
    assert.match((await busy.go()).skipped ?? "", /busy/);
  } finally {
    lock.release();
  }
});

test("6.10 S6 boundary: a run cut off after its marker makes the next run reset first; the real tree is untouched", async () => {
  const resetLog = path.join(here, ".tmp", "st-s6-reset.log");
  rmSync(resetLog, { force: true });
  const reset = `node -e "require('fs').appendFileSync(${JSON.stringify(resetLog).replace(/"/g, "'")}, 'reset\\n')"`;
  const s = calcRepo("st-s6", { config: { serialTests: true, strengthReset: reset } });
  const stateDir = path.join(s.repo, ".claude", "gate");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "strength-pending"), JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  const before = treeOf(s.repo);
  const r = await s.go({ tests: [] });
  assert.match(r.skipped ?? "", /related test/, "anchor: this run itself skips");
  assert.equal(existsSync(resetLog) ? readFileSync(resetLog, "utf8").trim() : "", "reset", "the left marker made it reset first");
  assert.equal(existsSync(path.join(stateDir, "strength-pending")), false, "the marker is cleared once the reset ran");
  const cut = await s.go({ budgetMs: 1 });
  assert.ok(cut.untried?.length > 0 || cut.skipped, JSON.stringify(cut));
  assert.equal(treeOf(s.repo), before, "the real tree is untouched");
});

test("6.10 S7 performance: copying a tree of 3000 files is measured and stays inside the budget", async () => {
  const s = calcRepo("st-s7");
  for (let i = 0; i < 3000; i++) write(s.repo, `src/many/f${i}.mjs`, `export const v${i} = ${i};\n`);
  execFileSync("git", ["add", "-A"], { cwd: s.repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "many"], { cwd: s.repo });
  const r = await s.go();
  assert.equal(r.skipped, undefined, r.skipped);
  assert.ok(Number.isFinite(r.copyMs), "the copy's time is reported");
  assert.ok(r.copyMs < 30000, `copying 3000 files took ${r.copyMs} ms`);
});

test("6.10 S8 refused: a reset failing mid-run stops it and keeps the marker; an ignored folder is never written; the child cannot reach the real tree", async () => {
  const counter = path.join(here, ".tmp", "st-s8-count");
  rmSync(counter, { force: true });
  const reset = `node -e "const f=${JSON.stringify(counter).replace(/"/g, "'")};const fs=require('fs');const n=(fs.existsSync(f)?+fs.readFileSync(f,'utf8'):0)+1;fs.writeFileSync(f,String(n));process.exit(n===2?1:0)"`;
  const s = calcRepo("st-s8", { config: { serialTests: true, strengthReset: reset } });
  const r = await s.go();
  assert.ok(r.resetFailed, JSON.stringify(r));
  assert.ok(existsSync(path.join(s.repo, ".claude", "gate", "strength-pending")), "a failed reset keeps the marker");

  const envLog = path.join(here, ".tmp", "st-s8-env.log");
  rmSync(envLog, { force: true });
  const writes = calcRepo("st-s8-writes", { extra: [
    "import { mkdirSync, writeFileSync } from \"node:fs\";",
    "mkdirSync(\"scratch\", { recursive: true }); writeFileSync(\"scratch/keep.txt\", \"written by a break run\\n\");",
    `appendFileSync(${JSON.stringify(envLog)}, \`[\${process.env.CLAUDE_PROJECT_DIR ?? ""}]\\n\`);`,
  ] });
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = writes.repo;
  try {
    const w = await writes.go();
    assert.equal(w.skipped, undefined, w.skipped);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
  assert.equal(readFileSync(path.join(writes.repo, "scratch/keep.txt"), "utf8"), "real\n", "an ignored folder of the real repo was written");
  assert.ok(readFileSync(envLog, "utf8").trim().split("\n").every((l) => l === "[]"), readFileSync(envLog, "utf8"));
});

test("6.10 S9 edge: a reset that takes real time keeps its own time after a break, and shifts are never broken into syntax errors", async () => {
  const slow = `node -e "setTimeout(() => {}, 1200)"`;
  const s = calcRepo("st-s9", { config: { serialTests: true, strengthReset: slow } });
  const r = await s.go({ budgetMs: 20000 });
  assert.equal(r.skipped, undefined, r.skipped);
  assert.ok(!r.resetFailed, JSON.stringify(r));
  assert.equal(existsSync(path.join(s.repo, ".claude", "gate", "strength-pending")), false);
  assert.deepEqual(pickBreaks("src/a.ts", at(["x >>= 1;", "y <<= 2;"]), cfg()), []);
});
