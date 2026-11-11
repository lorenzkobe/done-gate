import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, doneArgs, lookedUp, planChecked, redRun, userSays, capRounds } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { pointerResolver } from "../scripts/lib/rules.mjs";
import { reviewFiles } from "../scripts/lib/assess.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { nextHint } from "../scripts/lib/next.mjs";
import { readsOnly } from "../scripts/lib/guard.mjs";

// ===== from tests/review-dispute.test.mjs =====
{
// Task 9 — review completeness (R15) and the dispute round (the arbiter went in 6.8).
// Written from the requirements, blind to the implementation.

// ---------------------------------------------------------------------------
// conventions (mirrors tests/skeptic-file.test.mjs and tests/tier-policy.test.mjs)
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
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}

// scripts/gate.mjs always sets `process.exitCode = 0`, so the exit status says nothing:
// a refusal is a `done-gate: <message>` line on stderr.
const REFUSAL = /^done-gate: /m;

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
// Every Act-on item the ledger holds, in the order the huddles recorded them.
const itemsOf = (ledger) => ledger.huddles.flatMap((h) => h.actOn ?? []);
const itemById = (ledger, id) => itemsOf(ledger).find((i) => i.id === id);
const ruleLine = (out, rule) => lines(out).find((l) => new RegExp(`\\b${rule}\\b`).test(l));

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// A hook payload, fed to `gate log` exactly as Claude Code's hooks feed one
// (tests/tier-policy.test.mjs owns this shape).
function hook(repo, payload) {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
}

const commandEvent = (repo, command) =>
  hook(repo, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "edit a file" },
    tool_output: "...",
  });

const reviewerStop = (repo) =>
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "A9", agent_type: "done-gate:reviewer", stop_hook_active: false });

// An edit made by a shell command: the hook fires for the command, then the bytes land.
function shellWrite(repo, rel, content) {
  commandEvent(repo, `cat > ${rel} <<'EOF' ...`);
  write(repo, rel, content);
}

const helperFile = (repo, name, body) => writeFileSync(path.join(runDir(repo), name), body);

