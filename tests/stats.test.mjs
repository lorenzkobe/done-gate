import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, pluginRoot, here } from "./helpers.mjs";
import { readsOnly } from "../scripts/lib/guard.mjs";
import { noticeCause } from "../scripts/lib/events.mjs";

const NOW = Date.now();
const iso = (daysAgo, plusMinutes = 0) => new Date(NOW - daysAgo * 864e5 + plusMinutes * 6e4).toISOString();

function stats(repo, args = []) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  return spawnSync(process.execPath, [gate, "stats", ...args], { encoding: "utf8", env });
}

function ok(repo, args = []) {
  const r = stats(repo, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const runsOf = (repo) => path.join(repo, ".claude", "gate", "runs");

function writeRun(repo, name, ledger) {
  const dir = path.join(runsOf(repo), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "ledger.json"), typeof ledger === "string" ? ledger : JSON.stringify(ledger));
}

// A closed run opened `daysAgo` days ago that took `minutes`, at `size` when one is given.
function closedRun({ daysAgo = 1, minutes = 10, size = "standard", ...rest } = {}) {
  return {
    status: "closed",
    version: "0.21.0",
    openedAt: iso(daysAgo),
    closedAt: iso(daysAgo, minutes),
    ...(size ? { tier: { measured: { tier: size } } } : {}),
    huddles: [],
    waivers: [],
    changedAtClose: [],
    ...rest,
  };
}

const planned = (files, over = {}) => ({ playbook: "feature", tier: { predictedFiles: files, measured: { tier: "standard" } }, ...over });
const line = (out, start) => out.split("\n").find((l) => l.trimStart().startsWith(start));

function snapshot(dir, out = {}) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) snapshot(p, out);
    else out[p] = `${s.mtimeMs} ${readFileSync(p, "utf8")}`;
  }
  return out;
}

test("C1 happy: runs by outcome and the median minutes per measured size", () => {
  const repo = makeRepo("stats-c1");
  writeRun(repo, "a", closedRun({ minutes: 10 }));
  writeRun(repo, "b", closedRun({ minutes: 30 }));
  writeRun(repo, "c", closedRun({ minutes: 50 }));
  writeRun(repo, "d", closedRun({ minutes: 20, size: "large" }));
  writeRun(repo, "e", closedRun({ minutes: 40, size: "large" }));
  writeRun(repo, "f", { status: "abandoned", openedAt: iso(1), version: "0.21.0" });
  writeRun(repo, "g", { status: "open", openedAt: iso(1), version: "0.21.0" });
  const out = ok(repo);
  assert.match(out, /stats-c1/);
  assert.match(line(out, "runs:"), /7 of 7 runs/);
  assert.match(line(out, "outcome:"), /5 closed, 1 abandoned, 1 open/);
  assert.match(line(out, "standard:"), /30 min \(3 of 5 runs\)/);
  assert.match(line(out, "large:"), /30 min \(2 of 5 runs\)/);
});

test("C2 edge: a ledger with no version is counted as such and --version leaves it out", () => {
  const repo = makeRepo("stats-c2");
  writeRun(repo, "old", closedRun({ version: undefined, minutes: 100 }));
  writeRun(repo, "new", closedRun({ version: "0.21.0", minutes: 10 }));
  writeRun(repo, "other", closedRun({ version: "0.20.0", minutes: 50 }));
  assert.match(line(ok(repo), "no version:"), /1 of 3 runs/);
  const only = ok(repo, ["--version", "0.21.0"]);
  assert.match(only, /version 0\.21\.0/);
  assert.match(line(only, "runs:"), /1 of 3 runs/);
  assert.match(line(only, "standard:"), /10 min \(1 of 1 runs\)/);
});

test("C3 edge: a closed run with no measured size is counted apart; a size with no runs prints missing", () => {
  const repo = makeRepo("stats-c3");
  writeRun(repo, "sized", closedRun({ minutes: 12 }));
  writeRun(repo, "unsized", closedRun({ size: null, minutes: 500 }));
  writeRun(repo, "weird", closedRun({ size: null, tier: { measured: { tier: "huge" } }, minutes: 500 }));
  const out = ok(repo);
  assert.match(line(out, "no measured size:"), /2 of 3 runs/);
  assert.match(line(out, "standard:"), /12 min \(1 of 3 runs\)/);
  assert.match(line(out, "tiny:"), /missing/);
  assert.match(line(out, "large:"), /missing/);
});

test("C4 edge: a closed-late run is left out of the medians and counted", () => {
  const repo = makeRepo("stats-c4");
  writeRun(repo, "late", closedRun({ closedLate: true, minutes: 9000 }));
  writeRun(repo, "fine", closedRun({ minutes: 20 }));
  writeRun(repo, "no-close-time", closedRun({ closedAt: undefined }));
  const out = ok(repo);
  assert.match(line(out, "standard:"), /20 min \(1 of 3 runs\)/);
  assert.match(line(out, "closed late, left out:"), /1 of 3 runs/);
  assert.match(line(out, "no usable close time:"), /1 of 3 runs/);
});

test("C5 edge: torn, non-object and undated ledgers count as unreadable and the rest still read", () => {
  const repo = makeRepo("stats-c5");
  writeRun(repo, "fine", closedRun());
  writeRun(repo, "torn", '{"status":"clos');
  writeRun(repo, "null", "null");
  writeRun(repo, "list", "[]");
  writeRun(repo, "undated", { status: "closed" });
  mkdirSync(path.join(runsOf(repo), "no-ledger"), { recursive: true });
  const out = ok(repo);
  assert.match(line(out, "runs:"), /1 of 1 runs/);
  assert.match(line(out, "unreadable ledgers:"), /4/);
  assert.ok(!existsSync(path.join(repo, ".claude", "gate", "gate-error.log")));
});

test("C6 edge: no state folder prints missing, exits 0, prints no 0 and creates nothing", () => {
  const repo = makeRepo("stats-c6");
  const out = ok(repo);
  assert.match(out, /missing/);
  assert.doesNotMatch(out, /\b0\b/);
  assert.ok(!existsSync(path.join(repo, ".claude", "gate")), "the verb created the state folder");
});

test("C17 edge: no run in the window prints missing, never 0", () => {
  const repo = makeRepo("stats-c17");
  writeRun(repo, "old", closedRun({ daysAgo: 400 }));
  const out = ok(repo);
  assert.match(line(out, "standard:"), /missing/);
  assert.match(line(out, "findings:"), /missing/);
  assert.match(line(out, "waivers:"), /missing/);
  assert.doesNotMatch(out, /\b0\b/);
});

