// T2 — R14 (tier outgrown) and the blast-radius feature are gone; `gate note attention`
// and the Attention prose go with them. R8 keeps exactly two clauses: blank steps and
// open cases. Growth from small to standard still blanks {skeptic}; R8, not R14, names it.
//
// Written from the requirements and the case table, blind to the implementation.
//
// Sources of truth for the literals below:
//   - step keys ({skeptic}, {reconcile}, {read}, …): skills/gate/playbooks/*.md, the files
//     scripts/lib/ledger.mjs parses into ledger.steps — never the rule's own constants.
//   - the refusal shape (`done-gate: ` on stderr, exit 0): tests/smoke.test.mjs and
//     tests/waivers.test.mjs; scripts/gate.mjs always sets process.exitCode = 0.
//   - the `gate note` sections that survive: the task's requirements (task and plan).
//   - the run dir / ledger.json layout: scripts/lib/session-state.mjs.
//   - the old ledger shape hand-written in C3: a run opened by this CLI, plus the two
//     fields the previous version carried (`blast`, `tier.reopened`) and a {blast} step,
//     rewritten the way tests/waivers.test.mjs C4 rewrites a carried-over waiver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/rules.test.mjs, tests/waivers.test.mjs and
// tests/tier-policy.test.mjs)
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
  return r;
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
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
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r.stdout;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const closedRunDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).lastClosed);
const ledgerFileOf = (dir) => path.join(dir, "ledger.json");
const ledgerOf = (repo) => JSON.parse(readFileSync(ledgerFileOf(runDir(repo)), "utf8"));
const writeLedger = (repo, ledger) =>
  writeFileSync(ledgerFileOf(runDir(repo)), `${JSON.stringify(ledger, null, 2)}\n`);
const stepOf = (ledger, key) => ledger.steps.find((s) => s.key === key);

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// `gate check` prints one "<n>. <rule> — <text>" line per unmet rule, or "clean".
const ruleLines = (out, rule) => lines(out).filter((l) => new RegExp(`\\b${rule}\\b`).test(l));

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so tracked/clean files can be measured by `git diff --numstat`
// (tests/tier-policy.test.mjs owns this helper).
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// A Stop hook payload, exactly as tests/stop.test.mjs feeds one.
function stopHook(repo, message = "report", session = "S1") {
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
  return r;
}

const headings = (md) =>
  md.split("\n").flatMap((l) => {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    return m ? [m[1]] : [];
  });

// The vocabulary this task deletes. "side effect(s)" was the plain-language stand-in the
// brief printed for "blast radius"; with the feature gone neither word may appear.
const GONE_WORDS = [
  [/\bblast\b/i, "blast"],
  [/\brungs?\b/i, "rung"],
  [/\bside[- ]effects?\b/i, "side effect"],
];

// ---------------------------------------------------------------------------
// C1 refused — the verb and the note section are both gone
// ---------------------------------------------------------------------------

