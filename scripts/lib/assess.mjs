import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { readEvents } from "./events.mjs";
import { currentLedger, isDone, saveLedger } from "./ledger.mjs";
import { delegatedTier, leadDelegates, measure, policyFor, reconcileTier, tiered } from "./size.mjs";
import { implementationHash } from "./rules.mjs";
import { nextSeq } from "./events.mjs";
import { evaluate } from "./rules.mjs";
import { ensureSession, loadSession, saveSession } from "./session-state.mjs";
import { diffSnapshots, gitChanged, gitDiffers, gitHead, gitNumstat, snapshot } from "./tree.mjs";
import { repoPath } from "./paths.mjs";

export function readVerify(dir) {
  const file = path.join(dir, "verify.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/\r/g, ""));
}

// The marker a running verify leaves; null once it finished.
export function readVerifyStarted(dir) {
  const file = path.join(dir, "verify.started.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { startedAt: null };
  }
}

// The files reading helpers write for themselves: review-<n>.md, review2-<n>.md,
// skeptic-<n>.md and arbiter-<n>.md.
export function reviewFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^(?:review2?|skeptic|arbiter)-\d+\.md$/.test(f)).sort();
}
export const helperFiles = reviewFiles;

// Everything the rules need, gathered once. Throws LedgerParseError when our own
// state is unreadable so the caller can apply the block-once-then-fail-open policy.
export class LedgerParseError extends Error {}

// Records the moment the implementation (source minus tests) last changed. Called by the
// PostToolUse hook right after any tool that can write files, so the stamp is the tool call
// that made the change; and by every assess, where a change with no cause is dated now.
// Returns true when the ledger changed and needs saving.
export function stampSourceChange(ledger, hash, events, tree = null) {
  if (ledger.lastSourceHash === hash) return false;
  const first = ledger.lastSourceHash === undefined; // the opening stamp is not an edit
  const prev = ledger.lastSourceChangeSeq ?? 0;
  const prevHash = ledger.lastSourceHash;
  const cause = events.filter((e) => (e.kind === "edit" || e.kind === "command") && e.seq > prev).pop();
  ledger.lastSourceHash = hash;
  ledger.lastSourceChangeSeq = first ? 0 : (cause?.seq ?? nextSeq());
  // a change no edit-tool event accounts for came through the shell (sed, a heredoc, git
  // apply); R16 reads this list at a size where only workers may edit
  if (!first && !events.some((e) => e.kind === "edit" && e.seq > prev)) {
    const entry = { seq: ledger.lastSourceChangeSeq, cmd: cause?.kind === "command" ? cause.cmd ?? null : null, agentType: cause?.agentType ?? null };
    // the files it may cover, and whether any command of this run since the last stamp could
    // have written them: with none, the change is another session's and may be absorbed later
    if (tree) {
      const edited = editedSince(ledger, events);
      entry.paths = diffSnapshots(ledger.baseline, tree.now).changed.filter((p) => tree.config.isSource(p) && !edited.has(p));
      entry.writes = events.some((e) => e.kind === "command" && e.seq > prev && !e.readOnly);
      entry.prev = prev;
      entry.prevHash = prevHash;
    }
    ledger.unexplainedChanges = [...(ledger.unexplainedChanges ?? []), entry];
  }
  return true;
}

function editedSince(ledger, events) {
  const since = ledger.openedSeq ?? 0;
  return new Set(events.filter((e) => e.kind === "edit" && e.seq > since).map((e) => e.path));
}