test("C7 refused: a bad number, a missing value, an unknown flag and a stray word, with no gate error logged", () => {
  const repo = makeRepo("stats-c7");
  writeRun(repo, "fine", closedRun());
  for (const args of [["--days", "abc"], ["--days", "0"], ["--days", "-3"], ["--days", "1.5"], ["--days"], ["--version"], ["--version", "--days", "5"], ["--dayz", "5"], ["extra"], ["--days", "5", "extra"], ["--days", "5", "--days", "7"]]) {
    const r = stats(repo, args);
    assert.equal(r.status, 1, `${args.join(" ")} was not refused: ${r.stdout}`);
    assert.match(r.stderr, /usage: gate stats/, args.join(" "));
    assert.equal(r.stdout, "");
  }
  assert.ok(!existsSync(path.join(repo, ".claude", "gate", "gate-error.log")));
});

test("C8 boundary: --days keeps runs by openedAt, and the default is 30 days", () => {
  const repo = makeRepo("stats-c8");
  writeRun(repo, "recent", closedRun({ daysAgo: 1 }));
  writeRun(repo, "inside", closedRun({ daysAgo: 29 }));
  writeRun(repo, "outside", closedRun({ daysAgo: 31 }));
  const plain = ok(repo);
  assert.match(plain, /last 30 days/);
  assert.match(line(plain, "runs:"), /2 of 3 runs/);
  assert.match(line(ok(repo, ["--days", "2"]), "runs:"), /1 of 3 runs/);
  assert.match(line(ok(repo, ["--days", "60"]), "runs:"), /3 of 3 runs/);
});

test("C9 idempotent: the state folder is unchanged after a run, with an open run and a session present", () => {
  const repo = makeRepo("stats-c9");
  const state = path.join(repo, ".claude", "gate");
  writeRun(repo, "open-one", { status: "open", openedAt: iso(1), version: "0.21.0", sessions: ["S1"], huddles: [] });
  writeRun(repo, "closed-one", closedRun());
  mkdirSync(path.join(state, "sessions", "S1"), { recursive: true });
  writeFileSync(path.join(state, "sessions", "S1", "session.json"), JSON.stringify({ current: "open-one" }));
  writeFileSync(path.join(state, "current-session"), "S1");
  const before = snapshot(state);
  ok(repo);
  ok(repo, ["--days", "1", "--version", "0.21.0"]);
  stats(repo, ["--days", "abc"]);
  assert.deepEqual(snapshot(state), before);
});

const finding = (over = {}) => ({ id: "H1.1", text: "a finding", closed: "src/a.ts:1", ...over });

test("C10 happy: per role rounds, clean rounds, findings, closed as wrong, and a qa round with no file", () => {
  const repo = makeRepo("stats-c10");
  writeRun(repo, "one", closedRun({
    changedAtClose: ["tests/a.test.ts", "src/a.ts"],
    huddles: [
      { role: "skeptic", file: "skeptic-1.md", actOn: [finding(), finding({ closed: "tests/a.test.ts:name" })] },
      { role: "reviewer", file: "review-1.md", actOn: [] },
      { role: "reviewer", file: "review-2.md", actOn: [
        finding({ closed: "withdrawn (review-2.md)", dispute: { verdict: "withdrawn" } }),
        finding({ closed: "tests/a.test.ts:name" }),
      ] },
      { role: "reviewer-2", file: "review2-1.md", actOn: [finding({ closed: "overruled (arbiter-1.md)", dispute: { verdict: "arbiter:implementer" } })] },
      { role: "qa", actOn: [] },
    ],
  }));
  const out = ok(repo);
  assert.match(line(out, "skeptic:"), /rounds 1, clean 0, findings 2, closed as wrong at least 0, closed on a note 0, closed on a test 1/);
  assert.match(line(out, "reviewer:"), /rounds 2, clean 1, findings 2, closed as wrong at least 1, closed on a note 0, closed on a test 1/);
  assert.match(line(out, "reviewer-2:"), /rounds 1, clean 0, findings 1, closed as wrong at least 1, closed on a note 0, closed on a test 0/);
  assert.match(line(out, "qa:"), /rounds 1, by hand 1, clean 0, findings 0/);
  assert.match(line(out, "both reviewers:"), /rounds 3, clean 1, findings 3, closed as wrong at least 2, closed on a note 0, closed on a test 1/);
});

test("C18 edge: a finding dismissed on a decision or a plan note is counted apart, and wrong stays a floor", () => {
  const repo = makeRepo("stats-c18");
  writeRun(repo, "one", closedRun({
    changedAtClose: ["tests/a.test.ts"],
    huddles: [{ role: "reviewer", file: "review-1.md", actOn: [
      finding({ closed: "decisions#1" }),
      finding({ closed: "ledger.md#plan" }),
      finding({ closed: "tests/a.test.ts:name" }),
    ] }],
  }));
  assert.match(line(ok(repo), "reviewer:"), /findings 3, closed as wrong at least 0, closed on a note 2, closed on a test 1/);
});

test("C19 edge: a round with no file is not clean, and arbiter and worker rounds print no clean figure", () => {
  const repo = makeRepo("stats-c19");
  writeRun(repo, "one", closedRun({
    huddles: [
      { role: "skeptic", actOn: [] },
      { role: "skeptic", file: "skeptic-1.md", actOn: [] },
      { role: "arbiter", file: "arbiter-1.md", actOn: [] },
      { role: "worker", file: "worker-1.md", actOn: [] },
    ],
  }));
  const out = ok(repo);
  assert.match(line(out, "skeptic:"), /rounds 2, by hand 1, clean 1, findings 0/);
  assert.doesNotMatch(line(out, "arbiter:"), /clean/);
  assert.doesNotMatch(line(out, "worker:"), /clean/);
});