// A PreToolUse payload, exactly the shape tests/guard.test.mjs feeds `gate fence`.
function fenceOut(repo, payload) {
  const r = spawnSync(process.execPath, [gate, "fence"], {
    input: JSON.stringify({ cwd: repo, session_id: "S1", hook_event_name: "PreToolUse", ...payload }),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const denied = (repo, payload) => {
  const out = fenceOut(repo, payload);
  return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
};
const writePayload = (file_path, who = {}) => ({ tool_name: "Write", tool_input: { file_path }, ...who });

// `## <heading>` section text, up to the next `## ` line.
function section(md, heading) {
  const all = md.split("\n");
  const start = all.findIndex((l) => l.trim() === `## ${heading}`);
  assert.ok(start >= 0, `packet has no "## ${heading}" section:\n${md.slice(0, 2000)}`);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function packet(repo, role, args = []) {
  const r = cli(repo, "brief", [role, ...args]);
  const p = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${r.stdout}`);
  return { path: p, text: readFileSync(p, "utf8") };
}

// ---------------------------------------------------------------------------
// source-of-truth anchors
//   the file shape helpers write   → agents/reviewer.md and agents/skeptic.md
//                                    ("## Act on" then "- <finding> — file:line")
//   agent roles + their models     → models.json
//   the ceiling line's wording     → scripts/lib/size.mjs's tier block (not touched here)
// Never the new implementation's own constants.
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(pluginRoot, "agents");
const SKILL_MD = path.join(pluginRoot, "skills", "gate", "SKILL.md");
const README = path.join(pluginRoot, "README.md");
const modelsJson = () => JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));

const FIND_1 = "the empty list renders a stray comma — src/a.ts:1 — the join runs on an empty array — []";
const FIND_2 = "null venue crashes the badge — src/a.ts:2 — venue is optional on the card — { venue: null }";
const FIND_3 = "the refused side has no test — tests/a.test.ts:1 — nothing covers the unknown role";
const WHY = "the caller already null-checks venue before it renders the card";
const EVIDENCE = "src/a.ts:2";
const UPHELD_REASON = "the card renders before the venue query resolves, so the caller's check cannot help";

const reviewFile = (n, slug, actOn, extra = "") =>
  `# Review ${n} — ${slug}\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "_none_"}\n${extra}## Consider\n- rename the helper\n`;

const arbiterFile = (n, slug, ruling) => `# Arbiter ${n} — ${slug}\n\n## Ruling\n- ${ruling}\n`;

// An open feature ledger with a real HEAD and one changed source file, so a
// packet has a diff to quote.
function opened(name, { slug = name } = {}) {
  const repo = committed(name);
  cli(repo, "open", [slug, "feature"]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  cli(repo, "case", ["add", "refuses an unknown role", "--kind", "refused"]);
  write(repo, "src/a.ts", "export const a = 2;\nexport const venue = null;\n");
  return repo;
}

// an older run's arbiter ruling, as huddle add arbiter wrote it before 6.8
const oldRuling = (repo, id, side) => {
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  const a = ledger.huddles.flatMap((h) => h.actOn).find((x) => x.id === id);
  a.dispute.verdict = `arbiter:${side}`;
  a.dispute.arbiterReason = side === "implementer" ? "the caller's null check runs first" : "the second caller passes null straight through";
  if (side === "implementer") a.closed = "overruled (arbiter-1.md)";
  writeFileSync(file, JSON.stringify(ledger, null, 2));
};

// opened() + review-1.md (two findings), H1.2 disputed with evidence, and review-2.md
// upholding the dispute: the state that goes to the user.
function upheld(name, { findings = [FIND_1, FIND_2] } = {}) {
  const repo = opened(name);
  helperFile(repo, "review-1.md", reviewFile(1, name, findings));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  // H1.1 is fixed the ordinary way, so H1.2 is the only thing R5 can still be waiting on
  redRun(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:empty list"]);
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);
  helperFile(repo, "review-2.md", reviewFile(2, name, [], `\n## Disputes\n- H1.2 — upheld: ${UPHELD_REASON}\n\n`));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1 — the three parsers read their own section and nothing else
// ---------------------------------------------------------------------------

test("C1 happy: parseFindings returns one entry per Act-on bullet and none for 'none' or a missing section; parseDisputes reads its section with ids and verdicts", async () => {
  const { parseFindings, parseDisputes } = await import("../scripts/lib/rules.mjs");

  // The file shape agents/reviewer.md tells the reviewer to write.
  const body = [
    "# Review 1 — badge",
    "",
    "## Act on",
    `- ${FIND_1}`,
    `- ${FIND_2}`,
    "## Consider",
    "- a finding under Consider is not an Act-on item",
    "## Noted",
    "- neither is this",
    "",
  ].join("\n");
  assert.deepEqual(parseFindings(body), [{ text: FIND_1 }, { text: FIND_2 }]);

  // "none" is a valid answer in both spellings agents use, and so is no section at all.
  assert.deepEqual(parseFindings("# Review 2 — badge\n\n## Act on\n_none_\n\n## Consider\n- x\n"), []);
  assert.deepEqual(parseFindings("# Review 2 — badge\n\n## Act on\n- none\n"), []);
  assert.deepEqual(parseFindings("# Review 2 — badge\n\n## Consider\n- x\n"), []);

  const disputes = [
    "# Review 2 — badge",
    "",
    "## Act on",
    "_none_",
    "",
    "## Disputes",
    "- H1.2 — withdrawn: you are right, the caller checks it",
    `- H1.3 — upheld: ${UPHELD_REASON}`,
    "",
    "## Consider",
    "- not a dispute",
    "",
  ].join("\n");
  assert.deepEqual(parseDisputes(disputes), [
    { id: "H1.2", verdict: "withdrawn", reason: "you are right, the caller checks it" },
    { id: "H1.3", verdict: "upheld", reason: UPHELD_REASON },
  ]);
  assert.deepEqual(parseDisputes("# Review 1 — badge\n\n## Act on\n- x\n"), []);

});

// ---------------------------------------------------------------------------
// C2 — `huddle add --file` records every Act-on bullet, once
// ---------------------------------------------------------------------------

test("C2 happy: gate huddle add reviewer --file review-1.md with three Act-on bullets creates H1.1, H1.2, H1.3 with the bullet text; a second add of the same file adds nothing", () => {
  const repo = opened("rd-c2");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c2", [FIND_1, FIND_2, FIND_3]));

  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const first = itemsOf(ledgerOf(repo));
  assert.deepEqual(
    first.map((i) => i.id),
    ["H1.1", "H1.2", "H1.3"],
    `the three Act-on bullets were not recorded as items: ${JSON.stringify(first, null, 2)}`,
  );
  assert.deepEqual(first.map((i) => i.text), [FIND_1, FIND_2, FIND_3]);
  assert.deepEqual(first.map((i) => i.closed), [null, null, null], "an imported finding starts open");

  // The bullet under `## Consider` is not a finding.
  assert.ok(
    !itemsOf(ledgerOf(repo)).some((i) => /rename the helper/.test(i.text)),
    "a Consider bullet was imported as an Act-on item",
  );

  // Importing the same file again must not duplicate anything.
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const again = itemsOf(ledgerOf(repo));
  assert.equal(again.length, 3, `a second add of review-1.md duplicated items: ${JSON.stringify(again.map((i) => i.text))}`);
  assert.deepEqual(again.map((i) => i.text), [FIND_1, FIND_2, FIND_3]);
});

// ---------------------------------------------------------------------------
// C3 — R15: the file lists more than the ledger holds
// ---------------------------------------------------------------------------

test("C3 refused: R15 fires when a helper file lists more Act-on bullets than the huddle records and names the file and both counts; it clears after gate huddle add again", () => {
  const repo = opened("rd-c3");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c3", [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.ok(!ruleLine(check(repo), "R15"), `R15 fired while the ledger matched the file:\n${check(repo)}`);

  // A third finding appended to the file after the import: the ledger now holds fewer.
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c3", [FIND_1, FIND_2, FIND_3]));
  const line = ruleLine(check(repo), "R15");
  assert.ok(line, `R15 did not fire on a file with 3 bullets against 2 recorded items:\n${check(repo)}`);
  assert.ok(line.includes("review-1.md"), `the R15 line does not name the file: ${line}`);
  assert.match(line, /\b3\b/, `the R15 line does not carry the file's count of 3: ${line}`);
  assert.match(line, /\b2\b/, `the R15 line does not carry the ledger's count of 2: ${line}`);

  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.equal(itemsOf(ledgerOf(repo)).length, 3, "the re-add did not pick up the appended bullet");
  assert.ok(!ruleLine(check(repo), "R15"), `R15 still fires after the missing bullet was recorded:\n${check(repo)}`);
});

// ---------------------------------------------------------------------------
// C4 — dispute needs evidence, and only once, and only on an open item
// ---------------------------------------------------------------------------

test("C4 refused: gate huddle dispute H1.2 without --evidence is refused; with evidence it marks the item disputed and open; a second dispute on the same item, or a dispute on a closed item, is refused", () => {
  const repo = opened("rd-c4");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c4", [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  // no id at all → usage
  const bare = refused(repo, "huddle", ["dispute"]);
  assert.match(bare.stderr, /usage/i, `no usage line for a bare dispute: ${bare.stderr}`);

  // an id and a why, but no evidence → refused, and nothing recorded
  const noEvidence = refused(repo, "huddle", ["dispute", "H1.2", WHY]);
  assert.match(noEvidence.stderr, /evidence/i, `the refusal does not mention evidence: ${noEvidence.stderr}`);
  assert.equal(itemById(ledgerOf(repo), "H1.2").dispute ?? null, null, "a dispute was recorded without evidence");

  // with evidence: recorded, and the item stays open
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);
  const item = itemById(ledgerOf(repo), "H1.2");
  assert.ok(item.dispute, `H1.2 carries no dispute: ${JSON.stringify(item, null, 2)}`);
  assert.equal(item.closed, null, "disputing a finding must not close it");
  const recorded = JSON.stringify(item.dispute);
  assert.ok(recorded.includes(WHY), `the dispute does not carry the why: ${recorded}`);
  assert.ok(recorded.includes(EVIDENCE), `the dispute does not carry the evidence pointer: ${recorded}`);

  // one round only
  refused(repo, "huddle", ["dispute", "H1.2", "and another thing", "--evidence", "src/a.ts:1"]);
  assert.ok(
    JSON.stringify(itemById(ledgerOf(repo), "H1.2").dispute).includes(WHY),
    "the second dispute overwrote the first",
  );

  // a closed finding cannot be disputed
  redRun(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:empty list"]);
  assert.ok(itemById(ledgerOf(repo), "H1.1").closed, "premise: H1.1 is closed");
  refused(repo, "huddle", ["dispute", "H1.1", "too late", "--evidence", "src/a.ts:1"]);
  assert.equal(itemById(ledgerOf(repo), "H1.1").dispute ?? null, null, "a closed finding carries a dispute");
});

// ---------------------------------------------------------------------------
// C5 — the reviewer answers in its next file
// ---------------------------------------------------------------------------

test("C5 happy: a reviewer file with ## Disputes closes a withdrawn item as withdrawn and leaves an upheld item open with verdict upheld and the reviewer's reason", () => {
  const repo = opened("rd-c5");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c5", [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["dispute", "H1.1", "the list is never empty at this call site", "--evidence", "src/a.ts:1"]);
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);

  helperFile(
    repo,
    "review-2.md",
    reviewFile(2, "rd-c5", [], `\n## Disputes\n- H1.1 — withdrawn: you are right, the caller guards it\n- H1.2 — upheld: ${UPHELD_REASON}\n\n`),
  );
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);

  const withdrawn = itemById(ledgerOf(repo), "H1.1");
  assert.ok(withdrawn.closed, `a withdrawn finding stayed open: ${JSON.stringify(withdrawn, null, 2)}`);
  assert.match(String(withdrawn.closed), /withdrawn/i, `the close reason does not say withdrawn: ${withdrawn.closed}`);
  assert.ok(
    String(withdrawn.closed).includes("review-2.md"),
    `the close reason does not name the file that withdrew it: ${withdrawn.closed}`,
  );

  const still = itemById(ledgerOf(repo), "H1.2");
  assert.equal(still.closed, null, "an upheld finding must stay open");
  assert.equal(still.dispute.verdict, "upheld");
  assert.ok(
    JSON.stringify(still.dispute).includes(UPHELD_REASON),
    `the reviewer's upheld reason was not recorded: ${JSON.stringify(still.dispute)}`,
  );
});

// ---------------------------------------------------------------------------
// C10 — the policy names no model
// ---------------------------------------------------------------------------

test("C10 happy: models.json names no model and no ceiling; the tier block prints none", () => {
  const m = modelsJson();
  assert.ok(!("roles" in m), `models.json still names models: ${JSON.stringify(m.roles)}`);
  assert.ok(!("ceiling" in m.policy), `models.json ceiling: ${JSON.stringify(m.policy.ceiling)}`);

  const repo = opened("rd-c10");
  const out = cli(repo, "size").stdout;
  assert.doesNotMatch(out, /ceiling/, `\`gate size\` still prints a ceiling:\n${out}`);
});

// ---------------------------------------------------------------------------
// C11 — the prose that ships with it
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C12 — the design huddle is covered too
// ---------------------------------------------------------------------------

test("C12 edge: a skeptic file's Act-on bullets are imported too, so R15 covers the design huddle", () => {
  const repo = opened("rd-c12");
  const A = "the plan hides a second write path — src/a.ts:1";
  const B = "the refused side has no case — tests/a.test.ts:1";
  const C = "the helper already exists — src/app/page.tsx:1";
  helperFile(repo, "skeptic-1.md", `# Skeptic 1 — rd-c12\n\n## Act on\n- ${A}\n- ${B}\n## Consider\n- rename it\n`);

  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  const items = itemsOf(ledgerOf(repo));
  assert.deepEqual(items.map((i) => i.id), ["H1.1", "H1.2"]);
  assert.deepEqual(items.map((i) => i.text), [A, B]);
  assert.equal(ledgerOf(repo).huddles[0].role, "skeptic");
  assert.doesNotMatch(check(repo), /R15 — skeptic-1\.md lists/, `R15 fired while the skeptic file matched the ledger:\n${check(repo)}`);

  helperFile(repo, "skeptic-1.md", `# Skeptic 1 — rd-c12\n\n## Act on\n- ${A}\n- ${B}\n- ${C}\n## Consider\n- rename it\n`);
  const line = ruleLine(check(repo), "R15");
  assert.ok(line, `R15 does not cover the skeptic huddle:\n${check(repo)}`);
  assert.ok(line.includes("skeptic-1.md"), `the R15 line does not name the skeptic file: ${line}`);
});

// ---------------------------------------------------------------------------
// C13 — an overruled finding is not an open finding, and the round is capped
// ---------------------------------------------------------------------------

test("C13 refused: an older run's overruled item does not count as open for R5, and the dispute round is capped: no dispute on an item the arbiter ruled on", () => {
  const repo = upheld("rd-c13");
  // a source edit and a reviewer pass after it, so the only thing R5 can still object to
  // is the open finding
  shellWrite(repo, "src/a.ts", "export const a = 3;\nexport const venue = null;\n");
  reviewerStop(repo);
  assert.ok(ruleLine(check(repo), "R5"), `premise: R5 blocks while H1.2 is open:\n${check(repo)}`);

  oldRuling(repo, "H1.2", "implementer");
  assert.ok(
    !ruleLine(check(repo), "R5"),
    `an overruled finding still counts as open for R5:\n${check(repo)}`,
  );

  // ruled on → no second dispute, whichever way it went
  refused(repo, "huddle", ["dispute", "H1.2", "I still disagree", "--evidence", "src/a.ts:1"]);
  assert.equal(itemById(ledgerOf(repo), "H1.2").dispute.verdict, "arbiter:implementer", "the re-dispute changed the verdict");

  // the same when the arbiter ruled for the reviewer and the finding is still open
  const forReviewer = upheld("rd-c13-reviewer");
  oldRuling(forReviewer, "H1.2", "reviewer");
  assert.equal(itemById(ledgerOf(forReviewer), "H1.2").closed, null, "premise: the finding is still open");
  refused(forReviewer, "huddle", ["dispute", "H1.2", "one more round", "--evidence", "src/a.ts:1"]);
  assert.equal(
    itemById(ledgerOf(forReviewer), "H1.2").dispute.verdict,
    "arbiter:reviewer",
    "the re-dispute changed the verdict",
  );
});

// ---------------------------------------------------------------------------
// C14 — two bullets that read the same are two findings
// ---------------------------------------------------------------------------

test("C14 boundary: two identical Act-on bullets are recorded as two items and raise no R15, and an acton with the same text neither adds a third nor makes a re-add do so", () => {
  const repo = opened("rd-c14");
  const DUP = "the join runs on an empty array — src/a.ts:1";
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c14", [DUP, DUP]));

  // Skipping "a bullet already recorded" must not collapse the file's own repeat.
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const imported = itemsOf(ledgerOf(repo));
  assert.deepEqual(imported.map((i) => i.id), ["H1.1", "H1.2"], `two identical bullets did not become two items: ${JSON.stringify(imported, null, 2)}`);
  assert.deepEqual(imported.map((i) => i.text), [DUP, DUP]);
  assert.ok(
    !ruleLine(check(repo), "R15"),
    `R15 fires on a file whose two bullets read the same, though both were recorded:\n${check(repo)}`,
  );

  // An acton with text the ledger already holds points at the item that holds it.
  const acton = cli(repo, "huddle", ["acton", "H1", DUP]);
  assert.match(acton.stdout, /H1\.[12]\b/, `acton did not name the existing item: ${acton.stdout}`);
  assert.equal(itemsOf(ledgerOf(repo)).length, 2, "an acton with already-recorded text added a third item");

  // and the file can still be re-read without growing the list
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const after = itemsOf(ledgerOf(repo));
  assert.equal(after.length, 2, `re-reading the file grew the list: ${JSON.stringify(after.map((i) => i.text))}`);
  assert.deepEqual(after.map((i) => i.text), [DUP, DUP]);
  assert.ok(!ruleLine(check(repo), "R15"), `R15 fires after the re-add:\n${check(repo)}`);
});

// ---------------------------------------------------------------------------
// C15 — a file-writing helper's huddle needs its file
// ---------------------------------------------------------------------------

test("C15 refused: gate huddle add reviewer and skeptic without --file are refused by name and record no huddle, while gate huddle add qa --summary still works", () => {
  const repo = opened("rd-c15");
  assert.deepEqual(ledgerOf(repo).huddles, [], "premise: no huddle yet");

  for (const role of ["reviewer", "skeptic"]) {
    const r = refused(repo, "huddle", ["add", role]);
    assert.match(r.stderr, /--file/, `the ${role} refusal does not name --file: ${r.stderr}`);
    assert.deepEqual(
      ledgerOf(repo).huddles,
      [],
      `gate huddle add ${role} with no --file recorded a huddle: ${JSON.stringify(ledgerOf(repo).huddles)}`,
    );
  }

  // qa does not write a file of its own, so it needs no --file.
  cli(repo, "huddle", ["add", "qa", "--summary", "x"]);
  const huddles = ledgerOf(repo).huddles;
  assert.equal(huddles.length, 1, `gate huddle add qa --summary did not record a huddle: ${JSON.stringify(huddles)}`);
  assert.equal(huddles[0].role, "qa");
});

// ---------------------------------------------------------------------------
// C16 — a helper file on disk that no huddle ever recorded
// ---------------------------------------------------------------------------

test("C16 refused: a review-2.md written into the run dir but never recorded makes gate check print R15 naming review-2.md; recording it clears", () => {
  const repo = opened("rd-c16");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c16", [FIND_1]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.ok(!ruleLine(check(repo), "R15"), `R15 fires while every file on disk is recorded:\n${check(repo)}`);

  // A second round the model forgot to record at all.
  helperFile(repo, "review-2.md", reviewFile(2, "rd-c16", [FIND_2]));
  const line = ruleLine(check(repo), "R15");
  assert.ok(line, `an unrecorded review-2.md does not raise R15:\n${check(repo)}`);
  assert.ok(line.includes("review-2.md"), `the R15 line does not name the unrecorded file: ${line}`);

  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  assert.ok(!ruleLine(check(repo), "R15"), `R15 still fires after review-2.md was recorded:\n${check(repo)}`);
  assert.ok(
    itemsOf(ledgerOf(repo)).some((i) => i.text === FIND_2),
    "recording review-2.md did not import its finding",
  );
});

// ---------------------------------------------------------------------------
// C17 — a role's huddle takes that role's own file
// ---------------------------------------------------------------------------

test("C17 refused: gate huddle add reviewer --file skeptic-1.md is refused and names the review- prefix; gate huddle add skeptic --file review-1.md likewise names skeptic-", () => {
  const repo = opened("rd-c17");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c17", [FIND_1]));
  helperFile(repo, "skeptic-1.md", `# Skeptic 1 — rd-c17\n\n## Act on\n- the plan hides a second write path — src/a.ts:1\n`);

  const asReviewer = refused(repo, "huddle", ["add", "reviewer", "--file", "skeptic-1.md"]);
  assert.match(asReviewer.stderr, /review-/, `the refusal does not name the reviewer's own prefix: ${asReviewer.stderr}`);

  const asSkeptic = refused(repo, "huddle", ["add", "skeptic", "--file", "review-1.md"]);
  assert.match(asSkeptic.stderr, /skeptic-/, `the refusal does not name the skeptic's own prefix: ${asSkeptic.stderr}`);

  assert.deepEqual(ledgerOf(repo).huddles, [], "a mismatched file still recorded a huddle");

  // the matching pairs still work
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  assert.deepEqual(ledgerOf(repo).huddles.map((h) => h.role), ["reviewer", "skeptic"]);
});

// ---------------------------------------------------------------------------
// C18 — resolving a finding needs a pointer that resolves
// ---------------------------------------------------------------------------

test("C18 refused: gate huddle resolve H1.1 --evidence nope-nothing is refused and the item stays open; --evidence verify.json after a green verify closes it", () => {
  const repo = opened("rd-c18");
  // a skeptic item: a reviewer finding closes on a run instead (6.6 P1)
  helperFile(repo, "skeptic-1.md", `# Skeptic 1 — rd-c18\n\n## Act on\n- ${FIND_1}\n`);
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);

  const bad = refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "nope-nothing"]);
  assert.match(bad.stderr, /nope-nothing|evidence|pointer/i, `the refusal does not name the pointer: ${bad.stderr}`);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, null, "an unresolvable pointer closed the finding");

  // verify.json only resolves once a verify has actually run
  assert.ok(!existsSync(path.join(runDir(repo), "verify.json")), "premise: no verify has run yet");
  refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "verify.json"]);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, null, "verify.json resolved before any verify ran");

  cli(repo, "verify");
  assert.ok(existsSync(path.join(runDir(repo), "verify.json")), "premise: the verify wrote its file");
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "verify.json"]);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, "verify.json");
});

// ---------------------------------------------------------------------------
// C19 — nobody edits a helper's file behind its back, not even the main session
// ---------------------------------------------------------------------------

