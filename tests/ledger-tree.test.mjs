import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, readdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, write, pluginRoot } from "./helpers.mjs";
import { loadSession, ensureSession } from "../scripts/lib/session-state.mjs";
import { openLedger, attachLedger, currentLedger, loadLedger } from "../scripts/lib/ledger.mjs";
import { loadConfig, matchGlob, matchAny, DEFAULTS } from "../scripts/lib/config.mjs";
import { snapshot, diffSnapshots, listFiles } from "../scripts/lib/tree.mjs";
import { fileURLToPath } from "node:url";
import { toPosixRel } from "../scripts/lib/paths.mjs";
import { nextHint } from "../scripts/lib/next.mjs";

// the understand-first note every fixture writes before its plan
const CONTEXT = "Traced: src/a.ts:1 is the entry, read by src/app/page.tsx:1.\nRelated: tests/a.test.ts pins it.\nResearch: none needed: a local change.";

// ===== from tests/ledger.test.mjs =====
{
const stateOf = (repo) => path.join(repo, ".claude", "gate");

test("ensureSession snapshots the tree once per session and keeps it on repeat calls", () => {
  const repo = makeRepo("ledger-session");
  const s = ensureSession(stateOf(repo), repo, "S1");
  assert.equal(s.session, "S1");
  assert.match(s.baseline.hash, /^[0-9a-f]{40}$/);
  const again = ensureSession(stateOf(repo), repo, "S1");
  assert.equal(again.baseline.hash, s.baseline.hash);
  assert.equal(again.startedAt, s.startedAt);
  assert.equal(loadSession(stateOf(repo), "S9"), null);
});

test("openLedger creates the run dir, ledger.json/ledger.md, points the session at it and ignores the state dir", () => {
  const repo = makeRepo("ledger-open");
  ensureSession(stateOf(repo), repo, "S1");
  const { dir, ledger } = openLedger({ stateDir: stateOf(repo), root: repo, session: "S1" }, "venue-badge", "feature");
  assert.ok(existsSync(path.join(dir, "ledger.json")));
  assert.ok(existsSync(path.join(dir, "ledger.md")));
  assert.equal(ledger.slug, "venue-badge");
  assert.equal(ledger.playbook, "feature");
  assert.equal(ledger.status, "open");
  assert.deepEqual(ledger.sessions, ["S1"]);
  assert.match(ledger.gateHash, /^[0-9a-f]{40}$/);
  assert.equal(ledger.baseline.hash, loadSession(stateOf(repo), "S1").baseline.hash);
  assert.ok(ledger.steps.length > 0, "playbook steps copied in");
  assert.equal(currentLedger(stateOf(repo), "S1").dir, dir);
  assert.match(readFileSync(path.join(repo, ".gitignore"), "utf8"), /^\.claude\/gate\/$/m);
});

test("opening the same slug twice attaches instead of creating a second run", () => {
  const repo = makeRepo("ledger-reopen");
  ensureSession(stateOf(repo), repo, "S1");
  const first = openLedger({ stateDir: stateOf(repo), root: repo, session: "S1" }, "x", "bugfix");
  ensureSession(stateOf(repo), repo, "S2");
  const second = openLedger({ stateDir: stateOf(repo), root: repo, session: "S2" }, "x", "bugfix");
  assert.equal(second.dir, first.dir);
  assert.deepEqual(loadLedger(first.dir).sessions, ["S1", "S2"]);
  assert.equal(currentLedger(stateOf(repo), "S2").dir, first.dir);
});

test("attachLedger joins an existing run from a new session and refuses an unknown slug", () => {
  const repo = makeRepo("ledger-attach");
  ensureSession(stateOf(repo), repo, "S1");
  const { dir } = openLedger({ stateDir: stateOf(repo), root: repo, session: "S1" }, "y", "refactor");
  ensureSession(stateOf(repo), repo, "S2");
  attachLedger({ stateDir: stateOf(repo), root: repo, session: "S2" }, "y");
  assert.deepEqual(loadLedger(dir).sessions, ["S1", "S2"]);
  assert.throws(() => attachLedger({ stateDir: stateOf(repo), root: repo, session: "S2" }, "nope"), /no run/);
});

test("`gate open` CLI prints the run dir and playbook steps", () => {
  const repo = makeRepo("ledger-cli");
  const r = spawnSync(process.execPath, [gate, "open", "cli-task", "feature"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cli-task/);
  assert.match(r.stdout, /1\./);
  assert.ok(existsSync(path.join(repo, ".claude", "gate", "runs")));
});
}

// ===== from tests/tree.test.mjs =====
{
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
}

// ===== from tests/lib.test.mjs =====
{
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

test("glob: ** spans directories and * stays within one segment", () => {
  assert.equal(matchGlob("src/**", "src/a/b.ts"), true);
  assert.equal(matchGlob("src/**", "src"), true);
  assert.equal(matchGlob("src/**", "srcx/a.ts"), false);
  assert.equal(matchGlob("*.md", "README.md"), true);
  assert.equal(matchGlob("*.md", "docs/a.md"), false);
  assert.equal(matchGlob("**/*.md", "docs/a.md"), true);
  assert.equal(matchGlob("**/*.md", "README.md"), true);
});

test("glob: brace alternation and ? work", () => {
  assert.equal(matchGlob("**/*.{test,spec}.*", "tests/a.test.ts"), true);
  assert.equal(matchGlob("**/*.{test,spec}.*", "a/b.spec.tsx"), true);
  assert.equal(matchGlob("**/*.{test,spec}.*", "a/b.ts"), false);
  assert.equal(matchGlob("**/{tests,test,__tests__,spec}/**", "a/__tests__/y.ts"), true);
  assert.equal(matchGlob("**/{tests,test,__tests__,spec}/**", "tests/x.ts"), true);
  assert.equal(matchGlob("**/{tests,test,__tests__,spec}/**", "src/x.ts"), false);
  assert.equal(matchGlob("src/?.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/?.ts", "src/ab.ts"), false);
});

test("glob: regex metacharacters in patterns are literal", () => {
  assert.equal(matchGlob("src/lib/data/courtly-db.ts", "src/lib/data/courtly-db.ts"), true);
  assert.equal(matchGlob("src/a.ts", "src/aXts"), false);
  assert.equal(matchGlob("src/(app)/**", "src/(app)/page.tsx"), true);
});

test("matchAny: case-insensitive when asked (win32 / macOS default FS)", () => {
  assert.equal(matchAny(["src/**"], "SRC/a.ts"), false);
  assert.equal(matchAny(["src/**"], "SRC/a.ts", { ignoreCase: true }), true);
});

test("paths: root-relative POSIX, backslashes normalised, outside root is null", () => {
  const root = "/repo";
  assert.equal(toPosixRel(root, "/repo/src/a.ts"), "src/a.ts");
  assert.equal(toPosixRel(root, "/repo\\src\\b.ts"), "src/b.ts");
  assert.equal(toPosixRel(root, "src/c.ts"), "src/c.ts");
  assert.equal(toPosixRel(root, "/elsewhere/x.ts"), null);
  assert.equal(toPosixRel(root, "/repo"), "");
});

test("config: no gate.json derives verify from package.json scripts in canonical order", () => {
  const cfg = loadConfig(path.join(fixtures, "repo-no-config"));
  assert.deepEqual(
    cfg.verify.map((v) => v.cmd),
    ["npm run lint", "npm run test", "npm run build"],
  );
  assert.equal(cfg.verify[0].timeout, DEFAULTS.verifyTimeout);
  assert.deepEqual(cfg.source, DEFAULTS.source);
  assert.deepEqual(cfg.tests, DEFAULTS.tests);
  assert.deepEqual(cfg.ui, DEFAULTS.ui);
  assert.deepEqual(cfg.highRisk, []);
  assert.deepEqual(cfg.checks, []);
  assert.equal(cfg.driver, null);
  assert.equal(cfg.explicit, false);
});

test("config: gate.json replaces the default arrays and normalises verify entries", () => {
  const cfg = loadConfig(path.join(fixtures, "repo-with-config"));
  assert.equal(cfg.explicit, true);
  assert.deepEqual(cfg.source, ["src/**", "supabase/**", "tests/**", "package.json"]);
  // `when` is part of every normalised entry. A hand-written entry is "always" unless it says
  // otherwise or is one build call and nothing else, which gets "source" like the build
  // derived from package.json (faster-loop.test.mjs C9/C18).
  assert.deepEqual(cfg.verify, [
    { cmd: "npm run lint", timeout: DEFAULTS.verifyTimeout, when: "always" },
    { cmd: "npm run test", timeout: 900, when: "always" },
    { cmd: "npm run build", timeout: DEFAULTS.verifyTimeout, when: "source" },
  ]);
  assert.deepEqual(cfg.checks, ["claude-md-budget", "migration-number"]);
  assert.equal(cfg.driver, "skill:verify");
});

test("config: gate.json hash is stable and changes with content", () => {
  const a = loadConfig(path.join(fixtures, "repo-with-config"));
  const b = loadConfig(path.join(fixtures, "repo-with-config"));
  const c = loadConfig(path.join(fixtures, "repo-no-config"));
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.match(a.hash, /^[0-9a-f]{40}$/);
});

test("config: the gate's own state dir is always excluded from source", () => {
  const cfg = loadConfig(path.join(fixtures, "repo-with-config"));
  assert.equal(cfg.isSource(".claude/gate/runs/x/ledger.md"), false);
  assert.equal(cfg.isSource("src/a.ts"), true);
  assert.equal(cfg.isSource("docs/x.md"), false);
});
}

// ===== from tests/ledger-tree.test.mjs =====
{
// T3 — the five small lib files are absorbed into their neighbours and deleted.
// Written from the requirements and from the pre-merge sources at HEAD (the spec for
// "behaviour unchanged"), never from the merged files. Every import is dynamic so a
// missing export fails only its own case.

const libDir = path.join(pluginRoot, "scripts", "lib");
const REMOVED = ["doctor.mjs", "checks.mjs", "glob.mjs", "review.mjs", "policy.mjs"];

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.DONE_GATE_STATE_DIR;
  return e;
}

function run(repo, verb, args = []) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input: "",
    encoding: "utf8",
    env: envFor(repo),
  });
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");

