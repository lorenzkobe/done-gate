import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Where the gate keeps its state for a repo. Tests override with DONE_GATE_STATE_DIR.
export function stateDirFor(root) {
  return process.env.DONE_GATE_STATE_DIR ?? path.join(root, ".claude", "gate");
}

export function projectRootFrom(input) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? process.cwd());
}

// Verbs run from the model's shell carry no hook payload. Claude Code exposes the session id
// to that shell as CLAUDE_CODE_SESSION_ID (per terminal, exact); the marker the SessionStart
// hook writes is the fallback for harnesses without it and is shared by every terminal in
// the repo, newest wins.
export function readSessionMarker(stateDir) {
  try {
    return readFileSync(path.join(stateDir, "current-session"), "utf8").trim() || null;
  } catch {
    return null;
  }
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
    session:
      input?.session_id ??
      (process.env.DONE_GATE_SESSION || undefined) ??
      (process.env.CLAUDE_CODE_SESSION_ID || undefined) ??
      readSessionMarker(stateDir) ??
      null,
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
