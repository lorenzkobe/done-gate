import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { pointerResolver } from "../scripts/lib/rules.mjs";
import { reviewFiles } from "../scripts/lib/assess.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/next-hints.test.mjs and tests/helper-packets.test.mjs)
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

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
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

// An open feature ledger at tier standard (two planned files), with a case table.
function opened(name, { planFiles = "src/a.ts,src/app/page.tsx", files = {} } = {}) {
  const repo = committed(name, files);
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Give the skeptic a file. [inferred]"]);
  cli(repo, "note", ["plan", "Two modules.", "--files", planFiles]);
  cli(repo, "case", ["add", "the skeptic writes its file", "--kind", "happy"]);
  cli(repo, "case", ["add", "everyone else is denied", "--kind", "refused"]);
  return repo;
}

// ---------------------------------------------------------------------------
// source-of-truth anchors
//   agent roles + their models   → models.json
//   playbook step keys and order → skills/gate/playbooks/feature.md
//   agent turn budgets           → each agent file's own frontmatter
//   tests globs                  → the repo's .claude/gate.json
// Never the renderer's or the guard's own tables.
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(pluginRoot, "agents");
const SKILL_MD = path.join(pluginRoot, "skills", "gate", "SKILL.md");

function playbookKeys(playbook) {
  const md = readFileSync(path.join(pluginRoot, "skills", "gate", "playbooks", `${playbook}.md`), "utf8");
  return md.split("\n").flatMap((l) => {
    const m = /^\s*\d+\.\s.*\{([a-z0-9-]+)\}\s*$/.exec(l);
    return m ? [m[1]] : [];
  });
}

// The last printed line of a mutating verb is its `next:` hint.
const hintOf = (stdout) => lines(stdout)[lines(stdout).length - 1] ?? "";

