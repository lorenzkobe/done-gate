import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate } from "./helpers.mjs";
import { loadSession, ensureSession } from "../scripts/lib/session-state.mjs";
import { openLedger, attachLedger, currentLedger, loadLedger } from "../scripts/lib/ledger.mjs";

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
