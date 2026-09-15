// T3 — the five small lib files are absorbed into their neighbours and deleted.
// Written from the requirements and from the pre-merge sources at HEAD (the spec for
// "behaviour unchanged"), never from the merged files. Every import is dynamic so a
// missing export fails only its own case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, pluginRoot } from "./helpers.mjs";

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
  assert.deepEqual(policy.roles, { ...DEFAULT_POLICY.roles, ...models.roles });
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
