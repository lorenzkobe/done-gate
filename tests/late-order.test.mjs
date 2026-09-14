// C11 — R2 matches its own message. An edit logged before `gate open` means the Plan and
// the case table are written after the first code change; R2 blocks only while one of them
// is missing altogether, and once both exist the late order is recorded in the reports
// rather than blocking the turn. Written from the case table, blind to rules.mjs/report.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { makeRepo, write, gate } from "./helpers.mjs";

const SESSION = "L1";

// The model's own shell: no session env at all, so the verbs fall back to the marker the
// SessionStart hook wrote (tests/session-marker.test.mjs owns that contract).
function shellEnv(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo };
  delete e.DONE_GATE_SESSION;
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.DONE_GATE_STATE_DIR;
  return e;
}

function sh(repo, args) {
  const r = spawnSync(process.execPath, [gate, ...args], { input: "", encoding: "utf8", env: shellEnv(repo) });
  assert.equal(r.status, 0, `gate ${args.join(" ")}\n${r.stderr}`);
  return r;
}

function hookVerb(repo, verb, payload) {
  const r = spawnSync(process.execPath, [gate, verb], {
    input: JSON.stringify({ session_id: SESSION, cwd: repo, ...payload }),
    encoding: "utf8",
    env: shellEnv(repo),
  });
  assert.equal(r.status, 0, `gate ${verb}\n${r.stderr}`);
  return r;
}

// `check` exits 0 whether or not rules are unmet; only a crash is a failure here.
function check(repo) {
  const r = spawnSync(process.execPath, [gate, "check"], { input: "", encoding: "utf8", env: shellEnv(repo) });
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!/GATE ERROR/.test(out), out);
  return r.stdout;
}

test("C11 boundary: an edit logged before `gate open` blocks R2 only while the Plan or case table is missing, then the late order is recorded", () => {
  const repo = makeRepo("late-order-c11");

  hookVerb(repo, "session-start", { hook_event_name: "SessionStart", session_start_source: "startup" });

  // the Edit tool fires the PostToolUse hook, then the bytes land — before any ledger
  hookVerb(repo, "log", {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(repo, "src", "a.ts") },
    tool_output: "ok",
  });
  write(repo, "src/a.ts", "export const a = 2;\n");

  sh(repo, ["open", "late", "feature"]);

  // nothing written yet: R2 blocks
  const empty = check(repo);
  assert.match(empty, /R2/, `R2 should block while the Plan and case table are missing:\n${empty}`);

  // the Plan alone is not enough — the case table must exist too
  sh(repo, ["note", "task", "Make a() return 2. [inferred]"]);
  sh(repo, ["note", "plan", "One file, one constant.", "--files", "src/a.ts"]);
  const planOnly = check(repo);
  assert.match(planOnly, /R2/, `R2 should still block while the case table is missing:\n${planOnly}`);

  // with both written, the late order stops blocking
  sh(repo, ["case", "add", "a() returns 2", "--kind", "happy"]);
  sh(repo, ["case", "close", "C1", "--na", "covered by the existing fixture"]);
  const both = check(repo);
  assert.ok(!/R2\b/.test(both), `a late Plan and case table that exist must not block:\n${both}`);

  // …and is recorded instead
  const brief = sh(repo, ["report", "--brief"]).stdout;
  assert.match(
    brief,
    /written after the first code change/,
    `the brief should record the late order:\n${brief}`,
  );
});