// ---------------------------------------------------------------------------
// C1 — gate doctor and gate check still run and print the same output
// ---------------------------------------------------------------------------

test("C1 check.mjs is the home of both verbs", async () => {
  const { verbs } = await import("../scripts/lib/check.mjs");
  assert.deepEqual(Object.keys(verbs).sort(), ["check", "doctor"]);
});

test("C1 doctor and check still run and keep their output shape", () => {
  const repo = makeRepo("t3-verbs");
  const version = JSON.parse(
    readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
  ).version;

  const doc = run(repo, "doctor");
  assert.equal(doc.status, 0, doc.stderr);
  const out = lines(doc.stdout);
  // first line: "done-gate <version> · node <node> · <platform>"
  assert.equal(out[0], `done-gate ${version} · node ${process.version} · ${process.platform}`);
  const has = (prefix) => out.some((l) => l.startsWith(prefix));
  for (const prefix of ["repo: ", "config: ", "  source: ", "  tests: ", "  verify: ", "session: ", "ledger: ", "gate errors: "]) {
    assert.ok(has(prefix), `doctor is missing a "${prefix.trim()}" line:\n${doc.stdout}`);
  }
  assert.ok(out.some((l) => l.startsWith("config: ") && l.includes("defaults (no .claude/gate.json)")));

  // check before anything is open: runs clean, says so in one word
  const before = run(repo, "check");
  assert.equal(before.status, 0, before.stderr);

  // check with a ledger open: a numbered list of unmet rules, nothing else
  const opened = run(repo, "open", ["t3-shape", "feature"]);
  assert.equal(opened.status, 0, opened.stderr);
  const after = run(repo, "check");
  assert.equal(after.status, 0, after.stderr);
  const body = lines(after.stdout);
  assert.ok(body.length > 0, "an open feature ledger has unmet rules");
  for (const l of body) assert.match(l, /^\d+\. \S+ — \S/);
  assert.equal(after.stderr, "");
});

// ---------------------------------------------------------------------------
// C2 — no import cycle at load time, whichever module is the entry point
// ---------------------------------------------------------------------------

