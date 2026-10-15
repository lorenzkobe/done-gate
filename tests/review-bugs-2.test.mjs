import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot, here } from "./helpers.mjs";
import { loadLedger, saveLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { decide } from "../scripts/lib/guard.mjs";

// The second batch of bugs from the 0.16.0 review (items 2.3, 2.4, 2.7 and the draft-first
// and git-checkout points of 2.10). One test per case of the run's case table.

const REFUSAL = /^done-gate: /m;
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerOf = (repo) => loadLedger(runDir(repo));

function run(repo, verb, args = [], { input = "" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" },
  });
}
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, `gate ${verb} ${args.join(" ")}\n${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}
function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.notEqual(r.status, 0, `gate ${verb} ${args.join(" ")} was not refused:\n${r.stdout}`);
  assert.match(r.stderr, REFUSAL);
  return r;
}
function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
const r10 = (repo) => cli(repo, "check").stdout.split("\n").filter((l) => /^\d+\. R10 — /.test(l)).join("\n");

// ---- the slop waiver ----

function slopRun(name) {
  const repo = committed(name);
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/a.ts", "// helpers\nexport const a = 1;\n");
  assert.match(r10(repo), /slop: 1 slop line/, "premise: the label is slop");
  return repo;
}

test("C1 reported-surface: after `gate waive slop`, a slop line added later is flagged again and the waived one is not", () => {
  const repo = slopRun("rb2-c1");
  const waive = cli(repo, "waive", ["slop", "user: the label names a real module"]).stdout;
  assert.match(waive, /1 slop line/, waive);
  assert.equal(r10(repo), "", "the waived line is still flagged");
  write(repo, "src/a.ts", "// helpers\nexport const a = 1;\n// constants\nexport const b = 2;\n");
  const out = r10(repo);
  assert.match(out, /slop: 1 slop line/, out);
  assert.match(out, /constants/, out);
  assert.doesNotMatch(out, /helpers/, out);
});

test("C2 refused: `gate waive slop` with no slop line in the diff is refused and stores nothing", () => {
  const repo = committed("rb2-c2");
  cli(repo, "open", ["t", "feature"]);
  const r = refused(repo, "waive", ["slop", "nothing to waive"]);
  assert.match(r.stderr, /slop/, r.stderr);
  assert.deepEqual(ledgerOf(repo).waivers, []);
});

test("C3 idempotent: a slop waiver from before this change (no list) still covers the whole run", () => {
  const repo = slopRun("rb2-c3");
  const ledger = ledgerOf(repo);
  ledger.waivers.push({ key: "slop", reason: "an older waiver", seq: 1 });
  saveLedger(runDir(repo), ledger);
  write(repo, "src/a.ts", "// helpers\nexport const a = 1;\n// constants\nexport const b = 2;\n");
  assert.equal(r10(repo), "");
});

test("C4 edge: a waived slop line that moves to another line number stays waived", () => {
  const repo = slopRun("rb2-c4");
  cli(repo, "waive", ["slop", "user: the label names a real module"]);
  write(repo, "src/a.ts", "export const z = 0;\nexport const y = 0;\n// helpers\nexport const a = 1;\n");
  assert.equal(r10(repo), "");
});

test("C5 happy: the claude-md-budget and migration-number texts say they have no waiver", () => {
  const repo = committed("rb2-c5", {
    "CLAUDE.md": "Next number: `0001`\n",
    "supabase/migrations/0001_a.sql": "select 1;\n",
    ".claude/gate.json": JSON.stringify({ checks: ["claude-md-budget", "migration-number"], source: ["src/**", "supabase/**", "CLAUDE.md"] }),
  });
  cli(repo, "open", ["t", "feature"]);
  write(repo, "supabase/migrations/0002_b.sql", "select 2;\n");
  write(repo, "CLAUDE.md", `Next number: \`0001\`\n${"x".repeat(150_001)}\n`);
  const out = r10(repo);
  assert.match(out, /claude-md-budget: [^\n]*no waiver/, out);
  assert.match(out, /migration-number: [^\n]*no waiver/, out);
});

// ---- the quick size measure ----

const pyFunctions = (n) => Array.from({ length: n }, (_, i) => `def f${i}():\n    return ${i}\n`).join("");
const pyInClass = (n) => `class C:\n${Array.from({ length: n }, (_, i) => `    def f${i}():\n        return ${i}\n`).join("")}`;
function editHook(repo, rel) {
  const r = run(repo, "log", [], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) }, tool_output: "ok" }) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim() || "null");
}

test("C6 reported-surface: the edit hook warns when a python re-indent crosses into large, the size `gate size` measures", () => {
  const repo = committed("rb2-c6", { "app/m.py": pyFunctions(250) });
  cli(repo, "open", ["t", "feature"]);
  write(repo, "app/m.py", pyInClass(250));
  const warned = editHook(repo, "app/m.py");
  assert.match(warned?.hookSpecificOutput?.additionalContext ?? "", /size large/, JSON.stringify(warned));
  assert.match(cli(repo, "size").stdout, /^tier: large/m);
});

