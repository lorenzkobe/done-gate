import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// ---------------------------------------------------------------------------
// conventions
// ---------------------------------------------------------------------------

const NODE = JSON.stringify(process.execPath);

function envFor(repo, session = "S1", extra = {}) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session, ...extra };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1", extraEnv = {}, bin = gate } = {}) {
  return spawnSync(process.execPath, [bin, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session, extraEnv),
  });
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  return r;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(repo, ".claude", "gate", "runs", loadSession(stateDir(repo), session).current);
const closedRunDir = (repo, session = "S1") =>
  path.join(repo, ".claude", "gate", "runs", loadSession(stateDir(repo), session).lastClosed);

// a Stop hook payload, exactly as tests/stop.test.mjs feeds one
function stopHook(repo, message = "report", session = "S1", bin = gate) {
  const r = spawnSync(process.execPath, [bin, "stop"], {
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
  return r;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// Every mutating verb ends with a `next:` hint (tests/next-hints.test.mjs owns that line);
// assertions about a verb's own output ignore it.
const withoutHint = (s) => lines(s).filter((l) => !l.startsWith("next:"));
const numbered = (s) => lines(s).filter((l) => /^\s*\d+[.)]/.test(l));
const checksLine = (s) => lines(s).find((l) => /\b(green|red|failed|not run)\b/i.test(l));

// A stand-in executable on PATH, so a check can be named after a real tool without
// that tool being installed (and without npx reaching the network for the real one).
const exits = (code) => `#!/bin/sh\nexit ${code}\n`;
const passthrough = '#!/bin/sh\nexec "$@"\n';

function fakeBin(repo, scripts) {
  const bin = path.join(repo, "fakebin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  return { extraEnv: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}

// ---------------------------------------------------------------------------
// source-of-truth anchors (never the implementation's own constants)
// ---------------------------------------------------------------------------

const playbookPath = (name) => path.join(pluginRoot, "skills", "gate", "playbooks", `${name}.md`);
const playbookSteps = (name) =>
  readFileSync(playbookPath(name), "utf8")
    .split("\n")
    .filter((l) => /^\d+\.\s/.test(l));
const keyed = (steps) => steps.filter((l) => /\{[a-z0-9-]+\}\s*$/.test(l.trim()));

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// The fixture tests/report.test.mjs builds, plus a second (N/A) case and a real
// verify run, so the brief has something of every kind to suppress or summarise.
// Unmet on this fixture: R7 (no test file changed), R5 (no reviewer pass), R8
// (blank steps) — three things missing.
const STANDARD_UNMET = 3;

function standardFixture(name, { gateJson = null } = {}) {
  const repo = makeRepo(name, gateJson ? { ".claude/gate.json": JSON.stringify(gateJson) } : {});
  cli(repo, "open", ["badge", "feature"]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "One component, no data change."]);
  cli(repo, "case", ["add", "renders badge", "--kind", "happy"]);
  cli(repo, "case", ["add", "hidden when the venue has no rating", "--kind", "edge"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:renders the badge"]);
  cli(repo, "case", ["close", "C2", "--na", "covered by C1's fixture"]);
  cli(repo, "blast", ["add", "only one consumer", "--rung", "2", "--proof", "src/a.ts:1"]);
  cli(repo, "step", ["read", "done", "read it", "--evidence", "events#1"]);
  cli(repo, "step", ["cleanup", "skipped", "tiny change"]);
  cli(repo, "waive", ["driver", "skip the phone pass this time, chrome is disconnected"]);
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n- null venue crashes\n");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["acton", "H1", "null venue crashes"]);
  cli(repo, "decide", ["plan", "kept it simple", "one consumer", "src/a.ts", "open"]);
  write(repo, "src/a.ts", "changed\n");
  cli(repo, "verify");
  return repo;
}

// A ledger the gate agrees is clean: the plan playbook, every step closed, no
// source touched, `gate close` run. Mirrors tests/verbs.test.mjs's close test.
function cleanClosingFixture(name, slug = "tidy") {
  const repo = makeRepo(name);
  cli(repo, "open", [slug, "plan"]);
  cli(repo, "note", ["task", "Write the spec. [inferred]"]);
  cli(repo, "note", ["plan", "One document."]);
  cli(repo, "case", ["add", "spec covers the refused side", "--kind", "refused"]);
  cli(repo, "case", ["add", "spec covers the happy path", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:refused"]);
  cli(repo, "case", ["close", "C2", "--test", "tests/a.test.ts:happy"]);
  cli(repo, "step", ["read", "done", "read it", "--evidence", "events#1"]);
  cli(repo, "step", ["skeptic", "done", "no findings", "--evidence", "events#2"]);
  cli(repo, "step", ["implement", "done", "spec written", "--evidence", "docs/notes.md"]);
  cli(repo, "close");
  return repo;
}

const brief = (repo) => cli(repo, "report", ["--brief"]).stdout;

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 happy: `gate check` prints exactly \"clean\" when nothing is unmet", () => {
  const repo = makeRepo("brief-c1");
  const r = cli(repo, "check");
  assert.equal(r.stdout.trim(), "clean");
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 happy: `gate check` with unmet items prints only numbered rule lines", () => {
  const repo = makeRepo("brief-c2");
  cli(repo, "check"); // snapshots the baseline
  write(repo, "src/a.ts", "changed\n");
  const out = cli(repo, "check").stdout;

  const all = lines(out);
  assert.ok(all.length >= 1, out);
  for (const line of all) {
    assert.match(line, /^\d+\. R\d+ — /, `unexpected line in \`gate check\` output: ${JSON.stringify(line)}`);
  }
  assert.equal(all[0].slice(0, 7), "1. R1 —");
  assert.ok(!out.includes("ledger:"), "no ledger: line");
  assert.ok(!out.includes("changed since baseline:"), "no changed-since-baseline line");
  assert.ok(!out.includes("unmet:"), "no unmet: header line");
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 happy: `open`/`attach` print the run dir and keyed steps only; `gate steps` prints every step", () => {
  const feature = playbookSteps("feature");
  assert.equal(feature.length, 15, "anchor: skills/gate/playbooks/feature.md has 15 numbered steps");
  assert.equal(keyed(feature).length, 15, "anchor: every feature step carries a {key} today");

  const repo = makeRepo("brief-c3");
  const open = cli(repo, "open", ["slug-c3", "feature"]).stdout;
  const dir = runDir(repo);
  assert.equal(lines(open)[0], `ledger: ${dir}`);
  const openSteps = numbered(open);
  for (const line of openSteps) {
    assert.match(line, /\{[a-z0-9-]+\}/, `unkeyed step printed by \`gate open\`: ${JSON.stringify(line)}`);
  }
  assert.equal(openSteps.length, keyed(feature).length);

  const attach = cli(repo, "attach", ["slug-c3"], { session: "S2" }).stdout;
  assert.equal(lines(attach)[0], `ledger: ${dir}`);
  for (const line of numbered(attach)) {
    assert.match(line, /\{[a-z0-9-]+\}/, `unkeyed step printed by \`gate attach\`: ${JSON.stringify(line)}`);
  }

  const steps = cli(repo, "steps").stdout;
  assert.equal(numbered(steps).length, 15);

  // the discriminator: a playbook whose steps carry no {key} at all
  const inv = playbookSteps("investigation");
  assert.equal(keyed(inv).length, 0, "anchor: investigation steps carry no {key}");
  const repo2 = makeRepo("brief-c3-inv");
  assert.equal(numbered(cli(repo2, "open", ["slug-inv", "investigation"]).stdout).length, 0);
  assert.equal(numbered(cli(repo2, "steps").stdout).length, inv.length);
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

test("C4 happy: `gate verify` shows a red command's output tail and stays quiet when green", () => {
  // The output word lives in the script, never in the command line, so finding it
  // in stdout proves the tail was printed rather than the command echoed.
  const red = makeRepo("brief-c4-red", {
    "run-red.cjs": "console.log('boom');\nprocess.exit(1);\n",
    ".claude/gate.json": JSON.stringify({ verify: [`${NODE} run-red.cjs`] }),
  });
  cli(red, "open", ["t", "feature"]);
  const redOut = cli(red, "verify").stdout;
  assert.ok(redOut.includes("boom"), `the failing command's output is missing from stdout:\n${redOut}`);

  const green = makeRepo("brief-c4-green", {
    "run-green.cjs": "console.log('quiet');\nprocess.exit(0);\n",
    ".claude/gate.json": JSON.stringify({
      verify: [`${NODE} run-green.cjs`, `${NODE} -e "process.exit(0)"`],
    }),
  });
  cli(green, "open", ["t", "feature"]);
  const greenOut = cli(green, "verify").stdout;
  assert.ok(!greenOut.includes("```"), `a green verify printed a fenced block:\n${greenOut}`);
  assert.ok(!greenOut.includes("quiet"), `a green verify echoed command output:\n${greenOut}`);
  assert.equal(withoutHint(greenOut).length, 3, "two per-command lines plus the one-line summary");
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 happy: `gate report --brief` prints the short plain-language form", () => {
  const repo = standardFixture("brief-c5");
  assert.equal(numbered(cli(repo, "check").stdout).length, STANDARD_UNMET, "fixture pins the unmet count");

  const out = brief(repo);
  const all = lines(out);

  assert.equal(all[0], `badge: not finished (${STANDARD_UNMET} things missing)`);

  const changed = all.find((l) => /^Changed \d+ files?\./.test(l));
  assert.ok(changed, `no "Changed <n> files." line:\n${out}`);
  assert.ok(changed.includes("Tested 2 cases"), `the changed line does not report the 2 cases: ${changed}`);

  const checks = all.find((l) => /green|red|not run/i.test(l));
  assert.ok(checks, `no checks line:\n${out}`);

  assert.ok(
    all.some((l) => l.startsWith("Reviewer found") || l.startsWith("No independent review yet")),
    `no reviewer line:\n${out}`,
  );

  assert.equal(all[all.length - 1], `Full report: ${path.join(runDir(repo), "report.md")}`);
  assert.ok(all.length <= 14, `the brief is ${all.length} lines, expected 14 or fewer:\n${out}`);

  // the other half of the title: a gate the rules agree is clean
  const clean = cleanClosingFixture("brief-c5-clean", "tidy");
  assert.equal(cli(clean, "check").stdout.trim(), "clean");
  assert.equal(lines(brief(clean))[0], "tidy: done");
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 refused: the brief never leaks the gate's internal vocabulary", () => {
  const repo = standardFixture("brief-c6");
  const out = brief(repo);

  const banned = [
    [/\bledgers?\b/i, "ledger"],
    [/\bhuddles?\b/i, "huddle"],
    [/\bblast\b/i, "blast"],
    [/\brungs?\b/i, "rung"],
    [/\bR\d+\b/, "a rule id"],
    [/N\/A/, "N/A"],
  ];
  for (const [re, what] of banned) {
    const hit = lines(out).find((l) => re.test(l));
    assert.equal(hit, undefined, `the brief mentions ${what}: ${JSON.stringify(hit)}`);
  }
  const heading = lines(out).find((l) => /^#/.test(l));
  assert.equal(heading, undefined, `the brief contains a markdown heading: ${JSON.stringify(heading)}`);
});

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

test("C7 boundary: \"Please look at first:\" appears only when something needs looking at", () => {
  const quiet = cleanClosingFixture("brief-c7-quiet", "quiet");
  const quietOut = brief(quiet);
  assert.ok(
    !quietOut.includes("Please look at first"),
    `nothing is waived, unproven, skipped, denied or overridden, yet:\n${quietOut}`,
  );

  const flagged = cleanClosingFixture("brief-c7-waived", "flagged");
  cli(flagged, "waive", ["read", "skip the phone pass this time, chrome is disconnected"]);
  const flaggedOut = brief(flagged);
  assert.ok(flaggedOut.includes("Please look at first:"), `a waiver did not raise the block:\n${flaggedOut}`);
  assert.ok(
    flaggedOut.includes("chrome is disconnected"),
    `the waiver's quoted words are missing:\n${flaggedOut}`,
  );
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

test("C8 happy: `gate report --brief` still writes the full report.md", () => {
  const repo = standardFixture("brief-c8");
  const file = path.join(runDir(repo), "report.md");
  rmSync(file, { force: true });

  const out = brief(repo);
  assert.ok(existsSync(file), "report.md was not written");
  const md = readFileSync(file, "utf8");
  assert.ok(md.includes("## Steps"), "report.md is not the full report");
  assert.ok(md.includes("## Attention"), "report.md is not the full report");
  assert.ok(md.length > out.length, "report.md should be longer than the brief");
});

// ---------------------------------------------------------------------------
// C9
// ---------------------------------------------------------------------------

test("C9 edge: with no open ledger the brief renders the most recently closed run", () => {
  const repo = cleanClosingFixture("brief-c9", "shipped");
  stopHook(repo); // the Stop hook finalises a clean, closing run
  assert.equal(loadSession(stateDir(repo), "S1").current, null, "no run is open any more");

  const dir = closedRunDir(repo);
  const out = brief(repo);
  const all = lines(out);
  assert.equal(all[0], "shipped: done");
  assert.equal(all[all.length - 1], `Full report: ${path.join(dir, "report.md")}`);
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

test("C10 boundary: the checks line says not-run with no verify, and names the red command", () => {
  const none = makeRepo("brief-c10-none");
  cli(none, "open", ["nocheck", "feature"]);
  const noneOut = brief(none);
  assert.ok(noneOut.includes("Checks not run"), `expected a not-run checks line:\n${noneOut}`);

  const red = makeRepo("brief-c10-red");
  cli(red, "open", ["redcheck", "feature"]);
  write(red, "package.json", JSON.stringify({ name: "redcheck", scripts: { lint: "exit 1", test: "true", build: "true" } }));
  cli(red, "verify");
  const redOut = brief(red);
  assert.match(redOut, /lint/i, `the red command is not named in the brief:\n${redOut}`);
  assert.ok(!redOut.includes("Checks not run"), redOut);
});

// ---------------------------------------------------------------------------
// C11
// ---------------------------------------------------------------------------

// Volatile bits: the repo path, ISO timestamps, command durations, tree hashes and
// the run dir's date prefix. Everything else must match byte for byte.
function normalise(text, repo) {
  return text
    .split(repo)
    .join("<REPO>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TS>")
    .replace(/\b\d+\.\d+s\b/g, "<DUR>")
    .replace(/\b[0-9a-f]{12,40}\b/g, "<HASH>")
    .replace(/\b\d{4}-\d{2}-\d{2}-/g, "<DATE>-");
}

// The Tier section is pinned by tests/report-tier.test.mjs (C8); dropping it from both
// sides keeps this comparison about the rest of the renderer. From the "## Tier" heading
// up to the next "## " heading.
function withoutTier(md) {
  const start = md.indexOf("\n## Tier\n");
  if (start < 0) return md;
  const next = md.indexOf("\n## ", start + 1);
  return next < 0 ? `${md.slice(0, start)}\n` : md.slice(0, start) + md.slice(next);
}

function c11Fixture(name, bin) {
  const repo = makeRepo(name, {
    ".claude/gate.json": JSON.stringify({ verify: [`${NODE} -e "process.exit(0)"`] }),
  });
  const go = (verb, args = []) => {
    const r = run(repo, verb, args, { bin });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  go("open", ["stable", "feature"]);
  go("note", ["task", "Add a badge. [inferred]"]);
  go("note", ["plan", "One component."]);
  go("case", ["add", "renders badge", "--kind", "happy"]);
  go("case", ["add", "hidden with no rating", "--kind", "edge"]);
  go("case", ["close", "C1", "--test", "tests/a.test.ts:renders"]);
  go("case", ["close", "C2", "--na", "covered by C1"]);
  go("blast", ["add", "only one consumer", "--rung", "2", "--proof", "src/a.ts:1"]);
  go("step", ["read", "done", "read it", "--evidence", "events#1"]);
  go("step", ["cleanup", "skipped", "tiny change"]);
  go("waive", ["driver", "skip the phone pass"]);
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n- null venue crashes\n");
  go("huddle", ["add", "reviewer", "--file", "review-1.md"]);
  go("huddle", ["acton", "H1", "null venue crashes"]);
  go("decide", ["plan", "kept it simple", "one consumer", "src/a.ts", "open"]);
  write(repo, "src/a.ts", "changed\n");
  go("verify");
  return { repo, go };
}

test("C11 idempotent: the full report is byte-identical twice, and unchanged from HEAD", (t) => {
  const { repo, go } = c11Fixture("brief-c11", gate);
  const first = go("report").stdout;
  const second = go("report").stdout;
  assert.equal(second, first, "two consecutive `gate report` runs disagree");

  // The HEAD comparison pins the report RENDERER. The Steps section quotes the playbook
  // prose verbatim, so editing a playbook must change the report: comparing against HEAD
  // would then fail for a reason this guard was never meant to catch.
  const playbooksChanged =
    spawnSync("git", ["diff", "--quiet", "HEAD", "--", "skills/gate/playbooks"], { cwd: pluginRoot }).status !== 0;
  if (playbooksChanged) {
    t.diagnostic("skipping the HEAD comparison: skills/gate/playbooks differs from HEAD");
    return;
  }

  // the same fixture driven by the committed gate, as a refactor guard
  const headDir = path.join(here, ".tmp", "brief-c11-head");
  rmSync(headDir, { recursive: true, force: true });
  mkdirSync(headDir, { recursive: true });
  execSync(`git archive HEAD | tar -x -C ${JSON.stringify(headDir)}`, { cwd: pluginRoot });
  const headGate = path.join(headDir, "scripts", "gate.mjs");
  assert.ok(existsSync(headGate), "git archive HEAD did not produce scripts/gate.mjs");

  const head = c11Fixture("brief-c11-head-repo", headGate);
  const headReport = head.go("report").stdout;

  assert.equal(
    withoutTier(normalise(first, repo)),
    withoutTier(normalise(headReport, head.repo)),
    "the full report changed relative to HEAD (outside the Tier section)",
  );
});

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

test("C12 edge: an unrecognised check prints its own text; a multi-word match follows lint > typecheck > tests > build", () => {
  // a command that matches none of lint/typecheck/test/build
  const vet = makeRepo("brief-c12-vet", { ".claude/gate.json": JSON.stringify({ verify: ["go vet ./..."] }) });
  const withPath = fakeBin(vet, { go: exits(0) });
  cli(vet, "open", ["vetted", "feature"], withPath);
  cli(vet, "verify", [], withPath);
  const vetOut = cli(vet, "report", ["--brief"], withPath).stdout;
  assert.ok(
    vetOut.includes("Go vet ./... green."),
    `an unrecognised green check is not printed as its own capitalised text:\n${vetOut}`,
  );

  // "npm run build:test" matches both "build" and "test": tests wins
  const both = makeRepo("brief-c12-both", {
    "package.json": JSON.stringify({ name: "both", scripts: { "build:test": "true" } }),
    ".claude/gate.json": JSON.stringify({ verify: ["npm run build:test"] }),
  });
  cli(both, "open", ["precedence", "feature"]);
  cli(both, "verify");
  const bothOut = cli(both, "report", ["--brief"]).stdout;
  const checks = checksLine(bothOut);
  assert.ok(checks, `no checks line:\n${bothOut}`);
  assert.match(checks, /^Tests green\.$/, `expected the tests word to win: ${JSON.stringify(checks)}`);
  assert.ok(!/build/i.test(checks), `the checks line leaked the raw command: ${JSON.stringify(checks)}`);
});

// ---------------------------------------------------------------------------
// C13
// ---------------------------------------------------------------------------

test("C13 boundary: a run with no cases says so, and never says \"Tested 0 cases\"", () => {
  const repo = makeRepo("brief-c13");
  cli(repo, "open", ["nocases", "feature"]);
  const out = brief(repo);
  assert.ok(!out.includes("Tested 0 cases"), `the brief says "Tested 0 cases":\n${out}`);
  assert.ok(out.includes("No test cases recorded."), `expected the no-cases sentence:\n${out}`);
});

// ---------------------------------------------------------------------------
// C14
// ---------------------------------------------------------------------------

test("C14 refused: attention prose is carried into the brief with the internal words translated", () => {
  const repo = makeRepo("brief-c14");
  cli(repo, "open", ["prose", "feature"]);
  cli(repo, "note", [
    "attention",
    "The ledger's blast radius rung is low here (rung 2); see R7 for details, N/A elsewhere; huddle H1.",
  ]);

  const out = brief(repo);
  assert.ok(out.includes("Please look at first:"), `attention prose did not raise the block:\n${out}`);

  const flagged = lines(out).slice(lines(out).indexOf("Please look at first:") + 1);
  const carried = flagged.find((l) => /low here/.test(l));
  assert.ok(carried, `the attention line was dropped from the block:\n${out}`);

  for (const plain of ["task record", "side effects", "a gate check", "not applicable", "review round"]) {
    assert.ok(carried.includes(plain), `expected ${JSON.stringify(plain)} in: ${JSON.stringify(carried)}`);
  }

  for (const [re, what] of [
    [/\bledger'?s?\b/i, "ledger"],
    [/\bhuddles?\b/i, "huddle"],
    [/\bblast\b/i, "blast"],
    [/\brungs?\b/i, "rung"],
    [/\bR\d+\b/, "a rule id"],
    [/N\/A/, "N/A"],
  ]) {
    const hit = lines(out).find((l) => re.test(l));
    assert.equal(hit, undefined, `the brief still says ${what}: ${JSON.stringify(hit)}`);
  }
});

// ---------------------------------------------------------------------------
// C15
// ---------------------------------------------------------------------------

test("C15 boundary: only gate errors logged after the run opened are flagged", () => {
  const repo = makeRepo("brief-c15");
  cli(repo, "check"); // creates the state dir
  const crash = { extraEnv: { DONE_GATE_TEST: "1" }, input: "{}" };
  const log = path.join(stateDir(repo), "gate-error.log");

  cli(repo, "__throw", [], crash); // predates the run
  assert.ok(existsSync(log), "the pre-open crash did not reach gate-error.log");

  cli(repo, "open", ["crashy", "feature"]);
  const before = brief(repo);
  assert.ok(
    !/gate itself logged/i.test(before),
    `an error logged before the run opened was blamed on it:\n${before}`,
  );

  cli(repo, "__throw", [], crash); // during the run
  assert.equal(readFileSync(log, "utf8").match(/^\d{4}-\d{2}-\d{2}T/gm).length, 2, "two errors on file");

  const after = brief(repo);
  assert.ok(
    after.includes("The gate itself logged 1 error during this task"),
    `expected exactly the one in-run error to be flagged:\n${after}`,
  );
  assert.ok(after.includes("Please look at first:"), after);
});

// ---------------------------------------------------------------------------
// C16
// ---------------------------------------------------------------------------

test("C16 edge: a chained lint+typecheck command reports as lint, and an npx-prefixed lint stays lint", () => {
  // `eslint . && tsc` names both tools; lint outranks typecheck, and the chain is red
  const chained = makeRepo("brief-c16-red", {
    ".claude/gate.json": JSON.stringify({ verify: ["eslint . && tsc"] }),
  });
  const redPath = fakeBin(chained, { eslint: exits(1), tsc: exits(0) });
  cli(chained, "open", ["chained", "feature"], redPath);
  cli(chained, "verify", [], redPath);
  const redOut = cli(chained, "report", ["--brief"], redPath).stdout;
  assert.equal(checksLine(redOut), "Lint failed.", `checks line was: ${JSON.stringify(checksLine(redOut))}`);
  assert.ok(!/typecheck/i.test(redOut), `typecheck outranked lint:\n${redOut}`);

  // the same word behind an npx prefix, green. The fake npx just execs its args, so
  // the command text stays "npx eslint src" without npx fetching the real ESLint.
  const green = makeRepo("brief-c16-green", {
    ".claude/gate.json": JSON.stringify({ verify: ["npx eslint src"] }),
  });
  const greenPath = fakeBin(green, { npx: passthrough, eslint: exits(0) });
  cli(green, "open", ["npxed", "feature"], greenPath);
  cli(green, "verify", [], greenPath);
  const greenOut = cli(green, "report", ["--brief"], greenPath).stdout;
  assert.equal(checksLine(greenOut), "Lint green.", `checks line was: ${JSON.stringify(checksLine(greenOut))}`);
});

// ---------------------------------------------------------------------------
// C17
// ---------------------------------------------------------------------------

// "ledger-service" must survive intact: a hyphen is a word boundary, so a naive
// \bledger\b substitution would mangle it into "task record-service".
const standalone = (word) => new RegExp(`(?<![\\w-])${word}(?![\\w-])`, "i");

test("C17 boundary: attention prose translates the bare word but leaves hyphenated names alone", () => {
  const repo = makeRepo("brief-c17");
  cli(repo, "open", ["names", "feature"]);
  cli(repo, "note", ["attention", "See ledger-service and huddle-room; the ledger is fine."]);

  const out = brief(repo);
  const carried = lines(out).find((l) => /is fine/.test(l));
  assert.ok(carried, `the attention line was dropped:\n${out}`);

  assert.ok(carried.includes("ledger-service"), `"ledger-service" was mangled: ${JSON.stringify(carried)}`);
  assert.ok(carried.includes("huddle-room"), `"huddle-room" was mangled: ${JSON.stringify(carried)}`);
  assert.ok(carried.includes("task record"), `the bare word was not translated: ${JSON.stringify(carried)}`);
  assert.ok(
    !standalone("ledger").test(carried),
    `a standalone "ledger" survived: ${JSON.stringify(carried)}`,
  );
  assert.ok(
    !standalone("huddle").test(carried),
    `a standalone "huddle" survived: ${JSON.stringify(carried)}`,
  );
});

// ---------------------------------------------------------------------------
// C18
// ---------------------------------------------------------------------------

test("C18 refused: commands that merely contain \"lint\" inside a word are not checks named Lint", () => {
  // "build-fLINTt.js" and "spLINTer-check" both hide the substring; neither is a linter
  const repo = makeRepo("brief-c18", {
    "build-flint.js": "process.exit(0);\n",
    "package.json": JSON.stringify({ name: "c18", scripts: { "splinter-check": "true" } }),
    ".claude/gate.json": JSON.stringify({ verify: ["node build-flint.js", "npm run splinter-check"] }),
  });
  cli(repo, "open", ["flint", "feature"]);
  cli(repo, "verify");

  const out = cli(repo, "report", ["--brief"]).stdout;
  const checks = checksLine(out);
  assert.ok(checks, `no checks line:\n${out}`);
  assert.ok(
    checks.includes("Node build-flint.js"),
    `the first command is not printed as its own capitalised text: ${JSON.stringify(checks)}`,
  );
  assert.ok(
    checks.includes("npm run splinter-check"),
    `the second command is not printed as its own text: ${JSON.stringify(checks)}`,
  );
  assert.ok(!checks.includes("Lint"), `a substring match named these Lint: ${JSON.stringify(checks)}`);
  assert.ok(!out.includes("Lint"), `the brief calls something Lint:\n${out}`);
});