test("C19 refused: a Bash command from the main session that writes a recorded review file is denied, while reading it is not", () => {
  const repo = opened("rd-c19");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c19", [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  // the path as a shell command would spell it, from the repo root
  const rel = path.relative(repo, path.join(runDir(repo), "review-1.md"));
  const bash = (command) => denied(repo, { tool_name: "Bash", tool_input: { command } });

  // No agent_type at all: this is the main session, the one that owns the diff.
  assert.equal(bash(`sed -i '' '/^- /d' ${rel}`), true, `the main session was allowed to strip findings: sed -i '' '/^- /d' ${rel}`);
  assert.equal(bash(`echo x >> ${rel}`), true, `the main session was allowed to append to the review file: echo x >> ${rel}`);
  assert.equal(bash(`cat ${rel}`), false, `a read-only command naming the review file was denied: cat ${rel}`);

  // The rule is about the path, not the verb: an unrelated command is untouched.
  assert.equal(bash("grep -rn foo src"), false, "a command that names no helper file was denied");

  // Reading it with the Read tool is how the implementer is meant to read it.
  assert.equal(
    denied(repo, { tool_name: "Read", tool_input: { file_path: path.join(runDir(repo), "review-1.md") } }),
    false,
    "the Read tool was fenced away from the review file",
  );
});

// ---------------------------------------------------------------------------
// C20 — R15 counts what came from the file, not what was typed in beside it
// ---------------------------------------------------------------------------

test("C20 refused: hand-typed acton items do not pay for a bullet the file lists, so R15 still fires until the file is re-read", () => {
  const repo = opened("rd-c20");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c20", [FIND_1, FIND_2, FIND_3]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.equal(itemsOf(ledgerOf(repo)).length, 3, "premise: the three bullets were imported");

  // three items the model typed in itself, none of which is the file's fourth bullet
  for (const n of [1, 2, 3]) cli(repo, "huddle", ["acton", "H1", `placeholder ${n}`]);
  assert.equal(itemsOf(ledgerOf(repo)).length, 6, "premise: the ledger now holds six items");
  assert.ok(!ruleLine(check(repo), "R15"), `R15 fires while the file's three bullets are all recorded:\n${check(repo)}`);

  const FOURTH = "the retry path double-submits — src/a.ts:2 — a second click before the first resolves";
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c20", [FIND_1, FIND_2, FIND_3, FOURTH]));
  const line = ruleLine(check(repo), "R15");
  assert.ok(line, `six ledger items paid for the file's fourth bullet:\n${check(repo)}`);
  assert.ok(line.includes("review-1.md"), `the R15 line does not name the file: ${line}`);

  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.ok(
    itemsOf(ledgerOf(repo)).some((i) => i.text === FOURTH),
    "the re-add did not import the fourth bullet",
  );
  assert.ok(!ruleLine(check(repo), "R15"), `R15 still fires after the fourth bullet was recorded:\n${check(repo)}`);
});

// ---------------------------------------------------------------------------
// C21 — a decisions#n pointer resolves only to a row that exists
// ---------------------------------------------------------------------------

test("C21 refused: gate huddle resolve --evidence decisions#9999 is refused and the item stays open; after one decide row decisions#1 closes it and decisions#2 is refused", () => {
  const repo = opened("rd-c21");
  // a skeptic item: a reviewer finding closes on a run instead (6.6 P1)
  helperFile(repo, "skeptic-1.md", `# Skeptic 1 — rd-c21\n\n## Act on\n- ${FIND_1}\n- ${FIND_2}\n`);
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);

  // no decisions.tsv at all yet
  assert.ok(!existsSync(path.join(runDir(repo), "decisions.tsv")), "premise: nothing has been decided yet");
  const far = refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "decisions#9999"]);
  assert.match(far.stderr, /resolve/i, `the refusal does not say the pointer does not resolve: ${far.stderr}`);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, null, "a pointer at a row that does not exist closed the finding");

  // one row, so decisions#1 exists and decisions#2 does not
  cli(repo, "decide", ["review", "kept the null check in the caller", "one consumer", "src/a.ts:2", "open"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "decisions#1"]);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, "decisions#1");

  const past = refused(repo, "huddle", ["resolve", "H1.2", "--evidence", "decisions#2"]);
  assert.match(past.stderr, /resolve/i, `the refusal does not say the pointer does not resolve: ${past.stderr}`);
  assert.equal(itemById(ledgerOf(repo), "H1.2").closed, null, "a pointer one past the last row closed the finding");

  // the resolver itself, on a run dir that has no decisions.tsv
  const bare = path.join(runDir(repo), "no-decisions");
  mkdirSync(bare, { recursive: true });
  const resolves = pointerResolver({
    config: loadConfig(repo),
    changed: [],
    now: { hash: "x", files: {} },
    verify: null,
    events: [],
    reviews: [],
    root: repo,
    dir: bare,
  });
  assert.equal(resolves("decisions#1"), false, "decisions#1 resolves in a run dir with no decisions.tsv");
});

