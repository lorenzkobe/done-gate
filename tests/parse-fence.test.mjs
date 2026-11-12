import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate, isDraft, parseFindings } from "../scripts/lib/rules.mjs";
import { decide, ownFileWrites, readsOnly, scratchOnly } from "../scripts/lib/guard.mjs";
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
    `for d in */; do g="$d.claude/gate"; [ -d "$g" ] || continue; t=$(grep -rhoE 'x' "$g" 2>/dev/null | wc -l); echo "$d $t"; done`,
    `grep -rhE 'x' --include='*.jsonl' */.claude/gate | grep -oE 'y' | paste - - -`,
    `f="${EVIDENCE}"; cat "$f"`,
    `LC_ALL="C" sort ${EVIDENCE}`,
    `NO_COLOR=1 grep -n x ${EVIDENCE} 2>&1`,
    `GIT_PAGER=cat git log -- ${EVIDENCE}`,
    `PAGER=cat git show HEAD:${EVIDENCE}`,
    `GIT_PAGER= git log -- ${EVIDENCE}`,
    `DONE_GATE_SESSION=S1 CLAUDE_PROJECT_DIR=/r node ${gate} check`,
    `LESS=-R less ${EVIDENCE}`,
    `NODE_OPTIONS=--no-warnings cat ${EVIDENCE}`,
    `cat ${EVIDENCE} 2>/dev/null`,
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

test("C3 reported-surface: awk, ps, rtk proxy, git stash list and the $((...)) remainder on gate files are read-only", () => {
  for (const cmd of [
    "awk '/^## Contract/,0' .claude/gate/runs/2026-09-27-x/brief-qa-1.md",
    "awk '$1 > 5 { print $2 }' .claude/gate/runs/2026-09-27-x/decisions.tsv",
    "ps -p 3 -o pid,command; cat .claude/gate/runs/2026-09-27-x/verify.json",
    "rtk proxy grep -n Act .claude/gate/runs/2026-09-27-x/brief-worker-1.md",
    "git stash list; cat .claude/gate/runs/2026-09-27-x/ledger.json",
    "n=$(($(wc -l < .claude/gate/runs/2026-09-27-x/decisions.tsv) - 1)); echo $n",
    "cd ~/.claude/plugins/cache/done-gate && npm run reinstall",
    "git add .claude/gate.json && git commit -m config",
    'git commit -qm "the fence refuses .claude/gate writes"',
  ]) assert.equal(decide(bash(cmd), repo, cfg).deny, false, cmd);
});

test("C4 refused: awk that writes and git stash push are still writes", () => {
  for (const cmd of [
    `awk '{ print > "x" }' ${EVIDENCE}`,
    `awk '{ print >> "x" }' ${EVIDENCE}`,
    `awk 'BEGIN { system("rm x") }' ${EVIDENCE}`,
    `awk -i inplace '{ print }' ${EVIDENCE}`,
    `awk '{ print | "sh" }' ${EVIDENCE}`,
    `rtk proxy rm ${EVIDENCE}`,
    `awk 'BEGIN { "date" | getline d }' ${EVIDENCE}`,
    "cd .claude/gate/runs/x && rm *",
    "cd .claude && cd gate/runs/x && rm *",
    "pushd .claude/gate/runs/x && rm *",
    "cd .claude && rm -rf gate",
    "cd .claude/ && rm -rf ./gate",
    "cd .claude; find gate -delete",
    "cd .claude && cd gate && rm -rf runs",
    "D=.claude/gate/runs/x; cd $D && rm *",
    "cd ./.claude/./gate/runs/x && rm *",
    "cd \".claude\"/gate/runs/x && rm *",
    "cd /repo/.claude/gate; truncate -s0 runs/x/ledger.json",
    `awk -f/tmp/s.awk ${EVIDENCE}`,
    `awk -E /tmp/s.awk ${EVIDENCE}`,
    `awk -iinplace 1 ${EVIDENCE}`,
    `awk 'BEGIN { "rm x" |& getline }' ${EVIDENCE}`,
  ]) assert.equal(decide(bash(cmd), repo, cfg).deny, true, cmd);
  const helper = (cmd) => decide(bash(cmd, { agent_id: "A1", agent_type: "done-gate:reviewer" }), repo, cfg).deny;
  assert.equal(helper("rtk proxy rm src/a.ts"), true, "a helper's rtk proxy rm outside scratch is a write");
  assert.equal(helper("cp src/a.ts src/b.ts"), true, "premise: a helper's plain repo write is denied");
  assert.equal(readsOnly("git stash push -m x"), false);
  assert.equal(readsOnly("git stash"), false);
  for (const cmd of ["rm - x", "mv + y", "npm test -- badge", "run-tests", "/usr/bin/git commit -m x", "X=rm; $X - *", "shred - *", "n + 1"]) assert.equal(readsOnly(cmd), false, `the arithmetic rule never covers a writer: ${cmd}`);
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
    `grep x src/a.ts | paste - - > ${EVIDENCE}`,
    `for f in a; do continue; done; rm ${EVIDENCE}`,
    `X="a" rm ${EVIDENCE}`,
    `"g=x" ${EVIDENCE}`,
    `D=".claude/gate/runs/x"; echo x > $D/ledger.json`,
    `GIT_EXTERNAL_DIFF="rm ${EVIDENCE}" git diff`,
    `GIT_PAGER='sh -c "rm ${EVIDENCE}"' git show HEAD`,
    `PAGER="rm ${EVIDENCE}" git log`,
    `GIT_PAGER=rm git log ${EVIDENCE}`,
    `LESSOPEN="|rm ${EVIDENCE}" less README.md`,
    `echo x>${EVIDENCE}`,
    `grep x src/a.ts | paste - ->${EVIDENCE}`,
    `X="a">${EVIDENCE}`,
    `F="${EVIDENCE}"; echo x>$F`,
    `echo x>>${EVIDENCE}`,
    `git log --format=%h->${EVIDENCE}`,
    `echo x>"${EVIDENCE}"`,
    `echo x >"${EVIDENCE}"`,
    `echo x 1>"${EVIDENCE}"`,
    `echo x>'${EVIDENCE}'`,
    `echo "">${EVIDENCE}`,
    `echo x ''>${EVIDENCE}`,
    `GIT_PAGER="rm ${EVIDENCE}"; git log`,
    `LESSOPEN="|rm ${EVIDENCE}"; less README.md`,
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
    `S="${S}"; cp src/a.ts $S/a.ts`,
    `echo x>${S}/glued.txt`,
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
    `S="src"; cp a.ts $S/b.ts`,
    "echo x>src/glued.txt",
    'echo x >"src/a.ts"',
    'echo "">src/a.ts',
  ]) {
    const v = decide(bash(cmd, reviewer), repo, cfg);
    assert.equal(v.deny, true, cmd);
    assert.match(v.reason, /this command /, "the refusal says what the command writes");
  }
});

// ---------------------------------------------------------------------------
// fence-reads-and-brief-crash: the read-only shapes Courtly's runs were denied for
// ---------------------------------------------------------------------------

const RUN = ".claude/gate/runs/2026-10-19-x";
const WRAPPER = `gate() { echo '{"session_id":"S1"}' | node "${gate}" "$@"; }`;

test("C1 reported-surface: the read-only shapes Courtly was denied for pass the evidence fence", () => {
  for (const cmd of [
    `cd ${RUN} && sed -n 129,140p brief-reviewer-2-10.md; diff <(sed -n 1,128p brief-reviewer-2-9.md) <(sed -n 1,128p brief-reviewer-2-10.md) | head -20`,
    `diff <(sed '/^## Piece/,$d' ${RUN}/brief-reviewer-24.md) <(sed '/^## Piece/,$d' ${RUN}/brief-reviewer-25.md) | head`,
    `cd ${RUN}; grep -l "" brief-reviewer-*.md | sort -V | while read f; do printf "%s: " "$f"; grep -m1 -oE "src/[^ ,)]+" "$f"; done`,
    `tail -4 ${RUN}/gate-error.log 2>/dev/null || find .claude/gate -name gate-error.log -newer CLAUDE.md | head -2 | xargs tail -3`,
    `for f in $(ls ${RUN}/brief-reviewer-*.md | sort -V); do echo "== $(basename $f): $(grep -m1 -iE 'files' $f | cut -c1-200)"; done`,
    `${WRAPPER}; gate check 2>&1 | head -30; ls .claude/gate/`,
    `${WRAPPER}; S='{"a":1}'; R=${RUN}\necho "$S" | gate huddle add skeptic --file skeptic-1.md`,
    `${WRAPPER}; D='src/app/api/[id]'; gate brief reviewer --files "$D/route.ts"; ls ${RUN}`,
    `S=/private/tmp/claude-501/x/scratchpad && sed -n '/^## Tests QA wrote/,/^## Test command/p' ${RUN}/brief-worker-12.md | grep '^- ' | sed 's/^- //' > $S/qa.txt`,
    `lsof -ti tcp:3000 >/dev/null; ls ${RUN}`,
  ]) {
    const v = decide(bash(cmd), repo, cfg);
    assert.equal(v.deny, false, `${cmd}\n${v.reason ?? ""}`);
  }
});

test("C2 happy: a word after a process or command substitution stays an argument of its command", () => {
  for (const cmd of ["cat $(ls x) y", "diff <(sort a) b", "diff <(sort a) <(sort b) c", "echo $(cat $(ls x)) tail", "wc -l <(grep -c x a) | head", "diff <(sort a) <(sort b) && cat c"]) {
    assert.equal(readsOnly(cmd), true, cmd);
  }
  assert.equal(readsOnly("diff <( (cd a && ls) ) b"), true, "a subshell inside the substitution");
  assert.equal(readsOnly("cat $(ls x) y > out.txt"), false, "the outer command's redirect still counts");
  assert.equal(readsOnly("cat <(rm x) y"), false, "the command inside the substitution is checked");
});

test("C3 refused: writes to gate files and look-alikes of reads are still denied", () => {
  for (const cmd of [
    `L=${RUN}/ledger.md && cat >> $L <<'EOF'\n## Decisions\nEOF`,
    `cd ${RUN} && sed -i '' 's/a/b/' review-6.md`,
    `python3 - <<'EOF'\np='${RUN}/worker-4.md'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF`,
    `cat a > $(echo ${RUN}/review-1.md)`,
    `find ${RUN} -name '*.md' | xargs rm`,
    `ls ${RUN} | xargs -n 1 sed -i '' s/a/b/`,
    `$(echo rm) ${RUN}/review-1.md`,
    `cat ${RUN}/review-1.md | tee >(cat > x)`,
    `read PATH; cat ${RUN}/review-1.md`,
    `S=/tmp/x; cat a > $S/b; cp $S/b ${RUN}/review-1.md`,
    `cat ${RUN}/review-1.md > /tmp/x/r.md; mv /tmp/x/r.md ${RUN}/review-1.md`,
    `rm /tmp/proj/${RUN}/verify.started.json`,
    `cd /tmp/proj/.claude/gate && rm runs/x/ledger.json`,
    `cat a > /tmp/proj/.claude/gate/runs/x/review-1.md`,
  ]) {
    assert.equal(decide(bash(cmd), repo, cfg).deny, true, cmd);
  }
  for (const cmd of ["npx vitest run >/dev/null 2>&1", "read -r PAGER", "read GIT_SSH_COMMAND", "xargs -I {} rm {}", "xargs -0 sed -i s/a/b/", "$(ls) x"]) assert.equal(readsOnly(cmd), false, cmd);
});

