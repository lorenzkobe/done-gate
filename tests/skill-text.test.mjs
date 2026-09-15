// T10 — the prose that ships with the team flow: skills/gate/SKILL.md, hooks/session-start.md
// and README.md. Written from the requirements and the case table, blind to the edits.
//
// Sources of truth for every literal asserted here:
//   - the 4096-byte SKILL budget .......... tests/skeptic-file.test.mjs C7, tests/review-dispute.test.mjs C11
//   - `gate brief worker` / done-gate:worker ... scripts/lib/rules.mjs (R16 text), scripts/lib/guard.mjs, agents/worker.md
//   - `gate huddle reply --file worker-<n>.md` . scripts/lib/verbs.mjs
//   - the resume message ("write <file> now") .. scripts/lib/brief.mjs
//   - the rule ids README may list ............. scripts/lib/rules.mjs, the only place a rule id is minted
//
// Assertions are on the words and phrases the requirements name, never on whole sentences:
// the wording is the writer's, the vocabulary is the requirement's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pluginRoot } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// conventions
// ---------------------------------------------------------------------------

const SKILL_MD = path.join(pluginRoot, "skills", "gate", "SKILL.md");
const SESSION_START = path.join(pluginRoot, "hooks", "session-start.md");
const README = path.join(pluginRoot, "README.md");
const RULES_MJS = path.join(pluginRoot, "scripts", "lib", "rules.mjs");

const read = (file) => readFileSync(file, "utf8");
// Markdown wraps: a phrase may be split across lines, so most checks run on the text with
// every run of whitespace collapsed to a single space.
const flat = (s) => s.replace(/\s+/g, " ");
const linesOf = (s) => s.split("\n");

function has(text, needle, file, why = "") {
  assert.ok(
    flat(text).includes(needle),
    `${file} never says ${JSON.stringify(needle)}${why ? ` (${why})` : ""}`,
  );
}

