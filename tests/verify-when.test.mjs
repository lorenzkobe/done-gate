// `when` on a verify command: "always" (default) or "source" (a command that only earns
// its cost when real implementation changed). Written from the case table, blind to
// config.mjs / verify.mjs / rules.mjs / report.mjs / doctor.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { evaluate, sourceHash } from "../scripts/lib/rules.mjs";

// ---------------------------------------------------------------------------
// conventions (mirrors tests/tier-policy.test.mjs)
// ---------------------------------------------------------------------------

const NODE = JSON.stringify(process.execPath);

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "", session = "S1" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], {
    input,
    encoding: "utf8",
    env: envFor(repo, session),
  });
}

function cli(repo, verb, args = [], opts = {}) {
  const r = run(repo, verb, args, opts);
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// `check` exits 0 whether or not rules are unmet; only a crash is a failure here.
function check(repo) {
  const r = run(repo, "check");
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!/GATE ERROR/.test(out), out);
  return r.stdout;
}

const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo, session = "S1") =>
  path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current);
const verifyJson = (repo) => JSON.parse(readFileSync(path.join(runDir(repo), "verify.json"), "utf8"));
const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");

// ---------------------------------------------------------------------------
// source of truth for the `when` vocabulary: gate.schema.json, the file that
// documents what a user may write, not any constant inside the implementation.
// The schema is walked generically so this stays an assertion about the
// published contract rather than about the schema's internal shape.
// ---------------------------------------------------------------------------

const schema = () => JSON.parse(readFileSync(path.join(pluginRoot, "gate.schema.json"), "utf8"));

function findWhenEnum(node) {
  if (!node || typeof node !== "object") return null;
  if (node.properties?.when?.enum) return node.properties.when.enum;
  for (const value of Object.values(node)) {
    const found = findWhenEnum(value);
    if (found) return found;
  }
  return null;
}

const WHEN = ["always", "source"]; // the case table's own words

// Two commands that both exit 0 but are told apart by the tag they echo, so a
// record can be matched to the entry that produced it without relying on order.
const tagged = (tag, code = 0) => `${NODE} -e "console.log('${tag}'); process.exit(${code})"`;
const recordFor = (v, tag) => v.commands.find((c) => c.cmd.includes(tag));

