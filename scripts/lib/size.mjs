import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextSeq } from "./events.mjs";
import { baseCopy, copyNumstat, gitNumstat, gitTracked, indentMatters } from "./tree.mjs";
import { buildState } from "./assess.mjs";
import { UsageError } from "./context.mjs";
import { repoPath } from "./paths.mjs";
import { printNext } from "./next.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Plugin-level policy: which helpers a task of a given size needs. Helpers run on the
// session's own model (agents/*.md say `model: inherit`), so no model is named here. It
// lives in models.json, not in the repo's gate.json, so a plugin upgrade mid-task never
// trips R13 (which hashes the repo config).
export const DEFAULT_POLICY = Object.freeze({
  tiers: {
    tiny: { maxFiles: 1, maxLines: 15, requires: [] },
    small: { maxFiles: 1, maxLines: 40, requires: ["reviewer"] },
    standard: { maxFiles: 10, maxLines: 400, requires: ["skeptic", "reviewer"] },
    large: { requires: ["skeptic", "qa", "worker", "reviewer", "reviewer-2"] },
  },
  forceStandard: ["ui", "schema", "highRisk"],
  // a second reviewer round: after this many Act-on items in round 1, or at this tier
  escalate: { reviewerRound2: { whenActOnAtLeast: 2, orTier: "large" } },
  ceiling: { helpersPerTask: 10 },
  // the size at which the lead stops editing and briefs a worker per piece; below it the lead
  // implements with its own context
  delegatesAt: "large",
  // the most source lines one review round may cover; a larger change is reviewed in pieces
  reviewMaxLines: 400,
});

// A requires entry names a role. An older policy wrote "reviewer:opus" for the second review
// round; that is the reviewer-2 role now. Any other "role:model" keeps its role.
function normaliseRequires(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const [role, model] = String(entry).split(":");
    const name = model && role === "reviewer" ? "reviewer-2" : role;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function normaliseTiers(tiers) {
  const out = {};
  for (const [name, t] of Object.entries(tiers)) out[name] = { ...t, requires: normaliseRequires(t?.requires) };
  return out;
}

function merge(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const p = r.policy && typeof r.policy === "object" ? r.policy : {};
  const tiers = p.tiers && typeof p.tiers === "object" && Object.keys(p.tiers).length ? normaliseTiers(p.tiers) : DEFAULT_POLICY.tiers;
  const round2 = p.escalate && typeof p.escalate === "object" && p.escalate.reviewerRound2 && typeof p.escalate.reviewerRound2 === "object" ? p.escalate.reviewerRound2 : {};
  const resolved = {
    tiers,
    forceStandard: Array.isArray(p.forceStandard) ? p.forceStandard.map(String) : DEFAULT_POLICY.forceStandard,
    // the old `model` key is dropped: helpers inherit the session's model
    escalate: { reviewerRound2: { ...DEFAULT_POLICY.escalate.reviewerRound2, ...round2, model: undefined } },
    ceiling: { ...DEFAULT_POLICY.ceiling, ...(p.ceiling && typeof p.ceiling === "object" ? p.ceiling : {}) },
    delegatesAt: typeof p.delegatesAt === "string" && p.delegatesAt ? p.delegatesAt : DEFAULT_POLICY.delegatesAt,
    reviewMaxLines: Math.max(1, Number.isFinite(p.reviewMaxLines) ? p.reviewMaxLines : DEFAULT_POLICY.reviewMaxLines),
  };
  delete resolved.escalate.reviewerRound2.model;
  // hashed like the repo config, so a mid-task edit to models.json is caught (R13)
  return { ...resolved, hash: createHash("sha1").update(JSON.stringify(resolved)).digest("hex") };
}

// Never throws: the Stop hook calls this, and a broken models.json must not wedge a session.
export function loadPolicy(file = path.join(pluginRoot, "models.json")) {
  try {
    if (!existsSync(file)) return merge(null);
    return merge(JSON.parse(readFileSync(file, "utf8").replace(/\r/g, "")));
  } catch {
    return merge(null);
  }
}

// The policy a task is judged by: the one pinned into its ledger at open, so a plugin
// upgrade mid-task changes nothing for it; models.json for a ledger from before pinning.
export function policyFor(ledger) {
  // the pin is re-merged, so a field this version added is backfilled from the defaults
  return ledger?.policy?.tiers ? merge({ policy: ledger.policy }) : loadPolicy();
}

export function tierOrder(policy) {
  return Object.keys(policy.tiers);
}

// The later of two tiers in policy order; null-safe so a missing measurement never lowers a prediction.
export function tierMax(policy, a, b) {
  const order = tierOrder(policy);
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia < 0) return ib < 0 ? null : b;
  if (ib < 0) return a;
  return ia >= ib ? a : b;
}

