import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(here, "..");
export const gate = path.join(pluginRoot, "scripts", "gate.mjs");

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

const RUN_KEYS = new Set(["repro", "rootcause", "schema"]);

// Arguments that close a step DONE. A step that claims a run (repro, rootcause, schema)
// closes only on a recorded run, so one is logged first, the way the PostToolUse hook does.
export function doneArgs(repo, ref, key, note, evidence, session = "S1") {
  if (!RUN_KEYS.has(key)) return [ref, "done", note, "--evidence", evidence];
  const payload = { session_id: session, cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `node probe.mjs ${key}` }, tool_response: { exit_code: 0 } };
  execFileSync(process.execPath, [gate, "log"], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session } });
  return [ref, "done", `${note} (src/a.ts:1)`, "--ran", `node probe.mjs ${key}`];
}
