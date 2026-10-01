import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A mistake in how a verb was called: bad arguments, empty text, no open ledger. Reported on
// stderr and never logged as a gate error, so the GATE ERROR stamp means a real failure.
export class UsageError extends Error {}

// Where the gate keeps its state for a repo. Tests override with DONE_GATE_STATE_DIR.
export function stateDirFor(root) {
  return process.env.DONE_GATE_STATE_DIR ?? path.join(root, ".claude", "gate");
}

export function projectRootFrom(input) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? process.cwd());
}

// Verbs run from the model's shell carry no hook payload. Claude Code exposes the session id
// to that shell as CLAUDE_CODE_SESSION_ID (per terminal, exact). Without it the pid files the
// fence writes decide, then the marker the SessionStart hook writes, which is shared by every
// terminal in the repo, newest wins.
export function readSessionMarker(stateDir) {
  try {
    return readFileSync(path.join(stateDir, "current-session"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

const PID_LEVELS = 4;

// This process's ancestors, nearest first, pid 1 left out. Each level past the parent costs
// one `ps`, so the list is lazy: a reader that stops at the first hit spawns nothing more.
export function* ancestorPids() {
  let pid = process.ppid;
  for (let level = 0; level < PID_LEVELS && pid > 1; level += 1) {
    yield pid;
    if (level + 1 === PID_LEVELS) return;
    try {
      pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      return;
    }
  }
}

export function pidsDir(stateDir) {
  return path.join(stateDir, "pids");
}

// The fence leaves its session id under the pids of its own ancestors; a verb started by the
// same Claude process shares one of them, and a second session in the repo does not.
function readSessionPid(stateDir) {
  for (const pid of ancestorPids()) {
    try {
      const id = readFileSync(path.join(pidsDir(stateDir), String(pid)), "utf8").trim();
      if (id) return id;
    } catch {
      // no file for this ancestor
    }
  }
  return null;
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
      readSessionPid(stateDir) ??
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
