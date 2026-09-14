import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, write } from "./helpers.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { evaluate } from "../scripts/lib/rules.mjs";

const repo = makeRepo("rules2", {
  ".claude/gate.json": JSON.stringify({
    source: ["src/**", "supabase/**", "tests/**"], tests: ["tests/**"], ui: ["src/app/**"],
    schema: ["src/lib/data/db.ts", "supabase/migrations/**"], highRisk: ["src/lib/payments/**"],
    checks: ["claude-md-budget", "migration-number"], driver: "skill:verify",
  }),
  "CLAUDE.md": "# rules\n\nNext number:\n   `0003`.\n",
  "supabase/migrations/0001_a.sql": "x", "supabase/migrations/0002_b.sql": "y",
});
const cfg = loadConfig(repo);
const ids = (s) => evaluate(s).map((u) => u.rule);
const green = (now) => ({ sourceHash: "n/a", commands: [{ cmd: "x", exit: 0, timedOut: false }] });
const clean = (over = {}) => {
  const ledger = {
    status: "open", planSeq: 1, taskSeq: 1, waivers: [], huddles: [], reviews: [],
    cases: [{ id: "C1", status: "closed", test: "t", seq: 2 }], blast: [{ fact: "f", rung: 4 }],
    steps: [{ n: 1, key: "schema", state: "N/A", note: "none" }],
    gateHash: cfg.hash, baseline: { seq: 0 },
    ...over.ledger,
  };
  return { root: repo, dir: repo, config: cfg, ledger, changed: ["src/a.ts", "tests/a.test.ts"], now: { hash: "x", files: {} }, verify: null, events: [], reviews: [], lastMessage: "", ledgerMd: "", ...over, ledger };
};

test("R4: a UI change needs a driver run (browser event or /verify skill) after the last edit, unless waived", () => {
  const changed = ["src/app/page.tsx", "tests/a.test.ts"];
  assert.ok(ids(clean({ changed })).includes("R4"));
  const edit = { seq: 10, kind: "edit", path: "src/app/page.tsx", agent: null };
  assert.ok(ids(clean({ changed, events: [edit, { seq: 5, kind: "browser", agent: null }] })).includes("R4"), "browser call BEFORE the edit does not count");
  assert.ok(!ids(clean({ changed, events: [edit, { seq: 11, kind: "browser", agent: null }] })).includes("R4"));
  assert.ok(!ids(clean({ changed, events: [edit, { seq: 12, kind: "skill", skill: "verify", agent: null }] })).includes("R4"));
  assert.ok(!ids(clean({ changed, ledger: { waivers: [{ key: "driver", found: true }] } })).includes("R4"));
  assert.ok(!ids(clean({ changed: ["src/lib/x.ts", "tests/a.test.ts"] })).includes("R4"), "non-UI change needs no driver");
});

test("R4 names the missing driver when the repo has none configured", () => {
  const noDriver = loadConfig(makeRepo("rules2-nodriver"));
  const u = evaluate(clean({ config: noDriver, changed: ["src/app/page.tsx", "tests/a.test.ts"] })).find((x) => x.rule === "R4");
  assert.match(u.text, /verify-setup/);
});

test("R5: source change needs a reviewer huddle with its file, after the last edit, with every Act-on item closed", () => {
  const edit = { seq: 10, kind: "edit", path: "src/a.ts", agent: null };
  assert.ok(ids(clean({ events: [edit] })).includes("R5"));
  const stopEarly = { seq: 9, kind: "subagent-stop", agentType: "done-gate:reviewer" };
  const stopLate = { seq: 20, kind: "subagent-stop", agentType: "done-gate:reviewer" };
  const huddle = { id: "H1", role: "reviewer", file: "review-1.md", actOn: [] };
  assert.ok(ids(clean({ events: [edit, stopEarly], reviews: ["review-1.md"], ledger: { huddles: [huddle] } })).includes("R5"), "review before the last edit is stale");
  assert.ok(ids(clean({ events: [edit, stopLate], reviews: [], ledger: { huddles: [huddle] } })).includes("R5"), "no review file");
  assert.ok(!ids(clean({ events: [edit, stopLate], reviews: ["review-1.md"], ledger: { huddles: [huddle] } })).includes("R5"));
  const open = { ...huddle, actOn: [{ id: "H1.1", text: "x", closed: null }] };
  assert.ok(ids(clean({ events: [edit, stopLate], reviews: ["review-1.md"], ledger: { huddles: [open] } })).includes("R5"));
  assert.ok(!ids(clean({ events: [edit], ledger: { waivers: [{ key: "review", found: true }] } })).includes("R5"));
});