test("C7 boundary: a whitespace-only change to a .ts file still measures zero lines in the quick measure", () => {
  const ts = Array.from({ length: 450 }, (_, i) => `export const a${i} = ${i};`).join("\n") + "\n";
  const repo = committed("rb2-c7", { "src/big.ts": ts });
  cli(repo, "open", ["t", "feature"]);
  write(repo, "src/big.ts", ts.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n"));
  const out = editHook(repo, "src/big.ts");
  assert.equal(out?.hookSpecificOutput, undefined, `a re-indent of a .ts file warned: ${JSON.stringify(out)}`);
});

// ---- a sibling repo with no gate.json ----

function siblingRun(name, otherFiles = {}) {
  const repo = committed(name, { ".claude/gate.json": JSON.stringify({ source: ["src/**"], tests: ["tests/**"] }) });
  const other = path.join(here, ".tmp", `${name}-front`);
  makeRepo(`${name}-front`, otherFiles);
  execFileSync("git", ["add", "-A"], { cwd: other });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: other });
  cli(repo, "open", ["t", "feature", "--repo", `../${name}-front`]);
  return { repo, other, p: `../${name}-front` };
}

test("C8 reported-surface: a sibling repo with no gate.json classes src/__tests__/y.test.js as a test, not source", () => {
  const { repo, p } = siblingRun("rb2-c8");
  const config = loadConfig(repo, ledgerOf(repo).repos);
  assert.equal(config.isTest(`${p}/src/__tests__/y.test.js`), true);
  assert.equal(config.isTest(`${p}/src/lib/z.spec.ts`), true);
  assert.equal(config.isTest(`${p}/src/lib/z.ts`), false);
  assert.equal(config.isSource(`${p}/src/lib/z.ts`), true);
});

test("C9 happy: test_x.py and x_test.go count as tests by default, and a sibling's packet lists the default test globs", () => {
  const plain = loadConfig(committed("rb2-c9-plain"));
  for (const p of ["app/test_orders.py", "app/orders_test.py", "pkg/orders_test.go"]) assert.equal(plain.isTest(p), true, p);
  assert.equal(plain.isTest("app/testing_utils.py"), false);

  const { repo, p } = siblingRun("rb2-c9");
  const packet = readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", ["qa"]).stdout)[1], "utf8");
  assert.ok(packet.includes(`${p}/**/*.{test,spec}.*`), `the packet does not list the sibling's default test globs:\n${packet}`);
});

test("C10 edge: a sibling repo with its own gate.json keeps its own test globs only", () => {
  const { repo, p } = siblingRun("rb2-c10", { ".claude/gate.json": JSON.stringify({ tests: ["spec/**"] }) });
  const config = loadConfig(repo, ledgerOf(repo).repos);
  assert.equal(config.isTest(`${p}/spec/a.js`), true);
  assert.equal(config.isTest(`${p}/src/__tests__/y.test.js`), false, "an explicit config is the whole truth for its repo");
});

// ---- the draft-first fence ----

