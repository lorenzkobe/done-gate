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
    "src/a.ts": "export const a = 1;\n",
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