// 6.7: a finding closed as wrong, a reopened one, and an upheld dispute that goes to the user
const logged = (repo, payload) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
const browsed = (repo) => {
  logged(repo, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "http://localhost:3000/venues" }, tool_response: {} });
  return `events#${readEvents(stateDir(repo), "S1").filter((e) => e.kind === "browser").at(-1).seq}`;
};
function twoFindings(name) {
  const repo = opened(name);
  cli(repo, "brief", ["reviewer"]);
  logged(repo, { hook_event_name: "SubagentStop", agent_id: "R1", agent_type: "done-gate:reviewer" });
  helperFile(repo, "review-1.md", reviewFile(1, name, [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  return repo;
}

test("6.7 W1 W2: resolve --wrong refuses a file pointer, closes on a browser call since the round, and shows in the short report", () => {
  const repo = twoFindings("rl-67-w1");
  refused(repo, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", "src/a.ts:1"]);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, null);
  const ptr = browsed(repo);
  const out = cli(repo, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", ptr]).stdout;
  assert.match(out, /H1\.1 closed as wrong/);
  const item = itemById(ledgerOf(repo), "H1.1");
  assert.equal(item.wrong.evidence, ptr);
  assert.match(String(item.closed), /^wrong/);
  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.match(brief, /1 closed as wrong/, brief);
  assert.match(brief, /closed as wrong: "the empty list renders a stray comma/, brief);
});

test("6.7 W3 edge: reopen refuses an open item; a reopened item blocks R5 again and keeps its old close", () => {
  const repo = twoFindings("rl-67-w3");
  refused(repo, "huddle", ["reopen", "H1.2", "it never closed"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", browsed(repo)]);
  cli(repo, "huddle", ["resolve", "H1.2", "--evidence", "doc"]);
  assert.doesNotMatch(ruleLine(check(repo), "R5") ?? "", /H1\.1/);
  cli(repo, "huddle", ["reopen", "H1.1", "the page I checked was cached"]);
  const item = itemById(ledgerOf(repo), "H1.1");
  assert.equal(item.closed, null);
  assert.equal(item.wrong, undefined);
  assert.equal(item.reopened.length, 1);
  assert.match(item.reopened[0].closed, /^wrong/);
  assert.match(check(repo), /H1\.1/, "the reopened finding blocks again");
});

test("6.7 W4 happy: a wrong item leaves a fix-check's re-check list and is listed as closed as wrong", () => {
  const repo = twoFindings("rl-67-w4");
  cli(repo, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", browsed(repo)]);
  write(repo, "src/a.ts", "export const a = 2;\nexport const venue = undefined;\n");
  logged(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, "src/a.ts") }, tool_response: {} });
  cli(repo, "huddle", ["resolve", "H1.2", "--evidence", "doc"]);
  const packet = readFileSync(/packet: (\S+)/.exec(cli(repo, "brief", ["reviewer"]).stdout)[1], "utf8");
  const recheck = /## Findings to re-check\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1] ?? "";
  assert.match(recheck, /H1\.2/, packet);
  assert.doesNotMatch(recheck, /H1\.1/);
  const wrongs = /## Closed as wrong\n([\s\S]*?)(?=\n## |$)/.exec(packet)?.[1] ?? "";
  assert.match(wrongs, /new evidence/, packet);
  assert.match(wrongs, /- H1\.1 — /, packet);
});

test("6.7 W5 reported-surface: an upheld dispute blocks R5 with a line naming the user, and the short report says waiting for you", () => {
  const repo = upheld("rl-67-w5");
  const r5 = ruleLine(check(repo), "R5") ?? "";
  assert.match(r5, /H1\.2[\s\S]*ask the user/, r5);
  assert.match(r5, /--wrong --words/, r5);
  assert.match(cli(repo, "report", ["--brief"]).stdout, /the reviewer upheld it, waiting for you/);
});

test("6.7 W6 refused: --wrong --words the user never said is refused; their words close the item and show in the report", () => {
  const repo = upheld("rl-67-w6");
  const words = "the reviewer is wrong, leave the venue check as it is";
  refused(repo, "huddle", ["resolve", "H1.2", "--wrong", "--words", words]);
  assert.equal(itemById(ledgerOf(repo), "H1.2").closed, null);
  userSays(repo, words);
  cli(repo, "huddle", ["resolve", "H1.2", "--wrong", "--words", words]);
  assert.equal(itemById(ledgerOf(repo), "H1.2").wrong.words, words);
  assert.doesNotMatch(ruleLine(check(repo), "R5") ?? "", /H1\.2/, check(repo));
  assert.match(cli(repo, "report", ["--brief"]).stdout, /leave the venue check as it is/);
});

test("6.7 W7 happy: an upheld finding fixed and resolved with proof closes as any fix does", () => {
  const repo = upheld("rl-67-w7");
  cli(repo, "huddle", ["resolve", "H1.2", "--evidence", "doc"]);
  assert.ok(itemById(ledgerOf(repo), "H1.2").closed);
  assert.equal(itemById(ledgerOf(repo), "H1.2").wrong, undefined);
  assert.doesNotMatch(cli(repo, "report", ["--brief"]).stdout, /waiting for you/, "a fixed upheld item waits for nobody");
});

test("6.7 W8 refused: --wrong while a dispute waits, --evidence on an upheld item, and any resolve of a closed item", () => {
  const waiting = twoFindings("rl-67-w8");
  cli(waiting, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);
  assert.match(refused(waiting, "huddle", ["resolve", "H1.2", "--wrong", "--evidence", browsed(waiting)]).stderr, /reviewer/);
  const up = upheld("rl-67-w8-up");
  assert.match(refused(up, "huddle", ["resolve", "H1.2", "--wrong", "--evidence", browsed(up)]).stderr, /user/);
  assert.match(refused(up, "huddle", ["resolve", "H1.2", "--wrong", "--evidence", browsed(up), "--words", "leave it exactly as it is"]).stderr, /not both/);
  cli(waiting, "huddle", ["resolve", "H1.1", "--evidence", "doc"]);
  assert.match(refused(waiting, "huddle", ["resolve", "H1.1", "--wrong", "--evidence", browsed(waiting)]).stderr, /reopen/);
});

test("6.7 W9 refused: --words said before the reviewer upheld it, or only as the user's question", () => {
  const repo = twoFindings("rl-67-w9");
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);
  const early = "keep the venue check exactly as it is";
  userSays(repo, early);
  helperFile(repo, "review-2.md", reviewFile(2, "rl-67-w9", [], `\n## Disputes\n- H1.2 — upheld: ${UPHELD_REASON}\n\n`));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  refused(repo, "huddle", ["resolve", "H1.2", "--wrong", "--words", early]);
  const asked = "should I keep the venue check?";
  userSays(repo, asked);
  refused(repo, "huddle", ["resolve", "H1.2", "--wrong", "--words", asked]);
  assert.equal(itemById(ledgerOf(repo), "H1.2").closed, null);
});

test("6.7 W10 edge: a reopened withdrawn item counts once in the short report and is not counted as wrong", () => {
  const repo = twoFindings("rl-67-w10");
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);
  helperFile(repo, "review-2.md", reviewFile(2, "rl-67-w10", [], `\n## Disputes\n- H1.2 — withdrawn: fair, the caller checks it\n\n`));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  cli(repo, "huddle", ["reopen", "H1.2", "the caller's check was removed since"]);
  const item = itemById(ledgerOf(repo), "H1.2");
  assert.equal(item.dispute, undefined);
  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.doesNotMatch(brief, /withdrawn by the reviewer/, brief);
  assert.match(brief, /2 still open/, brief);
});

// 6.8: the arbiter is gone; an upheld dispute is the user's call. Old runs' arbiter verdicts
// still read.
const ledgerFile = (repo) => path.join(runDir(repo), "ledger.json");

test("6.8 A1 refused: gate brief arbiter and gate huddle add arbiter are refused, naming the roles that remain", () => {
  const repo = upheld("rl-68-a1");
  for (const args of [["brief", ["arbiter", "--item", "H1.2"]], ["huddle", ["add", "arbiter", "--file", "arbiter-1.md"]]]) {
    const r = refused(repo, args[0], args[1]);
    assert.match(r.stderr, /usage/i, r.stderr);
    assert.match(r.stderr, /reviewer-2/, r.stderr);
    assert.doesNotMatch(r.stderr, /arbiter\|/, r.stderr);
  }
  assert.equal(readdirSync(runDir(repo)).filter((f) => f.startsWith("brief-arbiter")).length, 0);
});

test("6.8 A2 idempotent: an old ledger's arbiter verdicts still report both outcomes", () => {
  const repo = opened("rl-68-a2");
  helperFile(repo, "review-1.md", reviewFile(1, "rl-68-a2", [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const ledger = JSON.parse(readFileSync(ledgerFile(repo), "utf8"));
  const [a, b] = ledger.huddles[0].actOn;
  a.dispute = { why: WHY, evidence: EVIDENCE, verdict: "arbiter:implementer", arbiterReason: "the caller checks it first" };
  a.closed = "overruled (arbiter-1.md)";
  b.dispute = { why: WHY, evidence: EVIDENCE, verdict: "arbiter:reviewer", arbiterReason: "a second caller passes null" };
  b.closed = "doc";
  writeFileSync(ledgerFile(repo), JSON.stringify(ledger, null, 2));
  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.match(brief, /1 overruled by the arbiter/, brief);
  assert.match(brief, /the arbiter sided with me/, brief);
  assert.match(brief, /the arbiter sided with the reviewer, fixed/, brief);
});

test("6.8 A3 reported-surface: no agent file, role list or help line names the arbiter", async () => {
  assert.ok(!existsSync(path.join(pluginRoot, "agents", "arbiter.md")), "agents/arbiter.md is still there");
  const { ROLES } = await import("../scripts/lib/verbs.mjs");
  assert.ok(!ROLES.includes("arbiter"), ROLES.join(","));
  const repo = committed("rl-68-a3");
  const help = run(repo, "help");
  assert.doesNotMatch(`${help.stdout}${help.stderr}`, /arbiter/i);
  for (const rel of ["skills/gate/SKILL.md", "hooks/session-start.md", "agents/reviewer.md", "agents/reviewer-2.md", "agents/worker.md"]) {
    assert.doesNotMatch(readFileSync(path.join(pluginRoot, rel), "utf8"), /arbiter/i, rel);
  }
});

test("6.8 A5 edge: an old run's unrecorded arbiter file raises no R15 naming a refused verb, and gate diagnose never prints gate brief arbiter", () => {
  const repo = opened("rl-68-a5");
  helperFile(repo, "arbiter-1.md", arbiterFile(1, "rl-68-a5", "H1.2 — implementer: an old ruling"));
  const out = check(repo);
  assert.doesNotMatch(out, /huddle add arbiter|gate brief arbiter/, out);
  // an older run's arbiter, briefed and cut off three times before its file was finished: the
  // ladder would reach a fresh brief, which must not be gate brief arbiter
  const file = path.join(runDir(repo), "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  ledger.briefed = { ...(ledger.briefed ?? {}), "arbiter-1.md": { seq: 1, item: "H1.2" } };
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  helperFile(repo, "arbiter-1.md", "# Arbiter 1\n\n## Ruling\n- unverified\n");
  for (const id of ["ARB1", "ARB2", "ARB3"]) {
    for (const hook_event_name of ["SubagentStart", "SubagentStop"]) {
      spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name, agent_id: id, agent_type: "done-gate:arbiter" }), encoding: "utf8", env: envFor(repo) });
    }
  }
  const d = run(repo, "diagnose");
  assert.doesNotMatch(`${d.stdout}${d.stderr}`, /arbiter/, `${d.stdout}${d.stderr}`);
  assert.doesNotMatch(check(repo), /gate brief arbiter/);
});

test("6.8 A6 idempotent: kept from the deleted arbiter tests: the reviewer packet's shape, an old arbiter file as a pointer, and the report embedding it", () => {
  const repo = upheld("rl-68-a6");
  // a third reviewer round after the dispute's answer: a cap past one
  capRounds(repo, 3);
  const review = readFileSync(/packet: (\S+)/.exec(cli(repo, "brief", ["reviewer"]).stdout)[1], "utf8");
  for (const h of ["Tier", "Tests"]) assert.doesNotMatch(review, new RegExp(`^## ${h}$`, "m"), `the reviewer packet carries no ${h}`);
  assert.match(review, /^## Cases$/m, "the reviewer still reads the cases");
  assert.doesNotMatch(review, /^Start with C\d+:/m, "no Start-with line");
  helperFile(repo, "arbiter-1.md", arbiterFile(1, "rl-68-a6", "H1.2 — implementer: the caller's null check runs first"));
  const resolves = pointerResolver({ root: repo, repos: [], config: loadConfig(repo), reviews: reviewFiles(runDir(repo)), dir: runDir(repo), ledger: ledgerOf(repo), events: [] });
  assert.equal(resolves("arbiter-1.md"), true, "a pointer at an old arbiter file does not resolve");
  assert.equal(resolves("arbiter-9.md"), false, "a pointer at a missing arbiter file resolves anyway");
  // the round an older run recorded with huddle add arbiter
  const lf = path.join(runDir(repo), "ledger.json");
  const led = JSON.parse(readFileSync(lf, "utf8"));
  led.huddles.push({ id: `H${led.huddles.length + 1}`, role: "arbiter", round: 1, file: "arbiter-1.md", summary: null, actOn: [], seq: 1 });
  writeFileSync(lf, JSON.stringify(led, null, 2));
  const md = cli(repo, "report").stdout;
  assert.ok(md.includes("<summary>arbiter-1.md</summary>"), `the report does not embed an old arbiter file:\n${md.slice(-1500)}`);
});

test("6.8 A4 edge: an old run's arbiter file stays protected from the lead's writes", async () => {
  const { decide } = await import("../scripts/lib/guard.mjs");
  const repo = opened("rl-68-a4");
  const rel = path.relative(repo, path.join(runDir(repo), "arbiter-1.md"));
  const current = path.dirname(rel);
  for (const tool of ["Write", "Edit"]) {
    const v = decide({ tool_name: tool, tool_input: { file_path: path.join(repo, rel) } }, repo, null, current, ledgerOf(repo));
    assert.equal(v.deny, true, `${tool}: ${JSON.stringify(v)}`);
    assert.match(v.reason, /older run's arbiter ruling/, v.reason);
  }
  // a stray done-gate:arbiter caller's shell edit is refused with no hint to use an edit tool
  for (const agent_type of [undefined, "done-gate:arbiter"]) {
    const v = decide({ tool_name: "Bash", ...(agent_type ? { agent_type, agent_id: "ARB" } : {}), tool_input: { command: `sed -i '' s/a/b/ ${path.join(repo, rel)}` } }, repo, null, current, ledgerOf(repo));
    assert.equal(v.deny, true, JSON.stringify(v));
    assert.doesNotMatch(v.reason, /Use the (?:Edit or )?Write tool, or sed -i with plain s or d commands, on arbiter-1\.md/, v.reason);
  }
});
}

// ===== from tests/review-loop.test.mjs =====
{
// T8 — the review loop: the worker answers findings in worker-<n>.md, the reviewer's rounds
// are capped at three, and the review step's hint describes the whole loop.
// Written from the requirements and the case table, blind to the implementation.

// ---------------------------------------------------------------------------
// conventions (mirrors tests/review-dispute.test.mjs)
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
const itemById = (ledger, id) => itemsOf(ledger).find((i) => i.id === id);
const ruleLine = (out, rule) => lines(out).find((l) => new RegExp(`\\b${rule}\\b`).test(l));

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

const helperFile = (repo, name, body) => writeFileSync(path.join(runDir(repo), name), body);

// ---------------------------------------------------------------------------
// source-of-truth anchors
//   the worker file's shape     → agents/worker.md ("## Replies", "- H<k>.<i> — fixed: …")
//   the reviewer file's shape   → agents/reviewer.md ("## Act on" then "- <finding> — file:line")
//   what a pointer may be       → the refusal `gate huddle resolve --evidence` already prints:
//                                 a test (file:name), a file:line, verify.json, events#<seq>
//                                 or a helper file
//   the step keys and their order → skills/gate/playbooks.md
//   the helper role names       → models.json
// Never the new implementation's own constants.
// ---------------------------------------------------------------------------

const FIND_1 = "the empty list renders a stray comma — src/a.ts:1 — the join runs on an empty array — []";
const FIND_2 = "null venue crashes the badge — src/a.ts:2 — venue is optional on the card — { venue: null }";
const FIND_3 = "the refused side has no test — tests/a.test.ts:1 — nothing covers the unknown role";
const WHY = "the caller already null-checks venue before it renders the card";

const reviewFile = (n, slug, actOn, extra = "") =>
  `# Review ${n} — ${slug}\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "_none_"}\n${extra}## Consider\n- rename the helper\n`;

// The file agents/worker.md tells the worker to write.
const workerFile = (n, slug, replies) =>
  `# Worker ${n} — ${slug}\n\n## Replies\n${replies.map((t) => `- ${t}`).join("\n")}\n`;

// An open feature ledger with a real HEAD and one changed source file.
function opened(name, { slug = name } = {}) {
  const repo = committed(name);
  cli(repo, "open", [slug, "feature"]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  cli(repo, "case", ["add", "refuses an unknown role", "--kind", "refused"]);
  // three lines, so a `src/a.ts:3` pointer names a line that exists
  write(repo, "src/a.ts", "export const a = 2;\nexport const venue = null;\nexport const badge = null;\n");
  return repo;
}

// opened() + a first reviewer round whose findings are the ones the worker answers.
function reviewed(name, findings = [FIND_1, FIND_2]) {
  const repo = opened(name);
  helperFile(repo, "review-1.md", reviewFile(1, name, findings));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1 — a fixed reply closes the finding with the worker's pointer
// ---------------------------------------------------------------------------

test("C1 happy: gate huddle reply --file worker-1.md with 'H1.1 — fixed: tests/a.test.ts:renders' closes H1.1 with that pointer and the report row reads closed [tests/a.test.ts:renders]", () => {
  const repo = reviewed("rl-c1");
  const POINTER = "tests/a.test.ts:renders";
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, null, "premise: H1.1 starts open");

  redRun(repo);
  helperFile(repo, "worker-1.md", workerFile(1, "rl-c1", [`H1.1 — fixed: ${POINTER}`]));
  cli(repo, "huddle", ["reply", "--file", "worker-1.md"]);

  const item = itemById(ledgerOf(repo), "H1.1");
  assert.equal(
    item.closed,
    POINTER,
    `a fixed reply did not close H1.1 with the worker's pointer: ${JSON.stringify(item, null, 2)}`,
  );
  assert.ok(item.closedSeq, "the close was not stamped with a seq");
  // the other finding is untouched
  assert.equal(itemById(ledgerOf(repo), "H1.2").closed, null, "a reply about H1.1 closed H1.2 as well");

  // the report shows the same pointer on the item's row
  const md = cli(repo, "report").stdout;
  const row = lines(md).find((l) => /^- H1\.1\b/.test(l));
  assert.ok(row, `the report has no row for H1.1:\n${md}`);
  assert.ok(row.includes(`closed [${POINTER}]`), `the H1.1 row does not read closed [${POINTER}]: ${row}`);
  assert.ok(
    lines(md).find((l) => /^- H1\.2\b/.test(l))?.includes("OPEN"),
    `the still-open H1.2 row does not read OPEN:\n${md}`,
  );
});

// ---------------------------------------------------------------------------
// C2 — a fixed pointer that does not resolve is refused
// ---------------------------------------------------------------------------

test("C2 refused: gate huddle reply with a 'fixed:' pointer that does not resolve is refused, names the pointer, and H1.1 stays open", () => {
  const repo = reviewed("rl-c2");
  helperFile(repo, "worker-1.md", workerFile(1, "rl-c2", ["H1.1 — fixed: nope-nothing"]));

  const r = refused(repo, "huddle", ["reply", "--file", "worker-1.md"]);
  assert.match(
    r.stderr,
    /H1\.1 fixed: a reviewer finding closes on a run/,
    `the refusal does not say what closes the finding: ${r.stderr}`,
  );
  assert.equal(
    itemById(ledgerOf(repo), "H1.1").closed,
    null,
    "an unresolvable pointer closed the finding anyway",
  );

  // the same pointer `gate huddle resolve` refuses is the one `reply` must refuse
  refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "nope-nothing"]);

  // and a pointer that proves the fix still closes it, so the refusal was about the pointer
  helperFile(repo, "worker-2.md", workerFile(2, "rl-c2", ["H1.1 — fixed: doc"]));
  cli(repo, "huddle", ["reply", "--file", "worker-2.md"]);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, "doc");
});

// ---------------------------------------------------------------------------
// C3 — a disagree reply is a dispute, and one round is the limit
// ---------------------------------------------------------------------------

test("C3 happy: 'H1.2 — disagree: <why> — src/a.ts:3' records a dispute on H1.2 with the why and the pointer as evidence and leaves it open; a second disagree on the same item is refused and the first dispute stands", () => {
  const repo = reviewed("rl-c3");
  const EVIDENCE = "src/a.ts:3";
  helperFile(repo, "worker-1.md", workerFile(1, "rl-c3", [`H1.2 — disagree: ${WHY} — ${EVIDENCE}`]));

  cli(repo, "huddle", ["reply", "--file", "worker-1.md"]);
  const item = itemById(ledgerOf(repo), "H1.2");
  assert.ok(item.dispute, `H1.2 carries no dispute: ${JSON.stringify(item, null, 2)}`);
  assert.equal(item.closed, null, "disagreeing with a finding must not close it");
  assert.equal(item.dispute.why, WHY, `the dispute does not carry the why: ${JSON.stringify(item.dispute)}`);
  assert.equal(
    item.dispute.evidence,
    EVIDENCE,
    `the dispute does not carry the pointer as its evidence: ${JSON.stringify(item.dispute)}`,
  );
  assert.equal(item.dispute.verdict ?? null, null, "a fresh dispute is unanswered until the reviewer answers it");

  // one round only — the same cap `gate huddle dispute` enforces
  helperFile(repo, "worker-2.md", workerFile(2, "rl-c3", ["H1.2 — disagree: and another thing — src/a.ts:1"]));
  const second = refused(repo, "huddle", ["reply", "--file", "worker-2.md"]);
  assert.match(
    second.stderr,
    /one round|already disputed|limit/i,
    `the refusal says nothing about the one-round cap: ${second.stderr}`,
  );
  const after = itemById(ledgerOf(repo), "H1.2");
  assert.equal(after.dispute.why, WHY, "the second disagree overwrote the first dispute");
  assert.equal(after.dispute.evidence, EVIDENCE, "the second disagree overwrote the first dispute's evidence");

  // `gate huddle dispute` refuses the same second round, whichever way it is spelled
  const direct = refused(repo, "huddle", ["dispute", "H1.2", "one more round", "--evidence", "src/a.ts:1"]);
  assert.match(direct.stderr, /one round|already/i, direct.stderr);
});

// ---------------------------------------------------------------------------
// C4 — a reply about an item that is already settled changes nothing
// ---------------------------------------------------------------------------

test("C4 idempotent: a reply naming an item the implementer already resolved, or one the reviewer withdrew, leaves both closes exactly as they were and the verb says the item was skipped", () => {
  const repo = reviewed("rl-c4", [FIND_1, FIND_2]);
  // H1.1 closed the ordinary way
  redRun(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:empty list"]);
  // H1.2 disputed, then withdrawn by the reviewer's next file
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", "src/a.ts:2"]);
  helperFile(
    repo,
    "review-2.md",
    reviewFile(2, "rl-c4", [], "\n## Disputes\n- H1.2 — withdrawn: you are right, the caller guards it\n\n"),
  );
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);

  const before = ledgerOf(repo);
  assert.equal(itemById(before, "H1.1").closed, "tests/a.test.ts:empty list", "premise: H1.1 is closed");
  const withdrawn = String(itemById(before, "H1.2").closed);
  assert.match(withdrawn, /withdrawn/i, "premise: H1.2 was withdrawn by the reviewer");

  helperFile(
    repo,
    "worker-1.md",
    workerFile(1, "rl-c4", ["H1.1 — fixed: tests/a.test.ts:renders", "H1.2 — fixed: src/a.ts:3"]),
  );
  const r = cli(repo, "huddle", ["reply", "--file", "worker-1.md"]);

  const after = ledgerOf(repo);
  assert.equal(
    itemById(after, "H1.1").closed,
    "tests/a.test.ts:empty list",
    "a reply overwrote the pointer an already-closed finding was closed with",
  );
  assert.equal(
    String(itemById(after, "H1.2").closed),
    withdrawn,
    "a reply overwrote the reviewer's withdrawal",
  );
  assert.equal(
    itemById(after, "H1.1").closedSeq,
    itemById(before, "H1.1").closedSeq,
    "a reply re-stamped an already-closed finding",
  );

  const said = `${r.stdout}${r.stderr}`;
  assert.match(said, /H1\.1/, `the verb did not say what happened to H1.1:\n${said}`);
  assert.match(said, /H1\.2/, `the verb did not say what happened to H1.2:\n${said}`);
  assert.match(
    said,
    /skip|already|closed|withdrawn/i,
    `the verb did not say the settled items were left alone:\n${said}`,
  );
});

// ---------------------------------------------------------------------------
// C5 — the file must exist and must be the worker's own
// ---------------------------------------------------------------------------

test("C5 refused: gate huddle reply with no --file, with a worker-<n>.md that is not in the run dir, or with a file that is not named worker-<n>.md is refused and nothing is recorded", () => {
  const repo = reviewed("rl-c5");
  helperFile(repo, "notes.md", workerFile(1, "rl-c5", ["H1.1 — fixed: src/a.ts:3"]));

  const bare = refused(repo, "huddle", ["reply"]);
  assert.match(bare.stderr, /--file|usage/i, `the refusal does not name --file: ${bare.stderr}`);

  const missing = refused(repo, "huddle", ["reply", "--file", "worker-9.md"]);
  assert.match(
    missing.stderr,
    /worker-9\.md|not found|does not exist|no such/i,
    `the refusal does not name the missing file: ${missing.stderr}`,
  );

  // a real file in the run dir, but not the worker's own name
  const wrongName = refused(repo, "huddle", ["reply", "--file", "review-1.md"]);
  assert.match(wrongName.stderr, /worker-/, `the refusal does not name the worker- prefix: ${wrongName.stderr}`);
  const alsoWrong = refused(repo, "huddle", ["reply", "--file", "notes.md"]);
  assert.match(alsoWrong.stderr, /worker-/, `the refusal does not name the worker- prefix: ${alsoWrong.stderr}`);

  // a path out of the run dir is not a worker-<n>.md either
  refused(repo, "huddle", ["reply", "--file", path.join(repo, "worker-1.md")]);

  assert.deepEqual(
    itemsOf(ledgerOf(repo)).map((i) => i.closed),
    [null, null],
    "a refused reply still touched the findings",
  );
  assert.ok(
    !itemsOf(ledgerOf(repo)).some((i) => i.dispute),
    "a refused reply still recorded a dispute",
  );
});

// ---------------------------------------------------------------------------
// C6 — the round cap, then the user for an upheld dispute
// ---------------------------------------------------------------------------

test("C6 refused: a fourth round after three reviewer huddles is refused and the message sends an upheld dispute to the user", () => {
  const natural = opened("rl-c6-natural");
  for (const [n, find] of [[1, FIND_1], [2, FIND_2], [3, FIND_3]]) {
    helperFile(natural, `review-${n}.md`, reviewFile(n, "rl-c6-natural", [find]));
    cli(natural, "huddle", ["add", "reviewer", "--file", `review-${n}.md`]);
  }
  assert.equal(
    ledgerOf(natural).huddles.filter((h) => h.role === "reviewer").length,
    3,
    "premise: three reviewer rounds are recorded",
  );
  const fourth = refused(natural, "brief", ["reviewer"]);
  assert.ok(
    fourth.stderr.includes("--wrong --words"),
    `the natural fourth round's refusal does not send an upheld dispute to the user: ${fourth.stderr}`,
  );
  assert.ok(!fourth.stdout.includes("packet: "), `a fourth reviewer packet was written:\n${fourth.stdout}`);
});

// ---------------------------------------------------------------------------
// C7 — "none" under Act on is not a finding
// ---------------------------------------------------------------------------

test("C7 edge: a reviewer file whose Act-on bullet is '- none.' or '- none found' records zero Act-on items and raises no R15", () => {
  for (const [n, bullet] of [[1, "none."], [2, "none found"]]) {
    const repo = opened(`rl-c7-${n}`);
    helperFile(repo, "review-1.md", reviewFile(1, `rl-c7-${n}`, [bullet]));
    cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

    const items = itemsOf(ledgerOf(repo));
    assert.deepEqual(
      items,
      [],
      `"- ${bullet}" was recorded as a finding: ${JSON.stringify(items, null, 2)}`,
    );
    assert.equal(ledgerOf(repo).huddles.length, 1, "the huddle itself must still be recorded");
    assert.ok(
      !ruleLine(check(repo), "R15"),
      `R15 fires on a file whose only Act-on bullet is "- ${bullet}":\n${check(repo)}`,
    );
  }

  // the empty answer the reviewer template already uses still records nothing
  const italic = opened("rl-c7-italic");
  helperFile(italic, "review-1.md", reviewFile(1, "rl-c7-italic", []));
  cli(italic, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.deepEqual(itemsOf(ledgerOf(italic)), [], "_none_ under Act on recorded an item");
});

// ---------------------------------------------------------------------------
// C8 — the review step's hint describes the loop
// ---------------------------------------------------------------------------

test("C8 happy: the next: hint for the {review} step names gate brief reviewer, gate huddle add, gate brief worker, SendMessage, gate huddle reply and the user for an upheld dispute", () => {
  // step keys and their order come from the playbook, never from the hint renderer
  const playbook = readFileSync(path.join(pluginRoot, "skills", "gate", "playbooks.md"), "utf8");
  const m = /^## feature\s*$/m.exec(playbook);
  const rest = playbook.slice(m.index + m[0].length);
  const body = rest.slice(0, /^## /m.exec(rest)?.index ?? rest.length);
  const keys = body.split("\n").flatMap((l) => {
    const k = /^\s*\d+\.\s.*\{([a-z0-9-]+)\}\s*$/.exec(l);
    return k ? [k[1]] : [];
  });
  assert.ok(keys.includes("review"), `the feature playbook has no {review} step: ${keys}`);

  // every step before {review} closed, so {review} is the next blank one
  const steps = keys.map((key, i) => ({
    n: i + 1,
    key,
    text: `step ${i + 1}`,
    state: key === "review" || keys.indexOf(key) > keys.indexOf("review") ? null : "DONE",
    note: null,
    evidence: null,
    seq: i + 1,
  }));
  const h = nextHint({
    status: "open", rules: 2,
    playbook: "feature",
    taskSeq: 1,
    planSeq: 2,
    cases: [{ id: "C1", status: "closed" }],
    steps,
    huddles: [],
    waivers: [],
  });

  for (const [what, re] of [
    ["gate brief reviewer", /gate brief reviewer/],
    ["gate huddle add", /gate huddle add/],
    ["gate brief worker", /gate brief worker/],
    ["SendMessage", /SendMessage/],
    ["gate huddle reply", /gate huddle reply/],
    ["the user for an upheld dispute", /upheld dispute is the user's/],
  ]) {
    assert.match(h, re, `the {review} hint never names ${what}:\n${h}`);
  }
  // one round plus one re-check is the loop; a run pinned before keeps three
  assert.match(h, /\bone round\b[^.;]*\bre-check\b/, `the {review} hint does not say one round plus a re-check:\n${h}`);
  assert.doesNotMatch(h, /at most three rounds/, `the {review} hint still caps new runs at three:\n${h}`);
  // the worker answers in worker-<n>.md, and the reviewer's file is what the loop feeds it
  assert.match(h, /worker-<n>\.md/, `the hint does not name the file the worker writes:\n${h}`);
});

// 6.6: on a new run a reviewer finding closes on a run: a test that failed since the finding, a
// recorded command or browser call, or doc for a text-only fix
// a failed Bash call arrives as PostToolUseFailure; a green one as PostToolUse
const shell = (repo, command, exit, agent = {}) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...agent, tool_name: "Bash", tool_input: { command }, ...(exit ? { hook_event_name: "PostToolUseFailure", error: `Exit code ${exit}` } : { hook_event_name: "PostToolUse", tool_response: { exit_code: 0 } }) }), encoding: "utf8", env: envFor(repo) });
const browse = (repo, url) => spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url }, tool_response: {} }), encoding: "utf8", env: envFor(repo) });
const newestSeq = (repo, kind) => readEvents(stateDir(repo), "S1").filter((e) => e.kind === kind).at(-1).seq;
const PROOF = /closes on a run/;

