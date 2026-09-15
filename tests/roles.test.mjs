// T5 — the worker role. Written from the task's case table, blind to the implementation of
// models.json, scripts/lib/size.mjs and scripts/lib/verbs.mjs.
//
// Anchors, never the implementation's own constants:
//   the six roles and the ceiling → the requirement text of task T5
//   role → model                  → models.json "roles" (the file the plugin ships)
//   agent files                   → agents/<role>.md on disk
//   required helpers per tier     → models.json policy.tiers[<tier>].requires
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { DEFAULT_POLICY } from "../scripts/lib/size.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/report-tier.test.mjs and tests/helper-packets.test.mjs)
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

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// hook payloads, fed to `gate log` exactly as tests/report-tier.test.mjs feeds them
function hook(repo, payload, session = "S1") {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: session, cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

const subagentStop = (repo, agentType, extra = {}) =>
  hook(repo, { hook_event_name: "SubagentStop", agent_id: "A9", agent_type: agentType, stop_hook_active: false, ...extra });

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
// Every mutating verb ends with a `next:` hint (tests/next-hints.test.mjs owns that line).
const withoutHint = (s) => lines(s).filter((l) => !l.startsWith("next:"));
const lineStarting = (text, prefix) => lines(text).find((l) => l.startsWith(prefix));

// ---------------------------------------------------------------------------
// source-of-truth anchors
// ---------------------------------------------------------------------------

const MODELS = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
const AGENTS_DIR = path.join(pluginRoot, "agents");

// the six roles T5 asks for, spelled out rather than read back from the file under test
const EXPECTED_ROLES = {
  skeptic: "sonnet",
  qa: "opus",
  reviewer: "sonnet",
  "reviewer-2": "opus",
  arbiter: "opus",
  worker: "sonnet",
};
const EXPECTED_CEILING = 10;
const WORKER_MAX_TURNS = 60;

// roles that must never touch code: they read and write their own findings file only.
// qa is deliberately absent — it writes tests, so agents/qa.md carries no disallowedTools.
const EDIT_BANNED = ["skeptic", "reviewer", "reviewer-2", "arbiter"];

const frontmatter = (md) => /^---\n([\s\S]*?)\n---\n/.exec(md);
const agentFile = (role) => readFileSync(path.join(AGENTS_DIR, `${role}.md`), "utf8");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function openTiered(repo, { slug = "roles", playbook = "feature", files = null } = {}) {
  cli(repo, "open", [slug, playbook]);
  cli(repo, "note", ["task", "Add the worker role. [inferred]"]);
  cli(repo, "note", ["plan", "One module and the policy file.", ...(files ? ["--files", files] : [])]);
  cli(repo, "case", ["add", "the worker is a role", "--kind", "happy"]);
}

// predicted small (one file named in the plan), measured standard (three source files, one
// .tsx, which forces the ui category) → the standard tier, whose requires list has three roles.
function standardTier(name) {
  const repo = committed(name);
  openTiered(repo, { slug: name, files: "src/a.ts" });
  write(repo, "src/a.ts", "export const a = 2;\nexport const b = 3;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/app/page.tsx", "export default () => null; // changed\n");
  return repo;
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 happy: models.json and DEFAULT_POLICY both name worker: sonnet and a ceiling of 10 helpers/task, and `gate size` prints that ceiling", () => {
  assert.deepEqual(MODELS.roles, EXPECTED_ROLES, "models.json roles is not the six-role map T5 asks for");
  assert.equal(MODELS.policy.ceiling.helpersPerTask, EXPECTED_CEILING, "models.json ceiling.helpersPerTask");

  // the fallback used when models.json cannot be read must say the same thing
  assert.deepEqual(DEFAULT_POLICY.roles, EXPECTED_ROLES, "size.mjs DEFAULT_POLICY.roles drifted from models.json");
  assert.equal(
    DEFAULT_POLICY.ceiling.helpersPerTask,
    EXPECTED_CEILING,
    "size.mjs DEFAULT_POLICY.ceiling.helpersPerTask drifted from models.json",
  );

  const repo = standardTier("roles-c1");
  const requires = lineStarting(cli(repo, "size").stdout, "requires:");
  assert.ok(requires, `no requires line in \`gate size\`:\n${cli(repo, "size").stdout}`);
  assert.ok(
    requires.endsWith(`ceiling ${EXPECTED_CEILING} helpers/task`),
    `\`gate size\` still prints the old ceiling: ${requires}`,
  );
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 happy: `gate brief worker` writes brief-worker-1.md, every other role still briefs, and `gate huddle add worker --file worker-1.md` is recorded", () => {
  const repo = standardTier("roles-c2");

  // arbiter is left out: it needs --item <H#.#>, a disputed finding, and tests/review-dispute owns it
  for (const role of Object.keys(EXPECTED_ROLES).filter((r) => r !== "arbiter")) {
    const out = withoutHint(cli(repo, "brief", [role]).stdout);
    const abs = path.join(runDir(repo), `brief-${role}-1.md`);
    assert.ok(existsSync(abs), `${role}: ${abs} was not written`);
    assert.equal(out[0], `packet: ${abs}`, `${role}: ${out.join(" | ")}`);
    assert.ok(out[1].startsWith(`prompt: Read ${abs} and follow your role brief.`), `${role}: ${out[1]}`);
    assert.ok(readFileSync(abs, "utf8").trim().length > 0, `${role}: the packet is empty`);
  }

  // the worker's evidence is its own worker-<n>.md
  const ok = run(repo, "huddle", ["add", "worker", "--file", "worker-1.md"]);
  assert.equal(ok.stderr, "", `\`gate huddle add worker --file worker-1.md\` was refused:\n${ok.stderr}`);
  assert.match(withoutHint(ok.stdout)[0] ?? "", /^H\d+ added \(worker\)/, ok.stdout);
  const huddle = ledgerOf(repo).huddles.find((h) => h.role === "worker");
  assert.ok(huddle, "no worker huddle was recorded in the ledger");
  assert.equal(huddle.file, "worker-1.md");

  // refused side: another role's file, and no file at all
  const wrongFile = run(repo, "huddle", ["add", "worker", "--file", "review-1.md"]);
  assert.match(
    wrongFile.stderr,
    /worker-/,
    `a worker huddle must insist on its own worker-<n>.md, not a reviewer's file:\n${wrongFile.stdout}${wrongFile.stderr}`,
  );
  assert.equal(
    ledgerOf(repo).huddles.filter((h) => h.role === "worker").length,
    1,
    "a refused `huddle add worker` still wrote a huddle",
  );

  const noFile = run(repo, "huddle", ["add", "worker"]);
  assert.match(noFile.stderr, /needs --file/, `worker's file is its evidence, so it is required:\n${noFile.stderr}`);
  assert.match(noFile.stderr, /worker-/, `the message must name worker-<n>.md:\n${noFile.stderr}`);
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 refused: `gate brief bogus` fails with a usage message listing every role, worker included, and writes no packet", () => {
  const repo = standardTier("roles-c3");
  const before = readdirSync(runDir(repo));

  const bad = run(repo, "brief", ["bogus"]);
  assert.equal(bad.status, 0, "the dispatcher must fail open");
  assert.match(bad.stderr, /usage/i, `stderr carries no usage message:\n${bad.stderr}`);
  for (const role of Object.keys(EXPECTED_ROLES)) {
    assert.ok(bad.stderr.includes(role), `the usage message does not list ${role}:\n${bad.stderr}`);
  }
  assert.deepEqual(
    readdirSync(runDir(repo)).filter((f) => f.startsWith("brief-")),
    before.filter((f) => f.startsWith("brief-")),
    "a packet was written for an unknown role",
  );

  // the same refusal from `gate huddle add`
  const huddle = run(repo, "huddle", ["add", "bogus", "--file", "review-1.md"]);
  assert.match(huddle.stderr, /usage/i, `huddle add accepted an unknown role:\n${huddle.stderr}`);
  assert.ok(huddle.stderr.includes("worker"), `the huddle usage message does not list worker:\n${huddle.stderr}`);
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

test("C4 edge: every role in models.json has an agents/<role>.md whose model matches, worker runs 60 turns with no Edit ban, and the reading roles still ban Edit", () => {
  for (const [role, model] of Object.entries(MODELS.roles)) {
    const file = path.join(AGENTS_DIR, `${role}.md`);
    assert.ok(existsSync(file), `models.json names ${role} but agents/${role}.md does not exist`);
    const md = readFileSync(file, "utf8");
    const fm = frontmatter(md);
    assert.ok(fm, `agents/${role}.md has no frontmatter`);
    const declared = /^\s*model:\s*(\S+)\s*$/m.exec(fm[1]);
    assert.ok(declared, `agents/${role}.md frontmatter has no model line:\n${fm[1]}`);
    assert.equal(declared[1], model, `agents/${role}.md runs on ${declared[1]}, models.json says ${model}`);
    assert.match(fm[1], /^\s*name:\s*/m, `agents/${role}.md frontmatter has no name line`);
  }

  // the worker edits code, so nothing may be taken away from it
  const worker = agentFile("worker");
  const wfm = frontmatter(worker)[1];
  const turns = /^\s*maxTurns:\s*(\d+)\s*$/m.exec(wfm);
  assert.ok(turns, `agents/worker.md has no maxTurns line:\n${wfm}`);
  assert.equal(Number(turns[1]), WORKER_MAX_TURNS, "agents/worker.md maxTurns");
  assert.ok(
    worker.replace(/^---\n[\s\S]*?\n---\n/, "").includes(`By turn ${WORKER_MAX_TURNS - 2}`),
    `agents/worker.md has maxTurns ${WORKER_MAX_TURNS} but no "By turn ${WORKER_MAX_TURNS - 2}" line`,
  );
  assert.ok(
    !/^\s*disallowedTools:/m.test(wfm),
    `agents/worker.md must not disallow any tool — it writes the code:\n${wfm}`,
  );

  // and nothing was taken away from the roles that only read
  for (const role of EDIT_BANNED) {
    const banned = /^\s*disallowedTools:.*$/m.exec(frontmatter(agentFile(role))[1]);
    assert.ok(banned, `agents/${role}.md lost its disallowedTools line`);
    for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
      assert.ok(banned[0].includes(tool), `agents/${role}.md no longer disallows ${tool}: ${banned[0]}`);
    }
  }
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 happy: agents/reviewer.md and reviewer-2.md send the reviewer to the test command, bugs, tests, security and performance, keep the Act on / Disputes shape, and say to write the file early", () => {
  const bodyOf = (role) => agentFile(role).replace(/^---\n[\s\S]*?\n---\n/, "");

  // what both reviewer files must carry
  for (const role of ["reviewer", "reviewer-2"]) {
    const body = bodyOf(role);
    assert.match(body, /test command/i, `agents/${role}.md never tells the reviewer to run the test command`);
    assert.match(body, /\bbugs?\b/i, `agents/${role}.md never asks for bugs`);
    assert.match(body, /\btests?\b/i, `agents/${role}.md never asks the reviewer to judge the tests`);
    assert.ok(body.includes("review-<n>.md"), `agents/${role}.md never names the file it writes`);

    // the sections the implementer's parsers read (scripts/lib/rules.mjs parseFindings/parseDisputes)
    for (const section of ["Act on", "Consider", "Noted", "Dismissed"]) {
      assert.ok(body.includes(section), `agents/${role}.md dropped the "${section}" section from the file shape`);
    }
    assert.ok(body.includes("## Disputes"), `agents/${role}.md dropped the "## Disputes" instruction`);

    // write early, refine later — a reviewer that runs out of turns must still leave a file behind
    assert.match(
      body,
      /write the file first|first tool call is Write|draft|first \d+ turns|file early/i,
      `agents/${role}.md never tells the reviewer to write the file early`,
    );
  }

  // the axes the first reviewer works through, in its own ordered list
  const reviewer = bodyOf("reviewer");
  for (const axis of [/edge case/i, /weak test/i, /security/i, /performance/i]) {
    assert.match(reviewer, axis, `agents/reviewer.md never asks about ${axis.source}`);
  }
  assert.ok(reviewer.includes("## Act on"), 'agents/reviewer.md no longer shows the "## Act on" heading in its file shape');
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 boundary: a worker stop is not a helper — the Tier block's helper count stays 0 until a required role stops", () => {
  const repo = standardTier("roles-c6");
  const required = MODELS.policy.tiers.standard.requires;
  assert.deepEqual(required, ["skeptic", "qa", "reviewer"], "anchor: models.json policy.tiers.standard.requires");

  const none = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.ok(none, "no helpers line in the Tier block");
  assert.equal(none, `helpers: spawned 0 of ${required.length} required (${required.join(", ")})`);

  subagentStop(repo, "done-gate:worker");
  subagentStop(repo, "worker"); // the bare type must not count either

  const afterWorker = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.equal(
    afterWorker,
    `helpers: spawned 0 of ${required.length} required (${required.join(", ")})`,
    "a worker stop was counted as a required helper",
  );

  // the counter still works: a real helper moves it
  subagentStop(repo, "done-gate:qa");
  const afterQa = lineStarting(cli(repo, "report").stdout, "helpers:");
  assert.match(afterQa, /^helpers: spawned 1 of /, afterQa);
  assert.ok(afterQa.includes("qa ✓"), afterQa);
});
