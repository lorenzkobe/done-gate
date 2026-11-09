// A green verify works out the driver and schema steps when the run's changes cannot reach them,
// and a later edit takes that back. A run opened before the stamp keeps today's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gate, lookedUp, makeRepo, write, waiveArgs } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { readEvents } from "../scripts/lib/events.mjs";
import { newRules } from "../scripts/lib/rules.mjs";

function envFor(repo) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}
const run = (repo, verb, args = []) => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo) });
function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const runDir = (repo) => {
  const stateDir = path.join(repo, ".claude", "gate");
  return path.join(stateDir, "runs", loadSession(stateDir, "S1").current);
};
const ledgerPath = (repo) => path.join(runDir(repo), "ledger.json");
const ledgerOf = (repo) => JSON.parse(readFileSync(ledgerPath(repo), "utf8"));
const stepOf = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key);

function hook(repo, payload) {
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }), encoding: "utf8", env: envFor(repo) });
}
function edit(repo, rel, content) {
  write(repo, rel, content);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) } });
}

const DECLARED = { testFiles: null, source: ["src/**", "app/**", "db/**"], tests: ["tests/**", "**/*.test.tsx"], ui: ["src/**/*.tsx"], api: ["app/api/**"], schema: ["db/**"], verify: ["true"] };

function opened(name, config = DECLARED, playbook = "feature", files = {}) {
  const repo = makeRepo(name, {
    ".claude/gate.json": JSON.stringify(config, null, 2),
    "src/server.ts": "export const s = 1;\n",
    "app/api/users/route.ts": "export const GET = 1;\n",
    "db/001.sql": "select 1;\n",
    "src/app/page.test.tsx": "test('p', () => {});\n",
    ...files,
  });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  cli(repo, "open", [name, playbook]);
  lookedUp(repo);
  cli(repo, "note", ["task", "Add checkout. [inferred]"]);
  return repo;
}
// A run from before the stamp: the marker taken back out of its ledger.
function aged(repo) {
  const ledger = ledgerOf(repo);
  delete ledger.rules;
  writeFileSync(ledgerPath(repo), JSON.stringify(ledger, null, 2));
}
const closedAuto = (repo, key) => {
  const step = stepOf(repo, key);
  assert.equal(step.state, "N/A", `${key} stayed ${step.state}`);
  assert.ok(typeof step.auto === "string" && step.auto.length > 0, `${key} has no auto mark`);
};
const stillOpen = (repo, key) => {
  const step = stepOf(repo, key);
  assert.equal(step.state, null, `${key} is ${step.state}: ${step.note}`);
  assert.equal(step.auto, undefined);
};

test("C1 a new run carries the stamp; a ledger with it removed still checks as an old run", () => {
  const repo = opened("wo-c1");
  assert.equal(ledgerOf(repo).rules, 2);
  assert.equal(newRules(ledgerOf(repo)), true);
  aged(repo);
  assert.equal(newRules(ledgerOf(repo)), false);
  assert.equal(newRules(null), false);
  assert.equal(run(repo, "check").status, 0);
});

test("C2 a server-only change with every glob declared closes driver and schema on a green verify", () => {
  const repo = opened("wo-c2");
  edit(repo, "src/server.ts", "export const s = 2;\n");
  cli(repo, "verify");
  closedAuto(repo, "driver");
  closedAuto(repo, "schema");
  assert.equal(stepOf(repo, "verify").state, "DONE");
  assert.match(stepOf(repo, "driver").note, /worked out/);
});