// Folds other sessions' commits into the baseline: a source file committed since open, clean
// against HEAD, not edited or shell-written by this run. Skipped when this run wrote through git.
function absorbForeign(root, ledger, now, config, events) {
  const base = ledger.baseline;
  const repos = ledger.repos ?? [];
  const unexplained = ledger.unexplainedChanges ?? [];
  // an entry from before paths were recorded cannot say which files it covers
  if (unexplained.some((u) => !u.paths)) return false;
  // each declared repo is asked on its own: its HEAD at declaration against its HEAD now
  const roots = [
    { dir: root, key: "", from: base?.head, seen: ledger.foreignHead },
    ...repos.map((r) => ({ dir: r.root, key: `${r.prefix}/`, prefix: r.prefix, from: base?.heads?.[r.prefix], seen: ledger.foreignHeads?.[r.prefix] })),
  ];
  const ahead = [];
  for (const r of roots) {
    const head = r.from ? gitHead(r.dir) : null;
    if (head && head !== r.from && head !== r.seen) ahead.push({ ...r, head });
  }
  if (!ahead.length) return false;
  if (events.some((e) => e.kind === "command" && e.git && e.seq > (ledger.openedSeq ?? 0))) return false;
  const committed = new Set();
  for (const r of ahead) {
    if (r.prefix) ledger.foreignHeads = { ...ledger.foreignHeads, [r.prefix]: r.head };
    else ledger.foreignHead = r.head;
    for (const p of gitChanged(r.dir, r.from, r.head)) committed.add(`${r.key}${p}`);
  }
  const edited = editedSince(ledger, events);
  const shell = new Set(unexplained.filter((u) => u.writes).flatMap((u) => u.paths));
  // what a late-declared repo held uncommitted at declaration is this run's, whoever commits it
  const own = new Set(base.untrackedAtHead ?? []);
  const moved = diffSnapshots(base, now).changed.filter((p) => config.isSource(p) && committed.has(p) && !edited.has(p) && !shell.has(p) && base.files[p]?.h !== "HEAD" && !own.has(p));
  const dirty = moved.length ? gitNumstat(root, moved, "HEAD", { repos }) : new Map();
  const foreign = moved.filter((p) => !dirty.has(p));
  if (!foreign.length) return true;
  const without = { ...now.files };
  for (const p of foreign) {
    if (p in base.files) without[p] = base.files[p];
    else delete without[p];
  }
  const rest = implementationHash({ files: without }, config);
  for (const p of foreign) {
    if (p in now.files) base.files[p] = now.files[p];
    else delete base.files[p];
  }
  ledger.foreign = [...new Set([...(ledger.foreign ?? []), ...foreign])].sort();
  // an unexplained change that was only these files is explained now: R16 and the freshness
  // clock stop counting it
  const gone = new Set(foreign);
  const removed = new Map();
  ledger.unexplainedChanges = unexplained.filter((u) => {
    if (!u.paths.some((p) => gone.has(p))) return true;
    u.paths = u.paths.filter((p) => !gone.has(p));
    if (u.paths.length) return true;
    removed.set(u.seq, u);
    return false;
  });
  // the stamp walks back past every removed entry, and stops at one a real change made
  let before = ledger.lastSourceHash;
  while (removed.has(ledger.lastSourceChangeSeq)) {
    const u = removed.get(ledger.lastSourceChangeSeq);
    ledger.lastSourceChangeSeq = u.prev;
    before = u.prevHash;
  }
  // the rest of the tree is as it was at that stamp, so only the absorbed files moved: the
  // hash follows with no stamp, whatever content the commit gave them
  if (rest === ledger.lastSourceHash || rest === before) ledger.lastSourceHash = implementationHash(now, config);
  return true;
}

