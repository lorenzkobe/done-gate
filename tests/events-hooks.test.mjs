// T6 — the lead-delegation fence. When a ledger is open on a tiered playbook and the
// plan predicted standard or large, the main session (no agent_type) may not edit source
// or tests; it is told to brief and spawn a worker. The worker may. Everything else —
// small tasks, an un-tiered playbook, no --files, no open ledger, the other helper roles —
// is unchanged.
//
// The fence is driven the way production drives it: a PreToolUse payload on stdin to
// `gate fence`, so which run dir and which ledger are "the open task's" is resolved by the
// session, not by this test. Ledgers are built with the real CLI and read back from
// ledger.json (tests/tier-policy.test.mjs's ledgerOf()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { readEvents } from "../scripts/lib/events.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/guard.test.mjs and tests/tier-policy.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function cli(repo, verb, args = [], session = "S1") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], {
    input: "",
    encoding: "utf8",
    env: envFor(repo, session),
  });
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  return r;
}

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD: `gate open` snapshots the tree against HEAD.
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));

// A PreToolUse payload, exactly as tests/guard.test.mjs builds one.
const pre = (repo, tool, file_path, extra = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: { file_path },
  cwd: repo,
  session_id: "S1",
  ...extra,
});

// `gate fence` on stdin: null when the call is allowed (the hook stays silent),
// otherwise the deny reason the model is shown.
function fence(repo, payload) {
  const r = spawnSync(process.execPath, [gate, "fence"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  if (out === "") return null;
  const hook = JSON.parse(out).hookSpecificOutput;
  assert.equal(hook.permissionDecision, "deny", out);
  return hook.permissionDecisionReason;
}

// A ledger open on `playbook` whose plan named `files`, so tier.predicted is whatever the
// CLI derives from them. Returns the repo.
function openedWith(name, { playbook = "feature", files = null, extra = {} } = {}) {
  const repo = committed(name, extra);
  cli(repo, "open", [name, playbook]);
  cli(repo, "note", ["task", "Do the thing. [inferred]"]);
  cli(repo, "note", ["plan", "The plan.", ...(files ? ["--files", files.join(",")] : [])]);
  return repo;
}

const stdinFixture = (name) =>
  JSON.parse(readFileSync(path.join(here, "fixtures", "stdin", `${name}.json`), "utf8"));

// ---------------------------------------------------------------------------
// C1 — the lead is fenced off source once the plan predicts standard or large
// ---------------------------------------------------------------------------

test("C1 refused: at predicted standard the lead's Edit/Write/MultiEdit/NotebookEdit on source is denied, and the reason names the size and `gate brief worker`", () => {
  const repo = openedWith("fence-c1", { files: ["src/a.ts", "src/b.ts"] });
  // the size the fence must name comes from the ledger the CLI wrote, not from the guard
  assert.equal(ledgerOf(repo).tier.predicted, "standard");

  const reason = fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts")));
  assert.ok(reason, "a lead Edit on source at standard must be denied");
  assert.match(reason, /standard/, reason);
  assert.match(reason, /gate brief worker/, reason);
  assert.match(reason, /done-gate:worker/, reason);
  assert.match(reason, /src\/a\.ts/, reason);

  // every editing tool, not just Edit
  assert.ok(fence(repo, pre(repo, "Write", path.join(repo, "src/b.ts"))), "Write");
  assert.ok(
    fence(repo, {
      ...pre(repo, "MultiEdit", undefined),
      tool_input: { edits: [{ file_path: path.join(repo, "src/a.ts") }, { file_path: path.join(repo, "src/b.ts") }] },
    }),
    "MultiEdit",
  );
  assert.ok(
    fence(repo, { ...pre(repo, "NotebookEdit", undefined), tool_input: { notebook_path: path.join(repo, "src/nb.ipynb") } }),
    "NotebookEdit",
  );
});

test("C1 refused: a plan naming 11 files predicts large and the reason names that size", () => {
  const files = Array.from({ length: 11 }, (_, i) => `src/f${i + 1}.ts`);
  const repo = openedWith("fence-c1-large", {
    files,
    extra: Object.fromEntries(files.map((f) => [f, "export const x = 1;\n"])),
  });
  assert.equal(ledgerOf(repo).tier.predicted, "large");

  const reason = fence(repo, pre(repo, "Edit", path.join(repo, "src/f1.ts")));
  assert.ok(reason, "a lead Edit on source at large must be denied");
  assert.match(reason, /large/, reason);
  assert.match(reason, /gate brief worker/, reason);
});

// ---------------------------------------------------------------------------
// C2 — everything the fence must leave alone
// ---------------------------------------------------------------------------

test("C2 happy: the lead still edits source when the prediction is small, when the plan named no files, when no ledger is open, and on the un-tiered plan playbook", () => {
  const small = openedWith("fence-c2-small", { files: ["src/a.ts"] });
  assert.equal(ledgerOf(small).tier.predicted, "small");
  assert.equal(fence(small, pre(small, "Edit", path.join(small, "src/a.ts"))), null, "tier small");

  const noFiles = openedWith("fence-c2-nofiles");
  assert.equal(ledgerOf(noFiles).tier.predicted, null, "no --files means no prediction");
  assert.equal(fence(noFiles, pre(noFiles, "Edit", path.join(noFiles, "src/a.ts"))), null, "no prediction");

  // no ledger at all: `gate open` was never run here
  const none = committed("fence-c2-none");
  assert.equal(fence(none, pre(none, "Edit", path.join(none, "src/a.ts"))), null, "no open ledger");

  // scripts/lib/ledger.mjs gives a tier only to feature/bugfix/refactor; plan gets null
  const planned = openedWith("fence-c2-plan", { playbook: "plan", files: ["src/a.ts", "src/b.ts"] });
  assert.equal(ledgerOf(planned).tier, null, "the plan playbook is never tiered");
  assert.equal(fence(planned, pre(planned, "Edit", path.join(planned, "src/a.ts"))), null, "plan playbook");
});

test("C2 happy: bugfix and refactor are tiered too, so the lead is fenced there as well", () => {
  for (const playbook of ["bugfix", "refactor"]) {
    const repo = openedWith(`fence-c2-${playbook}`, { playbook, files: ["src/a.ts", "src/b.ts"] });
    assert.equal(ledgerOf(repo).tier.predicted, "standard", playbook);
    assert.ok(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))), playbook);
  }
});