test("C1 refused: `gate blast` is an unknown verb and `gate note attention` is refused with the usage line", () => {
  const repo = makeRepo("size-policy-c1");
  cli(repo, "open", ["gone", "feature"]);
  cli(repo, "note", ["task", "Remove a feature. [inferred]"]);
  cli(repo, "note", ["plan", "Touch a few modules."]);

  // `gate blast add …` is no longer a verb: stderr says so, stdout stays empty, exit 0.
  const blast = run(repo, "blast", ["add", "only one consumer", "--rung", "2", "--proof", "src/a.ts:1"]);
  assert.match(blast.stderr, /unknown verb/, `\`gate blast\` still runs:\n${blast.stdout}${blast.stderr}`);
  assert.equal(blast.stdout.trim(), "", `\`gate blast\` wrote to stdout:\n${blast.stdout}`);

  // Nothing was recorded, and no step was marked by it.
  const afterBlast = ledgerOf(repo);
  assert.deepEqual(afterBlast.blast ?? [], [], "an unknown verb still appended a blast row");
  assert.equal(
    afterBlast.steps.find((s) => s.key === "blast"),
    undefined,
    "the playbook still carries a {blast} step",
  );

  // `gate note attention "…"` is refused, and the usage line names only the sections left.
  const note = refused(repo, "note", ["attention", "look at the null venue path first"]);
  const usage = lines(note.stderr).find((l) => /usage/i.test(l));
  assert.ok(usage, `the refusal carries no usage line:\n${note.stderr}`);
  assert.ok(usage.includes("task"), `the usage line does not offer \`task\`: ${usage}`);
  assert.ok(usage.includes("plan"), `the usage line does not offer \`plan\`: ${usage}`);
  assert.ok(!/attention/i.test(usage), `the usage line still offers \`attention\`: ${usage}`);

  // The refused note wrote nothing: ledger.md keeps Task and Plan and gains no section.
  const md = readFileSync(path.join(runDir(repo), "ledger.md"), "utf8");
  assert.ok(!/^##\s*Attention/im.test(md), `ledger.md grew an Attention section:\n${md}`);
  assert.deepEqual(headings(md), ["Task", "Plan"], `ledger.md sections changed:\n${md}`);

  // The surviving sections still work.
  cli(repo, "note", ["task", "Remove a feature, for real. [inferred]"]);
});

// ---------------------------------------------------------------------------
// C2 happy — growth still blanks {skeptic}; R8 names it, R14 is nowhere
// ---------------------------------------------------------------------------

test("C2 happy: growth from small to standard blanks {skeptic} and `gate check` names it under R8, never R14", () => {
  const repo = committed("size-policy-c2");
  cli(repo, "open", ["grow", "feature"]);
  cli(repo, "note", ["task", "One small change. [inferred]"]);
  cli(repo, "note", ["plan", "Touch one file.", "--files", "src/a.ts"]);

  // A one-file prediction is small, so the optional {skeptic} is auto-N/A'd: R8's blank-step
  // line must not name it yet.
  const predicted = ledgerOf(repo);
  assert.equal(predicted.tier.predicted, "small");
  assert.equal(stepOf(predicted, "skeptic").state, "N/A", "{skeptic} was not auto-N/A'd at small");

  const small = check(repo);
  assert.deepEqual(ruleLines(small, "R14"), [], `R14 still exists:\n${small}`);
  const smallR8 = ruleLines(small, "R8").join("\n");
  assert.ok(!smallR8.includes("{skeptic}"), `R8 names an N/A step:\n${smallR8}`);

  // Three source files: the measured diff outgrows small.
  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");

  const grown = check(repo);
  assert.deepEqual(ruleLines(grown, "R14"), [], `R14 fired on growth:\n${grown}`);

  const l = ledgerOf(repo);
  assert.equal(l.tier.measured.tier, "standard", "the measured tier did not grow");
  assert.equal(stepOf(l, "skeptic").state, null, "{skeptic} was not blanked by the growth");

  // R8 is now the rule that names it, as a blank step.
  const grownR8 = ruleLines(grown, "R8");
  const named = grownR8.find((line) => line.includes("{skeptic}"));
  assert.ok(named, `no R8 line names {skeptic} after the growth:\n${grown}`);
  assert.ok(/blank/i.test(named), `the R8 line does not say the step is blank: ${named}`);

  // The reopened bookkeeping is gone with R14: no ledger field, no marker on `gate steps`,
  // no line in the tier block.
  assert.ok(
    !("reopened" in (l.tier ?? {})),
    `ledger.tier still carries a reopened list: ${JSON.stringify(l.tier?.reopened)}`,
  );
  const steps = cli(repo, "steps").stdout;
  assert.ok(!/reopened/i.test(steps), `\`gate steps\` still marks a reopened step:\n${steps}`);
  const size = cli(repo, "size").stdout;
  assert.ok(!/reopened/i.test(size), `\`gate size\` still prints a reopened line:\n${size}`);

  // Closing the blanked step clears it from R8 again.
  cli(repo, "step", ["skeptic", "done", "huddled, two findings answered", "--evidence", "events#1"]);
  const after = check(repo);
  assert.ok(
    !ruleLines(after, "R8").join("\n").includes("{skeptic}"),
    `R8 still names a closed {skeptic}:\n${after}`,
  );
  assert.deepEqual(ruleLines(after, "R14"), [], after);
});

// ---------------------------------------------------------------------------
// C3 boundary — an old ledger.json, written before this change, still works
// ---------------------------------------------------------------------------

// The step line the old feature playbook produced, verbatim: carried-over data, echoed by
// the report rather than rewritten.
const OLD_BLAST_STEP_TEXT = "Blast radius (`gate blast add`): the fact the change is safe because of.";

test("C3 boundary: an old ledger.json carrying blast rows, a {blast} step and tier.reopened still loads, reports and closes", () => {
  const repo = committed("size-policy-c3");
  cli(repo, "open", ["carried", "feature"]);
  cli(repo, "note", ["task", "An old run, resumed. [inferred]"]);
  cli(repo, "note", ["plan", "One file.", "--files", "src/a.ts"]);

  // Rewrite the ledger in the shape the previous version stored: blast rows (one of them
  // with no rung at all, which R8 used to block on), a {blast} playbook step, and a
  // tier.reopened list naming a step that is blank again (what R14 used to fire on).
  const old = ledgerOf(repo);
  const lastStep = old.steps[old.steps.length - 1];
  old.blast = [
    { fact: "CourtCard is the only consumer", rung: 4, unproven: false, proof: "tests/a.test.ts", seq: 11 },
    { fact: "the sitemap does not read the badge", rung: null, unproven: true, proof: null, seq: 12 },
  ];
  old.steps = [
    ...old.steps,
    {
      n: lastStep.n + 1,
      key: "blast",
      text: OLD_BLAST_STEP_TEXT,
      state: "DONE",
      note: "two facts recorded",
      evidence: "ledger.json#blast",
      seq: 13,
    },
  ];
  stepOf(old, "skeptic").state = null; // reopened by the old R14 plumbing
  old.tier = { ...old.tier, reopened: ["skeptic"] };
  writeLedger(repo, old);

  // It loads: `gate check` runs clean of crashes, says nothing about R14 or rungs, and the
  // rung-less row raises nothing.
  const out = check(repo);
  assert.deepEqual(ruleLines(out, "R14"), [], `R14 fired on a carried-over ledger:\n${out}`);
  for (const [re, what] of GONE_WORDS) {
    const hit = lines(out).find((l) => re.test(l));
    assert.equal(hit, undefined, `\`gate check\` still talks about ${what}: ${JSON.stringify(hit)}`);
  }
  // The blank {skeptic} is still named, by R8 and nothing else.
  const named = ruleLines(out, "R8").find((l) => l.includes("{skeptic}"));
  assert.ok(named, `R8 does not name the blank {skeptic} of an old ledger:\n${out}`);

  // The old {blast} step survives untouched: an unknown key is data, not a crash.
  assert.equal(stepOf(ledgerOf(repo), "blast").state, "DONE", "the carried-over {blast} step was rewritten");

  // It reports: the full report renders with no Blast section and no rung wording.
  const report = cli(repo, "report");
  const reportMd = readFileSync(path.join(runDir(repo), "report.md"), "utf8");
  for (const md of [report.stdout, reportMd]) {
    assert.ok(headings(md).length > 0, `the report rendered no sections:\n${md}`);
    const bad = headings(md).find((h) => /blast/i.test(h));
    assert.equal(bad, undefined, `the report still has a Blast section: ${JSON.stringify(bad)}`);

    // The carried-over step is data, so its own text (which names the old verb) is echoed
    // under Steps. Every other trace of the feature is gone: no fact rows, no rungs.
    const carried = lines(md).filter((l) => l.includes(OLD_BLAST_STEP_TEXT));
    assert.equal(carried.length, 1, `the carried-over {blast} step was dropped from the report:\n${md}`);
    const rest = lines(md).filter((l) => !l.includes(OLD_BLAST_STEP_TEXT));
    for (const [re, what] of GONE_WORDS) {
      const hit = rest.find((l) => re.test(l));
      assert.equal(hit, undefined, `the report still mentions ${what}: ${JSON.stringify(hit)}`);
    }
    for (const fact of ["CourtCard is the only consumer", "the sitemap does not read the badge"]) {
      assert.ok(!md.includes(fact), `the report still renders a blast-radius fact: ${fact}`);
    }
  }

  // And it closes.
  for (const s of ledgerOf(repo).steps) {
    if (!s.state && s.key !== "close") cli(repo, "step", [String(s.n), "na", "carried-over run, nothing to do"]);
  }
  const closed = cli(repo, "close");
  assert.equal(ledgerOf(repo).status, "closing", `\`gate close\` did not close an old ledger:\n${closed.stdout}`);
});

// ---------------------------------------------------------------------------
// C4 happy — the brief and the full report for a closed run
// ---------------------------------------------------------------------------

// The clean-closing fixture tests/brief-report.test.mjs uses: the plan playbook, every
// step closed, no source touched, `gate close` run.
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

test("C4 happy: `gate report --brief` for a closed run has no Blast section, no attention prose and no rung or side-effect wording", () => {
  const repo = cleanClosingFixture("size-policy-c4", "shipped");
  stopHook(repo); // the Stop hook finalises a clean, closing run
  assert.equal(loadSession(stateDir(repo), "S1").current, null, "no run is open any more");

  const dir = closedRunDir(repo);
  const out = cli(repo, "report", ["--brief"]).stdout;

  // The brief still says something about the run it closed.
  assert.ok(lines(out).length >= 2, `the brief is empty:\n${out}`);
  assert.ok(out.includes("shipped") || /case/i.test(out), `the brief does not describe the run:\n${out}`);

  for (const [re, what] of [...GONE_WORDS, [/\battention\b/i, "attention"]]) {
    const hit = lines(out).find((l) => re.test(l));
    assert.equal(hit, undefined, `the brief still mentions ${what}: ${JSON.stringify(hit)}`);
  }

  // The full report written alongside it has neither section.
  const file = path.join(dir, "report.md");
  assert.ok(existsSync(file), `report.md was not written to the closed run dir: ${file}`);
  const md = readFileSync(file, "utf8");
  const hs = headings(md);
  assert.ok(hs.includes("Steps"), `report.md is not the full report (sections: ${hs.join(", ")})`);
  assert.equal(hs.find((h) => /blast/i.test(h)), undefined, `report.md still has a Blast section: ${hs.join(", ")}`);
  // The report keeps its Attention section (waivers, skips, unmet rules), but nothing in it
  // is free prose from ledger.md any more: every line is a bullet or the empty marker.
  const attention = md.split(/^## Attention\n/m)[1]?.split(/^## /m)[0] ?? "";
  for (const l of lines(attention)) {
    assert.ok(/^- /.test(l) || l === "_nothing flagged_", `free prose in report.md's Attention section: ${JSON.stringify(l)}`);
  }
  for (const [re, what] of GONE_WORDS) {
    const hit = lines(md).find((l) => re.test(l));
    assert.equal(hit, undefined, `report.md still mentions ${what}: ${JSON.stringify(hit)}`);
  }
});

// ---------------------------------------------------------------------------
// C5 edge — the reviewer packet
// ---------------------------------------------------------------------------

test("C5 edge: the reviewer brief packet has no Blast radius section", () => {
  const repo = committed("size-policy-c5", { "src/lib/x.ts": "export const x = 1;\n" });
  cli(repo, "open", ["packet", "feature"]);
  cli(repo, "note", ["task", "Give the reviewer a packet. [inferred]"]);
  cli(repo, "note", ["plan", "Touch one module.", "--files", "src/lib/x.ts"]);
  cli(repo, "case", ["add", "renders the packet", "--kind", "happy"]);
  write(repo, "src/lib/x.ts", "export const x = 2;\n");

  const r = cli(repo, "brief", ["reviewer"]);
  const packetPath = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(packetPath, `no "packet: <path>" line in:\n${r.stdout}`);
  const text = readFileSync(packetPath, "utf8");

  const hs = headings(text);
  // Not vacuous: the reviewer packet still carries the sections either side of the old one.
  assert.ok(hs.includes("Diff"), `the reviewer packet has no Diff section (sections: ${hs.join(", ")})`);
  assert.ok(hs.includes("Verify"), `the reviewer packet has no Verify section (sections: ${hs.join(", ")})`);
  assert.ok(
    hs.some((h) => /write your findings/i.test(h)),
    `the reviewer packet does not say where to write findings (sections: ${hs.join(", ")})`,
  );

  assert.equal(hs.find((h) => /blast/i.test(h)), undefined, `the packet still has a Blast section: ${hs.join(", ")}`);
  for (const [re, what] of GONE_WORDS) {
    const hit = lines(text).find((l) => re.test(l));
    assert.equal(hit, undefined, `the reviewer packet still mentions ${what}: ${JSON.stringify(hit)}`);
  }
});

// ---------------------------------------------------------------------------
// C6 edge — R8's two remaining clauses, and only those two
// ---------------------------------------------------------------------------

const cfg = loadConfig(makeRepo("size-policy-rules-cfg"));

function state(over = {}) {
  return {
    config: cfg,
    ledger: null,
    changed: [],
    now: { hash: "h-now", files: {} },
    verify: null,
    events: [],
    reviews: [],
    lastMessage: "",
    ...over,
  };
}

const ids = (unmet) => unmet.map((u) => u.rule);
const r8Of = (unmet) => unmet.filter((u) => u.rule === "R8");
const base = { status: "open", steps: [], waivers: [], cases: [], blast: [] };

test("C6 edge: R8 fires for a blank step and an open case, and for nothing else", () => {
  // 1. an open case
  const openCase = evaluate(state({ ledger: { ...base, cases: [{ id: "C1", status: "open", test: null, na: null }] } }));
  const caseLine = r8Of(openCase);
  assert.equal(caseLine.length, 1, `expected exactly one R8 for an open case: ${JSON.stringify(ids(openCase))}`);
  assert.ok(caseLine[0].text.includes("C1"), `the R8 line does not name C1: ${caseLine[0].text}`);

  // 2. a blank step, named by number and key
  const blankStep = evaluate(state({ ledger: { ...base, steps: [{ n: 4, key: "skeptic", state: null }] } }));
  const stepLine = r8Of(blankStep);
  assert.equal(stepLine.length, 1, `expected exactly one R8 for a blank step: ${JSON.stringify(ids(blankStep))}`);
  assert.ok(stepLine[0].text.includes("{skeptic}"), `the R8 line does not name {skeptic}: ${stepLine[0].text}`);
  assert.ok(stepLine[0].text.includes("4"), `the R8 line does not name step 4: ${stepLine[0].text}`);

  // 3. both at once: two R8 items, one per clause
  const both = evaluate(state({
    ledger: {
      ...base,
      cases: [{ id: "C1", status: "open", test: null, na: null }],
      steps: [{ n: 4, key: "skeptic", state: null }],
    },
  }));
  assert.equal(r8Of(both).length, 2, `expected one R8 per clause: ${JSON.stringify(r8Of(both).map((u) => u.text))}`);

  // 4. nothing else. Every case closed with a pointer, every step stated — and a carried-over
  //    blast row with no rung, which used to be R8's third clause, raises nothing.
  const clean = {
    ...base,
    cases: [
      { id: "C1", status: "closed", test: "tests/a.test.ts:one", na: null },
      { id: "C2", status: "closed", test: null, na: "covered by C1" },
    ],
    steps: [
      { n: 1, key: "read", state: "DONE" },
      { n: 2, key: "skeptic", state: "N/A" },
      { n: 3, key: "qa", state: "WAIVED" },
      { n: 4, key: "cleanup", state: "SKIPPED" },
    ],
    blast: [{ fact: "no rung on this one", rung: null, unproven: true, proof: null }],
    tier: { predicted: "small", predictedFiles: [], measured: null, autoNa: ["skeptic"], reopened: ["skeptic"] },
  };
  const none = evaluate(state({ ledger: clean }));
  assert.deepEqual(r8Of(none), [], `R8 fired with nothing blank and nothing open: ${JSON.stringify(r8Of(none))}`);

  // 5. R14 is gone everywhere, and no unmet item talks about rungs or blast radius.
  for (const unmet of [openCase, blankStep, both, none]) {
    assert.ok(!ids(unmet).includes("R14"), `R14 is still a rule: ${JSON.stringify(ids(unmet))}`);
    for (const u of unmet) {
      for (const [re, what] of GONE_WORDS) {
        assert.ok(!re.test(u.text), `${u.rule} still mentions ${what}: ${u.text}`);
      }
    }
  }
});
