import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

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

const ROLES = Object.keys(JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8")).roles);

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
  cli(repo, "note", ["plan", "One module.", "--files", planFiles]);
  return repo;
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1 happy: a fresh feature ledger hints `gate note task`, then `gate note plan --files`, then `gate case add`", () => {
  const repo = committed("next-c1");

  const afterOpen = hintOf(cli(repo, "open", ["badge", "feature"]).stdout);
  assert.match(afterOpen, /^next: /, afterOpen);
  assert.match(afterOpen, /`gate note task/, `a ledger with no Task must ask for the Task:\n${afterOpen}`);

  const afterTask = hint(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  assert.match(afterTask, /`gate note plan[^`]*--files/, `a ledger with no Plan must ask for the Plan:\n${afterTask}`);

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

test("C2 edge: after the case table the hint names `gate brief skeptic` at tier standard and `gate brief qa` at tier small", () => {
  // {skeptic} is step 4 and {qa} step 5 of the feature playbook: at tier small {skeptic}
  // is auto-N/A, so the first blank helper step becomes {qa}.
  const feature = playbookKeys("feature");
  assert.ok(feature.indexOf("skeptic") < feature.indexOf("qa"), feature.join(","));

  const standard = opened("next-c2-standard", { planFiles: "src/a.ts,src/app/page.tsx" });
  cli(standard, "step", ["read", "done", "read the card and its callers", "--evidence", "events#1"]);
  const std = hint(standard, "case", ["add", "renders the badge", "--kind", "happy"]);
  assert.equal(stepOf(ledgerOf(standard), "skeptic").state, null, "premise: {skeptic} is still blank at tier standard");
  assert.match(std, /`gate brief skeptic/, std);
  assert.ok(!/`gate brief qa/.test(std), `the skeptic is still blank, so qa must not be hinted yet:\n${std}`);

  const small = opened("next-c2-small", { planFiles: "src/a.ts" });
  cli(small, "step", ["read", "done", "read the card and its callers", "--evidence", "events#1"]);
  const sml = hint(small, "case", ["add", "renders the badge", "--kind", "happy"]);
  assert.equal(stepOf(ledgerOf(small), "skeptic").state, "N/A", "premise: tier small auto-N/As {skeptic}");
  assert.match(sml, /`gate brief qa/, sml);
  assert.ok(!/skeptic/.test(sml), `a step that is already N/A must never be hinted:\n${sml}`);
});

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

test("C3 happy: once {qa} is closed the hint moves to the next blank step; a bugfix's first step hint is {repro}", () => {
  const repo = opened("next-c3", { planFiles: "src/a.ts" }); // tier small: {skeptic} auto-N/A
  cli(repo, "step", ["read", "done", "read the card", "--evidence", "events#1"]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);

  const afterQa = hint(repo, "step", ["qa", "done", "QA wrote the tests", "--evidence", "tests/a.test.ts"]);
  const feature = playbookKeys("feature");
  const next = feature
    .slice(feature.indexOf("qa") + 1)
    .find((k) => stepOf(ledgerOf(repo), k).state === null);
  assert.equal(next, "implement", "premise: {implement} is the next blank step after {qa} at tier small");
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
    ["step", ["read", "done", "read the card", "--evidence", "events#1"], {}],
    ["huddle", ["add", "reviewer", "--file", "review-1.md"], {}],
    ["waive", ["driver", "chrome is disconnected, skip the phone pass"], {}],
    ["decide", ["plan", "kept the badge in the card", "one consumer", "events#3", "open"], {}],
    ["verify", [], {}],
    ["size", [], {}],
    ["brief", ["qa"], {}],
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
