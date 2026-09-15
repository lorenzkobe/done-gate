// T1 — waivers are key + reason: no transcript lookup, no claim labels.
// Written from the requirements and the case table, blind to the implementation.
//
// Sources of truth for the literals below:
//   - waiver step keys ("qa", "driver", …) and rule ids: scripts/lib/rules.mjs (R7 waives on
//     the step key "qa"; R11/R12 are the two rules this task removes).
//   - the dispute evidence pointer grammar: the `gate huddle dispute` usage string, which
//     names "a test (file:name), a file:line, verify.json, events#<seq> or a helper file".
//   - the run dir / ledger.json layout: scripts/lib/session-state.mjs + scripts/lib/ledger.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/rules.test.mjs for the repo, tests/review-dispute.test.mjs
// for the CLI: scripts/gate.mjs always sets process.exitCode = 0, so a refusal is a
// `done-gate: <message>` line on stderr, never a non-zero status)
// ---------------------------------------------------------------------------

const REFUSAL = /^done-gate: /m;

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1" } = {}) {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}

function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.match(r.stderr, REFUSAL, `expected \`gate ${verb} ${args.join(" ")}\` to be refused, got:\n${r.stdout}${r.stderr}`);
  return r;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const writeLedger = (repo, ledger) =>
  writeFileSync(path.join(runDir(repo), "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// `gate check` prints one "<n>. <rule> — <text>" line per unmet rule, or "clean".
const check = (repo) => run(repo, "check").stdout;
const ruleLine = (out, rule) => lines(out).find((l) => new RegExp(`\\b${rule}\\b`).test(l));

// A Stop hook payload, exactly as Claude Code feeds one (tests/stop.test.mjs owns the shape).
// `extra` lets a case leave transcript_path out entirely.
function stop(repo, message = "done.", extra = {}, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({
      session_id: session,
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: message,
      ...extra,
    }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return { ...r, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null };
}

const errorLog = (repo) => path.join(stateDir(repo), "gate-error.log");

// An open feature ledger over a repo whose only change is one source file — the exact
// shape R7 fires on (source changed, no test file changed).
function openedWithSourceEdit(name) {
  const repo = makeRepo(name);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Change one module."]);
  cli(repo, "note", ["plan", "One module.", "--files", "src/a.ts"]);
  write(repo, "src/a.ts", "export const a = 2;\n");
  return repo;
}

// ---------------------------------------------------------------------------
// C1 happy — `gate waive qa "<reason>"` needs no transcript, and the report says why
// ---------------------------------------------------------------------------

const QA_REASON = "no tests for this one, it is a prose-only change and I read it myself";

test("C1: waive qa records the reason with no transcript lookup, satisfies R7, and the report prints the reason", () => {
  const repo = openedWithSourceEdit("waivers-c1");

  // R7 is unmet before the waiver: source changed, no test file changed.
  assert.ok(ruleLine(check(repo), "R7"), `R7 did not fire on a source-only change:\n${check(repo)}`);

  const waived = cli(repo, "waive", ["qa", QA_REASON]);
  assert.doesNotMatch(
    waived.stdout,
    /transcript/i,
    `\`gate waive\` still promises a transcript lookup: ${waived.stdout}`,
  );

  // The waiver is key + reason. Nothing records a transcript verdict.
  const [w, ...rest] = ledgerOf(repo).waivers;
  assert.equal(rest.length, 0, "one waive recorded more than one waiver");
  assert.equal(w.key, "qa");
  assert.equal(w.reason, QA_REASON, `the waiver does not carry the reason: ${JSON.stringify(w)}`);
  assert.ok(!("found" in w), `the waiver still carries a transcript verdict: ${JSON.stringify(w)}`);
  assert.equal(typeof w.seq, "number", `the waiver has no seq: ${JSON.stringify(w)}`);

  // R7 is satisfied, and no rule complains about the waiver itself.
  const out = check(repo);
  assert.ok(!ruleLine(out, "R7"), `R7 still fires after \`gate waive qa\`:\n${out}`);
  assert.ok(!ruleLine(out, "R12"), `R12 fired on a waiver with no transcript:\n${out}`);

  // The report names the waived key and quotes the user's reason, without a transcript verdict.
  const md = cli(repo, "report").stdout;
  const waiverLine = lines(md).find((l) => /waived/i.test(l) && /\bqa\b/.test(l));
  assert.ok(waiverLine, `the report has no waiver line for qa:\n${md}`);
  assert.ok(waiverLine.includes(QA_REASON), `the report's waiver line drops the reason: ${waiverLine}`);
  assert.doesNotMatch(waiverLine, /transcript/i, `the report still reports a transcript verdict: ${waiverLine}`);

  // The plain-language brief says the same thing in the user's own words.
  const brief = cli(repo, "report", ["--brief"]).stdout;
  assert.ok(brief.includes(QA_REASON), `the brief drops the waiver reason:\n${brief}`);
  assert.doesNotMatch(brief, /could not find you saying/i, `the brief still hunts the transcript:\n${brief}`);
});

// ---------------------------------------------------------------------------
// C2 refused — pointerResolver survives the move out of claims.mjs
// ---------------------------------------------------------------------------

const FINDING = "null venue crashes the badge — src/a.ts:2 — venue is optional on the card";
const WHY = "the caller already null-checks venue before it renders the card";

test("C2: gate huddle dispute is refused when --evidence does not resolve, and accepted when it does", () => {
  const repo = openedWithSourceEdit("waivers-c2");
  writeFileSync(
    path.join(runDir(repo), "review-1.md"),
    `# Review 1 — waivers-c2\n\n## Act on\n- ${FINDING}\n\n## Consider\n- rename the helper\n`,
  );
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  const itemOf = (id) => ledgerOf(repo).huddles.flatMap((h) => h.actOn ?? []).find((a) => a.id === id);
  assert.ok(itemOf("H1.1"), `the reviewer finding was not recorded as H1.1: ${JSON.stringify(ledgerOf(repo).huddles)}`);

  // refused: a file that is in neither the run dir nor the repo
  const missingFile = refused(repo, "huddle", ["dispute", "H1.1", WHY, "--evidence", "src/nope.ts:12"]);
  assert.match(missingFile.stderr, /resolve/i, `the refusal does not say the pointer failed to resolve: ${missingFile.stderr}`);
  assert.equal(itemOf("H1.1").dispute ?? null, null, "a dispute was recorded with an unresolvable pointer");

  // refused: an events#<seq> pointer with no such event
  const missingEvent = refused(repo, "huddle", ["dispute", "H1.1", WHY, "--evidence", "events#99999"]);
  assert.match(missingEvent.stderr, /resolve/i, `the refusal does not say the pointer failed to resolve: ${missingEvent.stderr}`);
  assert.equal(itemOf("H1.1").dispute ?? null, null, "a dispute was recorded with an unresolvable events pointer");

  // refused: a helper file the run dir does not hold
  refused(repo, "huddle", ["dispute", "H1.1", WHY, "--evidence", "review-9.md"]);
  assert.equal(itemOf("H1.1").dispute ?? null, null, "a dispute was recorded against a helper file that does not exist");

  // permitted: a real file:line in the repo
  cli(repo, "huddle", ["dispute", "H1.1", WHY, "--evidence", "src/a.ts:2"]);
  const recorded = JSON.stringify(itemOf("H1.1").dispute);
  assert.ok(recorded.includes(WHY), `the dispute does not carry the why: ${recorded}`);
  assert.ok(recorded.includes("src/a.ts:2"), `the dispute does not carry the evidence pointer: ${recorded}`);
});

// ---------------------------------------------------------------------------
// C3 edge — no claim labels anywhere, and nothing asks for them
// ---------------------------------------------------------------------------

test("C3: an unlabelled claim in ledger.md or in the final message never produces an unmet R11", () => {
  const repo = openedWithSourceEdit("waivers-c3");
  appendFileSync(
    path.join(runDir(repo), "ledger.md"),
    "\n## Notes\n\nAll the tests pass and the build is green.\n",
  );

  const out = check(repo);
  assert.ok(!ruleLine(out, "R11"), `R11 fired on an unlabelled line in ledger.md:\n${out}`);
  assert.doesNotMatch(out, /\[measured\]|\[inferred\]|\[guess\]/, `a rule still asks for claim labels:\n${out}`);

  // The same claim as the turn's last message, through the real Stop hook.
  const blocked = stop(repo, "Tests pass, the build is green and there are no regressions.");
  const reason = blocked.json?.reason ?? "";
  assert.ok(!ruleLine(reason, "R11"), `the stop hook reported R11 for an unlabelled claim:\n${reason}`);
  assert.doesNotMatch(reason, /unlabelled/i, `the stop hook still complains about unlabelled claims:\n${reason}`);
  assert.doesNotMatch(reason, /\[measured\]|\[inferred\]|\[guess\]/, `the stop hook still asks for claim labels:\n${reason}`);
});

// ---------------------------------------------------------------------------
// C4 boundary — an old ledger.json, written before this change, still waives
// ---------------------------------------------------------------------------

test("C4: a waiver carried over with found:false still counts as waived, and never raises R12", () => {
  const repo = openedWithSourceEdit("waivers-c4");
  cli(repo, "waive", ["qa", QA_REASON]);

  // Rewrite the waiver in the shape the previous version stored: a quote plus a transcript
  // verdict of false. A ledger opened before this task can hold exactly this.
  const ledger = ledgerOf(repo);
  ledger.waivers = [{ key: "qa", quote: QA_REASON, found: false, seq: ledger.waivers[0].seq }];
  writeLedger(repo, ledger);

  const out = check(repo);
  assert.ok(!ruleLine(out, "R7"), `a waiver with found:false stopped waiving R7 (the match is on the key):\n${out}`);
  assert.ok(!ruleLine(out, "R12"), `R12 still fires on an old waiver's transcript verdict:\n${out}`);
  assert.doesNotMatch(out, /transcript/i, `a rule still talks about the transcript:\n${out}`);

  // The stop hook agrees with `gate check`, and leaves the old field alone.
  const reason = stop(repo).json?.reason ?? "";
  assert.ok(!ruleLine(reason, "R12"), `the stop hook reported R12 for an old waiver:\n${reason}`);
  assert.ok(!ruleLine(reason, "R7"), `the stop hook did not honour an old waiver:\n${reason}`);
  assert.equal(ledgerOf(repo).waivers[0].key, "qa", "the stop hook rewrote the carried-over waiver");
});

// ---------------------------------------------------------------------------
// C5 edge — the Stop hook no longer needs a transcript at all
// ---------------------------------------------------------------------------

test("C5: the stop hook with no transcript_path in the payload does not throw", () => {
  const repo = openedWithSourceEdit("waivers-c5");
  cli(repo, "waive", ["qa", QA_REASON]);
  cli(repo, "waive", ["driver", "no UI here, skip the phone pass"]);

  assert.ok(!existsSync(errorLog(repo)), "the repo already had a gate-error.log before the stop hook ran");

  // The payload carries no transcript_path key at all.
  const r = stop(repo, "A change and two waivers.");
  const both = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(both, /GATE ERROR/, `the stop hook failed open with a gate error:\n${both}`);
  assert.doesNotMatch(r.stderr, /at .*\.mjs/, `the stop hook threw:\n${r.stderr}`);
  assert.ok(!existsSync(errorLog(repo)), `the stop hook logged a gate error:\n${existsSync(errorLog(repo)) ? readFileSync(errorLog(repo), "utf8") : ""}`);

  const reason = r.json?.reason ?? "";
  assert.ok(!ruleLine(reason, "R11"), `the stop hook reported R11:\n${reason}`);
  assert.ok(!ruleLine(reason, "R12"), `the stop hook reported R12:\n${reason}`);
  assert.ok(!ruleLine(reason, "R7"), `the waiver did not satisfy R7 without a transcript:\n${reason}`);

  // A transcript_path that points nowhere is equally harmless: nothing reads it any more.
  const ghost = stop(repo, "Again.", { transcript_path: path.join(repo, "no-such-transcript.jsonl") });
  assert.doesNotMatch(`${ghost.stdout}${ghost.stderr}`, /GATE ERROR/, `a missing transcript file crashed the stop hook:\n${ghost.stderr}`);
  assert.ok(!existsSync(errorLog(repo)), "a missing transcript file logged a gate error");
  assert.ok(!ruleLine(ghost.json?.reason ?? "", "R12"), `R12 fired once a transcript path was supplied:\n${ghost.json?.reason}`);
});