test("C3 a later implementation edit blanks both, a test edit does not, the next green verify closes them again", () => {
  const repo = opened("wo-c3");
  edit(repo, "src/server.ts", "export const s = 2;\n");
  cli(repo, "verify");
  edit(repo, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(repo, "check");
  closedAuto(repo, "driver");
  closedAuto(repo, "schema");
  edit(repo, "src/server.ts", "export const s = 3;\n");
  cli(repo, "check");
  stillOpen(repo, "driver");
  stillOpen(repo, "schema");
  cli(repo, "verify");
  closedAuto(repo, "driver");
  closedAuto(repo, "schema");
});

test("C4 a UI or api file changed keeps driver open; a schema file changed keeps schema open", () => {
  const ui = opened("wo-c4-ui");
  edit(ui, "src/app/page.tsx", "export default () => 1;\n");
  cli(ui, "verify");
  stillOpen(ui, "driver");
  closedAuto(ui, "schema");

  const api = opened("wo-c4-api");
  edit(api, "app/api/users/route.ts", "export const GET = 2;\n");
  cli(api, "verify");
  stillOpen(api, "driver");
  closedAuto(api, "schema");

  const schema = opened("wo-c4-schema");
  edit(schema, "db/001.sql", "select 2;\n");
  cli(schema, "verify");
  closedAuto(schema, "driver");
  stillOpen(schema, "schema");
});

test("C5 an undeclared glob stays open: ui without api, no schema key, no keys at all", () => {
  const { api: _api, schema: _schema, ...uiOnly } = DECLARED;
  const partial = opened("wo-c5-partial", uiOnly);
  edit(partial, "src/server.ts", "export const s = 2;\n");
  cli(partial, "verify");
  stillOpen(partial, "driver");
  stillOpen(partial, "schema");

  const bare = opened("wo-c5-bare", { testFiles: null, verify: ["true"] });
  edit(bare, "src/server.ts", "export const s = 2;\n");
  cli(bare, "verify");
  stillOpen(bare, "driver");
  stillOpen(bare, "schema");
});

test("C5 an empty list is a declaration: a repo with no api says so with []", () => {
  const repo = opened("wo-c5-empty", { ...DECLARED, api: [] });
  edit(repo, "src/server.ts", "export const s = 2;\n");
  cli(repo, "verify");
  closedAuto(repo, "driver");
});

test("C6 only tests or docs changed, or nothing yet: both close with no globs declared", () => {
  const bare = { testFiles: null, verify: ["true"] };
  const tests = opened("wo-c6-tests", bare);
  edit(tests, "tests/a.test.ts", "test('a2', () => {});\n");
  cli(tests, "verify");
  closedAuto(tests, "driver");
  closedAuto(tests, "schema");

  const docs = opened("wo-c6-docs", bare);
  edit(docs, "docs/notes.md", "# more\n");
  cli(docs, "verify");
  closedAuto(docs, "driver");

  const nothing = opened("wo-c6-nothing", bare);
  cli(nothing, "verify");
  closedAuto(nothing, "driver");
  edit(nothing, "src/server.ts", "export const s = 2;\n");
  cli(nothing, "check");
  stillOpen(nothing, "driver");
});

test("C6 a test file a ui glob also matches owes no drive in a new run", () => {
  const repo = opened("wo-c6-tsx");
  edit(repo, "src/app/page.test.tsx", "test('p2', () => {});\n");
  cli(repo, "verify");
  closedAuto(repo, "driver");
  assert.doesNotMatch(cli(repo, "check"), /\bR4\b/);
});

test("C7 a red verify closes nothing, and verify-before closes nothing", () => {
  const red = opened("wo-c7-red", { ...DECLARED, verify: ["false"] });
  edit(red, "src/server.ts", "export const s = 2;\n");
  cli(red, "verify");
  stillOpen(red, "driver");
  stillOpen(red, "schema");

  const before = opened("wo-c7-before", DECLARED, "refactor");
  cli(before, "verify", ["--step", "verify-before"]);
  stillOpen(before, "driver");
  stillOpen(before, "schema");
});

test("C8 a step closed by hand is not overwritten, and a later edit leaves it alone", () => {
  const repo = opened("wo-c8");
  edit(repo, "src/server.ts", "export const s = 2;\n");
  cli(repo, "step", ["driver", "na", "this repo has no surface"]);
  cli(repo, "verify");
  const hand = stepOf(repo, "driver");
  assert.equal(hand.note, "this repo has no surface");
  assert.equal(hand.auto, undefined);
  edit(repo, "src/server.ts", "export const s = 3;\n");
  cli(repo, "check");
  assert.equal(stepOf(repo, "driver").state, "N/A");
  assert.equal(stepOf(repo, "driver").note, "this repo has no surface");
});

test("C9 an old run is unchanged: nothing worked out, na stays free, a test file a ui glob matches still owes R4", () => {
  const repo = opened("wo-c9");
  aged(repo);
  edit(repo, "src/server.ts", "export const s = 2;\n");
  cli(repo, "verify");
  stillOpen(repo, "driver");
  stillOpen(repo, "schema");

  const free = opened("wo-c9-free");
  aged(free);
  edit(free, "src/app/page.tsx", "export default () => 1;\n");
  cli(free, "step", ["driver", "na", "fixture"]);
  assert.equal(stepOf(free, "driver").state, "N/A");

  const tsx = opened("wo-c9-tsx");
  aged(tsx);
  edit(tsx, "src/app/page.test.tsx", "test('p2', () => {});\n");
  assert.match(cli(tsx, "check"), /\bR4\b/);
});

test("C10 gate step na is refused when a matching file changed, and passes when none did", () => {
  const ui = opened("wo-c10-ui");
  edit(ui, "src/app/page.tsx", "export default () => 1;\n");
  const refused = run(ui, "step", ["driver", "na", "looks fine"]);
  assert.match(refused.stderr, /driver/);
  assert.match(refused.stderr, /src\/app\/page\.tsx/);
  assert.equal(stepOf(ui, "driver").state, null);

  const api = opened("wo-c10-api");
  edit(api, "app/api/users/route.ts", "export const GET = 2;\n");
  assert.match(run(api, "step", ["driver", "na", "looks fine"]).stderr, /app\/api\/users\/route\.ts/);

  const schema = opened("wo-c10-schema");
  edit(schema, "db/001.sql", "select 2;\n");
  assert.match(run(schema, "step", ["schema", "na", "looks fine"]).stderr, /db\/001\.sql/);

  const free = opened("wo-c10-free");
  edit(free, "src/server.ts", "export const s = 2;\n");
  cli(free, "step", ["driver", "na", "server only"]);
  cli(free, "step", ["schema", "na", "no schema here"]);
  assert.equal(stepOf(free, "driver").state, "N/A");
  assert.equal(stepOf(free, "schema").state, "N/A");
});

test("C11 config: api matches, defaults empty, declared flags read the keys gate.json has as lists", () => {
  const repo = makeRepo("wo-c11", { ".claude/gate.json": JSON.stringify({ api: ["app/api/**"], ui: [], schema: "not a list" }) });
  const config = loadConfig(repo);
  assert.equal(config.isApi("app/api/users/route.ts"), true);
  assert.equal(config.isApi("src/a.ts"), false);
  assert.deepEqual(config.declared, { ui: true, schema: false, api: true });

  const none = loadConfig(makeRepo("wo-c11-none", { ".claude/gate.json": JSON.stringify({ testFiles: null }) }));
  assert.deepEqual(none.api, []);
  assert.equal(none.isApi("app/api/users/route.ts"), false);
  assert.deepEqual(none.declared, { ui: false, schema: false, api: false });

  const schema = JSON.parse(readFileSync(new URL("../gate.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.api.type, "array");
});

test("C11 isApi dispatches to a declared repo's own gate.json", () => {
  const other = makeRepo("wo-c11-other", { ".claude/gate.json": JSON.stringify({ testFiles: null, api: ["server/**"] }) });
  const repo = makeRepo("wo-c11-main", { ".claude/gate.json": JSON.stringify({ testFiles: null, api: ["app/api/**"] }) });
  const config = loadConfig(repo, [{ prefix: "../wo-c11-other", root: other }]);
  assert.equal(config.isApi("../wo-c11-other/server/a.ts"), true);
  assert.equal(config.isApi("../wo-c11-other/app/api/a.ts"), false);
  assert.equal(config.isApi("app/api/a.ts"), true);
});

test("C11 a gate.json with no api key hashes as it did: the stamp moves nothing for R13", () => {
  const body = JSON.stringify({ testFiles: null, verify: ["true"] });
  const repo = makeRepo("wo-c11-hash", { ".claude/gate.json": body });
  const before = loadConfig(repo).hash;
  write(repo, ".claude/gate.json", JSON.stringify({ testFiles: null, verify: ["true"], api: ["app/api/**"] }));
  assert.notEqual(loadConfig(repo).hash, before, "adding the key is a config change");
  write(repo, ".claude/gate.json", body);
  assert.equal(loadConfig(repo).hash, before);
});

const proposal = (repo) => {
  const r = run(repo, "setup");
  return JSON.parse(r.stdout.slice(r.stdout.indexOf("{"), r.stdout.lastIndexOf("\n}") + 2));
};
const jestRepo = (name, files) => makeRepo(name, { ".claude/gate.json": null, "package.json": JSON.stringify({ name, scripts: { test: "jest" }, devDependencies: { jest: "29" } }), ...files });

test("C12 gate setup proposes api for app/api and pages/api, and none for other repos", () => {
  assert.deepEqual(proposal(jestRepo("wo-c12-app", { "app/api/users/route.ts": "export const GET = 1;\n" })).api, ["app/api/**"]);
  assert.deepEqual(proposal(jestRepo("wo-c12-pages", { "pages/api/users.ts": "export default 1;\n" })).api, ["pages/api/**"]);
  assert.deepEqual(proposal(jestRepo("wo-c12-src", { "src/app/api/users/route.ts": "export const GET = 1;\n" })).api, ["src/app/api/**"]);
  assert.equal("api" in proposal(jestRepo("wo-c12-none", {})), false);
});

test("C12 gate setup keeps an api key the repo already has", () => {
  const repo = jestRepo("wo-c12-kept", { ".claude/gate.json": JSON.stringify({ api: ["server/**"] }), "app/api/users/route.ts": "export const GET = 1;\n" });
  assert.deepEqual(proposal(repo).api, ["server/**"]);
});

test("C13 a run with declared repos closes nothing by this route", () => {
  const repo = opened("wo-c13");
  makeRepo("wo-c13-other", { ".claude/gate.json": JSON.stringify({ testFiles: null, verify: ["true"] }) });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--allow-empty"], { cwd: path.join(path.dirname(repo), "wo-c13-other") });
  cli(repo, "repo", ["add", "../wo-c13-other"]);
  edit(repo, "src/server.ts", "export const s = 2;\n");
  cli(repo, "verify");
  stillOpen(repo, "driver");
  stillOpen(repo, "schema");
});

test("C14 an edit then verify with no check between works the step out again", () => {
  const ui = opened("wo-c14-ui");
  edit(ui, "src/server.ts", "export const s = 2;\n");
  cli(ui, "verify");
  closedAuto(ui, "driver");
  edit(ui, "src/app/page.tsx", "export default () => 1;\n");
  cli(ui, "verify");
  stillOpen(ui, "driver");

  const server = opened("wo-c14-server");
  edit(server, "src/server.ts", "export const s = 2;\n");
  cli(server, "verify");
  const first = stepOf(server, "driver").auto;
  edit(server, "src/server.ts", "export const s = 3;\n");
  cli(server, "verify");
  closedAuto(server, "driver");
  assert.notEqual(stepOf(server, "driver").auto, first, "the mark follows the code just judged");
  cli(server, "check");
  closedAuto(server, "driver");
});

test("C15 a matching file outside source, added after the close, blanks at the next check and stays open at verify", () => {
  const config = { ...DECLARED, source: ["src/**"] };
  const repo = opened("wo-c15", config);
  edit(repo, "src/server.ts", "export const s = 2;\n");
  cli(repo, "verify");
  closedAuto(repo, "schema");
  edit(repo, "db/002.sql", "select 3;\n");
  cli(repo, "check");
  stillOpen(repo, "schema");
  cli(repo, "verify");
  stillOpen(repo, "schema");
});

test("C16 a hand close or waiver over a worked-out step drops its mark, and a blank step is not re-saved", () => {
  const done = opened("wo-c16-done");
  edit(done, "src/server.ts", "export const s = 2;\n");
  cli(done, "verify");
  cli(done, "step", ["schema", "na", "by hand now"]);
  assert.equal(stepOf(done, "schema").auto, undefined);
  edit(done, "src/server.ts", "export const s = 3;\n");
  cli(done, "check");
  assert.equal(stepOf(done, "schema").note, "by hand now");

  const waived = opened("wo-c16-waive");
  edit(waived, "src/server.ts", "export const s = 2;\n");
  cli(waived, "verify");
  cli(waived, "waive", waiveArgs(waived, "driver", "fixture"));
  assert.equal(stepOf(waived, "driver").auto, undefined);
  edit(waived, "src/server.ts", "export const s = 3;\n");
  cli(waived, "check");
  assert.equal(stepOf(waived, "driver").state, null, "the waiver lapsed with the code, and left no worked-out mark behind");
  assert.equal(stepOf(waived, "driver").auto, undefined);

  const blanked = opened("wo-c16-blank");
  edit(blanked, "src/server.ts", "export const s = 2;\n");
  cli(blanked, "verify");
  edit(blanked, "src/server.ts", "export const s = 3;\n");
  cli(blanked, "check");
  assert.equal(stepOf(blanked, "driver").auto, undefined);
  const seq = stepOf(blanked, "driver").seq;
  const bytes = readFileSync(ledgerPath(blanked), "utf8");
  cli(blanked, "check");
  assert.equal(stepOf(blanked, "driver").seq, seq);
  assert.equal(readFileSync(ledgerPath(blanked), "utf8"), bytes);
});

test("C17 test and doc files are no surface in a new run: R4, R6, the na refusal and the report's app line agree", () => {
  const config = { ...DECLARED, ui: ["**/*.tsx"], schema: ["**/*.sql"] };
  const repo = opened("wo-c17", config);
  edit(repo, "docs/site/App.tsx", "export default 1;\n");
  edit(repo, "tests/fixtures/001.sql", "select 1;\n");
  edit(repo, "src/app/page.test.tsx", "test('p2', () => {});\n");
  const out = cli(repo, "check");
  assert.doesNotMatch(out, /\bR4\b/);
  assert.doesNotMatch(out, /\bR6\b/);
  cli(repo, "step", ["driver", "na", "tests and docs only"]);
  cli(repo, "step", ["schema", "na", "tests and docs only"]);
  assert.match(cli(repo, "report", ["--brief"]), /No screen change/);
});

test("C18 an edit made while verify runs is judged from the tree at its start", () => {
  const repo = opened("wo-c18", { ...DECLARED, verify: ["printf 'export default () => 9;\\n' > src/app/page.tsx"] });
  edit(repo, "src/server.ts", "export const s = 2;\n");
  cli(repo, "verify");
  cli(repo, "check");
  stillOpen(repo, "driver");
  assert.match(cli(repo, "check"), /\bR4\b/);
});

// Batch 3.3: an api change is driven by calling the endpoint, and only a recorded call closes it.
// a call under the readings shows its status line, so it can close the driver step
const call = (repo, command = "curl -s localhost:3000/api/users -i") => hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "HTTP/1.1 200 OK\n\n{}" } });
const r4 = (repo) => cli(repo, "check").split("\n").filter((l) => /\bR4\b/.test(l)).join("\n");
const apiChanged = (name) => {
  const repo = opened(name);
  edit(repo, "app/api/users/route.ts", "export const GET = 2;\n");
  return repo;
};

test("3.3 C1 an api file changed: a recorded call closes driver and R4 is clean", () => {
  const repo = apiChanged("wo-33c1");
  assert.match(r4(repo), /app\/api\/users\/route\.ts/);
  call(repo);
  cli(repo, "step", ["driver", "done", "returned 200 with the new field", "--ran", "curl -s localhost:3000"]);
  const step = stepOf(repo, "driver");
  assert.equal(step.state, "DONE");
  assert.match(step.evidence, /^events#\d+$/);
  assert.equal(r4(repo), "");
});

test("3.3 C2 an api file changed: a note is refused, the step stays blank and R4 names the call", () => {
  const repo = apiChanged("wo-33c2");
  write(repo, "notes.txt", "looks fine\n");
  for (const args of [["driver", "done", "looks fine", "--evidence", "notes.txt"], ["driver", "done", "looks fine"], ["driver", "done", "looks fine", "--ran", "curl -s localhost:3000"]]) {
    const r = run(repo, "step", args);
    assert.match(r.stderr, /recorded/, args.join(" "));
    assert.equal(stepOf(repo, "driver").state, null);
  }
  assert.match(r4(repo), /--ran/);
});

test("3.3 C3 a call from before the last edit cannot close it; an edit after the call brings R4 back until a new call", () => {
  const before = opened("wo-33c3");
  edit(before, "app/api/users/route.ts", "export const GET = 2;\n");
  call(before);
  edit(before, "app/api/users/route.ts", "export const GET = 3;\n");
  assert.match(run(before, "step", ["driver", "done", "old call", "--ran", "curl -s localhost:3000"]).stderr, /after the last edit/);
  assert.equal(stepOf(before, "driver").state, null);

  const repo = apiChanged("wo-33c3b");
  call(repo);
  cli(repo, "step", ["driver", "done", "returned 200", "--ran", "curl -s localhost:3000"]);
  assert.equal(r4(repo), "");
  edit(repo, "app/api/users/route.ts", "export const GET = 3;\n");
  assert.match(r4(repo), /app\/api\/users\/route\.ts/);
  call(repo, "curl -s localhost:3000/api/users?again=1");
  cli(repo, "step", ["driver", "done", "returned 200 again", "--ran", "again=1"]);
  assert.equal(r4(repo), "");
});

test("3.3 C4 an old run is unchanged: an api file closes driver on a note and owes no R4 for it", () => {
  const repo = opened("wo-33c4");
  aged(repo);
  edit(repo, "app/api/users/route.ts", "export const GET = 2;\n");
  assert.equal(r4(repo), "");
  write(repo, "notes.txt", "looks fine\n");
  cli(repo, "step", ["driver", "done", "looks fine", "--evidence", "notes.txt"]);
  assert.equal(stepOf(repo, "driver").state, "DONE");
});

test("3.3 C5 a UI-only change in a new run closes driver on evidence, and R4 reads the drive", () => {
  const repo = opened("wo-33c5");
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  write(repo, "notes.txt", "drove it\n");
  cli(repo, "step", ["driver", "done", "drove it", "--evidence", "notes.txt"]);
  assert.equal(stepOf(repo, "driver").evidence, "notes.txt");
  assert.match(r4(repo), /UI files changed/);
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "http://localhost:3000" }, tool_response: {} });
  assert.equal(r4(repo), "");
});