// The step key a hint points at (same mapping tests/next-hints.test.mjs uses).
const ROLE_STEP = { skeptic: "skeptic", qa: "qa", reviewer: "review", "reviewer-2": "review" };
function hintedKey(h) {
  const flagged = /--step ([a-z0-9-]+)/.exec(h);
  if (flagged) return flagged[1];
  const step = /`gate step ([a-z0-9-]+)/.exec(h);
  if (step) return step[1];
  const role = /`gate brief ([a-z0-9-]+)/.exec(h);
  if (role) return ROLE_STEP[role[1]] ?? role[1];
  const verb = /`gate (verify|close|decide)\b/.exec(h);
  if (verb) return { verify: "verify", close: "close", decide: "driver" }[verb[1]];
  return null;
}

// `## <heading>` section text, up to the next `## ` line.
function section(md, heading) {
  const all = md.split("\n");
  const start = all.findIndex((l) => l.trim() === `## ${heading}`);
  assert.ok(start >= 0, `packet has no "## ${heading}" section:\n${md.slice(0, 2000)}`);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function packet(repo, role, args = []) {
  const r = cli(repo, "brief", [role, ...args]);
  const p = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${r.stdout}`);
  return { path: p, text: readFileSync(p, "utf8") };
}

// ---------------------------------------------------------------------------
// C1 — the fence lets the skeptic write <run dir>/skeptic-<n>.md and nothing else
// ---------------------------------------------------------------------------

test("C1 refused: with a ledger open the fence lets the skeptic write <run dir>/skeptic-1.md and denies src/a.ts, review-1.md, a skeptic file outside the run dir, every other writer, and every write when no ledger is open", () => {
  const repo = committed("skeptic-fence", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
  cli(repo, "open", ["skeptic-fence", "feature"]);
  const dir = runDir(repo); // the session's own run dir, not an invented one

  // A PreToolUse payload, exactly the shape tests/guard.test.mjs feeds `gate fence`.
  const payload = (tool, file_path, extra = {}) => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path },
    cwd: repo,
    session_id: "S1",
    ...extra,
  });

  const fence = (p, root = repo) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify(p),
      encoding: "utf8",
      env: envFor(root, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  // `gate fence` is silent on an allow and emits a deny envelope otherwise.
  const denied = (p, root = repo) => {
    const out = fence(p, root);
    if (out === "") return false;
    return JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const SKEPTIC = { agent_id: "A3", agent_type: "done-gate:skeptic" };

  // permitted: its own file, in the session's run dir
  assert.equal(fence(payload("Write", path.join(dir, "skeptic-1.md"), SKEPTIC)), "", "the skeptic's own file was not allowed");

  // refused: source, another helper's file, and a skeptic file outside the run dir
  assert.equal(denied(payload("Write", `${repo}/src/a.ts`, SKEPTIC)), true, "the skeptic was allowed to write source");
  assert.equal(denied(payload("Write", path.join(dir, "review-1.md"), SKEPTIC)), true, "the skeptic was allowed to write the reviewer's file");
  assert.equal(denied(payload("Write", `${repo}/skeptic-1.md`, SKEPTIC)), true, "a skeptic file outside the run dir was allowed");

  // refused: skeptic files are fenced from everyone else
  assert.equal(
    denied(payload("Write", path.join(dir, "skeptic-1.md"), { agent_id: "A2", agent_type: "done-gate:reviewer" })),
    true,
    "the reviewer was allowed to write a skeptic file",
  );
  assert.equal(
    denied(payload("Write", path.join(dir, "skeptic-1.md"))),
    true,
    "the main session was allowed to write a skeptic file",
  );

  // refused: no ledger means no task, so a helper may write nothing at all
  const bare = committed("skeptic-fence-noledger", { ".claude/gate.json": JSON.stringify({ tests: ["tests/**"] }) });
  const barePayload = (file_path, extra) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path },
    cwd: bare,
    session_id: "S1",
    ...extra,
  });
  assert.ok(!existsSync(path.join(bare, ".claude", "gate", "runs")), "premise: the bare repo has no run at all");
  assert.equal(
    denied(barePayload(`${bare}/.claude/gate/runs/x/skeptic-1.md`, SKEPTIC), bare),
    true,
    "with no ledger open the skeptic was still allowed to write a skeptic file",
  );
  assert.equal(
    denied(barePayload(`${bare}/.claude/gate/runs/x/review-1.md`, { agent_id: "A2", agent_type: "done-gate:reviewer" }), bare),
    true,
    "with no ledger open the reviewer was still allowed to write a review file",
  );
});

// ---------------------------------------------------------------------------
// C2 — a [measured] (skeptic-1.md) pointer resolves only when the file exists
// ---------------------------------------------------------------------------

test("C2 happy: a [measured] (skeptic-1.md) pointer resolves when the file exists and not when it is missing", () => {
  const repo = makeRepo("skeptic-pointer");
  const dir = path.join(repo, ".claude", "gate", "runs", "x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "skeptic-1.md"), "# Skeptic 1 — skeptic-pointer\n\n## Act on\n\n1. wrong premise\n");

  // The state's `reviews` array is what assess.mjs lists for the run dir.
  const reviews = reviewFiles(dir);
  assert.ok(reviews.includes("skeptic-1.md"), `assess did not list skeptic-1.md, got ${JSON.stringify(reviews)}`);
  assert.ok(!reviews.includes("skeptic-2.md"), `assess listed a file that does not exist: ${JSON.stringify(reviews)}`);

  // Built the way tests/report.test.mjs builds a rules state.
  const state = {
    config: loadConfig(repo),
    changed: [],
    now: { hash: "x", files: {} },
    verify: null,
    events: [],
    reviews,
    root: repo,
    dir,
  };
  const resolves = pointerResolver(state);
  assert.equal(resolves("skeptic-1.md"), true, "a pointer at the skeptic's file does not resolve");
  assert.equal(resolves("skeptic-2.md"), false, "a pointer at a missing skeptic file resolves anyway");
});

// ---------------------------------------------------------------------------
// C3 — the full report embeds the skeptic huddle's file
// ---------------------------------------------------------------------------

test("C3 happy: the full report embeds the skeptic huddle's file; a missing file is reported without a crash", () => {
  const repo = opened("skeptic-report");
  const body = "# Skeptic 1 — skeptic-report\n\n## Act on\n\n1. the plan hides a second write path\n";
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), body);
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);

  const md = cli(repo, "report").stdout;
  assert.ok(md.includes("<summary>skeptic-1.md</summary>"), `the report does not embed skeptic-1.md:\n${md}`);
  assert.ok(
    md.includes("the plan hides a second write path"),
    `the report embeds skeptic-1.md without its text:\n${md}`,
  );

  // Same ledger, file gone: the report still renders and names the file.
  const gone = opened("skeptic-report-missing");
  cli(gone, "huddle", ["add", "skeptic", "--file", "skeptic-9.md"]);
  const r = run(gone, "report");
  assert.equal(r.status, 0, `report crashed on a missing skeptic file:\n${r.stderr}`);
  assert.ok(!existsSync(path.join(runDir(gone), "skeptic-9.md")), "premise: the file really is absent");
  assert.ok(r.stdout.includes("skeptic-9.md"), `the huddle row does not name the missing file:\n${r.stdout}`);
  assert.ok(
    !r.stdout.includes("<summary>skeptic-9.md</summary>"),
    "a missing file was embedded as if it existed",
  );
});

// ---------------------------------------------------------------------------
// C4 — the skeptic packet names its output file and asks for the Act-on list only
// ---------------------------------------------------------------------------

test("C4 happy: the skeptic packet's You-may-write line names <run dir>/skeptic-<n>.md, one past the highest existing, and asks for the Act-on list only in the reply", () => {
  const repo = opened("skeptic-packet");
  const dir = runDir(repo);

  const first = packet(repo, "skeptic");
  const may = section(first.text, "You may write");
  assert.ok(
    may.includes(path.join(dir, "skeptic-1.md")),
    `the skeptic's "You may write" does not name ${path.join(dir, "skeptic-1.md")}:\n${may}`,
  );

  // The reply is the short part: the Act-on list only.
  const replyLine = first.text
    .split("\n")
    .find((l) => /\bact[- ]on\b/i.test(l) && /\bonly\b/i.test(l) && /\breply\b/i.test(l));
  assert.ok(replyLine, `no line tells the skeptic to reply with the Act-on list only:\n${first.text}`);

  // n is one past the highest existing skeptic file.
  writeFileSync(path.join(dir, "skeptic-1.md"), "# Skeptic 1 — skeptic-packet\n");
  const second = packet(repo, "skeptic", ["--round", "2"]);
  const may2 = section(second.text, "You may write");
  assert.ok(
    may2.includes(path.join(dir, "skeptic-2.md")),
    `with skeptic-1.md on disk the packet must name skeptic-2.md:\n${may2}`,
  );
});

