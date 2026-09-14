import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Where the gate keeps its state for a repo. Tests override with DONE_GATE_STATE_DIR.
export function stateDirFor(root) {
  return process.env.DONE_GATE_STATE_DIR ?? path.join(root, ".claude", "gate");
}

export function projectRootFrom(input) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? process.cwd());
}

export function resolveContext({ input, args, pluginRoot, version }) {
  const root = projectRootFrom(input);
  const stateDir = stateDirFor(root);
  return {
    input,
    args,
    pluginRoot,
    version,
    root,
    stateDir,
    session: input?.session_id ?? process.env.DONE_GATE_SESSION ?? null,
    out: (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
}

let lastErrorPath = null;

export function recordGateError(error, verb) {
  const root = projectRootFrom(null);
  const dir = stateDirFor(root);
  mkdirSync(dir, { recursive: true });
  lastErrorPath = path.join(dir, "gate-error.log");
  const line = `${new Date().toISOString()} verb=${verb ?? "?"} ${error?.stack ?? String(error)}\n`;
  appendFileSync(lastErrorPath, line);
  return lastErrorPath;
}