// ---------------------------------------------------------------------------
// C3 — the boundary is config.isSource(), which covers tests and skips docs
// ---------------------------------------------------------------------------

test("C3 edge: a test file is denied to the lead like source; docs/notes.md and the run dir's ledger.md stay writable", () => {
  const repo = openedWith("fence-c3", { files: ["src/a.ts", "src/b.ts"] });
  assert.equal(ledgerOf(repo).tier.predicted, "standard");

  // the boundary, read from the config that owns it (source **, minus docs/** and **/*.md)
  const cfg = loadConfig(repo);
  assert.equal(cfg.isSource("tests/a.test.ts"), true);
  assert.equal(cfg.isSource("docs/notes.md"), false);
  assert.equal(cfg.isSource(".claude/gate/runs/x/ledger.md"), false);

  const denied = fence(repo, pre(repo, "Edit", path.join(repo, "tests/a.test.ts")));
  assert.ok(denied, "tests are source for this fence");
  assert.match(denied, /tests\/a\.test\.ts/, denied);
  assert.match(denied, /gate brief worker/, denied);

  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "docs/notes.md"))), null, "docs");
  assert.equal(fence(repo, pre(repo, "Write", path.join(runDir(repo), "ledger.md"))), null, "ledger.md");
});

// ---------------------------------------------------------------------------
// C4 — the worker is the role the deny points at
// ---------------------------------------------------------------------------

test("C4 happy: a done-gate:worker edits source and tests at standard, but not another role's review-1.md", () => {
  const repo = openedWith("fence-c4", { files: ["src/a.ts", "src/b.ts"] });
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  const worker = { agent_id: "A7", agent_type: "done-gate:worker" };

  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"), worker)), null, "source");
  assert.equal(fence(repo, pre(repo, "Write", path.join(repo, "tests/a.test.ts"), worker)), null, "tests");
  assert.ok(fence(repo, pre(repo, "Write", path.join(runDir(repo), "review-1.md"), worker)), "review-1.md");
});

// ---------------------------------------------------------------------------
// C5 — the other helper roles are untouched by the new branch
// ---------------------------------------------------------------------------

