import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, gate, here } from "./helpers.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

const env = (repo) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" });
function cli(repo, verb, args = [], input = "") {
  const r = spawnSync(process.execPath, [gate, verb, ...args], { input, encoding: "utf8", env: env(repo) });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const runDir = (repo) => path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);

test("report renders every section, the summary counts, and embeds the reviewer's file verbatim", () => {
  const repo = makeRepo("report-render");
  cli(repo, "open", ["badge", "feature"]);
  cli(repo, "note", ["task", "Add a badge. [inferred]"]);
  cli(repo, "note", ["plan", "One component."]);
  cli(repo, "case", ["add", "renders badge", "--kind", "happy"]);
  cli(repo, "case", ["close", "C1", "--test", "tests/a.test.ts:renders"]);
  cli(repo, "step", ["read", "done", "read it", "--evidence", "events#1"]);
  cli(repo, "step", ["schema", "skipped", "no schema files"]);
  cli(repo, "waive", ["driver", "skip the phone pass"]);
  writeFileSync(path.join(runDir(repo), "review-1.md"), "# Review 1\n\n## Act on\n- null venue crashes\n");
  cli(repo, "huddle", ["add", "reviewer", "--file", "review-1.md"]);
  cli(repo, "huddle", ["acton", "H1", "null venue crashes"]);
  cli(repo, "decide", ["plan", "kept it simple", "one consumer", "src/a.ts", "open"]);
  write(repo, "src/a.ts", "changed\n");
  const r = cli(repo, "report");
  const md = r.stdout;
  assert.match(md, /^# badge — feature/m);
  assert.match(md, /DONE 3 · SKIPPED 1 · WAIVED 1 · N\/A 0 · blank \d+/);
  assert.match(md, /cases 1\/1 closed/);
  assert.match(md, /## Task\n\nAdd a badge/);
  assert.match(md, /\| C1 \| renders badge \| happy \| tests\/a\.test\.ts:renders \|/);
  assert.match(md, /1\. Read the affected code.*DONE.*events#1/);
  assert.match(md, /null venue crashes.*OPEN/);
  assert.match(md, /# Review 1/);
  assert.match(md, /## Changed files\n[\s\S]*src\/a\.ts/);
  assert.match(md, /kept it simple/);
  assert.match(md, /## Attention[\s\S]*waived.*driver/i);
  assert.ok(existsSync(path.join(runDir(repo), "report.md")));
  assert.equal(readFileSync(path.join(runDir(repo), "report.md"), "utf8"), md);
});