// ---------------------------------------------------------------------------
// C5 — every agent carries a By-turn line two under its own maxTurns
// ---------------------------------------------------------------------------

test("C5 happy: every agent file carries a By-turn line equal to its maxTurns minus two, and skeptic.md allows Write while disallowing Edit, MultiEdit and NotebookEdit", () => {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 4, `expected the four helper agents, got ${files.join(", ")}`);

  for (const f of files) {
    const md = readFileSync(path.join(AGENTS_DIR, f), "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
    assert.ok(fm, `agents/${f} has no frontmatter`);
    const turns = /^\s*maxTurns:\s*(\d+)\s*$/m.exec(fm[1]);
    assert.ok(turns, `agents/${f} frontmatter has no maxTurns line:\n${fm[1]}`);

    const budget = Number(turns[1]) - 2;
    const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.ok(
      body.includes(`By turn ${budget}`),
      `agents/${f} has maxTurns ${turns[1]} but its body carries no "By turn ${budget}" line`,
    );
  }

  const skeptic = readFileSync(path.join(AGENTS_DIR, "skeptic.md"), "utf8");
  const disallowed = /^\s*disallowedTools:.*$/m.exec(skeptic);
  assert.ok(disallowed, "agents/skeptic.md has no disallowedTools line");
  for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
    assert.ok(disallowed[0].includes(tool), `agents/skeptic.md no longer disallows ${tool}: ${disallowed[0]}`);
  }
  assert.ok(
    !/\bWrite\b/.test(disallowed[0]),
    `agents/skeptic.md still disallows Write, so it cannot write its file: ${disallowed[0]}`,
  );
});

// ---------------------------------------------------------------------------
// C6 — the hints name the skeptic file, the waiver cost, and who owns the diff
// ---------------------------------------------------------------------------

