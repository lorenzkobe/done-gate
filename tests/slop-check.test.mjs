import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { scanDiff } from "../scripts/lib/slop.mjs";
import { changedUnitsOf, evaluate } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { fileDiff } from "../scripts/lib/tree.mjs";

// A unified diff for one file from tagged lines: "+added", "-removed", " context".
function diffOf(lines, rel = "src/b.ts") {
  return [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`, `@@ -1,${lines.length} +1,${lines.length} @@`, ...lines].join("\n");
}
const added = (...lines) => diffOf(lines.map((l) => `+${l}`));
const patterns = (hits) => hits.map((h) => h.pattern);

test("C1 happy: a banner comment on an added line is reported with its line and pattern", () => {
  const hits = scanDiff(added("import x from 'y';", "// ===== ROUTES =====", "# ------", "/* ********** */", "-- ~~~~~~~~~~ --"));
  assert.deepEqual(hits.map((h) => [h.line, h.pattern]), [[2, "banner"], [3, "banner"], [4, "banner"], [5, "banner"]]);
  assert.equal(hits[0].text, "// ===== ROUTES =====");
});

test("C2 happy: step narration, empty label, end marker, emoji, bare and vague TODO, and a @param echoing its name are each named", () => {
  const lines = [
    "// Step 1: validate the input",
    "# step 2 - process",
    "// main logic",
    "// Helper function",
    "# Error handling:",
    "} // end if",
    "# end of function",
    "}); // End processOrder",
    "// ✅ validation done",
    "// TODO",
    "// TODO: improve this",
    "# FIXME: fix later",
    " * @param price The price.",
    " * @param {number} count - the count",
  ];
  const hits = scanDiff(added(...lines));
  assert.deepEqual(patterns(hits), [
    "step narration", "step narration",
    "empty label", "empty label", "empty label",
    "end marker", "end marker", "end marker",
    "emoji",
    "todo", "todo", "todo",
    "signature echo", "signature echo",
  ]);
  assert.deepEqual(hits.map((h) => h.line), lines.map((_, i) => i + 1));
});

test("C3 refused: comments that say why, a TODO naming a task, a URL, a CSS id, a shebang, a short separator and markers inside strings report nothing", () => {
  const hits = scanDiff(added(
    "#!/usr/bin/env node",
    "// Stripe may retry a webhook for three days; the event id dedupes it.",
    "// TODO: drop the legacy hash once every ledger from before 0.9 is closed",
    "const url = 'https://example.com/a'; // the docs host",
    "#main { color: #fff; }",
    "// ---",
    "const banner = '// ===== ROUTES =====';",
    'const label = "# main logic";',
    "// Step counts are one-based in the report.",
    "const end = 1; // end date is exclusive",
    "// Endpoint of the probe",
    " * @param price the unit price in cents, before tax",
  ));
  assert.deepEqual(hits, []);
});

test("misses C1-C4: a string with an apostrophe does not hide a trailing comment; a marker inside a string holding the other quote kind, or after an escaped quote, stays text; flags, stars and ‼ count as emoji", () => {
  const hits = scanDiff(added(
    `const s = "user's"; // ===== X =====`,
    `const t = 'say "hi"'; # ------`,
    `const u = "it's // fine";`,
    `const v = 'say "#" here';`,
    `const w = "a \\" quote // ===== X =====";`,
    "// 🇺🇸 locale",
    "// ⭐ favourite",
    "// ‼ read this",
  ));
  assert.deepEqual(hits.map((h) => [h.line, h.pattern]), [[1, "banner"], [2, "banner"], [6, "emoji"], [7, "emoji"], [8, "emoji"]]);
});

test("C4 edge: only added lines count; a slop comment in context or on a removed line is not reported", () => {
  const hits = scanDiff(diffOf([" // ===== OLD BANNER =====", "-// Step 1: old", "+export const a = 1;", " // main logic"]));
  assert.deepEqual(hits, []);
});

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const cli = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) }).stdout;
function commit(repo) {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: envFor(repo) });
}
const r10 = (out) => out.split("\n").filter((l) => /\bR10\b/.test(l));

function repoWithTask(name, config = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ source: ["src/**"], tests: ["tests/**"], verify: ["true"], ...config }) });
  commit(repo);
  cli(repo, "open", ["t", "feature"]);
  return repo;
}

test("C1/C6 happy: gate check names each hit as file:line pattern and the comment, caps at 12 with a count of the rest, and names the waiver", () => {
  const repo = repoWithTask("slop-hits");
  write(repo, "src/b.ts", ["export const b = 1;", "// ===== ROUTES =====", "// Step 1: route"].join("\n") + "\n");
  const lines = r10(cli(repo, "check"));
  assert.equal(lines.length, 1, `expected one R10 line:\n${lines.join("\n")}`);
  assert.match(lines[0], /slop: 2 slop line/);
  assert.match(lines[0], /src\/b\.ts:2 banner "\/\/ ===== ROUTES ====="/);
  assert.match(lines[0], /src\/b\.ts:3 step narration/);
  assert.match(lines[0], /gate waive slop/);

  write(repo, "src/c.ts", Array.from({ length: 14 }, (_, i) => `// Step ${i + 1}: go`).join("\n") + "\n");
  const capped = r10(cli(repo, "check"))[0];
  assert.match(capped, /16 slop line/);
  assert.equal((capped.match(/src\/[bc]\.ts:\d+ /g) ?? []).length, 12, `12 hits listed:\n${capped}`);
  assert.match(capped, /and 4 more/);
});