test("C11 edge: closed on a test needs a test path that the run changed", () => {
  const repo = makeRepo("stats-c11", { ".claude/gate.json": JSON.stringify({ testFiles: null, tests: ["tests/**"] }) });
  writeRun(repo, "one", closedRun({
    repos: [{ prefix: "../other", root: path.join(here, ".tmp", "stats-c11-other") }],
    changedAtClose: ["tests/changed.test.ts", "src/a.ts", "../other/tests/b.test.ts"],
    huddles: [{ role: "reviewer", file: "review-1.md", actOn: [
      finding({ closed: null }),
      finding({ closed: "withdrawn (review-1.md)", dispute: { verdict: "withdrawn" } }),
      finding({ closed: "src/a.ts:1" }),
      finding({ closed: "tests/unchanged.test.ts:name" }),
      finding({ closed: "events#17" }),
      finding({ closed: "tests/changed.test.ts:a test name with spaces" }),
      finding({ closed: "../other/tests/b.test.ts:12" }),
    ] }],
  }));
  assert.match(line(ok(repo), "reviewer:"), /findings 7, closed as wrong at least 1, closed on a note 0, closed on a test 2/);
});

test("C12 edge: a run with no findings is clean, not missing; a finding with no changed list is not judged", () => {
  const repo = makeRepo("stats-c12");
  writeRun(repo, "clean", closedRun({ huddles: [{ role: "reviewer", file: "review-1.md", actOn: [] }] }));
  const clean = ok(repo);
  assert.doesNotMatch(line(clean, "reviewer:"), /missing|not judged/);
  assert.match(line(clean, "runs with no findings:"), /1 of 1 runs/);

  const unseen = makeRepo("stats-c12b");
  writeRun(unseen, "no-round", closedRun());
  writeRun(unseen, "by-hand-only", closedRun({ huddles: [{ role: "qa", actOn: [] }] }));
  writeRun(unseen, "reviewed", closedRun({ huddles: [{ role: "reviewer", file: "review-1.md", actOn: [] }] }));
  const seen = ok(unseen);
  assert.match(line(seen, "runs with no findings:"), /1 of 3 runs/);
  assert.match(line(seen, "no helper round:"), /2 of 3 runs/);

  const noList = closedRun({ huddles: [{ role: "reviewer", file: "review-1.md", actOn: [finding({ closed: "tests/a.test.ts:name" })] }] });
  delete noList.changedAtClose;
  writeRun(repo, "no-list", noList);
  writeRun(repo, "late", closedRun({ closedLate: true, changedAtClose: [], huddles: [{ role: "reviewer", file: "review-2.md", actOn: [finding({ closed: "tests/a.test.ts:name" })] }] }));
  const out = line(ok(repo), "reviewer:");
  assert.match(out, /closed on a test missing/);
  assert.doesNotMatch(out, /closed on a test 0/);

  writeRun(repo, "known", closedRun({ changedAtClose: ["tests/a.test.ts"], huddles: [{ role: "reviewer", file: "review-3.md", actOn: [finding({ closed: "tests/a.test.ts:name" })] }] }));
  assert.match(line(ok(repo), "reviewer:"), /closed on a test 1, not judged 2 of 3/);
});

test("C13 edge: a damaged huddle list or a null finding does not crash the verb", () => {
  const repo = makeRepo("stats-c13");
  writeRun(repo, "no-huddles", closedRun({ huddles: "oops", waivers: "oops" }));
  writeRun(repo, "null-huddle", closedRun({ huddles: [null], waivers: [null] }));
  writeRun(repo, "null-finding", closedRun({ huddles: [{ role: "reviewer", actOn: [null] }] }));
  writeRun(repo, "no-act-on", closedRun({ huddles: [{ role: "reviewer" }] }));
  writeRun(repo, "bad-tier", closedRun({ size: null, tier: "oops" }));
  const out = ok(repo);
  assert.match(line(out, "runs:"), /5 of 5 runs/);
  assert.ok(!existsSync(path.join(repo, ".claude", "gate", "gate-error.log")));
});

test("C14 edge: a bad gate.json prints closed on a test as missing and does not crash", () => {
  const repo = makeRepo("stats-c14", { ".claude/gate.json": "{ not json" });
  writeRun(repo, "one", closedRun({ changedAtClose: ["tests/a.test.ts"], huddles: [{ role: "reviewer", file: "review-1.md", actOn: [finding({ closed: "tests/a.test.ts:name" })] }] }));
  const out = line(ok(repo), "reviewer:");
  assert.match(out, /findings 1, closed as wrong at least 0, closed on a note 0, closed on a test missing/);
  assert.ok(!existsSync(path.join(repo, ".claude", "gate", "gate-error.log")));
});

test("C15 happy: waivers by key and per run; could-not-run and lapsed print not recorded", () => {
  const repo = makeRepo("stats-c15");
  writeRun(repo, "one", closedRun({ waivers: [{ key: "driver", reason: "x" }, { key: "driver", reason: "y" }, { key: "review-2", reason: "z" }] }));
  writeRun(repo, "two", closedRun());
  const out = ok(repo);
  assert.match(line(out, "waivers:"), /3 in 2 closed runs, 1\.5 per run/);
  assert.match(line(out, "by key:"), /driver 2, review-2 1/);
  assert.match(line(out, "could-not-run waivers:"), /not recorded/);
  assert.match(line(out, "lapsed waivers:"), /not recorded/);

  const none = makeRepo("stats-c15b");
  writeRun(none, "two", closedRun());
  assert.match(line(ok(none), "waivers:"), /none in 1 closed runs/);
});

test("C16 reported surface: help and README name the verb, and the fence reads it as a gate call", () => {
  const repo = makeRepo("stats-c16");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" };
  assert.match(spawnSync(process.execPath, [gate, "help"], { encoding: "utf8", env }).stdout, /^ {2}stats /m);
  assert.match(readFileSync(path.join(pluginRoot, "README.md"), "utf8"), /`stats \[--days n\] \[--version x\]`/);
  assert.equal(readsOnly(`node ${gate} stats --days 7`), true);
});

test("C21 happy: code outside the plan counts runs, the median extra and one-file-only", () => {
  const repo = makeRepo("stats-p1");
  writeRun(repo, "inside", closedRun({ ...planned(["src/a.ts"]), changedAtClose: ["src/a.ts"] }));
  writeRun(repo, "one-extra", closedRun({ ...planned(["src/a.ts"], { playbook: "bugfix" }), changedAtClose: ["src/a.ts", "src/b.ts"] }));
  writeRun(repo, "three-extra", closedRun({ ...planned(["src/a.ts"], { playbook: "refactor" }), changedAtClose: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] }));
  const out = ok(repo);
  assert.match(line(out, "code outside the plan:"), /2 of 3 runs/);
  assert.match(line(out, "median extra files:"), /2/);
  assert.match(line(out, "one file only:"), /1 of 2 runs/);
});

