import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(here, "..");
export const gate = path.join(pluginRoot, "scripts", "gate.mjs");

// The gate reads which MCP servers are set up from the home folder; tests see an empty one
// unless they point DONE_GATE_HOME elsewhere, so this machine's own setup never leaks in.
process.env.DONE_GATE_HOME ??= path.join(here, ".tmp", "home-empty");
// the seals of what the gate writes go outside the repo; a test's stay under tests/.tmp
process.env.DONE_GATE_SEALS ??= path.join(here, ".tmp", "seals");

// False for an installed copy: the plugin cache has no .git, and a marketplace clone puts the
// plugin below its top. Checks that read the plugin's own git history skip there.
export const AT_GIT_TOPLEVEL = (() => {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: pluginRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return realpathSync(top) === realpathSync(pluginRoot);
  } catch {
    return false;
  }
})();

// A throwaway git repo with a few files, a .gitignore and package.json scripts.
export function makeRepo(name, files = {}) {
  const dir = path.join(here, ".tmp", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // a repo made again at the same path starts with no seals from the last one
  rmSync(sealsOf(path.join(realpathSync(dir), ".claude", "gate")), { recursive: true, force: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const all = {
    ".gitignore": "node_modules/\nignored.txt\n",
    "package.json": JSON.stringify({ name, scripts: { lint: "true", test: "true", build: "true" } }),
    // twenty lines, so a rewrite measures past tiny (15 lines) and the reviewer rules apply
    "src/a.ts": Array.from({ length: 20 }, (_, i) => `export const a${i} = ${i};`).join("\n") + "\n",
    "src/app/page.tsx": "export default () => null;\n",
    "tests/a.test.ts": "test('a', () => {});\n",
    "docs/notes.md": "# notes\n",
    "ignored.txt": "not tracked\n",
    // setup recorded as declined, so a session start does not hold `gate open` for it; a test of
    // setup itself passes ".claude/gate.json": null to start with none
    ".claude/gate.json": JSON.stringify({ testFiles: null }),
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) if (content !== null) write(dir, rel, content);
  return dir;
}

export function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export const CODE_LOOKUP = "mcp__socraticode__codebase_search";
export const MEMORY_LOOKUP = "mcp__mempalace__mempalace_search";

// One code-search and one memory lookup, logged the way the PostToolUse hook logs an MCP call:
// by the lead (no agent) or by a helper (agent id plus done-gate:<role>). The gate asks both of
// the lead before `gate note context` and of each helper whose file it records.
export function lookedUp(repo, { agent = null, role = null, session = "S1", tools = [CODE_LOOKUP, MEMORY_LOOKUP] } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete env.CLAUDE_CODE_SESSION_ID;
  for (const tool_name of tools) {
    const payload = {
      session_id: session, cwd: repo, hook_event_name: "PostToolUse", tool_name,
      tool_input: { query: "where the change lands" }, tool_response: {},
      ...(agent ? { agent_id: agent, agent_type: role.includes(":") ? role : `done-gate:${role}` } : {}),
    };
    execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify(payload), env });
  }
}

const RUN_KEYS = new Set(["repro", "rootcause", "schema"]);

// Arguments that close a step DONE. A step that claims a run (repro, rootcause, schema)
// closes only on a recorded run, so one is logged first, the way the PostToolUse hook does.
export function doneArgs(repo, ref, key, note, evidence, session = "S1") {
  if (!RUN_KEYS.has(key)) return [ref, "done", note, "--evidence", evidence];
  const payload = { session_id: session, cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `node probe.mjs ${key}` }, tool_response: { exit_code: 0 } };
  execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session } });
  return [ref, "done", `${note} (src/a.ts:1)`, "--ran", `node probe.mjs ${key}`];
}

// Writes the minimal Task, Context, Plan and one case into the open run, so the fence lets
// code be edited (an edit before them is refused). `plan` adds args to `gate note plan`.
export function readyToEdit(repo, { session = "S1", plan = [] } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete env.CLAUDE_CODE_SESSION_ID;
  lookedUp(repo, { session });
  for (const args of [
    ["note", "task", "the task"],
    ["note", "context", "Traced: src/a.ts:1 · Related: none: `grep -rn a src` · Research: none needed: a test fixture"],
    ["note", "plan", "the plan", ...plan],
    ["case", "add", "the case", "--kind", "happy"],
  ]) {
    const r = spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`readyToEdit: gate ${args.slice(0, 2).join(" ")}: ${r.stderr}`);
  }
}