test("C4 edge: the deny names the part that is not a plain read, and points the file's owner at the edit tools", () => {
  const ledger = decide(bash(`ls ${RUN}; cat >> ${RUN}/ledger.md <<'EOF'\nx\nEOF`), repo, cfg);
  assert.equal(ledger.deny, true);
  assert.match(ledger.reason, /`cat >> \S*ledger\.md/, ledger.reason);
  assert.match(ledger.reason, /Edit or Write tool, or sed -i with plain s or d commands, on ledger\.md/, ledger.reason);
  const other = decide(bash(`npx vitest run 2>&1 | grep -f ${RUN}/notes.txt`), repo, cfg);
  assert.match(other.reason, /`npx vitest run/, other.reason);
  assert.doesNotMatch(other.reason, /Edit or Write tool/, other.reason);
  const long = decide(bash(`node scripts/x.mjs ${"--flag ".repeat(40)} | grep -f ${RUN}/notes.txt`), repo, cfg);
  assert.ok(long.reason.length < 600, `the quoted part is cut short: ${long.reason.length}`);
});

test("C11 edge: the edit-tool hint goes only to the caller that owns the file", () => {
  const as = (role) => ({ agent_id: "A1", agent_type: `done-gate:${role}` });
  const sedOn = (file) => `cd ${RUN} && sed -i '' 's/a/b/' ${file}`;
  for (const [role, file] of [["reviewer", "review-6.md"], ["reviewer-2", "review2-2.md"], ["skeptic", "skeptic-1.md"], ["worker", "worker-4.md"]]) {
    const v = decide(bash(sedOn(file), as(role)), repo, cfg);
    assert.equal(v.deny, true, `${role} ${file}`);
    assert.match(v.reason, new RegExp(`Use the ${role === "worker" ? "Edit or Write" : "Write"} tool, or sed -i with plain s or d commands, on ${file.replace(".", "\\.")}`), `${role}: ${v.reason}`);
  }
  for (const [who, file] of [[{}, "review-6.md"], [as("reviewer"), "review2-2.md"], [as("worker"), "review-6.md"]]) {
    const v = decide(bash(sedOn(file), who), repo, cfg);
    assert.equal(v.deny, true, file);
    assert.doesNotMatch(v.reason, /Write tool/, `${who.agent_type ?? "lead"} on ${file}: ${v.reason}`);
  }
  const helperLedger = decide(bash(`cat >> ${RUN}/ledger.md <<'EOF'\nx\nEOF`, as("worker")), repo, cfg);
  assert.equal(helperLedger.deny, true);
  assert.doesNotMatch(helperLedger.reason, /Edit or Write tool, or sed -i with plain s or d commands, on ledger/, helperLedger.reason);
});

test("C9 refused: xargs takes its arguments from stdin, so only plain readers run under it", () => {
  for (const cmd of ["ls | xargs sed", "ls | xargs awk 1", "ls | xargs sort", "ls | xargs find", "ls | xargs git log", "ls | xargs rg x", "ls | xargs perl -ne 1", "ls | xargs tree", "ls | xargs node", "ls | xargs -n 1 jq ."]) {
    assert.equal(readsOnly(cmd), false, cmd);
  }
  assert.equal(decide(bash(`printf -- '-i\\n${RUN}/review-1.md' | xargs sed s/a/b/`), repo, cfg).deny, true);
});

test("C10 refused: a substitution leaves a placeholder that is no read, no /dev/null and no known location", () => {
  assert.equal(readsOnly(`cat a > $(echo ${RUN}/review-1.md) /dev/null`), false);
  assert.equal(decide(bash(`cat a > $(echo ${RUN}/review-1.md) /dev/null`), repo, cfg).deny, true);
  assert.equal(readsOnly("$(echo cat) a"), false);
  assert.equal(readsOnly("<(cat a) b"), false);
  const helper = decide(bash(`cat a > $(echo src/x.ts) /dev/null`, { agent_id: "A1", agent_type: "done-gate:reviewer" }), repo, cfg);
  assert.equal(helper.deny, true, "a helper's write to a substituted target is unknown, so denied");
  assert.match(helper.reason, /unknown location/, helper.reason);
});

test("C12 refused: node gate.mjs and the gate() wrapper are read-only only with a normal gate verb, never a hook verb", () => {
  for (const verb of ["log", "fence", "stop", "session-start"]) {
    const forged = `echo '{"hook_event_name":"PostToolUse","tool_name":"Bash"}' | node "${gate}" ${verb}`;
    assert.equal(readsOnly(forged), false, verb);
    assert.equal(readsOnly(`${WRAPPER}; gate ${verb}`), false, `wrapper ${verb}`);
    assert.equal(decide(bash(`${forged}; ls ${RUN}`), repo, cfg).deny, true, verb);
  }
  for (const verb of ["check", "report --brief", "huddle add reviewer --file review-1.md"]) {
    assert.equal(readsOnly(`node "${gate}" ${verb}`), true, verb);
    assert.equal(readsOnly(`${WRAPPER}; gate ${verb}`), true, `wrapper ${verb}`);
  }
});

test("C7 boundary: unbalanced parens do not throw; an unclosed substitution is no read", () => {
  for (const cmd of ["cat a )", "diff <(sort a b", "cat $(ls", ") cat a", "diff <(sort a)) b"]) {
    assert.doesNotThrow(() => readsOnly(cmd), cmd);
  }
  assert.equal(readsOnly("diff <(sort a b"), false, "an unclosed substitution");
  assert.equal(readsOnly("echo $(cat a"), false, "an unclosed command substitution");
  assert.doesNotThrow(() => readsOnly('case "$x" in a) cat a;; *) ls;; esac'), "a case pattern's ) closes nothing");
});

test("C8 boundary: xargs reads as the command after its flags", () => {
  for (const cmd of ["ls | xargs", "ls | xargs tail -3", "ls | xargs -n 1 head -2", "ls | xargs -I {} grep -n x {}", "ls | xargs -P 4 -0 wc -l", "ls | xargs -n1 cat", "ls | xargs -L 1 -r stat"]) {
    assert.equal(readsOnly(cmd), true, cmd);
  }
  for (const cmd of ["ls | xargs sed -i s/a/b/", "ls | xargs -I {} cp {} /src", "ls | xargs sh -c 'rm x'", "ls | xargs -n 1 npx eslint --fix", "ls | xargs -I"]) {
    assert.equal(readsOnly(cmd), false, cmd);
  }
});

test("C14 refused: a scratch-only write is only one whose every writer the fence can read", () => {
  for (const cmd of ["cat a > /tmp/x/b", "sed -n 1p a | sort > /tmp/x/b", "cp a tests/.tmp/b"]) assert.equal(scratchOnly(cmd), true, cmd);
  for (const cmd of [`awk '{ print > "src/a.ts" }' a > /tmp/x/b`, "sort -o src/a.ts a > /tmp/x/b", "PATH=/tmp/x cat a > /tmp/x/b", "npx eslint --fix > /tmp/x/b"]) {
    assert.equal(scratchOnly(cmd), false, cmd);
  }
});

test("C15 refused: a name inside $((…)) is no read, since bash evaluates its value and a[$(cmd)] there runs; numbers and substitutions are", () => {
  for (const cmd of ["echo $((3-1))", "echo $(($(wc -l < f) - 1))", "n=$(($(grep -c . f) - 1)); echo $n"]) assert.equal(readsOnly(cmd), true, cmd);
  for (const cmd of ["echo $((n-1))", "x=$P; echo $((x))", "echo $(( $(rm x) + 1 ))", "echo $((3-1)) > out.txt"]) assert.equal(readsOnly(cmd), false, cmd);
});

test("C14 refused: links cannot carry a scratch write into the gate dir", () => {
  for (const cmd of [
    `ln -s $PWD/${RUN} /tmp/g; echo x > /tmp/g/ledger.json`,
    `ln -s $PWD/.claude /tmp/c; echo x > /tmp/c/gate/runs/x/ledger.json; ls ${RUN}`,
    `ln ${RUN}/ledger.json /tmp/h; echo x > /tmp/h`,
    `cp -l ${RUN}/ledger.json /tmp/h && echo x >> /tmp/h`,
    `cp -s ${RUN}/ledger.json /tmp/h && echo x >> /tmp/h`,
    `cp --link ${RUN}/ledger.json /tmp/h && echo x >> /tmp/h`,
  ]) assert.equal(decide(bash(cmd), repo, cfg).deny, true, cmd);
  assert.equal(decide(bash(`ln -s $PWD/${RUN} /tmp/g; echo x > /tmp/g/review-1.md`, { agent_id: "A1", agent_type: "done-gate:reviewer" }), repo, cfg).deny, true, "a reviewer's link");
  for (const cmd of ["ln -s src /tmp/s; echo x > /tmp/s/a.ts", "cp -l src/a.ts /tmp/h", "cp -al src /tmp/h"]) assert.equal(scratchOnly(cmd), false, cmd);
});

test("C14 refused: an absolute write target is judged by its real path", () => {
  const gateDir = path.join(repo, ".claude", "gate", "runs", "linked");
  mkdirSync(gateDir, { recursive: true });
  const link = path.join(os.tmpdir(), `dg-link-${process.pid}`);
  try { unlinkSync(link); } catch {}
  symlinkSync(gateDir, link);
  try {
    assert.equal(scratchOnly(`echo x > ${link}/ledger.json`), false, "a link made earlier points into the gate dir");
    const v = decide(bash(`echo x > ${link}/ledger.json`), repo, cfg);
    assert.equal(v.deny, true, "the text never names the gate dir");
    assert.match(v.reason, /evidence folder/, v.reason);
    assert.equal(decide(bash(`cp a ${link}/runs/x/review-1.md`), repo, cfg).deny, true, "a copy through the link");
    assert.equal(decide(bash(`echo x > ${os.tmpdir()}/dg-plain-${process.pid}.txt`), repo, cfg).deny, false, "a plain scratch write");
    assert.equal(scratchOnly(`echo x > ${os.tmpdir()}/dg-plain-${process.pid}.txt`), true, "a plain scratch file stays scratch");
  } finally {
    try { unlinkSync(link); } catch {}
  }
});

