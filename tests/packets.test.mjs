import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { DEFAULTS } from "../scripts/lib/config.mjs";
import { detectFramework } from "../scripts/lib/brief.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { ROLES } from "../scripts/lib/verbs.mjs";

// ===== from tests/helper-packets.test.mjs =====
{
// ---------------------------------------------------------------------------
// conventions (mirrors tests/brief-report.test.mjs and tests/tier-policy.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session),
  });
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so tracked/clean files diff against a baseline commit.
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// Every mutating verb ends with a `next:` hint (tests/next-hints.test.mjs owns that line);
// assertions about a verb's own output ignore it.
const withoutHint = (s) => lines(s).filter((l) => !l.startsWith("next:"));

// ---------------------------------------------------------------------------
// source-of-truth anchors
//   globs        → scripts/lib/config.mjs DEFAULTS (never the packet renderer)
//   agent files  → git show HEAD:agents/<x>.md
//   line counts  → the fixture's own bytes
// ---------------------------------------------------------------------------

const TESTS_GLOBS = DEFAULTS.tests;

// Two exports, four newline-terminated lines. Both counting conventions agree on 4.
const X_SRC = "export function alpha() {\n  return 1;\n}\nexport const beta = 2;\n";
const X_LINES = X_SRC.split("\n").length - 1;

const PLAN_FILE = "src/lib/x.ts";
const TASK_TEXT = "Give helpers a generated packet. [inferred]";
const PLAN_TEXT = "Touch one module and nothing else.";

// The header sections every packet carries, in the order the spec lists them.
const HEADER_SECTIONS = ["Task", "Plan", "Context", "Cases", "Tier", "Tests", "You may write"];

// The requirements pin "the plan's files" as a section, not its exact wording: the skeptic
// packet calls it `## Files`, the QA packet `## Files the implementer will touch`.
const FILES_SECTION = /^##\s+Files\b/;

function headings(md) {
  return md.split("\n").flatMap((l) => {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    return m ? [m[1]] : [];
  });
}