test("C2 every lib module loads as its own entry point, with no cycle error", () => {
  const mods = readdirSync(libDir).filter((f) => f.endsWith(".mjs")).sort();
  assert.ok(mods.length >= 15, `expected the lib dir to still hold the modules, got ${mods.length}`);
  const failures = [];
  for (const m of mods) {
    const url = JSON.stringify(path.join(libDir, m));
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${url});`], {
      encoding: "utf8",
      env: { ...process.env },
    });
    if (r.status !== 0) failures.push(`${m}: ${r.stderr.trim().split("\n")[0]}`);
  }
  assert.deepEqual(failures, []);
});

test("C2 size.mjs and ledger.mjs load together in either order", () => {
  const p = (m) => JSON.stringify(path.join(libDir, m));
  for (const [a, b] of [["size.mjs", "ledger.mjs"], ["ledger.mjs", "size.mjs"], ["assess.mjs", "size.mjs"]]) {
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const x = await import(${p(a)}); const y = await import(${p(b)}); if (!Object.keys(x).length || !Object.keys(y).length) throw new Error("empty namespace");`],
      { encoding: "utf8", env: { ...process.env } },
    );
    assert.equal(r.status, 0, `${a} then ${b}:\n${r.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// C3 — the glob helpers now live in config.mjs
// ---------------------------------------------------------------------------

test("C3 globToRegex, matchGlob and matchAny come from config.mjs and match as before", async () => {
  const { globToRegex, matchGlob, matchAny } = await import("../scripts/lib/config.mjs");
  assert.equal(typeof globToRegex, "function");
  assert.equal(typeof matchGlob, "function");
  assert.equal(typeof matchAny, "function");

  // ** spans directories, * stays inside one segment, ? is one non-slash char
  assert.equal(matchGlob("**/*.test.ts", "src/deep/a.test.ts"), true);
  assert.equal(matchGlob("**/*.test.ts", "a.test.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/nested/a.ts"), false);
  assert.equal(matchGlob("a?.ts", "ab.ts"), true);
  assert.equal(matchGlob("a?.ts", "a/.ts"), false);

  // a trailing /** is the directory itself or anything beneath it
  assert.equal(matchGlob("tests/**", "tests"), true);
  assert.equal(matchGlob("tests/**", "tests/a/b.ts"), true);
  assert.equal(matchGlob("tests/**", "testsx/a.ts"), false);

  // {a,b} alternation, including the repo's own tests glob
  assert.equal(matchGlob("**/{tests,spec}/**", "packages/x/tests/a.ts"), true);
  assert.equal(matchGlob("**/{tests,spec}/**", "packages/x/src/a.ts"), false);
  assert.equal(matchGlob("**/*.{test,spec}.*", "src/a.spec.tsx"), true);

  // dots are literal, not "any char"
  assert.equal(matchGlob("*.ts", "ats"), false);

  // ignoreCase is opt-in
  assert.equal(matchGlob("*.TS", "a.ts"), false);
  assert.equal(matchGlob("*.TS", "a.ts", { ignoreCase: true }), true);

  assert.ok(globToRegex("*.ts") instanceof RegExp);
  assert.equal(globToRegex("*.ts").test("a.ts"), true);
  assert.equal(globToRegex("*.ts").test("b/a.ts"), false);

  assert.equal(matchAny(["docs/**", "**/*.md"], "README.md"), true);
  assert.equal(matchAny(["docs/**"], "README.md"), false);
  assert.equal(matchAny([], "README.md"), false);
});

// ---------------------------------------------------------------------------
// C4 — the helper-file readers now live in rules.mjs
// ---------------------------------------------------------------------------

test("C4 parseFindings, parseDisputes and parseRuling come from rules.mjs and parse the same fixtures", async () => {
  const { parseFindings, parseDisputes, parseRuling } = await import("../scripts/lib/rules.mjs");

  const review = [
    "# review-1",
    "prose that is not a bullet",
    "## Act on",
    "- H1.1 — the guard misses the refused path",
    "  * H1.2 — the migration column is wrong",
    "prose inside the section",
    "## Notes",
    "- not a finding",
    "",
  ].join("\n");
  assert.deepEqual(parseFindings(review), [
    { text: "H1.1 — the guard misses the refused path" },
    { text: "H1.2 — the migration column is wrong" },
  ]);
  assert.deepEqual(parseFindings("## Act on\n- none\n"), []);
  assert.deepEqual(parseFindings("## Act on\n- N/A\n"), []);
  assert.deepEqual(parseFindings("## Notes\n- something\n"), []);
  assert.deepEqual(parseFindings(""), []);
  assert.deepEqual(parseFindings(undefined), []);
  assert.deepEqual(parseFindings("## Act on\r\n- H1.1 — carriage returns\r\n"), [{ text: "H1.1 — carriage returns" }]);

  const disputes = [
    "## Disputes",
    "- H1.2 — withdrawn: the evidence covers it",
    "- H1.3 — upheld: still unhandled",
    "- H1.4 — maybe: not a verdict",
    "- free prose",
    "## Act on",
    "- H9.9 — wrong section",
  ].join("\n");
  assert.deepEqual(parseDisputes(disputes), [
    { id: "H1.2", verdict: "withdrawn", reason: "the evidence covers it" },
    { id: "H1.3", verdict: "upheld", reason: "still unhandled" },
  ]);
  assert.deepEqual(parseDisputes("## Ruling\n- H1.2 — withdrawn: elsewhere\n"), []);

  const ruling = [
    "## Ruling",
    "- H1.2 — implementer: the test proves it",
    "- H1.3 — reviewer: the path is still open",
    "- H1.4 — nobody: not a side",
  ].join("\n");
  assert.deepEqual(parseRuling(ruling), [
    { id: "H1.2", side: "implementer", reason: "the test proves it" },
    { id: "H1.3", side: "reviewer", reason: "the path is still open" },
  ]);
  assert.deepEqual(parseRuling("## Act on\n- H1.2 — implementer: wrong section\n"), []);
});

// ---------------------------------------------------------------------------
// C5 — the policy loader now lives in size.mjs
// ---------------------------------------------------------------------------

test("C5 the policy exports come from size.mjs and still read models.json", async () => {
  const { DEFAULT_POLICY, loadPolicy, tierOrder, tierMax, requires, tierFor } = await import("../scripts/lib/size.mjs");
  const models = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));

  const policy = loadPolicy(); // defaults to the plugin's own models.json
  assert.deepEqual(policy.tiers, models.policy.tiers, "loadPolicy must read models.json, not a frozen copy");
  assert.ok(!("roles" in policy) && !("roles" in DEFAULT_POLICY), "the policy names no model per role");
  assert.deepEqual(policy.forceStandard, models.policy.forceStandard);
  assert.match(policy.hash, /^[0-9a-f]{40}$/);

  assert.deepEqual(tierOrder(policy), Object.keys(models.policy.tiers));
  assert.deepEqual(requires(policy, "small"), models.policy.tiers.small.requires);
  assert.deepEqual(requires(policy, "no-such-tier"), []);

  const { maxFiles, maxLines } = models.policy.tiers.small;
  assert.equal(tierFor(policy, { files: maxFiles, lines: maxLines }), "small");
  assert.equal(tierFor(policy, { files: maxFiles + 1, lines: maxLines }), "standard");
  assert.equal(tierFor(policy, { files: maxFiles, lines: maxLines + 1 }), "standard");
  assert.equal(tierFor(policy, { files: models.policy.tiers.standard.maxFiles + 1, lines: 0 }), "large");
  assert.equal(tierFor(policy, {}), "small");
  // a forced category lifts the answer to at least standard
  assert.equal(tierFor(policy, { files: 0, lines: 0, forced: ["ui"] }), "standard");
  assert.equal(tierFor(policy, { files: 999, lines: 0, forced: ["ui"] }), "large");

  assert.equal(tierMax(policy, "small", "large"), "large");
  assert.equal(tierMax(policy, "large", "small"), "large");
  assert.equal(tierMax(policy, "standard", "standard"), "standard");
  assert.equal(tierMax(policy, null, "small"), "small");
  assert.equal(tierMax(policy, "small", null), "small");
  assert.equal(tierMax(policy, null, null), null);

  // never throws on a missing or broken file: it falls back to the built-in policy
  const fallback = loadPolicy(path.join(pluginRoot, "no-such-models.json"));
  assert.deepEqual(fallback.tiers, DEFAULT_POLICY.tiers);
  assert.deepEqual(fallback.roles, DEFAULT_POLICY.roles);
  assert.equal(Object.isFrozen(DEFAULT_POLICY), true);
});

// ---------------------------------------------------------------------------
// C6 — the five old module paths are gone, and nothing still imports them
// ---------------------------------------------------------------------------

test("C6 the five absorbed modules no longer exist and cannot be imported", async () => {
  for (const name of REMOVED) {
    assert.equal(existsSync(path.join(libDir, name)), false, `scripts/lib/${name} should be deleted`);
    await assert.rejects(
      () => import(`../scripts/lib/${name}`),
      (e) => e.code === "ERR_MODULE_NOT_FOUND",
      `importing scripts/lib/${name} should fail`,
    );
  }
});

test("C6 no script still imports an absorbed module", () => {
  const files = [path.join(pluginRoot, "scripts", "gate.mjs"), ...readdirSync(libDir).filter((f) => f.endsWith(".mjs")).map((f) => path.join(libDir, f))];
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const name of REMOVED) {
      if (new RegExp(`["'\`]\\.[^"'\`]*/${name.replace(".", "\\.")}["'\`]`).test(text)) {
        offenders.push(`${path.relative(pluginRoot, file)} → ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
}

// ===== from tests/playbooks.test.mjs =====
{
// ---------------------------------------------------------------------------
// conventions (mirrors tests/next-hints.test.mjs and tests/tier-policy.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { session = "S1" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input: "",
    encoding: "utf8",
    env: envFor(repo, session),
  });
}

// every verb exits 0 (the gate fails open); a refusal is the `done-gate: …` line on stderr
const REFUSAL = /^done-gate: /m;

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const hintOf = (stdout) => lines(stdout).at(-1) ?? "";
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerFile = (repo, session = "S1") => path.join(runDir(repo, session), "ledger.json");
const ledgerOf = (repo, session = "S1") => JSON.parse(readFileSync(ledgerFile(repo, session), "utf8"));
const stepOf = (ledger, key) => ledger.steps.find((s) => s.key === key);

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so `--files` predictions have a baseline to measure against
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// ---------------------------------------------------------------------------
// source-of-truth anchors
//   step keys + their order → the approved plan (Team gate v0.3, T4), transcribed here
//   the playbook file       → skills/gate/playbooks.md, one `## <name>` per playbook
//   tier thresholds         → models.json (policy.tiers.small.maxFiles)
//   the "unknown playbook" name list → the five section names below
// Never ledger.mjs's or next.mjs's own tables.
// ---------------------------------------------------------------------------

const PLAYBOOK_FILE = path.join(pluginRoot, "skills", "gate", "playbooks.md");

// key lists exactly as the task states them; `null` is an unkeyed step
const EXPECTED = {
  feature: ["context", "plan", "cases", "skeptic", "tests", "implement", "verify", "driver", "schema", "review", "close"],
  bugfix: ["repro", "rootcause", "context", "plan", "cases", "tests", "implement", "verify", "driver", "schema", "review", "close"],
  refactor: ["context", "plan", "cases", "tests", "verify-before", "implement", "verify", "driver", "review", "close"],
  plan: ["context", "plan", "skeptic", "implement", "close"],
  investigation: [null, null],
};
const NAMES = Object.keys(EXPECTED);

// the keys the old 14-step feature playbook carried and this change removes
const DROPPED = ["reconcile", "cleanup", "docs"];

const POLICY = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8")).policy;

// ---------------------------------------------------------------------------
// C1 — the new step lists
// ---------------------------------------------------------------------------

test("C1 happy: `gate open` copies in the new step list for each playbook — keys in order, numbers 1..n", () => {
  assert.ok(existsSync(PLAYBOOK_FILE), `every playbook now lives in ${PLAYBOOK_FILE}`);
  const headings = readFileSync(PLAYBOOK_FILE, "utf8")
    .split("\n")
    .flatMap((l) => {
      const m = /^##\s+(.+?)\s*$/.exec(l.replace(/\r$/, ""));
      return m ? [m[1].toLowerCase()] : [];
    });
  assert.deepEqual(headings, NAMES, "one `## <playbook>` section per playbook, in order");

  for (const name of NAMES) {
    const repo = makeRepo(`playbooks-c1-${name}`);
    cli(repo, "open", [`task-${name}`, name]);
    const l = ledgerOf(repo);
    assert.equal(l.playbook, name);
    assert.deepEqual(l.steps.map((s) => s.key), EXPECTED[name], `${name}: step keys`);
    assert.equal(l.steps.length, EXPECTED[name].length, `${name}: step count`);
    assert.deepEqual(
      l.steps.map((s) => s.n),
      EXPECTED[name].map((_, i) => i + 1),
      `${name}: step numbers are 1..n`,
    );
    for (const gone of DROPPED) {
      assert.equal(stepOf(l, gone), undefined, `${name}: {${gone}} is folded away, not copied in`);
    }
  }
});

// ---------------------------------------------------------------------------
// C2 — an unknown playbook
// ---------------------------------------------------------------------------

test("C2 refused: an unknown playbook is refused by name and lists the five playbooks; no run is created", () => {
  const repo = makeRepo("playbooks-c2");
  const r = run(repo, "open", ["chore-task", "chore"]);
  assert.equal(r.status, 0, "the gate always fails open");
  assert.equal(r.stdout, "", `a refused open must print nothing on stdout:\n${r.stdout}`);
  assert.match(r.stderr, REFUSAL);
  assert.match(r.stderr, /unknown playbook "chore"/);
  for (const name of NAMES) assert.match(r.stderr, new RegExp(`\\b${name}\\b`), `${name} must be offered:\n${r.stderr}`);
  assert.equal(existsSync(path.join(stateDir(repo), "runs", `${new Date().toISOString().slice(0, 10)}-chore-task`)), false);
});

// ---------------------------------------------------------------------------
// C3 — the ledger.md template
// ---------------------------------------------------------------------------

test("C3 happy: a fresh ledger.md has exactly the Task, Context and Plan sections, with slug, playbook and opened date filled in", () => {
  const repo = makeRepo("playbooks-c3");
  cli(repo, "open", ["venue-badge", "feature"]);
  const l = ledgerOf(repo);
  const md = readFileSync(path.join(runDir(repo), "ledger.md"), "utf8");

  const sections = md.split("\n").flatMap((line) => {
    const m = /^##\s+(.+?)\s*$/.exec(line.replace(/\r$/, ""));
    return m ? [m[1]] : [];
  });
  assert.deepEqual(sections, ["Task", "Context", "Plan"]);
  assert.ok(!/\{\{|\}\}/.test(md), `every placeholder must be filled in:\n${md}`);
  assert.match(md, /venue-badge/);
  assert.match(md, /feature/);
  assert.ok(md.includes(l.openedAt.slice(0, 10)), `the opened date must be filled in:\n${md}`);
});

// ---------------------------------------------------------------------------
// C4 — the one optional step left
// ---------------------------------------------------------------------------

test("C4 edge: `note plan --files <one file>` marks only {skeptic} N/A on a feature; bugfix and refactor mark nothing", () => {
  assert.equal(POLICY.tiers.small.maxFiles, 1, "premise: one file is tier small per models.json");

  const feature = committed("playbooks-c4-feature");
  cli(feature, "open", ["badge", "feature"]);
  cli(feature, "note", ["task", "Add a badge. [inferred]"]);
  cli(feature, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  const f = ledgerOf(feature);
  assert.equal(f.tier.predicted, "small");
  assert.deepEqual(f.tier.autoNa, ["skeptic"]);
  assert.equal(stepOf(f, "skeptic").state, "N/A");
  assert.deepEqual(
    f.steps.filter((s) => s.state).map((s) => s.key),
    ["plan", "skeptic"],
    "only {plan} (just written) and {skeptic} (auto-N/A) are closed",
  );

  for (const name of ["bugfix", "refactor"]) {
    const repo = committed(`playbooks-c4-${name}`);
    cli(repo, "open", ["badge", name]);
    cli(repo, "note", ["task", "Fix the badge. [inferred]"]);
    cli(repo, "note", ["plan", "One component.", "--files", "src/a.ts"]);
    const l = ledgerOf(repo);
    assert.equal(l.tier.predicted, "small", name);
    assert.deepEqual(l.tier.autoNa, [], `${name}: nothing is auto-N/A`);
    assert.deepEqual(
      l.steps.filter((s) => s.state).map((s) => s.key),
      ["plan"],
      `${name}: only {plan} is closed`,
    );
  }
});

// ---------------------------------------------------------------------------
// C5 — the next: hints
// ---------------------------------------------------------------------------

test("C5 edge: after the case table the hint names {context}/{repro}; the {implement} hint drops reconcile; cleanup and docs have no hint", () => {
  const feature = committed("playbooks-c5-feature");
  cli(feature, "open", ["badge", "feature"]);
  cli(feature, "note", ["task", "Add a badge. [inferred]"]);
  cli(feature, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  const afterCases = hintOf(cli(feature, "case", ["add", "renders the badge", "--kind", "happy"]).stdout);
  assert.match(afterCases, /`gate note context/, `the first blank feature step is {context}:\n${afterCases}`);

  const bugfix = committed("playbooks-c5-bugfix");
  cli(bugfix, "open", ["badge", "bugfix"]);
  cli(bugfix, "note", ["task", "Badge is missing. [inferred]"]);
  cli(bugfix, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  const afterBugCases = hintOf(cli(bugfix, "case", ["add", "the badge is missing", "--kind", "reported-surface"]).stdout);
  assert.match(afterBugCases, /`gate step repro done/, `the first blank bugfix step is {repro}:\n${afterBugCases}`);

  // walk the feature run to {implement}: {skeptic} is auto-N/A at tier small
  cli(feature, "note", ["context", CONTEXT]);
  const afterQa = hintOf(cli(feature, "step", ["tests", "done", "wrote the tests, red first", "--evidence", "tests/a.test.ts"]).stdout);
  assert.equal(stepOf(ledgerOf(feature), "skeptic").state, "N/A", "premise: tier small auto-N/As {skeptic}");
  assert.match(afterQa, /`gate step implement done/, `{implement} is the next blank step:\n${afterQa}`);
  assert.ok(!/reconcile/i.test(afterQa), `the {implement} hint must not mention reconcile:\n${afterQa}`);

  // a step key with no hint of its own falls back to the step's own text and number
  for (const key of DROPPED) {
    const h = nextHint({
      status: "open",
      playbook: "feature",
      taskSeq: 1,
      planSeq: 2,
      cases: [{ id: "C1", status: "closed" }],
      steps: [{ n: 1, key, text: "an old step", state: null, note: null, evidence: null, seq: null }],
    });
    assert.match(h, /`gate step 1 done\|skipped\|na/, `{${key}} must have no hint of its own:\n${h}`);
    assert.ok(!new RegExp(`gate step ${key}\\b`).test(h), `{${key}} must have no hint of its own:\n${h}`);
  }
});

// ---------------------------------------------------------------------------
// C6 — the refactor baseline verify
// ---------------------------------------------------------------------------

test("C6 happy: `gate verify --step verify-before` still closes {verify-before} on the refactor playbook", () => {
  const repo = committed("playbooks-c6");
  cli(repo, "open", ["move-card", "refactor"]);
  const keys = ledgerOf(repo).steps.map((s) => s.key);
  assert.ok(keys.indexOf("verify-before") < keys.indexOf("implement"), `the baseline runs before the move: ${keys}`);

  const r = cli(repo, "verify", ["--step", "verify-before"]);
  assert.match(r.stdout, /step \{verify-before\} closed with verify\.json/, r.stdout);

  const l = ledgerOf(repo);
  assert.equal(stepOf(l, "verify-before").state, "DONE");
  assert.equal(stepOf(l, "verify-before").evidence, "verify.json");
  assert.equal(stepOf(l, "verify").state, null, "the post-move {verify} is untouched");
});

// ---------------------------------------------------------------------------
// C7 — a run opened under the old 14-step playbook
// ---------------------------------------------------------------------------

test("C7 boundary: a ledger written under the old 14-step feature playbook still attaches, reports and closes", () => {
  // the feature playbook as it stood before this change, keys and all
  const OLD = [
    "read", "plan", "cases", "skeptic", "tests", "implement", "reconcile",
    "verify", "driver", "schema", "cleanup", "review", "docs", "close",
  ];
  const repo = committed("playbooks-c7");
  cli(repo, "open", ["legacy-run", "feature"]);
  const ledger = ledgerOf(repo);
  ledger.steps = OLD.map((key, i) => ({
    n: i + 1, key, text: `old step ${i + 1}`, state: null, note: null, evidence: null, seq: null,
  }));
  writeFileSync(ledgerFile(repo), `${JSON.stringify(ledger, null, 2)}\n`);

  // a second session joins the run the old way
  const attached = cli(repo, "attach", ["legacy-run"], { session: "S2" });
  assert.match(attached.stdout, /ledger: /);
  assert.deepEqual(ledgerOf(repo, "S2").steps.map((s) => s.key), OLD, "attaching never rewrites the old step list");

  const report = cli(repo, "report", [], { session: "S2" });
  const stepLines = report.stdout.split("\n## ").find((s) => s.startsWith("Steps\n"));
  assert.ok(stepLines, `the report has a Steps section:\n${report.stdout}`);
  assert.equal(lines(stepLines).filter((l) => /^\d+\. /.test(l)).length, OLD.length, "all 14 old steps are reported");
  assert.ok(existsSync(path.join(runDir(repo, "S2"), "report.md")));

  cli(repo, "close", [], { session: "S2" });
  const closed = ledgerOf(repo, "S2");
  assert.equal(closed.status, "closing");
  assert.equal(stepOf(closed, "close").state, "DONE");
  assert.deepEqual(closed.steps.map((s) => s.key), OLD, "closing never rewrites the old step list");
});
}

// ===== from tests/next-hints.test.mjs =====
{
// ---------------------------------------------------------------------------
// conventions (mirrors tests/tier-policy.test.mjs and tests/helper-packets.test.mjs)
// ---------------------------------------------------------------------------

function envFor(repo, session = "S1", extra = {}) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session, ...extra };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1", extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session, extraEnv),
  });
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  return r;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const ledgerOf = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "ledger.json"), "utf8"));
const stepOf = (ledger, key) => ledger.steps.find((s) => s.key === key);
const errorLog = (repo) => path.join(stateDir(repo), "gate-error.log");

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

