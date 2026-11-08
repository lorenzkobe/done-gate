// no-unused-exports: every export of scripts/ is imported by another file, a test included. An
// export only its own file uses is a function nobody outside may rely on; it stays unexported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pluginRoot } from "./helpers.mjs";

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const full = path.join(dir, f);
  if (f === ".tmp" || f === "fixtures" || f === "node_modules") return [];
  return statSync(full).isDirectory() ? walk(full) : full.endsWith(".mjs") ? [full] : [];
});

// the names a file imports: static imports, destructured dynamic imports, (await import(x)).name
// and mod.name, which gate.mjs uses to reach each module's verbs
function importedBy(src) {
  const names = new Set();
  const add = (list) => list.split(",").map((s) => s.trim().split(/\s*:\s*|\s+as\s+/)[0]).filter(Boolean).forEach((n) => names.add(n));
  for (const m of src.matchAll(/import\s*\{([^{}]*)\}\s*from/g)) add(m[1]);
  for (const m of src.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(/g)) add(m[1]);
  for (const m of src.matchAll(/\(await\s+import\([^)]*\)\)\.(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bmod\.(\w+)/g)) names.add(m[1]);
  return names;
}

function unusedExports() {
  const files = [...walk(path.join(pluginRoot, "scripts")), ...walk(path.join(pluginRoot, "tests"))];
  const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const imported = new Map(files.map((f) => [f, importedBy(text.get(f))]));
  const out = [];
  for (const file of files.filter((f) => f.startsWith(path.join(pluginRoot, "scripts")))) {
    for (const m of text.get(file).matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (!files.some((f) => f !== file && imported.get(f).has(m[1]))) out.push(`${path.relative(pluginRoot, file)}:${m[1]}`);
    }
  }
  return out.sort();
}

test("8.2 C1 every export of scripts/ is imported by another file", () => {
  // events, ledger and tree are cleaned in the next run of this batch
  assert.deepEqual(unusedExports(), ["scripts/lib/events.mjs:SILENT", "scripts/lib/ledger.mjs:playbookSteps", "scripts/lib/tree.mjs:countLines"]);
});

test("8.2 C1 the scan sees each kind of import", () => {
  const names = importedBy([
    'import { a, b as c } from "./x.mjs";',
    'const { d, e: f } = await import("./y.mjs");',
    'const g = (await import("./z.mjs")).h;',
    "const fn = mod.verbs?.[verb];",
  ].join("\n"));
  assert.deepEqual([...names].sort(), ["a", "b", "d", "e", "h", "verbs"]);
});
