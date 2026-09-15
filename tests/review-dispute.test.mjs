// Task 9 — review completeness (R15), the dispute round and the arbiter.
// Written from the requirements, blind to the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { pointerResolver } from "../scripts/lib/rules.mjs";
import { reviewFiles } from "../scripts/lib/assess.mjs";

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
    out.includes("Reviewer found 3 problems, 2 fixed, 1 overruled by the arbiter."),
    `expected "Reviewer found 3 problems, 2 fixed, 1 overruled by the arbiter." in:\n${out}`,
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
  const all = lines(briefOut);
  const start = all.findIndex((l) => l.startsWith("Please look at first:"));
  assert.ok(start >= 0, `no look-first block in:\n${briefOut}`);
  const block = all.slice(start + 1);
  for (const phrase of ["sided with me", "sided with the reviewer", "waiting for the arbiter"]) {
    const hit = block.find((l) => l.includes(phrase));
    assert.ok(hit, `no look-first line says "${phrase}":\n${briefOut}`);
    assert.ok(hit.includes("disputed"), `the "${phrase}" line does not say the finding was disputed: ${hit}`);
  }
});

// ---------------------------------------------------------------------------
// C10 — the policy gains the arbiter and one more helper
// ---------------------------------------------------------------------------

test("C10 happy: models.json has roles.arbiter opus and ceiling 10; the tier block prints the ceiling", () => {
  const m = modelsJson();
  assert.equal(m.roles.arbiter, "opus", `models.json roles: ${JSON.stringify(m.roles)}`);
  assert.equal(m.policy.ceiling.helpersPerTask, 10, `models.json ceiling: ${JSON.stringify(m.policy.ceiling)}`);

  const repo = opened("rd-c10");
  const out = cli(repo, "size").stdout;
  assert.ok(out.includes("ceiling 10"), `\`gate size\` does not print the new ceiling:\n${out}`);
});

// ---------------------------------------------------------------------------
// C11 — the prose that ships with it
// ---------------------------------------------------------------------------

test("C11 boundary: agents/arbiter.md exists with opus, maxTurns 12 and a By turn 10 line; reviewer, reviewer-2 and skeptic files carry the Disputes instruction; SKILL.md mentions gate huddle dispute and stays under 4096 bytes; README lists R15", () => {
  const file = path.join(AGENTS_DIR, "arbiter.md");
  assert.ok(existsSync(file), `${file} does not exist`);
  const md = readFileSync(file, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(fm, "agents/arbiter.md has no frontmatter");
  assert.match(fm[1], /^name: arbiter$/m, `arbiter frontmatter:\n${fm[1]}`);
  assert.match(fm[1], /^model: opus$/m, `arbiter frontmatter:\n${fm[1]}`);
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
