// A standing waiver: the user's words once, for a named batch of runs, ending in 14 days. Each run
// that says it belongs to the batch carries it, and every report lists it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { abandonArgs, gate, here, lookedUp, makeRepo, userSays, write } from "./helpers.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

const DAY_MS = 864e5;
const envFor = (repo, session = "S1") => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
};
const run = (repo, verb, args = [], session = "S1") => spawnSync(process.execPath, [gate, verb, ...args], { encoding: "utf8", env: envFor(repo, session) });
function cli(repo, verb, args = [], session = "S1") {
  const r = run(repo, verb, args, session);
  assert.ok(!/^done-gate: /m.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r.stdout;
}
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const standingFile = (repo) => path.join(stateDir(repo), "standing.json");
const ledgerOf = (repo, session = "S1") => JSON.parse(readFileSync(path.join(stateDir(repo), "runs", loadSession(stateDir(repo), session).current, "ledger.json"), "utf8"));
const stepState = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key).state;
const WORDS = "skip the driver check for batch rollout";
const standing = (repo, key = "driver", batch = "rollout", words = WORDS) => {
  userSays(repo, words);
  return run(repo, "waive", [key, "--standing", batch, "--user-ok", words]);
};
const uiEdit = (repo, value = 1) => write(repo, "src/app/page.tsx", `export default () => ${value};\n`);
const r4 = (repo) => cli(repo, "check").split("\n").some((l) => /\bR4\b/.test(l));

test("C1 a standing waiver needs the user's words naming the check and the batch; it works with no run open", () => {
  const repo = makeRepo("sw-c1");
  assert.match(run(repo, "waive", ["driver", "--standing", "rollout"]).stderr, /--user-ok/);
  assert.match(run(repo, "waive", ["driver", "--standing", "rollout", "--user-ok", WORDS]).stderr, /did not say/);

  userSays(repo, "fine by me for rollout");
  assert.match(run(repo, "waive", ["driver", "--standing", "rollout", "--user-ok", "fine by me for rollout"]).stderr, /does not name/);
  userSays(repo, "skip the driver check");
  assert.match(run(repo, "waive", ["driver", "--standing", "rollout", "--user-ok", "skip the driver check"]).stderr, /rollout/);

  const answer = { session_id: "S1", cwd: repo, hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, tool_response: { answers: { "Which?": `${WORDS} (Recommended)` } } };
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify(answer), encoding: "utf8", env: envFor(repo) });
  assert.match(run(repo, "waive", ["driver", "--standing", "rollout", "--user-ok", WORDS]).stderr, /did not say/);
  assert.equal(existsSync(standingFile(repo)), false);

  assert.equal(standing(repo).status, 0, "no run is open, and that is fine");
  assert.equal(existsSync(standingFile(repo)), true);
});

test("C2 it writes standing.json ending in 14 days, and the fence refuses a write to that file", () => {
  const repo = makeRepo("sw-c2");
  assert.equal(standing(repo).status, 0);
  const [entry] = JSON.parse(readFileSync(standingFile(repo), "utf8")).entries;
  assert.equal(entry.key, "driver");
  assert.equal(entry.batch, "rollout");
  assert.equal(entry.words, WORDS);
  const days = (Date.parse(entry.until) - Date.parse(entry.at)) / DAY_MS;
  assert.equal(days, 14);

  const edit = decide({ tool_name: "Edit", tool_input: { file_path: standingFile(repo) } }, repo);
  assert.equal(edit.deny, true);
  const shell = decide({ tool_name: "Bash", tool_input: { command: "echo '{}' > .claude/gate/standing.json" } }, repo);
  assert.equal(shell.deny, true);
});

test("C3 gate open --batch copies live entries: the step closes, the rule clears, no code, and an edit does not lapse it", () => {
  const repo = makeRepo("sw-c3");
  assert.equal(standing(repo).status, 0);
  assert.match(cli(repo, "open", ["t", "feature", "--batch", "rollout"]), /rollout/);
  const ledger = ledgerOf(repo);
  assert.equal(ledger.batch, "rollout");
  const [w] = ledger.waivers;
  assert.equal(w.key, "driver");
  assert.equal(w.batch, "rollout");
  assert.equal(w.words, WORDS);
  assert.equal(w.code, undefined);
  assert.equal(stepState(repo, "driver"), "WAIVED");
  uiEdit(repo);
  assert.equal(r4(repo), false);
  uiEdit(repo, 2);
  assert.equal(r4(repo), false, "a standing waiver holds across edits");
  assert.equal(ledgerOf(repo).waivers[0].lapsed, undefined);
});

