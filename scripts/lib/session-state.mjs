import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sessionDir } from "./events.mjs";
import { nextSeq } from "./events.mjs";
import { snapshot } from "./tree.mjs";

function stateFile(stateDir, session) {
  return path.join(sessionDir(stateDir, session), "state.json");
}

export function loadSession(stateDir, session) {
  const file = stateFile(stateDir, session);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/\r/g, ""));
}

// Written whole then renamed, so a concurrent reader never sees a torn file.
export function saveSession(stateDir, state) {
  const file = stateFile(stateDir, state.session);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
  return state;
}

// The baseline is the tree as it stood when this session started (or when its last
// ledger closed). Everything the gate judges is "what changed since the baseline".
export function ensureSession(stateDir, root, session) {
  const existing = loadSession(stateDir, session);
  if (existing) return existing;
  const state = {
    session,
    startedAt: new Date().toISOString(),
    baseline: snapshot(root),
    baselineSeq: nextSeq(),
    current: null,
    blocks: { key: null, count: 0 },
    stopsWithoutSnapshot: 0,
  };
  return saveSession(stateDir, state);
}

export function updateSession(stateDir, session, patch) {
  const state = loadSession(stateDir, session);
  if (!state) throw new Error(`no session state for ${session}`);
  return saveSession(stateDir, { ...state, ...patch });
}