test("C22 edge: a test or docs extra is not code outside the plan", () => {
  const repo = makeRepo("stats-p2");
  writeRun(repo, "one", closedRun({ ...planned(["src/a.ts"]), changedAtClose: ["src/a.ts", "tests/a.test.ts", "docs/notes.md"] }));
  assert.match(line(ok(repo), "code outside the plan:"), /0 of 1 runs/);
});

test("C23 edge: a declared repo's paths are read with its prefix", () => {
  const repo = makeRepo("stats-p3");
  const repos = [{ prefix: "../other", root: path.join(here, ".tmp", "stats-p3-other") }];
  writeRun(repo, "one", closedRun({ ...planned(["../other/src/a.ts"]), repos, changedAtClose: ["../other/src/a.ts", "../other/src/b.ts", "../other/tests/b.test.ts"] }));
  const out = ok(repo);
  assert.match(line(out, "code outside the plan:"), /1 of 1 runs/);
  assert.match(line(out, "median extra files:"), /1/);
});

test("C24 edge: a plan with no file list prints no list", () => {
  const repo = makeRepo("stats-p4");
  writeRun(repo, "listed", closedRun({ ...planned(["src/a.ts"]), changedAtClose: ["src/a.ts"] }));
  writeRun(repo, "empty", closedRun({ ...planned([]), changedAtClose: ["src/a.ts"] }));
  writeRun(repo, "absent", closedRun({ playbook: "feature", changedAtClose: ["src/a.ts"] }));
  const out = ok(repo);
  assert.match(line(out, "code outside the plan:"), /0 of 1 runs/);
  assert.match(line(out, "no list:"), /2 of 3 runs/);
});

test("C25 edge: an abandoned run or a closed run with no changed list is not judged; nothing judged prints missing", () => {
  const repo = makeRepo("stats-p5");
  writeRun(repo, "abandoned", { status: "abandoned", openedAt: iso(1), ...planned(["src/a.ts"]) });
  const noList = closedRun(planned(["src/a.ts"]));
  delete noList.changedAtClose;
  writeRun(repo, "no-changed", noList);
  writeRun(repo, "late", closedRun({ ...planned(["src/a.ts"]), closedLate: true, changedAtClose: [] }));
  const out = ok(repo);
  assert.match(line(out, "code outside the plan:"), /missing/);
  assert.match(line(out, "no changed list:"), /2 of 2 runs/);
});

test("C26 edge: a bad gate.json prints code outside the plan and bugs after close as missing", () => {
  const repo = makeRepo("stats-p6", { ".claude/gate.json": "{ not json" });
  writeRun(repo, "one", closedRun({ ...planned(["src/a.ts"]), changedAtClose: ["src/a.ts", "src/b.ts"] }));
  writeRun(repo, "bug", closedRun({ ...planned(["src/a.ts"], { playbook: "bugfix" }), changedAtClose: ["src/a.ts"] }));
  const out = ok(repo);
  assert.match(line(out, "code outside the plan:"), /missing/);
  assert.match(line(out, "bugs after close (estimate):"), /missing/);
  assert.ok(!existsSync(path.join(repo, ".claude", "gate", "gate-error.log")));
});

test("C27 edge: plan and investigation runs are left out of code outside the plan", () => {
  const repo = makeRepo("stats-p7");
  writeRun(repo, "plan", closedRun({ ...planned(["docs/a.md"], { playbook: "plan" }), changedAtClose: ["src/a.ts"] }));
  writeRun(repo, "look", closedRun({ ...planned(["docs/a.md"], { playbook: "investigation" }), changedAtClose: ["src/a.ts"] }));
  writeRun(repo, "feature", closedRun({ ...planned(["src/a.ts"]), changedAtClose: ["src/a.ts"] }));
  assert.match(line(ok(repo), "code outside the plan:"), /0 of 1 runs/);
});

function largeRun(repo, name, { minutes, lines, findings = 0, workers = false, role = "reviewer" }) {
  writeRun(repo, name, closedRun({
    minutes,
    size: null,
    tier: { measured: { tier: "large", lines } },
    huddles: [{ role, file: "review-1.md", actOn: Array.from({ length: findings }, () => finding()) }],
  }));
  if (workers) writeFileSync(path.join(runsOf(repo), name, "worker-1.md"), "answers\n");
}

test("C28 happy: large runs split by worker files, with median minutes and findings per 100 lines", () => {
  const repo = makeRepo("stats-p8");
  largeRun(repo, "w1", { minutes: 30, lines: 500, findings: 5, workers: true });
  largeRun(repo, "w2", { minutes: 50, lines: 500, findings: 1, workers: true, role: "reviewer-2" });
  largeRun(repo, "lead", { minutes: 20, lines: 1000, findings: 1 });
  const out = ok(repo);
  assert.match(line(out, "with workers:"), /2 of 3 runs, median 40 min, 0\.6 findings per 100 lines/);
  assert.match(line(out, "without workers:"), /1 of 3 runs, median 20 min, 0\.1 findings per 100 lines/);

  const briefed = makeRepo("stats-p8d");
  largeRun(briefed, "brief-only", { minutes: 15, lines: 100 });
  writeFileSync(path.join(runsOf(briefed), "brief-only", "brief-worker-1.md"), "packet\n");
  assert.match(line(ok(briefed), "with workers:"), /1 of 1 runs, median 15 min/);

  const none = makeRepo("stats-p8b");
  largeRun(none, "lead", { minutes: 20, lines: 1000 });
  assert.match(line(ok(none), "with workers:"), /missing/);

  const small = makeRepo("stats-p8c");
  writeRun(small, "one", closedRun());
  assert.match(line(ok(small), "large runs:"), /missing/);
});

test("C29 edge: a large run with no measured lines is left out of findings per 100 lines", () => {
  const repo = makeRepo("stats-p9");
  largeRun(repo, "known", { minutes: 10, lines: 100, findings: 2 });
  largeRun(repo, "unknown", { minutes: 30, lines: undefined, findings: 50 });
  assert.match(line(ok(repo), "without workers:"), /2 of 2 runs, median 20 min, 2 findings per 100 lines/);

  const onlyUnknown = makeRepo("stats-p9b");
  largeRun(onlyUnknown, "unknown", { minutes: 30, lines: undefined, findings: 50 });
  assert.match(line(ok(onlyUnknown), "without workers:"), /1 of 1 runs, median 30 min, findings per 100 lines missing/);
});

const bugfixRun = (daysAgo, changedAtClose, over = {}) => closedRun({ daysAgo, playbook: "bugfix", changedAtClose, ...over });