test("C4 an entry past 14 days is not copied, and a batch with no live entry is refused, naming the live ones", () => {
  const repo = makeRepo("sw-c4");
  assert.equal(standing(repo).status, 0);
  assert.equal(standing(repo, "review", "other", "skip the review for batch other").status, 0);
  const file = JSON.parse(readFileSync(standingFile(repo), "utf8"));
  file.entries.find((e) => e.batch === "rollout").until = new Date(Date.now() - 1000).toISOString();
  writeFileSync(standingFile(repo), JSON.stringify(file));
  const refused = run(repo, "open", ["t", "feature", "--batch", "rollout"]);
  assert.match(refused.stderr, /no live standing waiver/);
  assert.match(refused.stderr, /other/);
  assert.equal(loadSession(stateDir(repo), "S1")?.current ?? null, null);
  assert.match(run(repo, "open", ["t", "feature", "--batch", "never-made"]).stderr, /no live standing waiver/);
});

test("C5 the keys tests, qa, R7 and slop are refused for a standing waiver", () => {
  const repo = makeRepo("sw-c5");
  for (const key of ["tests", "qa", "R7", "slop"]) {
    const words = `skip the ${key} check for rollout`;
    assert.match(standing(repo, key, "rollout", words).stderr, /standing/, key);
  }
  assert.equal(existsSync(standingFile(repo)), false);
});

test("C6 two runs in a batch close with the waiver listed in both reports, naming the batch", () => {
  const repo = makeRepo("sw-c6", { ".claude/gate.json": JSON.stringify({ testFiles: null, verify: ["true"] }) });
  assert.equal(standing(repo).status, 0);
  for (const name of ["first", "second"]) {
    cli(repo, "open", [name, "feature", "--batch", "rollout"]);
    lookedUp(repo);
    cli(repo, "note", ["task", "Add a thing. [inferred]"]);
    cli(repo, "note", ["context", "Traced: src/a.ts:1\nRelated: tests/a.test.ts\nResearch: none needed: local"]);
    cli(repo, "note", ["plan", "One file.", "--files", "src/a.ts"]);
    cli(repo, "case", ["add", "it works", "--kind", "happy"]);
    cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:a"]);
    const full = cli(repo, "report");
    assert.match(full, /waived driver:[^\n]*rollout/, name);
    assert.match(cli(repo, "report", ["--brief"]), /rollout/, name);
    cli(repo, "abandon", abandonArgs(repo, name, "this case stops at the report"));
  }
});

test("C7 a run with no --batch is unaffected by a standing waiver", () => {
  const repo = makeRepo("sw-c7");
  assert.equal(standing(repo).status, 0);
  cli(repo, "open", ["t", "feature"]);
  assert.deepEqual(ledgerOf(repo).waivers, []);
  assert.equal(ledgerOf(repo).batch, undefined);
  uiEdit(repo);
  assert.equal(r4(repo), true);
});

test("C8 gate waive --end stops it: a later open is refused, and a copy in an open run lapses and its rule comes back", () => {
  const repo = makeRepo("sw-c8");
  assert.equal(standing(repo).status, 0);
  cli(repo, "open", ["t", "feature", "--batch", "rollout"]);
  uiEdit(repo);
  assert.equal(r4(repo), false);
  assert.match(cli(repo, "waive", ["--end", "rollout"]), /rollout/);
  assert.equal(ledgerOf(repo).waivers[0].lapsed, true);
  assert.equal(stepState(repo, "driver"), null);
  assert.equal(r4(repo), true);
  cli(repo, "abandon", abandonArgs(repo, "t", "this case stops here"));
  assert.match(run(repo, "open", ["u", "feature", "--batch", "rollout"]).stderr, /no live standing waiver/);
  assert.match(run(repo, "waive", ["--end", "never-made"]).stderr, /no standing waiver/);
});

test("C9 the refusal that prints a re-run line for gate open keeps --batch", () => {
  const repo = makeRepo("sw-c9", { ".claude/gate.json": null, "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" }, devDependencies: { jest: "29" } }) });
  spawnSync(process.execPath, [gate, "session-start"], { input: JSON.stringify({ session_id: "S1", cwd: repo, hook_event_name: "SessionStart", session_start_source: "startup" }), encoding: "utf8", env: envFor(repo) });
  assert.equal(standing(repo).status, 0);
  const refused = run(repo, "open", ["t", "feature", "--batch", "rollout"]);
  assert.match(refused.stderr, /gate open t feature[^\n]*--batch rollout/);
});