test("6.6 P1 refused: a source line, verify.json, a green-only test run and a red run from before the finding cannot close a reviewer finding", () => {
  const repo = opened("rl-66-p1");
  shell(repo, "node --test tests/a.test.ts", 1);
  helperFile(repo, "review-1.md", reviewFile(1, "rl-66-p1", [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.match(refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts"]).stderr, PROOF, "a red run from before the round");
  for (const ptr of ["src/a.ts:1", "verify.json"]) assert.match(refused(repo, "huddle", ["resolve", "H1.1", "--evidence", ptr]).stderr, PROOF, ptr);
  shell(repo, "node --test tests/a.test.ts", 0);
  assert.match(refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts"]).stderr, PROOF, "a green run proves nothing about the finding");
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, null);
});

test("6.6 P2 happy: a test that failed since the finding, a browser call and doc each close a reviewer finding", () => {
  const repo = reviewed("rl-66-p2", [FIND_1, FIND_2, FIND_3]);
  shell(repo, "node --test tests/a.test.ts", 1);
  redRun(repo);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts"]);
  browse(repo, "http://localhost:3000/venues");
  cli(repo, "huddle", ["resolve", "H1.2", "--evidence", `events#${newestSeq(repo, "browser")}`]);
  cli(repo, "huddle", ["resolve", "H1.3", "--evidence", "doc"]);
  assert.ok(itemsOf(ledgerOf(repo)).every((a) => a.closed), JSON.stringify(itemsOf(ledgerOf(repo))));
});

test("6.6 P3 idempotent: a skeptic item keeps the pointer rule", () => {
  const repo = committed("rl-66-p3");
  cli(repo, "open", ["rl-66-p3", "feature"]);
  helperFile(repo, "skeptic-1.md", "# Skeptic 1\n\n## Act on\n- the plan misses the empty list — src/a.ts:1\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/a.ts:1"]);
});

test("6.6 P5 refused: a gate verb, a failed command, a git command and a reviewer's red run do not close a reviewer finding", () => {
  const repo = reviewed("rl-66-p5");
  const tries = [
    () => shell(repo, `node "${gate}" check`, 0),
    () => shell(repo, "node scripts/repro.mjs", 2),
    () => shell(repo, "git add -A", 0),
  ];
  for (const t of tries) {
    t();
    assert.match(refused(repo, "huddle", ["resolve", "H1.1", "--evidence", `events#${newestSeq(repo, "command")}`]).stderr, PROOF);
  }
  shell(repo, "node --test tests/a.test.ts", 1, { agent_id: "R2", agent_type: "done-gate:reviewer" });
  assert.match(refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts"]).stderr, PROOF, "the reviewer's own red run");
  shell(repo, "node scripts/repro.mjs", 0);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", `events#${newestSeq(repo, "command")}`]);
});

test("6.6 P4 refused: a worker's fixed reply needs the same proof", () => {
  const repo = reviewed("rl-66-p4");
  helperFile(repo, "worker-1.md", workerFile(1, "rl-66-p4", ["H1.1 — fixed: src/a.ts:1"]));
  assert.match(refused(repo, "huddle", ["reply", "--file", "worker-1.md"]).stderr, PROOF);
  helperFile(repo, "worker-1.md", workerFile(1, "rl-66-p4", ["H1.1 — fixed: doc"]));
  cli(repo, "huddle", ["reply", "--file", "worker-1.md"]);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed !== null, true);
});
}

// ===== from tests/skeptic-file.test.mjs =====
{
// ---------------------------------------------------------------------------
// conventions (mirrors tests/next-hints.test.mjs and tests/helper-packets.test.mjs)
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

// An open feature ledger at tier standard (two planned files), with a case table.
function opened(name, { planFiles = "src/a.ts,src/app/page.tsx", files = {} } = {}) {
  const repo = committed(name, files);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Give the skeptic a file. [inferred]"]);
  lookedUp(repo);
  cli(repo, "note", ["context", "Traced: src/a.ts:1 · Related: none: `grep -rn a src` · Research: none needed: a test fixture"]);
  cli(repo, "note", ["plan", "Two modules.", "--files", planFiles]);
  cli(repo, "case", ["add", "the skeptic writes its file", "--kind", "happy"]);
  cli(repo, "case", ["add", "everyone else is denied", "--kind", "refused"]);
  return repo;
}

// ---------------------------------------------------------------------------
// source-of-truth anchors
//   agent roles + their models   → models.json
//   playbook step keys and order → skills/gate/playbooks.md (## feature)
//   agent turn budgets           → each agent file's own frontmatter
//   tests globs                  → the repo's .claude/gate.json
// Never the renderer's or the guard's own tables.
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(pluginRoot, "agents");
const SKILL_MD = path.join(pluginRoot, "skills", "gate", "SKILL.md");

function playbookKeys(playbook) {
  const all = readFileSync(path.join(pluginRoot, "skills", "gate", "playbooks.md"), "utf8");
  const m = new RegExp(`^## ${playbook}\\s*$`, "m").exec(all);
  const rest = all.slice(m.index + m[0].length);
  const end = /^## /m.exec(rest);
  const md = end ? rest.slice(0, end.index) : rest;
  return md.split("\n").flatMap((l) => {
    const m = /^\s*\d+\.\s.*\{([a-z0-9-]+)\}\s*$/.exec(l);
    return m ? [m[1]] : [];
  });
}

// The last printed line of a mutating verb is its `next:` hint.
const hintOf = (stdout) => lines(stdout)[lines(stdout).length - 1] ?? "";

// The step key a hint points at (same mapping tests/next-hints.test.mjs uses).
const ROLE_STEP = { skeptic: "skeptic", qa: "tests", reviewer: "review", "reviewer-2": "review" };
function hintedKey(h) {
  const flagged = /--step ([a-z0-9-]+)/.exec(h);
  if (flagged) return flagged[1];
  const step = /`gate step ([a-z0-9-]+)/.exec(h);
  if (step) return step[1];
  const role = /`gate brief ([a-z0-9-]+)/.exec(h);
  if (role) return ROLE_STEP[role[1]] ?? role[1];
  const verb = /`gate (verify|close|decide)\b/.exec(h);
  if (verb) return { verify: "verify", close: "close", decide: "driver" }[verb[1]];
  return null;
}

// `## <heading>` section text, up to the next `## ` line.
function section(md, heading) {
  const all = md.split("\n");
  const start = all.findIndex((l) => l.trim() === `## ${heading}`);
  assert.ok(start >= 0, `packet has no "## ${heading}" section:\n${md.slice(0, 2000)}`);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function packet(repo, role, args = []) {
  const r = cli(repo, "brief", [role, ...args]);
  const p = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${r.stdout}`);
  return { path: p, text: readFileSync(p, "utf8") };
}

// ---------------------------------------------------------------------------
// C1 — the fence lets the skeptic write <run dir>/skeptic-<n>.md and nothing else
// ---------------------------------------------------------------------------

test("C1 refused: with a ledger open the fence lets the skeptic write <run dir>/skeptic-1.md and denies src/a.ts, review-1.md, a skeptic file outside the run dir, every other writer, and every write when no ledger is open", () => {
  const repo = committed("skeptic-fence", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
  cli(repo, "open", ["skeptic-fence", "feature"]);
  const dir = runDir(repo); // the session's own run dir, not an invented one

  // A PreToolUse payload, exactly the shape tests/guard.test.mjs feeds `gate fence`.
  const payload = (tool, file_path, extra = {}) => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path },
    cwd: repo,
    session_id: "S1",
    ...extra,
  });

  const fence = (p, root = repo) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify(p),
      encoding: "utf8",
      env: envFor(root, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  // `gate fence` is silent on an allow and emits a deny envelope otherwise.
  const denied = (p, root = repo) => {
    const out = fence(p, root);
    if (out === "") return false;
    return JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const SKEPTIC = { agent_id: "A3", agent_type: "done-gate:skeptic" };

  // permitted: its own file, in the session's run dir
  assert.equal(fence(payload("Write", path.join(dir, "skeptic-1.md"), SKEPTIC)), "", "the skeptic's own file was not allowed");

  // refused: source, another helper's file, and a skeptic file outside the run dir
  assert.equal(denied(payload("Write", `${repo}/src/a.ts`, SKEPTIC)), true, "the skeptic was allowed to write source");
  assert.equal(denied(payload("Write", path.join(dir, "review-1.md"), SKEPTIC)), true, "the skeptic was allowed to write the reviewer's file");
  assert.equal(denied(payload("Write", `${repo}/skeptic-1.md`, SKEPTIC)), true, "a skeptic file outside the run dir was allowed");

  // refused: skeptic files are fenced from everyone else
  assert.equal(
    denied(payload("Write", path.join(dir, "skeptic-1.md"), { agent_id: "A2", agent_type: "done-gate:reviewer" })),
    true,
    "the reviewer was allowed to write a skeptic file",
  );
  assert.equal(
    denied(payload("Write", path.join(dir, "skeptic-1.md"))),
    true,
    "the main session was allowed to write a skeptic file",
  );

  // refused: no ledger means no task, so a helper may write nothing at all
  const bare = committed("skeptic-fence-noledger", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
  const barePayload = (file_path, extra) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path },
    cwd: bare,
    session_id: "S1",
    ...extra,
  });
  assert.ok(!existsSync(path.join(bare, ".claude", "gate", "runs")), "premise: the bare repo has no run at all");
  assert.equal(
    denied(barePayload(`${bare}/.claude/gate/runs/x/skeptic-1.md`, SKEPTIC), bare),
    true,
    "with no ledger open the skeptic was still allowed to write a skeptic file",
  );
  assert.equal(
    denied(barePayload(`${bare}/.claude/gate/runs/x/review-1.md`, { agent_id: "A2", agent_type: "done-gate:reviewer" }), bare),
    true,
    "with no ledger open the reviewer was still allowed to write a review file",
  );
});

// ---------------------------------------------------------------------------
// C2 — a [measured] (skeptic-1.md) pointer resolves only when the file exists
// ---------------------------------------------------------------------------

test("C2 happy: a [measured] (skeptic-1.md) pointer resolves when the file exists and not when it is missing", () => {
  const repo = makeRepo("skeptic-pointer");
  const dir = path.join(repo, ".claude", "gate", "runs", "x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "skeptic-1.md"), "# Skeptic 1 — skeptic-pointer\n\n## Act on\n\n1. wrong premise\n");

  // The state's `reviews` array is what assess.mjs lists for the run dir.
  const reviews = reviewFiles(dir);
  assert.ok(reviews.includes("skeptic-1.md"), `assess did not list skeptic-1.md, got ${JSON.stringify(reviews)}`);
  assert.ok(!reviews.includes("skeptic-2.md"), `assess listed a file that does not exist: ${JSON.stringify(reviews)}`);

  // Built the way tests/report.test.mjs builds a rules state.
  const state = {
    config: loadConfig(repo),
    changed: [],
    now: { hash: "x", files: {} },
    verify: null,
    events: [],
    reviews,
    root: repo,
    dir,
  };
  const resolves = pointerResolver(state);
  assert.equal(resolves("skeptic-1.md"), true, "a pointer at the skeptic's file does not resolve");
  assert.equal(resolves("skeptic-2.md"), false, "a pointer at a missing skeptic file resolves anyway");
});

// ---------------------------------------------------------------------------
// C3 — the full report embeds the skeptic huddle's file
// ---------------------------------------------------------------------------

test("C3 happy: the full report embeds the skeptic huddle's file; a missing file is reported without a crash", () => {
  const repo = opened("skeptic-report");
  const body = "# Skeptic 1 — skeptic-report\n\n## Act on\n\n1. the plan hides a second write path\n";
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), body);
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);

  const md = cli(repo, "report").stdout;
  assert.ok(md.includes("<summary>skeptic-1.md</summary>"), `the report does not embed skeptic-1.md:\n${md}`);
  assert.ok(
    md.includes("the plan hides a second write path"),
    `the report embeds skeptic-1.md without its text:\n${md}`,
  );

  // Same ledger, file gone: the report still renders and names the file.
  const gone = opened("skeptic-report-missing");
  writeFileSync(path.join(runDir(gone), "skeptic-9.md"), "# Skeptic 9\n\n## Act on\n- none\n");
  cli(gone, "huddle", ["add", "skeptic", "--file", "skeptic-9.md"]);
  rmSync(path.join(runDir(gone), "skeptic-9.md"));
  const r = run(gone, "report");
  assert.equal(r.status, 0, `report crashed on a missing skeptic file:\n${r.stderr}`);
  assert.ok(!existsSync(path.join(runDir(gone), "skeptic-9.md")), "premise: the file really is absent");
  assert.ok(r.stdout.includes("skeptic-9.md"), `the huddle row does not name the missing file:\n${r.stdout}`);
  assert.ok(
    !r.stdout.includes("<summary>skeptic-9.md</summary>"),
    "a missing file was embedded as if it existed",
  );
});

// ---------------------------------------------------------------------------
// C4 — the skeptic packet names its output file and asks for the Act-on list only
// ---------------------------------------------------------------------------

test("C4 happy: the skeptic packet's You-may-write line names <run dir>/skeptic-<n>.md, one past the highest existing, and asks for the Act-on list only in the reply", () => {
  const repo = opened("skeptic-packet");
  const dir = runDir(repo);

  const first = packet(repo, "skeptic");
  const may = section(first.text, "You may write");
  assert.ok(
    may.includes(path.join(dir, "skeptic-1.md")),
    `the skeptic's "You may write" does not name ${path.join(dir, "skeptic-1.md")}:\n${may}`,
  );

  // The reply is the short part: the Act-on list only.
  const replyLine = first.text
    .split("\n")
    .find((l) => /\bact[- ]on\b/i.test(l) && /\bonly\b/i.test(l) && /\breply\b/i.test(l));
  assert.ok(replyLine, `no line tells the skeptic to reply with the Act-on list only:\n${first.text}`);

  // n is one past the highest existing skeptic file. The plan check runs once (tests/plan-hold.test.mjs
  // C12), so a disputed finding brings it back.
  writeFileSync(path.join(dir, "skeptic-1.md"), "# Skeptic 1 — skeptic-packet\n\n## Act on\n- the plan misses the empty list — src/a.ts:1\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  cli(repo, "huddle", ["dispute", "H1.1", "the case table holds it", "--evidence", "src/a.ts:1"]);
  const second = packet(repo, "skeptic", ["--round", "2"]);
  const may2 = section(second.text, "You may write");
  assert.ok(
    may2.includes(path.join(dir, "skeptic-2.md")),
    `with skeptic-1.md on disk the packet must name skeptic-2.md:\n${may2}`,
  );
});

// ---------------------------------------------------------------------------
// C5 — every agent carries a By-turn line two under its own maxTurns
// ---------------------------------------------------------------------------

test("C5 happy: every agent file carries a By-turn line equal to its maxTurns minus two, and skeptic.md allows Write while disallowing Edit, MultiEdit and NotebookEdit", () => {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 4, `expected the four helper agents, got ${files.join(", ")}`);

  for (const f of files) {
    const md = readFileSync(path.join(AGENTS_DIR, f), "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
    assert.ok(fm, `agents/${f} has no frontmatter`);
    const turns = /^\s*maxTurns:\s*(\d+)\s*$/m.exec(fm[1]);
    assert.ok(turns, `agents/${f} frontmatter has no maxTurns line:\n${fm[1]}`);

    const budget = Number(turns[1]) - 2;
    const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.ok(
      body.includes(`By turn ${budget}`),
      `agents/${f} has maxTurns ${turns[1]} but its body carries no "By turn ${budget}" line`,
    );
  }

  const skeptic = readFileSync(path.join(AGENTS_DIR, "skeptic.md"), "utf8");
  const disallowed = /^\s*disallowedTools:.*$/m.exec(skeptic);
  assert.ok(disallowed, "agents/skeptic.md has no disallowedTools line");
  for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
    assert.ok(disallowed[0].includes(tool), `agents/skeptic.md no longer disallows ${tool}: ${disallowed[0]}`);
  }
  assert.ok(
    !/\bWrite\b/.test(disallowed[0]),
    `agents/skeptic.md still disallows Write, so it cannot write its file: ${disallowed[0]}`,
  );
});

// ---------------------------------------------------------------------------
// C6 — the hints name the skeptic file, the waiver cost, and who owns the diff
// ---------------------------------------------------------------------------

test("C6 happy: the skeptic hint names `gate huddle add skeptic --file skeptic-<n>.md`; the driver and schema hints warn against waiving to save time; the review hint says you own the diff", () => {
  const keys = playbookKeys("feature");
  for (const k of ["skeptic", "driver", "schema", "review"]) {
    assert.ok(keys.includes(k), `premise: the feature playbook has a {${k}} step (got ${keys.join(", ")})`);
  }

  const repo = committed("skeptic-hints");
  cli(repo, "open", ["skeptic-hints", "feature"]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Pin the hints. [inferred]"]);
  const afterPlan = hintOf(cli(repo, "note", ["plan", "Two modules.", "--files", "src/a.ts,src/app/page.tsx"]).stdout);
  assert.match(afterPlan, /^next: /, afterPlan);

  // Walk the playbook, collecting each hint by the step it points at.
  const hints = {};
  const record = (stdout) => {
    const h = hintOf(stdout);
    const k = hintedKey(h);
    if (k && !(k in hints)) hints[k] = h;
  };
  record(cli(repo, "note", ["context", "Traced: src/a.ts:1 is the entry, read by src/app/page.tsx:1.\nRelated: tests/a.test.ts pins it.\nResearch: none needed: a local change."]).stdout);
  record(cli(repo, "case", ["add", "the skeptic writes its file", "--kind", "happy"]).stdout);
  for (const key of keys) {
    if (["context", "read", "plan", "cases"].includes(key)) continue;
    if (key === "review") break;
    if (key === "skeptic") {
      writeFileSync(path.join(runDir(repo), "skeptic-1.md"), "# Skeptic 1\n\n## Act on\n- none\n");
      cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
    }
    record(cli(repo, "step", doneArgs(repo, key, key, `${key} done`, "ledger.md")).stdout);
  }

  assert.ok(hints.skeptic, `no hint ever pointed at {skeptic}: ${JSON.stringify(hints, null, 2)}`);
  assert.match(
    hints.skeptic,
    /gate huddle add skeptic --file skeptic-<n>\.md/,
    `the skeptic hint does not name the file-carrying huddle command:\n${hints.skeptic}`,
  );

  for (const key of ["driver", "schema"]) {
    assert.ok(hints[key], `no hint ever pointed at {${key}}: ${JSON.stringify(hints, null, 2)}`);
    assert.match(hints[key], /waiver/i, `the ${key} hint does not mention a waiver:\n${hints[key]}`);
    assert.match(hints[key], /save time/i, `the ${key} hint does not say "save time":\n${hints[key]}`);
  }

  assert.ok(hints.review, `no hint ever pointed at {review}: ${JSON.stringify(hints, null, 2)}`);
  assert.match(hints.review, /own the diff/i, `the review hint does not say you own the diff:\n${hints.review}`);
});

// ---------------------------------------------------------------------------
// C7 — SKILL.md mentions the skeptic file and stays under 4 KB
// ---------------------------------------------------------------------------

test("C7 boundary: SKILL.md stays under 4096 bytes after mentioning the skeptic file", () => {
  const size = statSync(SKILL_MD).size;
  assert.ok(size < 4096, `skills/gate/SKILL.md is ${size} bytes, the budget is 4096`);
  const md = readFileSync(SKILL_MD, "utf8");
  assert.ok(md.includes("skeptic-<n>.md"), "skills/gate/SKILL.md never names skeptic-<n>.md");
});

// ---------------------------------------------------------------------------
// C9 — a helper's file belongs to the session's own run dir, not to any run dir
// ---------------------------------------------------------------------------

test("C9 refused: with a ledger open, the skeptic and the reviewer may write their file only in the session's own run dir", () => {
  const repo = opened("skeptic-other-run");
  const mine = runDir(repo);
  const other = path.join(stateDir(repo), "runs", "2020-01-01-other-run");
  mkdirSync(other, { recursive: true });
  assert.notEqual(mine, other, "premise: the two run dirs differ");

  const fence = (file_path, extra) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const denied = (file_path, extra) => {
    const out = fence(file_path, extra);
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const SKEPTIC = { agent_id: "A3", agent_type: "done-gate:skeptic" };
  const REVIEWER = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  assert.equal(fence(path.join(mine, "skeptic-1.md"), SKEPTIC), "", "the skeptic's file in its own run dir was denied");
  assert.equal(
    denied(path.join(other, "skeptic-1.md"), SKEPTIC),
    true,
    "the skeptic was allowed to write into another task's run dir",
  );

  assert.equal(fence(path.join(mine, "review-1.md"), REVIEWER), "", "the reviewer's file in its own run dir was denied");
  assert.equal(
    denied(path.join(other, "review-1.md"), REVIEWER),
    true,
    "the reviewer was allowed to write into another task's run dir",
  );
});

// ---------------------------------------------------------------------------
// C10 — round 2 packets name the next file for both helpers that write one
// ---------------------------------------------------------------------------

test("C10 edge: with review-1.md and skeptic-1.md on disk, the round-2 packets name review-2.md and skeptic-2.md", () => {
  const repo = opened("skeptic-round2");
  // a second reviewer round with the first one's file unrecorded: a cap past one
  capRounds(repo, 2);
  const dir = runDir(repo);
  writeFileSync(path.join(dir, "review-1.md"), "# Review 1\n\n## Act on\n\n_none_\n");
  // a second plan check answers a disputed finding (tests/plan-hold.test.mjs C12)
  writeFileSync(path.join(dir, "skeptic-1.md"), "# Skeptic 1 — skeptic-round2\n\n## Act on\n- the plan misses the empty list — src/a.ts:1\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  cli(repo, "huddle", ["dispute", "H1.1", "the case table holds it", "--evidence", "src/a.ts:1"]);

  for (const [role, want] of [["reviewer", "review-2.md"], ["skeptic", "skeptic-2.md"]]) {
    const { text } = packet(repo, role, ["--round", "2"]);
    const may = section(text, "You may write");
    assert.ok(
      may.includes(path.join(dir, want)),
      `the round-2 ${role} packet does not name ${path.join(dir, want)}:\n${may}`,
    );
  }
});

// ---------------------------------------------------------------------------
// C11 — a helper cannot route a write through Bash
// ---------------------------------------------------------------------------

test("C11 refused: a helper's Bash command that writes, deletes or commits source is denied; read-only commands pass, and the main session is untouched", () => {
  const repo = opened("skeptic-bash");
  // the main session's own writes wait for the plan check like any code write
  planChecked(repo);

  const fence = (command, extra = {}) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const SKEPTIC = { agent_id: "A3", agent_type: "done-gate:skeptic" };
  const QA = { agent_id: "A1", agent_type: "done-gate:qa" };

  // A write is a write however it is spelled: redirect, tee, in-place sed, rm, commit.
  const writes = [
    "echo x > src/a.ts",
    "cat f | tee src/a.ts",
    "sed -i s/a/b/ src/a.ts",
    "rm src/a.ts",
    "git add -A && git commit -m x",
  ];
  for (const cmd of writes) {
    assert.equal(fence(cmd, SKEPTIC), true, `the skeptic was allowed to run: ${cmd}`);
  }
  // the same rule for the other helper that is fenced to its own globs
  assert.equal(fence("echo x > src/a.ts", QA), true, "QA was allowed to write source through Bash");

  // Reading, searching, diffing and running the tests are the helpers' job.
  const reads = [
    "git diff HEAD",
    "grep -rn foo src",
    "node --test tests/x.test.mjs",
    "ls -la",
    "cat src/a.ts 2>&1 | head",
  ];
  for (const cmd of reads) {
    assert.equal(fence(cmd, SKEPTIC), false, `the skeptic was denied a read-only command: ${cmd}`);
  }

  // The main session owns the diff, so none of this applies to it.
  for (const cmd of writes) {
    assert.equal(fence(cmd), false, `the main session was denied its own command: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// C12 — the Bash rule reads the command, not the characters in it
// ---------------------------------------------------------------------------

test("C12 boundary: a helper may shell-write under scratch paths and quote write words harmlessly, but never write source or run a git write command", () => {
  const repo = opened("skeptic-bash-scratch");

  const fence = (command, extra = {}) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const RV = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  const allowed = [
    // a stream discard is not a write
    "sed -n 1,5p x.mjs 2>/dev/null | grep -n foo",
    // write words inside a quoted string are text, not commands
    'git log --grep="fix: rm -rf bug"',
    'grep -n "sed -i" scripts/lib/guard.mjs',
    "node --test tests/x.test.mjs 2>&1 | tail -3",
    // scratch paths are the helper's own workspace
    "echo hi > /tmp/o.txt",
    "rm -rf tests/.tmp/h && git archive HEAD | tar -x -C tests/.tmp/h",
    "cp tests/x.test.mjs tests/.tmp/h/tests/",
  ];
  for (const cmd of allowed) {
    assert.equal(fence(cmd, RV), false, `the reviewer was denied a harmless command: ${cmd}`);
  }

  const denied = [
    "cp tests/.tmp/a src/b.ts", // a scratch source does not make the destination scratch
    "echo x > src/a.ts",
    "git commit -m x",
  ];
  for (const cmd of denied) {
    assert.equal(fence(cmd, RV), true, `the reviewer was allowed to write outside scratch: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// C13 — moving source away, and writing through an interpreter, are still writes
// ---------------------------------------------------------------------------

test("C13 refused: a helper cannot move source into scratch or write it through node or python, but may move and run scratch files", () => {
  const repo = opened("skeptic-bash-interp");

  const fence = (command, extra = {}) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const RV = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  const denied = [
    // a scratch destination does not excuse deleting the source file
    "mv src/a.ts /private/tmp/gone.ts",
    // an interpreter is a shell by another name
    `node -e "require('fs').writeFileSync('src/a.ts',1)"`,
    `python3 -c "open('src/a.ts','w')"`,
  ];
  for (const cmd of denied) {
    assert.equal(fence(cmd, RV), true, `the reviewer was allowed to write source: ${cmd}`);
  }

  const allowed = [
    "mv tests/.tmp/a tests/.tmp/b", // scratch to scratch
    "node tests/.tmp/x.mjs", // running a scratch script is not writing source
    "node --test tests/x.test.mjs",
  ];
  for (const cmd of allowed) {
    assert.equal(fence(cmd, RV), false, `the reviewer was denied a harmless command: ${cmd}`);
  }
});

// The reviewer's own instructions put `timeout 60` in front of a probe: a wrapper that runs the
// next words as a command is no cover for a write
test("C13b refused: timeout, gtimeout, nohup, nice, env and stdbuf in front of a writing interpreter are still writes; in front of a read they pass", () => {
  const repo = opened("skeptic-bash-wrapper");
  const fence = (command) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1", agent_id: "A2", agent_type: "done-gate:reviewer" }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
      // a wrapper flag the fence cannot step past must fail here, not hang the hook
      timeout: 10000,
    });
    assert.equal(r.error, undefined, `the fence hung on: ${command}`);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };
  const write = `node -e "require('fs').writeFileSync('src/a.ts',1)"`;
  for (const lead of ["timeout 60", "timeout -s KILL -k 5 60", "timeout --signal=TERM 10s", "timeout --signal KILL 60", "timeout --kill-after 5 60", "gtimeout 60", "nohup", "nice -n 5", "nice", "env FOO=1", "env -i", "env -i A=1 -u B", "stdbuf -oL", "timeout 60 nice -n 5", "command", "exec", "setsid", "ionice -c 3", "caffeinate -t 60"]) {
    assert.equal(fence(`${lead} ${write}`), true, `the reviewer was allowed to write source behind: ${lead}`);
  }
  for (const cmd of [`timeout 60 node -e "console.log(1)"`, "timeout 60 node --test tests/x.test.mjs", "nohup grep -n a src/a.ts", "command -v node", "command -p cat src/a.ts", "setsid -w cat src/a.ts", "nohup -x cat src/a.ts"]) {
    assert.equal(fence(cmd), false, `the reviewer was denied a harmless command: ${cmd}`);
  }
  // env's assignments change what a reader runs, as they do without env in front
  for (const cmd of ["env PATH=/tmp/evil cat src/a.ts", "env GIT_PAGER=vim git log", "env -i PAGER=sh git log"]) {
    assert.equal(readsOnly(cmd), false, `read as a plain read: ${cmd}`);
  }
  assert.equal(readsOnly("env -i A=1 cat src/a.ts"), true);
});

// ---------------------------------------------------------------------------
// C14 — `-r` belongs to its own command, not to every command
// ---------------------------------------------------------------------------

test("C14 refused: php -r that writes source is denied, while -r on grep, ls and node's preload flag stays allowed", () => {
  const repo = opened("skeptic-bash-dashr");

  const fence = (command, extra = {}) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const RV = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  // php -r runs code, the same hole as node -e and python3 -c
  assert.equal(
    fence(`php -r 'file_put_contents("src/a.ts","x");'`, RV),
    true,
    "the reviewer was allowed to write source through php -r",
  );

  // -r means recursive to grep, reverse to ls, and preload to node: none of them run code that writes
  const allowed = [
    "grep -r foo src",
    "ls -r",
    "node -r ./tests/.tmp/pre.js tests/.tmp/a.mjs",
  ];
  for (const cmd of allowed) {
    assert.equal(fence(cmd, RV), false, `the reviewer was denied a harmless -r command: ${cmd}`);
  }
});
}

// ===== 6.2: Can't verify and Lessons are recorded =====
{
const env = (repo) => { const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" }; delete e.CLAUDE_CODE_SESSION_ID; return e; };
const gateRun = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: env(repo) });
const ok = (repo, verb, args = []) => {
  const r = gateRun(repo, verb, args);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
};
const stateOf = (repo) => path.join(repo, ".claude", "gate");
const runOf = (repo) => path.join(stateOf(repo), "runs", loadSession(stateOf(repo), "S1").current);
const ledger = (repo) => JSON.parse(readFileSync(path.join(runOf(repo), "ledger.json"), "utf8"));
const lessonsFile = (repo) => path.join(stateOf(repo), "lessons.md");
const TODAY = () => new Date().toISOString().slice(0, 10);
const lessonLines = (repo) => readFileSync(lessonsFile(repo), "utf8").split("\n").filter((l) => l.startsWith("- "));
const packetOf = (out) => readFileSync(/packet: (\S+)/.exec(out)[1], "utf8");
const review = ({ cant = ["none"], lessons = ["none"], act = ["none"] } = {}) =>
  `# Review — x\n\n## Act on\n${act.map((t) => `- ${t}`).join("\n")}\n## Can't verify\n${cant.map((t) => `- ${t}`).join("\n")}\n## Lessons\n${lessons.map((t) => `- ${t}`).join("\n")}\n## Dismissed\n- none\n`;
function opened(name) {
  const repo = makeRepo(name);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  ok(repo, "open", [name, "feature"]);
  lookedUp(repo);
  ok(repo, "note", ["task", "Change a. [inferred]"]);
  ok(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  ok(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  ok(repo, "case", ["add", "renders", "--kind", "happy"]);
  write(repo, "src/a.ts", Array.from({ length: 20 }, (_, i) => `export const a${i} = ${i + 1};`).join("\n") + "\n");
  return repo;
}
function reviewed(repo, role, text) {
  const out = ok(repo, "brief", [role]);
  const own = /Your file is .*\/((?:review2?|skeptic)-\d+\.md)/.exec(out)[1];
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "SubagentStop", agent_id: `A-${role}-${own}`, agent_type: `done-gate:${role}` }), encoding: "utf8", env: env(repo) });
  writeFileSync(path.join(runOf(repo), own), text);
  ok(repo, "huddle", ["add", role, "--file", own]);
  return { out, own };
}

test("6.2 C1 C2: a reviewer file's Can't verify is stored and reported, its Lessons go to lessons.md, and the next reviewer packet points at it", () => {
  const repo = opened("rl-62-c1");
  const first = reviewed(repo, "reviewer", review({ cant: ["the retry path under a real timeout — no network here"], lessons: ["this repo's fixtures commit before they open a run"] }));
  assert.doesNotMatch(packetOf(first.out), /^## Lessons$/m, "the first packet, before any lesson, has no Lessons section");
  const huddle = ledger(repo).huddles.find((h) => h.role === "reviewer");
  assert.deepEqual(huddle.cantVerify, ["the retry path under a real timeout — no network here"]);
  assert.deepEqual(lessonLines(repo), [`- this repo's fixtures commit before they open a run (${TODAY()})`]);
  assert.match(ok(repo, "report"), /can't verify \(H\d+ reviewer\): the retry path under a real timeout/);
  const next = packetOf(ok(repo, "brief", ["reviewer-2"]));
  // the header's section, before the embedded review-1.md that has a Lessons heading of its own
  const head = next.slice(0, next.indexOf("\n## Diff"));
  assert.match(head, /^## Lessons$/m, "the next reviewer packet has no Lessons section");
  assert.ok(head.includes(lessonsFile(repo)), "the Lessons section does not name the file");
  assert.ok(!lessonsFile(repo).startsWith(runOf(repo)), "anchor: the lessons file lives outside the run, so a later run reads it");
});

test("6.2 C3 idempotent: adding the same file again appends nothing", () => {
  const repo = opened("rl-62-c3");
  const { own } = reviewed(repo, "reviewer", review({ lessons: ["one lesson", "two lesson"] }));
  ok(repo, "huddle", ["add", "reviewer", "--file", own]);
  assert.deepEqual(lessonLines(repo), [`- one lesson (${TODAY()})`, `- two lesson (${TODAY()})`]);
});

test("6.2 C4 edge: Can't verify and Lessons reading none write no lessons file, store no Can't verify, and the packet has no Lessons section", () => {
  const repo = opened("rl-62-c4");
  reviewed(repo, "reviewer", review());
  assert.equal(existsSync(lessonsFile(repo)), false);
  assert.equal(ledger(repo).huddles.find((h) => h.role === "reviewer").cantVerify, undefined);
  const next = packetOf(ok(repo, "brief", ["reviewer-2"]));
  assert.doesNotMatch(next.slice(0, next.indexOf("\n## Diff")), /^## Lessons$/m);
  assert.ok(!next.includes("lessons.md"));
});

test("6.2 C5 refused: a skeptic file's Lessons and Can't verify are ignored", () => {
  const repo = makeRepo("rl-62-c5");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  ok(repo, "open", ["rl-62-c5", "feature"]);
  lookedUp(repo);
  ok(repo, "note", ["task", "Change a. [inferred]"]);
  ok(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  ok(repo, "note", ["plan", "Two modules.", "--files", "src/a.ts,src/app/page.tsx"]);
  ok(repo, "case", ["add", "renders", "--kind", "happy"]);
  reviewed(repo, "skeptic", review({ cant: ["a thing"], lessons: ["a skeptic lesson"] }));
  assert.equal(existsSync(lessonsFile(repo)), false);
  assert.equal(ledger(repo).huddles.find((h) => h.role === "skeptic").cantVerify, undefined);
});

test("6.2 C6 boundary: past 50 lessons only the last 50 are kept, in order", () => {
  const repo = opened("rl-62-c6");
  reviewed(repo, "reviewer", review({ lessons: Array.from({ length: 30 }, (_, i) => `lesson ${i}`) }));
  reviewed(repo, "reviewer-2", review({ lessons: [...Array.from({ length: 25 }, (_, i) => `lesson ${i + 30}`), "LESSON  3"] }));
  const kept = lessonLines(repo);
  assert.equal(kept.length, 50);
  assert.equal(kept[0], `- lesson 5 (${TODAY()})`);
  assert.equal(kept[49], `- lesson 54 (${TODAY()})`);
  assert.equal(kept.filter((l) => /lesson\s+3 \(\d{4}-\d{2}-\d{2}\)$/i.test(l)).length, 0, "a repeat in other case and spacing is not a new lesson, and lesson 3 fell off the front");
});

const TODAY_F10 = () => new Date().toISOString().slice(0, 10);

test("F10 C1 idempotent: a lesson is dated today; the same text again, dated or not, adds nothing", async () => {
  const { addLessons } = await import("../scripts/lib/ledger.mjs");
  const dir = makeRepo("rl-f10c1");
  addLessons(dir, ["run the seed first"]);
  addLessons(dir, ["run the seed first", `run the seed first (${TODAY_F10()})`, "Run  the seed first"]);
  assert.deepEqual(readFileSync(path.join(dir, "lessons.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")), [`- run the seed first (${TODAY_F10()})`]);
});

test("F10 C2 boundary: a lesson past 90 days drops on the next write and at a reviewer brief; 89 days stays; an empty file goes", async () => {
  const { addLessons } = await import("../scripts/lib/ledger.mjs");
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const dir = makeRepo("rl-f10c2");
  writeFileSync(path.join(dir, "lessons.md"), `# Lessons from reviews of this repo\n\n- old one (${day(91)})\n- recent one (${day(89)})\n`);
  addLessons(dir, ["new one"]);
  assert.deepEqual(readFileSync(path.join(dir, "lessons.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")), [`- recent one (${day(89)})`, `- new one (${TODAY_F10()})`]);

  const repo = opened("rl-f10c2b");
  writeFileSync(lessonsFile(repo), `# Lessons from reviews of this repo\n\n- stale (${day(120)})\n`);
  const packet = packetOf(ok(repo, "brief", ["reviewer"]));
  assert.doesNotMatch(packet.slice(0, packet.indexOf("\n## Diff")), /^## Lessons$/m);
  assert.equal(existsSync(lessonsFile(repo)), false);
});

test("F10 C3 edge: an undated lesson from before is kept and dated today on the next write", async () => {
  const { addLessons } = await import("../scripts/lib/ledger.mjs");
  const dir = makeRepo("rl-f10c3");
  writeFileSync(path.join(dir, "lessons.md"), "# Lessons from reviews of this repo\n\n- from before dates\n");
  addLessons(dir, ["a fresh one"]);
  assert.deepEqual(readFileSync(path.join(dir, "lessons.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")), [`- from before dates (${TODAY_F10()})`, `- a fresh one (${TODAY_F10()})`]);
});
}
