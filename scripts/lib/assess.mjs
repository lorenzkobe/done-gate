import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { appendEvents, readEvents } from "./events.mjs";
import { currentLedger, isDone, saveLedger } from "./ledger.mjs";
import { delegatedTier, leadDelegates, measure, policyFor, reconcileTier, tiered } from "./size.mjs";
import { editedLast, implementationHash, writersOf } from "./rules.mjs";
import { nextSeq } from "./events.mjs";
import { evaluate } from "./rules.mjs";
import { ensureSession, loadSession, saveSession } from "./session-state.mjs";
import { diffSnapshots, gitChanged, gitDiffers, gitHead, gitNumstat, gitTracked, snapshot } from "./tree.mjs";
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
  // a change no edit-tool event explains came through the shell; R16 reads this list. A lead
  // writing command since the last stamp keeps it the lead's unless the file times clear it.
  if (!first && !events.some((e) => e.kind === "edit" && e.seq > prev)) {
    const leadWrote = events.some((e) => e.kind === "command" && e.seq > prev && !e.agent && !e.readOnly && !e.scratch);
    const entry = { seq: ledger.lastSourceChangeSeq, cmd: cause?.kind === "command" ? cause.cmd ?? null : null, agentType: leadWrote ? null : cause?.agentType ?? null };
    // the files it may cover, and whether any command of this run since the last stamp could
    // have written them: with none, the change is another session's and may be absorbed later
    if (tree) {
      const edited = editedSince(ledger, events);
      entry.paths = diffSnapshots(ledger.baseline, tree.now).changed.filter((p) => tree.config.isSource(p) && !edited.has(p));
      entry.writes = events.some((e) => e.kind === "command" && e.seq > prev && !e.readOnly && !gitMove(e));
      entry.prev = prev;
      entry.prevHash = prevHash;
      // a subagent's write is first seen at the lead's next call: it is the subagent's when every
      // file that moved lies in a subagent command's run and in none of the lead's (seq is in µs)
      const moved = entry.paths.map((p) => tree.now.files[p]?.m).filter((m) => m !== undefined && m >= prev / 1000 - 1000);
      const writers = moved.map((m) => writersOf(events, prev, m));
      if (writers.length && writers.every((w) => w.length && w.every((e) => e.agent))) entry.agentType = writers.at(-1).at(-1).agentType;
    }
    ledger.unexplainedChanges = [...(ledger.unexplainedChanges ?? []), entry];
  }
  return true;
}

function editedSince(ledger, events) {
  const since = ledger.openedSeq ?? 0;
  return new Set(events.filter((e) => e.kind === "edit" && e.seq > since).map((e) => e.path));
}

// A checkout, pull or rebase that only moved the tree to what commits hold (events.mjs).
const gitMove = (e) => e.git === true && e.commits === false;

// The changed files the task may have written since its baseline (a run's starts before open): its
// edit, or its shell write or non-move command another session's last edit or command did not rival.
export function ownWrites(holder, events, now, paths, others = []) {
  const since = holder.baseline?.seq ?? holder.openedSeq ?? 0;
  const edited = new Set(events.filter((e) => e.kind === "edit" && e.seq > since).map((e) => e.path));
  const shell = new Set((holder.unexplainedChanges ?? []).filter((u) => u.writes).flatMap((u) => u.paths ?? []));
  // another session's background command is open-ended, so it never accounts for a write of this task
  const theirs = (p) => others.some((ev) => editedLast(ev, since, p, now.files[p]?.m) || writersOf(ev, since, now.files[p]?.m).some((e) => !e.background));
  // each command's run is timed against the events around it, git moves included
  return new Set(paths.filter((p) => edited.has(p) || ((shell.has(p) || writersOf(events, since, now.files[p]?.m).some((e) => !gitMove(e))) && !theirs(p))));
}

// Takes files into the baseline as they are now, out of the task's changes; R16 and the freshness
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
  if (rest === holder.lastSourceHash || rest === before) holder.lastSourceHash = implementationHash(now, config);
}

// Folds into the baseline a source file git changed since the HEAD last seen, clean against HEAD
// and not the task's own; skipped once a git command of the task's may have committed.
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
  if (events.some((e) => e.kind === "command" && e.git && !gitMove(e) && e.seq > (ledger.openedSeq ?? 0))) return false;
  const committed = new Set();
  for (const r of ahead) {
    if (r.prefix) ledger.foreignHeads = { ...ledger.foreignHeads, [r.prefix]: r.head };
    else ledger.foreignHead = r.head;
    for (const p of gitChanged(r.dir, r.last, r.head)) committed.add(`${r.key}${p}`);
  }
  // what a late-declared repo held uncommitted at declaration is this run's, whoever commits it
  const held = new Set(base.untrackedAtHead ?? []);
  const candidates = diffSnapshots(base, now).changed.filter((p) => config.isSource(p) && committed.has(p) && base.files[p]?.h !== "HEAD" && !held.has(p));
  const own = ownWrites(ledger, events, now, candidates);
  const moved = candidates.filter((p) => !own.has(p));
  const dirty = moved.length ? gitNumstat(root, moved, "HEAD", { repos }) : new Map();
  // an untracked file is not what HEAD holds, though git diff HEAD does not list it
  const tracked = moved.some((p) => p in now.files) ? gitTracked(root, repos) : new Set();
  const foreign = moved.filter((p) => !dirty.has(p) && (!(p in now.files) || tracked.has(p)));
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

// R16 counts the lead's edits from the moment the task became a size where the lead
// delegates; a prediction sets that mark, and so does the first measurement that crosses.
function markDelegated(ledger, policy, crossed = false) {
  if (ledger.tier?.predictedSeq != null || delegatedTier(policy, ledger.tier?.predicted) || (!crossed && !leadDelegates(ledger, policy))) return false;
  ledger.tier.predictedSeq = nextSeq();
  // the plan did not say large (a declared size raises the prediction): it grew there mid-task
  ledger.tier.grewAt = ledger.tier.predictedSeq;
  return true;
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
  if (warning) {
    ledger.tierWarned = true;
    markDelegated(ledger, policyFor(ledger), true);
  }
  if (changed || warning) saveLedger(dir, ledger);
  return warning;
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
    if (tiered(current.ledger)) {
      const measured = measure({ config, policy, diff, baseline, now, root: ctx.root, dir: current.dir, repos });
      if (reconcileTier(current.ledger, policy, measured).length) flipped = true;
      // a new measured size is kept: a later re-prediction reads it
      if (current.ledger.tier?.measured?.tier !== measured.tier) flipped = true;
      current.ledger.tier = { ...current.ledger.tier, measured };
      if (markDelegated(current.ledger, policy)) flipped = true;
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