test("C30 happy: a bugfix overlapping a run closed in the 30 days before it counts, labelled an estimate, with names", () => {
  const repo = makeRepo("stats-b1");
  writeRun(repo, "2026-01-02-first", closedRun({ daysAgo: 5, changedAtClose: ["src/a.ts"] }));
  writeRun(repo, "2026-01-03-fix-a", bugfixRun(1, ["src/a.ts"]));
  writeRun(repo, "2026-01-04-fix-b", bugfixRun(1, ["src/z.ts"]));
  const out = ok(repo);
  assert.match(line(out, "bugs after close (estimate):"), /1 of 3 runs/);
  assert.match(line(out, "runs:"), /3 of 3/);
  assert.match(line(out, "named:"), /2026-01-03-fix-a/);
  assert.doesNotMatch(line(out, "named:"), /fix-b|first/);
});

test("C31 boundary: an earlier run outside --days or of another version counts; one closed 31 days before does not", () => {
  const repo = makeRepo("stats-b2");
  writeRun(repo, "older", closedRun({ daysAgo: 20, version: "0.20.0", changedAtClose: ["src/a.ts"] }));
  writeRun(repo, "fix", bugfixRun(1, ["src/a.ts"]));
  assert.match(line(ok(repo, ["--days", "2", "--version", "0.21.0"]), "bugs after close (estimate):"), /1 of 1 runs/);

  const far = makeRepo("stats-b2b");
  writeRun(far, "older", closedRun({ daysAgo: 33, minutes: 0, changedAtClose: ["src/a.ts"] }));
  writeRun(far, "fix", bugfixRun(1, ["src/a.ts"]));
  assert.match(line(ok(far, ["--days", "2"]), "bugs after close (estimate):"), /0 of 1 runs/);
});

test("C32 edge: an abandoned earlier run and overlap only in tests do not count; a later feature run is not a bug; a run does not match itself", () => {
  const repo = makeRepo("stats-b3");
  writeRun(repo, "abandoned", { status: "abandoned", openedAt: iso(10), closedAt: iso(9), changedAtClose: ["src/a.ts"] });
  writeRun(repo, "tests-only", closedRun({ daysAgo: 8, changedAtClose: ["tests/a.test.ts"] }));
  writeRun(repo, "fix-tests", bugfixRun(3, ["tests/a.test.ts"]));
  writeRun(repo, "fix-self", bugfixRun(2, ["src/a.ts"]));
  writeRun(repo, "feature-after", closedRun({ daysAgo: 1, changedAtClose: ["src/a.ts"] }));
  assert.match(line(ok(repo), "bugs after close (estimate):"), /0 of 4 runs/);
});

test("C32b edge: an earlier feature run counts as the earlier run", () => {
  const repo = makeRepo("stats-b5");
  writeRun(repo, "first", closedRun({ daysAgo: 5, playbook: "feature", changedAtClose: ["src/a.ts"] }));
  writeRun(repo, "fix", bugfixRun(1, ["src/a.ts"]));
  assert.match(line(ok(repo), "bugs after close (estimate):"), /1 of 2 runs/);
});

test("C35 edge: a closed-late run is left out of all three blocks", () => {
  const repo = makeRepo("stats-b6");
  writeRun(repo, "late-feature", closedRun({ ...planned(["src/a.ts"]), closedLate: true, minutes: 2000, changedAtClose: ["src/a.ts", "src/b.ts"] }));
  writeRun(repo, "late-large", closedRun({ size: null, tier: { measured: { tier: "large", lines: 10 } }, closedLate: true, minutes: 9000 }));
  writeRun(repo, "late-fix", bugfixRun(1, ["src/a.ts"], { closedLate: true }));
  const out = ok(repo);
  assert.match(line(out, "code outside the plan:"), /missing/);
  assert.match(line(out, "large runs:"), /missing/);
  assert.match(line(out, "bugs after close (estimate):"), /missing/);

  writeRun(repo, "fix", bugfixRun(0.5, ["src/a.ts"]));
  assert.match(line(ok(repo), "bugs after close (estimate):"), /0 of 1 runs/, "a closed-late earlier run must not count");
});

test("C36 edge: a declared repo's bad gate.json leaves that run not judged and the others still count", () => {
  const repo = makeRepo("stats-b7");
  const other = path.join(here, ".tmp", "stats-b7-other");
  rmSync(other, { recursive: true, force: true });
  mkdirSync(path.join(other, ".claude"), { recursive: true });
  writeFileSync(path.join(other, ".claude", "gate.json"), "{ not json");
  writeRun(repo, "bad", closedRun({ ...planned(["src/a.ts"]), repos: [{ prefix: "../stats-b7-other", root: other }], changedAtClose: ["src/a.ts", "src/b.ts"] }));
  writeRun(repo, "good", closedRun({ ...planned(["src/a.ts"]), changedAtClose: ["src/a.ts", "src/b.ts"] }));
  const out = ok(repo);
  assert.match(line(out, "code outside the plan:"), /1 of 1 runs/);
  assert.match(line(out, "no usable gate.json:"), /1 of 2 runs/);
  assert.ok(!existsSync(path.join(repo, ".claude", "gate", "gate-error.log")));
});

test("C37 boundary: closed after the bugfix opened does not count, exactly 30 days before does, an unparseable closedAt does not", () => {
  const after = makeRepo("stats-b8");
  writeRun(after, "overlapping", closedRun({ daysAgo: 3, minutes: 4 * 24 * 60 - 60, changedAtClose: ["src/a.ts"] }));
  writeRun(after, "fix", bugfixRun(1, ["src/a.ts"]));
  assert.match(line(ok(after), "bugs after close (estimate):"), /0 of 2 runs/);

  const exactly = makeRepo("stats-b8b");
  writeRun(exactly, "older", closedRun({ daysAgo: 31, minutes: 0, changedAtClose: ["src/a.ts"] }));
  writeRun(exactly, "fix", bugfixRun(1, ["src/a.ts"]));
  assert.match(line(ok(exactly, ["--days", "2"]), "bugs after close (estimate):"), /1 of 1 runs/);

  const garbled = makeRepo("stats-b8c");
  writeRun(garbled, "older", closedRun({ daysAgo: 5, closedAt: "soon", changedAtClose: ["src/a.ts"] }));
  writeRun(garbled, "fix", bugfixRun(1, ["src/a.ts"]));
  assert.match(line(ok(garbled), "bugs after close (estimate):"), /0 of 2 runs/);
});