test("C11 reported-surface: the fence runs on Grep and Glob, and a reading helper that owes its draft is refused there until it writes it", () => {
  const hooks = JSON.parse(readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const matcher = new RegExp(`^(?:${hooks.hooks.PreToolUse[0].matcher})$`);
  for (const tool of ["Grep", "Glob", "Read", "Bash", "Edit"]) assert.ok(matcher.test(tool), `the fence does not see ${tool}`);

  const repo = makeRepo("rb2-c11");
  const currentRun = ".claude/gate/runs/2026-10-15-t";
  mkdirSync(path.join(repo, currentRun), { recursive: true });
  writeFileSync(path.join(repo, currentRun, "brief-skeptic-1.md"), "# packet\n");
  const skeptic = (tool_name, tool_input) => decide({ tool_name, tool_input, agent_type: "done-gate:skeptic", agent_id: "sk1" }, repo, null, currentRun);
  for (const [tool, input] of [["Grep", { pattern: "x", path: path.join(repo, "src") }], ["Glob", { pattern: "**/*.ts" }]]) {
    const d = skeptic(tool, input);
    assert.equal(d.deny, true, `${tool} before the draft was allowed`);
    assert.match(d.reason, /write your draft first/);
  }
  writeFileSync(path.join(repo, currentRun, "skeptic-1.md"), "# Skeptic 1\n\n## Act on\n- unverified\n");
  assert.equal(skeptic("Grep", { pattern: "x" }).deny, false, "Grep after the draft was refused");
});

test("C12 happy: the lead's Grep and Glob pass the fence", () => {
  const repo = makeRepo("rb2-c12");
  const currentRun = ".claude/gate/runs/2026-10-15-t";
  mkdirSync(path.join(repo, currentRun), { recursive: true });
  writeFileSync(path.join(repo, currentRun, "brief-skeptic-1.md"), "# packet\n");
  assert.equal(decide({ tool_name: "Grep", tool_input: { pattern: "x" } }, repo, null, currentRun).deny, false);
  assert.equal(decide({ tool_name: "Glob", tool_input: { pattern: "**/*" } }, repo, null, currentRun).deny, false);

  // through the hook: the lead's Grep passes; a skeptic that owes its draft is refused
  const live = committed("rb2-c12-hook");
  cli(live, "open", ["t", "feature"]);
  cli(live, "brief", ["skeptic"]);
  const fence = (extra) => run(live, "fence", [], { input: JSON.stringify({ session_id: "S1", cwd: live, hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x" }, ...extra }) }).stdout;
  assert.equal(fence({}).trim(), "");
  assert.match(fence({ agent_type: "done-gate:skeptic", agent_id: "sk1" }), /write your draft first/);
});

test("C13 happy: the reviewer, reviewer-2, skeptic and arbiter prompts say write the draft first, then search before grep", () => {
  for (const role of ["reviewer", "reviewer-2", "skeptic", "arbiter"]) {
    const md = readFileSync(path.join(pluginRoot, "agents", `${role}.md`), "utf8");
    assert.doesNotMatch(md, /First, before grep, search/, `${role}.md still says search first`);
    assert.match(md, /[Aa]fter (?:your|the) draft, before grep, search/, `${role}.md does not order draft, then search`);
    const draft = md.search(/write your draft first|first tool call is Write/i);
    const search = md.search(/before grep, search/);
    assert.ok(draft >= 0 && draft < search, `${role}.md does not put the draft before the search`);
  }
});

// ---- tests that need a git checkout ----

test("C14 edge: the two git-dependent tests skip outside a git checkout's top and still run at it", () => {
  for (const file of ["multi-repo.test.mjs", "packets.test.mjs"]) {
    assert.match(readFileSync(path.join(here, file), "utf8"), /AT_GIT_TOPLEVEL/, `${file} does not guard its git-only check`);
  }
  const flag = (dir) => execFileSync(process.execPath, ["--input-type=module", "-e", `import { AT_GIT_TOPLEVEL } from ${JSON.stringify(path.join(dir, "tests", "helpers.mjs"))}; process.stdout.write(String(AT_GIT_TOPLEVEL));`], { encoding: "utf8" });
  assert.equal(flag(pluginRoot), "true", "this checkout's top reads as not a checkout");
  // a copy below a checkout's top, as a marketplace clone installs it
  const copy = path.join(here, ".tmp", "rb2-c14", "plugin");
  mkdirSync(path.join(copy, "tests"), { recursive: true });
  writeFileSync(path.join(copy, "tests", "helpers.mjs"), readFileSync(path.join(here, "helpers.mjs"), "utf8"));
  assert.equal(flag(copy), "false", "a copy below the top reads as the top");
});

test("C15 edge: a second identical slop line added after the waiver is flagged; the waiver counts each line once", () => {
  const repo = slopRun("rb2-c15");
  cli(repo, "waive", ["slop", "user: the label names a real module"]);
  write(repo, "src/a.ts", "// helpers\nexport const a = 1;\n// helpers\nexport const b = 2;\n");
  assert.match(r10(repo), /slop: 1 slop line/, r10(repo));
});

test("C16 edge: a slop waiver in a run with a sibling repo covers the sibling's line by its prefixed path", () => {
  const { repo, other, p } = siblingRun("rb2-c16");
  write(other, "src/b.ts", "// helpers\nexport const b = 1;\n");
  assert.match(r10(repo), new RegExp(`${p.replace(/[.]/g, "\\.")}/src/b\\.ts`), "premise: the sibling's slop line is flagged");
  cli(repo, "waive", ["slop", "user: the label names a real module"]);
  assert.equal(r10(repo), "");
  write(other, "src/b.ts", "// helpers\nexport const b = 1;\n// constants\nexport const c = 2;\n");
  assert.match(r10(repo), /constants/);
});

test("C17 happy: the packet's Lookups section tells a reading helper to search after its draft, before grep", () => {
  const repo = committed("rb2-c17");
  cli(repo, "open", ["t", "feature"]);
  const packet = readFileSync(/^packet: (.+)$/m.exec(cli(repo, "brief", ["skeptic"]).stdout)[1], "utf8");
  const lookups = packet.slice(packet.indexOf("## Lookups"));
  assert.match(lookups, /after your draft/i, lookups);
  assert.doesNotMatch(lookups, /search it first/, lookups);
});

test("C18 edge: a second slop waiver stores only the newly flagged line, and one with nothing new is refused", () => {
  const repo = slopRun("rb2-c18");
  cli(repo, "waive", ["slop", "user: the label names a real module"]);
  write(repo, "src/a.ts", "// helpers\nexport const a = 1;\n// constants\nexport const b = 2;\n");
  assert.match(cli(repo, "waive", ["slop", "user: same for constants"]).stdout, /the 1 slop line flagged now/);
  assert.deepEqual(ledgerOf(repo).waivers.map((w) => w.lines.length), [1, 1]);
  refused(repo, "waive", ["slop", "again"]);
  write(repo, "src/a.ts", "// helpers\nexport const a = 1;\n// constants\nexport const b = 2;\n// helpers\nexport const c = 3;\n");
  assert.match(r10(repo), /slop: 1 slop line/, r10(repo));
});
