import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = path.join(root, "scripts", "gate.mjs");

function run(args, input = "", env = {}) {
  return spawnSync(process.execPath, [gate, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("--version prints the plugin.json version", () => {
  const { version } = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), version);
});

test("plugin.json and package.json versions agree", () => {
  const plugin = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const market = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(plugin.version, pkg.version);
  assert.equal(market.plugins[0].version, pkg.version);
});

test("an unknown verb fails OPEN: exit 0, error on stderr, nothing on stdout", () => {
  const r = run(["no-such-verb"], "{}");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unknown verb/);
});

test("a verb that throws fails OPEN: exit 0 and the stack lands in gate-error.log", () => {
  const r = run(["__throw"], "{}", { DONE_GATE_STATE_DIR: path.join(root, "tests", ".tmp", "smoke-state"), DONE_GATE_TEST: "1" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const log = readFileSync(path.join(root, "tests", ".tmp", "smoke-state", "gate-error.log"), "utf8");
  assert.match(log, /__throw/);
});