test("C33 edge: a bugfix run with no changed list is not judged, never counted as no bug", () => {
  const repo = makeRepo("stats-b4");
  writeRun(repo, "earlier", closedRun({ daysAgo: 5, changedAtClose: ["src/a.ts"] }));
  const fix = bugfixRun(1, []);
  delete fix.changedAtClose;
  writeRun(repo, "fix", fix);
  assert.match(line(ok(repo), "bugs after close (estimate):"), /missing/);

  writeRun(repo, "fix-known", bugfixRun(1, ["src/a.ts"]));
  assert.match(line(ok(repo), "bugs after close (estimate):"), /1 of 3 runs, not judged 1 of 2 bugfix runs/);
});

test("C34 idempotent: the state folder stays unchanged with worker files present", () => {
  const repo = makeRepo("stats-p10");
  largeRun(repo, "w1", { minutes: 30, lines: 500, findings: 5, workers: true });
  const state = path.join(repo, ".claude", "gate");
  const before = snapshot(state);
  ok(repo);
  assert.deepEqual(snapshot(state), before);
});

// Events: a run opened a day ago, an hour long, and events placed by the minute within it.
const OPEN_AT = NOW - 864e5;
const seqAt = (minute) => Math.round((OPEN_AT + minute * 6e4) * 1000);

function hourRun(sessions = ["S1"], over = {}) {
  return closedRun({
    openedAt: new Date(OPEN_AT).toISOString(),
    closedAt: new Date(OPEN_AT + 60 * 6e4).toISOString(),
    openedSeq: seqAt(0),
    sessions,
    ...over,
  });
}

function writeEvents(repo, session, events) {
  const dir = path.join(repo, ".claude", "gate", "sessions", session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => (typeof e === "string" ? e : JSON.stringify({ session, agent: null, ...e }))).join("\n") + "\n");
}

const reviewerStart = (minute, agent = "r1", agentType = "done-gate:reviewer") => ({ seq: seqAt(minute), kind: "subagent-start", agent, agentType });
const stopAt = (minute, agent = "r1", agentType = "") => ({ seq: seqAt(minute), kind: "subagent-stop", agent, agentType });
const userPrompt = (minute, text = "do the thing") => ({ seq: seqAt(minute), kind: "prompt", text });
const block = (minute, rules) => ({ seq: seqAt(minute), kind: "block", rules });
const deny = (minute, reason, over = {}) => ({ seq: seqAt(minute), kind: "deny", delegate: false, reason, ...over });

test("C40 happy: events coverage counts runs with events; a pruned session gives 1 of 2", () => {
  const repo = makeRepo("stats-e1");
  writeRun(repo, "kept", hourRun(["S1"]));
  writeRun(repo, "pruned", hourRun(["S2"]));
  writeEvents(repo, "S1", [userPrompt(1)]);
  assert.match(line(ok(repo), "events:"), /1 of 2 runs/);
});

test("C41 edge: no sessions folder prints missing on every event line, and a torn event line is dropped", () => {
  const repo = makeRepo("stats-e2");
  writeRun(repo, "one", hourRun());
  const out = ok(repo);
  for (const start of ["events:", "refusals:", "turns stopped:", "reviewer time:", "review wait:", "helper failures:"]) {
    assert.match(line(out, start), /missing/, start);
  }
  assert.match(line(out, "lead-turn failures:"), /not recorded/);

  writeEvents(repo, "S1", [userPrompt(1), '{"seq":1,"kind":"blo', block(2, ["R5"])]);
  const torn = ok(repo);
  assert.match(line(torn, "events:"), /1 of 1 runs/);
  assert.match(line(torn, "R5"), /1 turn/);
});

test("C42 edge: a session id with path characters is skipped", () => {
  const repo = makeRepo("stats-e3");
  writeRun(repo, "one", hourRun(["../../outside"]));
  writeEvents(repo, "../../outside", [userPrompt(1)]);
  assert.match(line(ok(repo), "events:"), /missing/);

  const dots = makeRepo("stats-e3b");
  writeRun(dots, "one", hourRun([".."]));
  assert.match(line(ok(dots), "events:"), /missing/);

  const real = makeRepo("stats-e3c");
  const id = "f11efdf8-5224-47ea-acf5-f5a0a35768c3";
  writeRun(real, "one", hourRun([id]));
  writeEvents(real, id, [userPrompt(1)]);
  assert.match(line(ok(real), "events:"), /1 of 1 runs/);
});

test("C43 happy: refusals leave hand-offs out, count read-beside apart, group the rest, and split lead from helper", () => {
  const repo = makeRepo("stats-e4");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [
    deny(1, "done-gate: size large: the lead does not edit source", { delegate: true }),
    deny(2, "done-gate: reading the gate folder beside `npm test` is refused, because the fence cannot tell"),
    deny(3, "done-gate: that command writes gate evidence files (.claude/gate/...): `x` is not a plain read. Evidence"),
    deny(4, "done-gate: helpers write through the shell only under the tests", { agent: "h1", agentType: "done-gate:qa" }),
    deny(5, "done-gate: helpers write through the shell only under a run"),
    deny(6, "done-gate: helpers write through the other wording", { agent: "h1" }),
    deny(7, "done-gate: that command writes gate evidence files (.claude/gate/...): `cat > .claude/gate/runs/a/worker-4.md <<EOF` is not a plain read. Evidence"),
  ]);
  const out = ok(repo);
  assert.match(line(out, "refusals:"), /6, hand-offs left out/);
  assert.match(line(out, "read beside another command:"), /lead 2, helper 0/);
  assert.match(line(out, "helpers write through the:"), /lead 1, helper 2/);
  assert.match(line(out, "that command writes gate:"), /lead 1, helper 0/);

  const named = makeRepo("stats-e4b");
  writeRun(named, "one", hourRun());
  writeEvents(named, "S1", [
    deny(1, "done-gate: that command writes tests/a.test.ts, which is a file"),
    deny(2, "done-gate: that command writes shot.mjs (in a folder)"),
    deny(3, "done-gate: .claude/gate/runs/x/review2-8.md is a helper's own file"),
    deny(4, "done-gate: write your draft first: .claude/gate/runs/x/review-2.md (every section"),
  ]);
  const grouped = ok(named);
  assert.match(line(grouped, "that command writes <file>:"), /lead 2, helper 0/);
  assert.match(line(grouped, "<file> is a helper's:"), /lead 1/);
  assert.match(line(grouped, "write your draft first:"), /^ *write your draft first: lead 1/);
});