// A tier that needs no helper is reached only by evidence; anything weaker lands one tier up.
function aboveLowest(policy, tier) {
  const order = tierOrder(policy);
  return tier === order[0] && order.length > 1 && !requires(policy, tier).length ? order[1] : tier;
}

export function requires(policy, tier) {
  return policy.tiers[tier]?.requires ?? [];
}

// Smallest tier whose limits hold; a tier without limits is the catch-all. Any forced
// category raises the answer to at least "standard".
export function tierFor(policy, { files = 0, lines = 0, forced = [] } = {}) {
  const order = tierOrder(policy);
  let tier = order[order.length - 1];
  for (const name of order) {
    const t = policy.tiers[name];
    const filesOk = t.maxFiles == null || files <= t.maxFiles;
    const linesOk = t.maxLines == null || lines <= t.maxLines;
    if (filesOk && linesOk) {
      tier = name;
      break;
    }
  }
  if (forced.length && order.includes("standard")) tier = tierMax(policy, tier, "standard");
  return tier;
}

// The steps a tier may drop, per playbook, and the helper role each one stands for: a step
// is required exactly when its role is in the tier's requires. Every tiered playbook has a
// design huddle and a review. A dropped step comes back the moment the diff outgrows the tier.
export const OPTIONAL_STEPS = { feature: ["skeptic", "review"], bugfix: ["skeptic", "review"], refactor: ["skeptic", "review"] };
const STEP_ROLE = { skeptic: "skeptic", review: "reviewer" };
const TIERED_PLAYBOOKS = new Set(Object.keys(OPTIONAL_STEPS));
export function optionalSteps(ledgerOrPlaybook) {
  const playbook = typeof ledgerOrPlaybook === "string" ? ledgerOrPlaybook : ledgerOrPlaybook?.playbook;
  return OPTIONAL_STEPS[playbook] ?? [];
}
const autoNote = (tier) => `tier ${tier} (predicted)`;
const isAutoNote = (note) => /^tier \w+ \(predicted\)$/.test(note ?? "");

export function tiered(ledger) {
  return Boolean(ledger) && TIERED_PLAYBOOKS.has(ledger.playbook);
}

// Whether a tier is one where the lead delegates: policy.delegatesAt or anything past it.
export function delegatedTier(policy, tier) {
  const order = tierOrder(policy);
  const at = order.indexOf(policy.delegatesAt);
  const i = tier ? order.indexOf(tier) : -1;
  return at >= 0 && i >= at;
}

// At policy.delegatesAt (large by default) the lead plans and delegates; workers edit the
// source. Below it the lead implements itself: it holds the context. The larger of the
// prediction and the last measurement decides, so a task that outgrows its prediction hands
// its remaining edits to a worker; with neither known yet, the lead may edit (R2 already
// demands a plan first). Returns that size, or null when the lead may edit.
export function leadDelegates(ledger, policy = policyFor(ledger)) {
  if (!tiered(ledger)) return null;
  const t = tierOf(ledger);
  const size = tierMax(policy, t.predicted, t.measured?.tier ?? null);
  return delegatedTier(policy, size) ? size : null;
}

