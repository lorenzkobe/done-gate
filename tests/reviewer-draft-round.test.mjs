// A reviewer that is cut off mid-write leaves its draft-first placeholder behind. A draft is
// an unfinished round: the same round is re-briefed and re-run, never consumed.
//
// Written from the requirements and the case table, blind to the implementation.
//
// ---------------------------------------------------------------------------
// source-of-truth anchors
//   what a draft looks like        → scripts/lib/guard.mjs's draft-first fence message
//                                    ('every section may read "- unverified"') and the
//                                    file shape in agents/reviewer.md / agents/reviewer-2.md
//                                    (Act on / Consider / Noted / Dismissed / Evidence verdict);
//                                    agents/arbiter.md for the arbiter's "## Ruling"
//   the finished file's shape      → agents/reviewer.md ("## Act on" then "- <finding> — file:line")
//   which files are helper files   → reviewFiles() in scripts/lib/assess.mjs
//                                    (/^(?:review|skeptic|arbiter)-\d+\.md$/)
//   the round cap's wording        → the existing cap refusal names `gate brief arbiter`
//   R5's wording                   → "no reviewer pass after the last edit"
// Never the new implementation's own constants.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { reviewFiles } from "../scripts/lib/assess.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/review-loop.test.mjs)
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
// a refusal is a `done-gate: <message>` line on stderr.
const REFUSAL = /^done-gate: /m;

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}

function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.match(
    r.stderr,
    REFUSAL,
    `expected \`gate ${verb} ${args.join(" ")}\` to be refused, got:\n${r.stdout}${r.stderr}`,
  );
  return r;
}

// `check` exits 0 whether or not rules are unmet; only a crash is a failure here.
function check(repo) {
  const r = run(repo, "check");
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!/GATE ERROR/.test(out), out);
  return r.stdout;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const itemsOf = (ledger) => ledger.huddles.flatMap((h) => h.actOn ?? []);
const reviewerHuddles = (ledger) => ledger.huddles.filter((h) => h.role === "reviewer");
const ruleLine = (out, rule) => lines(out).find((l) => new RegExp(`\\b${rule}\\b`).test(l));

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// A hook payload, fed to `gate log` exactly as Claude Code's hooks feed one.
function hook(repo, payload) {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
}

// An edit made by a shell command: the hook fires for the command, then the bytes land.
function shellWrite(repo, rel, content) {
  hook(repo, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: `cat > ${rel} <<'EOF' ...`, description: "edit a file" },
    tool_output: "...",
  });
  write(repo, rel, content);
}

const helperFile = (repo, name, body) => writeFileSync(path.join(runDir(repo), name), body);

