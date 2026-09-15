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
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

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