// Text of one `## <heading>` section, up to the next `## ` line. `heading` is the exact
// heading text, or a RegExp when only its opening words are pinned by the requirements.
function section(md, heading) {
  const all = md.split("\n");
  const want = heading instanceof RegExp ? (l) => heading.test(l.trim()) : (l) => l.trim() === `## ${heading}`;
  const start = all.findIndex((l) => /^##\s+\S/.test(l) && want(l));
  assert.ok(start >= 0, `packet has no "## ${heading}" section:\n${md.slice(0, 2000)}`);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function briefFile(repo, role, round = 1) {
  return path.join(runDir(repo), `brief-${role}-${round}.md`);
}

function packet(repo, role, args = []) {
  const r = cli(repo, "brief", [role, ...args]);
  const out = lines(r.stdout);
  const p = out.find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${r.stdout}`);
  return { stdout: r.stdout, out, path: p, text: readFileSync(p, "utf8") };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// An open ledger with a Task, a Plan naming one file, and a two-row case table.
// `verify` is overridden so `gate verify` is two fast commands, one green one red.
function opened(name, { playbook = "feature", files = {}, planFiles = PLAN_FILE, verify = null, cases = null } = {}) {
  const repo = committed(name, {
    [PLAN_FILE]: X_SRC,
    ...(verify ? { ".claude/gate.json": JSON.stringify({ verify }) } : {}),
    ...files,
  });
  cli(repo, "open", [name, playbook]);
  cli(repo, "note", ["task", TASK_TEXT]);
  cli(repo, "note", ["plan", PLAN_TEXT, ...(planFiles ? ["--files", planFiles] : [])]);
  for (const [text, kind] of cases ?? [["renders the packet", "happy"], ["refuses an unknown role", "refused"]]) {
    cli(repo, "case", ["add", text, "--kind", kind]);
  }
  return repo;
}

// The same ledger at size large (eleven planned files): the only size QA and the worker are for.
const PAD = Array.from({ length: 10 }, (_, i) => `src/lib/pad${i}.ts`);
function openedLarge(name, opts = {}) {
  const planFiles = [opts.planFiles ?? PLAN_FILE, ...PAD].join(",");
  return opened(name, { ...opts, planFiles, files: { ...Object.fromEntries(PAD.map((f) => [f, "export const pad = 1;\n"])), ...(opts.files ?? {}) } });
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 happy: `gate brief <role>` writes brief-<role>-1.md in the run dir and prints the packet path and a one-sentence spawn prompt", () => {
  const repo = openedLarge("packets-c1");

  for (const role of ["skeptic", "qa", "reviewer", "reviewer-2"]) {
    const r = cli(repo, "brief", [role]);
    const out = withoutHint(r.stdout);
    const abs = briefFile(repo, role);

    assert.ok(existsSync(abs), `${role}: ${abs} was not written`);
    assert.equal(out.length, 2, `${role}: expected exactly two printed lines, got:\n${r.stdout}`);
    assert.equal(out[0], `packet: ${abs}`);
    assert.ok(out[1].startsWith(`prompt: Read ${abs} and follow your role brief.`), `${role}: ${out[1]}`);
    assert.ok(path.isAbsolute(abs), `${role}: the packet path is not absolute`);
  }
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 happy: every packet starts with Task, Plan, the case table, the tier block, the tests globs with the detected framework, and what the helper may write", () => {
  const repo = openedLarge("packets-c2");
  // review-1.md exists so reviewer-2 has something to embed; it does not change the header.
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n\n_none_\n");

  const slug = "packets-c2";
  for (const role of ["skeptic", "qa", "reviewer", "reviewer-2"]) {
    const { text } = packet(repo, role);
    const first = lines(text)[0];
    assert.match(first, new RegExp(`^# Brief: ${role} round \\d+ — ${slug}$`), `${role}: bad title line "${first}"`);

    const order = headings(text);
    const header = order.slice(0, HEADER_SECTIONS.length);
    assert.deepEqual(header, HEADER_SECTIONS, `${role}: header sections are wrong or out of order (got ${order.join(", ")})`);

    assert.ok(section(text, "Task").includes(TASK_TEXT), `${role}: Task section does not quote ledger.md`);
    assert.ok(section(text, "Plan").includes(PLAN_TEXT), `${role}: Plan section does not quote ledger.md`);

    const cases = section(text, "Cases");
    assert.match(cases, /^\|\s*C1\s*\|/m, `${role}: no "| C1 |" row in the case table:\n${cases}`);
    assert.match(cases, /^\|\s*C2\s*\|/m, `${role}: no "| C2 |" row in the case table:\n${cases}`);
    assert.ok(cases.includes("renders the packet"), `${role}: C1's text is missing from the case table`);
    assert.ok(cases.includes("happy") && cases.includes("refused"), `${role}: case kinds are missing`);

    assert.match(section(text, "Tier"), /^tier:/m, `${role}: Tier section has no line starting "tier:"`);

    const tests = section(text, "Tests");
    for (const glob of TESTS_GLOBS) assert.ok(tests.includes(glob), `${role}: tests glob ${glob} missing from the Tests section:\n${tests}`);
    // makeRepo's package.json has no test framework and its test script is "true".
    assert.match(tests, /^framework: unknown$/m, `${role}: no "framework: <name>" line:\n${tests}`);

    const may = section(text, "You may write");
    if (role === "skeptic") {
      // The skeptic now writes its findings to skeptic-<n>.md in the run dir (tests/skeptic-file.test.mjs C4).
      const m = /(\S*skeptic-(\d+)\.md)/.exec(may);
      assert.ok(m, `skeptic may write: no skeptic-<n>.md named:\n${may}`);
      assert.equal(m[1], path.join(runDir(repo), `skeptic-${m[2]}.md`), "skeptic may write: the path is not absolute");
    } else if (role === "qa") {
      for (const glob of TESTS_GLOBS) assert.ok(may.includes(glob), `qa may write: tests glob ${glob} missing:\n${may}`);
    } else {
      const m = /(\S*review-(\d+)\.md)/.exec(may);
      assert.ok(m, `${role} may write: no review-<n>.md named:\n${may}`);
      assert.equal(m[1], path.join(runDir(repo), `review-${m[2]}.md`), `${role} may write: the review path is not absolute`);
    }
  }
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 happy: the skeptic packet lists the plan's files with line counts and exported symbols and contains no diff", () => {
  const repo = opened("packets-c3", {
    files: { "src/lib/y.py": "def one():\n    return 1\n\n\nclass Two:\n    pass\n" },
    planFiles: `${PLAN_FILE},src/lib/y.py`,
  });
  const { text } = packet(repo, "skeptic");
  const files = section(text, FILES_SECTION);

  const xRow = lines(files).find((l) => l.includes(PLAN_FILE));
  assert.ok(xRow, `no row for ${PLAN_FILE}:\n${files}`);
  assert.ok(xRow.includes(`${X_LINES} lines`), `row for ${PLAN_FILE} does not say "${X_LINES} lines": ${xRow}`);
  assert.match(xRow, /exports: alpha, beta\b/, `row for ${PLAN_FILE} does not list its exports: ${xRow}`);

  const yRow = lines(files).find((l) => l.includes("src/lib/y.py"));
  assert.ok(yRow, `no row for src/lib/y.py:\n${files}`);
  assert.ok(yRow.includes("6 lines"), `row for src/lib/y.py does not say "6 lines": ${yRow}`);
  assert.ok(/\bone\b/.test(yRow) && /\bTwo\b/.test(yRow), `row for src/lib/y.py does not list def/class symbols: ${yRow}`);

  assert.ok(!text.includes("@@"), "the skeptic packet contains a diff hunk marker");
  assert.ok(!text.includes("diff --git"), "the skeptic packet contains a diff");
  assert.ok(!headings(text).includes("Diff"), "the skeptic packet has a Diff section");
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

test("C4 refused: the QA packet contains no line starting with @@, + or -, lists up to three nearest test files nearest first, and for a bugfix names the reported-surface case first", () => {
  // Four candidate test files at four distinct directory distances from src/lib/:
  //   src/lib/x.test.ts   same dir
  //   src/a.test.ts       parent dir
  //   tests/a.test.ts     (makeRepo default) sibling tree, shallow
  //   tests/far/deep/y.test.ts  sibling tree, deep
  const repo = openedLarge("packets-c4", {
    files: {
      "src/lib/x.test.ts": "// nearest\ntest('x', () => {});\n",
      "src/a.test.ts": "// second\ntest('a', () => {});\n",
      "tests/far/deep/y.test.ts": "// farthest\ntest('y', () => {});\n",
    },
  });
  // Something for a diff to exist at all, so "no diff" is a real absence.
  write(repo, PLAN_FILE, `${X_SRC}export const gamma = 3;\n`);

  const { text } = packet(repo, "qa");

  const offenders = text.split("\n").filter((l) => /^(\+|-|@@)/.test(l));
  assert.deepEqual(offenders, [], `the QA packet has diff-shaped lines:\n${offenders.join("\n")}`);
  assert.ok(!text.includes("diff --git"), "the QA packet contains a diff");

  assert.ok(section(text, FILES_SECTION).includes(PLAN_FILE), "the QA packet does not list the plan's files");

  const conv = section(text, "Test conventions");
  const order = ["src/lib/x.test.ts", "src/a.test.ts", "tests/a.test.ts"].map((p) => conv.indexOf(p));
  assert.ok(order.every((i) => i >= 0), `not all three nearest test files are present:\n${conv}`);
  assert.ok(order[0] < order[1] && order[1] < order[2], `test files are not nearest-first (indexes ${order.join(", ")}):\n${conv}`);
  assert.ok(!conv.includes("tests/far/deep/y.test.ts"), "a fourth test file was included; the cap is three");
  assert.ok(conv.includes("test('x', () => {});"), "the nearest test file's body is not shown as a sample");
  assert.match(conv, /^\s*```/m, "the samples are not in fenced code blocks");

  // A bugfix ledger: the reported surface is the first test QA writes.
  const bug = openedLarge("packets-c4-bug", {
    playbook: "bugfix",
    cases: [
      ["the crash the user reported on /venues", "reported-surface"],
      ["renders with a rating", "happy"],
    ],
  });
  const bugText = packet(bug, "qa").text;
  const startWith = lines(bugText).find((l) => /^##\s+Start with\b/.test(l) || /start with/i.test(l));
  const caseRows = lines(section(bugText, "Cases")).filter((l) => /^\|\s*C\d+\s*\|/.test(l));
  const firstRowIsReported = /reported-surface/.test(caseRows[0] ?? "");
  assert.ok(
    firstRowIsReported || (startWith && /C\d+/.test(startWith)),
    `the bugfix QA packet neither orders the reported-surface case first nor names it in a "Start with" line:\n${bugText.slice(0, 2000)}`,
  );
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 happy: the reviewer packet holds the unified diff of changed source and test files, the verify lines, the review number and the exact output path", () => {
  const repo = opened("packets-c5", { verify: ["true", "false"] });
  write(repo, PLAN_FILE, `${X_SRC}export const gamma = 3;\n`);
  write(repo, "tests/a.test.ts", "test('a', () => {});\ntest('b', () => {});\n");
  cli(repo, "verify");

  const { text } = packet(repo, "reviewer");

  const diff = section(text, "Diff");
  assert.ok(diff.includes(`diff --git a/${PLAN_FILE} b/${PLAN_FILE}`), `no diff --git header for the source file:\n${diff.slice(0, 1500)}`);
  assert.ok(diff.includes("diff --git a/tests/a.test.ts b/tests/a.test.ts"), "the changed test file is not in the diff");
  assert.match(diff, /^@@ /m, "no @@ hunk header in the diff");
  assert.match(diff, /^\+export const gamma = 3;$/m, "the added line is not in the diff");

  const verify = section(text, "Verify");
  const verifyLine = (cmd) => lines(verify).find((l) => l.includes(`\`${cmd}\``) || l.includes(` ${cmd} `));
  assert.match(verifyLine("true") ?? "", /✓/, `no green mark on the line for "true":\n${verify}`);
  assert.ok(/exit 0/.test(verifyLine("true")), `the line for "true" does not carry its exit code:\n${verify}`);
  assert.match(verifyLine("false") ?? "", /✗/, `no red mark on the line for "false":\n${verify}`);
  assert.ok(/exit 1/.test(verifyLine("false")), `the line for "false" does not carry its exit code:\n${verify}`);

  assert.ok(!text.includes("## Blast radius"), "the packet has no Blast radius section any more");

  const write_ = section(text, "Write your findings to");
  assert.ok(write_.includes(path.join(runDir(repo), "review-1.md")), `the output path is not the run dir's review-1.md:\n${write_}`);

  // A ledger where verify never ran says so rather than inventing lines.
  const fresh = opened("packets-c5-noverify");
  assert.match(section(packet(fresh, "reviewer").text, "Verify"), /_not run_/, "an unverified ledger does not say _not run_");
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 boundary: a diff longer than 300 lines is not inlined; the packet lists the changed files with line counts instead", () => {
  const repo = opened("packets-c6");
  const big = Array.from({ length: 3000 }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n";
  write(repo, "src/big.ts", big);

  const { text } = packet(repo, "reviewer");
  assert.ok(!headings(text).includes("Diff"), `an oversized diff was inlined:\n${headings(text).join(", ")}`);
  const files = headings(text).find((h) => h.startsWith("Changed files"));
  assert.ok(files, `no "Changed files" section for the oversized diff (got ${headings(text).join(", ")})`);
  assert.match(files, /\d+ lines/, `the heading does not say how long the diff is: ${files}`);
  const body = section(text, files);
  assert.ok(body.includes("src/big.ts"), `the changed file is not listed:\n${body}`);
  assert.match(body, /src\/big\.ts \(source, 3000 lines now\)/, `no line count for src/big.ts:\n${body}`);
  assert.ok(!text.includes("export const n2999 = 2999;"), "the oversized diff's tail was inlined anyway");

  // a short diff is still inlined
  const small = opened("packets-c6-small");
  write(small, "src/a.ts", "export const a = 2;\n");
  assert.ok(headings(packet(small, "reviewer").text).includes("Diff"), "a short diff must still be inlined");
});

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

test("C7 happy: the reviewer-2 packet embeds review-1.md", () => {
  const repo = opened("packets-c7");
  write(repo, PLAN_FILE, `${X_SRC}export const gamma = 3;\n`);
  const review1 = "# Review 1\n\n## Act on\n\n1. null venue crashes the card renderer\n";
  writeFileSync(path.join(runDir(repo), "review-1.md"), review1);

  const two = packet(repo, "reviewer-2").text;
  assert.ok(headings(two).includes("Review 1"), `reviewer-2 has no "## Review 1" section (got ${headings(two).join(", ")})`);
  assert.ok(two.includes("null venue crashes the card renderer"), "review-1.md's text is not embedded");

  // It is the reviewer body plus that section: the reviewer's own sections are all there.
  const one = packet(repo, "reviewer").text;
  for (const h of headings(one)) assert.ok(headings(two).includes(h), `reviewer-2 is missing the reviewer section "${h}"`);
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

test("C8 edge: round defaults to the role's huddle count plus one, --round overrides; the review number is one past the highest existing review-<n>.md", () => {
  const repo = opened("packets-c8");
  const dir = runDir(repo);

  // No huddles yet: round 1, and with no review files the output path is review-1.md.
  const first = packet(repo, "reviewer");
  assert.equal(first.path, briefFile(repo, "reviewer", 1));
  assert.ok(section(first.text, "Write your findings to").includes(path.join(dir, "review-1.md")), "first round does not write review-1.md");

  writeFileSync(path.join(dir, "review-1.md"), "# Review 1\n");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  const second = packet(repo, "reviewer");
  assert.equal(second.path, briefFile(repo, "reviewer", 2), "round did not default to huddles + 1");
  assert.ok(existsSync(briefFile(repo, "reviewer", 2)));
  assert.match(lines(second.text)[0], /^# Brief: reviewer round 2 /, "the title line does not carry round 2");

  // A gap in the review files: the next number is one past the highest, not the count.
  writeFileSync(path.join(dir, "review-3.md"), "# Review 3\n");
  const third = packet(repo, "reviewer");
  assert.ok(
    section(third.text, "Write your findings to").includes(path.join(dir, "review-4.md")),
    `expected review-4.md after review-1.md and review-3.md:\n${section(third.text, "Write your findings to")}`,
  );

  // --round overrides the default (up to the three-round cap).
  const forced = packet(repo, "reviewer", ["--round", "3"]);
  assert.equal(forced.path, briefFile(repo, "reviewer", 3));
  assert.ok(existsSync(briefFile(repo, "reviewer", 3)));

  // Rounds are per role: the skeptic is still on round 1.
  assert.equal(packet(repo, "skeptic").path, briefFile(repo, "skeptic", 1));
});

// ---------------------------------------------------------------------------
// C9
// ---------------------------------------------------------------------------

test("C9 happy: detectFramework finds vitest, jest, mocha, ava, node:test and pytest, else unknown", () => {
  const tmp = (files) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gate-framework-"));
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  };
  const pkg = (obj) => ({ "package.json": JSON.stringify({ name: "fx", ...obj }) });

  assert.equal(detectFramework(tmp(pkg({ devDependencies: { vitest: "^1.0.0" } }))), "vitest");
  assert.equal(detectFramework(tmp(pkg({ dependencies: { jest: "^29.0.0" } }))), "jest");
  assert.equal(detectFramework(tmp(pkg({ devDependencies: { mocha: "^10.0.0" } }))), "mocha");
  assert.equal(detectFramework(tmp(pkg({ devDependencies: { ava: "^6.0.0" } }))), "ava");

  // The spec's order: the first of vitest, jest, mocha, ava wins.
  assert.equal(detectFramework(tmp(pkg({ devDependencies: { jest: "1", vitest: "1" } }))), "vitest");

  // No dependency, but the test script runs node's own runner.
  assert.equal(detectFramework(tmp(pkg({ scripts: { test: 'node --test "tests/**/*.test.mjs"' } }))), "node:test");
  // A dependency beats the script.
  assert.equal(detectFramework(tmp({ ...pkg({ scripts: { test: "node --test" }, devDependencies: { vitest: "1" } }) })), "vitest");

  assert.equal(detectFramework(tmp({ "pyproject.toml": "[tool.pytest.ini_options]\n" })), "pytest");
  assert.equal(detectFramework(tmp({ "pytest.ini": "[pytest]\n" })), "pytest");

  assert.equal(detectFramework(tmp(pkg({ scripts: { test: "true" } }))), "unknown");
  assert.equal(detectFramework(tmp({})), "unknown");
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

test("C10 refused: an unknown role, and brief without an open ledger, fail with a usage message and write nothing", () => {
  const repo = opened("packets-c10");
  const before = readdirSync(runDir(repo));

  const bad = run(repo, "brief", ["nope"]);
  assert.equal(bad.status, 0, "the dispatcher must fail open");
  assert.match(bad.stderr, /usage/i, `stderr does not carry a usage message:\n${bad.stderr}`);
  assert.ok(/skeptic/.test(bad.stderr) && /reviewer-2/.test(bad.stderr), `the usage message does not list the roles:\n${bad.stderr}`);
  assert.deepEqual(
    readdirSync(runDir(repo)).filter((f) => f.startsWith("brief-")),
    before.filter((f) => f.startsWith("brief-")),
    "a packet was written for an unknown role",
  );

  const none = run(repo, "brief", []);
  assert.equal(none.status, 0);
  assert.match(none.stderr, /usage/i, `no role at all should print usage:\n${none.stderr}`);

  // No ledger has ever been opened in this repo.
  const bare = committed("packets-c10-noledger");
  const orphan = run(bare, "brief", ["qa"]);
  assert.equal(orphan.status, 0);
  assert.match(orphan.stderr, /no open ledger/i, `stderr does not mention the missing ledger:\n${orphan.stderr}`);
  assert.ok(!existsSync(path.join(stateDir(bare), "runs")), "a run dir was created by a failing brief");
});

// ---------------------------------------------------------------------------
// C11
// ---------------------------------------------------------------------------

test("C11 happy: the full report names the packet file under a huddle when it exists", () => {
  const repo = opened("packets-c11");
  write(repo, PLAN_FILE, `${X_SRC}export const gamma = 3;\n`);

  const before = cli(repo, "report").stdout;
  assert.ok(!before.includes("packet:"), "the report names a packet before any packet exists");

  cli(repo, "brief", ["reviewer"]); // brief-reviewer-1.md
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n\n_none_\n");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  const after = cli(repo, "report").stdout;
  const huddles = section(after, "Huddles");
  assert.ok(huddles.includes("packet: brief-reviewer-1.md"), `the reviewer huddle does not name its packet:\n${huddles}`);
});

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

test("C12 boundary: untracked or non-git files appear in the reviewer diff as all-added blocks; deleted files as a one-line note; a file dirty at open carries a note that pre-existing changes are included", () => {
  const repo = committed("packets-c12", { [PLAN_FILE]: X_SRC });
  // Dirty before the ledger opens: git can no longer attribute these lines to this task.
  write(repo, "src/app/page.tsx", "export default () => null;\nconst pre = 1;\n");

  cli(repo, "open", ["packets-c12", "feature"]);
  cli(repo, "note", ["task", TASK_TEXT]);
  cli(repo, "note", ["plan", PLAN_TEXT, "--files", PLAN_FILE]);
  cli(repo, "case", ["add", "renders", "--kind", "happy"]);

  write(repo, "src/app/page.tsx", "export default () => null;\nconst pre = 1;\nconst during = 2;\n");
  write(repo, "src/new.ts", "export const fresh = 1;\nexport const alsoFresh = 2;\n");
  rmSync(path.join(repo, "src/a.ts"));

  const { text } = packet(repo, "reviewer");
  const diff = section(text, "Diff");

  // Untracked: a synthetic all-added block under a real diff --git header.
  const header = "diff --git a/src/new.ts b/src/new.ts";
  assert.ok(diff.includes(header), `no diff --git header for the untracked file:\n${diff}`);
  const block = diff.slice(diff.indexOf(header)).split("\n").slice(1);
  const bodyEnd = block.findIndex((l) => l.startsWith("diff --git") || /^deleted: /.test(l));
  // `--- /dev/null` and `+++ b/<rel>` are the file header, not content lines.
  const added = (bodyEnd === -1 ? block : block.slice(0, bodyEnd))
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  assert.ok(added.length >= 2, `the untracked block has no content lines:\n${block.slice(0, 20).join("\n")}`);
  assert.ok(added.every((l) => l.startsWith("+")), `the untracked block is not all-added:\n${added.join("\n")}`);
  assert.ok(added.includes("+export const fresh = 1;"), "the untracked file's content is missing");

  // Deleted: one line, with the line count it had.
  assert.match(diff, /^deleted: src\/a\.ts \(1 lines?\)$/m, `no one-line note for the deleted file:\n${diff}`);

  // Dirty at open: the block says so.
  const pageAt = diff.indexOf("src/app/page.tsx");
  assert.ok(pageAt >= 0, "the file that was dirty at open is not in the diff");
  const note = /^\s*\(unreliable for this task: /m;
  assert.match(diff, note, `no "(unreliable for this task: ..." note anywhere in the diff:\n${diff}`);
  assert.ok(diff.search(note) > pageAt, "the unreliable-for-this-task note is not attached to the file that was dirty at open");
});

// ---------------------------------------------------------------------------
// C13
// ---------------------------------------------------------------------------

test("C13 happy: the four agent files say their inputs are in the packet and no longer tell the reviewer to diff itself; frontmatter unchanged", () => {
  const ROLES = ["skeptic", "qa", "reviewer", "reviewer-2"];
  const PINNED = ["name", "model", "disallowedTools"]; // turn budgets are tuned on their own

  // Source of truth for the frontmatter: the committed file, not the working copy.
  const head = (rel) => execFileSync("git", ["show", `HEAD:${rel}`], { cwd: pluginRoot, encoding: "utf8" });
  const frontmatter = (md) => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
    assert.ok(m, "the agent file has no frontmatter");
    return m[1].split("\n").filter((l) => PINNED.includes(l.split(":")[0].trim()));
  };
  const body = (md) => md.replace(/^---\n[\s\S]*?\n---\n/, "");

  for (const role of ROLES) {
    const rel = `agents/${role}.md`;
    const now = readFileSync(path.join(pluginRoot, rel), "utf8");
    assert.ok(
      body(now).includes("in the packet named in your prompt"),
      `${rel} does not tell the agent its inputs are in the packet named in its prompt`,
    );
    // skeptic.md's frontmatter changes by design when it gains its own file (it needs Write
    // and a bigger turn budget); tests/skeptic-file.test.mjs C5 owns those lines.
    if (role !== "skeptic") {
      // the model line is not pinned: every helper inherits the session's model now
      const noModel = (lines) => lines.filter((l) => !/^\s*model:/.test(l));
      assert.deepEqual(noModel(frontmatter(now)), noModel(frontmatter(head(rel))), `${rel}: pinned frontmatter lines changed`);
    }
    assert.ok(!now.includes("git diff"), `${rel} still names the literal phrase "git diff"`);
  }

  // The skeptic keeps its identity, its model and its no-editing posture.
  const skepticFm = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path.join(pluginRoot, "agents", "skeptic.md"), "utf8"))[1].split("\n");
  const fmLine = (key) => skepticFm.find((l) => l.split(":")[0].trim() === key);
  assert.ok(fmLine("name"), "agents/skeptic.md has no name in its frontmatter");
  assert.match(fmLine("model") ?? "", /inherit/, `agents/skeptic.md does not inherit the session's model: ${fmLine("model")}`);
  assert.ok(fmLine("effort"), "agents/skeptic.md has no effort in its frontmatter");
  const skepticDisallowed = fmLine("disallowedTools") ?? "";
  for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
    assert.ok(skepticDisallowed.includes(tool), `agents/skeptic.md no longer disallows ${tool}: ${skepticDisallowed}`);
  }

  const reviewer = readFileSync(path.join(pluginRoot, "agents", "reviewer.md"), "utf8");
  assert.ok(
    reviewer.includes("do not diff the repository yourself") || reviewer.includes("Do not diff the repository yourself"),
    'agents/reviewer.md does not say "do not diff the repository yourself"',
  );
});

// ---------------------------------------------------------------------------
// C14
// ---------------------------------------------------------------------------

test("C14 boundary: a plan that names no files still yields skeptic and QA packets that say so instead of failing", () => {
  const repo = opened("packets-c14", { planFiles: null });

  for (const role of ["skeptic", "qa"]) {
    const r = cli(repo, "brief", [role]);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(briefFile(repo, role), "utf8");
    const files = section(text, FILES_SECTION);
    assert.match(files, /no files\b[\s\S]{0,20}\bnamed\b/i, `${role}: the Files section does not say the plan named no files:\n${files}`);
    assert.ok(!/\d+ lines/.test(files), `${role}: the Files section invented file rows:\n${files}`);
  }
});

// ---------------------------------------------------------------------------
// C15
// ---------------------------------------------------------------------------

test("C15 edge: a changed README.md appears in the reviewer packet's diff", () => {
  const repo = opened("packets-c15", { files: { "README.md": "# fixture\n" } });
  write(repo, "README.md", "# fixture\n\nA second paragraph.\n");
  write(repo, "docs/notes.md", "# notes\n\nand more notes\n");

  const diff = section(packet(repo, "reviewer").text, "Diff");
  // Docs are excluded from `source` by config.DEFAULTS.sourceExclude; the reviewer still
  // sees them, because a doc change is part of the change under review.
  assert.ok(diff.includes("diff --git a/README.md b/README.md"), `README.md is not in the reviewer diff:\n${diff}`);
  assert.match(diff, /^\+A second paragraph\.$/m, "README.md's added line is not in the diff");
  assert.ok(diff.includes("diff --git a/docs/notes.md b/docs/notes.md"), `docs/notes.md is not in the reviewer diff:\n${diff}`);
});

// ---------------------------------------------------------------------------
// C16
// ---------------------------------------------------------------------------

test("C16 boundary: a commit made mid-task does not shrink the reviewer diff or the measured size", () => {
  const repo = opened("packets-c16");
  const headAtOpen = git(repo, ["rev-parse", "HEAD"]).trim();

  const ledger = JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
  assert.equal(ledger.baseline.head, headAtOpen, "the ledger did not record the commit HEAD was at when the task opened");

  // Two edits with a commit between them. `git diff HEAD` would only see the second.
  write(repo, "src/a.ts", "export const a = 1;\nexport const b = 2;\n");
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "mid-task commit"]);
  assert.notEqual(git(repo, ["rev-parse", "HEAD"]).trim(), headAtOpen, "the mid-task commit did not move HEAD");
  write(repo, "src/a.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");

  const diff = section(packet(repo, "reviewer").text, "Diff");
  assert.match(diff, /^\+export const b = 2;$/m, "the committed edit vanished from the reviewer diff");
  assert.match(diff, /^\+export const c = 3;$/m, "the uncommitted edit is missing from the reviewer diff");

  // measure() counts against the same baseline: two added lines, not one.
  const size = cli(repo, "size").stdout;
  const filesLine = lines(size).find((l) => l.startsWith("files:"));
  assert.ok(filesLine, `gate size printed no files line:\n${size}`);
  assert.match(filesLine, /src\/a\.ts 2\b/, `src/a.ts should measure 2 changed lines since the task opened: ${filesLine}`);
});

// ---------------------------------------------------------------------------
// C17
// ---------------------------------------------------------------------------

test("C17 refused: the fence denies Edit/Write to a packet file and Bash commands that name one", () => {
  const repo = opened("packets-c17");
  cli(repo, "brief", ["qa"]);
  const abs = briefFile(repo, "qa");
  const rel = path.relative(repo, abs).split(path.sep).join("/");

  const fence = (payload) =>
    spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, session_id: "S1", ...payload }),
      encoding: "utf8",
      env: envFor(repo),
    });

  for (const tool of ["Write", "Edit"]) {
    const r = fence({ tool_name: tool, tool_input: { file_path: abs } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout || "{}");
    assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", `${tool} to the packet was not denied:\n${r.stdout}`);
  }

  const bash = fence({ tool_name: "Bash", tool_input: { command: `echo x > ${rel}` } });
  assert.equal(bash.status, 0, bash.stderr);
  const bashOut = JSON.parse(bash.stdout || "{}");
  assert.equal(bashOut.hookSpecificOutput?.permissionDecision, "deny", `a Bash command naming the packet was not denied:\n${bash.stdout}`);

  // The fence still lets ordinary source edits through.
  const allowed = fence({ tool_name: "Write", tool_input: { file_path: path.join(repo, "src/a.ts") } });
  assert.equal(allowed.stdout.trim(), "", `an ordinary source write was not allowed:\n${allowed.stdout}`);
});