// The plan check, run the way the lead runs it: the real brief, a finished skeptic file with
// nothing to act on, recorded, and the step closed by hand when the gate has not closed it.
export function planChecked(repo, { session = "S1" } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (args) => {
    const r = spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`planChecked: gate ${args.slice(0, 2).join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const file = /Your file is (\S+\.md)/.exec(run(["brief", "skeptic"]))?.[1];
  if (!file) throw new Error("planChecked: gate brief skeptic named no file");
  writeFileSync(file, "# Skeptic\n\n## Act on\n- none\n## Consider\n- none\n## Noted\n- none\n## The one question\n- none\n");
  run(["huddle", "add", "skeptic", "--file", path.basename(file)]);
  const ledger = JSON.parse(readFileSync(path.join(path.dirname(file), "ledger.json"), "utf8"));
  if (!ledger.steps.find((s) => s.key === "skeptic")?.state) run(["step", "skeptic", "done", "checked", "--evidence", path.basename(file)]);
}

// A failed run of a test file, logged as the lead's command: what closes a reviewer finding on a
// test pointer on a run under the new rules.
export function redRun(repo, file = "tests/a.test.ts", session = "S1") {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete env.CLAUDE_CODE_SESSION_ID;
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: session, cwd: repo, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: `node --test ${file}` }, tool_error: "Exit code 1\nnot ok 1" }), encoding: "utf8", env });
}

// The run's pinned policy as a run pinned before 0.22 holds it: three rounds before the fix-check,
// and no call owed for lines changed after review; for the mechanics those runs keep.
export function pinnedBefore(repo, session = "S1") {
  const stateDir = path.join(repo, ".claude", "gate");
  const { current } = JSON.parse(readFileSync(path.join(stateDir, "sessions", session, "state.json"), "utf8"));
  const ledgerFile = path.join(stateDir, "runs", current, "ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  const { lateLines: _new, ...policy } = ledger.policy;
  ledger.policy = { ...policy, reviewRounds: 3 };
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  resealRun(repo, session);
}

// A fixture's own write of the open run's ledger.json, sealed as the gate seals its writes
// (scripts/lib/seal.mjs keeps the same format), so it does not read as a change outside the gate.
const sealsOf = (realStateDir) => path.join(process.env.DONE_GATE_SEALS || path.join(os.homedir(), ".claude", "done-gate", "seals"), createHash("sha1").update(realStateDir).digest("hex").slice(0, 16));
export function resealRun(repo, session = "S1") {
  const stateDir = path.join(repo, ".claude", "gate");
  const { current } = JSON.parse(readFileSync(path.join(stateDir, "sessions", session, "state.json"), "utf8"));
  const text = readFileSync(path.join(stateDir, "runs", current, "ledger.json"), "utf8");
  const dir = sealsOf(realpathSync(stateDir));
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, `run-${current}-${JSON.parse(text).openedSeq}.seals`), `ledger.json\t${createHash("sha1").update(text).digest("hex")}\n`);
}

// A run from before the rules stamp: the marker taken back out of the open ledger.
export function asOldRun(repo, session = "S1") {
  const stateDir = path.join(repo, ".claude", "gate");
  const { current } = JSON.parse(readFileSync(path.join(stateDir, "sessions", session, "state.json"), "utf8"));
  const ledgerFile = path.join(stateDir, "runs", current, "ledger.json");
  const { rules: _gone, ...ledger } = JSON.parse(readFileSync(ledgerFile, "utf8"));
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
}

// The user's message, as the hook logs it. A fixture writes files with no hook: the gate has to see
// them before the words, as it would a real edit.
export function userSays(repo, words, session = "S1") {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete env.CLAUDE_CODE_SESSION_ID;
  spawnSync(process.execPath, [gate, "check"], { env });
  execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: session, cwd: repo, hook_event_name: "UserPromptSubmit", prompt: words }), env });
}

// The user's words for a waiver, logged as their message, and the args that waive on them. A rule
// number's key is spelled out, since the words have to name the check given up.
const RULE_WORD = { R4: "driver", R5: "review", R6: "schema", R7: "tests" };
export function waiveArgs(repo, key, reason, { session = "S1" } = {}) {
  const words = `you may skip the ${RULE_WORD[key] ?? key} check`;
  userSays(repo, words, session);
  return [key, reason, "--user-ok", words];
}

// The user's words for giving a used run up, logged as their message, and the args that abandon on them.
export function abandonArgs(repo, slug, reason, { session = "S1" } = {}) {
  const words = `abandon the ${slug} run`;
  userSays(repo, words, session);
  return [slug, reason, "--user-ok", words];
}

// The lead's process keeps its pid across /clear, and the fence left the earlier session's id
// under it. A hook spawned by this test process has this pid as its parent.
export function clearedFrom(repo, session, pid = process.pid) {
  const dir = path.join(repo, ".claude", "gate", "pids");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, String(pid)), session);
}

// The args that close a planned case N/A, on words the user just said.
export function naArgs(repo, id, reason, { session = "S1" } = {}) {
  const words = "no test for this case";
  userSays(repo, words, session);
  return ["close", id, "--na", reason, "--user-ok", words];
}