// makeRepo + a real HEAD, so `--files` predictions and `git diff --numstat` have a baseline.
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// ---------------------------------------------------------------------------
// source-of-truth anchors
//   step keys + their order → skills/gate/playbooks/<playbook>.md
//   helper role names       → models.json
//   the verbs that must hint → the user-facing verb list the task names
// Never the hint renderer's own tables.
// ---------------------------------------------------------------------------

function playbookKeys(playbook) {
  const all = readFileSync(path.join(pluginRoot, "skills", "gate", "playbooks.md"), "utf8");
  const m = new RegExp(`^## ${playbook}\\s*$`, "m").exec(all);
  const rest = all.slice(m.index + m[0].length);
  const end = /^## /m.exec(rest);
  const md = end ? rest.slice(0, end.index) : rest;
  return md.split("\n").flatMap((l) => {
    const m = /^\s*\d+\.\s.*\{([a-z0-9-]+)\}\s*$/.exec(l);
    return m ? [m[1]] : [];
  });
}

const ROLES = ["skeptic", "qa", "reviewer", "reviewer-2", "arbiter", "worker"]; // agents/*.md

const SKILL_MD = path.join(pluginRoot, "skills", "gate", "SKILL.md");

// The last printed line of a mutating verb is the hint.
function hintOf(stdout) {
  const l = lines(stdout);
  return l[l.length - 1] ?? "";
}