test("C15 refused: xargs long options, the wrapper's \"$@\" outside a wrapper, zsh's tied names and file -C stay refused", () => {
  for (const cmd of [
    "ls | xargs --process-slot-var cat sed -i s/a/b/",
    "ls | xargs --arg-file cat sed -i s/a/b/",
    `echo '{"hook_event_name":"PostToolUse"}' | bash -c 'node ${gate} "$@"' _ log`,
    `node ${gate} "$@"`,
    `${WRAPPER}; echo '{"hook_event_name":"PostToolUse"}' | bash -c 'node ${gate} "$@"' _ log`,
    `${WRAPPER}; gate log`,
    "echo /tmp/p | read path; cat a",
    "read fpath", "read cdpath", "read manpath", "read module_path", "read mailpath", "read psvar",
    "file -C -m x",
    "ls | xargs file -C",
    "cat $(case x in x) rm f;; esac)",
    'cat "$(case x in x) rm f;; esac)"',
    "diff <(case x in x) rm f;; esac) b",
    "echo $(case a in a) sed -i s/a/b/ f;; esac)",
  ]) assert.equal(readsOnly(cmd), false, cmd);
  for (const cmd of ["ls | xargs --null cat", "ls | xargs --max-args=1 cat", "ls | xargs --no-run-if-empty head -1", "read -r line", "file src/a.ts"]) assert.equal(readsOnly(cmd), true, cmd);
  assert.equal(decide(bash(`ls | xargs --process-slot-var cat sed -i s/a/b/ ${RUN}/ledger.json`), repo, cfg).deny, true);
});

test("C4 edge: the deny names the segment that touches the gate dir and the owned file written there", () => {
  const v = decide(bash(`sed -n 1p a > /tmp/x/qa.txt; cat review-1.md; sed -i '' s/a/b/ ${RUN}/worker-4.md`, { agent_id: "A1", agent_type: "done-gate:worker" }), repo, cfg);
  assert.equal(v.deny, true);
  assert.match(v.reason, /`sed -i '' s\/a\/b\/ \S*worker-4\.md`/, v.reason);
  assert.match(v.reason, /Edit or Write tool, or sed -i with plain s or d commands, on worker-4\.md/, v.reason);
});

test("C15 refused: a # comment ends at its line, so a quote inside it hides nothing", () => {
  for (const cmd of [`cat ${RUN}/a # "\nrm ${RUN}/ledger.json\n# "`, `cat ${RUN}/a # '\nrm ${RUN}/ledger.json\n# '`]) {
    assert.equal(readsOnly(cmd), false, cmd);
    assert.equal(decide(bash(cmd), repo, cfg).deny, true, cmd);
  }
  for (const cmd of [`cat ${RUN}/a # a note`, `# just a note\ncat ${RUN}/a`, "echo $# ${#x}", "echo a#b"]) assert.equal(readsOnly(cmd), true, cmd);
});

test("C14 edge: removing a link in scratch is judged by the link, not by where it points", () => {
  const link = path.join(os.tmpdir(), `dg-rmlink-${process.pid}`);
  try { unlinkSync(link); } catch {}
  // a folder outside every scratch root wherever this repo lives (a clone in /tmp is scratch)
  symlinkSync("/usr/bin", link);
  try {
    assert.equal(scratchOnly(`rm ${link}`), true, "the link itself is in scratch");
    assert.equal(scratchOnly(`rm ${link}/env`), false, "a file through the link is outside scratch");
  } finally {
    try { unlinkSync(link); } catch {}
  }
});

// ---------------------------------------------------------------------------
// enforce-order-no-giving-up: no code edit before the run, Task, Context, Plan and a case
// ---------------------------------------------------------------------------

const editOf = (rel, tool = "Edit") => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path.join(repo, rel) }, cwd: repo, session_id: "S1" });
const FEATURE_STEPS = [{ key: "context" }, { key: "plan" }, { key: "cases" }];
const planned = (over = {}) => ({ slug: "t", taskSeq: 1, contextSeq: 2, planSeq: 3, cases: [{ id: "C1" }], steps: FEATURE_STEPS, waivers: [], ...over });
const RUN_REL = ".claude/gate/runs/2026-10-19-t";

test("C1 refused: an edit to a source file with no run open is denied and says to open one", () => {
  for (const tool of ["Edit", "Write"]) {
    const v = decide(editOf("src/a.ts", tool), repo, cfg, null, null);
    assert.equal(v.deny, true, tool);
    assert.match(v.reason, /gate open/, v.reason);
  }
});

test("C2 refused: with a run open, a source or test edit waits for Task, Context, Plan and a case, and the reason names what is missing", () => {
  for (const [missing, ledger] of [
    ["Task", planned({ taskSeq: undefined })],
    ["Context", planned({ contextSeq: undefined })],
    ["Plan", planned({ planSeq: undefined })],
    ["case", planned({ cases: [] })],
  ]) {
    for (const file of ["src/a.ts", "tests/a.test.ts"]) {
      const v = decide(editOf(file), repo, cfg, RUN_REL, ledger);
      assert.equal(v.deny, true, `${missing} ${file}`);
      assert.match(v.reason, new RegExp(missing), v.reason);
    }
  }
  const nothing = decide(editOf("src/a.ts"), repo, cfg, RUN_REL, planned({ taskSeq: undefined, contextSeq: undefined, planSeq: undefined, cases: [] }));
  assert.match(nothing.reason, /Task.*Context.*Plan.*case/, nothing.reason);
});

test("C3 happy: once Task, Context, Plan and a case exist the edit passes; a playbook with no context step does not wait for Context", () => {
  assert.equal(decide(editOf("src/a.ts"), repo, cfg, RUN_REL, planned()).deny, false);
  assert.equal(decide(editOf("tests/a.test.ts", "Write"), repo, cfg, RUN_REL, planned()).deny, false);
  assert.equal(decide(editOf("src/a.ts"), repo, cfg, RUN_REL, planned({ contextSeq: undefined, steps: [{ key: "plan" }, { key: "cases" }] })).deny, false);
});

test("C9 edge: each run asks only for its playbook's own steps: an investigation edits once open, a plan run needs Task, Context and Plan but no case", () => {
  const bare = { slug: "i", cases: [], waivers: [] };
  assert.equal(decide(editOf("tests/repro.test.ts", "Write"), repo, cfg, RUN_REL, { ...bare, steps: [] }).deny, false, "investigation");
  const planRun = { ...bare, steps: [{ key: "context" }, { key: "plan" }, { key: "skeptic" }] };
  assert.match(decide(editOf("src/a.ts"), repo, cfg, RUN_REL, planRun).reason, /Task.*Context.*Plan/);
  assert.equal(decide(editOf("src/a.ts"), repo, cfg, RUN_REL, { ...planRun, taskSeq: 1, contextSeq: 2, planSeq: 3 }).deny, false, "plan run needs no case");
});

test("C10 edge: an unreadable run is the gate's failure, so the edit is let through instead of asking for a second run", () => {
  assert.equal(decide(editOf("src/a.ts"), repo, cfg, null, null, { unreadable: true }).deny, false);
  assert.equal(decide(bash("echo x > src/a.ts"), repo, cfg, null, null, { unreadable: true }).deny, false);
});

test("C1 refused: a MultiEdit names its file at the top, and the fence sees it (evidence and code alike)", () => {
  const multi = (rel) => ({ hook_event_name: "PreToolUse", tool_name: "MultiEdit", tool_input: { file_path: path.join(repo, rel), edits: [{ old_string: "a", new_string: "b" }] }, cwd: repo, session_id: "S1" });
  assert.equal(decide(multi(`${RUN}/ledger.json`), repo, cfg, RUN_REL, planned()).deny, true, "evidence through MultiEdit");
  assert.equal(decide(multi("src/a.ts"), repo, cfg, null, null).deny, true, "code before a run");
  assert.equal(decide(multi("src/a.ts"), repo, cfg, RUN_REL, planned()).deny, false, "code once planned");
});

test("C4 edge: docs, files the gate does not count as source, and scratch files stay editable with no run", () => {
  for (const rel of ["docs/notes.md", "README.md", "tests/.tmp/x.ts"]) assert.equal(decide(editOf(rel), repo, cfg, null, null).deny, false, rel);
  assert.equal(decide({ ...editOf("x"), tool_input: { file_path: "/tmp/scratch/a.ts" } }, repo, cfg, null, null).deny, false);
});

test("C5 refused: a lead shell write to a source file waits for the plan; a read or a scratch write does not", () => {
  for (const cmd of ["sed -i '' s/a/b/ src/a.ts", "echo x > src/a.ts", "cp /tmp/a.ts src/a.ts", "printf x >> tests/a.test.ts"]) {
    assert.equal(decide(bash(cmd), repo, cfg, null, null).deny, true, `no run: ${cmd}`);
    assert.equal(decide(bash(cmd), repo, cfg, RUN_REL, planned({ planSeq: undefined })).deny, true, `no plan: ${cmd}`);
    assert.equal(decide(bash(cmd), repo, cfg, RUN_REL, planned()).deny, false, `planned: ${cmd}`);
  }
  for (const cmd of [`python3 - <<'EOF'\np='src/a.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF`, `node -e 'require("fs").writeFileSync("src/a.ts","x")'`]) {
    assert.equal(decide(bash(cmd), repo, cfg, null, null).deny, true, `inline code before a run: ${cmd}`);
    assert.equal(decide(bash(cmd), repo, cfg, RUN_REL, planned()).deny, false, `inline code once planned: ${cmd}`);
  }
  for (const cmd of ["cat src/a.ts", "grep -n a src/a.ts", "echo x > /tmp/x.ts", "npm test", "git commit -qm x", `python3 -c "open('/tmp/x.txt','w')"`]) assert.equal(decide(bash(cmd), repo, cfg, null, null).deny, false, cmd);
});

test("C1 refused: a closed or abandoned run is no run: code waits for a new one", () => {
  for (const status of ["closed", "abandoned"]) {
    const v = decide(editOf("src/a.ts"), repo, cfg, RUN_REL, planned({ status }));
    assert.equal(v.deny, true, status);
    assert.match(v.reason, /no run is open/, v.reason);
  }
  assert.equal(decide(editOf("src/a.ts"), repo, cfg, RUN_REL, planned({ status: "open" })).deny, false);
});

test("C11 refused and edge: inline code is judged by what it writes: a code target waits for the plan, a scratch target with code only read does not", () => {
  for (const cmd of [
    `python3 - <<'EOF'\nopen('/tmp/o','w').write(open('scripts/lib/stop.mjs').read())\nEOF`,
    `node -e 'require("fs").writeFileSync("/tmp/o", require("fs").readFileSync("src/a.ts","utf8"))'`,
    `python3 - <<'EOF'\nout='/tmp/o.txt'\nopen(out,'w').write(open('src/a.ts').read())\nEOF`,
    `cd /tmp && python3 -c "open('out.txt','w').write('x')"`,
    `cd /tmp/x/scratchpad && node -e "require('fs').writeFileSync('out.json','{}')"`,
    `cd ${repo} && python3 - <<'EOF'\nout='docs/report.md'\nopen(out,'w').write(open('src/a.ts').read())\nEOF`,
  ]) assert.equal(decide(bash(cmd), repo, cfg, null, null).deny, false, cmd);
  assert.match(decide(bash(`cd ${repo} && python3 -c "open('src/a.ts','w').write('x')"`), repo, cfg, null, null).reason ?? "", /writes src\/a\.ts/, "an absolute cd into the repo is followed");
  const lostWrite = decide(bash(`cd $X && python3 -c "open('a.ts','w').write('x')"`), repo, cfg, null, null);
  assert.equal(lostWrite.deny, true);
  assert.ok(lostWrite.paths.every((p) => !/cannot follow/.test(p)), "the note stays in the reason, not the path");
  for (const cmd of [
    `python3 - <<'EOF'\np='src/a.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF`,
    `node -e 'require("fs").writeFileSync("src/a.ts","x")'`,
    `python3 -c "open('src/a.ts','a').write('x')"`,
    `python3 - <<'EOF'\nimport os\nopen(os.environ['T'],'w').write(open('src/a.ts').read())\nEOF`,
    `cd src && python3 -c "open('a.ts','w').write('x')"`,
    `cd src && node -e "require('fs').writeFileSync('a.ts','x')"`,
    `cd $D && python3 -c "open('a.ts','w').write('x')"`,
    `python3 - <<'EOF'\np='src/a.ts'\ns=open(p).read()\nopen(p,'w').write(s)\np='/tmp/log.txt'\nEOF`,
  ]) {
    const v = decide(bash(cmd), repo, cfg, null, null);
    assert.equal(v.deny, true, cmd);
  }
  assert.match(decide(bash(`cd src && python3 -c "open('a.ts','w').write('x')"`), repo, cfg, null, null).reason, /writes src\/a\.ts/, "the cd is followed");
  assert.match(decide(bash(`cd $D && python3 -c "open('a.ts','w').write('x')"`), repo, cfg, null, null).reason, /cannot follow/, "a folder it cannot read");
  assert.equal(decide(bash(`cd docs && python3 -c "open('notes.md','w').write('x')"`), repo, cfg, null, null).deny, false, "a docs write after cd");
});

