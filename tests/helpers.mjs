import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(here, "..");
export const gate = path.join(pluginRoot, "scripts", "gate.mjs");

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
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) write(dir, rel, content);
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
  for (const args of [
    ["note", "task", "the task"],
    ["note", "context", "Traced: src/a.ts:1 · Related: none: `grep -rn a src` · Research: none needed: a test fixture", "--no-code", "SocratiCode: not installed", "--no-memory", "MemPalace: not installed"],
    ["note", "plan", "the plan", ...plan],
    ["case", "add", "the case", "--kind", "happy"],
  ]) {
    const r = spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`readyToEdit: gate ${args.slice(0, 2).join(" ")}: ${r.stderr}`);
  }
}
