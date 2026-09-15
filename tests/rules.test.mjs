import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, sourceHash } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { makeRepo } from "./helpers.mjs";

const cfg = loadConfig(makeRepo("rules-cfg"));

function state(over = {}) {
  return {
    config: cfg,
    ledger: null,
    changed: [],
    now: { hash: "h-now", files: {} },
    verify: null,
    events: [],
    reviews: [],
    lastMessage: "",
    ...over,
  };
}

const ids = (unmet) => unmet.map((u) => u.rule);

test("R1: source changed with no ledger blocks; nothing changed passes", () => {
  assert.deepEqual(ids(evaluate(state())), []);
  assert.deepEqual(ids(evaluate(state({ changed: ["src/a.ts"] }))), ["R1"]);
});

test("doc-only changes without a ledger pass R1", () => {
  assert.deepEqual(ids(evaluate(state({ changed: ["docs/notes.md", "README.md"] }))), []);
});

test("R3: with a ledger, verify.json must exist, be green, and match the current source hash", () => {
  const ledger = { status: "open", steps: [], waivers: [], cases: [] };
  const now = { hash: "x", files: { "src/a.ts": { h: "1" }, "docs/x.md": { h: "2" } } };
  const changed = ["src/a.ts", "tests/a.test.ts"];
  assert.ok(ids(evaluate(state({ ledger, changed, now }))).includes("R3"));
  const green = { sourceHash: sourceHash(now, cfg), commands: [{ cmd: "npm run test", exit: 0, timedOut: false }] };
  assert.ok(!ids(evaluate(state({ ledger, changed, now, verify: green }))).includes("R3"));
  const red = { ...green, commands: [{ cmd: "npm run test", exit: 1, timedOut: false }] };
  assert.ok(ids(evaluate(state({ ledger, changed, now, verify: red }))).includes("R3"));
  const timedOut = { ...green, commands: [{ cmd: "npm run build", exit: null, timedOut: true }] };
  assert.ok(ids(evaluate(state({ ledger, changed, now, verify: timedOut }))).includes("R3"));
  const stale = { ...green, sourceHash: "older" };
  assert.ok(ids(evaluate(state({ ledger, changed, now, verify: stale }))).includes("R3"));
});

test("sourceHash ignores non-source files so a docs edit after verify does not invalidate it", () => {
  const a = { files: { "src/a.ts": { h: "1" }, "docs/x.md": { h: "2" } } };
  const b = { files: { "src/a.ts": { h: "1" }, "docs/x.md": { h: "changed" } } };
  const c = { files: { "src/a.ts": { h: "9" }, "docs/x.md": { h: "2" } } };
  assert.equal(sourceHash(a, cfg), sourceHash(b, cfg));
  assert.notEqual(sourceHash(a, cfg), sourceHash(c, cfg));
});

test("R7: source changed without any test file changing blocks unless the qa step is waived", () => {
  const ledger = { status: "open", steps: [], waivers: [], cases: [] };
  assert.ok(ids(evaluate(state({ ledger, changed: ["src/a.ts"] }))).includes("R7"));
  assert.ok(!ids(evaluate(state({ ledger, changed: ["src/a.ts", "tests/a.test.ts"] }))).includes("R7"));
  const waived = { ...ledger, waivers: [{ key: "qa", quote: "skip tests", found: true }] };
  assert.ok(!ids(evaluate(state({ ledger: waived, changed: ["src/a.ts"] }))).includes("R7"));
});

test("every unmet item names its rule and says what to do next", () => {
  const unmet = evaluate(state({ changed: ["src/a.ts"] }));
  assert.equal(unmet.length, 1);
  assert.match(unmet[0].text, /gate open/);
});