// ---------------------------------------------------------------------------
// keep-runs-small: a run that outgrew its plan takes no new code files
// ---------------------------------------------------------------------------

const grown = (files, measured) => planned({ tier: { predictedFiles: files, measured: { files: measured } } });

test("C2 refused: a run planned at 3 files that grew to 13 refuses a new unplanned code file, naming close-and-new-run and re-plan", () => {
  const v = decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, grown(["src/a.ts", "src/b.ts", "src/c.ts"], 13));
  assert.equal(v.deny, true);
  assert.match(v.reason, /new run|gate open/, v.reason);
  assert.match(v.reason, /gate plan add src\/new\.ts/, v.reason);
  assert.match(v.reason, /planned 3/, v.reason);
  const shell = decide(bash("echo x > src/new.ts"), repo, cfg, RUN_REL, grown(["src/a.ts", "src/b.ts", "src/c.ts"], 13));
  assert.equal(shell.deny, true, "a shell write is held the same way");
});

test("C3 edge: planned files and test files stay editable however big the run; under the growth limit unplanned files are free", () => {
  const big = grown(["src/a.ts", "src/b.ts", "src/c.ts"], 13);
  assert.equal(decide(editOf("src/a.ts"), repo, cfg, RUN_REL, big).deny, false, "a planned file");
  assert.equal(decide(editOf("tests/new.test.ts", "Write"), repo, cfg, RUN_REL, big).deny, false, "a test file");
  assert.equal(decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, grown(["src/a.ts", "src/b.ts", "src/c.ts"], 12)).deny, false, "12 < 3 + 10");
  assert.equal(decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, grown(Array.from({ length: 12 }, (_, i) => `src/p${i}.ts`), 23)).deny, false, "23 < 2 x 12");
  assert.equal(decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, grown(Array.from({ length: 12 }, (_, i) => `src/p${i}.ts`), 24)).deny, true, "24 = 2 x 12");
});

test("C4 edge: a run with no planned files is held only past 40 changed files", () => {
  assert.equal(decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, grown([], 40)).deny, false);
  assert.equal(decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, grown([], 41)).deny, true);
});

test("C6 edge: only the lead is held; a helper edits the files its packet names, and planned tests and docs do not count as planned code", () => {
  const big = grown(["src/a.ts", "src/b.ts", "src/c.ts"], 13);
  assert.equal(decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, big).deny, true, "the lead");
  assert.equal(decide({ ...editOf("src/new.ts", "Write"), agent_id: "A1", agent_type: "done-gate:worker" }, repo, cfg, RUN_REL, big).deny, false, "a worker");
  const padded = grown(["src/a.ts", "tests/a.test.ts", "tests/b.test.ts", "docs/notes.md"], 11);
  assert.equal(decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, padded).deny, true, "1 code file planned, 11 changed: 11 >= 1 + 10");
});

test("C5 happy: once the plan names the new file, the edit passes", () => {
  assert.equal(decide(editOf("src/new.ts", "Write"), repo, cfg, RUN_REL, grown(["src/a.ts", "src/b.ts", "src/c.ts", "src/new.ts"], 13)).deny, false);
});

{
const repo = makeRepo("fence-reads-own");
const cfg = loadConfig(repo);
const RUN_DIR = ".claude/gate/runs/2026-11-07-x";
const asked = (command, agent_type) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1", ...(agent_type ? { agent_id: "A1", agent_type } : {}) });
const verdict = (command, agent_type) => decide(asked(command, agent_type), repo, cfg, RUN_DIR);

test("the listing forms, /usr/bin/grep and rtk read pass beside a gate path", () => {
  for (const cmd of [
    `/usr/bin/grep x ${RUN_DIR}/verify.json`,
    `/bin/cat ${RUN_DIR}/verify.json`,
    `git tag --list; cat ${RUN_DIR}/verify.json`,
    `git tag -l 'v*'; ls ${RUN_DIR}`,
    `git tag; ls ${RUN_DIR}`,
    `git tag --contains abc; ls ${RUN_DIR}`,
    `git branch; ls ${RUN_DIR}`,
    `git branch -a; ls ${RUN_DIR}`,
    `git branch -vv; ls ${RUN_DIR}`,
    `git branch -r --contains abc; ls ${RUN_DIR}`,
    `git branch --show-current; ls ${RUN_DIR}`,
    `git branch --merged main; ls ${RUN_DIR}`,
    `git reflog; ls ${RUN_DIR}`,
    `git reflog -5; ls ${RUN_DIR}`,
    `git reflog show main; ls ${RUN_DIR}`,
    `git --no-pager log -1; ls ${RUN_DIR}`,
    `git -C . --no-pager diff; ls ${RUN_DIR}`,
    `rtk read ${RUN_DIR}/ledger.md`,
    `sed -n '/^## Work/,/^## Why/p' ${RUN_DIR}/ledger.md`,
  ]) assert.equal(verdict(cmd).deny, false, cmd);
});

test("other paths, write forms and names stay refused beside a gate path", () => {
  for (const cmd of [
    `/usr/local/bin/grep x ${RUN_DIR}/verify.json`,
    `/bin/sed -i s/a/b/ ${RUN_DIR}/verify.json`,
    `./bin/cat ${RUN_DIR}/verify.json`,
    `rtk read x > ${RUN_DIR}/ledger.json`,
  ]) assert.equal(verdict(cmd).deny, true, cmd);
  for (const cmd of [
    "git tag -d v1",
    "git tag -a v1",
    "git tag v1",
    "git tag -l -d v1",
    "git branch -D x",
    "git branch -d x",
    "git branch x",
    "git branch -m a b",
    "git branch -a x",
    "git branch -u origin/x",
    "git branch --list -D x",
    "git reflog expire --all",
    "git reflog delete HEAD@{0}",
    "git --no-pager commit -m x",
    "git -c core.pager=evil log",
  ]) assert.equal(readsOnly(cmd), false, cmd);
});

test("a reviewer's write through /bin/ or /usr/bin/ is refused", () => {
  for (const cmd of ["/bin/rm src/a.ts", "/usr/bin/tee src/a.ts", "rtk proxy /bin/rm src/a.ts", "'/bin/rm' src/a.ts",
    "/usr/bin/cd /tmp; rm src/a.ts", "sed -i'' s/a/b/ src/a.ts", "sed \"-i\" s/a/b/ src/a.ts", "find . | xargs /bin/rm", "git --no-pager commit -am x", "git -c a=b commit -am x", "git --git-dir .git commit -am x"]) {
    assert.equal(verdict(cmd, "done-gate:reviewer").deny, true, cmd);
  }
});

test("a helper's cd into the run folder then a write to its own file passes", () => {
  for (const [cmd, role] of [
    [`cd ${RUN_DIR} && cat > worker-2.md <<'E'\nx\nE`, "done-gate:worker"],
    [`cd ${RUN_DIR} && cat >> worker-2.md <<'E'\nx\nE`, "done-gate:worker"],
    [`cd ${RUN_DIR} && sed -i '' s/a/b/ review-1.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' '/^- /d' review-1.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' 's/old word/better/g' review-1.md`, "done-gate:reviewer"],
    [`cd "${repo}/${RUN_DIR}" && cat > skeptic-1.md <<'E'\nx\nE`, "done-gate:skeptic"],
  ]) assert.equal(verdict(cmd, role).deny, false, cmd);
  const logged = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ ...asked(`cd ${RUN_DIR} && cat > worker-2.md <<'E'\nx\nE`, "done-gate:worker"), hook_event_name: "PostToolUse", tool_response: {} }),
    encoding: "utf8", env: envFor(repo),
  });
  assert.equal(logged.status, 0, logged.stderr);
  const events = readFileSync(path.join(repo, ".claude/gate/sessions/S1/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.kind === "edit" && e.path === `${RUN_DIR}/worker-2.md`), "the write logs an edit event");
});

test("the cd form stays refused when it reaches anything but the helper's own file", () => {
  for (const cmd of [
    `cd ${RUN_DIR} && cat > worker-2.md; echo x > ledger.json`,
    `cd ${RUN_DIR} && cat > ledger.json`,
    `cd ${RUN_DIR} && cat > review-1.md`,
    `cd ${RUN_DIR} && cat > worker-$n.md`,
    `cd ${RUN_DIR} && python3 - <<'E'\nopen('ledger.json', 'w').write('{}')\nE`,
    `cd ${RUN_DIR} && python3 - <<'E'\nopen('worker-2.md', 'w').write('x')\nopen('verify.json', 'w').write('{}')\nE`,
    `cd ${RUN_DIR}/../.. && cat > worker-2.md`,
    `cd ${RUN_DIR} && cd .. && cat > worker-2.md`,
    `cd ${RUN_DIR} && cat > worker-2.md && git commit -am x`,
    `cd ${RUN_DIR} && cat > worker-2.md; gzip ledger.json`,
    `cd ${RUN_DIR} && ln -sf ledger.json worker-2.md`,
    `cd ${RUN_DIR} && cat > worker-2.md; awk 'BEGIN { print "x" > "ledger.json" }'`,
    `cd ${RUN_DIR} && sed -i '' 's/a/b/w ledger.json' worker-2.md`,
    `cd ${RUN_DIR} && sed -i '' 's/a/b/;w ledger.json' worker-2.md`,
    `cd ${RUN_DIR} && sed -i '' 's/a/b/; w ledger.json' worker-2.md`,
    `cd ${RUN_DIR} && sed -i '' -e 's/a/b/' -e 'w ledger.json' worker-2.md`,
    `cd ${RUN_DIR} && sed -i '' 's/a/b/;{w ledger.json}' worker-2.md`,
    `cd ${RUN_DIR} && sed -i '' '1!w ledger.json' worker-2.md`,
    `cd ${RUN_DIR} && sed -i '' '/a/!w ledger.json' worker-2.md`,
    `cd ${RUN_DIR} && sed -i '' -f x.sed worker-2.md`,
    `cd ${RUN_DIR} && echo x > worker-2.md; echo y >&ledger.json`,
    `cd ${RUN_DIR} && echo x > worker-2.md; echo y >& ledger.json`,
    `cd ${RUN_DIR} && echo x > worker-2.md; echo y &>ledger.json`,
    `cd ${RUN_DIR} && echo x > worker-2.md; sed -i'' s/a/b/ ledger.json`,
    `cd ${RUN_DIR} && echo x > worker-2.md; sed "-i" s/a/b/ ledger.json`,
    `cd ${RUN_DIR} && echo x > worker-2.md; sed -i'' s/a/b/ led*`,
    `cd ${RUN_DIR} && echo x > "worker-2.md"; echo y > "ledger.json"`,
    `cd ${RUN_DIR} && echo x > worker-2.md; tee "ledger.json"`,
    `cd ${RUN_DIR} && f=ledger.json; echo x > worker-2.md; echo y > $f`,
    `cd ${RUN_DIR} && sed -i '' --file=x.sed worker-2.md`,
    `cd ${RUN_DIR} && sed -i '' 's/a/b/' worker-2.md --file=x.sed`,
    `cd ${RUN_DIR} && sed -i '' 's/a/b/w ledger.json' worker-2.md`,
    `cd ${RUN_DIR} && cat > worker-2.md; rm ledger.json`,
    `cd ${RUN_DIR} && cat > worker-2.md $(rm ledger.json)`,
    `cd ${RUN_DIR} && echo x | tee ledger.json worker-2.md`,
  ]) assert.equal(verdict(cmd, "done-gate:worker").deny, true, cmd);
});