test("C3/C4 refused+edge: a clean edit, and a slop comment that already existed above the change, leave R10 clean", () => {
  const repo = makeRepo("slop-clean", { ".claude/gate.json": JSON.stringify({ source: ["src/**"], tests: ["tests/**"], verify: ["true"] }), "src/old.ts": "// ===== OLD =====\nexport const o = 1;\n" });
  commit(repo);
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/old.ts", "// ===== OLD =====\nexport const o = 1;\n// the second export feeds the report\nexport const p = 2;\n");
  assert.deepEqual(r10(cli(repo, "check")), []);
});

test("C5 edge: a deleted file, a doc file and a test file are skipped; a new untracked file is scanned as added", () => {
  const repo = makeRepo("slop-files", { ".claude/gate.json": JSON.stringify({ source: ["src/**", "docs/**"], docs: ["docs/**"], tests: ["**/*.test.*"], verify: ["true"] }), "src/gone.ts": "// Step 1: gone\n" });
  commit(repo);
  cli(repo, "open", ["t", "feature"]);
  rmSync(path.join(repo, "src", "gone.ts"));
  write(repo, "docs/notes.md", "// ===== NOTES =====\n");
  write(repo, "src/b.test.ts", "// ===== from tests/a.test.ts =====\ntest('b', () => {});\n");
  assert.deepEqual(r10(cli(repo, "check")), []);
  write(repo, "src/n.ts", "// main logic\nexport const n = 1;\n");
  const lines = r10(cli(repo, "check"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /src\/n\.ts:1 empty label/);
  assert.doesNotMatch(lines[0], /gone\.ts|notes\.md|b\.test\.ts/);
});

test("C11 refused: with no ledger open the scan does not run, so a Stop with no ledger keeps its exit (R1 alone)", () => {
  const repo = makeRepo("slop-no-ledger");
  commit(repo);
  const state = { root: repo, config: loadConfig(repo), ledger: null, changed: ["src/a.ts"], diff: { changed: ["src/a.ts"], deleted: [] }, now: { hash: "h", files: {} }, verify: null, events: [], reviews: [], lastMessage: "", diffText: new Map([["src/a.ts", diffOf(["+// ===== A ====="], "src/a.ts")]]) };
  assert.deepEqual(evaluate(state).map((u) => u.rule), ["R1"]);
});

test("C7 refused: \"slop\": false turns the scan off, a waiver clears it, and the schema accepts the key", () => {
  const off = repoWithTask("slop-off", { slop: false });
  write(off, "src/b.ts", "// ===== ROUTES =====\n");
  assert.deepEqual(r10(cli(off, "check")), []);

  const waived = repoWithTask("slop-waived");
  write(waived, "src/b.ts", "// ===== ROUTES =====\n");
  assert.equal(r10(cli(waived, "check")).length, 1);
  cli(waived, "waive", ["slop", "the banner is this repo's section style, user agreed"]);
  assert.deepEqual(r10(cli(waived, "check")), []);

  const schema = JSON.parse(readFileSync(path.join(pluginRoot, "gate.schema.json"), "utf8"));
  assert.equal(schema.properties.slop?.type, "boolean");
  assert.equal(loadConfig(off).slop, false);
  assert.equal(loadConfig(waived).slop, true);
});

test("C8 performance: one diff read per file per assess; the slop check and changedUnitsOf share the cache", () => {
  const repo = makeRepo("slop-cache");
  commit(repo);
  const state = {
    root: repo,
    config: loadConfig(repo),
    ledger: { status: "open", steps: [], waivers: [], cases: [], baseline: { head: "HEAD" } },
    baseline: { head: "HEAD" },
    changed: ["src/a.ts"],
    diff: { changed: ["src/a.ts"], deleted: [] },
    now: { hash: "h", files: {} },
    verify: null,
    events: [],
    reviews: [],
    lastMessage: "",
    diffText: new Map([["src/a.ts", diffOf(["+// ===== A =====", "+export const a = 1;"], "src/a.ts")]]),
  };
  const hit = evaluate(state).find((u) => u.rule === "R10");
  assert.ok(hit, "the check read the cached diff, not the clean file on disk");
  assert.match(hit.text, /src\/a\.ts:1 banner/);
  assert.equal(changedUnitsOf(state, "src/a.ts").length, 2, "changedUnitsOf read the same cached diff");
  assert.equal(state.diffText.size, 1);
});

test("C9 happy: the prompt files name the new patterns and the keep-list; README's R10 row names slop", () => {
  const prompts = ["skills/gate/SKILL.md", "agents/worker.md", "agents/reviewer.md", "agents/reviewer-2.md"];
  for (const rel of prompts) {
    const text = readFileSync(path.join(pluginRoot, rel), "utf8").replace(/\s+/g, " ");
    for (const re of [/banner/i, /step/i, /label/i, /marks an end|end marker|end if/i, /signature|@param/i, /two at most|two when/i, /workaround/i]) {
      assert.match(text, re, `${rel} lacks ${re}`);
    }
  }
  const readme = readFileSync(path.join(pluginRoot, "README.md"), "utf8");
  const row = readme.split("\n").find((l) => l.startsWith("| R10"));
  assert.match(row, /slop/);
  assert.match(readme, /"slop"/);
});

test("C10 reported surface: the plugin's own scanner, rules, config and this test pass the scan as all-added diffs", () => {
  for (const rel of ["scripts/lib/slop.mjs", "scripts/lib/rules.mjs", "scripts/lib/config.mjs", "tests/slop-check.test.mjs"]) {
    const hits = scanDiff(fileDiff(pluginRoot, "HEAD", rel, false));
    assert.deepEqual(hits, [], `${rel}: ${JSON.stringify(hits)}`);
  }
});
