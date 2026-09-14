#!/usr/bin/env node
// done-gate dispatcher. Every verb runs inside a fail-open wrapper: a crash exits 0 with
// the stack in gate-error.log, because a hook that exits non-zero on its own bug would
// wedge every session in every repo where the plugin is installed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContext, recordGateError } from "./lib/context.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(
  readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
).version;

// verb → { hook: reads a hook payload from stdin, load: lazy module import }
const VERBS = {
  "session-start": { hook: true, load: () => import("./lib/session.mjs") },
  fence: { hook: true, load: () => import("./lib/guard.mjs") },
  log: { hook: true, load: () => import("./lib/events.mjs") },
  stop: { hook: true, load: () => import("./lib/stop.mjs") },
  open: { hook: false, load: () => import("./lib/ledger.mjs") },
  attach: { hook: false, load: () => import("./lib/ledger.mjs") },
  note: { hook: false, load: () => import("./lib/verbs.mjs") },
  case: { hook: false, load: () => import("./lib/verbs.mjs") },
  step: { hook: false, load: () => import("./lib/verbs.mjs") },
  blast: { hook: false, load: () => import("./lib/verbs.mjs") },
  huddle: { hook: false, load: () => import("./lib/verbs.mjs") },
  waive: { hook: false, load: () => import("./lib/verbs.mjs") },
  decide: { hook: false, load: () => import("./lib/verbs.mjs") },
  close: { hook: false, load: () => import("./lib/verbs.mjs") },
  verify: { hook: false, load: () => import("./lib/verify.mjs") },
  check: { hook: false, load: () => import("./lib/check.mjs") },
  report: { hook: false, load: () => import("./lib/report.mjs") },
  steps: { hook: false, load: () => import("./lib/ledger.mjs") },
  doctor: { hook: false, load: () => import("./lib/doctor.mjs") },
};

// Only hook verbs, and the verbs that accept a "-" argument for a long text, have anything on
// stdin. Reading it unconditionally hung every other verb inside Claude Code's Bash tool,
// whose stdin is a pipe that never closes.
const STDIN_TEXT_VERBS = new Set(["note"]);
function wantsStdin(verb, args) {
  return VERBS[verb]?.hook === true || (STDIN_TEXT_VERBS.has(verb) && args.includes("-"));
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(raw) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable: raw.slice(0, 200) };
  }
}

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === "--version" || verb === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const raw = wantsStdin(verb, args) ? await readStdin() : "";
  const input = parseInput(raw);
  const ctx = resolveContext({ input, args, pluginRoot, version: VERSION });
  ctx.rawStdin = raw;

  if (verb === "__throw" && process.env.DONE_GATE_TEST === "1") {
    throw new Error("__throw: deliberate test crash");
  }
  const entry = VERBS[verb];
  if (!entry) {
    process.stderr.write(`done-gate: unknown verb "${verb ?? ""}"\n`);
    return;
  }
  const mod = await entry.load();
  const fn = mod.verbs?.[verb] ?? mod.default;
  if (typeof fn !== "function") throw new Error(`verb "${verb}" has no implementation`);
  await fn(ctx);
}

try {
  await main();
} catch (error) {
  try {
    recordGateError(error, process.argv[2]);
  } catch {
    // nothing left to do; stay silent and fail open
  }
  process.stderr.write(`done-gate: ${error?.message ?? error}\n`);
}
process.exitCode = 0;