test("a read beside a command the fence cannot see past says what it is and to run the read alone, and a real write keeps its wording", () => {
  for (const [cmd, what] of [
    [`npx vitest run x; tail -$N ${RUN_DIR}/ledger.md`, "a `$`"],
    [`t() { npx vitest run x; }; t; ls ${RUN_DIR}`, "a function"],
    [`for i in 1 2; do npm test; done; ls ${RUN_DIR}`, "`for`"],
    [`if npm test; then ls ${RUN_DIR}; fi`, "`if`"],
    [`PAGER=sh; git log; ls ${RUN_DIR}`, "an assignment"],
    [`export CI=1; npm test; ls ${RUN_DIR}`, "`export`"],
  ]) {
    const beside = verdict(cmd).reason;
    assert.ok(beside.startsWith(`done-gate: reading the gate folder beside another command is refused when the line holds ${what}:`), `${cmd}: ${beside}`);
    assert.match(beside, /Run the read as its own command/);
    assert.doesNotMatch(beside, /writes gate evidence/);
  }
  const write = verdict(`echo x >> ${RUN_DIR}/verify.json`).reason;
  assert.match(write, /writes gate evidence files/);
  assert.doesNotMatch(write, /as its own command/);
  for (const leads of [`cd ${RUN_DIR} && rm ledger.json`, `D=${RUN_DIR}; rm $D/ledger.json`, `for f in ${RUN_DIR}/*; do rm $f; done`, `ls ${RUN_DIR} | xargs rm`, `cd "${repo}"/.claude; npm test; cat gate/lessons.md`, `cat ${RUN_DIR}/ledger.md | node x.mjs $X`]) {
    const v = verdict(leads);
    assert.equal(v.deny, true, leads);
    assert.doesNotMatch(v.reason, /as its own command/, `running this part alone would still reach the gate folder: ${leads}`);
  }
  for (const last of ["echo $HOME", "export CI=1", "npm test"]) {
    const heredoc = verdict(`python3 - <<'E'\nopen('${RUN_DIR}/verify.json','w').write('x')\nE\n${last}`).reason;
    assert.match(heredoc, /writes gate evidence files/, last);
    assert.doesNotMatch(heredoc, /as its own command/, last);
  }
  const both = verdict(`npm test; echo x >> ${RUN_DIR}/verify.json`).reason;
  assert.match(both, /writes gate evidence files/, "the write decides when both are there");
});

test("a role with no Edit tool is told Write only, and one with it hears both", () => {
  const told = (role, file) => verdict(`sed -i '' s/a/b/ ${RUN_DIR}/${file}; cat ${RUN_DIR}/ledger.json`, role).reason;
  assert.match(told("done-gate:reviewer", "review-1.md"), /Use the Write tool, or sed -i with plain s or d commands, on/);
  assert.doesNotMatch(told("done-gate:reviewer", "review-1.md"), /Edit/);
  assert.match(told("done-gate:skeptic", "skeptic-1.md"), /Use the Write tool, or sed -i with plain s or d commands, on/);
  assert.match(told("done-gate:worker", "worker-1.md"), /Use the Edit or Write tool, or sed -i with plain s or d commands, on/);
});
}

{
const repo = makeRepo("fence-home-driver");
const cfg = loadConfig(repo);
const lead = (command, config = cfg) => decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1" }, repo, config, null, null);
const edit = (rel, config = cfg) => decide({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(repo, rel) }, cwd: repo, session_id: "S1" }, repo, config, null, null);
const pyWrite = (name) => `python3 - <<'E'\nopen('${name}','w').write('x')\nE`;
const withHome = (home, run) => {
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    return run();
  } finally {
    process.env.HOME = before;
  }
};

test("a lead script writing under ~ passes with no run open, by cd ~/x and by bare cd", () => {
  for (const cmd of [`cd ~/.claude/projects/x/memory && ${pyWrite("note.md")}`, `cd ~ && ${pyWrite("notes.txt")}`, `cd && ${pyWrite("notes.txt")}`]) {
    assert.equal(lead(cmd).deny, false, cmd);
  }
});

test("a command that could move home, ~user, a stray pushd and a ~ path into the repo's source stay refused", () => {
  for (const cmd of [
    `HOME=${repo}/src; cd ~ && ${pyWrite("a.ts")}`,
    `export HOME=${repo}/src; cd ~ && ${pyWrite("a.ts")}`,
    `env HOME=${repo}/src sh -c true; cd ~ && ${pyWrite("a.ts")}`,
    `read HOME; cd ~ && ${pyWrite("a.ts")}`,
    `unset HOME; cd ~ && ${pyWrite("a.ts")}`,
    `source env.sh; cd ~ && ${pyWrite("a.ts")}`,
    `. env.sh; cd ~ && ${pyWrite("a.ts")}`,
    `eval "$X"; cd ~ && ${pyWrite("a.ts")}`,
    `cd ~other/x && ${pyWrite("a.ts")}`,
    `cd ${repo}/src; pushd /tmp; pushd; ${pyWrite("a.ts")}`,
    `(cd ~/x && true); ${pyWrite("src/a.ts")}`,
    `pushd ~/x; popd; ${pyWrite("src/a.ts")}`,
  ]) assert.equal(lead(cmd).deny, true, cmd);
  const into = withHome(path.dirname(repo), () => lead(`cd ~/${path.basename(repo)}/src && ${pyWrite("a.ts")}`));
  assert.equal(into.deny, true);
  assert.match(into.reason, /writes src\/a\.ts/);
});

test("a name test by suffix is not a target; a literal compared whole, with a folder, or listed stays a possible one", () => {
  const unknown = (check, target = "f + '.bak'") => `python3 - <<'E'\nfor f in files:\n  if ${check}: open(${target},'w')\nE`;
  for (const check of ["f.endswith('.test.ts')", "f.startswith('.eslintrc.js')", "f.endswith(('.test.ts', '.spec.ts'))"]) {
    assert.equal(lead(unknown(check)).deny, false, check);
  }
  assert.equal(lead(`node -e "for (const f of files) if (f.endsWith('.test.ts') || f.includes('.spec.ts')) require('fs').writeFileSync(f + '.x', '')"`).deny, false);
  for (const cmd of [
    unknown("f == 'src/a.ts'", "f"),
    unknown("f in ['src/a.ts']", "f"),
    unknown("f.endswith('src/a.ts')", "f"),
    `python3 - <<'E'\nfor f in ['src/a.ts', 'src/b.ts']:\n  open(f,'w')\nE`,
    `python3 - <<'E'\n[open(f,'w') for f in ('src/a.ts',)]\nE`,
    `python3 - <<'E'\np=compute()\nopen(p,'w').write('src/a.ts')\nE`,
    `python3 - <<'E'\nname='.eslintrc.js'\np=name+''\nopen(p,'w')\nE`,
  ]) assert.equal(lead(cmd).deny, true, cmd);
});

const withSource = makeRepo("fence-driver-source", { ".claude/gate.json": JSON.stringify({ source: ["src/**", ".claude/skills/**"] }) });
const driverCfg = loadConfig(withSource);
const named = makeRepo("fence-driver-named", { ".claude/gate.json": JSON.stringify({ source: ["src/**", ".claude/skills/**"], driver: "skill:drive" }) });
const namedCfg = loadConfig(named);

test("a driver file edit passes with no run, by Edit and by shell, and is not R1", () => {
  assert.equal(driverCfg.isSource(".claude/skills/verify/drive.mjs"), true, "it stays source");
  assert.equal(driverCfg.isDriverFile(".claude/skills/verify/drive.mjs"), true);
  const fence = (input) => decide({ hook_event_name: "PreToolUse", cwd: withSource, session_id: "S1", ...input }, withSource, driverCfg, null, null);
  assert.equal(fence({ tool_name: "Write", tool_input: { file_path: path.join(withSource, ".claude/skills/verify/drive.mjs") } }).deny, false);
  assert.equal(fence({ tool_name: "Bash", tool_input: { command: "cat > .claude/skills/verify/SKILL.md <<'E'\nx\nE" } }).deny, false);
  const named2 = decide({ hook_event_name: "PreToolUse", cwd: named, session_id: "S1", tool_name: "Write", tool_input: { file_path: path.join(named, ".claude/skills/drive/run.mjs") } }, named, namedCfg, null, null);
  assert.equal(named2.deny, false, "the skill gate.json names");
  assert.deepEqual(evaluate({ config: driverCfg, ledger: null, changed: [".claude/skills/verify/drive.mjs"], now: { hash: "x", files: {} }, events: [], root: withSource }).filter((u) => u.rule === "R1"), []);
  assert.equal(evaluate({ config: driverCfg, ledger: null, changed: ["src/a.ts"], now: { hash: "x", files: {} }, events: [], root: withSource }).some((u) => u.rule === "R1"), true);
});