// predicted stays null until `gate note plan --files` names the files; the measured diff
// alone then decides, so a task that never predicts is judged by what it actually changed.
export function emptyTier() {
  return { predicted: null, predictedFiles: [], declared: null, measured: null, autoNa: [], predictedSeq: null };
}

// A tier record from an older ledger, or a damaged one, is normalised rather than trusted.
export function tierOf(ledger) {
  const t = ledger?.tier;
  const base = emptyTier();
  if (!t || typeof t !== "object" || Array.isArray(t)) return base;
  return {
    predicted: typeof t.predicted === "string" ? t.predicted : null,
    predictedFiles: Array.isArray(t.predictedFiles) ? t.predictedFiles : [],
    declared: typeof t.declared === "string" ? t.declared : null,
    measured: t.measured && typeof t.measured === "object" ? t.measured : null,
    autoNa: Array.isArray(t.autoNa) ? t.autoNa : [],
    predictedSeq: typeof t.predictedSeq === "number" ? t.predictedSeq : null,
  };
}

const CATEGORY_PRED = { ui: "isUi", schema: "isSchema", highRisk: "isHighRisk" };

export function forcedFor(config, policy, paths) {
  return policy.forceStandard.filter((cat) => {
    const pred = config[CATEGORY_PRED[cat]];
    return typeof pred === "function" && paths.some((p) => pred(p));
  });
}

// Only source files that are not tests count toward size; tests grow with the case table.
function sized(config, paths) {
  return paths.filter((p) => config.isSource(p) && !config.isTest(p));
}

// A plan naming no source file says nothing about the size, so it never predicts the lowest tier.
export function predictTier(policy, config, paths) {
  const files = sized(config, paths);
  const forced = forcedFor(config, policy, files);
  let tier = tierFor(policy, { files: files.length, lines: 0, forced });
  if (!files.length) tier = aboveLowest(policy, tier);
  return { tier, files: files.length, forced };
}

