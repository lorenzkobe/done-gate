import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { readEvents } from "./events.mjs";
import { currentLedger, saveLedger } from "./ledger.mjs";
import { loadPolicy } from "./size.mjs";
import { measure, reconcileTier, tiered } from "./size.mjs";
import { implementationHash } from "./rules.mjs";
import { nextSeq } from "./events.mjs";
import { evaluate } from "./rules.mjs";
import { ensureSession, loadSession, saveSession } from "./session-state.mjs";
import { diffSnapshots, snapshot } from "./tree.mjs";

export function readVerify(dir) {
  const file = path.join(dir, "verify.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/\r/g, ""));
}

// The files helpers write for themselves: review-<n>.md and skeptic-<n>.md.
export function reviewFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^(?:review|skeptic|arbiter)-\d+\.md$/.test(f)).sort();
}
export const helperFiles = reviewFiles;

// Everything the rules need, gathered once. Throws LedgerParseError when our own
// state is unreadable so the caller can apply the block-once-then-fail-open policy.
export class LedgerParseError extends Error {}

// Records the moment the implementation (source minus tests) last changed. Called by the
// PostToolUse hook right after any tool that can write files, so the stamp is the tool call
// that made the change; and by every assess, where a change with no cause is dated now.
// Returns true when the ledger changed and needs saving.
export function stampSourceChange(ledger, hash, events) {
  if (ledger.lastSourceHash === hash) return false;
  const first = ledger.lastSourceHash === undefined; // the opening stamp is not an edit
  const prev = ledger.lastSourceChangeSeq ?? 0;
  const cause = events.filter((e) => (e.kind === "edit" || e.kind === "command") && e.seq > prev).pop();
  ledger.lastSourceHash = hash;
  ledger.lastSourceChangeSeq = first ? 0 : (cause?.seq ?? nextSeq());
  // a change no edit-tool event accounts for came through the shell (sed, a heredoc, git
  // apply); R16 reads this list at a size where only workers may edit
  if (!first && !events.some((e) => e.kind === "edit" && e.seq > prev)) {
    ledger.unexplainedChanges = [...(ledger.unexplainedChanges ?? []), { seq: ledger.lastSourceChangeSeq, cmd: cause?.kind === "command" ? cause.cmd ?? null : null, agentType: cause?.agentType ?? null }];
  }
  return true;
}

// The cheap path for the hook: snapshot, hash, stamp. No measuring, no git, and no session
// write: session.json is the Stop hook's to update, and a concurrent write here could undo
// its close marker. The session's cached tree is read for speed but never saved.
export function stampNow(ctx) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if (!current || current.ledger.status === "closed") return;
  const config = loadConfig(ctx.root);
  const session = loadSession(ctx.stateDir, ctx.session);
  const now = snapshot(ctx.root, session?.lastTree ?? current.ledger.baseline);
  const events = current.ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
  if (stampSourceChange(current.ledger, implementationHash(now, config), events)) saveLedger(current.dir, current.ledger);
}

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

  const sessions = current ? current.ledger.sessions : [ctx.session];
  const events = sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);

  // Size and freshness bookkeeping. The ledger is written only on a state flip (a step
  // reopened, or the source hash moved), so a plain `gate check` leaves it byte-identical.
  const policy = loadPolicy();
  let tier = null;
  if (current) {
    let flipped = stampSourceChange(current.ledger, implementationHash(now, config), events);
    if (tiered(current.ledger)) {
      const measured = measure({ config, policy, diff, baseline, now, root: ctx.root });
      if (reconcileTier(current.ledger, policy, measured).length) flipped = true;
      current.ledger.tier = { ...current.ledger.tier, measured };
      tier = current.ledger.tier;
    }
    if (flipped) saveLedger(current.dir, current.ledger);
  }

  let verify = null;
  if (current) {
    try {
      verify = readVerify(current.dir);
    } catch (error) {
      throw new LedgerParseError(`verify.json unreadable: ${error.message}`);
    }
  }
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
    policy,
    tier,
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
