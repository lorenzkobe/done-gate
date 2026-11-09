import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../scripts/lib/rules.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { makeRepo } from "./helpers.mjs";

// From the 0.20.0 review, 3.9: a repo that drove its UI with a Playwright script waived the driver
// step every run, because gate.json named a /verify skill it did not have and R4 never said a
// cmd: driver would count the script.

const UI = { source: ["src/**", "tests/**"], tests: ["tests/**"], ui: ["src/app/**"] };
function r4(files, events = []) {
  const repo = makeRepo(`dch-${Object.keys(files).join("").replace(/\W/g, "").slice(0, 40)}-${events.length}`, files);
  const config = loadConfig(repo);
  const ledger = {
    status: "open", rules: 2, planSeq: 1, taskSeq: 1, waivers: [], huddles: [], reviews: [],
    cases: [{ id: "C1", status: "closed", test: "t", seq: 2 }],
    steps: [], gateHash: config.hash, baseline: { seq: 0 },
  };
  const edit = { seq: 10, kind: "edit", path: "src/app/page.tsx", agent: null };
  const state = { root: repo, dir: repo, config, ledger, changed: ["src/app/page.tsx", "tests/a.test.ts"], now: { hash: "x", files: {} }, verify: null, events: [edit, ...events], reviews: [], lastMessage: "", ledgerMd: "" };
  return evaluate(state).find((u) => u.rule === "R4") ?? null;
}
const gateJson = (extra) => ({ ".claude/gate.json": JSON.stringify({ ...UI, testFiles: null, ...extra }) });

test("C1 reported-surface: a skill:verify driver the repo lacks: R4 says it is missing and names cmd: and verify-setup", () => {
  const u = r4(gateJson({ driver: "skill:verify" }));
  assert.match(u.text, /\.claude\/skills\/verify/);
  assert.match(u.text, /"driver": "cmd:<the command>"/);
  assert.match(u.text, /verify-setup/);
});

test("C2 edge: with no driver, R4 names verify-setup and the cmd: option", () => {
  const u = r4(gateJson({}));
  assert.match(u.text, /verify-setup/);
  assert.match(u.text, /"driver": "cmd:<the command>"/);
});

test("C3 refused: a skill:verify driver whose skill exists keeps the /verify text with no cmd: line", () => {
  const u = r4({ ...gateJson({ driver: "skill:verify" }), ".claude/skills/verify/SKILL.md": "---\nname: verify\n---\n" });
  assert.match(u.text, /\/verify driver/);
  assert.doesNotMatch(u.text, /cmd:/);
});

test("C4 happy: a cmd: driver run after the last edit clears R4, and the driver key is outside the config hash", () => {
  assert.equal(r4(gateJson({ driver: "cmd:node drive.mjs" }), [{ seq: 11, kind: "command", cmd: "node drive.mjs --phone", exit: 0, agent: null }]), null);
  const a = loadConfig(makeRepo("dch-hash-a", gateJson({ driver: "skill:verify" })));
  const b = loadConfig(makeRepo("dch-hash-b", gateJson({ driver: "cmd:node drive.mjs" })));
  assert.equal(a.hash, b.hash, "switching the driver mid-run is not a config change (R13)");
});