// Exact for tracked files clean at open (git) and files with a base copy; anything else is a
// line-count delta flagged as an estimate. Whitespace-only lines count only where indentation is meaning.
export function measure({ config, policy, diff, baseline, now, root, dir = null, quick = false, repos = [] }) {
  const paths = sized(config, diff.changed);
  const dirty = new Set(baseline?.dirty ?? []);
  // quick is the edit hook's shape: one git process, no ls-files, no base copy read
  const copies = new Map(quick ? [] : paths.map((p) => [p, baseCopy(dir, baseline, p, repos)]).filter(([, copy]) => copy));
  const tracked = quick ? null : gitTracked(root, repos);
  const exact = paths.filter((p) => !dirty.has(p) && !copies.has(p) && (quick || tracked.has(p) || diff.deleted.includes(p)));
  const indented = quick ? [] : exact.filter(indentMatters);
  const plain = quick ? exact : exact.filter((p) => !indentMatters(p));
  const ref = baseline?.head ?? "HEAD";
  const heads = baseline?.heads;
  const numstat = new Map([
    ...(plain.length ? gitNumstat(root, plain, ref, { ignoreWhitespace: true, repos, heads }) : []),
    ...(indented.length ? gitNumstat(root, indented, ref, { repos, heads }) : []),
  ]);
  const headOf = (p) => {
    const at = repoPath(root, p, repos);
    return at.index < 0 ? baseline?.head : heads?.[at.prefix];
  };
  const renamedAway = new Set([...numstat.values()].map((r) => r.from).filter(Boolean));
  const details = [];
  for (const p of paths) {
    if (copies.has(p)) {
      // deleted after open: every line of the copy went
      const lines = diff.deleted.includes(p) ? (baseline.files[p]?.l ?? 0) : copyNumstat(root, copies.get(p), p, { ignoreWhitespace: !indentMatters(p), repos });
      details.push({ path: p, lines, source: "copy", estimate: false });
      continue;
    }
    const row = numstat.get(p);
    // renamed from a file with a base copy: an added file, since git's row measures from HEAD
    if (row && !row.binary && !copies.has(row.from)) {
      details.push({ path: p, lines: row.added + row.deleted, source: "git", estimate: false, ...(row.from ? { from: row.from } : {}) });
      continue;
    }
    if (renamedAway.has(p) && !dirty.has(p)) {
      details.push({ path: p, lines: 0, source: "git", estimate: false, renamedTo: true });
      continue;
    }
    // git was asked about this file and, whitespace ignored, found nothing changed
    if (!row && !quick && headOf(p) && tracked.has(p) && !dirty.has(p) && !indentMatters(p)) {
      details.push({ path: p, lines: 0, source: "git", estimate: false });
      continue;
    }
    const before = baseline?.files?.[p]?.l;
    const after = now?.files?.[p]?.l;
    let lines;
    if (before === null || after === null) lines = 1; // binary: it changed, lines mean nothing
    else if (diff.added.includes(p)) lines = after ?? 0;
    else if (diff.deleted.includes(p)) lines = before ?? 0;
    else if (typeof before !== "number") lines = after ?? 1;
    else lines = Math.max(1, Math.abs((after ?? 0) - before));
    details.push({ path: p, lines, source: "delta", estimate: true });
  }
  const lines = details.reduce((n, d) => n + d.lines, 0);
  const forced = forcedFor(config, policy, paths);
  let tier = tierFor(policy, { files: paths.length, lines, forced });
  const reasons = [];
  if (details.some((d) => d.estimate) && aboveLowest(policy, tier) !== tier) {
    reasons.push("estimated lines");
    tier = aboveLowest(policy, tier);
  }
  for (const name of Object.keys(policy.tiers)) {
    const t = policy.tiers[name];
    if (name === tier) break;
    if (t.maxFiles != null && paths.length > t.maxFiles) reasons.push(`${paths.length} files > ${name}.maxFiles ${t.maxFiles}`);
    else if (t.maxLines != null && lines > t.maxLines) reasons.push(`${lines} lines > ${name}.maxLines ${t.maxLines}`);
  }
  for (const cat of forced) reasons.push(`forced by ${cat}`);
  return { tier, files: paths.length, lines, forced, reasons, details };
}

export function requiredSteps(policy, tier, ledger) {
  const roles = requires(policy, tier);
  return optionalSteps(ledger).filter((key) => roles.includes(STEP_ROLE[key]));
}

function blank(step) {
  Object.assign(step, { state: null, note: null, evidence: null, seq: nextSeq() });
}

// Prediction from the files the plan names, raised to a size the plan declares (a one-file
// 500-line migration is large by lines, which no file count can see). Each optional step
// the predicted tier does not require is marked N/A; one it requires that an earlier
// prediction dropped is given back. A step closed by hand keeps its own note and is never
// touched.
export function applyPrediction(ledger, policy, config, paths, declared = null) {
  if (!tiered(ledger)) return null;
  const tier = tierOf(ledger);
  // a declaration outlives the plan note that made it: a later --files alone keeps it
  tier.declared = declared ?? tier.declared;
  const pred = { ...predictTier(policy, config, paths), declared: tier.declared };
  if (tier.declared) pred.tier = tierMax(policy, pred.tier, tier.declared);
  const wasDelegated = delegatedTier(policy, tier.predicted);
  const delegated = delegatedTier(policy, pred.tier);
  tier.predicted = pred.tier;
  tier.predictedFiles = paths;
  // R16 counts the lead's source edits from the moment the task became a delegated size;
  // a later re-prediction never moves that mark forward and erases a standing finding
  if (delegated && tier.predictedSeq === null) tier.predictedSeq = nextSeq();
  if (!delegated && !delegatedTier(policy, tier.measured?.tier)) tier.predictedSeq = null;
  const required = requiredSteps(policy, pred.tier, ledger);
  tier.autoNa = [];
  for (const key of optionalSteps(ledger)) {
    const step = ledger.steps.find((s) => s.key === key);
    if (!step) continue;
    const auto = step.state === "N/A" && isAutoNote(step.note);
    if (required.includes(key)) {
      if (auto) blank(step);
    } else {
      if (step.state === null) Object.assign(step, { state: "N/A", note: autoNote(pred.tier), evidence: null, seq: nextSeq() });
      if (step.state === "N/A" && isAutoNote(step.note)) tier.autoNa.push(key);
    }
  }
  ledger.tier = tier;
  return { ...pred, tier: pred.tier };
}

