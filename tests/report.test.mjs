import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here, pluginRoot } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

// ===== from tests/report.test.mjs =====
{
const env = (repo) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" });
function cli(repo, verb, args = [], input = "") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: env(repo) });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);

test("report renders every section, the summary counts, and embeds the reviewer's file verbatim", () => {
  const repo = makeRepo("report-render");
  cli(repo, "open", ["badge", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["plan", "One component."]);
  cli(repo, "case", ["add", "renders badge", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:renders"]);
  cli(repo, "step", ["read", "done", "read it", "--evidence", "events#1"]);
  cli(repo, "step", ["schema", "skipped", "no schema files"]);
  cli(repo, "waive", ["driver", "skip the phone pass"]);
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n- null venue crashes\n");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["acton", "H1", "null venue crashes"]);
  cli(repo, "decide", ["plan", "kept it simple", "one consumer", "src/a.ts", "open"]);
  write(repo, "src/a.ts", "changed\n");
  const r = cli(repo, "report");
  const md = r.stdout;
  assert.match(md, /^# badge — feature/m);
  assert.match(md, /DONE 3 · SKIPPED 1 · WAIVED 1 · N\/A 0 · blank \d+/);
  assert.match(md, /cases 1\/1 closed/);
  assert.match(md, /## Task\n\nAdd a badge/);
  assert.match(md, /\| C1 \| renders badge \| happy \| tests\/a\.test\.ts:renders \|/);
  assert.match(md, /1\. Read the affected code.*DONE.*events#1/);
  assert.match(md, /null venue crashes.*OPEN/);
  assert.match(md, /# Review 1/);
  assert.match(md, /## Changed files\n[\s\S]*src\/a\.ts/);
  assert.match(md, /kept it simple/);
  assert.match(md, /## Attention[\s\S]*waived.*driver/i);
  assert.ok(existsSync(path.join(runDir(repo), "report.md")));
  assert.equal(readFileSync(path.join(runDir(repo), "report.md"), "utf8"), md);
});
}

// ===== from tests/brief-report.test.mjs =====
{
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

const playbookSection = (name) => {
  const md = readFileSync(path.join(pluginRoot, "skills", "gate", "playbooks.md"), "utf8");
  const m = new RegExp(`^## ${name}\\s*$`, "m").exec(md);
  const rest = md.slice(m.index + m[0].length);
  const end = /^## /m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
};
const playbookSteps = (name) =>
  playbookSection(name)
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
  cli(repo, "step", ["read", "done", "read it", "--evidence", "events#1"]);
  cli(repo, "step", ["schema", "skipped", "no schema files"]);
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
  assert.equal(feature.length, 11, "anchor: the feature playbook has 11 numbered steps");
  assert.equal(keyed(feature).length, 11, "anchor: every feature step carries a {key} today");

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
  assert.equal(numbered(steps).length, 11);

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

  const changed = all.find((l) => /^Changed \d+ files?\b/.test(l));
  assert.ok(changed, `no "Changed <n> files" line:\n${out}`);

  const checks = all.find((l) => /green|red|not run/i.test(l));
  assert.ok(checks, `no checks line:\n${out}`);
  assert.ok(checks.includes("Tested 2 cases"), `the checks line does not report the 2 cases: ${checks}`);

  assert.ok(
    all.some((l) => l.startsWith("Review:") || l.startsWith("No review yet")),
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

test("C7 boundary: the \"For you:\" line says nothing when nothing needs looking at", () => {
  const quiet = cleanClosingFixture("brief-c7-quiet", "quiet");
  const quietOut = brief(quiet);
  assert.ok(
    quietOut.includes("For you: nothing."),
    `nothing is waived, skipped, denied or overridden, yet:\n${quietOut}`,
  );

  const flagged = cleanClosingFixture("brief-c7-waived", "flagged");
  cli(flagged, "waive", ["read", "skip the phone pass this time, chrome is disconnected"]);
  const flaggedOut = brief(flagged);
  assert.ok(flaggedOut.includes("For you: skipped with your OK"), `a waiver did not reach the For you line:\n${flaggedOut}`);
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
  write(none, "src/a.ts", "export const a = 2;\n"); // a source change makes the checks owed
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
  go("step", ["read", "done", "read it", "--evidence", "events#1"]);
  go("step", ["schema", "skipped", "no schema files"]);
  go("waive", ["driver", "skip the phone pass"]);
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n- null venue crashes\n");
  go("huddle", ["add", "reviewer", "--file", "review-1.md"]);
  go("huddle", ["acton", "H1", "null venue crashes"]);
  go("decide", ["plan", "kept it simple", "one consumer", "src/a.ts", "open"]);
  write(repo, "src/a.ts", "changed\n");
  go("verify");
  return { repo, go };
}

test("C11 idempotent: the full report is byte-identical twice", () => {
  const { repo, go } = c11Fixture("brief-c11", gate);
  const first = go("report").stdout;
  const second = go("report").stdout;
  assert.equal(second, first, "two consecutive `gate report` runs disagree");

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
  assert.match(checks, /^Tests green\./, `expected the tests word to win: ${JSON.stringify(checks)}`);
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
    after.includes("the gate itself logged 1 error"),
    `expected exactly the one in-run error to be flagged:\n${after}`,
  );
  assert.ok(after.includes("For you:"), after);
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
  assert.ok(checksLine(redOut).startsWith("Lint failed."), `checks line was: ${JSON.stringify(checksLine(redOut))}`);
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
  assert.ok(checksLine(greenOut).startsWith("Lint green."), `checks line was: ${JSON.stringify(checksLine(greenOut))}`);
});

// ---------------------------------------------------------------------------
// C17
// ---------------------------------------------------------------------------

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
}

// ===== from tests/brief.test.mjs =====
{
// T9 — `gate report --brief` is a fixed five-line summary plus the report path.
// Written from the requirements and the case table, blind to scripts/lib/report.mjs.
//
// The shape under test, and the only thing the lines are addressed by here:
//
//   <slug>: done                       | <slug>: not finished (<n> things missing)
//   <blank>
//   1. what changed   — how many source files, up to three names, the size word
//   2. the checks     — ran and green / red / not run / not needed, and test files
//   3. the review     — rounds and items fixed / open / withdrawn / overruled, or none
//   4. the app        — driven / not yet driven / no screen change
//   5. For you:       — waivers, open disputes, a pause, an override, errors, or nothing
//   <blank>
//   Full report: <path>
//
// Assertions are on the line count, the position of each line and the words that
// carry the meaning — never on a whole sentence, which is the implementation's to word.

// ---------------------------------------------------------------------------
// conventions (mirrors tests/brief-report.test.mjs and tests/review-dispute.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1", extra = {}) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session, ...extra };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1", extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session, extraEnv),
  });
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD: `gate open` snapshots the tree against HEAD.
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

const helperFile = (repo, name, body) => writeFileSync(path.join(runDir(repo), name), body);

// hook payloads, fed exactly as Claude Code's hooks feed them
function hook(repo, verb, payload) {
  const r = spawnSync(process.execPath, [gate, verb], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// a Chrome tool call: the event kind R4 counts as "the surface was driven"
const browserEvent = (repo) =>
  hook(repo, "log", {
    hook_event_name: "PostToolUse",
    tool_name: "mcp__claude-in-chrome__computer",
    tool_input: { action: "screenshot" },
    tool_output: "...",
  });

// a Write tool call, so the edit has a cause and is dated when it happened rather than
// at the next assess (scripts/lib/assess.mjs stampSourceChange)
const editEvent = (repo, file) =>
  hook(repo, "log", {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(repo, file) },
    tool_output: "ok",
  });

// the reviewer subagent finishing: R5's "an independent reviewer looked after the last edit"
const reviewerStop = (repo) =>
  hook(repo, "log", {
    hook_event_name: "SubagentStop",
    agent_id: "A9",
    agent_type: "done-gate:reviewer",
    stop_hook_active: false,
  });

const stopHook = (repo, message) =>
  hook(repo, "stop", { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: message });

// ---------------------------------------------------------------------------
// the shape: every test addresses a line by its position, never by its words
// ---------------------------------------------------------------------------

const CONTENT_LINES = 5; // the requirement: exactly five lines between headline and path

// headline, blank, five content lines, blank, "Full report: <path>"
function parse(out) {
  const all = out.replace(/\n+$/, "").split("\n");
  assert.equal(all.length, 9, `expected 9 raw lines (2 of them blank), got ${all.length}:\n${out}`);
  assert.equal(all[1], "", `line 2 is not blank:\n${out}`);
  assert.equal(all[7], "", `the line before "Full report:" is not blank:\n${out}`);
  const body = all.slice(2, 7);
  for (const [i, l] of body.entries()) assert.ok(l.trim() !== "", `content line ${i + 1} is blank:\n${out}`);
  assert.equal(lines(out).length, CONTENT_LINES + 2, `expected ${CONTENT_LINES} content lines:\n${out}`);
  assert.match(all[8], /^Full report: \S/, `no "Full report: <path>" last line:\n${out}`);
  return { all, headline: all[0], body, changed: body[0], checks: body[1], review: body[2], app: body[3], forYou: body[4], tail: all[8] };
}

const brief = (repo) => cli(repo, "report", ["--brief"]).stdout;
const parsed = (repo) => parse(brief(repo));

// `gate check`'s own numbered rule lines: the source of truth for "<n> things missing"
const unmetCount = (repo) => lines(cli(repo, "check").stdout).filter((l) => /^\s*\d+[.)]/.test(l)).length;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const FIND_1 = "the empty list crashes — src/a.ts:1 — map over a possibly-empty array";
const FIND_2 = "null venue crashes — src/a.ts:2 — the card renders before the query resolves";
const WHY = "the caller already null-checks venue before it renders the card";
const EVIDENCE = "src/a.ts:2";

const reviewFile = (n, slug, actOn, extra = "") =>
  `# Review ${n} — ${slug}\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "_none_"}\n${extra}## Consider\n- rename the helper\n`;
const arbiterFile = (n, slug, ruling) => `# Arbiter ${n} — ${slug}\n\n## Ruling\n- ${ruling}\n`;

// Every step of the open playbook, closed. The keys come from `gate steps`, not from a
// list copied into this file, so a playbook edit cannot leave R8 quietly unmet here.
function closeEveryStep(repo) {
  const keys = lines(cli(repo, "steps").stdout)
    .map((l) => /\{([a-z0-9-]+)\}/.exec(l)?.[1])
    .filter(Boolean);
  assert.ok(keys.length > 0, "the playbook printed no keyed steps");
  for (const key of keys) cli(repo, "step", [key, "done", `did ${key}`, "--evidence", "docs/notes.md"]);
}

// An opened feature run whose plan and case table predate the first source edit.
function opened(name, slug = name, { source = "src/a.ts" } = {}) {
  const repo = committed(name);
  cli(repo, "open", [slug, "feature"]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "One module.", "--files", source]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  cli(repo, "case", ["add", "refuses an unknown role", "--kind", "refused"]);
  write(repo, source, "export const a = 2;\nexport const venue = null;\n");
  editEvent(repo, source);
  write(repo, "tests/a.test.ts", "test('a', () => {});\ntest('b', () => {});\n");
  editEvent(repo, "tests/a.test.ts");
  cli(repo, "check"); // dates the source change here, before anything that must come after it
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:renders the badge"]);
  cli(repo, "case", ["close", "C2", "--test", "tests/a.test.ts:refuses an unknown role"]);
  return repo;
}

// C1's state: one source file changed, tests changed, checks green, one review round
// whose two findings were both fixed, no UI file, no waiver, `gate close` run.
function closedRun(name, slug = name) {
  const repo = opened(name, slug);
  helperFile(repo, "review-1.md", reviewFile(1, slug, [FIND_1, FIND_2]));
  reviewerStop(repo);
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:renders the badge"]);
  cli(repo, "huddle", ["resolve", "H1.2", "--evidence", "tests/a.test.ts:refuses an unknown role"]);
  closeEveryStep(repo);
  cli(repo, "verify");
  cli(repo, "close");
  return repo;
}

// A run that touched no source at all: the plan playbook, every step closed, nothing edited.
function noSourceRun(name, slug = name) {
  const repo = committed(name);
  cli(repo, "open", [slug, "plan"]);
  cli(repo, "note", ["task", "Write the spec. [inferred]"]);
  cli(repo, "note", ["plan", "One document."]);
  cli(repo, "case", ["add", "spec covers the refused side", "--kind", "refused"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:refused"]);
  closeEveryStep(repo);
  cli(repo, "close");
  return repo;
}

// ---------------------------------------------------------------------------
// C1 — the shape of a finished run
// ---------------------------------------------------------------------------

test("C1 happy: a closed run with source changes, green checks, one review round and two fixed items prints a headline, exactly five lines and the report path", () => {
  const repo = closedRun("brief-t9-c1", "badge");
  assert.equal(cli(repo, "check").stdout.trim(), "clean", "fixture is not a finished run");

  const b = parsed(repo); // parse() pins the line count and the blank lines

  assert.equal(b.headline, "badge: done");
  assert.equal(b.tail, `Full report: ${path.join(runDir(repo), "report.md")}`);

  // 1. what changed: how many source files, the name, the size word
  assert.match(b.changed, /\b1\b/, `line 1 does not say how many source files changed: ${JSON.stringify(b.changed)}`);
  assert.ok(b.changed.includes("src/a.ts"), `line 1 does not name the changed file: ${JSON.stringify(b.changed)}`);
  assert.match(b.changed, /\b(small|standard|large)\b/, `line 1 has no size word: ${JSON.stringify(b.changed)}`);

  // 2. the checks ran and were green, and test files changed
  assert.match(b.checks, /\bgreen\b/i, `line 2 does not say the checks were green: ${JSON.stringify(b.checks)}`);
  assert.match(b.checks, /\btests?\b/i, `line 2 does not mention the test files: ${JSON.stringify(b.checks)}`);

  // 3. one round, two items fixed
  assert.match(b.review, /\b1\b/, `line 3 does not count the one review round: ${JSON.stringify(b.review)}`);
  assert.match(b.review, /\b2\b/, `line 3 does not count the two fixed items: ${JSON.stringify(b.review)}`);
  assert.match(b.review, /fixed/i, `line 3 does not say the items were fixed: ${JSON.stringify(b.review)}`);

  // 4. no UI file was touched
  assert.match(b.app, /no screen change/i, `line 4 should say there was no screen change: ${JSON.stringify(b.app)}`);

  // 5. nothing for the user
  assert.match(b.forYou, /^For you:/, `line 5 does not start with "For you:": ${JSON.stringify(b.forYou)}`);
  assert.match(b.forYou, /nothing/i, `nothing was waived, disputed or paused, yet: ${JSON.stringify(b.forYou)}`);
});

// ---------------------------------------------------------------------------
// C2 — no gate vocabulary, in any run state
// ---------------------------------------------------------------------------

test("C2 refused: the five lines never say ledger, huddle, rung, skeptic, blast, N/A or a rule id, in any run state", () => {
  const banned = [
    [/\bledgers?\b/i, "ledger"],
    [/\bhuddles?\b/i, "huddle"],
    [/\brungs?\b/i, "rung"],
    [/\bskeptics?\b/i, "skeptic"],
    [/\bblast\b/i, "blast"],
    [/N\/A/, "N/A"],
    [/\bR\d{1,2}\b/, "a rule id"],
  ];

  const states = {
    finished: closedRun("brief-t9-c2-done", "done-one"),
    "no source": noSourceRun("brief-t9-c2-nosrc", "spec"),
    unfinished: opened("brief-t9-c2-open", "halfway"),
    "waived, disputed and paused": attentionRun("brief-t9-c2-att", "flagged"),
    "ui not driven": uiRun("brief-t9-c2-ui", "screen", { drive: false }),
  };

  for (const [what, repo] of Object.entries(states)) {
    const b = parsed(repo);
    for (const line of [b.headline, ...b.body]) {
      for (const [re, word] of banned) {
        assert.ok(!re.test(line), `the ${what} brief says ${word}: ${JSON.stringify(line)}`);
      }
      assert.ok(!/^#/.test(line), `the ${what} brief has a markdown heading: ${JSON.stringify(line)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// C3 — nothing changed
// ---------------------------------------------------------------------------

test("C3 edge: a run with no source changes says so on line 1, and line 2 says the checks were not needed", () => {
  const repo = noSourceRun("brief-t9-c3", "spec");
  const b = parsed(repo);

  assert.match(b.changed, /\bno\b/i, `line 1 does not say no source files changed: ${JSON.stringify(b.changed)}`);
  assert.ok(
    !/\b[1-9]\d* (source )?files?\b/.test(b.changed),
    `line 1 counts files on a run that changed none: ${JSON.stringify(b.changed)}`,
  );
  assert.match(b.checks, /not needed/i, `line 2 does not say the checks were not needed: ${JSON.stringify(b.checks)}`);
  assert.ok(!/\bgreen\b|\bred\b/i.test(b.checks), `line 2 claims a check result: ${JSON.stringify(b.checks)}`);
});

// ---------------------------------------------------------------------------
// C4 — the unfinished headline
// ---------------------------------------------------------------------------

test("C4 edge: an open run with unmet rules has the not-finished headline and says what is missing in plain words", () => {
  const repo = opened("brief-t9-c4", "halfway");
  const missing = unmetCount(repo);
  assert.ok(missing > 0, "fixture has nothing missing");

  const b = parsed(repo);
  assert.equal(b.headline, `halfway: not finished (${missing} things missing)`);

  // the missing things, in plain words and in their own lines: no checks were run (R3),
  // and nobody has reviewed the change yet (R5)
  assert.match(b.checks, /not run/i, `line 2 does not say the checks have not run: ${JSON.stringify(b.checks)}`);
  assert.match(b.review, /\bno\b/i, `line 3 does not say there was no review yet: ${JSON.stringify(b.review)}`);
  assert.match(b.forYou, /^For you:/, `line 5 does not start with "For you:": ${JSON.stringify(b.forYou)}`);
  assert.match(b.forYou, /missing: /, `line 5 does not list what is missing: ${JSON.stringify(b.forYou)}`);
  assert.ok(!/\bR\d{1,2}\b/.test(b.forYou), `line 5 names a rule id: ${JSON.stringify(b.forYou)}`);
});

// ---------------------------------------------------------------------------
// C5 — everything that needs the user, on one line
// ---------------------------------------------------------------------------

const WAIVER_REASON = "chrome is disconnected on this machine";
const PAUSE_TEXT = "need the production API key from you";

// A run carrying all three of the things line 5 is for: a waiver with its reason, a
// dispute nobody has answered, and a pause.
function attentionRun(name, slug = name) {
  const repo = opened(name, slug);
  cli(repo, "waive", ["driver", WAIVER_REASON]);
  helperFile(repo, "review-1.md", reviewFile(1, slug, [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:renders the badge"]);
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);
  stopHook(repo, `Some progress.\n\nPAUSED: ${PAUSE_TEXT}`);
  return repo;
}

test("C5 happy: a waiver, an unanswered dispute and a pause are all listed on line 5", () => {
  const repo = attentionRun("brief-t9-c5", "flagged");
  const b = parsed(repo);

  assert.match(b.forYou, /^For you:/, `line 5 does not start with "For you:": ${JSON.stringify(b.forYou)}`);
  assert.ok(!/nothing/i.test(b.forYou), `three things need the user, yet line 5 says nothing: ${JSON.stringify(b.forYou)}`);
  assert.ok(
    b.forYou.includes(WAIVER_REASON),
    `line 5 drops the waiver's reason: ${JSON.stringify(b.forYou)}`,
  );
  assert.match(b.forYou, /disput|disagree/i, `line 5 does not mention the open dispute: ${JSON.stringify(b.forYou)}`);
  assert.match(b.forYou, /paus/i, `line 5 does not mention the pause: ${JSON.stringify(b.forYou)}`);
});

// ---------------------------------------------------------------------------
// C6 — the app line
// ---------------------------------------------------------------------------

// src/app/page.tsx is a UI file by the repo's own glob (config.mjs DEFAULTS.ui:
// "**/*.{tsx,vue,svelte}"), so changing it is what makes line 4 say anything at all.
function uiRun(name, slug = name, { drive = true } = {}) {
  const repo = opened(name, slug, { source: "src/app/page.tsx" });
  if (drive) browserEvent(repo); // a Chrome call after the last edit: the surface was driven
  return repo;
}

test("C6 edge: a driven UI change says driven on line 4; an undriven one says not yet driven", () => {
  const driven = parsed(uiRun("brief-t9-c6-driven", "screen-a", { drive: true }));
  assert.match(driven.app, /driven/i, `line 4 does not say the app was driven: ${JSON.stringify(driven.app)}`);
  assert.ok(!/not yet|not driven/i.test(driven.app), `the app was driven, yet: ${JSON.stringify(driven.app)}`);
  assert.ok(!/no screen change/i.test(driven.app), `a .tsx file changed, yet: ${JSON.stringify(driven.app)}`);

  const not = parsed(uiRun("brief-t9-c6-undriven", "screen-b", { drive: false }));
  assert.match(not.app, /not yet driven|not driven/i, `line 4 does not say the app is not yet driven: ${JSON.stringify(not.app)}`);
});

// ---------------------------------------------------------------------------
// C7 — withdrawn and overruled are counted, not dropped
// ---------------------------------------------------------------------------

test("C7 boundary: an arbiter-overruled item and a reviewer-withdrawn item are both counted on line 3", () => {
  const slug = "settled";
  const repo = opened("brief-t9-c7", slug);
  helperFile(repo, "review-1.md", reviewFile(1, slug, [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["dispute", "H1.1", "the list is never empty at this call site", "--evidence", "src/a.ts:1"]);
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);

  // round 2: the reviewer withdraws one of its own findings and holds the other
  helperFile(
    repo,
    "review-2.md",
    reviewFile(2, slug, [], "\n## Disputes\n- H1.1 — withdrawn: you are right, the caller guards it\n- H1.2 — upheld: the card renders before the venue query resolves\n\n"),
  );
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);

  // the arbiter rules for the implementer on the one still standing: overruled
  helperFile(repo, "arbiter-1.md", arbiterFile(1, slug, "H1.2 — implementer: the caller's null check runs first"));
  cli(repo, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);

  const b = parsed(repo);
  assert.match(b.review, /withdrawn/i, `line 3 does not count the withdrawn finding: ${JSON.stringify(b.review)}`);
  assert.match(b.review, /overrul/i, `line 3 does not count the overruled finding: ${JSON.stringify(b.review)}`);
  assert.ok(!/\b0 (items?|findings?)\b/i.test(b.review), `line 3 reports nothing happened: ${JSON.stringify(b.review)}`);
  assert.ok(!/\bopen\b/i.test(b.review) || /\b0\b/.test(b.review), `nothing is still open: ${JSON.stringify(b.review)}`);
});

// ---------------------------------------------------------------------------
// C8 — the full report is untouched
// ---------------------------------------------------------------------------

test("C8 idempotent: --brief still writes the same full report.md that `gate report` writes", () => {
  const repo = closedRun("brief-t9-c8", "whole");
  const file = path.join(runDir(repo), "report.md");

  const full = cli(repo, "report").stdout;
  const written = readFileSync(file, "utf8");
  assert.equal(written, full, "`gate report` and the file it writes disagree");

  rmSync(file, { force: true });
  const short = brief(repo);
  const afterBrief = readFileSync(file, "utf8");

  assert.equal(afterBrief, written, "report.md written by --brief differs from the one `gate report` writes");
  assert.ok(afterBrief.includes("## Steps"), `report.md is not the full report:\n${afterBrief.slice(0, 400)}`);
  assert.ok(afterBrief.length > short.length, "the full report should be longer than the brief");
});
}