function hint(repo, verb, args = [], opts = {}) {
  const r = cli(repo, verb, args, opts);
  const h = hintOf(r.stdout);
  assert.match(h, /^next: /, `\`gate ${verb}\` did not end with a next: line:\n${r.stdout}`);
  assert.match(h, /`gate\s+[a-z][^`]*`/, `the hint carries no backticked gate verb:\n${h}`);
  return h;
}

// The step key a hint points at: `gate step <key>` directly, or `gate brief <role>` where
// the role is the step that spawning it closes.
const ROLE_STEP = { skeptic: "skeptic", qa: "qa", reviewer: "review", "reviewer-2": "review" };
function hintedKey(h) {
  const flagged = /--step ([a-z0-9-]+)/.exec(h); // e.g. `gate verify --step verify-before`
  if (flagged) return flagged[1];
  const step = /`gate step ([a-z0-9-]+)/.exec(h);
  if (step) return step[1];
  const role = /`gate brief ([a-z0-9-]+)/.exec(h);
  if (role) return ROLE_STEP[role[1]] ?? role[1];
  const verb = /`gate (verify|blast|close|decide)\b/.exec(h);
  if (verb) return { verify: "verify", blast: "blast", close: "close", decide: "driver" }[verb[1]];
  return null;
}

// An open ledger with a Task and a Plan naming `files`.
function opened(name, { playbook = "feature", planFiles = "src/a.ts", extra = {} } = {}) {
  const repo = committed(name, extra);
  cli(repo, "open", [name, playbook]);
  cli(repo, "note", ["task", "Pin the next hint. [inferred]"]);
  cli(repo, "note", ["context", CONTEXT]);
  cli(repo, "note", ["plan", "One module.", "--files", planFiles]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 happy: a fresh feature ledger hints `gate note task`, then `gate note context`, then `gate note plan --files`, then `gate case add`", () => {
  const repo = committed("next-c1");

  const afterOpen = hintOf(cli(repo, "open", ["badge", "feature"]).stdout);
  assert.match(afterOpen, /^next: /, afterOpen);
  assert.match(afterOpen, /`gate note task/, `a ledger with no Task must ask for the Task:\n${afterOpen}`);

  const afterTask = hint(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  assert.match(afterTask, /`gate note context/, `a ledger with no Context must ask for it first:\n${afterTask}`);
  const afterContext = hint(repo, "note", ["context", CONTEXT]);
  assert.match(afterContext, /`gate note plan[^`]*--files/, `a ledger with no Plan must ask for the Plan:\n${afterContext}`);

  const afterPlan = hint(repo, "note", ["plan", "Touch one component.", "--files", "src/a.ts"]);
  assert.match(afterPlan, /`gate case add/, `a tiered playbook with no cases must ask for the case table:\n${afterPlan}`);

  // premise: the Task and Plan really did land, so the hints above moved for the right reason
  const l = ledgerOf(repo);
  assert.equal(stepOf(l, "plan").state, "DONE");
  assert.equal(stepOf(l, "cases").state, null);
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 edge: after the case table the hint names `gate brief skeptic` at tier standard and the tests step at tier small", () => {
  // {skeptic} is step 4 and {tests} step 5 of the feature playbook: at tier small {skeptic}
  // is auto-N/A, so the first blank step becomes {tests}, which the lead does itself.
  const feature = playbookKeys("feature");
  assert.ok(feature.indexOf("skeptic") < feature.indexOf("tests"), feature.join(","));

  const standard = opened("next-c2-standard", { planFiles: "src/a.ts,src/app/page.tsx" });
  cli(standard, "note", ["context", CONTEXT]); // the understand-first step
  const std = hint(standard, "case", ["add", "renders the badge", "--kind", "happy"]);
  assert.equal(stepOf(ledgerOf(standard), "skeptic").state, null, "premise: {skeptic} is still blank at tier standard");
  assert.match(std, /`gate brief skeptic/, std);
  assert.ok(!/`gate step tests/.test(std), `the skeptic is still blank, so the tests step must not be hinted yet:\n${std}`);

  const small = opened("next-c2-small", { planFiles: "src/a.ts" });
  cli(small, "note", ["context", CONTEXT]); // the understand-first step
  const sml = hint(small, "case", ["add", "renders the badge", "--kind", "happy"]);
  assert.equal(stepOf(ledgerOf(small), "skeptic").state, "N/A", "premise: tier small auto-N/As {skeptic}");
  assert.match(sml, /`gate step tests done/, sml);
  assert.ok(!/skeptic/.test(sml), `a step that is already N/A must never be hinted:\n${sml}`);
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 happy: once {tests} is closed the hint moves to the next blank step; a bugfix's first step hint is {repro}", () => {
  const repo = opened("next-c3", { planFiles: "src/a.ts" }); // tier small: {skeptic} auto-N/A
  cli(repo, "note", ["context", CONTEXT]); // the understand-first step
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);

  const afterQa = hint(repo, "step", ["tests", "done", "wrote the tests, red first", "--evidence", "tests/a.test.ts"]);
  const feature = playbookKeys("feature");
  const next = feature
    .slice(feature.indexOf("tests") + 1)
    .find((k) => stepOf(ledgerOf(repo), k).state === null);
  assert.equal(next, "implement", "premise: {implement} is the next blank step after {tests} at tier small");
  assert.match(afterQa, new RegExp("`gate step " + next + "\\b"), afterQa);

  // A bug fix's playbook opens with {repro}, so that is the first step the hint names.
  const bug = opened("next-c3-bugfix", { playbook: "bugfix", planFiles: "src/a.ts" });
  const bugKeys = playbookKeys("bugfix");
  assert.equal(bugKeys[0], "repro", bugKeys.join(","));
  const afterCases = hint(bug, "case", ["add", "the reported surface still fails", "--kind", "reported-surface"]);
  assert.match(afterCases, /`gate step repro\b/, `a bug fix must be sent to the reproduction first:\n${afterCases}`);
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 boundary: open cases with every step closed hint `gate case close`, nothing left hints `gate close`, closing hints `gate check` and `gate report --brief`", () => {
  const repo = opened("next-c5", { planFiles: "src/a.ts,src/app/page.tsx" }); // standard: nothing auto-N/A
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);

  // Close every step the playbook has except {close} itself.
  const keys = playbookKeys("feature").filter((k) => !["plan", "cases", "close"].includes(k));
  let last = "";
  for (const key of keys) last = hint(repo, "step", [key, "na", "not exercised by this fixture"]);

  const l = ledgerOf(repo);
  for (const key of keys) assert.notEqual(stepOf(l, key).state, null, `${key} is still blank`);
  assert.equal(l.cases.filter((c) => c.status === "open").length, 1, "premise: one case is still open");

  assert.match(last, /`gate case close/, `an open case with every step closed must hint the case:\n${last}`);
  assert.ok(!/`gate close/.test(last), last);

  const afterCase = hint(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:renders the badge"]);
  assert.match(afterCase, /`gate close/, `with nothing left the hint must be the close:\n${afterCase}`);
  assert.ok(!/`gate case close/.test(afterCase), afterCase);

  const afterClose = hint(repo, "close");
  assert.equal(ledgerOf(repo).status, "closing", "premise: close sets status closing");
  assert.match(afterClose, /`gate check`/, afterClose);
  assert.match(afterClose, /`gate report --brief`/, afterClose);
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 happy: every mutating verb's last line is the next: hint, and `gate check` prints none", () => {
  const repo = committed("next-c6");

  // The full list of verbs the task puts a hint behind, driven in an order that keeps the
  // ledger legal. `close` is last because it ends the run.
  const drive = [
    ["open", ["next-c6", "feature"], {}],
    ["attach", ["next-c6"], { session: "S2" }],
    ["note", ["task", "Add a badge. [inferred]"], {}],
    ["note", ["plan", "One component.", "--files", "src/a.ts"], {}],
    ["case", ["add", "renders the badge", "--kind", "happy"], {}],
    ["note", ["context", CONTEXT], {}],
    ["huddle", ["add", "reviewer", "--file", "review-1.md"], {}],
    ["waive", ["driver", "chrome is disconnected, skip the phone pass"], {}],
    ["decide", ["plan", "kept the badge in the card", "one consumer", "events#3", "open"], {}],
    ["verify", [], {}],
    ["size", [], {}],
    ["brief", ["skeptic"], {}],
    ["close", [], {}],
  ];

  for (const [verb, args, opts] of drive) {
    const h = hint(repo, verb, args, opts);
    assert.match(h, /^next: \S/, `\`gate ${verb}\`: ${h}`);
  }

  const chk = cli(repo, "check");
  assert.ok(
    !lines(chk.stdout).some((l) => l.startsWith("next:")),
    `\`gate check\` must stay a pure read:\n${chk.stdout}`,
  );
});

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

