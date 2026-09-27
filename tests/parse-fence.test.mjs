import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDraft, parseFindings } from "../scripts/lib/rules.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { makeRepo, gate } from "./helpers.mjs";

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], input = "") {
  return spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: envFor(repo) });
}

const review = (actOn) => `# Review 1 — x\n\n## Act on\n${actOn}\n## Consider\n- none\n`;

test("C1 a top-level Act-on bullet with indented sub-bullets is one finding", () => {
  const text = review(["- H1.1 A cashier can pass the limit by splitting", "  - Trigger: two calls of 5%", "  - Probed on the fixture", "    - Fix: sum the live rows", "- H1.2 A double tap applies twice"].join("\n"));
  assert.deepEqual(parseFindings(text).map((f) => f.text), ["H1.1 A cashier can pass the limit by splitting", "H1.2 A double tap applies twice"]);
});

test("C2 a bullet that starts with none is empty; a finding that starts with Nothing counts", () => {
  assert.deepEqual(parseFindings(review("- none. The three commits close H4.1 and H5.1.")), []);
  assert.deepEqual(parseFindings(review("- None — the diff is clean")), []);
  assert.deepEqual(parseFindings(review("- n/a")), []);
  assert.deepEqual(parseFindings(review("- none (all four closed)")), []);
  assert.deepEqual(parseFindings(review("- Nothing tests C4's gapless numbering")).map((f) => f.text), ["Nothing tests C4's gapless numbering"]);
  assert.deepEqual(parseFindings(review("- None of the callers handle a null tier")).map((f) => f.text), ["None of the callers handle a null tier"]);
});

test("C1 a list indented as a whole is read at its own outermost level", () => {
  const text = review(["  - H1.1 first", "    - detail", "  - H1.2 second"].join("\n"));
  assert.deepEqual(parseFindings(text).map((f) => f.text), ["H1.1 first", "H1.2 second"]);
});

const TEMPLATE = "# Review 3 — x\n\n## Act on\n- unverified\n## Consider\n- unverified\n## Dismissed\n- none\n## Evidence verdict\n- tests: unverified\n- cases: unverified\n";

test("C3 a template whose bullets read 'label: unverified' is a draft; one real finding makes it not", () => {
  assert.equal(isDraft(TEMPLATE), true);
  assert.equal(isDraft(TEMPLATE.replace("## Act on\n- unverified", "## Act on\n- H1.1 the guard reads the wrong column")), false);
  assert.equal(isDraft("# Review\n\n## Act on\n- none\n"), false);
});