test("3.3 C6 a waiver clears the api line of R4", () => {
  const repo = apiChanged("wo-33c6");
  cli(repo, "waive", waiveArgs(repo, "driver", "fixture"));
  assert.equal(r4(repo), "");
});

test("3.3 C7 a test file an api glob matches, or a change no api glob matches, owes no call", () => {
  const config = { ...DECLARED, api: ["app/api/**"], tests: ["**/*.test.ts"] };
  const repo = opened("wo-33c7", config);
  edit(repo, "app/api/users/route.test.ts", "test('r', () => {});\n");
  edit(repo, "src/server.ts", "export const s = 2;\n");
  assert.equal(r4(repo), "");
  write(repo, "notes.txt", "n/a\n");
  cli(repo, "step", ["driver", "done", "server only", "--evidence", "notes.txt"]);
  assert.equal(stepOf(repo, "driver").evidence, "notes.txt");
});

test("3.3 C8 a failed call, a helper's call and a background call cannot close it", () => {
  const repo = apiChanged("wo-33c8");
  hook(repo, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "curl -s localhost:3000/api/users" }, tool_error: "Exit code 7" });
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "curl -s localhost:3000/api/users" }, tool_response: {}, agent_id: "A1", agent_type: "done-gate:reviewer" });
  hook(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "curl -s localhost:3000/api/users", run_in_background: true }, tool_response: {} });
  assert.match(run(repo, "step", ["driver", "done", "no", "--ran", "curl -s localhost:3000"]).stderr, /recorded/);
  assert.equal(stepOf(repo, "driver").state, null);
});

