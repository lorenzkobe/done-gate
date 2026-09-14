import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchGlob, matchAny } from "../scripts/lib/glob.mjs";
import { toPosixRel } from "../scripts/lib/paths.mjs";
import { loadConfig, DEFAULTS } from "../scripts/lib/config.mjs";

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
  // `when` is part of every normalised entry. A hand-written gate.json entry is "always"
  // unless it says otherwise — the "source" default belongs to the build command *derived*
  // from package.json scripts, not to the words "npm run build" (verify-when.test.mjs C1).
  assert.deepEqual(cfg.verify, [
    { cmd: "npm run lint", timeout: DEFAULTS.verifyTimeout, when: "always" },
    { cmd: "npm run test", timeout: 900, when: "always" },
    { cmd: "npm run build", timeout: DEFAULTS.verifyTimeout, when: "always" },
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