test("C7 refused: `gate note task \"\"` prints to stderr and leaves no gate-error.log; __throw still writes one", () => {
  const repo = opened("next-c7", { planFiles: "src/a.ts" });
  assert.ok(!existsSync(errorLog(repo)), "premise: no gate error has been logged yet");

  const r = run(repo, "note", ["task", ""]);
  assert.equal(r.status, 0, "the dispatcher must fail open");
  assert.equal(r.stdout, "", `a usage mistake must print nothing on stdout:\n${r.stdout}`);
  assert.match(r.stderr, /empty text/i, `stderr does not name the mistake:\n${r.stderr}`);
  assert.ok(!/\n\s+at /.test(r.stderr), `a usage mistake must not print a stack:\n${r.stderr}`);
  assert.ok(!existsSync(errorLog(repo)), "a usage mistake was recorded as a plugin failure");

  // A real plugin failure still lands in the log, exactly as tests/smoke.test.mjs pins it.
  const boom = run(repo, "__throw", [], { extraEnv: { DONE_GATE_TEST: "1" } });
  assert.equal(boom.status, 0);
  assert.ok(existsSync(errorLog(repo)), "a genuine crash no longer reaches gate-error.log");
  assert.match(readFileSync(errorLog(repo), "utf8"), /__throw/);
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

test("C8 refused: an unknown playbook, an unknown brief role and a verb with no open ledger print usage and write no gate-error.log", () => {
  const unknownPlaybook = committed("next-c8-playbook");
  const p = run(unknownPlaybook, "open", ["x", "nope"]);
  assert.equal(p.status, 0);
  assert.equal(p.stdout, "", p.stdout);
  assert.match(p.stderr, /unknown playbook/i, p.stderr);
  assert.ok(!existsSync(errorLog(unknownPlaybook)), "an unknown playbook was recorded as a plugin failure");

  const badRole = opened("next-c8-role", { planFiles: "src/a.ts" });
  const b = run(badRole, "brief", ["nope"]);
  assert.equal(b.status, 0);
  assert.equal(b.stdout, "", b.stdout);
  assert.match(b.stderr, /usage/i, b.stderr);
  for (const role of ROLES) {
    assert.ok(b.stderr.includes(role), `the usage message does not list ${role}:\n${b.stderr}`);
  }
  assert.ok(!existsSync(errorLog(badRole)), "an unknown role was recorded as a plugin failure");

  const noLedger = committed("next-c8-noledger");
  const s = run(noLedger, "size");
  assert.equal(s.status, 0);
  assert.equal(s.stdout, "", s.stdout);
  assert.match(s.stderr, /no open ledger/i, s.stderr);
  assert.ok(!existsSync(errorLog(noLedger)), "a missing ledger was recorded as a plugin failure");
});

// ---------------------------------------------------------------------------
// C9
// ---------------------------------------------------------------------------

test("C9 boundary: a malformed stop payload exits 0, surfaces no usage error and logs nothing", () => {
  const garbage = "  ```json\n{not json, ``` <<<>>>  ";

  const bare = committed("next-c9-bare");
  const quiet = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({ session_id: "S1", cwd: bare, hook_event_name: "Stop", last_assistant_message: garbage }),
    encoding: "utf8",
    env: envFor(bare),
  });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout.trim(), "", `a repo with no ledger must stay silent:\n${quiet.stdout}`);
  assert.ok(!existsSync(errorLog(bare)), quiet.stderr);

  const repo = opened("next-c9", { planFiles: "src/a.ts" });
  const r = spawnSync(process.execPath, [gate, "stop"], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "Stop", last_assistant_message: garbage }),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(errorLog(repo)), "a hook verb wrote a gate error for a malformed payload");
  assert.ok(!/usage/i.test(r.stderr), `a hook verb surfaced a usage error:\n${r.stderr}`);
  if (r.stdout.trim()) JSON.parse(r.stdout); // whatever a hook prints must stay a hook envelope
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