// assert.match would print the whole file on failure; these files are the thing under test
// and QA is blind to them, so a failure says what is missing, not what is there.
function matches(text, re, file, why = "") {
  assert.ok(
    re.test(flat(text)),
    `${file} has nothing matching ${re}${why ? ` (${why})` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// C1 — SKILL.md fits the budget and names every verb and agent the team loop needs
// ---------------------------------------------------------------------------

test("C1 happy: SKILL.md stays under 4096 bytes and names the whole team loop — open/note/case, brief worker, done-gate:worker, SendMessage, huddle reply, huddle dispute, arbiter, three rounds, ten helpers, verify, report --brief, and the write-now resume", () => {
  const size = statSync(SKILL_MD).size;
  assert.ok(size < 4096, `skills/gate/SKILL.md is ${size} bytes, the budget is 4096`);

  const md = read(SKILL_MD);
  const file = "skills/gate/SKILL.md";

  // the verbs the loop is driven by (spelled as the CLI spells them)
  for (const verb of [
    "gate open",
    "gate note",
    "gate case",
    "gate brief worker",
    "gate huddle reply",
    "gate huddle dispute",
    "gate verify",
    "gate report --brief",
  ]) {
    has(md, verb, file, "the loop is driven by this verb");
  }

  // the worker agent, and the one way the lead talks to a running helper
  has(md, "done-gate:worker", file, "the agent the lead spawns per piece");
  has(md, "SendMessage", file, "how the lead relays a review file to a running worker");

  // the review loop's shape: three rounds, then the arbiter
  matches(md, /three rounds/i, file, "the round cap");
  matches(md, /arbiter/i, file, "what settles a dispute after round three");

  // the helper ceiling — ten per task
  matches(md, /\bten\b[^.]{0,40}helper/i, file, "the ceiling of ten helper invocations");

  // A helper that stops without its file is resumed exactly once, with the "write <file> now"
  // message scripts/lib/brief.mjs itself prints; the next round waits for the file. The
  // requirement is the rule, not the word "resume", so the substance is what is pinned:
  // the no-file case, the once, the message, and the refusal to go on without the file.
  matches(md, /(no file|without (its|the|a) file|stops? with no file)/i, file, "the case the rule covers: a helper that stopped without its file");
  matches(md, /\bonce\b/i, file, "the helper is nudged once, not repeatedly");
  matches(md, /write [^.]{0,40}\bnow\b/i, file, 'the "write <file> now" resume message');
  matches(md, /never brief[^.]{0,60}(file|round)/i, file, "no next round without the file");
});

// ---------------------------------------------------------------------------
// C2 — the two standing rules the rewrite must not drop
// ---------------------------------------------------------------------------

test("C2 edge: SKILL.md still bans the gate's own words from the final message and still says to ask before step 2 when the ask is ambiguous", () => {
  const md = read(SKILL_MD);
  const file = "skills/gate/SKILL.md";

  // the final message is in plain words: never the gate's own vocabulary
  matches(md, /never[^.]{0,90}ledger/i, file, 'the final message must never say "ledger"');
  matches(md, /huddle"/i, file, 'the final message must never say "huddle"');
  matches(md, /rule number/i, file, "the final message must never quote a rule number");

  // an ambiguous ask is a question, asked before the Plan and case table go in
  has(md, "AskUserQuestion", file, "how the lead asks");
  matches(md, /before step 2/i, file, "when to ask: before the Plan and case table");
});

// ---------------------------------------------------------------------------
// C3 — who edits source, by size
// ---------------------------------------------------------------------------

test("C3 happy: SKILL.md says a small edit is the lead's own and that standard or large goes to a worker who owns the file", () => {
  const md = read(SKILL_MD);
  const file = "skills/gate/SKILL.md";

  // small: the lead edits it itself
  matches(md, /small[^.]{0,120}\b(yourself|your own)\b/i, file, "at size small the lead edits");

  // standard and large: the lead never edits source; each piece goes to a worker
  matches(
    md,
    /(standard|large)[^.]{0,160}worker|worker[^.]{0,160}(standard|large)/i,
    file,
    "at standard and large the piece belongs to a worker",
  );
  matches(md, /never edit[^.]{0,40}source|never[^.]{0,40}edit source/i, file, "the lead never edits source at a delegated size");
});

// ---------------------------------------------------------------------------
// C4 — the session-start block carries the same two facts before the skill loads
// ---------------------------------------------------------------------------

test("C4 happy: hooks/session-start.md says the lead never edits source at standard or large and that a helper writes its file first", () => {
  const md = read(SESSION_START);
  const file = "hooks/session-start.md";

  matches(md, /never edit[^.]{0,60}source|never[^.]{0,60}edit source/i, file, "the lead-delegates line");
  matches(md, /standard/i, file, "the sizes the delegation applies at");
  matches(md, /large/i, file, "the sizes the delegation applies at");

  // a helper's reply is not the deliverable: its file is, and it comes first
  matches(
    md,
    /file first|first[^.]{0,30}file|writes? [^.]{0,40}file [^.]{0,30}before/i,
    file,
    "helpers write their file before they reply",
  );
});

// ---------------------------------------------------------------------------
// C5 — README's tables: exactly the live rules, and the two new verbs
// ---------------------------------------------------------------------------

test("C5 edge: README's rule table lists exactly R1-R10, R13, R15 and R16 — the ids scripts/lib/rules.mjs can emit — and the verbs table names huddle reply and brief worker", () => {
  const md = read(README);

  // every line that opens a rule row, in the order README lists them
  const listed = linesOf(md)
    .filter((l) => /^\| R/.test(l))
    .map((l) => /^\| (R\d+)/.exec(l)?.[1] ?? l);

  const expected = [
    "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10",
    "R13", "R15", "R16",
  ];
  assert.deepEqual(listed, expected, `README.md's rule table rows:\n${listed.join(", ")}`);

  // and that list is not a wish: it is exactly the set of ids the engine can put in `unmet`
  const minted = [...read(RULES_MJS).matchAll(/rule:\s*"(R\d+)"/g)].map((m) => m[1]);
  const uniqueMinted = [...new Set(minted)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  assert.deepEqual(
    [...listed].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    uniqueMinted,
    "README's rule table and the rule ids scripts/lib/rules.mjs emits have drifted apart",
  );

  // the verbs table gained the two verbs the team loop runs on; both in a table row,
  // not merely somewhere in the prose
  const rows = linesOf(md).filter((l) => l.startsWith("|"));
  const rowHas = (needle) => rows.some((r) => r.includes(needle));
  assert.ok(rowHas("huddle reply"), "README.md's verbs table has no `huddle reply` row");
  // `brief worker` may be written as one row listing the roles (`brief <skeptic|qa|worker|…>`),
  // so the pin is: one table row names both the verb and the role.
  assert.ok(
    rows.some((r) => /\bbrief\b/.test(r) && /\bworker\b/.test(r)),
    "no row of README.md's verbs table names `brief` and `worker` together",
  );
});

// ---------------------------------------------------------------------------
// C6 — the existing SKILL pins. Nothing new runs here: they live in
//   tests/skeptic-file.test.mjs   "C7 boundary: SKILL.md stays under 4096 bytes …"
//       → SKILL.md < 4096 bytes and still names `skeptic-<n>.md`
//   tests/review-dispute.test.mjs "C11 boundary: agents/arbiter.md exists …"
//       → SKILL.md < 4096 bytes, still names `gate huddle dispute`, README still lists R15
// Both run in the same `node --test tests/` pass as this file; duplicating them here would
// pin the same facts twice, so C6 is covered by re-running those two files unchanged.
// ---------------------------------------------------------------------------