test("3.3 C9 a cmd driver whose own write set the stamp still closes it; a sed that wrote the file is no call", () => {
  const config = { ...DECLARED, driver: "cmd:npm run e2e" };
  const driven = opened("wo-33c9", config);
  edit(driven, "app/api/users/route.ts", "export const GET = 2;\n");
  write(driven, "app/api/users/route.ts", "export const GET = 'written by the driver';\n");
  call(driven, "npm run e2e");
  cli(driven, "check");
  cli(driven, "step", ["driver", "done", "e2e green", "--ran", "npm run e2e"]);
  assert.equal(r4(driven), "");

  const sed = opened("wo-33c9b");
  edit(sed, "app/api/users/route.ts", "export const GET = 2;\n");
  write(sed, "app/api/users/route.ts", "export const GET = 3;\n");
  call(sed, "sed -i '' s/2/3/ app/api/users/route.ts");
  cli(sed, "check");
  assert.match(run(sed, "step", ["driver", "done", "no", "--ran", "sed -i"]).stderr, /recorded|after the last edit/);
});

test("3.3 C10 a change matching ui and api owes both, each until its own proof is there", () => {
  const repo = opened("wo-33c10");
  edit(repo, "src/app/page.tsx", "export default () => 1;\n");
  edit(repo, "app/api/users/route.ts", "export const GET = 2;\n");
  const navigate = (r) => hook(r, { hook_event_name: "PostToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "http://localhost:3000" }, tool_response: {} });
  assert.match(r4(repo), /UI files changed/, "the check prints one line per rule: the drive first");
  navigate(repo);
  assert.match(r4(repo), /route\.ts/, "a drive does not stand in for the call");
  call(repo);
  cli(repo, "step", ["driver", "done", "returned 200", "--ran", "curl -s localhost:3000"]);
  assert.equal(r4(repo), "");

  const callFirst = opened("wo-33c10b");
  edit(callFirst, "src/app/page.tsx", "export default () => 1;\n");
  edit(callFirst, "app/api/users/route.ts", "export const GET = 2;\n");
  call(callFirst);
  cli(callFirst, "step", ["driver", "done", "returned 200", "--ran", "curl -s localhost:3000"]);
  assert.match(r4(callFirst), /UI files changed/, "a call does not stand in for the drive");
  navigate(callFirst);
  assert.equal(r4(callFirst), "");
});

test("3.3 C11 --evidence events# closes on a real call, and is refused on an edit or a read-only event", () => {
  const repo = apiChanged("wo-33c11");
  call(repo, "cat README.md");
  const events = () => readEvents(path.join(repo, ".claude", "gate"), "S1");
  const edited = events().filter((e) => e.kind === "edit").pop();
  const read = events().filter((e) => e.kind === "command").pop();
  for (const e of [edited, read]) assert.match(run(repo, "step", ["driver", "done", "no", "--evidence", `events#${e.seq}`]).stderr, /recorded/);
  call(repo);
  const real = events().filter((e) => e.kind === "command").pop();
  cli(repo, "step", ["driver", "done", "returned 200", "--evidence", `events#${real.seq}`]);
  assert.equal(r4(repo), "");
});

test("3.3 C12 a driver step closed by hand before the api file changed owes the call", () => {
  for (const [name, args] of [["wo-33c12a", ["driver", "na", "no surface yet"]], ["wo-33c12b", ["driver", "done", "looked fine", "--evidence", "src/a.ts"]]]) {
    const repo = opened(name);
    cli(repo, "step", args);
    edit(repo, "app/api/users/route.ts", "export const GET = 2;\n");
    assert.match(r4(repo), /route\.ts/, name);
    call(repo);
    cli(repo, "step", ["driver", "done", "returned 200", "--ran", "curl -s localhost:3000"]);
    assert.equal(r4(repo), "");
  }
});

test("3.3 C13 the driver hint names both ways to close", () => {
  const repo = opened("wo-33c13");
  lookedUp(repo);
  cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
  cli(repo, "note", ["plan", "the plan", "--files", "src/server.ts"]);
  cli(repo, "case", ["add", "c", "--kind", "happy"]);
  for (const key of ["skeptic", "tests", "implement", "verify"]) cli(repo, "step", [key, "na", "fixture"]);
  const hint = cli(repo, "next");
  assert.match(hint, /decisions#/);
  assert.match(hint, /--ran/);
});