test("C44 happy: turns stopped per rule count each rule once a turn and print its meaning", () => {
  const repo = makeRepo("stats-e5");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [
    userPrompt(1),
    block(2, ["R5", "R5", "R8"]),
    block(3, ["R5"]),
    userPrompt(4),
    block(5, ["R5"]),
  ]);
  const out = ok(repo);
  assert.match(line(out, "turns stopped:"), /2 of 2 turns/);
  assert.match(line(out, "R5"), /no review after the last change[^:]*: 2 turns/);
  assert.match(line(out, "R8"), /1 turn$/);
});

test("C45 edge: a hand-back, a task notification and a system notification start no turn", () => {
  const repo = makeRepo("stats-e6");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [
    userPrompt(1),
    block(2, ["R5"]),
    { ...userPrompt(3, "<agent-message from=\"x\">done</agent-message>"), handback: true },
    block(4, ["R5"]),
    userPrompt(5, "<agent-message from=\"y\">no tag, an older record</agent-message>"),
    block(6, ["R5"]),
    userPrompt(7, "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is automated.\n\n<task-notification><status>completed</status><summary>Agent \"a\" finished</summary></task-notification>"),
    block(8, ["R5"]),
    { ...userPrompt(9, "a helper's own prompt"), agent: "h1" },
    block(10, ["R5"]),
  ]);
  assert.match(line(ok(repo), "R5"), /: 1 turn$/);

  const next = makeRepo("stats-e6b");
  writeRun(next, "one", hourRun());
  writeEvents(next, "S1", [userPrompt(1), block(2, ["R5"]), userPrompt(3), block(4, ["R5"])]);
  assert.match(line(ok(next), "R5"), /: 2 turns$/);
});

test("C46 edge: events outside the run's stretch are not counted", () => {
  const repo = makeRepo("stats-e7");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [
    deny(-5, "done-gate: helpers write through the before"),
    block(-4, ["R5"]),
    userPrompt(1),
    block(70, ["R8"]),
    deny(70, "done-gate: helpers write through the after"),
  ]);
  const out = ok(repo);
  assert.equal(line(out, "R5"), undefined);
  assert.equal(line(out, "R8"), undefined);
  assert.match(line(out, "refusals:"), /none/);
});

test("C54 edge: an event in two overlapping run stretches counts once, and a turn crossing a close counts once", () => {
  const repo = makeRepo("stats-e13");
  writeRun(repo, "one", hourRun());
  writeRun(repo, "overlap", hourRun());
  writeEvents(repo, "S1", [userPrompt(1), block(2, ["R5"]), deny(3, "done-gate: helpers write through the x")]);
  const out = ok(repo);
  assert.match(line(out, "refusals:"), /^refusals: 1,/);
  assert.match(line(out, "R5"), /: 1 turn$/);

  const crossing = makeRepo("stats-e13b");
  writeRun(crossing, "first", hourRun(["S1"], { closedAt: new Date(OPEN_AT + 20 * 6e4).toISOString() }));
  writeRun(crossing, "second", hourRun(["S1"], { openedAt: new Date(OPEN_AT + 21 * 6e4).toISOString(), openedSeq: seqAt(21) }));
  writeEvents(crossing, "S1", [userPrompt(1), block(10, ["R5"]), block(30, ["R5"])]);
  assert.match(line(ok(crossing), "R5"), /: 1 turn$/);
});

test("C55 edge: a closed-late run is left out of reviewer time and review wait", () => {
  const repo = makeRepo("stats-e14");
  writeRun(repo, "late", hourRun(["S1"], { closedLate: true }));
  writeEvents(repo, "S1", [reviewerStart(1), stopAt(30)]);
  const out = ok(repo);
  assert.match(line(out, "events:"), /1 of 1 runs/);
  assert.match(line(out, "reviewer time:"), /missing/);
  assert.match(line(out, "review wait:"), /missing/);
});

test("C56 edge: a block outside every run prints as outside any run, at least n, and not with --version", () => {
  const repo = makeRepo("stats-e15");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [block(-10, ["R1"]), userPrompt(1), block(2, ["R5"]), userPrompt(70), block(71, ["R1"]), block(72, ["R1"])]);
  const out = ok(repo);
  assert.equal(line(out, "R1"), undefined);
  assert.match(line(out, "outside any run:"), /at least 2 turns \(R1 2\)/);
  assert.equal(line(ok(repo, ["--version", "0.21.0"]), "outside any run:"), undefined);

  const another = makeRepo("stats-e15b");
  writeRun(another, "one", hourRun());
  writeRun(another, "older", hourRun(["S1"], { daysAgo: 40, openedAt: iso(40), closedAt: iso(40, 60), openedSeq: Math.round((NOW - 40 * 864e5) * 1000) }));
  writeEvents(another, "S1", [{ ...block(0, ["R8"]), seq: Math.round((NOW - 40 * 864e5 + 6e4) * 1000) }, userPrompt(1)]);
  assert.equal(line(ok(another), "outside any run:"), undefined);
});

test("C57 edge: a rule with no plain meaning prints its name alone", () => {
  const repo = makeRepo("stats-e16");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [userPrompt(1), block(2, ["R99"])]);
  const out = ok(repo);
  assert.equal(line(out, "R99"), "  R99: 1 turn");
  assert.doesNotMatch(out, /undefined/);
});

test("C47 happy: reviewer time pairs by agent id, excludes a resumed helper's gap, and counts overlap once", () => {
  const repo = makeRepo("stats-e8");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [
    reviewerStart(1, "r1"),
    stopAt(7, "r1"),
    reviewerStart(30, "r1"),
    stopAt(36, "r1", "done-gate:reviewer"),
    reviewerStart(33, "r2", "done-gate:reviewer-2"),
    stopAt(39, "r2"),
  ]);
  assert.match(line(ok(repo), "reviewer time:"), /25% of 60 run minutes \(1 of 1 runs\)/);
});

test("C48 edge: a start with no stop is left out and counted; a skeptic's time is not reviewer time", () => {
  const repo = makeRepo("stats-e9");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [
    reviewerStart(1, "r1"),
    reviewerStart(10, "r1"),
    stopAt(16, "r1"),
    reviewerStart(20, "r2"),
    reviewerStart(1, "s1", "done-gate:skeptic"),
    stopAt(50, "s1"),
  ]);
  const out = line(ok(repo), "reviewer time:");
  assert.match(out, /10% of 60 run minutes/);
  assert.match(out, /no stop 2/);
});