test("C6 happy: the skeptic hint names `gate huddle add skeptic --file skeptic-<n>.md`; the driver and schema hints warn against waiving to save time; the review hint says you own the diff", () => {
  const keys = playbookKeys("feature");
  for (const k of ["skeptic", "driver", "schema", "review"]) {
    assert.ok(keys.includes(k), `premise: the feature playbook has a {${k}} step (got ${keys.join(", ")})`);
  }

  const repo = committed("skeptic-hints");
  cli(repo, "open", ["skeptic-hints", "feature"]);
  cli(repo, "note", ["task", "Pin the hints. [inferred]"]);
  const afterPlan = hintOf(cli(repo, "note", ["plan", "Two modules.", "--files", "src/a.ts,src/app/page.tsx"]).stdout);
  assert.match(afterPlan, /^next: /, afterPlan);

  // Walk the playbook, collecting each hint by the step it points at.
  const hints = {};
  const record = (stdout) => {
    const h = hintOf(stdout);
    const k = hintedKey(h);
    if (k && !(k in hints)) hints[k] = h;
  };
  record(cli(repo, "step", ["read", "done", "read both modules", "--evidence", "events#1"]).stdout);
  record(cli(repo, "case", ["add", "the skeptic writes its file", "--kind", "happy"]).stdout);
  for (const key of keys) {
    if (["read", "plan", "cases"].includes(key)) continue;
    if (key === "review") break;
    record(cli(repo, "step", [key, "done", `${key} done`, "--evidence", "events#1"]).stdout);
  }

  assert.ok(hints.skeptic, `no hint ever pointed at {skeptic}: ${JSON.stringify(hints, null, 2)}`);
  assert.match(
    hints.skeptic,
    /gate huddle add skeptic --file skeptic-<n>\.md/,
    `the skeptic hint does not name the file-carrying huddle command:\n${hints.skeptic}`,
  );

  for (const key of ["driver", "schema"]) {
    assert.ok(hints[key], `no hint ever pointed at {${key}}: ${JSON.stringify(hints, null, 2)}`);
    assert.match(hints[key], /waiver/i, `the ${key} hint does not mention a waiver:\n${hints[key]}`);
    assert.match(hints[key], /save time/i, `the ${key} hint does not say "save time":\n${hints[key]}`);
  }

  assert.ok(hints.review, `no hint ever pointed at {review}: ${JSON.stringify(hints, null, 2)}`);
  assert.match(hints.review, /own the diff/i, `the review hint does not say you own the diff:\n${hints.review}`);
});

// ---------------------------------------------------------------------------
// C7 — SKILL.md mentions the skeptic file and stays under 4 KB
// ---------------------------------------------------------------------------

test("C7 boundary: SKILL.md stays under 4096 bytes after mentioning the skeptic file", () => {
  const size = statSync(SKILL_MD).size;
  assert.ok(size < 4096, `skills/gate/SKILL.md is ${size} bytes, the budget is 4096`);
  const md = readFileSync(SKILL_MD, "utf8");
  assert.ok(md.includes("skeptic-<n>.md"), "skills/gate/SKILL.md never names skeptic-<n>.md");
});

// ---------------------------------------------------------------------------
// C8 — the brief's Design check line counts the skeptic huddle's Act-on items
// ---------------------------------------------------------------------------

test("C8 boundary: the brief's Design check line counts the skeptic huddle's Act-on items, n still open then all addressed", () => {
  const repo = opened("skeptic-brief");
  writeFileSync(path.join(runDir(repo), "skeptic-1.md"), "# Skeptic 1 — skeptic-brief\n\n## Act on\n\n1. a\n2. b\n");
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  cli(repo, "huddle", ["acton", "H1", "the plan hides a second write path"]);
  cli(repo, "huddle", ["acton", "H1", "the refused side has no case"]);
  // `huddle resolve` requires a pointer that actually resolves, so this names a real file
  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "tests/a.test.ts:a"]);

  const open = cli(repo, "report", ["--brief"]).stdout;
  assert.ok(
    open.includes("Design check: 2 concerns, 1 still open."),
    `expected "Design check: 2 concerns, 1 still open." in:\n${open}`,
  );

  cli(repo, "huddle", ["resolve", "H1.2", "--evidence", "tests/a.test.ts:a"]);
  const closed = cli(repo, "report", ["--brief"]).stdout;
  assert.ok(
    closed.includes("Design check: 2 concerns, all addressed."),
    `expected "Design check: 2 concerns, all addressed." in:\n${closed}`,
  );
});