// ---------------------------------------------------------------------------
// C18
// ---------------------------------------------------------------------------

test("C18 boundary: `gate brief reviewer-2` with no review-1.md still writes a packet that says review-1.md is missing", () => {
  const repo = opened("packets-c18");
  write(repo, PLAN_FILE, `${X_SRC}export const gamma = 3;\n`);
  assert.deepEqual(readdirSync(runDir(repo)).filter((f) => /^review-\d+\.md$/.test(f)), [], "the fixture already has a review file");

  const r = cli(repo, "brief", ["reviewer-2"]);
  const abs = path.join(runDir(repo), "brief-reviewer-2-1.md");
  assert.equal(lines(r.stdout)[0], `packet: ${abs}`, `the packet is not named brief-reviewer-2-1.md:\n${r.stdout}`);
  assert.ok(existsSync(abs), `${abs} was not written`);

  const text = readFileSync(abs, "utf8");
  assert.ok(text.includes("review-1.md not found"), `the packet does not say review-1.md is missing:\n${text.slice(-1500)}`);
  assert.ok(section(text, "Diff").includes("diff --git"), "the reviewer body is missing even though review-1.md is absent");
});

// ---------------------------------------------------------------------------
// C19
// ---------------------------------------------------------------------------

test("C19 boundary: an untracked binary file is named in the reviewer diff and the skeptic file list, never rendered as content", () => {
  const repo = opened("packets-c19", { planFiles: "src/logo.png" });

  // A few KB with NUL bytes in the first 8 KB: tree.countLines() returns null for these,
  // which is the repo's own definition of "binary".
  const png = Buffer.alloc(4096);
  Buffer.from("\x89PNG\r\n\x1a\n").copy(png);
  for (let i = 8; i < png.length; i++) png[i] = i % 7 === 0 ? 0x00 : i % 251;
  writeFileSync(path.join(repo, "src", "logo.png"), png);

  const diff = section(packet(repo, "reviewer").text, "Diff");
  const header = "diff --git a/src/logo.png b/src/logo.png";
  assert.ok(diff.includes(header), `no diff --git header for the binary file:\n${diff}`);

  const block = diff.slice(diff.indexOf(header)).split("\n").slice(1);
  const end = block.findIndex((l) => l.startsWith("diff --git") || /^deleted: /.test(l));
  const body = end === -1 ? block : block.slice(0, end);
  assert.match(body[0] ?? "", /binary file \(\d+ bytes\), contents not shown/, `the line after the header is not the binary note: ${body[0]}`);
  assert.ok(body[0].includes(`(${png.length} bytes)`), `the binary note does not carry the real byte count: ${body[0]}`);
  assert.deepEqual(
    body.filter((l) => l.startsWith("+")),
    [],
    `the binary file produced added lines:\n${body.filter((l) => l.startsWith("+")).join("\n")}`,
  );
  assert.ok(!body.some((l) => l.includes(" ")), "a NUL byte reached the packet");

  const files = section(packet(repo, "skeptic").text, FILES_SECTION);
  const row = lines(files).find((l) => l.includes("src/logo.png"));
  assert.ok(row, `the skeptic packet does not list the binary file:\n${files}`);
  assert.ok(row.includes("src/logo.png (binary file)"), `the skeptic row is not "src/logo.png (binary file)": ${row}`);
  assert.ok(!/\d+ lines/.test(row), `the skeptic row invents a line count for a binary file: ${row}`);
  assert.ok(!/exports:/.test(row), `the skeptic row invents exports for a binary file: ${row}`);
});