// A placeholder entry of a late-declared repo takes the file's real entry once git finds the
// file equal to the repo's HEAD at declaration again: put back, it leaves the run. One git call per repo.
function settleAtHead(root, ledger, now) {
  const repos = (ledger.repos ?? []).filter((r) => r.fromHead);
  if (!repos.length) return false;
  const base = ledger.baseline;
  const held = repos.map(() => []);
  for (const p of Object.keys(base.files)) if (base.files[p].h === "HEAD") held[repoPath(root, p, repos).index]?.push(p);
  let settled = false;
  repos.forEach((repo, i) => {
    const differs = held[i].length ? gitDiffers(repo.root, base.heads[repo.prefix], held[i].map((p) => p.slice(repo.prefix.length + 1))) : null;
    for (const p of differs ? held[i] : []) {
      if (differs.has(p.slice(repo.prefix.length + 1))) continue;
      if (p in now.files) base.files[p] = now.files[p];
      else delete base.files[p];
      settled = true;
    }
  });
  return settled;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// Tells the lead at the edit that crosses into the delegated size, once per run; the
// measurement is not saved, so the fence starts refusing at the next gate verb as before.
function sizeWarning(root, ledger, config, now, logged) {
  if (!tiered(ledger) || ledger.tierWarned) return null;
  if (!logged.some((e) => e.kind === "edit" && config.isSource(e.path) && !config.isTest(e.path))) return null;
  const policy = policyFor(ledger);
  if (leadDelegates(ledger, policy) || (ledger.waivers ?? []).some((w) => w.key === "delegate")) return null;
  const m = measure({ config, policy, diff: diffSnapshots(ledger.baseline, now), baseline: ledger.baseline, now, root, quick: true, repos: ledger.repos ?? [] });
  if (!delegatedTier(policy, m.tier)) return null;
  return `done-gate: this task now measures ${plural(m.lines, "line")} in ${plural(m.files, "source file")}, which is size ${m.tier}. At that size the lead does not edit source: the next gate verb records the size and from then on the fence refuses your source edits. Hand the rest to a worker now: run \`gate brief worker\` and spawn done-gate:worker with the prompt it prints.`;
}

// The hook's path, bounded: git is asked for HEAD only when the source hash moved, and for one
// numstat only after a lead edit of a sized file on a run not yet warned. Never writes session.json (the Stop hook's).
export function stampNow(ctx, logged = []) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if (!current || isDone(current.ledger)) return null;
  const { dir, ledger } = current;
  const repos = ledger.repos ?? [];
  const config = loadConfig(ctx.root, repos);
  const session = loadSession(ctx.stateDir, ctx.session);
  const now = snapshot(ctx.root, session?.lastTree ?? ledger.baseline, repos);
  const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
  const hash = implementationHash(now, config);
  let changed = hash !== ledger.lastSourceHash && absorbForeign(ctx.root, ledger, now, config, events);
  if (stampSourceChange(ledger, hash, events, { now, config })) changed = true;
  const warning = sizeWarning(ctx.root, ledger, config, now, logged);
  if (warning) ledger.tierWarned = true;
  if (changed || warning) saveLedger(dir, ledger);
  return warning;
}

// The events of every other session in this repo that logged anything since this one started:
// R1 asks them whether a change this session never made is theirs.
function otherSessionsEvents(stateDir, self, since) {
  const dir = path.join(stateDir, "sessions");
  if (!existsSync(dir)) return [];
  const from = Date.parse(since ?? 0) || 0;
  return readdirSync(dir)
    .filter((s) => s !== self && (statSync(path.join(dir, s, "events.jsonl"), { throwIfNoEntry: false })?.mtimeMs ?? 0) >= from)
    .map((s) => readEvents(stateDir, s));
}

export function buildState(ctx, { lastMessage = "" } = {}) {
  const session = ensureSession(ctx.stateDir, ctx.root, ctx.session);
  let current = null;
  try {
    current = currentLedger(ctx.stateDir, ctx.session);
  } catch (error) {
    throw new LedgerParseError(`ledger.json unreadable: ${error.message}`);
  }
  if (current && isDone(current.ledger)) current = null;
  const repos = current?.ledger.repos ?? [];
  const config = loadConfig(ctx.root, repos);

  const baseline = current ? current.ledger.baseline : session.baseline;
  const cache = session.lastTree ?? baseline;
  const now = snapshot(ctx.root, cache, repos);
  // the declared repos' entries ride along as a hash cache for the run; close and abandon drop them
  saveSession(ctx.stateDir, { ...session, lastTree: { files: now.files, hash: now.hash } });

  const sessions = current ? current.ledger.sessions : [ctx.session];
  const events = sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
  const otherEvents = current ? [] : otherSessionsEvents(ctx.stateDir, ctx.session, session.startedAt);
  // before the diff is taken, so another session's commit never shows as this task's change
  const settled = current ? settleAtHead(ctx.root, current.ledger, now) : false;
  const absorbed = (current ? absorbForeign(ctx.root, current.ledger, now, config, events) : false) || settled;
  const diff = diffSnapshots(baseline, now);

  // Size and freshness bookkeeping. The ledger is written only on a state flip (a step
  // reopened, or the source hash moved), so a plain `gate check` leaves it byte-identical.
  const policy = policyFor(current?.ledger);
  let tier = null;
  if (current) {
    let flipped = stampSourceChange(current.ledger, implementationHash(now, config), events, { now, config }) || absorbed;
    if (tiered(current.ledger)) {
      const measured = measure({ config, policy, diff, baseline, now, root: ctx.root, dir: current.dir, repos });
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
    repos,
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
    verifyStarted: current ? readVerifyStarted(current.dir) : null,
    events,
    otherEvents,
    reviews: current ? reviewFiles(current.dir) : [],
    lastMessage,
  };
}

export function assess(ctx, opts) {
  const state = buildState(ctx, opts);
  return { state, unmet: evaluate(state) };
}