// ---------------------------------------------------------------------------
// C9 — a helper's file belongs to the session's own run dir, not to any run dir
// ---------------------------------------------------------------------------

test("C9 refused: with a ledger open, the skeptic and the reviewer may write their file only in the session's own run dir", () => {
  const repo = opened("skeptic-other-run");
  const mine = runDir(repo);
  const other = path.join(stateDir(repo), "runs", "2020-01-01-other-run");
  mkdirSync(other, { recursive: true });
  assert.notEqual(mine, other, "premise: the two run dirs differ");

  const fence = (file_path, extra) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const denied = (file_path, extra) => {
    const out = fence(file_path, extra);
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const SKEPTIC = { agent_id: "A3", agent_type: "done-gate:skeptic" };
  const REVIEWER = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  assert.equal(fence(path.join(mine, "skeptic-1.md"), SKEPTIC), "", "the skeptic's file in its own run dir was denied");
  assert.equal(
    denied(path.join(other, "skeptic-1.md"), SKEPTIC),
    true,
    "the skeptic was allowed to write into another task's run dir",
  );

  assert.equal(fence(path.join(mine, "review-1.md"), REVIEWER), "", "the reviewer's file in its own run dir was denied");
  assert.equal(
    denied(path.join(other, "review-1.md"), REVIEWER),
    true,
    "the reviewer was allowed to write into another task's run dir",
  );
});

// ---------------------------------------------------------------------------
// C10 — round 2 packets name the next file for both helpers that write one
// ---------------------------------------------------------------------------

test("C10 edge: with review-1.md and skeptic-1.md on disk, the round-2 packets name review-2.md and skeptic-2.md", () => {
  const repo = opened("skeptic-round2");
  const dir = runDir(repo);
  writeFileSync(path.join(dir, "review-1.md"), "# Review 1\n\n## Act on\n\n_none_\n");
  writeFileSync(path.join(dir, "skeptic-1.md"), "# Skeptic 1 — skeptic-round2\n\n## Act on\n\n_none_\n");

  for (const [role, want] of [["reviewer", "review-2.md"], ["skeptic", "skeptic-2.md"]]) {
    const { text } = packet(repo, role, ["--round", "2"]);
    const may = section(text, "You may write");
    assert.ok(
      may.includes(path.join(dir, want)),
      `the round-2 ${role} packet does not name ${path.join(dir, want)}:\n${may}`,
    );
  }
});

// ---------------------------------------------------------------------------
// C11 — a helper cannot route a write through Bash
// ---------------------------------------------------------------------------

test("C11 refused: a helper's Bash command that writes, deletes or commits source is denied; read-only commands pass, and the main session is untouched", () => {
  const repo = opened("skeptic-bash");

  const fence = (command, extra = {}) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const SKEPTIC = { agent_id: "A3", agent_type: "done-gate:skeptic" };
  const QA = { agent_id: "A1", agent_type: "done-gate:qa" };

  // A write is a write however it is spelled: redirect, tee, in-place sed, rm, commit.
  const writes = [
    "echo x > src/a.ts",
    "cat f | tee src/a.ts",
    "sed -i s/a/b/ src/a.ts",
    "rm src/a.ts",
    "git add -A && git commit -m x",
  ];
  for (const cmd of writes) {
    assert.equal(fence(cmd, SKEPTIC), true, `the skeptic was allowed to run: ${cmd}`);
  }
  // the same rule for the other helper that is fenced to its own globs
  assert.equal(fence("echo x > src/a.ts", QA), true, "QA was allowed to write source through Bash");

  // Reading, searching, diffing and running the tests are the helpers' job.
  const reads = [
    "git diff HEAD",
    "grep -rn foo src",
    "node --test tests/x.test.mjs",
    "ls -la",
    "cat src/a.ts 2>&1 | head",
  ];
  for (const cmd of reads) {
    assert.equal(fence(cmd, SKEPTIC), false, `the skeptic was denied a read-only command: ${cmd}`);
  }

  // The main session owns the diff, so none of this applies to it.
  for (const cmd of writes) {
    assert.equal(fence(cmd), false, `the main session was denied its own command: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// C12 — the Bash rule reads the command, not the characters in it
// ---------------------------------------------------------------------------

test("C12 boundary: a helper may shell-write under scratch paths and quote write words harmlessly, but never write source or run a git write command", () => {
  const repo = opened("skeptic-bash-scratch");

  const fence = (command, extra = {}) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const RV = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  const allowed = [
    // a stream discard is not a write
    "sed -n 1,5p x.mjs 2>/dev/null | grep -n foo",
    // write words inside a quoted string are text, not commands
    'git log --grep="fix: rm -rf bug"',
    'grep -n "sed -i" scripts/lib/guard.mjs',
    "node --test tests/x.test.mjs 2>&1 | tail -3",
    // scratch paths are the helper's own workspace
    "echo hi > /tmp/o.txt",
    "rm -rf tests/.tmp/h && git archive HEAD | tar -x -C tests/.tmp/h",
    "cp tests/x.test.mjs tests/.tmp/h/tests/",
  ];
  for (const cmd of allowed) {
    assert.equal(fence(cmd, RV), false, `the reviewer was denied a harmless command: ${cmd}`);
  }

  const denied = [
    "cp tests/.tmp/a src/b.ts", // a scratch source does not make the destination scratch
    "echo x > src/a.ts",
    "git commit -m x",
  ];
  for (const cmd of denied) {
    assert.equal(fence(cmd, RV), true, `the reviewer was allowed to write outside scratch: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// C13 — moving source away, and writing through an interpreter, are still writes
// ---------------------------------------------------------------------------

test("C13 refused: a helper cannot move source into scratch or write it through node or python, but may move and run scratch files", () => {
  const repo = opened("skeptic-bash-interp");

  const fence = (command, extra = {}) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const RV = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  const denied = [
    // a scratch destination does not excuse deleting the source file
    "mv src/a.ts /private/tmp/gone.ts",
    // an interpreter is a shell by another name
    `node -e "require('fs').writeFileSync('src/a.ts',1)"`,
    `python3 -c "open('src/a.ts','w')"`,
  ];
  for (const cmd of denied) {
    assert.equal(fence(cmd, RV), true, `the reviewer was allowed to write source: ${cmd}`);
  }

  const allowed = [
    "mv tests/.tmp/a tests/.tmp/b", // scratch to scratch
    "node tests/.tmp/x.mjs", // running a scratch script is not writing source
    "node --test tests/x.test.mjs",
  ];
  for (const cmd of allowed) {
    assert.equal(fence(cmd, RV), false, `the reviewer was denied a harmless command: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// C14 — `-r` belongs to its own command, not to every command
// ---------------------------------------------------------------------------

test("C14 refused: php -r that writes source is denied, while -r on grep, ls and node's preload flag stays allowed", () => {
  const repo = opened("skeptic-bash-dashr");

  const fence = (command, extra = {}) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
        session_id: "S1",
        ...extra,
      }),
      encoding: "utf8",
      env: envFor(repo, "S1"),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    return out === "" ? false : JSON.parse(out).hookSpecificOutput.permissionDecision === "deny";
  };

  const RV = { agent_id: "A2", agent_type: "done-gate:reviewer" };

  // php -r runs code, the same hole as node -e and python3 -c
  assert.equal(
    fence(`php -r 'file_put_contents("src/a.ts","x");'`, RV),
    true,
    "the reviewer was allowed to write source through php -r",
  );

  // -r means recursive to grep, reverse to ls, and preload to node: none of them run code that writes
  const allowed = [
    "grep -r foo src",
    "ls -r",
    "node -r ./tests/.tmp/pre.js tests/.tmp/a.mjs",
  ];
  for (const cmd of allowed) {
    assert.equal(fence(cmd, RV), false, `the reviewer was denied a harmless -r command: ${cmd}`);
  }
});
