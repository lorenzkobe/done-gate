// helpers-handoff: a helper saves its findings as it goes, a file it left unfinished is noticed
// and handed to a fresh helper that continues from it, and parallel briefs keep their own
// numbers. Cases C1–C17 of the task's case table.
//
// Written from the requirements and the case table, blind to the implementation.
//
// source-of-truth anchors
//   the helper file shapes        → agents/skeptic.md and agents/reviewer.md ("File shape")
//   the placeholder               → scripts/lib/guard.mjs's draft-first message ('"- unverified"')
//   event kinds                   → scripts/lib/events.mjs (SubagentStart / SubagentStop / PostToolUse)
//   the 45-minute bound           → scripts/lib/stop.mjs HELPER_MAX_MS (45 * 60 * 1000)
//   tiers and what they require   → models.json policy.tiers
//   step keys and order           → skills/gate/playbooks.md
//   turn budgets                  → the case table (C11), read back from each agent's frontmatter

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, pluginRoot } from "./helpers.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

function envFor(repo, session = "S1") {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: session };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function run(repo, verb, args = [], { input = "" } = {}) {
  return spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: envFor(repo) });
}

const REFUSAL = /^done-gate: /m;

function cli(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.ok(!REFUSAL.test(r.stderr), `gate ${verb} ${args.join(" ")} was refused:\n${r.stderr}`);
  return r;
}

function refused(repo, verb, args = []) {
  const r = run(repo, verb, args);
  assert.ok(!/GATE ERROR/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, REFUSAL, `expected \`gate ${verb} ${args.join(" ")}\` to be refused, got:\n${r.stdout}${r.stderr}`);
  return r;
}

function check(repo) {
  const r = run(repo, "check");
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!/GATE ERROR/.test(out), out);
  return r.stdout;
}

const lines = (s) => s.split("\n").filter((l) => l.trim() !== "");
const stateDir = (repo) => path.join(repo, ".claude", "gate");
const runDir = (repo) => path.join(stateDir(repo), "runs", loadSession(stateDir(repo), "S1").current);
const ledgerPath = (repo) => path.join(runDir(repo), "ledger.json");
const ledgerOf = (repo) => JSON.parse(readFileSync(ledgerPath(repo), "utf8"));
const stepOf = (repo, key) => ledgerOf(repo).steps.find((s) => s.key === key);
const huddlesOf = (repo, role) => ledgerOf(repo).huddles.filter((h) => h.role === role);
const eventsFile = (repo) => path.join(stateDir(repo), "sessions", "S1", "events.jsonl");

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function committed(name, files = {}) {
  const repo = makeRepo(name, files);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

// A hook payload, fed to `gate log` exactly as Claude Code's hooks feed one.
function hook(repo, payload) {
  const r = spawnSync(process.execPath, [gate, "log"], {
    input: JSON.stringify({ session_id: "S1", cwd: repo, ...payload }),
    encoding: "utf8",
    env: envFor(repo),
  });
  assert.equal(r.status, 0, r.stderr);
}
const start = (repo, id, role) => hook(repo, { hook_event_name: "SubagentStart", agent_id: id, agent_type: `done-gate:${role}` });
const stop = (repo, id, role) => hook(repo, { hook_event_name: "SubagentStop", agent_id: id, agent_type: `done-gate:${role}`, stop_hook_active: false });

const helperFile = (repo, name, body) => writeFileSync(path.join(runDir(repo), name), body);

// A helper's own Write of its file: the bytes land and the PostToolUse hook logs the edit
// under the helper's agent id.
function helperWrites(repo, id, role, name, body) {
  helperFile(repo, name, body);
  hook(repo, {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    agent_id: id,
    agent_type: `done-gate:${role}`,
    tool_input: { file_path: path.join(runDir(repo), name), content: body },
    tool_response: {},
  });
}

// A source edit by a shell command, so the reviewer has a diff to be briefed on.
function shellWrite(repo, rel, content) {
  hook(repo, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: `cat > ${rel} <<'EOF' ...`, description: "edit a file" },
    tool_output: "...",
  });
  write(repo, rel, content);
}

function brief(repo, role, args = []) {
  const r = cli(repo, "brief", [role, ...args]);
  const p = lines(r.stdout).find((l) => l.startsWith("packet: "))?.slice("packet: ".length);
  assert.ok(p, `no "packet: <path>" line in:\n${r.stdout}`);
  const prompt = lines(r.stdout).find((l) => l.startsWith("prompt: ")) ?? "";
  return { path: p, name: path.basename(p), text: readFileSync(p, "utf8"), prompt, stdout: r.stdout };
}