function packet(repo, role, args = []) {
  const r = cli(repo, "brief", [role, ...args]);
  const p = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${r.stdout}`);
  return { path: p, text: readFileSync(p, "utf8"), stdout: r.stdout };
}

// ---------------------------------------------------------------------------
// the two file shapes
// ---------------------------------------------------------------------------

const FIND_1 = "the empty list renders a stray comma — src/a.ts:1 — the join runs on an empty array — []";
const FIND_2 = "null venue crashes the badge — src/a.ts:2 — venue is optional on the card — { venue: null }";
const FIND_3 = "the refused side has no test — tests/a.test.ts:1 — nothing covers the unknown role";

// A finished review file: the shape agents/reviewer.md tells the reviewer to write.
const reviewFile = (n, slug, actOn) =>
  `# Review ${n} — ${slug}\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "_none_"}\n` +
  `## Consider\n- rename the helper\n## Noted\n- the module is small\n## Dismissed\n- none\n` +
  `## Evidence verdict\n- tests: npm test exit 0, 12 passed (ran it myself)\n`;

// The draft-first placeholder: the reviewer's *first* tool call, written before it reads
// anything. scripts/lib/guard.mjs's fence says every section may read "- unverified";
// agents/reviewer-2.md names the five sections. A draft is shape-agnostic: at least one
// bullet, and every bullet reads "unverified".
const draftFile = (n, slug) =>
  `# Review ${n} — ${slug}\n\n## Act on\n- unverified\n## Consider\n- unverified\n` +
  `## Noted\n- unverified\n## Dismissed\n- unverified\n## Evidence verdict\n- unverified\n`;

// The same placeholder written exactly as agents/reviewer.md:14 spells it: "every section
// reading `- unverified` (or `- none` in Dismissed)". This is the file a real cut-off
// reviewer leaves behind, so the ask covers it too.
const documentedDraftFile = (n, slug) =>
  `# Review ${n} — ${slug}\n\n## Act on\n- unverified\n## Consider\n- unverified\n` +
  `## Noted\n- unverified\n## Dismissed\n- none\n## Evidence verdict\n- unverified\n`;

// The arbiter's placeholder: one section, one bullet. Still a draft.
const arbiterDraftFile = (n, slug) => `# Arbiter ${n} — ${slug}\n\n## Ruling\n- unverified\n`;

// An open feature ledger with a real HEAD and one changed source file, and the edit logged
// as an event so the review-freshness rules have an edit to be stale against.
function opened(name, { slug = name } = {}) {
  const repo = committed(name);
  cli(repo, "open", [slug, "feature"]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  cli(repo, "case", ["add", "refuses an unknown role", "--kind", "refused"]);
  shellWrite(repo, "src/a.ts", "export const a = 2;\nexport const venue = null;\n");
  return repo;
}

// Two finished, recorded rounds, then a third round whose reviewer was cut off: only its
// draft placeholder is on disk and no huddle ever recorded it.
function cutOffOnRound3(name) {
  const repo = opened(name);
  for (const [n, find] of [[1, FIND_1], [2, FIND_2]]) {
    helperFile(repo, `review-${n}.md`, reviewFile(n, name, [find]));
    cli(repo, "huddle", ["add", "reviewer", "--file", `review-${n}.md`]);
  }
  helperFile(repo, "review-3.md", draftFile(3, name));

  // premise: three review files on disk, two finished rounds recorded
  assert.deepEqual(
    reviewFiles(runDir(repo)),
    ["review-1.md", "review-2.md", "review-3.md"],
    "premise: three review-<n>.md files are on disk",
  );
  assert.equal(reviewerHuddles(ledgerOf(repo)).length, 2, "premise: only two reviewer rounds are recorded");
  return repo;
}

// ---------------------------------------------------------------------------
// C1 — a draft does not consume the round
// ---------------------------------------------------------------------------

test("C1 happy: with two recorded rounds and a draft review-3.md on disk, gate brief reviewer writes a round-3 packet naming review-3.md instead of the cap message", () => {
  const repo = cutOffOnRound3("rdr-c1");

  const p = packet(repo, "reviewer");
  assert.match(p.path, /brief-reviewer-3\.md$/, `the packet is not round 3: ${p.path}`);
  assert.ok(
    !/gate brief arbiter/.test(p.stdout),
    `the cap message was printed for a round the draft never finished:\n${p.stdout}`,
  );

  // The packet names the same file the cut-off reviewer was meant to write, so a fresh
  // helper rewrites it in place.
  assert.ok(
    /\breview-3\.md\b/.test(p.text),
    `the round-3 packet does not name review-3.md:\n${p.text.slice(0, 2000)}`,
  );
  assert.ok(
    !/\breview-4\.md\b/.test(p.text),
    `the packet names review-4.md, so the draft consumed round 3:\n${p.text.slice(0, 2000)}`,
  );

  // Re-briefing the round records nothing: the ledger still holds two reviewer rounds.
  assert.equal(
    reviewerHuddles(ledgerOf(repo)).length,
    2,
    "briefing round 3 again recorded a reviewer round",
  );

  // Asking for round 3 by name is the same round, not a refusal.
  const explicit = packet(repo, "reviewer", ["--round", "3"]);
  assert.match(explicit.path, /brief-reviewer-3\.md$/, `--round 3 wrote a different packet: ${explicit.path}`);

  // Re-briefing overwrites brief-reviewer-3.md in place: the run dir does not collect a
  // packet per attempt, and no round-4 packet exists.
  assert.deepEqual(
    readdirSync(runDir(repo)).filter((f) => /^brief-reviewer-\d+\.md$/.test(f)).sort(),
    ["brief-reviewer-3.md"],
    "re-briefing the draft round grew the packet count in the run dir",
  );
});

// ---------------------------------------------------------------------------
// C2 — a draft cannot be recorded as a round
// ---------------------------------------------------------------------------

test("C2 refused: gate huddle add reviewer --file review-3.md is refused while review-3.md is a draft, records no huddle and no 'unverified' Act-on item, and the refusal names the file and tells the lead to re-brief", () => {
  const repo = cutOffOnRound3("rdr-c2");
  const before = ledgerOf(repo);

  const r = refused(repo, "huddle", ["add", "reviewer", "--file", "review-3.md"]);
  assert.ok(r.stderr.includes("review-3.md"), `the refusal does not name the draft file: ${r.stderr}`);
  assert.match(
    r.stderr,
    /draft|unverified|unfinished/i,
    `the refusal does not say the file is still a draft: ${r.stderr}`,
  );
  assert.match(
    r.stderr,
    /brief|re-?brief|re-?run/i,
    `the refusal does not tell the lead to re-brief the round: ${r.stderr}`,
  );

  const after = ledgerOf(repo);
  assert.equal(
    reviewerHuddles(after).length,
    2,
    `the draft was recorded as a third reviewer round: ${JSON.stringify(after.huddles.map((h) => h.role))}`,
  );
  assert.deepEqual(
    itemsOf(after).map((i) => i.text),
    itemsOf(before).map((i) => i.text),
    "recording the draft changed the Act-on items",
  );
  assert.ok(
    !itemsOf(after).some((i) => /^unverified$/i.test(String(i.text).trim())),
    `"unverified" was recorded as an Act-on item: ${JSON.stringify(itemsOf(after), null, 2)}`,
  );

  // The file is still on disk and still a draft: nothing was moved or rewritten.
  assert.equal(
    readFileSync(path.join(runDir(repo), "review-3.md"), "utf8"),
    draftFile(3, "rdr-c2"),
    "the refused add rewrote the draft file",
  );

  // The placeholder a real cut-off reviewer leaves behind: agents/reviewer.md:14 tells it to
  // write "every section reading `- unverified` (or `- none` in Dismissed)". That file is the
  // one the ask names, so it must be refused too.
  helperFile(repo, "review-3.md", documentedDraftFile(3, "rdr-c2"));
  const documented = refused(repo, "huddle", ["add", "reviewer", "--file", "review-3.md"]);
  assert.ok(
    documented.stderr.includes("review-3.md"),
    `the placeholder agents/reviewer.md:14 describes ("- none" in Dismissed) was recorded as a round: ${documented.stdout}`,
  );
  assert.equal(
    reviewerHuddles(ledgerOf(repo)).length,
    2,
    "the documented placeholder was recorded as a third reviewer round",
  );
});

// ---------------------------------------------------------------------------
// C3 — an unrecorded draft is not an unrecorded review
// ---------------------------------------------------------------------------

test("C3 edge: gate check does not report an unrecorded draft review file as written but never recorded, while R5 still asks for a reviewer pass; a finished unrecorded file still raises R15", () => {
  const repo = opened("rdr-c3");
  helperFile(repo, "review-1.md", draftFile(1, "rdr-c3"));

  const out = check(repo);
  const r15 = ruleLine(out, "R15");
  assert.ok(
    !r15 || !r15.includes("review-1.md"),
    `an unrecorded draft is reported as a written-but-unrecorded review: ${r15}`,
  );

  // The round never happened, so the review rule still blocks.
  assert.ok(
    ruleLine(out, "R5"),
    `R5 does not ask for a reviewer pass while the only review file is a draft:\n${out}`,
  );

  // Not vacuous: a finished file that no huddle recorded is still R15's business.
  helperFile(repo, "review-2.md", reviewFile(2, "rdr-c3", [FIND_1]));
  const withFinished = ruleLine(check(repo), "R15");
  assert.ok(withFinished, `an unrecorded finished review-2.md does not raise R15:\n${check(repo)}`);
  assert.ok(
    withFinished.includes("review-2.md"),
    `the R15 line does not name the unrecorded finished file: ${withFinished}`,
  );
  assert.ok(
    !withFinished.includes("review-1.md"),
    `the R15 line still names the draft review-1.md: ${withFinished}`,
  );
});

// ---------------------------------------------------------------------------
// C4 — three finished rounds still cap
// ---------------------------------------------------------------------------

test("C4 boundary: three finished review files and three recorded rounds still refuse a fourth reviewer round, by name and naturally, and the refusal names gate brief arbiter", () => {
  const repo = opened("rdr-c4");
  for (const [n, find] of [[1, FIND_1], [2, FIND_2], [3, FIND_3]]) {
    helperFile(repo, `review-${n}.md`, reviewFile(n, "rdr-c4", [find]));
    cli(repo, "huddle", ["add", "reviewer", "--file", `review-${n}.md`]);
  }
  assert.equal(reviewerHuddles(ledgerOf(repo)).length, 3, "premise: three reviewer rounds are recorded");
  assert.deepEqual(
    reviewFiles(runDir(repo)),
    ["review-1.md", "review-2.md", "review-3.md"],
    "premise: three finished review files are on disk",
  );

  const natural = refused(repo, "brief", ["reviewer"]);
  assert.ok(
    natural.stderr.includes("gate brief arbiter"),
    `the fourth round's refusal does not point at the arbiter: ${natural.stderr}`,
  );
  assert.ok(!natural.stdout.includes("packet: "), `a fourth reviewer packet was written:\n${natural.stdout}`);

  const explicit = refused(repo, "brief", ["reviewer", "--round", "4"]);
  assert.ok(
    explicit.stderr.includes("gate brief arbiter"),
    `--round 4's refusal does not point at the arbiter: ${explicit.stderr}`,
  );
  assert.ok(!explicit.stdout.includes("packet: "), `--round 4 wrote a packet anyway:\n${explicit.stdout}`);

  assert.ok(
    !readdirSync(runDir(repo)).includes("brief-reviewer-4.md"),
    `a round-4 reviewer packet file was left in the run dir: ${readdirSync(runDir(repo)).join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// C5 — "none" is a finished answer, not a draft
// ---------------------------------------------------------------------------

test("C5 idempotent: a finished review whose Act-on section reads none is not a draft — gate huddle add records the round with zero Act-on items and no R15", () => {
  for (const [n, body] of [
    ["underscores", reviewFile(1, "rdr-c5", [])], // "_none_"
    ["bullet", `# Review 1 — rdr-c5\n\n## Act on\n- none\n## Consider\n- rename the helper\n`],
  ]) {
    const repo = opened(`rdr-c5-${n}`);
    helperFile(repo, "review-1.md", body);

    cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

    const ledger = ledgerOf(repo);
    assert.equal(
      reviewerHuddles(ledger).length,
      1,
      `a "none" review was not recorded as a round (${n}): ${JSON.stringify(ledger.huddles)}`,
    );
    assert.deepEqual(
      itemsOf(ledger),
      [],
      `a "none" review recorded Act-on items (${n}): ${JSON.stringify(itemsOf(ledger), null, 2)}`,
    );
    assert.ok(
      !ruleLine(check(repo), "R15"),
      `R15 fires for a recorded "none" review (${n}):\n${check(repo)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// C6 — a partly rewritten file is a finished round
// ---------------------------------------------------------------------------

test("C6 edge: a review whose Act-on section holds a real bullet is not a draft even while Consider, Noted and Evidence verdict still read unverified — the round is recorded with that finding and no R15", () => {
  const repo = opened("rdr-c6");
  const partly =
    `# Review 1 — rdr-c6\n\n## Act on\n- ${FIND_1}\n## Consider\n- unverified\n` +
    `## Noted\n- unverified\n## Dismissed\n- none\n## Evidence verdict\n- unverified\n`;
  helperFile(repo, "review-1.md", partly);

  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  const ledger = ledgerOf(repo);
  assert.equal(
    reviewerHuddles(ledger).length,
    1,
    `a partly rewritten review was refused as a draft: ${JSON.stringify(ledger.huddles)}`,
  );
  assert.deepEqual(
    itemsOf(ledger).map((i) => i.text),
    [FIND_1],
    `the real Act-on bullet was not recorded: ${JSON.stringify(itemsOf(ledger), null, 2)}`,
  );
  assert.ok(!ruleLine(check(repo), "R15"), `R15 fires after the round was recorded:\n${check(repo)}`);

  // The round is consumed: the next reviewer brief is round 2, not round 1 again.
  const p = packet(repo, "reviewer");
  assert.match(p.path, /brief-reviewer-2\.md$/, `the recorded round was re-briefed as round 1: ${p.path}`);
});

// ---------------------------------------------------------------------------
// C7 — a draft is shape-agnostic: any helper file, any sections
// ---------------------------------------------------------------------------

test("C7 edge: an unrecorded arbiter-1.md whose only section is '## Ruling' reading '- unverified' is a draft, so gate check does not report it under R15; a real ruling in the same file does", () => {
  const repo = opened("rdr-c7");
  helperFile(repo, "arbiter-1.md", arbiterDraftFile(1, "rdr-c7"));
  assert.ok(
    reviewFiles(runDir(repo)).includes("arbiter-1.md"),
    "premise: arbiter-1.md is one of the helper files R15 looks at",
  );

  const draftLine = ruleLine(check(repo), "R15");
  assert.ok(
    !draftLine || !draftLine.includes("arbiter-1.md"),
    `an unrecorded arbiter draft is reported as written but never recorded: ${draftLine}`,
  );

  // Not vacuous: once the arbiter has actually ruled, the same unrecorded file is R15's business.
  helperFile(
    repo,
    "arbiter-1.md",
    `# Arbiter 1 — rdr-c7\n\n## Ruling\n- H1.2 — reviewer: the card renders before the venue query resolves\n`,
  );
  const ruledLine = ruleLine(check(repo), "R15");
  assert.ok(ruledLine, `an unrecorded finished arbiter-1.md does not raise R15:\n${check(repo)}`);
  assert.ok(
    ruledLine.includes("arbiter-1.md"),
    `the R15 line does not name the unrecorded ruling: ${ruledLine}`,
  );

  // A skeptic stub is a draft by the same predicate, whatever its sections are called.
  const other = opened("rdr-c7-skeptic");
  helperFile(other, "skeptic-1.md", "# Skeptic 1 — rdr-c7-skeptic\n\n## Attack\n- unverified\n");
  const skepticLine = ruleLine(check(other), "R15");
  assert.ok(
    !skepticLine || !skepticLine.includes("skeptic-1.md"),
    `an unrecorded skeptic draft is reported as written but never recorded: ${skepticLine}`,
  );
});