test("C10 boundary: SKILL.md is under 4096 bytes and still carries the live rules, the verbs and the plain-words rule", () => {
  const size = statSync(SKILL_MD).size;
  assert.ok(size < 4096, `skills/gate/SKILL.md is ${size} bytes, the budget is 4096`);

  const text = readFileSync(SKILL_MD, "utf8");
  // the rule table lives in the README now; the skill names the live set in one line
  assert.match(text, /R1[–-]R10, R13, R15, R16/, "SKILL.md no longer names the live rule set");
  for (const i of [2, 4, 6]) {
    assert.match(text, new RegExp(`\\bR${i}\\b`), `SKILL.md no longer names rule R${i} where the loop needs it`);
  }
  for (const fragment of ["gate open", "gate note", "gate case", "gate brief", "gate verify", "gate report --brief"]) {
    assert.ok(text.includes(fragment), `SKILL.md no longer names \`${fragment}\``);
  }

  // The final message must be written in plain words: one sentence forbids the gate's own vocabulary.
  const sentence = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?]) /)
    .find((s) => /ledger/i.test(s) && /huddle/i.test(s));
  assert.ok(sentence, `no sentence names ledger and huddle together as forbidden words:\n${text}`);
  assert.match(sentence, /never|not |avoid|don't/i, `the forbidden-words sentence does not forbid anything:\n${sentence}`);
});