test("C5 boundary: done-gate:qa is still refused source and still allowed tests at predicted standard", () => {
  const repo = openedWith("fence-c5", { files: ["src/a.ts", "src/b.ts"] });
  assert.equal(ledgerOf(repo).tier.predicted, "standard");
  const qa = { agent_id: "A1", agent_type: "done-gate:qa" };

  const denied = fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"), qa));
  assert.ok(denied, "QA never edits source");
  assert.doesNotMatch(denied, /gate brief worker/, "QA is refused as QA, not told to brief a worker");
  assert.equal(fence(repo, pre(repo, "Write", path.join(repo, "tests/a.test.ts"), qa)), null, "tests");
});

// ---------------------------------------------------------------------------
// C6 — the deny is evidence: an event, and a count in the report
// ---------------------------------------------------------------------------

test("C6 edge: a fenced lead edit is logged as a deny event and the report counts it", () => {
  const repo = openedWith("fence-c6", { files: ["src/a.ts", "src/b.ts"] });
  assert.deepEqual(readEvents(stateDir(repo), "S1").filter((e) => e.kind === "deny"), [], "nothing denied yet");

  assert.ok(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))));

  const denies = readEvents(stateDir(repo), "S1").filter((e) => e.kind === "deny");
  assert.equal(denies.length, 1);
  assert.equal(denies[0].session, "S1");
  assert.equal(denies[0].agentType ?? null, null, "the lead has no agent type");
  // a delegation deny is a hand-off, not tampering: the report says so and keeps the tampering count at 0
  assert.match(cli(repo, "report").stdout, /tampering attempts 0/);
  assert.match(cli(repo, "report").stdout, /1 lead edit\(s\) fenced off/);
});

// ---------------------------------------------------------------------------
// C8 — a measured size can fence the lead even when the plan predicted small
// ---------------------------------------------------------------------------

test("C8 boundary: a plan that predicted small but has already grown to a measured standard fences the lead's next source edit", () => {
  const repo = openedWith("fence-c8", { files: ["src/a.ts"] });
  assert.equal(ledgerOf(repo).tier.predicted, "small", "the plan named one file");
  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))), null, "small and unmeasured: allowed");

  // the task grows; `gate check` is what writes the measured tier into the ledger
  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "src/b.ts", "export const b = 1;\n");
  write(repo, "src/c.ts", "export const c = 1;\n");
  cli(repo, "check");
  assert.equal(ledgerOf(repo).tier.measured.tier, "standard");

  const reason = fence(repo, pre(repo, "Edit", path.join(repo, "src/d.ts")));
  assert.ok(reason, "the measured size fences the lead too");
  assert.match(reason, /standard/, reason);
  assert.match(reason, /gate brief worker/, reason);
  assert.match(reason, /done-gate:worker/, reason);
});

test("C8 boundary: with no prediction and nothing measured yet the lead may still edit", () => {
  const repo = openedWith("fence-c8-unmeasured"); // no --files
  assert.equal(ledgerOf(repo).tier.predicted, null);
  cli(repo, "check"); // nothing has changed, so there is no standard measurement to fence on
  assert.notEqual(ledgerOf(repo).tier.measured?.tier ?? null, "standard");
  assert.equal(fence(repo, pre(repo, "Edit", path.join(repo, "src/a.ts"))), null);
});

// ---------------------------------------------------------------------------
// C7 — the ordinary pass-through is unchanged
// ---------------------------------------------------------------------------

test("C7 idempotent: the tests/fixtures/stdin edit payloads still pass the fence silently when no ledger is open", () => {
  const repo = committed("fence-c7");
  // the fixtures address /repo; point them at this one, and ask the fence rather than the log
  const asPreToolUse = (name) =>
    JSON.parse(JSON.stringify(stdinFixture(name)).split("/repo").join(repo).split('"PostToolUse"').join('"PreToolUse"'));

  for (const name of ["edit", "write", "multiedit", "sub-edit"]) {
    const payload = asPreToolUse(name);
    assert.equal(payload.hook_event_name, "PreToolUse", name);
    assert.equal(fence(repo, payload), null, name);
  }

  // and a Bash payload that names no evidence file is still none of the fence's business
  assert.equal(fence(repo, asPreToolUse("bash")), null, "bash");
});
