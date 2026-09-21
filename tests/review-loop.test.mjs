import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { pointerResolver } from "../scripts/lib/rules.mjs";
import { reviewFiles } from "../scripts/lib/assess.mjs";
import { nextHint } from "../scripts/lib/next.mjs";

// ===== from tests/review-dispute.test.mjs =====
{
// Task 9 — review completeness (R15), the dispute round and the arbiter.
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

// An open feature ledger with a real HEAD and one changed source file, so the arbiter
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

// opened() + review-1.md (two findings), H1.2 disputed with evidence, and review-2.md
// upholding the dispute: the exact state `gate brief arbiter --item H1.2` is for.
function upheld(name, { findings = [FIND_1, FIND_2] } = {}) {
  const repo = opened(name);
  helperFile(repo, "review-1.md", reviewFile(1, name, findings));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  // H1.1 is fixed the ordinary way, so H1.2 is the only thing R5 can still be waiting on
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:empty list"]);
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);
  helperFile(repo, "review-2.md", reviewFile(2, name, [], `\n## Disputes\n- H1.2 — upheld: ${UPHELD_REASON}\n\n`));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1 — the three parsers read their own section and nothing else
// ---------------------------------------------------------------------------

test("C1 happy: parseFindings returns one entry per Act-on bullet and none for 'none' or a missing section; parseDisputes and parseRuling read their sections with ids and verdicts", async () => {
  const { parseFindings, parseDisputes, parseRuling } = await import("../scripts/lib/rules.mjs");

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

  const ruling = [
    "# Arbiter 1 — badge",
    "",
    "## Ruling",
    "- H1.2 — implementer: the caller's null check runs first",
    "- H1.4 — reviewer: the second caller passes null straight through",
    "",
  ].join("\n");
  assert.deepEqual(parseRuling(ruling), [
    { id: "H1.2", side: "implementer", reason: "the caller's null check runs first" },
    { id: "H1.4", side: "reviewer", reason: "the second caller passes null straight through" },
  ]);
  assert.deepEqual(parseRuling("# Arbiter 1 — badge\n\n## Notes\n- nothing\n"), []);
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
// C6 — the arbiter's file: fenced, pointable, embedded
// ---------------------------------------------------------------------------

test("C6 refused: the fence lets the arbiter write only arbiter-<n>.md in the current run; a [measured] (arbiter-1.md) pointer resolves; the report embeds the file", () => {
  const repo = upheld("rd-c6");
  const dir = runDir(repo);
  const ARBITER = { agent_id: "A7", agent_type: "done-gate:arbiter" };
  const REVIEWER = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  // permitted: its own file, in the session's own run dir
  assert.equal(fenceOut(repo, writePayload(path.join(dir, "arbiter-1.md"), ARBITER)), "", "the arbiter's own file was denied");

  // refused: source, another helper's file, its file outside the run dir, another run's dir
  assert.equal(denied(repo, writePayload(path.join(repo, "src/a.ts"), ARBITER)), true, "the arbiter was allowed to write source");
  assert.equal(denied(repo, writePayload(path.join(dir, "review-3.md"), ARBITER)), true, "the arbiter was allowed to write a review file");
  assert.equal(denied(repo, writePayload(path.join(repo, "arbiter-1.md"), ARBITER)), true, "an arbiter file outside the run dir was allowed");
  const other = path.join(stateDir(repo), "runs", "2020-01-01-other-run");
  mkdirSync(other, { recursive: true });
  assert.equal(denied(repo, writePayload(path.join(other, "arbiter-1.md"), ARBITER)), true, "the arbiter wrote into another task's run dir");

  // refused: arbiter files are fenced from everyone else
  assert.equal(denied(repo, writePayload(path.join(dir, "arbiter-1.md"), REVIEWER)), true, "the reviewer was allowed to write the arbiter's file");
  assert.equal(denied(repo, writePayload(path.join(dir, "arbiter-1.md"))), true, "the main session was allowed to write the arbiter's file");

  // a [measured] pointer at the arbiter's file resolves once the file exists
  helperFile(repo, "arbiter-1.md", arbiterFile(1, "rd-c6", "H1.2 — implementer: the caller's null check runs first"));
  const files = reviewFiles(dir);
  assert.ok(files.includes("arbiter-1.md"), `assess does not list arbiter-1.md, got ${JSON.stringify(files)}`);
  const resolves = pointerResolver({
    config: loadConfig(repo),
    changed: [],
    now: { hash: "x", files: {} },
    verify: null,
    events: [],
    reviews: files,
    root: repo,
    dir,
  });
  assert.equal(resolves("arbiter-1.md"), true, "a pointer at the arbiter's file does not resolve");
  assert.equal(resolves("arbiter-9.md"), false, "a pointer at a missing arbiter file resolves anyway");

  // the full report embeds it, the way it embeds every other helper file
  cli(repo, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);
  const md = cli(repo, "report").stdout;
  assert.ok(md.includes("<summary>arbiter-1.md</summary>"), `the report does not embed arbiter-1.md:\n${md}`);
  assert.ok(md.includes("the caller's null check runs first"), "the report embeds arbiter-1.md without its text");
});

// ---------------------------------------------------------------------------
// C7 — the arbiter packet
// ---------------------------------------------------------------------------

test("C7 happy: gate brief arbiter --item H1.2 writes a packet with the finding, the dispute why and evidence, the reviewer's upheld reason, the cited file's diff and the output path; without --item or for an undisputed item it is refused", () => {
  const repo = upheld("rd-c7");
  const dir = runDir(repo);

  const { text } = packet(repo, "arbiter", ["--item", "H1.2"]);
  assert.ok(text.includes(FIND_2), `the packet does not carry the finding:\n${text}`);
  assert.ok(text.includes(WHY), `the packet does not carry the implementer's why:\n${text}`);
  assert.ok(text.includes(EVIDENCE), `the packet does not carry the dispute's evidence pointer:\n${text}`);
  assert.ok(text.includes(UPHELD_REASON), `the packet does not carry the reviewer's upheld reason:\n${text}`);

  // the finding cites src/a.ts, so the packet must show that file's diff
  assert.ok(text.includes("diff --git"), `the packet carries no diff block:\n${text}`);
  assert.match(text, /diff --git a\/src\/a\.ts b\/src\/a\.ts/, `the diff is not of the file the finding cites:\n${text}`);

  const may = section(text, "You may write");
  assert.ok(
    may.includes(path.join(dir, "arbiter-1.md")),
    `the arbiter's "You may write" does not name ${path.join(dir, "arbiter-1.md")}:\n${may}`,
  );

  // refused: no --item
  const noItem = refused(repo, "brief", ["arbiter"]);
  assert.match(noItem.stderr, /--item/, `the refusal does not name --item: ${noItem.stderr}`);
  assert.ok(!noItem.stdout.includes("packet: "), `a packet was written without --item:\n${noItem.stdout}`);

  // refused: an item nobody disputed
  assert.equal(itemById(ledgerOf(repo), "H1.1").dispute ?? null, null, "premise: H1.1 was never disputed");
  const undisputed = refused(repo, "brief", ["arbiter", "--item", "H1.1"]);
  assert.ok(
    !undisputed.stdout.includes("packet: "),
    `an arbiter packet was written for an undisputed finding:\n${undisputed.stdout}`,
  );
});

// ---------------------------------------------------------------------------
// C8 — the ruling
// ---------------------------------------------------------------------------

test("C8 edge: gate huddle add arbiter --file arbiter-1.md with a ruling for the implementer closes the item as overruled; a ruling for the reviewer leaves it open until gate huddle resolve; R5 clears only then", () => {
  // --- implementer wins: the finding closes as overruled ---
  const win = upheld("rd-c8-implementer");
  helperFile(win, "arbiter-1.md", arbiterFile(1, "rd-c8-implementer", "H1.2 — implementer: the caller's null check runs first"));
  cli(win, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);
  const overruled = itemById(ledgerOf(win), "H1.2");
  assert.ok(overruled.closed, `the arbiter ruled for the implementer but the finding stayed open: ${JSON.stringify(overruled, null, 2)}`);
  assert.match(String(overruled.closed), /overruled/i, `the close reason does not say overruled: ${overruled.closed}`);
  assert.ok(String(overruled.closed).includes("arbiter-1.md"), `the close reason does not name the ruling file: ${overruled.closed}`);
  assert.equal(overruled.dispute.verdict, "arbiter:implementer");

  // --- reviewer wins: the finding stays open until it is actually fixed ---
  const lose = upheld("rd-c8-reviewer");
  // a source edit and a reviewer pass, so R5's only remaining objection is the open finding
  shellWrite(lose, "src/a.ts", "export const a = 3;\nexport const venue = null;\n");
  reviewerStop(lose);
  helperFile(lose, "arbiter-1.md", arbiterFile(1, "rd-c8-reviewer", "H1.2 — reviewer: the second caller passes null straight through"));
  cli(lose, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);
  const kept = itemById(ledgerOf(lose), "H1.2");
  assert.equal(kept.closed, null, "a finding the arbiter upheld for the reviewer must stay open");
  assert.equal(kept.dispute.verdict, "arbiter:reviewer");
  assert.ok(ruleLine(check(lose), "R5"), `R5 does not block while the arbiter's reviewer-side finding is open:\n${check(lose)}`);

  cli(lose, "huddle", ["resolve", "H1.2", "--evidence", "tests/a.test.ts:null venue"]);
  assert.ok(itemById(ledgerOf(lose), "H1.2").closed, "resolve did not close the finding");
  assert.ok(!ruleLine(check(lose), "R5"), `R5 still blocks after the finding was fixed:\n${check(lose)}`);
});

// ---------------------------------------------------------------------------
// C9 — both outcomes reach the user
// ---------------------------------------------------------------------------

test("C9 happy: the brief's review line reads n problems, k fixed, m overruled by the arbiter, and the look-first block names each disputed finding with its outcome or 'waiting for the arbiter'", () => {
  // three findings: two fixed, one disputed, upheld, then overruled by the arbiter
  const repo = opened("rd-c9");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c9", [FIND_1, FIND_2, FIND_3]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:empty list"]);
  cli(repo, "huddle", ["resolve", "H1.3", "--evidence", "tests/a.test.ts:unknown role"]);
  cli(repo, "huddle", ["dispute", "H1.2", WHY, "--evidence", EVIDENCE]);
  helperFile(repo, "review-2.md", reviewFile(2, "rd-c9", [], `\n## Disputes\n- H1.2 — upheld: ${UPHELD_REASON}\n\n`));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  helperFile(repo, "arbiter-1.md", arbiterFile(1, "rd-c9", "H1.2 — implementer: the caller's null check runs first"));
  cli(repo, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);

  const out = cli(repo, "report", ["--brief"]).stdout;
  assert.ok(
    out.includes("found 3 problems, 2 fixed, 1 overruled by the arbiter."),
    `expected "found 3 problems, 2 fixed, 1 overruled by the arbiter." in:\n${out}`,
  );

  // one ledger carrying all three dispute outcomes at once
  const three = opened("rd-c9-outcomes");
  helperFile(three, "review-1.md", reviewFile(1, "rd-c9-outcomes", [FIND_1, FIND_2, FIND_3]));
  cli(three, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  for (const id of ["H1.1", "H1.2", "H1.3"]) {
    cli(three, "huddle", ["dispute", id, WHY, "--evidence", EVIDENCE]);
  }
  helperFile(
    three,
    "review-2.md",
    reviewFile(2, "rd-c9-outcomes", [], `\n## Disputes\n- H1.1 — upheld: ${UPHELD_REASON}\n- H1.2 — upheld: ${UPHELD_REASON}\n- H1.3 — upheld: ${UPHELD_REASON}\n\n`),
  );
  cli(three, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  helperFile(
    three,
    "arbiter-1.md",
    `# Arbiter 1 — rd-c9-outcomes\n\n## Ruling\n- H1.1 — implementer: the caller's null check runs first\n- H1.2 — reviewer: the second caller passes null straight through\n`,
  );
  cli(three, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);

  const briefOut = cli(three, "report", ["--brief"]).stdout;
  const forYou = lines(briefOut).find((l) => l.startsWith("For you:"));
  assert.ok(forYou, `no "For you:" line in:\n${briefOut}`);
  for (const phrase of ["sided with me", "sided with the reviewer", "waiting for the arbiter"]) {
    assert.ok(forYou.includes(phrase), `the For you line does not say "${phrase}":\n${briefOut}`);
  }
});

// ---------------------------------------------------------------------------
// C10 — the policy gains the arbiter and one more helper
// ---------------------------------------------------------------------------

test("C10 happy: models.json names no model and a ceiling of 10; the tier block prints the ceiling", () => {
  const m = modelsJson();
  assert.ok(!("roles" in m), `models.json still names models: ${JSON.stringify(m.roles)}`);
  assert.equal(m.policy.ceiling.helpersPerTask, 10, `models.json ceiling: ${JSON.stringify(m.policy.ceiling)}`);

  const repo = opened("rd-c10");
  const out = cli(repo, "size").stdout;
  assert.ok(out.includes("ceiling 10"), `\`gate size\` does not print the new ceiling:\n${out}`);
});

// ---------------------------------------------------------------------------
// C11 — the prose that ships with it
// ---------------------------------------------------------------------------

test("C11 boundary: agents/arbiter.md exists with model inherit, maxTurns 12 and a By turn 10 line; reviewer, reviewer-2 and skeptic files carry the Disputes instruction; SKILL.md mentions gate huddle dispute and stays under 4096 bytes; README lists R15", () => {
  const file = path.join(AGENTS_DIR, "arbiter.md");
  assert.ok(existsSync(file), `${file} does not exist`);
  const md = readFileSync(file, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(fm, "agents/arbiter.md has no frontmatter");
  assert.match(fm[1], /^name: arbiter$/m, `arbiter frontmatter:\n${fm[1]}`);
  assert.match(fm[1], /^model: inherit$/m, `arbiter frontmatter:\n${fm[1]}`);
  assert.match(fm[1], /^maxTurns: 12$/m, `arbiter frontmatter:\n${fm[1]}`);
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  assert.ok(body.includes("By turn 10"), "agents/arbiter.md has maxTurns 12 but no \"By turn 10\" line");
  assert.ok(body.includes("arbiter-<n>.md"), "agents/arbiter.md never names the file it writes");

  for (const name of ["reviewer", "reviewer-2", "skeptic"]) {
    const text = readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf8");
    assert.ok(text.includes("## Disputes"), `agents/${name}.md carries no "## Disputes" instruction`);
  }

  const size = statSync(SKILL_MD).size;
  assert.ok(size < 4096, `skills/gate/SKILL.md is ${size} bytes, the budget is 4096`);
  assert.ok(
    readFileSync(SKILL_MD, "utf8").includes("gate huddle dispute"),
    "skills/gate/SKILL.md never names `gate huddle dispute`",
  );

  assert.ok(readFileSync(README, "utf8").includes("R15"), "README.md does not list R15");
});

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
  assert.ok(!ruleLine(check(repo), "R15"), `R15 fired while the skeptic file matched the ledger:\n${check(repo)}`);

  helperFile(repo, "skeptic-1.md", `# Skeptic 1 — rd-c12\n\n## Act on\n- ${A}\n- ${B}\n- ${C}\n## Consider\n- rename it\n`);
  const line = ruleLine(check(repo), "R15");
  assert.ok(line, `R15 does not cover the skeptic huddle:\n${check(repo)}`);
  assert.ok(line.includes("skeptic-1.md"), `the R15 line does not name the skeptic file: ${line}`);
});

// ---------------------------------------------------------------------------
// C13 — an overruled finding is not an open finding, and the round is capped
// ---------------------------------------------------------------------------

test("C13 refused: an overruled item does not count as open for R5, and the dispute round is capped: no dispute on an item the arbiter ruled on", () => {
  const repo = upheld("rd-c13");
  // a source edit and a reviewer pass after it, so the only thing R5 can still object to
  // is the open finding
  shellWrite(repo, "src/a.ts", "export const a = 3;\nexport const venue = null;\n");
  reviewerStop(repo);
  assert.ok(ruleLine(check(repo), "R5"), `premise: R5 blocks while H1.2 is open:\n${check(repo)}`);

  helperFile(repo, "arbiter-1.md", arbiterFile(1, "rd-c13", "H1.2 — implementer: the caller's null check runs first"));
  cli(repo, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);
  assert.ok(
    !ruleLine(check(repo), "R5"),
    `an overruled finding still counts as open for R5:\n${check(repo)}`,
  );

  // ruled on → no second dispute, whichever way it went
  refused(repo, "huddle", ["dispute", "H1.2", "I still disagree", "--evidence", "src/a.ts:1"]);
  assert.equal(itemById(ledgerOf(repo), "H1.2").dispute.verdict, "arbiter:implementer", "the re-dispute changed the verdict");

  // the same when the arbiter ruled for the reviewer and the finding is still open
  const forReviewer = upheld("rd-c13-reviewer");
  helperFile(forReviewer, "arbiter-1.md", arbiterFile(1, "rd-c13-reviewer", "H1.2 — reviewer: the second caller passes null straight through"));
  cli(forReviewer, "huddle", ["add", "arbiter", "--file", "arbiter-1.md"]);
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

test("C15 refused: gate huddle add reviewer, skeptic and arbiter without --file are refused by name and record no huddle, while gate huddle add qa --summary still works", () => {
  const repo = opened("rd-c15");
  assert.deepEqual(ledgerOf(repo).huddles, [], "premise: no huddle yet");

  for (const role of ["reviewer", "skeptic", "arbiter"]) {
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
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c18", [FIND_1]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

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

test("C19 refused: a Bash command from the main session that touches a recorded review file is denied, whether it writes or only reads it, while the Read tool is not fenced", () => {
  const repo = opened("rd-c19");
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c19", [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  // the path as a shell command would spell it, from the repo root
  const rel = path.relative(repo, path.join(runDir(repo), "review-1.md"));
  const bash = (command) => denied(repo, { tool_name: "Bash", tool_input: { command } });

  // No agent_type at all: this is the main session, the one that owns the diff.
  assert.equal(bash(`sed -i '' '/^- /d' ${rel}`), true, `the main session was allowed to strip findings: sed -i '' '/^- /d' ${rel}`);
  assert.equal(bash(`echo x >> ${rel}`), true, `the main session was allowed to append to the review file: echo x >> ${rel}`);
  assert.equal(bash(`cat ${rel}`), true, `a shell command naming the review file was allowed: cat ${rel}`);

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
  helperFile(repo, "review-1.md", reviewFile(1, "rd-c21", [FIND_1, FIND_2]));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

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
    /nope-nothing|resolve|pointer/i,
    `the refusal does not say the pointer does not resolve: ${r.stderr}`,
  );
  assert.equal(
    itemById(ledgerOf(repo), "H1.1").closed,
    null,
    "an unresolvable pointer closed the finding anyway",
  );

  // the same pointer `gate huddle resolve` refuses is the one `reply` must refuse
  refused(repo, "huddle", ["resolve", "H1.1", "--evidence", "nope-nothing"]);

  // and a pointer that does resolve still closes it, so the refusal was about the pointer
  helperFile(repo, "worker-2.md", workerFile(2, "rl-c2", ["H1.1 — fixed: src/a.ts:3"]));
  cli(repo, "huddle", ["reply", "--file", "worker-2.md"]);
  assert.equal(itemById(ledgerOf(repo), "H1.1").closed, "src/a.ts:3");
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
// C6 — three reviewer rounds, then the arbiter
// ---------------------------------------------------------------------------

test("C6 refused: gate brief reviewer --round 4, and a natural fourth round after three reviewer huddles, are refused and the message names gate brief arbiter; round 3 still writes its packet", () => {
  // --- the round asked for explicitly ---
  const explicit = reviewed("rl-c6");
  const r = refused(explicit, "brief", ["reviewer", "--round", "4"]);
  assert.ok(
    r.stderr.includes("gate brief arbiter"),
    `the refusal does not point at the arbiter: ${r.stderr}`,
  );
  assert.ok(!r.stdout.includes("packet: "), `a fourth-round reviewer packet was written anyway:\n${r.stdout}`);

  // round 3 is still allowed
  const third = cli(explicit, "brief", ["reviewer", "--round", "3"]);
  assert.match(third.stdout, /^packet: .*brief-reviewer-3\.md$/m, `no round-3 packet:\n${third.stdout}`);

  // --- the round the ledger arrives at by itself ---
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
    fourth.stderr.includes("gate brief arbiter"),
    `the natural fourth round's refusal does not name gate brief arbiter: ${fourth.stderr}`,
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

test("C8 happy: the next: hint for the {review} step names gate brief reviewer, gate huddle add, gate brief worker, SendMessage, gate huddle reply and the arbiter after round 3", () => {
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
    status: "open",
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
    ["the arbiter", /arbiter/],
  ]) {
    assert.match(h, re, `the {review} hint never names ${what}:\n${h}`);
  }
  // the arbiter is where the loop ends, after the third round
  assert.match(
    h,
    /\bthree\b|\bthird\b|\b3\b/,
    `the {review} hint does not say the loop caps at three rounds:\n${h}`,
  );
  // the worker answers in worker-<n>.md, and the reviewer's file is what the loop feeds it
  assert.match(h, /worker-<n>\.md/, `the hint does not name the file the worker writes:\n${h}`);
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
  cli(gone, "huddle", ["add", "skeptic", "--file", "skeptic-9.md"]);
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

  // n is one past the highest existing skeptic file.
  writeFileSync(path.join(dir, "skeptic-1.md"), "# Skeptic 1 — skeptic-packet\n");
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
    record(cli(repo, "step", [key, "done", `${key} done`, "--evidence", "events#1"]).stdout);
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
  const dir = runDir(repo);
  writeFileSync(path.join(dir, "review-1.md"), "# Review 1\n\n## Act on\n\n_none_\n");
  writeFileSync(path.join(dir, "skeptic-1.md"), "# Skeptic 1 — skeptic-round2\n\n## Act on\n\n_none_\n");

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