function repoWithVerify(name, verify, files = {}) {
  const repo = makeRepo(name, { ".claude/gate.json": JSON.stringify({ verify }), ...files });
  cli(repo, "open", ["t", "feature"]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 boundary: a verify entry keeps its when, a bare string and an unknown value fall back to always, and the derived build command is source", () => {
  const explicit = makeRepo("when-c1-explicit", {
    ".claude/gate.json": JSON.stringify({
      verify: [
        "npm run lint",
        { cmd: "npm run build", when: "source" },
        { cmd: "npm run test", when: "bogus" },
      ],
    }),
  });
  const cfg = loadConfig(explicit);
  assert.deepEqual(
    cfg.verify.map((v) => [v.cmd, v.when]),
    [
      ["npm run lint", "always"],
      ["npm run build", "source"],
      ["npm run test", "always"],
    ],
    "a string entry and an unknown when are both always; an explicit source survives",
  );

  // derived from package.json scripts, with no gate.json at all
  const derived = makeRepo("when-c1-derived", {
    // no gate.json at all, so the verify list is derived from package.json scripts
    "package.json": JSON.stringify({
      name: "when-c1-derived",
      scripts: { lint: "true", typecheck: "true", test: "true", build: "true" },
    }),
  });
  const derivedCfg = loadConfig(derived);
  const whenOf = Object.fromEntries(derivedCfg.verify.map((v) => [v.cmd, v.when]));
  assert.equal(whenOf["npm run build"], "source", `build should default to source: ${JSON.stringify(whenOf)}`);
  for (const script of ["lint", "typecheck", "test"]) {
    assert.equal(whenOf[`npm run ${script}`], "always", `${script} should default to always: ${JSON.stringify(whenOf)}`);
  }

  // every value the config hands out is one the schema documents
  assert.deepEqual(findWhenEnum(schema()), WHEN, "gate.schema.json must document the when vocabulary");
  for (const v of [...cfg.verify, ...derivedCfg.verify]) assert.ok(WHEN.includes(v.when), `${v.cmd} → ${v.when}`);
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

test("C2 happy: a test-only change skips the source-only command with a reason and 0 ms, prints it as skipped, and still closes {verify}", () => {
  const repo = repoWithVerify("when-c2", [
    { cmd: tagged("ALWAYS-RAN"), when: "always" },
    { cmd: tagged("SOURCE-RAN"), when: "source" },
  ]);
  write(repo, "tests/a.test.ts", "test('a', () => { /* changed */ });\n");

  const r = cli(repo, "verify");
  const v = verifyJson(repo);
  assert.equal(v.commands.length, 2);

  const always = recordFor(v, "ALWAYS-RAN");
  assert.equal(always.exit, 0, "the always command still runs");
  assert.match(always.tail, /ALWAYS-RAN/);

  const skipped = v.commands[1];
  assert.ok(skipped.cmd.includes("SOURCE-RAN"), "commands[1] is the source-only entry");
  assert.equal(typeof skipped.skipped, "string", `commands[1].skipped should be a reason string: ${JSON.stringify(skipped)}`);
  assert.ok(skipped.skipped.length > 0, "the skip reason is not empty");
  assert.equal(skipped.ms, 0, "a skipped command costs no time");
  assert.ok(!/SOURCE-RAN/.test(skipped.tail ?? ""), "the skipped command produced no output");

  assert.match(r.stdout, /skipped/, `gate verify should say the command was skipped:\n${r.stdout}`);
  assert.equal(loadLedger(runDir(repo)).steps.find((s) => s.key === "verify").state, "DONE");
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 happy: with a non-test source change the source-only command runs and records an exit code as before", () => {
  const repo = repoWithVerify("when-c3", [
    { cmd: tagged("ALWAYS-RAN"), when: "always" },
    { cmd: tagged("SOURCE-RAN"), when: "source" },
  ]);
  write(repo, "tests/a.test.ts", "test('a', () => { /* changed */ });\n");
  write(repo, "src/a.ts", "export const a = 2;\n");

  cli(repo, "verify");
  const ran = verifyJson(repo).commands[1];
  assert.ok(ran.cmd.includes("SOURCE-RAN"), "commands[1] is the source-only entry");
  assert.equal(ran.skipped, undefined, `a run command carries no skipped key: ${JSON.stringify(ran)}`);
  assert.equal(ran.exit, 0);
  assert.match(ran.tail, /SOURCE-RAN/);
  assert.equal(ran.timedOut, false);
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

test("C4 boundary: R3 counts a skipped entry as green, and still fires stale after a further source edit", () => {
  const cfg = loadConfig(makeRepo("when-c4-cfg"));
  const ledger = { status: "open", steps: [], waivers: [], cases: [] };
  const now = { hash: "h1", files: { "src/a.ts": { h: "1" }, "tests/a.test.ts": { h: "2" } } };
  const changed = ["src/a.ts", "tests/a.test.ts"];
  const state = (over = {}) => ({
    config: cfg,
    ledger,
    changed,
    now,
    verify: null,
    events: [],
    reviews: [],
    lastMessage: "",
    ...over,
  });
  const unmet = (over) => evaluate(state(over));
  const ids = (over) => unmet(over).map((u) => u.rule);

  const verify = {
    sourceHash: sourceHash(now, cfg),
    commands: [
      { cmd: "npm run build", skipped: "no implementation change (tests or docs only)", ms: 0 },
      { cmd: "npm run test", exit: 0, timedOut: false },
    ],
  };
  assert.ok(!ids({ verify }).includes("R3"), `a skip beside a green command is not red: ${JSON.stringify(ids({ verify }))}`);

  // a further source edit moves the source hash on: the same verify.json is now stale
  const later = { hash: "h2", files: { ...now.files, "src/a.ts": { h: "edited-again" } } };
  const staleIds = ids({ verify, now: later });
  assert.ok(staleIds.includes("R3"), `R3 should fire on a stale verify: ${JSON.stringify(staleIds)}`);
  assert.match(unmet({ verify, now: later }).find((u) => u.rule === "R3").text, /stale/i);
});

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

test("C5 happy: the full report prints the skipped command with its reason and the brief's checks line says skipped (test-only change) beside the green ones", () => {
  // The brief names a check after the tool in its command text (tests/brief-report.test.mjs
  // C16 owns that mapping), so the commands read as a lint and a build.
  const repo = repoWithVerify("when-c5", [
    { cmd: `${NODE} -e "process.exit(0)" # npm run lint`, when: "always" },
    { cmd: `${NODE} -e "process.exit(0)" # npm run build`, when: "source" },
  ]);
  write(repo, "tests/a.test.ts", "test('a', () => { /* changed */ });\n");
  cli(repo, "verify");

  const full = cli(repo, "report").stdout;
  const reported = lines(full).find((l) => l.includes("npm run build") && /skipped:/.test(l));
  assert.ok(reported, `the full report should print the skipped command with "skipped:":\n${full}`);

  const brief = cli(repo, "report", ["--brief"]).stdout;
  const checks = lines(brief).find((l) => l.includes("skipped (test-only change)"));
  assert.ok(checks, `the brief should say "skipped (test-only change)":\n${brief}`);
  assert.match(checks, /build/i, `the skipped check is named: ${JSON.stringify(checks)}`);
  assert.match(checks, /green/i, `the green checks sit on the same line: ${JSON.stringify(checks)}`);
});

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test("C6 boundary: a docs-only change skips the source-only command and still runs the always one", () => {
  const repo = repoWithVerify("when-c6", [
    { cmd: tagged("ALWAYS-RAN"), when: "always" },
    { cmd: tagged("SOURCE-RAN"), when: "source" },
  ]);
  write(repo, "docs/notes.md", "# notes\n\nchanged\n");

  cli(repo, "verify");
  const v = verifyJson(repo);
  assert.equal(recordFor(v, "ALWAYS-RAN").exit, 0);
  assert.equal(typeof recordFor(v, "SOURCE-RAN").skipped, "string", JSON.stringify(v.commands));
  assert.equal(recordFor(v, "SOURCE-RAN").ms, 0);
});

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

test("C7 idempotent: two verify runs on the same tree record the same commands, skips and source hash", () => {
  const repo = repoWithVerify("when-c7", [
    { cmd: tagged("ALWAYS-RAN"), when: "always" },
    { cmd: tagged("SOURCE-RAN"), when: "source" },
  ]);
  write(repo, "tests/a.test.ts", "test('a', () => { /* changed */ });\n");

  // everything that is allowed to differ between two runs of the same tree
  const VOLATILE = new Set(["ms", "at", "ts", "startedAt", "finishedAt", "timestamp", "durationMs"]);
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !VOLATILE.has(k))
          .map(([k, v]) => [k, stable(v)]),
      );
    }
    return value;
  };

  cli(repo, "verify");
  const first = verifyJson(repo);
  cli(repo, "verify");
  const second = verifyJson(repo);

  assert.deepEqual(stable(second), stable(first), "verify is idempotent once timings are removed");
  assert.equal(second.sourceHash, first.sourceHash);
  assert.equal(typeof second.commands[1].skipped, "string", "the skip survives the second run");
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

test("C8 happy: gate.schema.json documents when on a verify entry, and gate doctor marks the source-only command", () => {
  assert.deepEqual(
    findWhenEnum(schema()),
    WHEN,
    "the verify item schema must allow when with exactly the two documented values",
  );

  // no gate.json: the derived commands, where build is the source-only one
  const repo = makeRepo("when-c8", {
    "package.json": JSON.stringify({
      name: "when-c8",
      scripts: { lint: "true", test: "true", build: "true" },
    }),
  });
  const out = cli(repo, "doctor").stdout;
  const verifyLine = lines(out).find((l) => l.trim().startsWith("verify:"));
  assert.ok(verifyLine, `doctor should list the verify commands:\n${out}`);
  const segments = verifyLine.slice(verifyLine.indexOf(":") + 1).split("·").map((s) => s.trim());

  const segmentFor = (script) => segments.find((s) => s.startsWith(`npm run ${script}`));
  assert.match(segmentFor("build"), /when source/, `build is the source-only command: ${JSON.stringify(segments)}`);
  for (const script of ["lint", "test"]) {
    assert.ok(!/when source/.test(segmentFor(script)), `${script} is always: ${JSON.stringify(segmentFor(script))}`);
  }

  // the spec's literal marker: "(when source)" after the command
  assert.ok(
    out.includes("(when source)"),
    `gate doctor should print "(when source)" after a source-only command; it printed ${JSON.stringify(segmentFor("build"))}`,
  );
});

// ---------------------------------------------------------------------------
// C10
// ---------------------------------------------------------------------------

test("C10 refused: a red always command still blocks R3 even though the source-only command was skipped", () => {
  const repo = repoWithVerify("when-c10", [
    { cmd: tagged("ALWAYS-RED", 1), when: "always" },
    { cmd: tagged("SOURCE-RAN"), when: "source" },
  ]);
  write(repo, "tests/a.test.ts", "test('a', () => { /* changed */ });\n");
  cli(repo, "verify");

  const v = verifyJson(repo);
  assert.equal(recordFor(v, "ALWAYS-RED").exit, 1);
  assert.equal(typeof recordFor(v, "SOURCE-RAN").skipped, "string", JSON.stringify(v.commands));

  const out = check(repo);
  assert.match(out, /R3/, `a red always command must still block R3:\n${out}`);
  assert.ok(existsSync(path.join(runDir(repo), "verify.json")));
});

// ---------------------------------------------------------------------------
// C12
// ---------------------------------------------------------------------------

test("C12 refused: R13 covers gate.json's text plus the resolved verify command list — a gate.json edit and a script change that moves the list both block, a version bump does not", () => {
  // Separate repos rather than one mutated in place, so a per-root cache inside
  // loadConfig cannot make a stale hash look stable.
  const pkg = (name, scripts, extra = {}) => JSON.stringify({ name, scripts, ...extra });
  const derivedRepo = (name, scripts, extra = {}) => makeRepo(name, { "package.json": pkg(name, scripts, extra) });
  const cmdsOf = (cfg) => cfg.verify.map((v) => v.cmd);

  // (d) the resolved command list, not the rest of package.json, is what the hash sees
  const full = { lint: "true", test: "true", build: "true" };
  const plain = loadConfig(derivedRepo("when-c12-d1", full));
  const bumped = loadConfig(derivedRepo("when-c12-d2", full, { version: "9.9.9" }));
  assert.deepEqual(cmdsOf(bumped), cmdsOf(plain), "the same scripts resolve to the same command list");
  assert.equal(bumped.hash, plain.hash, "package.json fields outside the command list do not move the hash");

  // …and a list that really changed does move it
  const fewer = loadConfig(derivedRepo("when-c12-d3", { lint: "true", test: "true" }));
  assert.notDeepEqual(cmdsOf(fewer), cmdsOf(plain), "dropping a script really did change the list");
  assert.notEqual(fewer.hash, plain.hash, "a changed command list moves the hash");

  // gate.json's own text counts too: the same command list written with different entry
  // shapes is a different config, so a when/timeout-only edit mid-task is still R13.
  const asStrings = makeRepo("when-c12-d4", {
    ".claude/gate.json": JSON.stringify({ verify: ["npm run lint", "npm run build"] }),
  });
  const asObjects = makeRepo("when-c12-d5", {
    ".claude/gate.json": JSON.stringify({
      verify: [{ cmd: "npm run lint" }, { cmd: "npm run build", when: "source", timeout: 900 }],
    }),
  });
  assert.deepEqual(cmdsOf(loadConfig(asObjects)), cmdsOf(loadConfig(asStrings)), "same commands, different shapes");
  assert.notEqual(
    loadConfig(asObjects).hash,
    loadConfig(asStrings).hash,
    "gate.json's text is part of the hash, so when/timeout edits are visible to R13",
  );

  // ---- through the CLI ----------------------------------------------------

  // (a) rewriting gate.json mid-task
  const edited = repoWithVerify("when-c12-a", [tagged("ALWAYS-RAN")]);
  write(edited, ".claude/gate.json", JSON.stringify({ verify: [tagged("SOMETHING-ELSE")] }));
  const gateEdit = check(edited);
  assert.match(gateEdit, /R13/, `editing .claude/gate.json mid-task must block:\n${gateEdit}`);

  // (b) a package.json script that moves the derived verify list, in both directions
  const removed = derivedRepo("when-c12-b1", full);
  cli(removed, "open", ["t", "feature"]);
  write(removed, "package.json", pkg("when-c12-b1", { lint: "true", build: "true" })); // test dropped
  const afterRemove = check(removed);
  assert.match(afterRemove, /R13/, `dropping the test script must not go unnoticed:\n${afterRemove}`);

  const added = derivedRepo("when-c12-b2", { lint: "true", test: "true" });
  cli(added, "open", ["t", "feature"]);
  write(added, "package.json", pkg("when-c12-b2", full)); // build added
  const afterAdd = check(added);
  assert.match(afterAdd, /R13/, `adding a build script changes what verify runs:\n${afterAdd}`);

  // (c) a package.json change that leaves the verify list alone
  const untouched = derivedRepo("when-c12-c", full);
  cli(untouched, "open", ["t", "feature"]);
  write(untouched, "package.json", pkg("when-c12-c", full, { version: "9.9.9" }));
  const afterBump = check(untouched);
  assert.ok(!/R13\b/.test(afterBump), `a version bump leaves the verify list alone:\n${afterBump}`);
});
