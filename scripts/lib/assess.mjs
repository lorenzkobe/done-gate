import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { readEvents } from "./events.mjs";
import { currentLedger } from "./ledger.mjs";
import { evaluate } from "./rules.mjs";
import { ensureSession, saveSession } from "./session-state.mjs";
import { diffSnapshots, snapshot } from "./tree.mjs";

export function readVerify(dir) {
  const file = path.join(dir, "verify.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/\r/g, ""));
}

export function reviewFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^review-\d+\.md$/.test(f)).sort();
}

// Everything the rules need, gathered once. Throws LedgerParseError when our own
// state is unreadable so the caller can apply the block-once-then-fail-open policy.
export class LedgerParseError extends Error {}

export function buildState(ctx, { lastMessage = "" } = {}) {
  const config = loadConfig(ctx.root);
  const session = ensureSession(ctx.stateDir, ctx.root, ctx.session);
  let current = null;
  try {
    current = currentLedger(ctx.stateDir, ctx.session);
  } catch (error) {
    throw new LedgerParseError(`ledger.json unreadable: ${error.message}`);
  }
  if (current && current.ledger.status === "closed") current = null;

  const baseline = current ? current.ledger.baseline : session.baseline;
  const cache = session.lastTree ?? baseline;
  const now = snapshot(ctx.root, cache);
  saveSession(ctx.stateDir, { ...session, lastTree: { files: now.files, hash: now.hash } });
  const diff = diffSnapshots(baseline, now);

  let verify = null;
  if (current) {
    try {
      verify = readVerify(current.dir);
    } catch (error) {
      throw new LedgerParseError(`verify.json unreadable: ${error.message}`);
    }
  }
  const sessions = current ? current.ledger.sessions : [ctx.session];
  const events = sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);

  const ledgerMd = current && existsSync(path.join(current.dir, "ledger.md")) ? readFileSync(path.join(current.dir, "ledger.md"), "utf8") : "";

  return {
    root: ctx.root,
    stateDir: ctx.stateDir,
    ledgerMd,
    config,
    session,
    current,
    ledger: current?.ledger ?? null,
    dir: current?.dir ?? null,
    baseline,
    now,
    diff,
    changed: diff.changed,
    verify,
    events,
    reviews: current ? reviewFiles(current.dir) : [],
    lastMessage,
  };
}

export function assess(ctx, opts) {
  const state = buildState(ctx, opts);
  return { state, unmet: evaluate(state) };
}
