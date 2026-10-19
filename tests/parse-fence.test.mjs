import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDraft, parseFindings } from "../scripts/lib/rules.mjs";
import { decide, readsOnly, scratchOnly } from "../scripts/lib/guard.mjs";
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
    `git stash; cat ${EVIDENCE}`,
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
    `read PATH; cat ${RUN}/review-1.md`,
    `cat ${RUN}/review-1.md | tee >(cat > x)`,
    `npx vitest run >/dev/null 2>&1; ls ${RUN}`,
    `S=/tmp/x; cat a > $S/b; cp $S/b ${RUN}/review-1.md`,
    `cat ${RUN}/review-1.md > /tmp/x/r.md; mv /tmp/x/r.md ${RUN}/review-1.md`,
    `rm /tmp/proj/${RUN}/verify.started.json`,
    `cd /tmp/proj/.claude/gate && rm runs/x/ledger.json`,
    `cat a > /tmp/proj/.claude/gate/runs/x/review-1.md`,
  ]) {
    assert.equal(decide(bash(cmd), repo, cfg).deny, true, cmd);
  }
  for (const cmd of ["read -r PAGER", "read GIT_SSH_COMMAND", "xargs -I {} rm {}", "xargs -0 sed -i s/a/b/", "$(ls) x"]) assert.equal(readsOnly(cmd), false, cmd);
});

test("C4 edge: the deny names the part that is not a plain read, and points the file's owner at the edit tools", () => {
  const ledger = decide(bash(`ls ${RUN}; cat >> ${RUN}/ledger.md <<'EOF'\nx\nEOF`), repo, cfg);
  assert.equal(ledger.deny, true);
  assert.match(ledger.reason, /`cat >> \S*ledger\.md/, ledger.reason);
  assert.match(ledger.reason, /Edit or Write tool on ledger\.md/, ledger.reason);
  const other = decide(bash(`npx vitest run >/dev/null 2>&1; ls ${RUN}`), repo, cfg);
  assert.match(other.reason, /`npx vitest run/, other.reason);
  assert.doesNotMatch(other.reason, /Edit or Write tool/, other.reason);
  const long = decide(bash(`node scripts/x.mjs ${"--flag ".repeat(40)}; ls ${RUN}`), repo, cfg);
  assert.ok(long.reason.length < 600, `the quoted part is cut short: ${long.reason.length}`);
});

test("C11 edge: the edit-tool hint goes only to the caller that owns the file", () => {
  const as = (role) => ({ agent_id: "A1", agent_type: `done-gate:${role}` });
  const sedOn = (file) => `cd ${RUN} && sed -i '' 's/a/b/' ${file}`;
  for (const [role, file] of [["reviewer", "review-6.md"], ["reviewer-2", "review2-2.md"], ["skeptic", "skeptic-1.md"], ["arbiter", "arbiter-1.md"], ["worker", "worker-4.md"]]) {
    const v = decide(bash(sedOn(file), as(role)), repo, cfg);
    assert.equal(v.deny, true, `${role} ${file}`);
    assert.match(v.reason, new RegExp(`Edit or Write tool on ${file.replace(".", "\\.")}`), `${role}: ${v.reason}`);
  }
  for (const [who, file] of [[{}, "review-6.md"], [as("reviewer"), "review2-2.md"], [as("worker"), "review-6.md"]]) {
    const v = decide(bash(sedOn(file), who), repo, cfg);
    assert.equal(v.deny, true, file);
    assert.doesNotMatch(v.reason, /Edit or Write tool/, `${who.agent_type ?? "lead"} on ${file}: ${v.reason}`);
  }
  const helperLedger = decide(bash(`cat >> ${RUN}/ledger.md <<'EOF'\nx\nEOF`, as("worker")), repo, cfg);
  assert.equal(helperLedger.deny, true);
  assert.doesNotMatch(helperLedger.reason, /Edit or Write tool on ledger/, helperLedger.reason);
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
  assert.match(v.reason, /Edit or Write tool on worker-4\.md/, v.reason);
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
  symlinkSync(path.dirname(gate), link);
  try {
    assert.equal(scratchOnly(`rm ${link}`), true, "the link itself is in scratch");
    assert.equal(scratchOnly(`rm ${link}/gate.mjs`), false, "a file through the link is outside scratch");
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
  const lostWrite = decide(bash(`cd ~/x && python3 -c "open('a.ts','w').write('x')"`), repo, cfg, null, null);
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
