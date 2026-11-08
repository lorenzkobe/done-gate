// no-unused-exports: every export of scripts/ is imported by another file, a test included. An
// export only its own file uses is a function nobody outside may rely on; it stays unexported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { makeRepo, pluginRoot, write } from "./helpers.mjs";

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const full = path.join(dir, f);
  if (f === ".tmp" || f === "fixtures" || f === "node_modules") return [];
  return statSync(full).isDirectory() ? walk(full) : full.endsWith(".mjs") ? [full] : [];
});

// What a file imports, as "<module path>#<name>": static imports, destructured dynamic imports
// and (await import(x)).name, each resolved from the file's folder; mod.name stands for every
// module the file loads with import("..."), as gate.mjs reaches each module's verbs.
function importedBy(src, from = pluginRoot) {
  const out = new Set();
  const at = (spec) => path.resolve(path.dirname(from), spec);
  const add = (list, spec) => list.split(",").map((s) => s.trim().split(/\s*:\s*|\s+as\s+/)[0]).filter(Boolean).forEach((n) => out.add(`${at(spec)}#${n}`));
  for (const m of src.matchAll(/import\s*\{([^{}]*)\}\s*from\s*["']([^"']+)["']/g)) add(m[1], m[2]);
  for (const m of src.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], m[2]);
  for (const m of src.matchAll(/\(await\s+import\(\s*["']([^"']+)["']\s*\)\)\.(\w+)/g)) out.add(`${at(m[1])}#${m[2]}`);
  const loaded = [...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => at(m[1]));
  for (const m of src.matchAll(/\bmod\.(\w+)/g)) for (const mod of loaded) out.add(`${mod}#${m[1]}`);
  return out;
}

function unusedExports(root = pluginRoot) {
  const files = [...walk(path.join(root, "scripts")), ...walk(path.join(root, "tests"))];
  const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const imported = new Map(files.map((f) => [f, importedBy(text.get(f), f)]));
  const out = [];
  for (const file of files.filter((f) => f.startsWith(path.join(root, "scripts")))) {
    for (const name of exportedBy(text.get(file))) {
      if (!files.some((f) => f !== file && imported.get(f).has(`${file}#${name}`))) out.push(`${path.relative(root, file)}:${name}`);
    }
  }
  return out.sort();
}

// the names a file exports: declarations and export { a, b as c } lists, by their outside name
function exportedBy(src) {
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) names.push(...m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  return names;
}

test("8.2 C1 every export of scripts/ is imported by another file", () => {
  assert.deepEqual(unusedExports(), []);
});

test("8.2 C2 the scan reads export lists by their outside name", () => {
  assert.deepEqual(exportedBy("export function a() {}\nexport const b = 1;\nexport { c, d as e };\n"), ["a", "b", "c", "e"]);
});

test("8.2 C1 the scan sees each kind of import, by module", () => {
  const at = path.join(pluginRoot, "scripts", "lib", "a.mjs");
  const lib = (f) => path.join(pluginRoot, "scripts", "lib", f);
  const names = importedBy([
    'import { a, b as c } from "./x.mjs";',
    'const { d, e: f } = await import("./y.mjs");',
    'const g = (await import("./z.mjs")).h;',
    'const VERBS = { v: { load: () => import("./w.mjs") } };',
    "const fn = mod.verbs?.[verb];",
  ].join("\n"), at);
  assert.deepEqual([...names].sort(), [`${lib("w.mjs")}#verbs`, `${lib("x.mjs")}#a`, `${lib("x.mjs")}#b`, `${lib("y.mjs")}#d`, `${lib("y.mjs")}#e`, `${lib("y.mjs")}#verbs`, `${lib("z.mjs")}#h`, `${lib("z.mjs")}#verbs`].sort());
});

test("8.2 C4 a name imported from one module does not cover another module that exports it too", () => {
  const repo = makeRepo("nue-c4");
  write(repo, "scripts/lib/a.mjs", "export const x = 1;\n");
  write(repo, "scripts/lib/b.mjs", "export const x = 2;\n");
  write(repo, "tests/t.test.mjs", 'import { x } from "../scripts/lib/a.mjs";\n');
  assert.deepEqual(unusedExports(repo), ["scripts/lib/b.mjs:x"]);
});
