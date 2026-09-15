// T8 — the review loop: the worker answers findings in worker-<n>.md, the reviewer's rounds
// are capped at three, and the review step's hint describes the whole loop.
// Written from the requirements and the case table, blind to the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { nextHint } from "../scripts/lib/next.mjs";

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