export function effectiveTier(policy, ledger, measured) {
  const predicted = tierOf(ledger).predicted;
  const measuredTier = measured?.tier ?? null;
  return tierMax(policy, predicted, measuredTier) ?? "standard";
}

// The measured diff outgrew the prediction: any optional step still N/A (auto or by hand)
// goes back to blank, and R8 names it. DONE, WAIVED and SKIPPED are never touched.
export function reconcileTier(ledger, policy, measured) {
  if (!tiered(ledger)) return [];
  ledger.tier = tierOf(ledger);
  const reopened = [];
  for (const key of requiredSteps(policy, effectiveTier(policy, ledger, measured), ledger)) {
    const step = ledger.steps.find((s) => s.key === key);
    if (step && step.state === "N/A") {
      blank(step);
      reopened.push(key);
    }
  }
  ledger.tier.autoNa = ledger.tier.autoNa.filter((key) => !reopened.includes(key));
  return reopened;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function renderTierBlock(ledger, policy, measured, { details = false } = {}) {
  const t = tierOf(ledger);
  const eff = effectiveTier(policy, ledger, measured);
  const out = [];
  const predicted = t.predicted ? `predicted ${t.predicted}${t.predictedFiles.length ? ` (${plural(t.predictedFiles.length, "file")}${t.declared ? `, declared ${t.declared}` : ""})` : t.declared ? ` (declared)` : ""}` : "predicted: none (no --files)";
  const measuredText = measured
    ? `measured ${measured.tier}: ${plural(measured.files, "file")}, ${plural(measured.lines, "line")}${measured.forced.length ? ` · forced: ${measured.forced.join(", ")}` : ""}`
    : "measured: not yet";
  out.push(`tier: ${eff} · ${predicted} · ${measuredText}`);
  const helpers = requires(policy, eff);
  const esc = policy.escalate?.reviewerRound2;
  const escText = esc ? ` · round 2 (same reviewer, fresh context) when ${esc.whenActOnAtLeast}+ Act-on or tier ${esc.orTier}` : "";
  out.push(`requires: ${helpers.length ? helpers.join(", ") : "none"}${escText} · ceiling ${policy.ceiling.helpersPerTask} helpers/task`);
  out.push(`piece cap ${policy.reviewMaxLines} lines: a review round covers at most that many source lines (\`gate brief reviewer --files a,b\` for a piece)`);
  out.push(`auto-N/A: ${t.autoNa.length ? t.autoNa.map((k) => `{${k}}`).join(", ") : "none"}`);
  if (details && measured?.details?.length) {
    out.push(`files: ${measured.details.map((d) => `${d.path} ${d.lines}${d.estimate ? " (line-delta estimate)" : ""}`).join(" · ")}`);
  }
  return out;
}

export const verbs = {
  size(ctx) {
    const state = buildState(ctx, {});
    if (!state.ledger) throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
    if (!tiered(state.ledger)) {
      ctx.out(`playbook ${state.ledger.playbook} is not tiered; every step applies`);
      return;
    }
    for (const line of renderTierBlock(state.ledger, state.policy, state.tier?.measured ?? null, { details: true })) ctx.out(line);
    printNext(ctx);
  },
};