test("another skill's folder, a look-alike path and a repo naming another skill are still refused", () => {
  const fence = (root, config, file) => decide({ hook_event_name: "PreToolUse", cwd: root, session_id: "S1", tool_name: "Write", tool_input: { file_path: path.join(root, file) } }, root, config, null, null);
  assert.equal(fence(withSource, driverCfg, ".claude/skills/other/x.mjs").deny, true);
  assert.equal(fence(withSource, driverCfg, ".claude/skills/verify-more/x.mjs").deny, true);
  assert.equal(fence(withSource, driverCfg, "src/.claude/skills/verify/x.mjs").deny, true);
  assert.equal(fence(named, namedCfg, ".claude/skills/verify/x.mjs").deny, true, "this repo's driver is drive");
  assert.equal(driverCfg.isDriverFile(".claude/skills/verify/../other/x.mjs"), false);
  for (const driver of ["cmd:npx playwright test", "skill:a/b"]) {
    const other = makeRepo("fence-driver-cmd", { ".claude/gate.json": JSON.stringify({ source: ["src/**", ".claude/skills/**"], driver }) });
    assert.equal(fence(other, loadConfig(other), ".claude/skills/verify/x.mjs").deny, true, driver);
  }
});
}

// F4: harmless refusals from the trials. A helper edits its own findings file with sed -i, the lead
// appends to its run's ledger.md, pgrep reads, a worktree outside the repo is no gate write, and a
// gate call through a variable is told what to do.
{
const repo = makeRepo("fence-f4");
const cfg = loadConfig(repo);
const RUN_DIR = ".claude/gate/runs/2026-11-09-x";
const asked = (command, agent_type) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1", ...(agent_type ? { agent_id: "A1", agent_type } : {}) });
const verdict = (command, agent_type) => decide(asked(command, agent_type), repo, cfg, RUN_DIR);

test("F4 C1 happy: a helper's sed -i on its own file passes with -e pairs, joined commands, a | delimiter and regex characters in quotes", () => {
  for (const [cmd, role] of [
    [`cd ${repo}/${RUN_DIR} && sed -i '' -e 's/a:110 —/a:111 —/' -e 's/b/c/' review-2.md`, "done-gate:reviewer"],
    [`cd ${repo}/${RUN_DIR}; sed -i '' 's/x:341$/x:140/; s/Manila date/y/' review2-1.md`, "done-gate:reviewer-2"],
    [`cd ${repo}/${RUN_DIR}; sed -i '' 's|Book.tsx:198 |Book.tsx:200 |' review-15.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' 's/[0-9]*x/y/g' review-1.md`, "done-gate:reviewer"],
    [`sed -i '' -e 's/a/b/' -e '/^- old/d' ${RUN_DIR}/review-1.md`, "done-gate:reviewer"],
    [`sed -i -E 's#a+#b#2' ${RUN_DIR}/skeptic-1.md`, "done-gate:skeptic"],
    [`cd ${RUN_DIR} && sed -i '' -e 's/a/b/' worker-2.md`, "done-gate:worker"],
  ]) assert.equal(verdict(cmd, role).deny, false, cmd);
});

test("F4 C2 refused: a sed that can write or read elsewhere, or reaches another file, stays refused", () => {
  for (const [cmd, role] of [
    [`cd ${RUN_DIR} && sed -i '' -e 's/a/b/' -e 'w ledger.json' review-1.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' 's|a|b|w ledger.json' review-1.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' 's/a/b/e' review-1.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' 's/a/b/; e rm x' review-1.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' 's/a/b/; r ledger.json' review-1.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i.bak 's/a/b/' review-1.md`, "done-gate:reviewer"],
    [`sed -i.bak 's/a/b/' ${RUN_DIR}/review-1.md`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' -e 's/a/b/' review-1.md ledger.json`, "done-gate:reviewer"],
    [`cd ${RUN_DIR} && sed -i '' -e 's/a/b/' review-1.md`, "done-gate:skeptic"],
    [`sed -i '' 's/a/b/' .claude/gate/runs/2026-11-08-other/review-1.md`, "done-gate:reviewer"],
  ]) assert.equal(verdict(cmd, role).deny, true, cmd);
});

test("F4 C3 refused: a helper's python write to its own file stays refused and is told Write or sed -i", () => {
  const v = verdict(`cd ${repo}/${RUN_DIR} && python3 - <<'EOF'\nopen('review-2.md','w').write('x')\nEOF`, "done-gate:reviewer");
  assert.equal(v.deny, true);
  assert.match(v.reason, /Use the Write tool, or sed -i with plain s or d commands, on review-2\.md/);
  assert.doesNotMatch(v.reason, /Edit/);
  assert.match(verdict(`node -e "require('fs').writeFileSync('${RUN_DIR}/worker-1.md','x')"; cat ${RUN_DIR}/ledger.json`, "done-gate:worker").reason, /Use the Edit or Write tool, or sed -i/);
});

test("F4 C4 reported-surface: a gate call through a variable set elsewhere is refused with the gate() line to use", () => {
  for (const cmd of [`node $G huddle resolve H1.2 --evidence events#4; cat ${RUN_DIR}/ledger.md`, `$G help; ls ${RUN_DIR}`, `node "$G" step tests done x --evidence a; ls ${RUN_DIR}`]) {
    const v = verdict(cmd);
    assert.equal(v.deny, true, cmd);
    assert.match(v.reason, /cannot see through `\$G`/, cmd);
    assert.match(v.reason, /gate\(\) \{ node "[^"]*gate\.mjs" "\$@"; \}/, cmd);
  }
  assert.equal(verdict(`G="node /x/scripts/gate.mjs"; $G next; ls ${RUN_DIR}`).deny, false, "set in the same command, the gate sees it");
});

test("F4 C5 boundary: pgrep beside a gate path reads; pkill does not", () => {
  assert.equal(verdict(`pgrep -f vitest; cat ${RUN_DIR}/verify.json`).deny, false);
  assert.equal(readsOnly("pgrep -fl 'next dev'"), true);
  assert.equal(readsOnly("pkill -f vitest"), false);
});

test("F4 C6 boundary: git worktree remove outside the repo, prune and list pass beside a gate path; inside the repo or add stays refused", () => {
  for (const cmd of [`git worktree remove --force /tmp/uitrial-head && grep T16 ${RUN_DIR}/ledger.md`, `git worktree prune; ls ${RUN_DIR}`, `git worktree list; ls ${RUN_DIR}`]) assert.equal(verdict(cmd).deny, false, cmd);
  for (const cmd of [`git worktree remove --force ${repo}/wt`, "git worktree remove wt", "git worktree add /tmp/x HEAD"]) assert.equal(readsOnly(cmd, repo), false, cmd);
});

test("F4 C7 refused: the lead appends to its current run's ledger.md from the shell; another run's, ledger.json and a helper's append stay refused", () => {
  for (const cmd of [`cat >> ${RUN_DIR}/ledger.md <<'EOF'\n\n## Decisions\n\n- keep it\nEOF`, `echo "- one more" >> ${RUN_DIR}/ledger.md`, `cd ${RUN_DIR} && cat >> ledger.md <<'EOF'\nx\nEOF`]) assert.equal(verdict(cmd).deny, false, cmd);
  for (const [cmd, role] of [
    [`echo x >> .claude/gate/runs/2026-11-08-other/ledger.md`, undefined],
    [`echo x >> ${RUN_DIR}/ledger.json`, undefined],
    [`echo x >> ${RUN_DIR}/ledger.md; echo y > ${RUN_DIR}/verify.json`, undefined],
    [`echo x >> ${RUN_DIR}/ledger.md`, "done-gate:worker"],
  ]) assert.equal(verdict(cmd, role).deny, true, cmd);
});
}

{
const repo = makeRepo("fence-f4-w");
const cfg = loadConfig(repo);
const RUN_DIR = ".claude/gate/runs/2026-11-09-x";
const asked = (command, agent_type) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1", ...(agent_type ? { agent_id: "A1", agent_type } : {}) });
const verdict = (command, agent_type) => decide(asked(command, agent_type), repo, cfg, RUN_DIR);

test("F4 C8 refused: an s command's w or e flag after any delimiter, or a delimiter inside brackets, is a write", () => {
  for (const script of ["s|a|b|w out", "s,a,b,w out", "s#a#b#gw out", "s|a|b|e", "s|[|]| s|w out||", "s/[/]/x/w out"]) {
    assert.equal(readsOnly(`sed '${script}' x.txt`), false, script);
    assert.equal(verdict(`sed '${script}' ${RUN_DIR}/ledger.md`, "done-gate:reviewer").deny, true, script);
    assert.equal(verdict(`sed -i '' '${script}' ${RUN_DIR}/review-1.md`, "done-gate:reviewer").deny, true, `-i ${script}`);
  }
  assert.equal(verdict(`sed -i '' 's/[0-9]*x/y/g' ${RUN_DIR}/review-1.md`, "done-gate:reviewer").deny, false, "brackets without the delimiter stay plain");
  assert.equal(readsOnly("sed -n '/^## Work/,/^## Why/p' x.md"), true);
  for (const cmd of ["cd /tmp && git worktree remove x", "git -C /tmp worktree remove x"]) assert.equal(readsOnly(cmd, repo), false, cmd);
  assert.doesNotMatch(verdict(`$EDITOR notes.txt; ls ${RUN_DIR}`).reason, /gate\(\)/, "no gate verb: no gate() advice");
});
}

// A gate read beside a command that shares nothing with it passes; a pipe, a `$`, a function,
// a cd, a loop or xargs between them keeps the refusal.
{
const repo = makeRepo("fence-beside");
const cfg = loadConfig(repo);
const RUN_DIR = ".claude/gate/runs/2026-11-12-x";
const asked = (command, agent_type) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1", ...(agent_type ? { agent_id: "A1", agent_type } : {}) });
const verdict = (command, agent_type) => decide(asked(command, agent_type), repo, cfg, RUN_DIR);
const passes = (cmds, role) => {
  for (const cmd of cmds) assert.equal(verdict(cmd, role).deny, false, cmd);
};
const refused = (cmds, role) => {
  for (const cmd of cmds) assert.equal(verdict(cmd, role).deny, true, cmd);
};

test("beside C1 reported-surface: the commands the run records were refused for pass beside a gate read", () => {
  passes([
    `npx vitest run "tests/app/(app)/superadmin/moderation" 2>&1 | tail -30; tail -40 .claude/gate/lessons.md`,
    `cat .claude/gate/lessons.md | head -80; npx vitest run "tests/app/(app)/superadmin/contact" 2>&1 | tail -25`,
    `timeout 120 npx eslint "src/app/(app)/tournaments/create/page.tsx" src/components/x.tsx 2>&1 | tail -8; cat .claude/gate/lessons.md | tail -20`,
    `npx tsc --noEmit -p . 2>&1 | grep -cE "error TS"; ls .claude/gate/sessions/ | tail -3`,
    `ls -a; ls .claude; ls -t .claude/gate/runs 2>/dev/null | head -3; git remote -v`,
    `ls ${RUN_DIR}/; ipconfig getifaddr en0; lsof -iTCP:3000`,
    `node --version && ls ${RUN_DIR}`,
    `docker ps --format '{{.Names}}'\ngrep -c kind ${RUN_DIR}/ledger.md`,
    `(npx vitest run tests/lib/posts 2>&1 | tail -15) ; cat .claude/gate/lessons.md | head -60`,
  ]);
  passes([`timeout 300 npx vitest run tests/a.test.tsx 2>&1 | tail -15; cat .claude/gate/lessons.md`], "done-gate:reviewer");
});

test("beside C2 happy: a command let through still gets the checks it gets alone", () => {
  const helper = verdict(`cp src/a.ts src/b.ts; cat ${RUN_DIR}/ledger.md`, "done-gate:reviewer");
  assert.equal(helper.deny, true);
  assert.match(helper.reason, /helpers write through the shell only under scratch paths/);
  const lead = verdict(`cp src/a.ts src/b.ts; cat ${RUN_DIR}/ledger.md`);
  assert.equal(lead.deny, true);
  assert.match(lead.reason, /writes src\/b\.ts and no run is open/);
  const worker = verdict(`git stash; cat ${RUN_DIR}/ledger.md`, "done-gate:worker");
  assert.equal(worker.deny, true);
  assert.match(worker.reason, /a worker runs no git command that moves the tree/);
  mkdirSync(path.join(repo, ".claude", "gate"), { recursive: true });
  symlinkSync(path.join(repo, ".claude", "gate"), path.join(repo, "g"));
  const linked = verdict(`rm ${repo}/g/x.txt; cat ${RUN_DIR}/ledger.md`);
  unlinkSync(path.join(repo, "g"));
  assert.equal(linked.deny, true);
  assert.match(linked.reason, /in the gate's evidence folder/);
  assert.equal(verdict(`cd .claude; rm -rf gate; cat ${RUN_DIR}/ledger.md`).deny, true);
});

test("beside C3 refused: a non-read piped from or to a gate read, and it is not told to run alone", () => {
  for (const cmd of [
    `cat ${RUN_DIR}/ledger.md | node x.mjs`,
    `cat ${RUN_DIR}/ledger.md |& node x.mjs`,
    `cat ${RUN_DIR}/ledger.md |\n  node x.mjs`,
    `cat ${RUN_DIR}/ledger.md | head -3 | node x.mjs`,
    `node x.mjs | grep -f ${RUN_DIR}/ledger.md`,
    `npm test; find .claude/gate -name '*.md' | python3 x.py`,
    `(cat ${RUN_DIR}/ledger.md; echo) | node x.mjs`,
    `cat ${RUN_DIR}/ledger.md <&0 | node x.mjs`,
    `cat ${RUN_DIR}/ledger.md 3<&0 | node x.mjs`,
    `cat ${RUN_DIR}/ledger.md 2>&1 <&0 | node x.mjs`,
    `node x.mjs <&3 | grep -f ${RUN_DIR}/ledger.md`,
    `cat ${RUN_DIR}/ledger.md | (cd /tmp; node x.mjs)`,
  ]) {
    const v = verdict(cmd);
    assert.equal(v.deny, true, cmd);
    assert.match(v.reason, /is not a plain read/, cmd);
    assert.doesNotMatch(v.reason, /as its own command/, cmd);
  }
});

test("beside C4 refused: any $ keeps the refusal; the gate wrapper's \"$@\" does not", () => {
  refused([
    `F=tests/a.test.ts; npx vitest run $F; cat ${RUN_DIR}/ledger.md`,
    `ls ${RUN_DIR}/ledger.json; node x.mjs $_`,
    `npm test; cat $(ls ${RUN_DIR} | head -1)`,
    `npm test; tail -$N ${RUN_DIR}/ledger.md`,
    "npm test; cat `ls " + RUN_DIR + "`",
    `diff <(cat ${RUN_DIR}/a.md) b.md; npm test`,
    `sed -n "$((L-25)),5p" ${RUN_DIR}/ledger.md; npm test`,
    `X=$(cat ${RUN_DIR}/ledger.md); echo "$X" | sh`,
    `npm test "$@"; cat ${RUN_DIR}/ledger.md`,
    `npx vitest run x | grep -E "passed$"; cat ${RUN_DIR}/ledger.md`,
    `npx vitest run x; cat "${RUN_DIR}/$N.md"`,
  ]);
  passes([
    `npx vitest run x 2>&1 | grep -E 'passed$'; awk '{ print $1 }' ${RUN_DIR}/ledger.md`,
    `node x.mjs 'a$b' \\$HOME; grep -c 'x$' ${RUN_DIR}/ledger.md`,
  ]);
  passes([`gate() { node "${gate}" "$@"; }; gate check; npx vitest run x; cat ${RUN_DIR}/ledger.md`, `${WRAPPER}; npx vitest run x | tail -3\ngate check; ls ${RUN_DIR}`]);
});

test("beside C5 refused: a shell builtin or an assignment, which can change what a later word runs, keeps the refusal", () => {
  refused([
    `read PATH; cat ${RUN_DIR}/review-1.md`,
    `read PATH <<< /tmp/evil; cat ${RUN_DIR}/ledger.md`,
    `readonly PATH=/tmp/evil; cat ${RUN_DIR}/ledger.md`,
    `local PATH=/tmp/evil; cat ${RUN_DIR}/ledger.md`,
    `path=(/tmp/evil); cat ${RUN_DIR}/ledger.md`,
    `CDPATH=.claude; cd gate; node x.mjs; cat ${RUN_DIR}/ledger.md`,
    `cdpath=(.claude); cd gate; node x.mjs; cat ${RUN_DIR}/ledger.md`,
    `noglob alias cat=sh\ncat ${RUN_DIR}/ledger.md`,
    `- alias cat=sh\ncat ${RUN_DIR}/ledger.md`,
    `nocorrect eval "npm test"; cat ${RUN_DIR}/ledger.md`,
    `command eval "npm test"; cat ${RUN_DIR}/ledger.md`,
    `builtin alias cat=sh; cat ${RUN_DIR}/ledger.md`,
    `FOO=1; npm test; cat ${RUN_DIR}/ledger.md`,
    `alias cat=rm\ncat ${RUN_DIR}/ledger.json`,
    `export PATH=/tmp/bin:/usr/bin; cat ${RUN_DIR}/ledger.json`,
    `PATH=/tmp/bin; cat ${RUN_DIR}/ledger.json`,
    `eval "npm test"; cat ${RUN_DIR}/ledger.md`,
    `source ./env.sh; cat ${RUN_DIR}/ledger.md`,
    `. ./env.sh && cat ${RUN_DIR}/ledger.md`,
    `set -o allexport; cat ${RUN_DIR}/ledger.md`,
    `trap 'npm test' EXIT; cat ${RUN_DIR}/ledger.md`,
  ]);
});

test("beside C5 refused: a function other than the gate wrapper, or a compound command, keeps the refusal", () => {
  refused([
    `{ cat ${RUN_DIR}/ledger.md; } | node x.mjs`,
    `if true; then cat ${RUN_DIR}/ledger.md; fi | node x.mjs`,
    `cat ${RUN_DIR}/ledger.md | while read l; do node x.mjs; done`,
    `case x in x) cat ${RUN_DIR}/ledger.md;; esac | node x.mjs`,
    `t() { npx vitest run x; }; t; cat ${RUN_DIR}/ledger.md`,
    `function t { npx vitest run x; }; t; cat ${RUN_DIR}/ledger.md`,
    `function t() { npx vitest run x; }\nt\ncat ${RUN_DIR}/ledger.md`,
    `cat() { sh; }; echo "rm -rf ${RUN_DIR}" | cat`,
    `"cat"() sh x.sh; cat ${RUN_DIR}/ledger.md`,
    `'cat' () sh x.sh\ncat ${RUN_DIR}/ledger.md`,
    `gate() { node "${gate}" "$@"; }; cat () { sh; }; npm test; echo "rm ${RUN_DIR}/ledger.json" | cat`,
  ]);
});

test("beside C6 refused: what led to the gate folder before still does", () => {
  refused([
    `cd ${RUN_DIR} && node x.mjs`,
    `if cd ${RUN_DIR}; then node x.mjs; fi`,
    `D=${RUN_DIR}; node x.mjs`,
    `for f in ${RUN_DIR}/*; do node x.mjs; done`,
    `ls ${RUN_DIR} | xargs node`,
    `ls ${RUN_DIR}; echo a | xargs node`,
    `npm test; cat ${RUN_DIR}/ledger.md $(`,
    `cd -- ${RUN_DIR} && find . -delete`,
    `cd -P ${RUN_DIR}; node x.mjs`,
    `\\cd ${RUN_DIR}; node x.mjs`,
    `"cd" ${RUN_DIR}; node x.mjs`,
    `c\\d ${RUN_DIR}; node x.mjs`,
    `cd -- .claude; node x.mjs; cat gate/lessons.md`,
    "cd .claude/ && rm -rf ./gate",
    "cd .claude; node x.mjs gate; cat gate/lessons.md",
    `pushd "${repo}/.claude"; npm test; cat gate/lessons.md`,
    `echo '{"hook_event_name":"PostToolUse","tool_name":"Bash"}' | node "${gate}" log; ls ${RUN_DIR}`,
  ]);
});

test("beside C7 refused: a write that names the gate folder beside a read", () => {
  for (const cmd of ['echo "<"& rm -rf x', "echo '<'&rm -rf x", "echo \\<& rm -rf x", 'echo "a<"& rm -rf x', 'echo ">"& rm -rf x', "echo \\>& rm -rf x", 'echo >""& rm -rf x', 'cat <<<"x<"& rm -rf x']) assert.equal(readsOnly(cmd), false, cmd);
  for (const cmd of ["cat x 2>&1 | head", "cat x <&0 | head", "cat x 3<&0", "cat x >&2"]) assert.equal(readsOnly(cmd), true, cmd);
  refused([
    `echo "<"& rm -rf ${RUN_DIR}`,
    `grep "<"& rm ${RUN_DIR}/ledger.json`,
    `echo ">"& rm -rf ${RUN_DIR}`,
    `cat ${RUN_DIR}/ledger.md | grep "<"& rm -rf ${RUN_DIR}`,
    `npm test; echo x >> ${RUN_DIR}/verify.json`,
    `cat ${RUN_DIR}/ledger.md; rm ${RUN_DIR}/verify.json`,
    `npm test | tee ${RUN_DIR}/out.txt`,
    `cat ${RUN_DIR}/ledger.md; sed -i '' s/a/b/ ${RUN_DIR}/ledger.json`,
    `npm test; node -e "require('fs').writeFileSync('${RUN_DIR}/verify.json','x')"`,
    `npm test; node x.mjs ${RUN_DIR}/verify.json`,
  ]);
});

test("beside C8 boundary: || and & split like ; does, a pipe inside the other command does not join it to the read", () => {
  passes([
    `npm test || cat ${RUN_DIR}/ledger.md`,
    `npm run dev & tail -5 ${RUN_DIR}/ledger.md`,
    `npx vitest run x 2>&1 | tail -5; cat ${RUN_DIR}/ledger.md | head -3`,
    `cat ${RUN_DIR}/ledger.md | head -3\nnpm test | tail -2`,
    `npm test &> /dev/null; ls ${RUN_DIR}`,
  ]);
  refused([`npm test || cat ${RUN_DIR}/ledger.md | node x.mjs`, `cat ${RUN_DIR}/ledger.md | node x.mjs & npm test`]);
  passes([`test -f ${RUN_DIR}/ledger.md && npm test`]);
  // stricter than it has to be: a subshell is read as one pipeline, [[ as a compound command
  refused([`(npm test; cat ${RUN_DIR}/ledger.md)`, `[[ -f ${RUN_DIR}/ledger.md ]] && npm test`]);
});

test("beside C9 edge: a heredoc fed to python passes beside a gate read unless its code names an evidence file and writes", () => {
  passes([`python3 - <<'E'\nopen('/tmp/x.txt','w').write('x')\nE\ncat ${RUN_DIR}/ledger.md`]);
  refused([
    `python3 - <<'E'\nopen('${RUN_DIR}/verify.json','w').write('x')\nE\nnpm test`,
    `cat ${RUN_DIR}/ledger.md | python3 - <<'E'\nopen('/tmp/x.txt','w').write('x')\nE`,
  ]);
});
}

{
const repo = makeRepo("fence-trial-list");
const cfg = loadConfig(repo);
const RUN_DIR = ".claude/gate/runs/2026-11-12-x";
const asked = (command, agent_type) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "S1", ...(agent_type ? { agent_id: "A1", agent_type } : {}) });
const READY = { steps: [] };
const verdict = (command, agent_type, ledger = READY) => decide(asked(command, agent_type), repo, cfg, RUN_DIR, ledger);
const passes = (cmds, role) => {
  for (const cmd of cmds) assert.equal(verdict(cmd, role).deny, false, `${cmd}\n${verdict(cmd, role).reason}`);
};
const refused = (cmds, role) => {
  for (const cmd of cmds) assert.equal(verdict(cmd, role).deny, true, cmd);
};
const py = (file) => `python3 - <<'EOF'\np='${file}'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF`;
const WRAP = `gate() { node "${gate}" "$@"; }`;
const APPEND = `cat >> ledger.md <<'EOF'\n\n## Amendments\n- H1.1: folded\nEOF`;

test("ledger C13 C24 happy: a gate verb call beside cd <run> && cat >> ledger.md passes, whatever plain words the call holds", () => {
  passes([
    `${WRAP};\ngate plan add tests/a.test.ts "its pin reads 0291's hold; 0369 re-issues it (skeptic-1.md H1.6)"\ncd ${RUN_DIR} && ${APPEND}`,
    `${WRAP}; gate plan add docs/friction.md "why it is needed" && cd ${RUN_DIR} && ${APPEND}`,
    `${WRAP}; gate huddle add reviewer --file review-1.md; cd ${RUN_DIR} && ${APPEND}`,
    `${WRAP}; cd ${RUN_DIR} && ${APPEND}\ngate case amend C2 'is it empty? then [] comes back'`,
  ]);
  refused([`${WRAP}; gate report > ledger.json; cd ${RUN_DIR} && ${APPEND}`, `${WRAP}; cd ${RUN_DIR} && ${APPEND}\ngate report > ledger.json`]);
});

test("ledger C16 C24 boundary: a cd form whose gate call holds a $, a substitution or a redirect, or that names another file bare, keeps the refusal", () => {
  refused([
    `${WRAP}; gate plan add "$F" "why it is needed"; cd ${RUN_DIR} && ${APPEND}`,
    `${WRAP}; gate plan add $(cat x) "why it is needed"; cd ${RUN_DIR} && ${APPEND}`,
    `${WRAP}; gate report > ledger.json; cd ${RUN_DIR} && ${APPEND}`,
    `${WRAP}; cd ${RUN_DIR} && ${APPEND}\ngate report > ledger.json`,
    `${WRAP}; cd ${RUN_DIR} && ${APPEND}\ncat x >> ledger.json`,
    `${WRAP}; cd ${RUN_DIR} && cat ledger.json >> ledger.md`,
  ]);
});

test("ledger C14 C22 happy: a name given the run folder once is spelled out: cat >> $R/ledger.md passes in each plain spelling", () => {
  const body = `<<'EOF'\n- one more\nEOF`;
  passes([
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}`,
    `cd ${repo}; R=${RUN_DIR}; cat >> $R/ledger.md ${body}`,
    `R="${repo}/${RUN_DIR}/" && cat >> "\${R}ledger.md" ${body}`,
    `R='${RUN_DIR}'\ncat >> "$R/ledger.md" ${body}`,
    `R=${RUN_DIR}/ && cat >> $R/ledger.md ${body}`,
    `R=${RUN_DIR}; cd $R && cat >> ledger.md ${body}`,
    `${WRAP}; R=${RUN_DIR}; gate plan add tests/a.test.ts "why it is needed"; cat >> $R/ledger.md ${body}`,
  ]);
});

test("ledger C15 refused: with the run folder in a name, a write or an unknown program given another evidence file or the folder alone is refused", () => {
  const body = `<<'EOF'\n- one more\nEOF`;
  refused([
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\ncp /tmp/x $R/verify.json`,
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\nmytool $R/verify.json`,
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\nmytool $R`,
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\nmytool "\${R}"`,
    `R=${RUN_DIR}; cat >> $R/ledger.json ${body}`,
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\npython3 - "$R" <<'E'\nimport sys\nopen(sys.argv[1]+'/ledger.json','w').write('x')\nE`,
  ]);
});

test("ledger H2.4 refused: any other expansion of the name that holds the run folder keeps the refusal", () => {
  const body = `<<'EOF'\n- one more\nEOF`;
  refused([
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\nmytool \${R:-x}/verify.json`,
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\nnode x.mjs "\${R%/}/ledger.json"`,
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\nmytool "\${R%/*}"`,
    `R=${RUN_DIR}; cat >> $R/ledger.md ${body}\nmytool \${#R} \${R/x/y}`,
  ]);
});

test("ledger C16 C22 boundary: a name set twice, by read, for or export, or by a value that expands, and a cd form whose gate call holds a $ or a substitution, keep the refusal", () => {
  const body = `<<'EOF'\n- one more\nEOF`;
  refused([
    `R=${RUN_DIR}; R=${RUN_DIR}/../2026-11-01-other; cat >> $R/ledger.md ${body}\nmytool $R`,
    `R=${RUN_DIR}; read R; cat >> $R/ledger.md ${body}\nmytool x`,
    `for R in ${RUN_DIR}; do cat >> $R/ledger.md ${body}\ndone`,
    `R=$BASE/${RUN_DIR}; cat >> $R/ledger.md ${body}`,
    `cat >> $R/ledger.md ${body}\nR=${RUN_DIR}`,
    `export R=${RUN_DIR}; cat >> $R/ledger.md ${body}\nmytool x`,
    `${WRAP}; gate plan add "$F" "why it is needed"; cd ${RUN_DIR} && ${APPEND}`,
    `${WRAP}; gate plan add $(cat x) "why it is needed"; cd ${RUN_DIR} && ${APPEND}`,
  ]);
});

test("inline refused: a helper's inline write to a test file or a scratch file is refused, as before", () => {
  refused([py("tests/a.qa.test.ts"), `cd /private/tmp/claude-501/x/scratchpad; ${py("probe.mjs")}`], "done-gate:qa");
  refused([py("tests/.tmp/page.tsx")], "done-gate:reviewer");
});

test("inline C1 C2 refused: a helper's inline code that writes source through any writing open mode, write_text, os.replace, writeSync or cpSync is refused", () => {
  const python = (code) => `python3 -c "${code}"`;
  const node = (code) => `node -e "const fs=require('fs');${code}"`;
  const writes = [
    ...["'wb'", "'x'", "'r+'", "'rb+'", "'wt'", "'a+'", "mode='wb'"].map((mode) => python(`open('src/a.ts',${mode}).write('x')`)),
    `python3 - <<'EOF'\np='src/a.ts'\ns=open(p,'rb').read()\nopen(p,'wb').write(s)\nEOF`,
    node("fs.writeSync(fs.openSync('src/a.ts','w'),'x')"),
    node("fs.openSync('src/a.ts','w')"),
    python("from pathlib import Path; Path('src/a.ts').write_text('x')"),
    python("from pathlib import Path; Path('src/a.ts').write_bytes(b'x')"),
    python("import os; os.replace('/tmp/x','src/a.ts')"),
    node("fs.writeSync(3,'x')"),
    node("fs.cpSync('/tmp/x','src/a.ts')"),
  ];
  refused(writes, "done-gate:reviewer");
  refused(writes, "done-gate:qa");
});

test("inline C3 boundary: inline code that only reads still passes for a helper", () => {
  passes([
    `python3 -c "print(open('src/a.ts','rb').read())"`,
    `python3 -c "print(open('src/a.ts','r').read())"`,
    `python3 -c "print(open('src/a.ts').read())"`,
    `python3 -c "print(open('src/a.ts', encoding='utf8').read())"`,
    `node -e "const fs=require('fs');console.log(fs.readSync(fs.openSync('src/a.ts','r'),Buffer.alloc(9)))"`,
    `node -e "console.log(require('fs').readFileSync('src/a.ts','utf8'))"`,
  ], "done-gate:reviewer");
});

test("inline C4 refused: the lead's inline open of an evidence file in mode wb is refused, as mode w is", () => {
  const code = (mode) => `python3 - <<'EOF'\nopen('${RUN_DIR}/verify.json','${mode}').write('{}')\nEOF`;
  refused([code("w"), code("wb"), code("x"), code("r+")]);
});

test("inline C5 edge: the lead's inline open of its ledger.md alone is its own-file write in a and ab; write_text beside it is none", () => {
  const code = (body) => `python3 - <<'EOF'\n${body}\nEOF`;
  for (const mode of ["a", "ab"]) assert.deepEqual(ownFileWrites(code(`open('${RUN_DIR}/ledger.md','${mode}').write('x')`), null, repo), [`${RUN_DIR}/ledger.md`], mode);
  assert.deepEqual(ownFileWrites(code(`from pathlib import Path\nopen('${RUN_DIR}/ledger.md','a').write('x')\nPath('src/a.ts').write_text('x')`), null, repo), []);
});

test("ledger refused: the lead's inline open of its ledger.md in mode ab beside a remove of a code file is no own-file write", () => {
  const code = (body) => `python3 - <<'EOF'\n${body}\nEOF`;
  assert.deepEqual(ownFileWrites(code(`open('${RUN_DIR}/ledger.md','a').write('x')`), null, repo), [`${RUN_DIR}/ledger.md`]);
  assert.deepEqual(ownFileWrites(code(`import os\nopen('${RUN_DIR}/ledger.md','ab').write(b'x')\nos.remove('src/a.ts')`), null, repo), []);
});

test("ledger C17 refused: a helper cannot use the variable form on ledger.md, its own file or another role's; the lead cannot use it on another run's ledger", () => {
  const body = `<<'EOF'\n- one more\nEOF`;
  refused([`R=${RUN_DIR}; cat >> $R/review-2.md ${body}`, `R=${RUN_DIR}; sed -i '' 's/a/b/' $R/review-2.md`], "done-gate:reviewer");
  refused([`R=${RUN_DIR}; cat >> $R/ledger.md ${body}`, `R=${RUN_DIR}; cat >> $R/review2-1.md ${body}`, `R=${RUN_DIR}; cat >> $R/skeptic-1.md ${body}`], "done-gate:reviewer");
  refused([`R=${RUN_DIR}; cat >> $R/ledger.md ${body}`], "done-gate:qa");
  refused([`R=.claude/gate/runs/2026-11-01-other; cat >> $R/ledger.md ${body}`]);
});
}