test("C9 the old-version line keeps --batch", () => {
  const home = path.join(here, ".tmp", "sw-home-old");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "done-gate-release.json"), JSON.stringify({ latest: "99.0.0", checkedAt: new Date().toISOString() }));
  const repo = makeRepo("sw-c9b");
  const r = spawnSync(process.execPath, [gate, "open", "t", "feature", "--batch", "rollout"], { encoding: "utf8", env: { ...envFor(repo), DONE_GATE_HOME: home } });
  assert.match(r.stderr, /--batch rollout/);
});

test("C10 --end finds a copy whose entry expired, a report says it was ended, and a run already open keeps what it had", () => {
  const repo = makeRepo("sw-c10");
  assert.equal(standing(repo).status, 0);
  cli(repo, "open", ["t", "feature", "--batch", "rollout"]);
  writeFileSync(standingFile(repo), JSON.stringify({ entries: [] }));
  assert.equal(ledgerOf(repo).waivers[0].lapsed, undefined, "a copy outlives its entry for that run");
  uiEdit(repo);
  assert.equal(r4(repo), false);
  assert.match(cli(repo, "waive", ["--end", "rollout"]), /1 copy/);
  assert.match(cli(repo, "report"), /standing, batch rollout — ended with gate waive --end/);
  assert.match(cli(repo, "report", ["--brief"]), /standing OK for batch rollout was ended/);
  assert.doesNotMatch(cli(repo, "report"), /the code changed after it/);
});

test("C11 gate open of a run already open refuses a different --batch and takes the same one without copying twice", () => {
  const repo = makeRepo("sw-c11");
  assert.equal(standing(repo).status, 0);
  cli(repo, "open", ["t", "feature", "--batch", "rollout"]);
  cli(repo, "open", ["t", "feature", "--batch", "rollout"]);
  assert.equal(ledgerOf(repo).waivers.length, 1);
  assert.match(run(repo, "open", ["t", "feature", "--batch", "other"]).stderr, /already open in batch rollout/);

  const plain = makeRepo("sw-c11b");
  assert.equal(standing(plain).status, 0);
  cli(plain, "open", ["t", "feature"]);
  assert.match(run(plain, "open", ["t", "feature", "--batch", "rollout"]).stderr, /already open/);
  assert.deepEqual(ledgerOf(plain).waivers, []);
});

test("C12 gate waive --standing from a sibling folder is refused the same way, with the words kept in the line", () => {
  const home = makeRepo("sw-c12-home");
  makeRepo("sw-c12-sibling");
  userSays(home, WORDS);
  const env = { ...process.env, DONE_GATE_SESSION: "S1" };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [gate, "waive", "driver", "--standing", "rollout", "--user-ok", WORDS], { encoding: "utf8", env, cwd: path.join(path.dirname(home), "sw-c12-sibling") });
  assert.match(r.stderr, /filed under/);
  assert.match(r.stderr, /--standing rollout/);
  assert.equal(existsSync(path.join(path.dirname(home), "sw-c12-sibling", ".claude", "gate", "standing.json")), false);
});

const setCopyUntil = (repo, until) => {
  const file = path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current, "ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const w of ledger.waivers) if (w.batch) w.until = until;
  writeFileSync(file, JSON.stringify(ledger, null, 2));
};

test("F10 C4 happy: a copy lapses when its 14 days pass inside an open run; the report and For you say they ran out", () => {
  const repo = makeRepo("sw-f10c4");
  assert.equal(standing(repo).status, 0);
  cli(repo, "open", ["t", "feature", "--batch", "rollout"]);
  assert.equal(ledgerOf(repo).waivers[0].until, JSON.parse(readFileSync(standingFile(repo), "utf8")).entries[0].until, "the copy keeps the entry's end");
  uiEdit(repo);
  assert.equal(r4(repo), false);
  setCopyUntil(repo, new Date(Date.now() - 1000).toISOString());
  assert.equal(r4(repo), true, "the copy still holds past its 14 days");
  assert.equal(stepState(repo, "driver"), null);
  assert.match(cli(repo, "report"), /standing, batch rollout — ended: its 14 days ran out/);
  assert.match(cli(repo, "report", ["--brief"]), /standing OK for batch rollout ran out after its 14 days/);
});

test("F10 C5 edge: before its 14 days the copy holds, even with its entry gone; a copy with no end date keeps holding", () => {
  const repo = makeRepo("sw-f10c5");
  assert.equal(standing(repo).status, 0);
  cli(repo, "open", ["t", "feature", "--batch", "rollout"]);
  writeFileSync(standingFile(repo), JSON.stringify({ entries: [] }));
  setCopyUntil(repo, new Date(Date.now() + DAY_MS).toISOString());
  uiEdit(repo);
  assert.equal(r4(repo), false);
  setCopyUntil(repo, undefined);
  assert.equal(r4(repo), false, "a copy from before kept no end date");
});
