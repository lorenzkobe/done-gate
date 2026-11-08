import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { appendEvents, readEvents } from "./events.mjs";
import { currentLedger, isDone, saveLedger } from "./ledger.mjs";
import { delegatedTier, effectiveTier, leadDelegates, measure, policyFor, reconcileTier, tiered, trialHolds } from "./size.mjs";
import { editedLast, implementationHash, lapseWaivers, planDrift, reopenWorkedOut, writersOf } from "./rules.mjs";
import { nextSeq } from "./events.mjs";
import { evaluate, settleSteps } from "./rules.mjs";
import { ensureSession, loadSession, saveSession } from "./session-state.mjs";
import { diffSnapshots, gitChanged, gitBrought, gitDiffers, gitHead, gitNumstat, gitTracked, snapshot } from "./tree.mjs";
import { repoPath } from "./paths.mjs";
import { cutWorkers } from "./diagnose.mjs";

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
// skeptic-<n>.md, and an older run's arbiter-<n>.md.
export function reviewFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^(?:review2?|skeptic|arbiter)-\d+\.md$/.test(f)).sort();
}

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
  const cause = events.filter((e) => (e.kind === "edit" || e.kind === "command") && !e.viaVerify && e.seq > prev).pop();
  ledger.lastSourceHash = hash;
  ledger.lastSourceChangeSeq = first ? 0 : (cause?.seq ?? nextSeq());
  // a change no edit-tool event explains came through the shell, or from another session
  if (!first && !events.some((e) => e.kind === "edit" && e.seq > prev)) {
    const entry = { seq: ledger.lastSourceChangeSeq };
    // the files it may cover, and whether any command of this run since the last stamp could
    // have written them: with none, the change is another session's and may be absorbed later
    if (tree) {
      const edited = editedSince(ledger, events);
      entry.paths = diffSnapshots(ledger.baseline, tree.now).changed.filter((p) => tree.config.isSource(p) && !edited.has(p));
      entry.writes = events.some((e) => e.kind === "command" && e.seq > prev && !e.readOnly && !gitMove(e));
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

// A reflog entry that only moved HEAD, recorded a merge or replayed a commit; any other new entry (a
// commit, an amend, a rebase --continue, which holds a conflict's fix, am, cherry-pick, revert, a
// subject git adds later) is the session's own.
const MOVE_ENTRY = /^(?:checkout|switch|reset|branch|commit \(merge\)|merge [^:]*|pull(?: [^(:]*)?|(?:pull --rebase|rebase)[^:]*\((?:start|finish|abort|pick|reword|edit|fixup|squash)\)):/;

// A checkout, pull or rebase that only moved the tree to what commits hold (events.mjs).
const gitMove = (e) => e.git === true && e.commits === false;

// The changed files the task may have written since its baseline (a run's starts before open): its
// edit, or its shell write or non-move command another session's last edit or command did not rival.
// `timed` judges a shell write by file times alone, for files a merge commit brought in: the
// unexplained-change record would claim every file dirty at the merge for any command before it.
export function ownWrites(holder, events, now, paths, others = [], { timed = false } = {}) {
  const since = holder.baseline?.seq ?? holder.openedSeq ?? 0;
  const edited = new Set(events.filter((e) => e.kind === "edit" && e.seq > since).map((e) => e.path));
  const shell = timed ? new Set() : new Set((holder.unexplainedChanges ?? []).filter((u) => u.writes).flatMap((u) => u.paths ?? []));
  // another session's background command is open-ended, so it never accounts for a write of this task
  const theirs = (p) => others.some((ev) => editedLast(ev, since, p, now.files[p]?.m) || writersOf(ev, since, now.files[p]?.m).some((e) => !e.background));
  // each command's run is timed against the events around it, git moves included
  return new Set(paths.filter((p) => edited.has(p) || ((shell.has(p) || writersOf(events, since, now.files[p]?.m).some((e) => !gitMove(e))) && !theirs(p))));
}

// Takes files into the baseline as they are now, out of the task's changes; the freshness
// clock stop counting an unexplained change that was only these files.
export function foldIntoBaseline(holder, paths, now, config) {
  const base = holder.baseline;
  const unexplained = holder.unexplainedChanges ?? [];
  const without = { ...now.files };
  for (const p of paths) {
    if (p in base.files) without[p] = base.files[p];
    else delete without[p];
  }
  const rest = implementationHash({ files: without }, config);
  const gone = new Set(paths);
  for (const p of paths) {
    if (p in now.files) base.files[p] = now.files[p];
    else delete base.files[p];
  }
  // a folded file is no longer diffed against the copy taken at open
  if (base.based) base.based = base.based.filter((p) => !gone.has(p));
  if (base.dirty) base.dirty = base.dirty.filter((p) => !gone.has(p));
  const removed = new Map();
  const kept = unexplained.filter((u) => {
    if (!u.paths.some((p) => gone.has(p))) return true;
    u.paths = u.paths.filter((p) => !gone.has(p));
    if (u.paths.length) return true;
    removed.set(u.seq, u);
    return false;
  });
  if (holder.unexplainedChanges) holder.unexplainedChanges = kept;
  // the stamp walks back past every removed entry, and stops at one a real change made
  let before = holder.lastSourceHash;
  while (removed.has(holder.lastSourceChangeSeq)) {
    const u = removed.get(holder.lastSourceChangeSeq);
    holder.lastSourceChangeSeq = u.prev;
    before = u.prevHash;
  }
  // the rest of the tree is as it was at that stamp, so only the folded files moved: the
  // hash follows with no stamp, whatever content they now have
  if (rest === holder.lastSourceHash || rest === before) {
    const hash = implementationHash(now, config);
    // the task's code did not move: a waiver given on it still holds
    for (const w of holder.waivers ?? []) if (w.code === holder.lastSourceHash || w.code === before) w.code = hash;
    holder.lastSourceHash = hash;
  }
}

// The run's git commands that may commit, and the commit ids they made: known only when every such
// command's reflog says which entries are its own (those above the top its start saw).
function ownCommits(ledger, events) {
  const commits = events.filter((e) => e.kind === "command" && e.git && !gitMove(e) && e.seq > (ledger.openedSeq ?? 0));
  const starts = new Map(events.filter((e) => e.kind === "command-start" && "reflogTop" in e).map((e) => [e.toolUseId, e.reflogTop]));
  const same = (a, b) => Boolean(a && b) && a.join("\t") === b.join("\t");
  const madeBy = (e) => {
    if (!e.reflog || !starts.has(e.toolUseId)) return null;
    const top = starts.get(e.toolUseId);
    const at = top ? e.reflog.findIndex((r) => same(r, top)) : e.reflog.length;
    return at < 0 ? null : e.reflog.slice(0, at);
  };
  const made = commits.map(madeBy);
  const known = made.every((m) => m !== null);
  return { commits, known, mine: known ? [...new Set(made.flat().filter(([, , subject]) => !MOVE_ENTRY.test(subject)).map(([sha]) => sha))] : [] };
}

// What git brought into the main repo since the run opened, less the run's own commits; null when
// that cannot be told. A declared repo's reflog is not recorded, so its files are never in it.
export function broughtSinceOpen(root, ledger, events) {
  const { known, mine } = ownCommits(ledger, events);
  const from = ledger.baseline?.head;
  const head = from ? gitHead(root) : null;
  return known && head ? gitBrought(root, from, head, mine) : null;
}

// Which of `paths` hold what HEAD holds. An untracked file does not, though git diff HEAD does not list it.
export function cleanAtHead(root, paths, now, repos) {
  const dirty = paths.length ? gitNumstat(root, paths, "HEAD", { repos }) : new Map();
  const tracked = paths.some((p) => p in now.files) ? gitTracked(root, repos) : new Set();
  return paths.filter((p) => !dirty.has(p) && (!(p in now.files) || tracked.has(p)));
}

// Folds into the baseline a source file git changed since the HEAD last seen, clean against HEAD
// and not the task's own; after a git command of the task's that may commit, less that command's commits.
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
  // from the HEAD last folded, so a round trip (A, B, A) folds back to A
  const ahead = [];
  for (const r of roots) {
    const head = r.from ? gitHead(r.dir) : null;
    const last = r.seen ?? r.from;
    if (head && head !== last) ahead.push({ ...r, last, head });
  }
  if (!ahead.length) return false;
  // with a committing command's reflog unknown nothing folds, as before
  const { commits, known, mine } = ownCommits(ledger, events);
  const changedBy = ahead.map((r) => (!commits.length ? gitChanged(r.dir, r.last, r.head) : known && !r.prefix ? gitBrought(r.dir, r.last, r.head, mine) : null));
  if (changedBy.some((c) => c === null)) return false;
  const committed = new Set();
  ahead.forEach((r, i) => {
    if (r.prefix) ledger.foreignHeads = { ...ledger.foreignHeads, [r.prefix]: r.head };
    else ledger.foreignHead = r.head;
    for (const p of changedBy[i]) committed.add(`${r.key}${p}`);
  });
  // what a late-declared repo held uncommitted at declaration is this run's, whoever commits it
  const held = new Set(base.untrackedAtHead ?? []);
  const candidates = diffSnapshots(base, now).changed.filter((p) => config.isSource(p) && committed.has(p) && base.files[p]?.h !== "HEAD" && !held.has(p));
  const own = ownWrites(ledger, events, now, candidates, [], { timed: commits.length > 0 });
  const moved = candidates.filter((p) => !own.has(p));
  const foreign = cleanAtHead(root, moved, now, repos);
  if (!foreign.length) return true;
  foldIntoBaseline(ledger, foreign, now, config);
  ledger.foreign = [...new Set([...(ledger.foreign ?? []), ...foreign])].sort();
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

// A task that reaches large marks when, and whether the plan said so: the report and the packets name it.
function markDelegated(ledger, policy) {
  if (ledger.tier?.predictedSeq != null || delegatedTier(policy, ledger.tier?.predicted) || !leadDelegates(ledger, policy)) return false;
  ledger.tier.predictedSeq = nextSeq();
  // the plan did not say large (a declared size raises the prediction): it grew there mid-task
  ledger.tier.grewAt = ledger.tier.predictedSeq;
  return true;
}

// The hook's path, bounded: git is asked for HEAD only when the source hash moved. Never writes
// session.json (the Stop hook's). What it returns goes back to the model as added context.
export function stampNow(ctx) {
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
  if (changed) saveLedger(dir, ledger);
  return null;
}

// The events of every session in this repo but `own` that logged anything since `since`: R1 and
// rebaseline ask them whether a change this task never made is theirs.
export function otherSessionsEvents(stateDir, own, since) {
  const dir = path.join(stateDir, "sessions");
  if (!existsSync(dir)) return [];
  const from = Date.parse(since ?? 0) || 0;
  return readdirSync(dir)
    .filter((s) => !own.includes(s) && (statSync(path.join(dir, s, "events.jsonl"), { throwIfNoEntry: false })?.mtimeMs ?? 0) >= from)
    .map((s) => readEvents(stateDir, s));
}

// The code outside the plan, kept when the set changes, with one event for it; every file ever
// flagged stays in planDriftSeen, which gate stats reads for the shadow numbers.
function recordDrift(ctx, ledger, policy, { config, changed }) {
  const mode = policy.guards.planDiff;
  if (mode === "off") return false;
  const drift = planDrift({ ledger, config, changed });
  const before = ledger.planDrift;
  if ((before === undefined && !drift.length) || JSON.stringify(before ?? []) === JSON.stringify(drift)) return false;
  ledger.planDrift = drift;
  ledger.planDriftSeen = [...new Set([...(ledger.planDriftSeen ?? []), ...drift])].sort();
  appendEvents(ctx.stateDir, ctx.session, [{ seq: nextSeq(), ts: new Date().toISOString(), session: ctx.session, agent: null, agentType: null, kind: "plan-drift", files: drift, mode }]);
  return true;
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

  const sessions = current ? current.ledger.sessions : [ctx.session];
  const events = sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
  const otherEvents = current ? [] : otherSessionsEvents(ctx.stateDir, [ctx.session], session.startedAt);
  // before the diff is taken, so another session's commit never shows as this task's change
  const settled = current ? settleAtHead(ctx.root, current.ledger, now) : false;
  const absorbed = (current ? absorbForeign(ctx.root, current.ledger, now, config, events) : false) || settled;
  // with no run open the session's own baseline moves with git the same way
  let moved = {};
  if (!current) {
    const holder = { baseline, openedSeq: session.baselineSeq ?? 0, foreignHead: session.foreignHead };
    if (absorbForeign(ctx.root, holder, now, config, events)) {
      moved = { baseline, foreignHead: holder.foreignHead };
      if (holder.foreign?.length) appendEvents(ctx.stateDir, ctx.session, [{ seq: nextSeq(), ts: new Date().toISOString(), session: ctx.session, agent: null, agentType: null, kind: "baseline-moved", head: holder.foreignHead, paths: holder.foreign }]);
    }
  }
  // the declared repos' entries ride along as a hash cache for the run; close and abandon drop them
  saveSession(ctx.stateDir, { ...session, ...moved, lastTree: { files: now.files, hash: now.hash } });
  const diff = diffSnapshots(baseline, now);

  // Size and freshness bookkeeping. The ledger is written only on a state flip (a step
  // reopened, or the source hash moved), so a plain `gate check` leaves it byte-identical.
  const policy = policyFor(current?.ledger);
  let tier = null;
  if (current) {
    let flipped = stampSourceChange(current.ledger, implementationHash(now, config), events, { now, config }) || absorbed;
    if (reopenWorkedOut(current.ledger, config, diff.changed, implementationHash(now, config))) flipped = true;
    if (lapseWaivers(current.ledger, implementationHash(now, config))) flipped = true;
    if (tiered(current.ledger)) {
      const measured = measure({ config, policy, diff, baseline, now, root: ctx.root, dir: current.dir, repos });
      const trial = trialHolds(policy, config, diff.changed, effectiveTier(policy, current.ledger, measured));
      if (reconcileTier(current.ledger, policy, measured, { trial }).length) flipped = true;
      // a new measured size is kept: a later re-prediction reads it
      if (current.ledger.tier?.measured?.tier !== measured.tier) flipped = true;
      current.ledger.tier = { ...current.ledger.tier, measured };
      if (markDelegated(current.ledger, policy)) flipped = true;
      tier = current.ledger.tier;
      if (recordDrift(ctx, current.ledger, policy, { config, changed: diff.changed })) flipped = true;
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

  const state = {
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
  // a cut worker's piece is not done: the implement step waits for it (settleSteps)
  if (current?.ledger.pieces) state.cutWorkers = cutWorkers(state);
  // the steps the gate has the facts for close here, on the whole state; saved only when one did
  if (current && settleSteps(state)) saveLedger(current.dir, current.ledger);
  return state;
}

// One numbered line per rule, in the order rules first appear; a rule with several items
// (R8 for open cases and for blank steps) lists them on its line. `cut` shortens each item.
export const unmetCount = (unmet) => new Set(unmet.map((u) => u.rule)).size;

export function unmetLines(unmet, { cut = 0 } = {}) {
  const byRule = new Map();
  for (const u of unmet) byRule.set(u.rule, [...(byRule.get(u.rule) ?? []), cut && u.text.length > cut ? `${u.text.slice(0, cut)}…` : u.text]);
  return [...byRule].map(([rule, texts], i) => `${i + 1}. ${rule} — ${texts.join(" · ")}`);
}

export function assess(ctx, opts) {
  const state = buildState(ctx, opts);
  return { state, unmet: evaluate(state) };
}