// ---------------------------------------------------------------------------
// C20
// ---------------------------------------------------------------------------

test("C20 refused: the QA packet's file rows are read from the task's baseline, so an edit made after the ledger opened never reaches QA", () => {
  const repo = openedLarge("packets-c20", { planFiles: `${PLAN_FILE},src/lib/z.ts` });

  // The implementer's work, after the ledger opened: a new export in a file QA was told
  // about, and a file that did not exist at the baseline at all.
  write(repo, PLAN_FILE, `${X_SRC}export const gamma = 3;\n`);
  write(repo, "src/lib/z.ts", "export const zeta = 1;\n");

  const qa = packet(repo, "qa").text;
  assert.ok(!qa.includes("gamma"), `the QA packet names an export added after the ledger opened:\n${qa}`);
  assert.ok(!qa.includes("zeta"), "the QA packet names an export from a file created after the ledger opened");
  assert.ok(!qa.includes("exports:"), `the QA packet lists exported symbols at all:\n${section(qa, FILES_SECTION)}`);

  const files = section(qa, FILES_SECTION);
  const row = lines(files).find((l) => l.includes(PLAN_FILE));
  assert.ok(row, `no row for ${PLAN_FILE}:\n${files}`);
  assert.match(row, /src\/lib\/x\.ts \(\d+ lines when the task opened\)/, `the row is not baseline-dated: ${row}`);
  assert.ok(row.includes(`(${X_LINES} lines when the task opened)`), `the row does not carry the baseline line count ${X_LINES}: ${row}`);

  const newRow = lines(files).find((l) => l.includes("src/lib/z.ts"));
  assert.ok(newRow, `no row for the file created after the ledger opened:\n${files}`);
  assert.ok(newRow.includes("new file for this task"), `a file absent at the baseline is not marked as new: ${newRow}`);
  assert.ok(!/\d+ lines/.test(newRow), `the new-file row invents a baseline line count: ${newRow}`);

  // The skeptic is not blind: it reads the working tree and may name gamma.
  const skeptic = packet(repo, "skeptic").text;
  assert.ok(skeptic.includes("exports: alpha, beta, gamma"), `the skeptic packet lost its working-tree export list:\n${section(skeptic, FILES_SECTION)}`);
});
}