function section(md, heading) {
  const all = md.split("\n");
  const at = all.findIndex((l) => l.trim() === `## ${heading}`);
  assert.ok(at >= 0, `packet has no "## ${heading}" section:\n${md.slice(0, 2000)}`);
  const rest = all.slice(at + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// The line of `gate check` that reports an unfinished helper file: it names the file and
// the re-brief.
const unfinishedLine = (out, file, role) => lines(out).find((l) => l.includes(file) && l.includes(`gate brief ${role}`));
const neverRecordedLine = (out, file) => lines(out).find((l) => l.includes(file) && /never recorded/.test(l));

const FIND_1 = "the plan assumes one caller of a — src/a.ts:1";
const FIND_2 = "the empty list has no case — src/app/page.tsx:1";

// agents/skeptic.md's file shape: Act on / Consider / Noted / The one question.
const skepticFile = (n, slug, { actOn = [FIND_1], consider = "the helper could be inlined", noted = "the module is small", question = "none" } = {}) =>
  `# Skeptic ${n} — ${slug}\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n` +
  `## Consider\n- ${consider}\n## Noted\n- ${noted}\n## The one question\n- ${question}\n`;
const skepticDraft = (n, slug) => skepticFile(n, slug, { actOn: ["unverified"], consider: "unverified", noted: "unverified", question: "unverified" });
// Act on is filled; Consider still reads the bare placeholder.
const skepticPartial = (n, slug) => skepticFile(n, slug, { consider: "unverified" });

// agents/reviewer.md's file shape.
const reviewFile = (n, slug, { actOn = [FIND_1], consider = "rename the helper", verdict = "tests: npm test exit 0, 12 passed (ran it myself)" } = {}) =>
  `# Review ${n} — ${slug}\n\n## Act on\n${actOn.length ? actOn.map((t) => `- ${t}`).join("\n") : "- none"}\n` +
  `## Consider\n- ${consider}\n## Noted\n- the module is small\n## Dismissed\n- none\n## Evidence verdict\n- ${verdict}\n`;
const reviewDraft = (n, slug) =>
  `# Review ${n} — ${slug}\n\n## Act on\n- unverified\n## Consider\n- unverified\n## Noted\n- unverified\n## Dismissed\n- none\n## Evidence verdict\n- unverified\n`;
const reviewPartial = (n, slug) => reviewFile(n, slug, { consider: "unverified", verdict: "unverified" });

const TWO = "src/a.ts,src/app/page.tsx";

// An open ledger whose plan names two files: predicted standard (models.json: one file is
// tiny/small, up to ten is standard), so the skeptic is required.
function standard(name, playbook = "feature") {
  const repo = committed(name);
  cli(repo, "open", [name, playbook]);
  cli(repo, "note", ["task", "Add a badge to the venue card. [inferred]"]);
  cli(repo, "note", ["plan", "Two modules.", "--files", TWO]);
  cli(repo, "case", ["add", "renders the badge", "--kind", "happy"]);
  cli(repo, "case", ["add", "refuses an unknown role", "--kind", "refused"]);
  assert.equal(ledgerOf(repo).tier.predicted, "standard", "premise: a two-file plan predicts standard");
  return repo;
}

// The same ledger with both planned files changed, so a reviewer can be briefed per piece.
function changed(name) {
  const repo = standard(name);
  shellWrite(repo, "src/a.ts", "export const a = 2;\nexport const venue = null;\n");
  shellWrite(repo, "src/app/page.tsx", "export default () => 'badge';\n");
  return repo;
}

const LARGE = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);

// Eleven planned files: past standard's maxFiles of 10, so the task is large and workers are briefed.
function large(name) {
  const repo = committed(name, Object.fromEntries(LARGE.map((f) => [f, "export const x = 1;\n"])));
  cli(repo, "open", [name, "feature"]);
  cli(repo, "note", ["task", "Split the module. [inferred]"]);
  cli(repo, "note", ["plan", "Eleven modules.", "--files", LARGE.join(",")]);
  cli(repo, "case", ["add", "each module exports x", "--kind", "happy"]);
  assert.equal(ledgerOf(repo).tier.predicted, "large", "premise: an eleven-file plan predicts large");
  return repo;
}

const agentMd = (role) => readFileSync(path.join(pluginRoot, "agents", `${role}.md`), "utf8");
const bodyOf = (md) => md.replace(/^---\n[\s\S]*?\n---\n/, "");
const maxTurnsOf = (md) => Number(/^\s*maxTurns:\s*(\d+)\s*$/m.exec(/^---\n([\s\S]*?)\n---\n/.exec(md)[1])?.[1]);

test("C1 refused: a skeptic file whose Act on is filled but whose Consider still reads the bare placeholder is partial — huddle add skeptic refuses it, records nothing and names gate brief skeptic", () => {
  const repo = standard("hh-c1");
  helperFile(repo, "skeptic-1.md", skepticPartial(1, "hh-c1"));

  const r = refused(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  assert.ok(r.stderr.includes("skeptic-1.md"), `the refusal does not name the file: ${r.stderr}`);
  assert.ok(r.stderr.includes("gate brief skeptic"), `the refusal does not name the re-brief: ${r.stderr}`);
  assert.deepEqual(ledgerOf(repo).huddles, [], "the partial file was recorded as a huddle");
  assert.equal(readFileSync(path.join(runDir(repo), "skeptic-1.md"), "utf8"), skepticPartial(1, "hh-c1"), "the refused add rewrote the file");
});

test("C2 boundary: a finished file with the verdict line 'tests: npm test unverified' and no bare placeholder is not partial and is recorded", () => {
  const repo = changed("hh-c2");
  helperFile(repo, "review-1.md", reviewFile(1, "hh-c2", { verdict: "tests: npm test unverified" }));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const [h] = huddlesOf(repo, "reviewer");
  assert.ok(h, "the finished review was not recorded");
  assert.equal(h.file, "review-1.md");
  assert.deepEqual(h.actOn.map((a) => a.text), [FIND_1]);

  // the same line in a skeptic file's Noted section
  helperFile(repo, "skeptic-1.md", skepticFile(1, "hh-c2", { noted: "tests: npm test unverified" }));
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  assert.equal(huddlesOf(repo, "skeptic").length, 1, "the finished skeptic file was not recorded");
  const out = check(repo);
  assert.ok(!unfinishedLine(out, "review-1.md", "reviewer"), out);
  assert.ok(!unfinishedLine(out, "skeptic-1.md", "skeptic"), out);
});

test("C3 happy: after a partial skeptic file, gate brief skeptic reuses the same number and its packet has a Continue from section holding the partial text", () => {
  const repo = standard("hh-c3");
  const first = brief(repo, "skeptic");
  assert.equal(first.name, "brief-skeptic-1.md");
  assert.ok(!first.text.includes("## Continue from"), "a first brief has nothing to continue from");

  start(repo, "A1", "skeptic");
  helperWrites(repo, "A1", "skeptic", "skeptic-1.md", skepticPartial(1, "hh-c3"));
  stop(repo, "A1", "skeptic");

  const again = brief(repo, "skeptic");
  assert.equal(again.name, "brief-skeptic-1.md", "the partial file's number was not reused");
  assert.ok(section(again.text, "You may write").includes(path.join(runDir(repo), "skeptic-1.md")), again.text);
  assert.ok(!again.text.includes("skeptic-2.md"), "the re-brief names skeptic-2.md, so the partial file consumed its number");
  const at = again.text.indexOf("## Continue from");
  assert.ok(at >= 0, `the re-brief packet has no "## Continue from" section:\n${again.text.slice(0, 1500)}`);
  assert.ok(again.text.slice(at).includes(FIND_1), "the Continue from section does not hold the partial file's finding");
  assert.equal(readFileSync(path.join(runDir(repo), "skeptic-1.md"), "utf8"), skepticPartial(1, "hh-c3"), "the re-brief changed the partial file");
});

test("C4 edge: a briefed skeptic whose helper stopped with the file missing, draft or partial makes gate check list the file and the re-brief; before any helper ran, or while it runs, it is not listed", () => {
  for (const [state, body] of [["missing", null], ["draft", skepticDraft(1, "hh-c4")], ["partial", skepticPartial(1, "hh-c4")]]) {
    const repo = standard(`hh-c4-${state}`);
    brief(repo, "skeptic");
    assert.ok(!unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `${state}: listed before any helper ran:\n${check(repo)}`);

    start(repo, "A1", "skeptic");
    if (body) helperWrites(repo, "A1", "skeptic", "skeptic-1.md", body);
    const running = check(repo);
    assert.ok(!unfinishedLine(running, "skeptic-1.md", "skeptic"), `${state}: listed while the helper is still running:\n${running}`);
    assert.ok(!neverRecordedLine(running, "skeptic-1.md"), `${state}: reported as written but never recorded while the helper runs:\n${running}`);

    stop(repo, "A1", "skeptic");
    const stopped = check(repo);
    const line = unfinishedLine(stopped, "skeptic-1.md", "skeptic");
    assert.ok(line, `${state}: the stopped helper's unfinished skeptic-1.md is not listed with gate brief skeptic:\n${stopped}`);
    assert.match(line, /\bR15\b/, `${state}: the notice is not an R15 line: ${line}`);
  }

  // not vacuous the other way: a helper that stopped with a finished file is not unfinished
  const done = standard("hh-c4-finished");
  brief(done, "skeptic");
  start(done, "A1", "skeptic");
  helperWrites(done, "A1", "skeptic", "skeptic-1.md", skepticFile(1, "hh-c4-finished"));
  stop(done, "A1", "skeptic");
  assert.ok(!unfinishedLine(check(done), "skeptic-1.md", "skeptic"), `a finished file is listed as unfinished:\n${check(done)}`);
});

test("C5 idempotent: after the re-brief the unfinished notice is gone until the new helper stops unfinished too", () => {
  const repo = standard("hh-c5");
  brief(repo, "skeptic");
  start(repo, "A1", "skeptic");
  helperWrites(repo, "A1", "skeptic", "skeptic-1.md", skepticPartial(1, "hh-c5"));
  stop(repo, "A1", "skeptic");
  assert.ok(unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `premise: the stopped helper is listed:\n${check(repo)}`);

  assert.equal(brief(repo, "skeptic").name, "brief-skeptic-1.md");
  assert.ok(!unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `still listed right after the re-brief:\n${check(repo)}`);

  start(repo, "A2", "skeptic");
  assert.ok(!unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `listed while the fresh helper runs:\n${check(repo)}`);

  helperWrites(repo, "A2", "skeptic", "skeptic-1.md", skepticPartial(1, "hh-c5"));
  stop(repo, "A2", "skeptic");
  assert.ok(unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `the second unfinished stop is not listed:\n${check(repo)}`);
});

test("C6 refused: gate step skeptic done is refused with no recorded skeptic huddle, with a partial file, or with an open Act-on item, and accepted once the file is finished, recorded and every item closed; na still works below standard", () => {
  const repo = standard("hh-c6");
  const done = ["skeptic", "done", "huddled", "--evidence", "skeptic-1.md"];

  refused(repo, "step", done);
  assert.equal(stepOf(repo, "skeptic").state ?? null, null, "the step closed with no skeptic huddle");

  helperFile(repo, "skeptic-1.md", skepticPartial(1, "hh-c6"));
  refused(repo, "step", done);
  assert.equal(stepOf(repo, "skeptic").state ?? null, null, "the step closed on a partial file");

  helperFile(repo, "skeptic-1.md", skepticFile(1, "hh-c6"));
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  const open = refused(repo, "step", done);
  assert.ok(open.stderr.includes("H1.1"), `the refusal does not name the open item: ${open.stderr}`);
  assert.ok(open.stderr.includes(`H1.1 (${FIND_1.slice(0, 80)}`), `the refusal prints the item's text: ${open.stderr}`);
  assert.equal(stepOf(repo, "skeptic").state ?? null, null, "the step closed with an open Act-on item");

  cli(repo, "huddle", ["resolve", "H1.1", "--evidence", "src/a.ts:1"]);
  cli(repo, "step", done);
  assert.equal(stepOf(repo, "skeptic").state, "DONE");

  // a recorded file that went back to partial is not a finished file
  const back = standard("hh-c6-back");
  helperFile(back, "skeptic-1.md", skepticFile(1, "hh-c6-back", { actOn: [] }));
  cli(back, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  helperFile(back, "skeptic-1.md", skepticPartial(1, "hh-c6-back"));
  refused(back, "step", done);

  // below standard the step is N/A, and saying so by hand still works
  const tiny = committed("hh-c6-tiny");
  cli(tiny, "open", ["hh-c6-tiny", "feature"]);
  cli(tiny, "note", ["task", "One line. [inferred]"]);
  cli(tiny, "note", ["plan", "One file.", "--files", "src/a.ts"]);
  assert.equal(ledgerOf(tiny).tier.predicted, "tiny", "premise: a one-file plan predicts tiny");
  cli(tiny, "step", ["skeptic", "na", "one-line change, no design risk"]);
  assert.equal(stepOf(tiny, "skeptic").state, "N/A");
});

test("C7 happy: a bugfix and a refactor ledger have a skeptic step after cases; predicted tiny or small it is auto N/A, predicted standard it is required", () => {
  for (const playbook of ["bugfix", "refactor"]) {
    for (const [tier, extra] of [["tiny", []], ["small", ["--size", "small"]]]) {
      const repo = committed(`hh-c7-${playbook}-${tier}`);
      cli(repo, "open", [`hh-c7-${playbook}-${tier}`, playbook]);
      cli(repo, "note", ["task", "One small change. [inferred]"]);
      cli(repo, "note", ["plan", "One file.", "--files", "src/a.ts", ...extra]);
      const l = ledgerOf(repo);
      assert.equal(l.tier.predicted, tier, `premise: ${playbook} predicts ${tier}`);
      const keys = l.steps.map((s) => s.key);
      assert.ok(keys.includes("skeptic"), `${playbook}: no {skeptic} step: ${keys.join(", ")}`);
      assert.equal(keys.indexOf("skeptic"), keys.indexOf("cases") + 1, `${playbook}: {skeptic} is not right after {cases}: ${keys.join(", ")}`);
      assert.equal(stepOf(repo, "skeptic").state, "N/A", `${playbook} ${tier}: the skeptic step is not auto N/A`);
      assert.ok(l.tier.autoNa.includes("skeptic"), `${playbook} ${tier}: autoNa is ${JSON.stringify(l.tier.autoNa)}`);
    }

    const repo = standard(`hh-c7-${playbook}-standard`, playbook);
    const l = ledgerOf(repo);
    const step = l.steps.find((s) => s.key === "skeptic");
    assert.ok(step, `${playbook}: no {skeptic} step at standard`);
    assert.equal(step.state ?? null, null, `${playbook} standard: the skeptic step is not left open: ${step.state}`);
    assert.ok(!l.tier.autoNa.includes("skeptic"), `${playbook} standard: the skeptic step was dropped`);
    // required: it cannot be waved off as not applicable by the tier, and the blank step blocks
    const blank = lines(check(repo)).find((l2) => /step\(s\) blank/.test(l2));
    assert.ok(blank && blank.includes("{skeptic}"), `${playbook} standard: gate check does not ask for the skeptic step:\n${check(repo)}`);
  }
});

test("C8 reported-surface: two gate brief worker calls with different --files write brief-worker-1.md and brief-worker-2.md, each naming its own files and its own worker-<n>.md; the same --files twice reuses the number", () => {
  const repo = large("hh-c8");
  const dir = runDir(repo);

  const one = brief(repo, "worker", ["--files", "src/f0.ts,src/f1.ts"]);
  const two = brief(repo, "worker", ["--files", "src/f2.ts"]);
  assert.equal(one.name, "brief-worker-1.md");
  assert.equal(two.name, "brief-worker-2.md", "the second worker brief overwrote or shared the first packet");

  const first = readFileSync(path.join(dir, "brief-worker-1.md"), "utf8");
  const own1 = section(first, "Files you own");
  assert.ok(own1.includes("src/f0.ts") && own1.includes("src/f1.ts"), `packet 1 does not own its files:\n${own1}`);
  assert.ok(!own1.includes("src/f2.ts") && !own1.includes("src/f10.ts"), `packet 1 owns files it was not given:\n${own1}`);
  assert.ok(first.includes(path.join(dir, "worker-1.md")), "packet 1 does not name worker-1.md");
  assert.ok(!first.includes("worker-2.md"), "packet 1 names worker-2.md");

  const own2 = section(two.text, "Files you own");
  assert.ok(own2.includes("src/f2.ts"), `packet 2 does not own its file:\n${own2}`);
  assert.ok(!own2.includes("src/f0.ts") && !own2.includes("src/f1.ts"), `packet 2 owns packet 1's files:\n${own2}`);
  assert.ok(two.text.includes(path.join(dir, "worker-2.md")), "packet 2 does not name worker-2.md");
  assert.ok(!two.text.includes(path.join(dir, "worker-1.md")), "packet 2 names worker-1.md");

  const again = brief(repo, "worker", ["--files", "src/f0.ts,src/f1.ts"]);
  assert.equal(again.name, "brief-worker-1.md", "the same --files did not reuse its number");
  assert.ok(!existsSync(path.join(dir, "brief-worker-3.md")), "a third packet was written for a piece already briefed");
});

test("C9 reported-surface: gate huddle add reviewer prints each new id with its finding text; gate huddle reply with an id that does not exist fails and lists the open ids", () => {
  const repo = changed("hh-c9");
  helperFile(repo, "review-1.md", reviewFile(1, "hh-c9", { actOn: [FIND_1, FIND_2] }));
  const added = cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  for (const [id, text] of [["H1.1", FIND_1], ["H1.2", FIND_2]]) {
    assert.ok(
      lines(added.stdout).some((l) => l.includes(id) && l.includes(text)),
      `huddle add does not print ${id} with its finding text:\n${added.stdout}`,
    );
  }

  cli(repo, "huddle", ["resolve", "H1.2", "--evidence", "src/a.ts:2"]);
  helperFile(repo, "worker-1.md", "# Worker 1 — hh-c9\n\n## Replies\n- H9.9 — fixed: src/a.ts:1\n");
  const r = refused(repo, "huddle", ["reply", "--file", "worker-1.md"]);
  assert.ok(r.stderr.includes("H9.9"), `the refusal does not name the unknown id: ${r.stderr}`);
  assert.ok(r.stderr.includes("H1.1"), `the refusal does not list the open id H1.1: ${r.stderr}`);
  assert.ok(!r.stderr.includes("H1.2"), `the refusal lists the closed id H1.2 as open: ${r.stderr}`);
  const items = ledgerOf(repo).huddles.flatMap((h) => h.actOn);
  assert.equal(items.find((a) => a.id === "H1.1").closed, null, "the refused reply closed an item");
});

test("C10 boundary: skeptic and arbiter packets carry the number of the file they name, so the write guard owes the same file the packet names", () => {
  // two finished skeptic files on disk, one of them recorded: the next file is skeptic-3.md
  const repo = standard("hh-c10");
  const dir = runDir(repo);
  helperFile(repo, "skeptic-1.md", skepticFile(1, "hh-c10", { actOn: [] }));
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  helperFile(repo, "skeptic-2.md", skepticFile(2, "hh-c10", { actOn: [] }));

  const p = brief(repo, "skeptic");
  assert.ok(section(p.text, "You may write").includes(path.join(dir, "skeptic-3.md")), `premise: the packet names skeptic-3.md:\n${p.text.slice(0, 800)}`);
  assert.equal(p.name, "brief-skeptic-3.md", "the packet's number is not its file's number");
  assert.ok(p.prompt.includes(path.join(dir, "skeptic-3.md")), `the prompt does not name the same file: ${p.prompt}`);

  // the guard owes exactly that file: reading source first is denied, writing it is allowed
  const fence = (tool, file) => {
    const r = spawnSync(process.execPath, [gate, "fence"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "S1", cwd: repo, tool_name: tool, tool_input: { file_path: file }, agent_id: "A1", agent_type: "done-gate:skeptic" }),
      encoding: "utf8",
      env: envFor(repo),
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const denied = fence("Read", path.join(repo, "src/a.ts"));
  assert.ok(denied.includes("deny") && denied.includes("skeptic-3.md"), `the guard does not owe skeptic-3.md before anything else: ${denied || "(allowed)"}`);
  assert.ok(!fence("Write", path.join(dir, "skeptic-3.md")).includes("deny"), "the guard denies the file the packet names");

  // the arbiter: a finished arbiter-1.md is already on disk, so the next ruling is arbiter-2.md
  const arb = changed("hh-c10-arbiter");
  const adir = runDir(arb);
  helperFile(arb, "review-1.md", reviewFile(1, "hh-c10-arbiter"));
  cli(arb, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(arb, "huddle", ["dispute", "H1.1", "there is one caller only", "--evidence", "src/a.ts:1"]);
  helperFile(arb, "review-2.md", `# Review 2 — hh-c10-arbiter\n\n## Act on\n- none\n## Disputes\n- H1.1 — upheld: a second caller exists — src/app/page.tsx:1\n`);
  cli(arb, "huddle", ["add", "reviewer", "--file", "review-2.md"]);
  helperFile(arb, "arbiter-1.md", "# Arbiter 1 — hh-c10-arbiter\n\n## Ruling\n- H7.7 — reviewer: an older ruling\n");
  const a = brief(arb, "arbiter", ["--item", "H1.1"]);
  assert.ok(section(a.text, "You may write").includes(path.join(adir, "arbiter-2.md")), `premise: the packet names arbiter-2.md:\n${a.text.slice(0, 800)}`);
  assert.equal(a.name, "brief-arbiter-2.md", "the arbiter packet's number is not its file's number");
});

test("C11 happy: agent files — skeptic maxTurns 40 (stop at 38), reviewer and reviewer-2 60 (58), qa 60 (58), worker 100 (98); skeptic, reviewer and reviewer-2 say to rewrite the file after each finding; reviewer says not to number findings", () => {
  for (const [role, turns] of [["skeptic", 40], ["reviewer", 60], ["reviewer-2", 60], ["qa", 60], ["worker", 100]]) {
    const md = agentMd(role);
    assert.equal(maxTurnsOf(md), turns, `agents/${role}.md maxTurns`);
    assert.ok(bodyOf(md).includes(`You have ${turns} turns`), `agents/${role}.md does not say "You have ${turns} turns"`);
    assert.ok(bodyOf(md).includes(`By turn ${turns - 2}`), `agents/${role}.md has no "By turn ${turns - 2}" line`);
  }
  for (const role of ["skeptic", "reviewer", "reviewer-2"]) {
    assert.match(
      bodyOf(agentMd(role)),
      /rewrite[^.]{0,120}after (each|every)[^.]{0,40}finding|after (each|every)[^.]{0,60}finding[^.]{0,120}rewrite/i,
      `agents/${role}.md does not say to rewrite the file after each finding`,
    );
  }
  assert.match(
    bodyOf(agentMd("reviewer")),
    /(do not|don't|never) number[^.]{0,60}finding|finding[^.]{0,60}(not|never|un)\s?numbered/i,
    "agents/reviewer.md does not say not to number findings",
  );
});

test("C12 boundary: SKILL.md stays under 4096 bytes, names the hand-off and no longer says to SendMessage 'write <file> now'; a ledger opened before this change (seen without skeptic entries) still briefs and closes its skeptic step", () => {
  const skill = path.join(pluginRoot, "skills", "gate", "SKILL.md");
  const size = statSync(skill).size;
  assert.ok(size < 4096, `skills/gate/SKILL.md is ${size} bytes, the budget is 4096`);
  const md = readFileSync(skill, "utf8");
  assert.doesNotMatch(md, /write [^.]{0,40}\bnow\b/i, 'SKILL.md still carries the "write <file> now" nudge');
  assert.match(md, /brief[^.]{0,80}again|re-?brief/i, "SKILL.md does not say to brief the role again");
  assert.match(md, /fresh/i, "SKILL.md does not name the fresh helper");
  assert.match(md, /continues?\b/i, "SKILL.md does not say the fresh helper continues from the file");

  // a ledger from before: seen holds review pieces only, nothing records the skeptic brief
  const repo = standard("hh-c12");
  const strip = () => {
    const l = ledgerOf(repo);
    delete l.briefed;
    l.seen = { "review-1.md": { files: ["src/a.ts"], seq: 1 } };
    writeFileSync(ledgerPath(repo), JSON.stringify(l, null, 2));
  };
  strip();
  assert.equal(brief(repo, "skeptic").name, "brief-skeptic-1.md");
  // the old brief left no record of the skeptic file; its helper ran and stopped with no file
  strip();
  start(repo, "A1", "skeptic");
  stop(repo, "A1", "skeptic");
  assert.ok(!unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `a ledger from before is told its skeptic is unfinished:\n${check(repo)}`);

  helperFile(repo, "skeptic-1.md", skepticFile(1, "hh-c12", { actOn: [] }));
  cli(repo, "huddle", ["add", "skeptic", "--file", "skeptic-1.md"]);
  cli(repo, "step", ["skeptic", "done", "no findings", "--evidence", "skeptic-1.md"]);
  assert.equal(stepOf(repo, "skeptic").state, "DONE");
  const out = check(repo);
  assert.ok(!lines(out).some((l) => /\bR15\b/.test(l)), `R15 fires on the old ledger:\n${out}`);
});

test("C13 edge: a partial reviewer file whose helper is still running is not reported as written-but-unrecorded, and huddle add on it says the helper is still running", () => {
  const repo = changed("hh-c13");
  assert.equal(brief(repo, "reviewer").name, "brief-reviewer-1.md");
  start(repo, "R1", "reviewer");
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewPartial(1, "hh-c13"));

  const out = check(repo);
  assert.ok(!neverRecordedLine(out, "review-1.md"), `a partial file of a running reviewer is reported as never recorded:\n${out}`);
  assert.ok(!unfinishedLine(out, "review-1.md", "reviewer"), `a running reviewer is reported unfinished:\n${out}`);

  const r = refused(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.match(r.stderr, /still running/i, `the refusal does not say the helper is still running: ${r.stderr}`);
  assert.equal(huddlesOf(repo, "reviewer").length, 0, "the partial file was recorded");

  // once it stops unfinished, the same add names the re-brief instead
  stop(repo, "R1", "reviewer");
  const after = refused(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.ok(after.stderr.includes("gate brief reviewer"), `the refusal does not name the re-brief: ${after.stderr}`);
  assert.doesNotMatch(after.stderr, /still running/i);
});

test("C14 edge: two reviewers out on two pieces — one stops finished, the other still runs with a draft: the running one is not reported unfinished and its number is not reused by a new brief", () => {
  const repo = changed("hh-c14");
  assert.equal(brief(repo, "reviewer", ["--files", "src/a.ts"]).name, "brief-reviewer-1.md");
  start(repo, "R1", "reviewer");
  assert.equal(brief(repo, "reviewer", ["--files", "src/app/page.tsx"]).name, "brief-reviewer-2.md");
  start(repo, "R2", "reviewer");
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewDraft(1, "hh-c14"));
  helperWrites(repo, "R2", "reviewer", "review-2.md", reviewDraft(2, "hh-c14"));
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewFile(1, "hh-c14"));
  stop(repo, "R1", "reviewer");

  const out = check(repo);
  assert.ok(!unfinishedLine(out, "review-2.md", "reviewer"), `the running reviewer is reported unfinished:\n${out}`);
  assert.ok(!unfinishedLine(out, "review-1.md", "reviewer"), `the finished reviewer is reported unfinished:\n${out}`);

  const again = run(repo, "brief", ["reviewer", "--files", "src/app/page.tsx"]);
  assert.ok(!/GATE ERROR/.test(`${again.stdout}${again.stderr}`), `${again.stdout}${again.stderr}`);
  assert.ok(
    !/^packet: .*brief-reviewer-2\.md$/m.test(again.stdout),
    `a new brief reused the number of a reviewer that is still running:\n${again.stdout}`,
  );
  assert.equal(readFileSync(path.join(runDir(repo), "review-2.md"), "utf8"), reviewDraft(2, "hh-c14"));

  // once the second one stops with its draft, it is the unfinished one, and only it
  stop(repo, "R2", "reviewer");
  const later = check(repo);
  assert.ok(unfinishedLine(later, "review-2.md", "reviewer"), `the stopped reviewer's draft is not listed:\n${later}`);
  assert.ok(!unfinishedLine(later, "review-1.md", "reviewer"), later);
});

// Rewrites the session log with the chosen events of one agent moved `minutes` into the past.
function ageEvents(repo, minutes, which) {
  const events = readFileSync(eventsFile(repo), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const aged = events.map((e) => (which(e) ? { ...e, ts: new Date(Date.now() - minutes * 60 * 1000).toISOString() } : e));
  assert.ok(events.some(which), "premise: the session log holds an event to age");
  writeFileSync(eventsFile(repo), aged.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

test("C15 boundary: a helper whose every event is more than 45 minutes old, with no stop event and an unfinished file, is reported unfinished", () => {
  const repo = standard("hh-c15");
  brief(repo, "skeptic");
  start(repo, "A1", "skeptic");
  helperWrites(repo, "A1", "skeptic", "skeptic-1.md", skepticDraft(1, "hh-c15"));
  assert.ok(!unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `premise: a helper started just now counts as running:\n${check(repo)}`);

  // the helper is aged from its newest event (H3.1), so its edit ages with its start
  const age = (minutes) => ageEvents(repo, minutes, (e) => e.agent === "A1");

  age(44);
  assert.ok(!unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `a helper started 44 minutes ago is reported unfinished:\n${check(repo)}`);
  age(46);
  assert.ok(unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `a helper started 46 minutes ago with a draft and no stop is not reported:\n${check(repo)}`);
});

test("C16 happy: the continuation packet and prompt tell the helper to keep the finished sections and not reset the file; the three reading agent files say so too", () => {
  const KEEP = /keep[^.]{0,80}(finished|section)/i;
  const NO_RESET = /(never|not|don't)[^.]{0,60}reset/i;

  const repo = standard("hh-c16");
  const first = brief(repo, "skeptic");
  assert.doesNotMatch(first.prompt, NO_RESET, "a first brief has no file to keep");
  start(repo, "A1", "skeptic");
  helperWrites(repo, "A1", "skeptic", "skeptic-1.md", skepticPartial(1, "hh-c16"));
  stop(repo, "A1", "skeptic");

  const again = brief(repo, "skeptic");
  for (const [what, text] of [["packet", again.text], ["prompt", again.prompt]]) {
    assert.match(text, KEEP, `the continuation ${what} does not say to keep the finished sections:\n${text.slice(0, 1500)}`);
    assert.match(text, NO_RESET, `the continuation ${what} does not say not to reset the file:\n${text.slice(0, 1500)}`);
  }
  assert.doesNotMatch(again.prompt, /write it first/i, "the continuation prompt still tells the helper to write its file first");

  for (const role of ["skeptic", "reviewer", "reviewer-2"]) {
    const body = bodyOf(agentMd(role));
    assert.ok(body.includes("Continue from"), `agents/${role}.md does not name the packet's Continue from section`);
    assert.match(body, KEEP, `agents/${role}.md does not say to keep the finished sections`);
    assert.match(body, NO_RESET, `agents/${role}.md does not say not to reset the file`);
  }
});

test("C17 boundary: a ledger with no seen map that briefs a skeptic still has no seen map afterwards (briefed is separate)", () => {
  const repo = standard("hh-c17");
  assert.equal(ledgerOf(repo).seen, undefined, "premise: a fresh ledger has no seen map");
  brief(repo, "skeptic");
  const l = ledgerOf(repo);
  assert.equal(l.seen, undefined, `briefing a skeptic created a seen map: ${JSON.stringify(l.seen)}`);
  assert.ok(l.briefed && typeof l.briefed === "object", `the brief was not recorded under ledger.briefed: ${JSON.stringify(l.briefed)}`);
  assert.deepEqual(Object.keys(l.briefed), ["skeptic-1.md"]);
});

test("H3.1 edge: a helper that started 46 minutes ago and wrote its file just now is still running — not reported unfinished, and a new brief does not reuse its number", () => {
  const repo = standard("hh-h31");
  brief(repo, "skeptic");
  start(repo, "A1", "skeptic");
  helperWrites(repo, "A1", "skeptic", "skeptic-1.md", skepticPartial(1, "hh-h31"));
  ageEvents(repo, 46, (e) => e.kind === "subagent-start" && e.agent === "A1");

  const out = check(repo);
  assert.ok(!unfinishedLine(out, "skeptic-1.md", "skeptic"), `a helper that edited its file a moment ago is reported stopped:\n${out}`);
  assert.equal(brief(repo, "skeptic").name, "brief-skeptic-2.md", "a new brief reused the file a live helper is still writing");
  assert.equal(readFileSync(path.join(runDir(repo), "skeptic-1.md"), "utf8"), skepticPartial(1, "hh-h31"));

  // not vacuous: once its edit is that old too, it is gone
  ageEvents(repo, 46, (e) => e.agent === "A1");
  assert.ok(unfinishedLine(check(repo), "skeptic-1.md", "skeptic"), `a helper silent for 46 minutes is not reported:\n${check(repo)}`);
});

test("huddle add on a draft whose helper is still running says it is still running; once it stops the refusal names the re-brief", () => {
  const repo = changed("hh-draft-running");
  brief(repo, "reviewer");
  start(repo, "R1", "reviewer");
  helperWrites(repo, "R1", "reviewer", "review-1.md", reviewDraft(1, "hh-draft-running"));

  const r = refused(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.match(r.stderr, /still running/i, `the refusal does not say the helper is still running: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /gate brief reviewer/, "a running helper's draft is not handed to a fresh one");
  assert.equal(huddlesOf(repo, "reviewer").length, 0, "the draft was recorded");

  stop(repo, "R1", "reviewer");
  const after = refused(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  assert.ok(after.stderr.includes("gate brief reviewer"), `the refusal does not name the re-brief: ${after.stderr}`);
  assert.doesNotMatch(after.stderr, /still running/i);
});

test("a worker packet marks an open finding whose citation does not resolve, and leaves one that resolves unmarked", () => {
  const repo = large("hh-worker-unresolved");
  helperFile(repo, "review-1.md", reviewFile(1, "hh-worker-unresolved", { actOn: ["a caller is missed — src/gone.ts:9", "f0 drops the null case — src/f0.ts:1"] }));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  const open = section(brief(repo, "worker").text, "Open findings").split("\n");
  assert.match(open.find((l) => l.includes("H1.1")), /src\/gone\.ts:9, which does not resolve/);
  assert.doesNotMatch(open.find((l) => l.includes("H1.2")), /does not resolve/);
});

test("gate brief worker --files refuses an empty entry and a path outside the repo, and writes no packet", () => {
  const repo = large("hh-worker-files");
  for (const files of ["", "src/f0.ts,,src/f1.ts", "../elsewhere.ts", "src/f0.ts,/etc/hosts"]) {
    const r = refused(repo, "brief", ["worker", "--files", files]);
    assert.ok(r.stderr.includes("--files"), `the refusal for --files "${files}" does not name the flag: ${r.stderr}`);
    assert.ok(!r.stdout.includes("packet: "), `--files "${files}" wrote a packet:\n${r.stdout}`);
  }
  assert.equal(ledgerOf(repo).briefed, undefined, "a refused brief was recorded");
  assert.equal(brief(repo, "worker", ["--files", "src/f0.ts"]).name, "brief-worker-1.md");
});

test("a worker packet briefed with --files lists only the open findings that cite a file it owns; the packet with no --files lists the rest too", () => {
  const repo = large("hh-worker-findings");
  const OWN_0 = "f0 drops the null case — src/f0.ts:1";
  const OWN_1 = "f1 is never imported — src/f1.ts:1";
  const OWN_10 = "f10 shadows x — src/f10.ts:1";
  const NO_FILE = "the plan names no rollback";
  helperFile(repo, "review-1.md", reviewFile(1, "hh-worker-findings", { actOn: [OWN_0, OWN_1, OWN_10, NO_FILE] }));
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);

  const one = section(brief(repo, "worker", ["--files", "src/f0.ts"]).text, "Open findings");
  assert.ok(one.includes("H1.1") && one.includes(OWN_0), `the packet misses the finding on its own file:\n${one}`);
  for (const id of ["H1.2", "H1.3", "H1.4"]) assert.ok(!one.includes(id), `the packet for src/f0.ts lists ${id}:\n${one}`);

  // src/f1.ts is not src/f10.ts
  const two = section(brief(repo, "worker", ["--files", "src/f1.ts"]).text, "Open findings");
  assert.ok(two.includes("H1.2") && !two.includes("H1.3") && !two.includes("H1.1"), two);

  const rest = section(brief(repo, "worker").text, "Open findings");
  assert.ok(rest.includes("H1.4") && rest.includes(NO_FILE), `the finding that cites no file is in no packet:\n${rest}`);
});