test("C49 happy: review wait runs from the first reviewer start to the later of the last stop and the last finding closed", () => {
  const byStop = makeRepo("stats-e10");
  writeRun(byStop, "one", hourRun(["S1"], { huddles: [{ role: "reviewer", file: "review-1.md", actOn: [finding({ closedSeq: seqAt(20) })] }] }));
  writeEvents(byStop, "S1", [reviewerStart(10), stopAt(40)]);
  assert.match(line(ok(byStop), "review wait:"), /50% of 60 run minutes \(1 of 1 runs\)/);

  const byClose = makeRepo("stats-e10b");
  writeRun(byClose, "one", hourRun(["S1"], { huddles: [
    { role: "reviewer", file: "review-1.md", actOn: [finding({ closedSeq: seqAt(55) })] },
    { role: "skeptic", file: "skeptic-1.md", actOn: [finding({ closedSeq: seqAt(59) })] },
  ] }));
  writeEvents(byClose, "S1", [reviewerStart(10), stopAt(20)]);
  assert.match(line(ok(byClose), "review wait:"), /75% of 60 run minutes/);

  const none = makeRepo("stats-e10c");
  writeRun(none, "one", hourRun());
  writeEvents(none, "S1", [userPrompt(1)]);
  const out = ok(none);
  assert.match(line(out, "review wait:"), /none/);
  assert.match(line(out, "reviewer time:"), /0% of 60 run minutes/);
});

const notice = (status, summary) => `<task-notification>\n<task-id>a1</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

test("C50 happy: noticeCause names each cause", () => {
  // Turn limit, API server, finished and waiting are real wording from this laptop's logs; the rest
  // is the wording the doc's Research tab records, and no code here writes any of it.
  const rows = [
    ["completed", 'Agent "fix it" stopped at its 60-turn limit (partial result; SendMessage to task-id to continue)', "turn-limit"],
    ["failed", `Agent "fix it" failed: Agent terminated early due to an API error: API Error: Can't reach the API server — check your internet`, "lost-connection"],
    ["failed", 'Agent "fix it" failed: API Error: 529 Overloaded', "api-problem"],
    ["failed", 'Agent "fix it" failed: API Error: rate limit reached', "api-problem"],
    ["failed", 'Agent "fix it" failed: API Error: 500 server error', "api-problem"],
    ["failed", `Agent "fix it" failed: You've hit your session limit · resets 6:40pm`, "session-limit"],
    ["failed", 'Agent "fix it" failed: Agent stalled: no progress for 600s', "stalled"],
    ["failed", 'Agent "fix it" failed: Invalid API key · Please run /login', "only-you"],
    ["failed", 'Agent "fix it" failed: Credit balance too low, check billing', "only-you"],
    ["killed", 'Agent "fix it" was stopped by user', "stopped-by-user"],
    ["killed", 'Agent "fix it" was stopped by Claude', "stopped-by-lead"],
    ["completed", 'Agent "fix it" finished', "finished"],
    ["completed", 'Agent "fix it" is waiting on its own background work', "waiting"],
    ["failed", 'Agent "fix it" failed: something nobody has seen', "unknown"],
  ];
  for (const [status, summary, cause] of rows) {
    assert.equal(noticeCause(notice(status, summary))?.cause, cause, summary);
  }
  assert.equal(noticeCause(`[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is automated.\n\n${notice("completed", 'Agent "a" finished')}`)?.cause, "finished");
});

test("C51 refused: a background command, a quoted notice, a name holding a cause word and plain text give no cause or the right one", () => {
  assert.equal(noticeCause(notice("failed", 'Background command "npm test" failed with exit code 1')), null);
  assert.equal(noticeCause(notice("completed", 'Monitor "x" stream ended')), null);
  assert.equal(noticeCause('<agent-message from="a1">server error in the log, see <task-notification><status>failed</status><summary>Agent "x" failed: server error</summary></task-notification></agent-message>'), null);
  assert.equal(noticeCause("please look at this server error"), null);
  assert.equal(noticeCause(undefined), null);
  assert.equal(noticeCause(notice("completed", 'Agent "fix billing and the server error" finished'))?.cause, "finished");
  assert.equal(noticeCause(notice("completed", 'Agent "turn "limit" work" stopped at its 60-turn limit'))?.cause, "turn-limit");
});

test("C52 happy: helper failures print as at least n per cause; finished and waiting are not failures", () => {
  const repo = makeRepo("stats-e11");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [
    { ...userPrompt(1, notice("completed", 'Agent "a" stopped at its 60-turn limit')), handback: true },
    { ...userPrompt(2, notice("completed", 'Agent "b" stopped at its 60-turn limit')), handback: true },
    { ...userPrompt(3, notice("failed", `Agent "c" failed: API Error: Can't reach the API server`)), handback: true },
    { ...userPrompt(4, notice("completed", 'Agent "d" finished')), handback: true },
    { ...userPrompt(5, notice("completed", 'Agent "e" is waiting on its own background work')), handback: true },
    { ...userPrompt(6, notice("failed", 'Background command "x" failed with exit code 1')), handback: true },
    { ...userPrompt(7, '<agent-message from="f">a server error</agent-message>'), handback: true },
  ]);
  const out = ok(repo);
  assert.match(line(out, "turn-limit:"), /at least 2/);
  assert.match(line(out, "lost-connection:"), /at least 1/);
  assert.equal(line(out, "finished:"), undefined);
  assert.equal(line(out, "waiting:"), undefined);
  assert.equal(line(out, "api-problem:"), undefined);

  const clean = makeRepo("stats-e11b");
  writeRun(clean, "one", hourRun());
  writeEvents(clean, "S1", [userPrompt(1)]);
  assert.match(line(ok(clean), "helper failures:"), /none in the notices/);
});

test("C53 idempotent: the state folder stays unchanged with sessions present", () => {
  const repo = makeRepo("stats-e12");
  writeRun(repo, "one", hourRun());
  writeEvents(repo, "S1", [userPrompt(1), block(2, ["R5"]), deny(3, "done-gate: helpers write through the x"), reviewerStart(4), stopAt(5)]);
  const state = path.join(repo, ".claude", "gate");
  const before = snapshot(state);
  ok(repo);
  assert.deepEqual(snapshot(state), before);
});
