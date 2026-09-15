// T12 — helper budget: the fence stops burning a helper's turns on read-only shell,
// packets stop inlining a huge diff, a reading helper must draft first, `gate brief`
// refuses a round whose earlier file vanished, and the Stop hook lets the lead's turn
// end while a helper is still running.
//
// Written from the requirements and the case table, blind to this task's edits to
// scripts/lib/{guard,brief,stop}.mjs and hooks/hooks.json.
//
// source-of-truth anchors
//   role list + each role's own-file prefix → scripts/lib/verbs.mjs (ROLES, the huddle
//     `--file` prefix map: arbiter→arbiter, skeptic→skeptic, worker→worker, else review)
//   event kinds on the wire                 → scripts/lib/events.mjs (subagent-start,
//     subagent-stop, prompt) and tests/fixtures/stdin/*.json
//   agent turn budgets                      → agents/<role>.md frontmatter, against the
//     numbers the requirements state (reviewer 40/medium, reviewer-2 40, skeptic 24)
//   diff line counts                        → the fixture's own bytes
// Never the guard's or the renderer's own tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { ROLES } from "../scripts/lib/verbs.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/skeptic-file.test.mjs and tests/report-tier.test.mjs)
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
// a refusal is a `done-gate: <message>` line on stderr (tests/review-loop.test.mjs).
const REFUSAL = /^done-gate: /m;

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// An open feature ledger with a task, a plan naming files, and a case table.
function opened(name, { planFiles = "src/a.ts", files = {} } = {}) {
  const repo = committed(name, files);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Give helpers a budget. [inferred]"]);
  cli(repo, "note", ["plan", "One module.", "--files", planFiles]);
  cli(repo, "case", ["add", "the helper works inside its budget", "--kind", "happy"]);
  cli(repo, "case", ["add", "everything else is denied", "--kind", "refused"]);
  return repo;
}

// One PreToolUse payload through `gate fence` — the hook entry point, so the rules that
// need the session's current run dir are resolved the way production resolves them.
function fence(repo, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "fence"], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, session_id: session, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  if (out === "") return { deny: false, reason: "" };
  const d = JSON.parse(out).hookSpecificOutput;
  return { deny: d.permissionDecision === "deny", reason: d.permissionDecisionReason ?? "" };
}

const bash = (repo, command, extra = {}) =>
  fence(repo, { tool_name: "Bash", tool_input: { command }, ...extra });
const read = (repo, file_path, extra = {}) =>
  fence(repo, { tool_name: "Read", tool_input: { file_path }, ...extra });
const writeTool = (repo, file_path, extra = {}) =>
  fence(repo, { tool_name: "Write", tool_input: { file_path }, ...extra });