test("C4 gate huddle add refuses the labelled-unverified template as a draft", () => {
  const repo = makeRepo("parse-fence-draft");
  run(repo, "open", ["t", "feature"]);
  const dir = path.join(repo, ".claude", "gate", "runs");
  const runDir = path.join(dir, spawnSync("ls", [dir], { encoding: "utf8" }).stdout.trim());
  writeFileSync(path.join(runDir, "review-1.md"), TEMPLATE);
  const r = run(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.match(r.stderr, /draft/);
  assert.equal(JSON.parse(readFileSync(path.join(runDir, "ledger.json"), "utf8")).huddles.length, 0);
});

const repo = makeRepo("parse-fence-guard");
const cfg = loadConfig(repo);
const bash = (command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1", ...extra });
const EVIDENCE = ".claude/gate/runs/2026-09-27-x/review-1.md";

test("C5 read-only commands on an evidence file pass the fence", () => {
  for (const cmd of [
    `cat ${EVIDENCE}`,
    `ls .claude/gate/runs/2026-09-27-x/ && cat ${EVIDENCE}`,
    `grep -n "Act on" ${EVIDENCE} | head -20`,
    `sed -n '1,40p' ${EVIDENCE}`,
    `rtk cat ${EVIDENCE}`,
    `wc -l .claude/gate/runs/2026-09-27-x/ledger.json; tail -5 .claude/gate/sessions/S1/events.jsonl`,
    `cd .claude/gate/runs/2026-09-27-x && cat ledger.json | jq .tier`,
    `node "${gate}" report --brief > /dev/null; cat ${EVIDENCE} 2>&1`,
    `git show HEAD:${EVIDENCE}`,
    `git diff -- ${EVIDENCE}`,
    `FORCE_COLOR=0 cat ${EVIDENCE}`,
    `sed -n '/^## Write your/,$p' .claude/gate/runs/2026-09-27-x/brief-reviewer-1.md`,
    `sed -n '/^## You may write/,/^## Diff/p' .claude/gate/runs/2026-09-27-x/brief-reviewer-1.md`,
    `sed 's/ with / WITH /' ${EVIDENCE}`,
    `git -C ${repo} show HEAD:${EVIDENCE}`,
  ]) {
    assert.equal(decide(bash(cmd), repo, cfg).deny, false, cmd);
  }
});

test("C6 commands that write an evidence path are still denied", () => {
  for (const cmd of [
    `sed -i '' 's/a/b/' ${EVIDENCE}`,
    `cat x.md | tee ${EVIDENCE}`,
    `echo x > ${EVIDENCE}`,
    `echo x >> .claude/gate/sessions/S1/events.jsonl`,
    `rm ${EVIDENCE}`,
    `git checkout -- ${EVIDENCE}`,
    `cp x.md ${EVIDENCE}`,
    `node -e 'require("fs").writeFileSync("${EVIDENCE}", "x")'`,
    `python3 fix.py ${EVIDENCE}`,
    `cat ${EVIDENCE} | xargs rm`,
    `sed -n 'w ${EVIDENCE}' src/a.ts`,
    `sort -o ${EVIDENCE} src/a.ts`,
    `find ${EVIDENCE} -delete`,
    `find ${EVIDENCE} -exec rm {} \\;`,
    `awk '{print > "${EVIDENCE}"}' src/a.ts`,
    `perl -pe 's/a/b/' ${EVIDENCE}`,
    `cat $(ls ${EVIDENCE})`,
    `cat ${EVIDENCE} & rm ${EVIDENCE}`,
    `echo "$(rm ${EVIDENCE})"`,
    `echo "\`rm ${EVIDENCE}\`"`,
    `sort -ro ${EVIDENCE} src/a.ts`,
    `sort -o${EVIDENCE} src/a.ts`,
    `sed -n w\\ ${EVIDENCE} src/a.ts`,
    `sed -n 'W ${EVIDENCE}' src/a.ts`,
    `tree -o ${EVIDENCE}`,
    `git checkout HEAD -- ${EVIDENCE}`,
    `git diff --output=${EVIDENCE} HEAD~1`,
    `sed -I '' 's/a/b/' ${EVIDENCE}`,
    `sed -n w${EVIDENCE} src/a.ts`,
    `sort --outp ${EVIDENCE} src/a.ts`,
    `PATH=/tmp/x cat ${EVIDENCE}`,
    `rg --pre /tmp/x.sh Act ${EVIDENCE}`,
    `sed -n '1w ${EVIDENCE}' src/a.ts`,
    `sed -n '/a/w ${EVIDENCE}' src/a.ts`,
    `sed 's/a/b/w ${EVIDENCE}' src/a.ts`,
    `git -c core.pager=rm show HEAD:${EVIDENCE}`,
  ]) {
    assert.equal(decide(bash(cmd), repo, cfg).deny, true, cmd);
  }
});

test("C7 a helper's read-only command on its packet passes; its shell write outside scratch is still denied", () => {
  const reviewer = { agent_id: "A1", agent_type: "done-gate:reviewer" };
  assert.equal(decide(bash("cat .claude/gate/runs/2026-09-27-x/brief-reviewer-1.md", reviewer), repo, cfg).deny, false);
  assert.equal(decide(bash("echo x > src/out.txt", reviewer), repo, cfg).deny, true);
  assert.equal(decide(bash(`cat src/a.ts > ${EVIDENCE}`, reviewer), repo, cfg).deny, true);
});

test("C8 a deny event records the Bash command, truncated to 200 chars", () => {
  const r = makeRepo("parse-fence-event");
  const long = `echo ${"y".repeat(300)} > .claude/gate/runs/x/events.jsonl`;
  const out = spawnSync(process.execPath, [gate, "fence"], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: long }, cwd: r, session_id: "S1" }), encoding: "utf8", env: envFor(r) });
  assert.match(out.stdout, /deny/);
  const events = readFileSync(path.join(r, ".claude", "gate", "sessions", "S1", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const deny = events.find((e) => e.kind === "deny");
  assert.equal(deny.cmd.length, 200);
  assert.ok(long.startsWith(deny.cmd));
});
