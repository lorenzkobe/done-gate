import { test } from "node:test";
import assert from "node:assert/strict";
import { utimesSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { snapshot, diffSnapshots, listFiles } from "../scripts/lib/tree.mjs";

test("listFiles respects .gitignore and never lists the gate state or .git", () => {
  const repo = makeRepo("tree-list");
  write(repo, ".claude/gate/runs/x/ledger.md", "x");
  write(repo, "node_modules/dep/index.js", "x");
  const files = listFiles(repo);
  assert.ok(files.includes("src/a.ts"));
  assert.ok(files.includes("docs/notes.md"));
  assert.ok(!files.includes("ignored.txt"));
  assert.ok(!files.some((f) => f.startsWith(".git/")));
  assert.ok(!files.some((f) => f.startsWith("node_modules/")));
  assert.ok(!files.some((f) => f.startsWith(".claude/gate/")));
});

test("snapshot hash is stable, changes on content change, ignores the gate dir and mtime-only touches", () => {
  const repo = makeRepo("tree-hash");
  const s1 = snapshot(repo);
  const s2 = snapshot(repo);
  assert.equal(s1.hash, s2.hash);
  assert.match(s1.hash, /^[0-9a-f]{40}$/);

  write(repo, ".claude/gate/runs/x/ledger.md", "prose");
  assert.equal(snapshot(repo).hash, s1.hash);

  const past = new Date(Date.now() - 60_000);
  utimesSync(path.join(repo, "src/a.ts"), past, past);
  assert.equal(snapshot(repo, s1).hash, s1.hash);

  write(repo, "src/a.ts", "export const a = 2;\n");
  assert.notEqual(snapshot(repo, s1).hash, s1.hash);
});

test("diffSnapshots reports modified, added and deleted paths", () => {
  const repo = makeRepo("tree-diff");
  const before = snapshot(repo);
  write(repo, "src/a.ts", "changed\n");
  write(repo, "src/new.ts", "new\n");
  const after = snapshot(repo, before);
  const d = diffSnapshots(before, after);
  assert.deepEqual(d.modified, ["src/a.ts"]);
  assert.deepEqual(d.added, ["src/new.ts"]);
  assert.deepEqual(d.deleted, []);
  assert.deepEqual(d.changed, ["src/a.ts", "src/new.ts"]);
});

test("snapshot reuses cached hashes when size and mtime are unchanged", () => {
  const repo = makeRepo("tree-cache");
  const s1 = snapshot(repo);
  const s2 = snapshot(repo, s1);
  assert.equal(s2.hash, s1.hash);
  assert.ok(s2.rehashed < Object.keys(s1.files).length, "most files should come from the cache");
});

test("changed files can be classified with the repo config", () => {
  const repo = makeRepo("tree-classify");
  const cfg = loadConfig(repo);
  const before = snapshot(repo);
  write(repo, "docs/notes.md", "# more\n");
  write(repo, "src/app/page.tsx", "changed\n");
  const d = diffSnapshots(before, snapshot(repo, before));
  assert.deepEqual(d.changed.filter(cfg.isSource), ["src/app/page.tsx"]);
  assert.deepEqual(d.changed.filter(cfg.isDoc), ["docs/notes.md"]);
  assert.deepEqual(d.changed.filter(cfg.isUi), ["src/app/page.tsx"]);
});