// ===== from tests/helper-budget.test.mjs =====
{
// T12 — helper budget: the fence stops burning a helper's turns on read-only shell,
// packets stop inlining a huge diff, a reading helper must draft first, `gate brief`
// refuses a round whose earlier file vanished, and the Stop hook lets the lead's turn
// end while a helper is still running.
//
// Written from the requirements and the case table, blind to this task's edits to
// scripts/lib/{guard,brief,stop}.mjs and hooks/hooks.json.
//
// source-of-truth anchors
//   role list + each role's own-file prefix → scripts/lib/verbs.mjs (ROLES, the huddle
//     `--file` prefix map: arbiter→arbiter, skeptic→skeptic, worker→worker, else review)
//   event kinds on the wire                 → scripts/lib/events.mjs (subagent-start,
//     subagent-stop, prompt) and tests/fixtures/stdin/*.json
//   agent turn budgets                      → agents/<role>.md frontmatter, against the
//     numbers the requirements state (reviewer 40/medium, reviewer-2 40, skeptic 24)
//   diff line counts                        → the fixture's own bytes
// Never the guard's or the renderer's own tables.

// ---------------------------------------------------------------------------
// conventions (mirrors tests/skeptic-file.test.mjs and tests/report-tier.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session),
  });
}

// scripts/gate.mjs always sets `process.exitCode = 0`, so the exit status says nothing:
// a refusal is a `done-gate: <message>` line on stderr (tests/review-loop.test.mjs).
const REFUSAL = /^done-gate: /m;

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// An open feature ledger with a task, a plan naming files, and a case table.
function opened(name, { planFiles = "src/a.ts", files = {} } = {}) {
  const repo = committed(name, files);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Give helpers a budget. [inferred]"]);
  cli(repo, "note", ["plan", "One module.", "--files", planFiles]);
  cli(repo, "case", ["add", "the helper works inside its budget", "--kind", "happy"]);
  cli(repo, "case", ["add", "everything else is denied", "--kind", "refused"]);
  return repo;
}