test("R6: a schema change needs the schema step DONE with evidence, never N/A", () => {
  const changed = ["src/lib/data/db.ts", "tests/a.test.ts"];
  assert.ok(ids(clean({ changed })).includes("R6"));
  assert.ok(!ids(clean({ changed, ledger: { steps: [{ n: 1, key: "schema", state: "DONE", evidence: "events#3" }] } })).includes("R6"));
  assert.ok(!ids(clean({ changed, ledger: { waivers: [{ key: "schema", found: true }] } })).includes("R6"));
});

test("R9: a high-risk change needs the second reviewer too", () => {
  const changed = ["src/lib/payments/x.ts", "tests/a.test.ts"];
  const edit = { seq: 10, kind: "edit", path: "src/lib/payments/x.ts", agent: null };
  const r1 = { seq: 20, kind: "subagent-stop", agentType: "done-gate:reviewer" };
  const r2 = { seq: 21, kind: "subagent-stop", agentType: "done-gate:reviewer-2" };
  const h1 = { id: "H1", role: "reviewer", file: "review-1.md", actOn: [] };
  const h2 = { id: "H2", role: "reviewer-2", file: "review-2.md", actOn: [] };
  assert.ok(ids(clean({ changed, events: [edit, r1], reviews: ["review-1.md"], ledger: { huddles: [h1] } })).includes("R9"));
  assert.ok(!ids(clean({ changed, events: [edit, r1, r2], reviews: ["review-1.md", "review-2.md"], ledger: { huddles: [h1, h2] } })).includes("R9"));
  assert.ok(!ids(clean({ changed: ["src/a.ts", "tests/a.test.ts"], events: [edit, r1], reviews: ["review-1.md"], ledger: { huddles: [h1] } })).includes("R9"));
});

test("R10: migration-number requires CLAUDE.md's next number to be max+1 when a migration is added; claude-md-budget caps CLAUDE.md", () => {
  assert.ok(!ids(clean({ changed: ["src/a.ts", "tests/a.test.ts"] })).includes("R10"));
  write(repo, "supabase/migrations/0003_c.sql", "z");
  assert.ok(ids(clean({ changed: ["supabase/migrations/0003_c.sql", "tests/a.test.ts"] })).includes("R10"), "CLAUDE.md still says 0003");
  write(repo, "CLAUDE.md", "# rules\n\nNext number:\n   `0004`.\n");
  assert.ok(!ids(clean({ changed: ["supabase/migrations/0003_c.sql", "tests/a.test.ts"] })).includes("R10"));
  write(repo, "CLAUDE.md", `# big\n${"x".repeat(150_001)}\n`);
  assert.ok(ids(clean({ changed: ["CLAUDE.md"] })).includes("R10"));
  assert.ok(ids({ root: repo, config: cfg, ledger: null, changed: ["CLAUDE.md"], now: { hash: "x", files: {} }, events: [] }).includes("R10"), "doc-only path still runs the checks");
  write(repo, "CLAUDE.md", "# rules\n\nNext number:\n   `0004`.\n");
});

test("R13: gate.json changed since the ledger opened blocks unless waived", () => {
  assert.ok(ids(clean({ ledger: { gateHash: "stale" } })).includes("R13"));
  assert.ok(!ids(clean({ ledger: { gateHash: "stale", waivers: [{ key: "gate-config", found: true }] } })).includes("R13"));
});

test("agent briefs exist with the fixed model table and the write fences described", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const { pluginRoot } = await import("./helpers.mjs");
  const models = JSON.parse(readFileSync(path.join(pluginRoot, "models.json"), "utf8"));
  assert.deepEqual(models.roles, { skeptic: "sonnet", qa: "opus", reviewer: "sonnet", "reviewer-2": "opus" });
  for (const [name, model] of Object.entries(models.roles)) {
    const file = path.join(pluginRoot, "agents", `${name}.md`);
    assert.ok(existsSync(file), file);
    const fm = readFileSync(file, "utf8").split("---")[1];
    assert.match(fm, new RegExp(`^name: ${name}$`, "m"));
    assert.match(fm, new RegExp(`^model: ${model}$`, "m"));
    assert.ok(!/fable/i.test(fm), "Fable is never a helper");
  }
});