// ---------------------------------------------------------------------------
// C11
// ---------------------------------------------------------------------------

test("C11 refused: the hint never names a closed step, and never names the skeptic on a bugfix or a refactor", () => {
  for (const playbook of ["bugfix", "refactor"]) {
    const keys = playbookKeys(playbook);
    assert.ok(!keys.includes("skeptic"), `${playbook} unexpectedly has a {skeptic} step: ${keys.join(",")}`);

    const repo = opened(`next-c11-${playbook}`, { playbook, planFiles: "src/a.ts" });
    let h = hint(repo, "case", ["add", "the reported surface", "--kind", "happy"]);

    const seen = [];
    let finished = false;
    for (let i = 0; i < keys.length + 2 && !finished; i += 1) {
      assert.ok(!/skeptic/i.test(h), `${playbook} hinted the skeptic, which its playbook does not have:\n${h}`);
      const key = hintedKey(h);
      if (key === null || key === "close") {
        finished = true;
        break;
      }
      assert.equal(
        stepOf(ledgerOf(repo), key).state,
        null,
        `${playbook}: the hint names {${key}}, which is already closed:\n${h}`,
      );
      assert.ok(!seen.includes(key), `${playbook}: the hint repeated {${key}}:\n${h}`);
      seen.push(key);
      h = hint(repo, "step", [key, "na", "not exercised by this fixture"]);
    }

    // The walk really reached the end of the playbook, so the sweep above saw every hint.
    assert.ok(finished, `${playbook}: the hints never ran out after ${JSON.stringify(seen)}`);
    assert.match(h, /`gate (case )?close/, `${playbook}: the last hint is not a close:\n${h}`);
    const closedOrNa = ledgerOf(repo).steps.filter((s) => s.key !== "close" && s.state !== null);
    assert.equal(closedOrNa.length, keys.length - 1, `${playbook}: ${JSON.stringify(seen)}`);
  }
});

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

test("C12 edge: `gate attach` from a second session hints the ledger's own next step, not the Task", () => {
  const repo = committed("next-c12");
  cli(repo, "open", ["slug-c12", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["plan", "One component.", "--files", "src/a.ts"]);
  const owner = hint(repo, "case", ["add", "renders the badge", "--kind", "happy"]);

  const joined = hint(repo, "attach", ["slug-c12"], { session: "S2" });
  assert.ok(!/`gate note task/.test(joined), `attach sent the second session back to the Task:\n${joined}`);
  assert.ok(!/`gate note plan/.test(joined), `attach sent the second session back to the Plan:\n${joined}`);
  assert.equal(joined, owner, "the hint must come from the ledger, not from which session asked");
});

// ---------------------------------------------------------------------------
// C13
// ---------------------------------------------------------------------------

test("C13 refused: a verb whose stdout is closed under it exits 0 without an EPIPE stack", async () => {
  const repo = opened("next-c13", { planFiles: "src/a.ts" });

  const child = spawn(process.execPath, [gate, "size"], {
    env: envFor(repo),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end("");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  child.stdout.destroy(); // the reader hangs up before the hint is written

  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 0, `a closed stdout must not fail the verb:\n${stderr}`);
  assert.ok(!/EPIPE/.test(stderr), `EPIPE reached the user:\n${stderr}`);
  assert.ok(!/\n\s+at /.test(stderr), `a stack reached the user:\n${stderr}`);
  assert.ok(!existsSync(errorLog(repo)), "a closed stdout was recorded as a plugin failure");
});
}