// One PreToolUse payload through `gate fence` — the hook entry point, so the rules that
// need the session's current run dir are resolved the way production resolves them.
function fence(repo, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "fence"], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, session_id: session, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  if (out === "") return { deny: false, reason: "" };
  const d = JSON.parse(out).hookSpecificOutput;
  return { deny: d.permissionDecision === "deny", reason: d.permissionDecisionReason ?? "" };
}

const bash = (repo, command, extra = {}) =>
  fence(repo, { tool_name: "Bash", tool_input: { command }, ...extra });
const read = (repo, file_path, extra = {}) =>
  fence(repo, { tool_name: "Read", tool_input: { file_path }, ...extra });
const writeTool = (repo, file_path, extra = {}) =>
  fence(repo, { tool_name: "Write", tool_input: { file_path }, ...extra });

// A hook payload fed to `gate log`, exactly as Claude Code's hooks feed one.
function logHook(repo, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// A Stop hook payload, as tests/stop.test.mjs drives one. Returns the block JSON or null.
function stopHook(repo, message = "done.", session = "S1") {
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({
      session_id: session,
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: message,
    }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null;
}

const REVIEWER = { agent_id: "A2", agent_type: "done-gate:reviewer" };

// ---------------------------------------------------------------------------
// C1 happy — read-only shell is free; only a write is denied
// ---------------------------------------------------------------------------

test("C1 happy: a reviewer's read-only inline code and scratch scripts pass the fence, while inline code that writes and an in-place sed on source are denied", () => {
  const repo = opened("budget-shell");

  // No packet has been written into this run dir, so nothing is owed: this case is
  // about the shell rule alone.
  assert.equal(readdirSync(runDir(repo)).filter((f) => f.startsWith("brief-")).length, 0);

  const allowed = [
    // inline code that only reads is not a write
    `node -e "console.log(1)"`,
    `node -e "console.log(require('fs').readFileSync('src/a.ts','utf8'))"`,
    `python3 -c "print(open('src/a.ts').read())"`,
    // a script that lives in scratch space is the helper's own workspace
    "node /tmp/scratch.mjs",
    "node tests/.tmp/scratch.mjs",
    "node --test tests/a.test.ts",
  ];
  for (const cmd of allowed) {
    assert.equal(bash(repo, cmd, REVIEWER).deny, false, `the reviewer was denied a read-only command: ${cmd}`);
  }

  const denied = [
    // inline code that writes is still a write
    `node -e "require('fs').writeFileSync('src/a.ts',1)"`,
    `node -e "require('fs').appendFileSync('src/a.ts','x')"`,
    `node -e "require('fs').rmSync('src/a.ts')"`,
    `python3 -c "open('src/a.ts','w').write('x')"`,
    // a shell write outside scratch is a write however it is spelled
    "sed -i s/a/b/ src/a.ts",
    "echo x > src/a.ts",
    "cp tests/.tmp/a src/b.ts",
  ];
  for (const cmd of denied) {
    const d = bash(repo, cmd, REVIEWER);
    assert.equal(d.deny, true, `the reviewer was allowed to write source: ${cmd}`);
    // the reason has to tell the helper which forms are still open to it
    assert.match(d.reason, /scratch/i, `the denial does not name the allowed forms: ${cmd}\n${d.reason}`);
  }

  // the main session owns the diff: none of this applies to it
  for (const cmd of [...allowed, ...denied.filter((c) => !/\.claude\/gate/.test(c))]) {
    assert.equal(bash(repo, cmd).deny, false, `the lead was denied its own command: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// C2 refused — draft first: a reviewer that owes its file may only read its packet
// ---------------------------------------------------------------------------

test("C2 refused: while a reviewer owes review-1.md its Read of source and its Bash are denied naming that file, its packet Read and its own Write pass, and everything opens up once the file exists", () => {
  const repo = opened("budget-draft-first");
  const dir = runDir(repo);
  const packet = path.join(dir, "brief-reviewer-1.md");
  const own = path.join(dir, "review-1.md");
  writeFileSync(packet, "# Brief: reviewer round 1\n");
  assert.equal(existsSync(own), false, "the reviewer's file must be missing for this case");

  // owed: one brief-reviewer-<n>.md, no review-<n>.md
  const srcRead = read(repo, path.join(repo, "src", "a.ts"), REVIEWER);
  assert.equal(srcRead.deny, true, "a reviewer that owes its draft was allowed to read source");
  assert.match(srcRead.reason, /review-1\.md/, srcRead.reason);

  const anyBash = bash(repo, "grep -rn foo src", REVIEWER);
  assert.equal(anyBash.deny, true, "a reviewer that owes its draft was allowed to run a command");
  assert.match(anyBash.reason, /review-1\.md/, anyBash.reason);

  // the two things it must still be able to do
  assert.equal(read(repo, packet, REVIEWER).deny, false, "the reviewer was denied its own packet");
  assert.equal(writeTool(repo, own, REVIEWER).deny, false, "the reviewer was denied the file it owes");

  // once the draft lands, the role's ordinary permissions are back
  writeFileSync(own, "# Review 1\n\n## Act on\n- unverified\n");
  assert.equal(read(repo, path.join(repo, "src", "a.ts"), REVIEWER).deny, false);
  assert.equal(bash(repo, "grep -rn foo src", REVIEWER).deny, false);
  assert.equal(bash(repo, "node --test tests/a.test.ts", REVIEWER).deny, false);
  assert.equal(writeTool(repo, own, REVIEWER).deny, false);
  // and the rules that were never about drafting still hold
  assert.equal(writeTool(repo, path.join(repo, "src", "a.ts"), REVIEWER).deny, true);
});

// ---------------------------------------------------------------------------
// C3 edge — which roles the draft-first rule reaches
// ---------------------------------------------------------------------------

test("C3 edge: draft-first binds the skeptic, the arbiter and both reviewer roles, and never the worker, QA or the lead", () => {
  const repo = opened("budget-draft-roles");
  const dir = runDir(repo);
  const src = path.join(repo, "src", "a.ts");

  // scripts/lib/verbs.mjs is the source of truth for a role's own-file prefix
  const prefixOf = (role) => ({ arbiter: "arbiter", skeptic: "skeptic", worker: "worker" }[role] ?? "review");
  const agent = (role, i) => ({ agent_id: `A${i}`, agent_type: `done-gate:${role}` });

  // every role in the list gets a packet on disk; none has written its file yet
  for (const role of ROLES) writeFileSync(path.join(dir, `brief-${role}-1.md`), `# Brief: ${role} round 1\n`);

  const BOUND = ["skeptic", "arbiter", "reviewer", "reviewer-2"];
  const FREE = ["worker", "qa"];
  assert.deepEqual([...BOUND, ...FREE].sort(), [...ROLES].sort(), "the case table covers every role in verbs.mjs ROLES");

  BOUND.forEach((role, i) => {
    const who = agent(role, i + 10);
    const owed = `${prefixOf(role)}-1.md`;
    const r = read(repo, src, who);
    assert.equal(r.deny, true, `${role} owed its draft and was still allowed to read source`);
    assert.match(r.reason, new RegExp(owed.replace(".", "\\.")), `${role}: ${r.reason}`);
    assert.equal(bash(repo, "grep -rn foo src", who).deny, true, `${role} owed its draft and was still allowed a command`);
    // its own packet and its own file stay open
    assert.equal(read(repo, path.join(dir, `brief-${role}-1.md`), who).deny, false, `${role} was denied its packet`);
    assert.equal(writeTool(repo, path.join(dir, owed), who).deny, false, `${role} was denied the file it owes`);
  });

  FREE.forEach((role, i) => {
    const who = agent(role, i + 20);
    assert.equal(read(repo, src, who).deny, false, `${role} is not a drafting role but was denied a read`);
    assert.equal(bash(repo, "grep -rn foo src", who).deny, false, `${role} is not a drafting role but was denied a command`);
  });

  // the lead carries no agent_type at all
  assert.equal(read(repo, src).deny, false, "the lead was subjected to draft-first");
  assert.equal(bash(repo, "grep -rn foo src").deny, false, "the lead was subjected to draft-first");

  // the rule counts files, not rounds, and the two reviewer roles share review-<n>.md:
  // a fresh run dir, one reviewer packet, one review file → nothing owed; a second
  // packet of either reviewer role owes again.
  const second = opened("budget-draft-rounds");
  const dir2 = runDir(second);
  const src2 = path.join(second, "src", "a.ts");
  writeFileSync(path.join(dir2, "brief-reviewer-1.md"), "# Brief: reviewer round 1\n");
  writeFileSync(path.join(dir2, "review-1.md"), "# Review 1\n");
  assert.equal(read(second, src2, agent("reviewer", 31)).deny, false, "one packet, one file: nothing owed");
  writeFileSync(path.join(dir2, "brief-reviewer-2-1.md"), "# Brief: reviewer-2 round 1\n");
  assert.equal(
    read(second, src2, agent("reviewer-2", 32)).deny,
    true,
    "reviewer and reviewer-2 share review-<n>.md: two packets against one file owes a draft",
  );
});

// ---------------------------------------------------------------------------
// C4 boundary — a big diff becomes a file list
// ---------------------------------------------------------------------------

test("C4 boundary: above 300 diff lines the reviewer packet drops the unified diff for a changed-file list with line counts, and keeps the diff below it", () => {
  const BIG = 400;
  const bigSrc = Array.from({ length: BIG }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n";
  const bigLines = bigSrc.split("\n").length - 1;
  assert.equal(bigLines, BIG, "fixture anchor: the file's own bytes");

  // over the cap: one 400-line file added after the task opened
  const over = opened("budget-diff-over", { planFiles: "src/big.ts" });
  writeFileSync(path.join(over, "src", "big.ts"), bigSrc);
  const bigPacket = readFileSync(packetPath(over, "reviewer"), "utf8");

  assert.ok(!/^##\s+Diff\s*$/m.test(bigPacket), `a 400-line diff was inlined anyway:\n${bigPacket.slice(0, 500)}`);
  assert.ok(/^##\s+Changed files\b/m.test(bigPacket), `no "## Changed files" section:\n${bigPacket.slice(0, 2000)}`);
  const changed = section(bigPacket, /^##\s+Changed files\b/);
  const row = changed.split("\n").find((l) => l.includes("src/big.ts"));
  assert.ok(row, `src/big.ts is not listed:\n${changed}`);
  assert.match(row, new RegExp(`\\b${BIG}\\b`), `the row carries no line count for a ${BIG}-line file: ${row}`);
  // the reviewer is told what to do instead of reading a diff that is not there
  assert.match(changed, /read/i, `the section does not tell the reviewer to read what it needs:\n${changed}`);
  assert.ok(!/^diff --git /m.test(bigPacket), "a unified diff survived above the cap");

  // under the cap: a four-line change is still inlined
  const under = opened("budget-diff-under", { planFiles: "src/a.ts" });
  writeFileSync(path.join(under, "src", "a.ts"), "export const a = 2;\nexport const b = 3;\n");
  const smallPacket = readFileSync(packetPath(under, "reviewer"), "utf8");
  assert.ok(/^##\s+Diff\s*$/m.test(smallPacket), `no "## Diff" section for a small change:\n${smallPacket.slice(0, 2000)}`);
  assert.match(section(smallPacket, "Diff"), /^diff --git a\/src\/a\.ts /m, section(smallPacket, "Diff"));
  assert.ok(!/^##\s+Changed files\b/m.test(smallPacket), "a small change was summarised instead of shown");
});

// `gate brief <role>` → the packet path it printed.
function packetPath(repo, role, args = []) {
  const r = cli(repo, "brief", [role, ...args]);
  const p = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${r.stdout}`);
  return p;
}

// Text of one `## <heading>` section, up to the next `## ` line. `heading` is the exact
// heading text, or a RegExp when only its opening words are pinned by the requirements.
function section(md, heading) {
  const all = md.split("\n");
  const want = heading instanceof RegExp ? (l) => heading.test(l.trim()) : (l) => l.trim() === `## ${heading}`;
  const start = all.findIndex((l) => /^##\s+\S/.test(l) && want(l));
  assert.ok(start >= 0, `packet has no "## ${heading}" section:\n${md.slice(0, 2000)}`);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

// ---------------------------------------------------------------------------
// C5 refused — a round whose earlier file is gone
// ---------------------------------------------------------------------------

test("C5 refused: gate brief reviewer is refused while a recorded reviewer huddle's file is missing from the run dir, and passes once the file is there", () => {
  const repo = opened("budget-missing-file");
  const dir = runDir(repo);
  const own = path.join(dir, "review-1.md");

  // a reviewer round was recorded against review-1.md, which is not on disk
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md", "--summary", "round one"]);
  assert.equal(existsSync(own), false, "the recorded file must be missing for this case");
  assert.equal(
    loadLedger(dir).huddles.filter((h) => h.role === "reviewer" && h.file === "review-1.md").length,
    1,
    "ledger anchor: one reviewer huddle recorded against review-1.md",
  );

  const refused = run(repo, "brief", ["reviewer"]);
  assert.match(
    refused.stderr,
    REFUSAL,
    `gate brief reviewer was allowed with review-1.md missing:\n${refused.stdout}${refused.stderr}`,
  );
  assert.match(refused.stderr, /review-1\.md/, refused.stderr);
  assert.equal(
    readdirSync(dir).filter((f) => f === "brief-reviewer-2.md").length,
    0,
    "a refused round still wrote a packet",
  );

  // once the file is where the ledger says it is, the next round is briefed
  writeFileSync(own, "# Review 1\n\n## Act on\n- none\n\n## Evidence verdict\n- fine\n");
  const p = packetPath(repo, "reviewer");
  assert.equal(path.basename(p), "brief-reviewer-2.md", p);
});

// ---------------------------------------------------------------------------
// C6 happy — the lead's turn may end while a helper is running
// ---------------------------------------------------------------------------

test("C6 happy: the Stop hook passes silently without finalising while a done-gate helper started since the last prompt has not stopped, and blocks again once its stop event lands", () => {
  const repo = opened("budget-stop-waiting");
  const dir = runDir(repo);
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");

  // baseline: this turn has unmet rules, so it blocks
  const before = stopHook(repo);
  assert.equal(before?.decision, "block", JSON.stringify(before));
  const blocksBefore = loadSession(stateDir(repo), "S1").blocks?.count ?? 0;
  assert.ok(blocksBefore >= 1);

  // a prompt, then a helper the lead is waiting on
  logHook(repo, { hook_event_name: "UserPromptSubmit", user_message: "keep going" });
  logHook(repo, { hook_event_name: "SubagentStart", agent_id: "A9", agent_type: "done-gate:reviewer" });

  assert.equal(stopHook(repo), null, "the turn was blocked while a helper was still running");
  // and nothing was finalised or counted while it waited
  const ledger = loadLedger(dir);
  assert.equal(ledger.status, "open", "the ledger was closed while a helper was running");
  assert.ok(loadSession(stateDir(repo), "S1").current, "the session's run was cleared while a helper was running");

  // the helper stops: the normal rules apply again
  logHook(repo, { hook_event_name: "SubagentStop", agent_id: "A9", agent_type: "done-gate:reviewer", stop_hook_active: false });
  assert.equal(stopHook(repo)?.decision, "block", "the turn was let go after the helper stopped");

  // any agent the lead spawned counts, not only done-gate roles (tests/stop-sees-helpers C4)
  logHook(repo, { hook_event_name: "UserPromptSubmit", user_message: "again" });
  logHook(repo, { hook_event_name: "SubagentStart", agent_id: "A7", agent_type: "general-purpose" });
  assert.equal(stopHook(repo), null, "a general-purpose agent still running did not buy a quiet stop");
  logHook(repo, { hook_event_name: "SubagentStop", agent_id: "A7", agent_type: "general-purpose", stop_hook_active: false });

  // the refused side: a helper that started before the newest real prompt is history
  logHook(repo, { hook_event_name: "SubagentStart", agent_id: "A8", agent_type: "done-gate:skeptic" });
  logHook(repo, { hook_event_name: "UserPromptSubmit", user_message: "new turn, the old helper is history" });
  assert.equal(stopHook(repo)?.decision, "block", "a helper started before the newest prompt bought a quiet stop");
});

// ---------------------------------------------------------------------------
// C7 edge — the budgets the agent files state
// ---------------------------------------------------------------------------

test("C7 edge: reviewer is 40 turns at effort medium, reviewer-2 is 40 and the skeptic 24, and every agent's By-turn line matches its own frontmatter", () => {
  const agentsDir = path.join(pluginRoot, "agents");

  function frontmatter(role) {
    const text = readFileSync(path.join(agentsDir, `${role}.md`), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(m, `agents/${role}.md has no frontmatter block`);
    const fm = {};
    for (const line of m[1].split("\n")) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    return { fm, body: text.slice(m[0].length) };
  }

  // the numbers the requirements state
  const WANT = { reviewer: 40, "reviewer-2": 40, skeptic: 24 };
  for (const [role, turns] of Object.entries(WANT)) {
    const { fm } = frontmatter(role);
    assert.equal(fm.maxTurns, String(turns), `agents/${role}.md maxTurns`);
  }
  assert.equal(frontmatter("reviewer").fm.effort, "medium", "agents/reviewer.md effort");

  // every agent states its budget as a number, and the By-turn line agrees with it
  for (const role of ROLES) {
    const { fm, body } = frontmatter(role);
    const max = Number(fm.maxTurns);
    assert.ok(Number.isInteger(max) && max > 0, `agents/${role}.md has no numeric maxTurns: ${fm.maxTurns}`);
    const stated = /You have (\d+) turns?\./.exec(body);
    assert.ok(stated, `agents/${role}.md never states its budget as a number`);
    assert.equal(Number(stated[1]), max, `agents/${role}.md states ${stated[1]} turns but maxTurns is ${max}`);
    const by = /By turn (\d+)/.exec(body);
    assert.ok(by, `agents/${role}.md has no "By turn <n>" line`);
    assert.equal(Number(by[1]), max - 2, `agents/${role}.md: By turn ${by[1]} does not match a ${max}-turn budget`);
  }
});

// ---------------------------------------------------------------------------
// C8 happy — the prompt line names the packet and the file the helper owes
// ---------------------------------------------------------------------------

test("C8 happy: the prompt line gate brief prints names both the packet path and the helper's own output file", () => {
  const repo = opened("budget-prompt-line");
  const dir = runDir(repo);
  // scripts/lib/verbs.mjs is the source of truth for a role's own-file prefix
  const prefixOf = (role) => ({ arbiter: "arbiter", skeptic: "skeptic", worker: "worker" }[role] ?? "review");

  for (const role of ["skeptic", "reviewer"]) {
    const r = cli(repo, "brief", [role]);
    const out = lines(r.stdout);
    const packet = out.find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
    const prompt = out.find((l) => l.startsWith("prompt: "));
    assert.ok(packet, `no "packet: <path>" line for ${role}:\n${r.stdout}`);
    assert.ok(prompt, `no "prompt: <text>" line for ${role}:\n${r.stdout}`);
    assert.equal(path.basename(packet), `brief-${role}-1.md`, packet);
    assert.ok(prompt.includes(packet), `the prompt line does not name the packet:\n${prompt}`);
    const own = `${prefixOf(role)}-1.md`;
    assert.ok(prompt.includes(own), `the prompt line does not name ${own}, the file ${role} owes:\n${prompt}`);
    // the file it names is the one in this run dir, not some other task's
    assert.ok(existsSync(path.dirname(path.join(dir, own))), dir);
  }
});
}
