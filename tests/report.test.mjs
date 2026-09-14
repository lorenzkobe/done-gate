import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { lintClaims, findQuoteInTranscript } from "../scripts/lib/claims.mjs";

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
  cli(repo, "blast", ["add", "only one consumer", "--rung", "2", "--proof", "src/a.ts:1"]);
  cli(repo, "step", ["read", "done", "read it", "--evidence", "events#1"]);
  cli(repo, "step", ["cleanup", "skipped", "tiny change"]);
  cli(repo, "waive", ["driver", "skip the phone pass"]);
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n- null venue crashes\n");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["acton", "H1", "null venue crashes"]);
  cli(repo, "decide", ["plan", "kept it simple", "one consumer", "src/a.ts", "open"]);
  write(repo, "src/a.ts", "changed\n");
  const r = cli(repo, "report");
  const md = r.stdout;
  assert.match(md, /^# badge — feature/m);
  assert.match(md, /DONE 4 · SKIPPED 1 · WAIVED 1 · N\/A 0 · blank \d+/);
  assert.match(md, /cases 1\/1 closed/);
  assert.match(md, /blast 1 fact\(s\), 1 unproven/);
  assert.match(md, /## Task\n\nAdd a badge/);
  assert.match(md, /\| C1 \| renders badge \| happy \| tests\/a\.test\.ts:renders \|/);
  assert.match(md, /only one consumer \| 2 \| unproven/);
  assert.match(md, /1\. Read the affected code.*DONE.*events#1/);
  assert.match(md, /null venue crashes.*OPEN/);
  assert.match(md, /# Review 1/);
  assert.match(md, /## Changed files\n[\s\S]*src\/a\.ts/);
  assert.match(md, /kept it simple/);
  assert.match(md, /## Attention[\s\S]*waived.*driver/i);
  assert.match(md, /unproven/);
  assert.ok(existsSync(path.join(runDir(repo), "report.md")));
  assert.equal(readFileSync(path.join(runDir(repo), "report.md"), "utf8"), md);
});

test("lintClaims flags unlabelled success claims and unresolvable [measured] pointers, accepts labelled ones", () => {
  const resolves = (ptr) => ptr === "verify.json" || ptr === "events#1";
  assert.deepEqual(lintClaims("Tests pass now.", resolves).map((f) => f.kind), ["unlabelled"]);
  assert.deepEqual(lintClaims("The build passes [measured] (verify.json).", resolves), []);
  assert.deepEqual(lintClaims("All green [measured] (events#999).", resolves).map((f) => f.kind), ["unresolved"]);
  assert.deepEqual(lintClaims("It should work now [inferred].", resolves), []);
  assert.deepEqual(lintClaims("Probably fixed [guess].", resolves), []);
  assert.deepEqual(lintClaims("PAUSED: need the key", resolves), []);
  assert.deepEqual(lintClaims("## Task\n\nthe user wants the badge fixed", resolves), [], "quoting the ask is not a claim");
});

test("findQuoteInTranscript matches the user's words case- and whitespace-insensitively, only in user lines", () => {
  const file = path.join(here, "fixtures", "transcript.jsonl");
  assert.equal(findQuoteInTranscript(file, "skip the phone pass this time, chrome is   disconnected"), true);
  assert.equal(findQuoteInTranscript(file, "I will waive the driver step"), false, "assistant text does not count");
  assert.equal(findQuoteInTranscript(file, "never said this"), false);
  assert.equal(findQuoteInTranscript(path.join(here, "nope.jsonl"), "x"), null, "missing transcript is unknown, not false");
});

test("R11 blocks an unlabelled claim in the final message; R12 blocks a waiver quote the user never said", () => {
  const repo = makeRepo("report-rules");
  const cfg = loadConfig(repo);
  const base = { config: cfg, changed: [], now: { hash: "x", files: {} }, verify: null, events: [], reviews: [], root: repo, dir: repo };
  const ledger = { status: "open", steps: [], cases: [], blast: [], waivers: [], planSeq: 1 };
  const ids = (s) => evaluate(s).map((u) => u.rule);
  assert.ok(ids({ ...base, ledger, lastMessage: "Done, tests pass." }).includes("R11"));
  assert.ok(!ids({ ...base, ledger, lastMessage: "Done [measured] (ledger.md)." }).includes("R11"));
  const waivedFalse = { ...ledger, waivers: [{ key: "driver", quote: "skip it", found: false }] };
  assert.ok(ids({ ...base, ledger: waivedFalse, lastMessage: "" }).includes("R12"));
  const waivedTrue = { ...ledger, waivers: [{ key: "driver", quote: "skip it", found: true }] };
  assert.ok(!ids({ ...base, ledger: waivedTrue, lastMessage: "" }).includes("R12"));
});

test("the stop gate resolves pending waivers against the transcript and persists the verdict", () => {
  const repo = makeRepo("report-waiver-stop");
  cli(repo, "open", ["w", "plan"]);
  cli(repo, "waive", ["skeptic", "skip the phone pass this time, Chrome is disconnected"]);
  cli(repo, "waive", ["read", "made-up words"]);
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, last_assistant_message: "x", transcript_path: path.join(here, "fixtures", "transcript.jsonl") }),
    encoding: "utf8", env: env(repo),
  });
  const waivers = loadLedger(runDir(repo)).waivers;
  assert.equal(waivers[0].found, true);
  assert.equal(waivers[1].found, false);
  assert.match(JSON.parse(r.stdout).reason, /R12.*made-up words/);
});