// A hook payload fed to `gate log`, exactly as Claude Code's hooks feed one.
function logHook(repo, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// A Stop hook payload, as tests/stop.test.mjs drives one. Returns the block JSON or null.
function stopHook(repo, message = "done.", session = "S1") {
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
  return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : null;
}

const REVIEWER = { agent_id: "A2", agent_type: "done-gate:reviewer" };

// ---------------------------------------------------------------------------
// C1 happy — read-only shell is free; only a write is denied
// ---------------------------------------------------------------------------

test("C1 happy: a reviewer's read-only inline code and scratch scripts pass the fence, while inline code that writes and an in-place sed on source are denied", () => {
  const repo = opened("budget-shell");

  // No packet has been written into this run dir, so nothing is owed: this case is
  // about the shell rule alone.
  assert.equal(readdirSync(runDir(repo)).filter((f) => f.startsWith("brief-")).length, 0);

  const allowed = [
    // inline code that only reads is not a write
    `node -e "console.log(1)"`,
    `node -e "console.log(require('fs').readFileSync('src/a.ts','utf8'))"`,
    `python3 -c "print(open('src/a.ts').read())"`,
    // a script that lives in scratch space is the helper's own workspace
    "node /tmp/scratch.mjs",
    "node tests/.tmp/scratch.mjs",
    "node --test tests/a.test.ts",
  ];
  for (const cmd of allowed) {
    assert.equal(bash(repo, cmd, REVIEWER).deny, false, `the reviewer was denied a read-only command: ${cmd}`);
  }

  const denied = [
    // inline code that writes is still a write
    `node -e "require('fs').writeFileSync('src/a.ts',1)"`,
    `node -e "require('fs').appendFileSync('src/a.ts','x')"`,
    `node -e "require('fs').rmSync('src/a.ts')"`,
    `python3 -c "open('src/a.ts','w').write('x')"`,
    // a shell write outside scratch is a write however it is spelled
    "sed -i s/a/b/ src/a.ts",
    "echo x > src/a.ts",
    "cp tests/.tmp/a src/b.ts",
  ];
  for (const cmd of denied) {
    const d = bash(repo, cmd, REVIEWER);
    assert.equal(d.deny, true, `the reviewer was allowed to write source: ${cmd}`);
    // the reason has to tell the helper which forms are still open to it
    assert.match(d.reason, /scratch/i, `the denial does not name the allowed forms: ${cmd}\n${d.reason}`);
  }

  // the main session owns the diff: none of this applies to it
  for (const cmd of [...allowed, ...denied.filter((c) => !/\.claude\/gate/.test(c))]) {
    assert.equal(bash(repo, cmd).deny, false, `the lead was denied its own command: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// C2 refused — draft first: a reviewer that owes its file may only read its packet
// ---------------------------------------------------------------------------

test("C2 refused: while a reviewer owes review-1.md its Read of source and its Bash are denied naming that file, its packet Read and its own Write pass, and everything opens up once the file exists", () => {
  const repo = opened("budget-draft-first");
  const dir = runDir(repo);
  const packet = path.join(dir, "brief-reviewer-1.md");
  const own = path.join(dir, "review-1.md");
  writeFileSync(packet, "# Brief: reviewer round 1\n");
  assert.equal(existsSync(own), false, "the reviewer's file must be missing for this case");

  // owed: one brief-reviewer-<n>.md, no review-<n>.md
  const srcRead = read(repo, path.join(repo, "src", "a.ts"), REVIEWER);
  assert.equal(srcRead.deny, true, "a reviewer that owes its draft was allowed to read source");
  assert.match(srcRead.reason, /review-1\.md/, srcRead.reason);

  const anyBash = bash(repo, "grep -rn foo src", REVIEWER);
  assert.equal(anyBash.deny, true, "a reviewer that owes its draft was allowed to run a command");
  assert.match(anyBash.reason, /review-1\.md/, anyBash.reason);

  // the two things it must still be able to do
  assert.equal(read(repo, packet, REVIEWER).deny, false, "the reviewer was denied its own packet");
  assert.equal(writeTool(repo, own, REVIEWER).deny, false, "the reviewer was denied the file it owes");

  // once the draft lands, the role's ordinary permissions are back
  writeFileSync(own, "# Review 1\n\n## Act on\n- unverified\n");
  assert.equal(read(repo, path.join(repo, "src", "a.ts"), REVIEWER).deny, false);
  assert.equal(bash(repo, "grep -rn foo src", REVIEWER).deny, false);
  assert.equal(bash(repo, "node --test tests/a.test.ts", REVIEWER).deny, false);
  assert.equal(writeTool(repo, own, REVIEWER).deny, false);
  // and the rules that were never about drafting still hold
  assert.equal(writeTool(repo, path.join(repo, "src", "a.ts"), REVIEWER).deny, true);
});

// ---------------------------------------------------------------------------
// C3 edge — which roles the draft-first rule reaches
// ---------------------------------------------------------------------------

test("C3 edge: draft-first binds the skeptic, the arbiter and both reviewer roles, and never the worker, QA or the lead", () => {
  const repo = opened("budget-draft-roles");
  const dir = runDir(repo);
  const src = path.join(repo, "src", "a.ts");

  // scripts/lib/verbs.mjs is the source of truth for a role's own-file prefix
  const prefixOf = (role) => ({ arbiter: "arbiter", skeptic: "skeptic", worker: "worker" }[role] ?? "review");
  const agent = (role, i) => ({ agent_id: `A${i}`, agent_type: `done-gate:${role}` });

  // every role in the list gets a packet on disk; none has written its file yet
  for (const role of ROLES) writeFileSync(path.join(dir, `brief-${role}-1.md`), `# Brief: ${role} round 1\n`);

  const BOUND = ["skeptic", "arbiter", "reviewer", "reviewer-2"];
  const FREE = ["worker", "qa"];
  assert.deepEqual([...BOUND, ...FREE].sort(), [...ROLES].sort(), "the case table covers every role in verbs.mjs ROLES");

  BOUND.forEach((role, i) => {
    const who = agent(role, i + 10);
    const owed = `${prefixOf(role)}-1.md`;
    const r = read(repo, src, who);
    assert.equal(r.deny, true, `${role} owed its draft and was still allowed to read source`);
    assert.match(r.reason, new RegExp(owed.replace(".", "\\.")), `${role}: ${r.reason}`);
    assert.equal(bash(repo, "grep -rn foo src", who).deny, true, `${role} owed its draft and was still allowed a command`);
    // its own packet and its own file stay open
    assert.equal(read(repo, path.join(dir, `brief-${role}-1.md`), who).deny, false, `${role} was denied its packet`);
    assert.equal(writeTool(repo, path.join(dir, owed), who).deny, false, `${role} was denied the file it owes`);
  });

  FREE.forEach((role, i) => {
    const who = agent(role, i + 20);
    assert.equal(read(repo, src, who).deny, false, `${role} is not a drafting role but was denied a read`);
    assert.equal(bash(repo, "grep -rn foo src", who).deny, false, `${role} is not a drafting role but was denied a command`);
  });

  // the lead carries no agent_type at all
  assert.equal(read(repo, src).deny, false, "the lead was subjected to draft-first");
  assert.equal(bash(repo, "grep -rn foo src").deny, false, "the lead was subjected to draft-first");

  // the rule counts files, not rounds, and the two reviewer roles share review-<n>.md:
  // a fresh run dir, one reviewer packet, one review file → nothing owed; a second
  // packet of either reviewer role owes again.
  const second = opened("budget-draft-rounds");
  const dir2 = runDir(second);
  const src2 = path.join(second, "src", "a.ts");
  writeFileSync(path.join(dir2, "brief-reviewer-1.md"), "# Brief: reviewer round 1\n");
  writeFileSync(path.join(dir2, "review-1.md"), "# Review 1\n");
  assert.equal(read(second, src2, agent("reviewer", 31)).deny, false, "one packet, one file: nothing owed");
  writeFileSync(path.join(dir2, "brief-reviewer-2-1.md"), "# Brief: reviewer-2 round 1\n");
  assert.equal(
    read(second, src2, agent("reviewer-2", 32)).deny,
    true,
    "reviewer and reviewer-2 share review-<n>.md: two packets against one file owes a draft",
  );
});

// ---------------------------------------------------------------------------
// C4 boundary — a big diff becomes a file list
// ---------------------------------------------------------------------------

test("C4 boundary: above 300 diff lines the reviewer packet drops the unified diff for a changed-file list with line counts, and keeps the diff below it", () => {
  const BIG = 400;
  const bigSrc = Array.from({ length: BIG }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n";
  const bigLines = bigSrc.split("\n").length - 1;
  assert.equal(bigLines, BIG, "fixture anchor: the file's own bytes");

  // over the cap: one 400-line file added after the task opened
  const over = opened("budget-diff-over", { planFiles: "src/big.ts" });
  writeFileSync(path.join(over, "src", "big.ts"), bigSrc);
  const bigPacket = readFileSync(packetPath(over, "reviewer"), "utf8");

  assert.ok(!/^##\s+Diff\s*$/m.test(bigPacket), `a 400-line diff was inlined anyway:\n${bigPacket.slice(0, 500)}`);
  assert.ok(/^##\s+Changed files\b/m.test(bigPacket), `no "## Changed files" section:\n${bigPacket.slice(0, 2000)}`);
  const changed = section(bigPacket, /^##\s+Changed files\b/);
  const row = changed.split("\n").find((l) => l.includes("src/big.ts"));
  assert.ok(row, `src/big.ts is not listed:\n${changed}`);
  assert.match(row, new RegExp(`\\b${BIG}\\b`), `the row carries no line count for a ${BIG}-line file: ${row}`);
  // the reviewer is told what to do instead of reading a diff that is not there
  assert.match(changed, /read/i, `the section does not tell the reviewer to read what it needs:\n${changed}`);
  assert.ok(!/^diff --git /m.test(bigPacket), "a unified diff survived above the cap");

  // under the cap: a four-line change is still inlined
  const under = opened("budget-diff-under", { planFiles: "src/a.ts" });
  writeFileSync(path.join(under, "src", "a.ts"), "export const a = 2;\nexport const b = 3;\n");
  const smallPacket = readFileSync(packetPath(under, "reviewer"), "utf8");
  assert.ok(/^##\s+Diff\s*$/m.test(smallPacket), `no "## Diff" section for a small change:\n${smallPacket.slice(0, 2000)}`);
  assert.match(section(smallPacket, "Diff"), /^diff --git a\/src\/a\.ts /m, section(smallPacket, "Diff"));
  assert.ok(!/^##\s+Changed files\b/m.test(smallPacket), "a small change was summarised instead of shown");
});

// `gate brief <role>` → the packet path it printed.
function packetPath(repo, role, args = []) {
  const r = cli(repo, "brief", [role, ...args]);
  const p = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${r.stdout}`);
  return p;
}

// Text of one `## <heading>` section, up to the next `## ` line. `heading` is the exact
// heading text, or a RegExp when only its opening words are pinned by the requirements.
function section(md, heading) {
  const all = md.split("\n");
  const want = heading instanceof RegExp ? (l) => heading.test(l.trim()) : (l) => l.trim() === `## ${heading}`;
  const start = all.findIndex((l) => /^##\s+\S/.test(l) && want(l));
  assert.ok(start >= 0, `packet has no "## ${heading}" section:\n${md.slice(0, 2000)}`);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

// ---------------------------------------------------------------------------
// C5 refused — a round whose earlier file is gone
// ---------------------------------------------------------------------------

test("C5 refused: gate brief reviewer is refused while a recorded reviewer huddle's file is missing from the run dir, and passes once the file is there", () => {
  const repo = opened("budget-missing-file");
  const dir = runDir(repo);
  const own = path.join(dir, "review-1.md");

  // a reviewer round was recorded against review-1.md, which is not on disk
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md", "--summary", "round one"]);
  assert.equal(existsSync(own), false, "the recorded file must be missing for this case");
  assert.equal(
    loadLedger(dir).huddles.filter((h) => h.role === "reviewer" && h.file === "review-1.md").length,
    1,
    "ledger anchor: one reviewer huddle recorded against review-1.md",
  );

  const refused = run(repo, "brief", ["reviewer"]);
  assert.match(
    refused.stderr,
    REFUSAL,
    `gate brief reviewer was allowed with review-1.md missing:\n${refused.stdout}${refused.stderr}`,
  );
  assert.match(refused.stderr, /review-1\.md/, refused.stderr);
  assert.equal(
    readdirSync(dir).filter((f) => f === "brief-reviewer-2.md").length,
    0,
    "a refused round still wrote a packet",
  );

  // once the file is where the ledger says it is, the next round is briefed
  writeFileSync(own, "# Review 1\n\n## Act on\n- none\n\n## Evidence verdict\n- fine\n");
  const p = packetPath(repo, "reviewer");
  assert.equal(path.basename(p), "brief-reviewer-2.md", p);
});

// ---------------------------------------------------------------------------
// C6 happy — the lead's turn may end while a helper is running
// ---------------------------------------------------------------------------

test("C6 happy: the Stop hook passes silently without finalising while a done-gate helper started since the last prompt has not stopped, and blocks again once its stop event lands", () => {
  const repo = opened("budget-stop-waiting");
  const dir = runDir(repo);
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");

  // baseline: this turn has unmet rules, so it blocks
  const before = stopHook(repo);
  assert.equal(before?.decision, "block", JSON.stringify(before));
  const blocksBefore = loadSession(stateDir(repo), "S1").blocks?.count ?? 0;
  assert.ok(blocksBefore >= 1);

  // a prompt, then a helper the lead is waiting on
  logHook(repo, { hook_event_name: "UserPromptSubmit", user_message: "keep going" });
  logHook(repo, { hook_event_name: "SubagentStart", agent_id: "A9", agent_type: "done-gate:reviewer" });

  assert.equal(stopHook(repo), null, "the turn was blocked while a helper was still running");
  // and nothing was finalised or counted while it waited
  const ledger = loadLedger(dir);
  assert.equal(ledger.status, "open", "the ledger was closed while a helper was running");
  assert.ok(loadSession(stateDir(repo), "S1").current, "the session's run was cleared while a helper was running");

  // the helper stops: the normal rules apply again
  logHook(repo, { hook_event_name: "SubagentStop", agent_id: "A9", agent_type: "done-gate:reviewer", stop_hook_active: false });
  assert.equal(stopHook(repo)?.decision, "block", "the turn was let go after the helper stopped");

  // the refused side: an agent that is not a done-gate helper never buys a quiet stop,
  // and neither does a helper that started before the newest prompt
  logHook(repo, { hook_event_name: "UserPromptSubmit", user_message: "again" });
  logHook(repo, { hook_event_name: "SubagentStart", agent_id: "A7", agent_type: "general-purpose" });
  assert.equal(stopHook(repo)?.decision, "block", "a general-purpose agent bought a quiet stop");

  logHook(repo, { hook_event_name: "SubagentStart", agent_id: "A8", agent_type: "done-gate:skeptic" });
  logHook(repo, { hook_event_name: "UserPromptSubmit", user_message: "new turn, the old helper is history" });
  assert.equal(stopHook(repo)?.decision, "block", "a helper started before the newest prompt bought a quiet stop");
});

// ---------------------------------------------------------------------------
// C7 edge — the budgets the agent files state
// ---------------------------------------------------------------------------

test("C7 edge: reviewer is 40 turns at effort medium, reviewer-2 is 40 and the skeptic 24, and every agent's By-turn line matches its own frontmatter", () => {
  const agentsDir = path.join(pluginRoot, "agents");

  function frontmatter(role) {
    const text = readFileSync(path.join(agentsDir, `${role}.md`), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(m, `agents/${role}.md has no frontmatter block`);
    const fm = {};
    for (const line of m[1].split("\n")) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    return { fm, body: text.slice(m[0].length) };
  }

  // the numbers the requirements state
  const WANT = { reviewer: 40, "reviewer-2": 40, skeptic: 24 };
  for (const [role, turns] of Object.entries(WANT)) {
    const { fm } = frontmatter(role);
    assert.equal(fm.maxTurns, String(turns), `agents/${role}.md maxTurns`);
  }
  assert.equal(frontmatter("reviewer").fm.effort, "medium", "agents/reviewer.md effort");

  // every agent states its budget as a number, and the By-turn line agrees with it
  for (const role of ROLES) {
    const { fm, body } = frontmatter(role);
    const max = Number(fm.maxTurns);
    assert.ok(Number.isInteger(max) && max > 0, `agents/${role}.md has no numeric maxTurns: ${fm.maxTurns}`);
    const stated = /You have (\d+) turns?\./.exec(body);
    assert.ok(stated, `agents/${role}.md never states its budget as a number`);
    assert.equal(Number(stated[1]), max, `agents/${role}.md states ${stated[1]} turns but maxTurns is ${max}`);
    const by = /By turn (\d+)/.exec(body);
    assert.ok(by, `agents/${role}.md has no "By turn <n>" line`);
    assert.equal(Number(by[1]), max - 2, `agents/${role}.md: By turn ${by[1]} does not match a ${max}-turn budget`);
  }
});

// ---------------------------------------------------------------------------
// C8 happy — the prompt line names the packet and the file the helper owes
// ---------------------------------------------------------------------------

test("C8 happy: the prompt line gate brief prints names both the packet path and the helper's own output file", () => {
  const repo = opened("budget-prompt-line");
  const dir = runDir(repo);
  // scripts/lib/verbs.mjs is the source of truth for a role's own-file prefix
  const prefixOf = (role) => ({ arbiter: "arbiter", skeptic: "skeptic", worker: "worker" }[role] ?? "review");

  for (const role of ["skeptic", "reviewer"]) {
    const r = cli(repo, "brief", [role]);
    const out = lines(r.stdout);
    const packet = out.find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
    const prompt = out.find((l) => l.startsWith("prompt: "));
    assert.ok(packet, `no "packet: <path>" line for ${role}:\n${r.stdout}`);
    assert.ok(prompt, `no "prompt: <text>" line for ${role}:\n${r.stdout}`);
    assert.equal(path.basename(packet), `brief-${role}-1.md`, packet);
    assert.ok(prompt.includes(packet), `the prompt line does not name the packet:\n${prompt}`);
    const own = `${prefixOf(role)}-1.md`;
    assert.ok(prompt.includes(own), `the prompt line does not name ${own}, the file ${role} owes:\n${prompt}`);
    // the file it names is the one in this run dir, not some other task's
    assert.ok(existsSync(path.dirname(path.join(dir, own))), dir);
  }
});
