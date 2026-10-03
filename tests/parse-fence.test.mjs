import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDraft, parseFindings } from "../scripts/lib/rules.mjs";
import { decide, readsOnly } from "../scripts/lib/guard.mjs";
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
    `cat $(ls ${EVIDENCE})`,
    `perl -pe 's/a/b/' ${EVIDENCE}`,
  ]) {
    assert.equal(decide(bash(cmd), repo, cfg).deny, false, cmd);
  }
});

test("C7 reported-surface: sed -n on a path holding /w is read-only, on an evidence file and in source", () => {
  const worker = ".claude/gate/runs/2026-09-27-x/worker-1.md";
  for (const cmd of [
    `sed -n 1,40p ${worker}`,
    `grep -n Replies ${worker}; sed -n '10,20p' ${worker}`,
    `sed -n "/^## Replies/,/^## /p" ${worker}`,
    `sed -e 's/a/b/' ${worker}`,
  ]) assert.equal(decide(bash(cmd), repo, cfg).deny, false, cmd);
  for (const cmd of ["sed -n 1,40p src/web.ts", "sed -n 5p src/www/index.ts", "sed -ne 3p src/web.ts", "sed -n -f script.sed src/web.ts"]) assert.equal(readsOnly(cmd), true, cmd);
});

test("C8 edge: a w command in the sed script is still a write, as the script or an -e value", () => {
  for (const cmd of ["sed -n '1w out.txt' src/a.ts", "sed -e 's/a/b/w out.txt' src/a.ts", "sed -ne '/x/w out.txt' src/web.ts", "sed --expression='1w out.txt' src/a.ts"]) {
    assert.equal(readsOnly(cmd), false, cmd);
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
    `perl -pi -e 's/a/b/' ${EVIDENCE}`,
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

test("C9 an Act-on heading may carry a colon; a bullet opening with none or n/a is empty whatever follows; nothing alone or nothing found is empty; None of… and Nothing tests… are findings", () => {
  const colon = "# Review 7 — x\n\n## Act on:\n- H2-7.1 Two comments describe the index mechanism wrongly. src/x.ts:36-38\n  - Why: the literal proves the predicate\n\n## Consider\n- x\n";
  assert.deepEqual(parseFindings(colon).map((f) => f.text), ["H2-7.1 Two comments describe the index mechanism wrongly. src/x.ts:36-38"]);
  assert.deepEqual(parseFindings("# Review\n\n## Act on: none\n\n## Consider\n- x\n"), []);
  for (const b of ["none found for this piece (PaymentForm.tsx, TotalsBreakdown.tsx)", "none. I traced every money path the brief names.", "N/A", "nothing found for this piece", "Nothing.", "none"]) {
    assert.deepEqual(parseFindings(`## Act on\n- ${b}\n`), [], b);
  }
  for (const b of ["None of the callers checks the result", "Nothing tests C4's gapless numbering"]) {
    assert.equal(parseFindings(`## Act on\n- ${b}\n`).length, 1, b);
  }
});

test("C10 the lead may quote an evidence path in a heredoc body and read one with inline code or inside $( ); writing one is still denied", () => {
  const L = ".claude/gate/runs/2026-09-27-x/ledger.json";
  for (const cmd of [
    `cat >> .superpowers/report.md <<'EOF'\nSource: ${EVIDENCE}, citing ${L}\nEOF`,
    `node -e 'const l=require("./${L}");for(const c of l.cases)console.log(c.id)'`,
    `for r in a b; do echo "$r: $(grep -o '"status"' ${L} | head -1)"; done`,
    `python3 -c 'import json;print(json.load(open("${L}"))["status"])'`,
    `G=/tmp/g; $G huddle add reviewer --file review-2.md; cat > .superpowers/x.md <<'EOF'\nsee ${EVIDENCE}\nEOF`,
  ]) {
    assert.equal(decide(bash(cmd), repo, cfg).deny, false, cmd);
  }
  for (const cmd of [
    `cat > ${L} <<'EOF'\n{}\nEOF`,
    `node -e 'require("fs").writeFileSync("${L}","{}")'`,
    `echo "$(rm ${L})"`,
    `sh -c "echo x > ${L}"`,
    `python3 - <<'EOF'\nopen("${L}","w").write("{}")\nEOF`,
  ]) {
    assert.equal(decide(bash(cmd), repo, cfg).deny, true, cmd);
  }
});

test("C11 a helper's shell write is judged by its targets: scratch copies pass whatever the source, a cd into scratch and same-command variables resolve; repo writes, unknown targets and inline code that writes are denied", () => {
  const reviewer = { agent_id: "A1", agent_type: "done-gate:reviewer" };
  const S = "/private/tmp/claude-501/x/scratchpad";
  for (const cmd of [
    "git show cfa6af2:src/a.ts > /tmp/checkout.tsx && wc -l /tmp/checkout.tsx",
    "cd tests/.tmp/rv4 && cp -R /repo/src ./src && cat > vitest.config.ts <<'EOF'\nexport default {}\nEOF",
    `S=${S}; mkdir -p $S && sed -e "s#a#b#" src/a.ts > $S/a.ts`,
    `S=${S}; rm -rf $S; mkdir -p $S; cd /repo && rsync -a --exclude node_modules --exclude .git src $S/`,
    "S=/tmp/s; (npm test > $S/t3.log 2>&1; echo done)",
    "sed -i '' 's/a/b/' /repo/tests/.tmp/rv4/src/api.ts",
    "mkdir -p /tmp/claude-501/rv4 && ls /repo && cat /repo/vite*.config.* | head -60",
    "npm test 2>&1 | tail -5",
    "node -e 'console.log(require(\"fs\").readFileSync(\"src/a.ts\",\"utf8\").length)'",
  ]) {
    assert.equal(decide(bash(cmd, reviewer), repo, cfg).deny, false, cmd);
  }
  for (const cmd of [
    "python3 - <<'EOF'\np='src/a.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF",
    "echo x > src/out.txt",
    "git checkout -- src/a.ts",
    "bash -c 'echo hi > src/x'",
    "(npm test > $S/t3.log 2>&1)",
    "cd $R && cp a ./b",
    "tar xzf x.tgz",
    "sed -i '' 's/a/b/' src/api.ts",
    "cat x | xargs rm",
    "cp src/a.ts src/b.ts",
  ]) {
    const v = decide(bash(cmd, reviewer), repo, cfg);
    assert.equal(v.deny, true, cmd);
    assert.match(v.reason, /this command /, "the refusal says what the command writes");
  }
});
