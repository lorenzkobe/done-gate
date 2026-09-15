import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextSeq } from "./events.mjs";
import { gitNumstat, gitTracked } from "./tree.mjs";
import { buildState } from "./assess.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Plugin-level policy: which helpers a task of a given size needs and on which model.
// It lives in models.json, not in the repo's gate.json, so a plugin upgrade mid-task
// never trips R13 (which hashes the repo config).
export const DEFAULT_POLICY = Object.freeze({
  roles: { skeptic: "sonnet", qa: "opus", reviewer: "sonnet", "reviewer-2": "opus", arbiter: "opus", worker: "sonnet" },
  tiers: {
    small: { maxFiles: 1, maxLines: 40, requires: ["qa", "reviewer"] },
    standard: { maxFiles: 10, maxLines: 400, requires: ["skeptic", "qa", "reviewer"] },
    large: { requires: ["skeptic", "qa", "reviewer", "reviewer:opus"] },
  },
  forceStandard: ["ui", "schema", "highRisk"],
  escalate: { reviewerRound2: { model: "opus", whenActOnAtLeast: 2, orTier: "large" } },
  ceiling: { helpersPerTask: 10 },
});

function merge(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const p = r.policy && typeof r.policy === "object" ? r.policy : {};
  const tiers = p.tiers && typeof p.tiers === "object" && Object.keys(p.tiers).length ? p.tiers : DEFAULT_POLICY.tiers;
  const resolved = {
    roles: { ...DEFAULT_POLICY.roles, ...(r.roles && typeof r.roles === "object" ? r.roles : {}) },
    tiers,
    forceStandard: Array.isArray(p.forceStandard) ? p.forceStandard.map(String) : DEFAULT_POLICY.forceStandard,
    escalate: { ...DEFAULT_POLICY.escalate, ...(p.escalate && typeof p.escalate === "object" ? p.escalate : {}) },
    ceiling: { ...DEFAULT_POLICY.ceiling, ...(p.ceiling && typeof p.ceiling === "object" ? p.ceiling : {}) },
  };
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

// Steps a small task may skip, per playbook. Only the feature playbook has a design huddle;
// bugfix and refactor have none, so tier small skips nothing there. Skipped steps come back
// the moment the diff outgrows the tier.
export const OPTIONAL_STEPS = { feature: ["skeptic"], bugfix: [], refactor: [] };
const TIERED_PLAYBOOKS = new Set(Object.keys(OPTIONAL_STEPS));
export function optionalSteps(ledgerOrPlaybook) {
  const playbook = typeof ledgerOrPlaybook === "string" ? ledgerOrPlaybook : ledgerOrPlaybook?.playbook;
  return OPTIONAL_STEPS[playbook] ?? [];
}
const AUTO_NOTE = "tier small (predicted)";

export function tiered(ledger) {
  return Boolean(ledger) && TIERED_PLAYBOOKS.has(ledger.playbook);
}

// At size standard or large the lead plans and delegates; workers edit the source. The
// larger of the prediction and the last measurement decides, so a task that outgrows a
// small prediction hands its remaining edits to a worker; with neither known yet, the lead
// may edit (R2 already demands a plan first).
// Returns that size, or null when the lead may edit.
export function leadDelegates(ledger, policy = loadPolicy()) {
  if (!tiered(ledger)) return null;
  const t = tierOf(ledger);
  const size = tierMax(policy, t.predicted, t.measured?.tier ?? null);
  return size !== null && size !== "small" ? size : null;
}

// predicted stays null until `gate note plan --files` names the files; the measured diff
// alone then decides, so a task that never predicts is judged by what it actually changed.
export function emptyTier() {
  return { predicted: null, predictedFiles: [], measured: null, autoNa: [], predictedSeq: null };
}

// A tier record from an older ledger, or a damaged one, is normalised rather than trusted.
export function tierOf(ledger) {
  const t = ledger?.tier;
  const base = emptyTier();
  if (!t || typeof t !== "object" || Array.isArray(t)) return base;
  return {
    predicted: typeof t.predicted === "string" ? t.predicted : null,
    predictedFiles: Array.isArray(t.predictedFiles) ? t.predictedFiles : [],
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

export function predictTier(policy, config, paths) {
  const files = sized(config, paths);
  const forced = forcedFor(config, policy, files);
  return { tier: tierFor(policy, { files: files.length, lines: 0, forced }), files: files.length, forced };
}

// Lines changed per file. Git answers exactly for tracked files that were clean when the
// task opened; everything else (dirty at open, untracked, no git) is a line-count delta,
// which can only undercount, so it is flagged as an estimate.
export function measure({ config, policy, diff, baseline, now, root }) {
  const paths = sized(config, diff.changed);
  const dirty = new Set(baseline?.dirty ?? []);
  const tracked = gitTracked(root);
  const exact = paths.filter((p) => (tracked.has(p) || diff.deleted.includes(p)) && !dirty.has(p));
  const numstat = exact.length ? gitNumstat(root, exact, baseline?.head ?? "HEAD") : new Map();
  const renamedAway = new Set([...numstat.values()].map((r) => r.from).filter(Boolean));
  const details = [];
  for (const p of paths) {
    const row = numstat.get(p);
    if (row && !row.binary) {
      details.push({ path: p, lines: row.added + row.deleted, source: "git", estimate: false, ...(row.from ? { from: row.from } : {}) });
      continue;
    }
    if (renamedAway.has(p) && !dirty.has(p)) {
      details.push({ path: p, lines: 0, source: "git", estimate: false, renamedTo: true });
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
  const tier = tierFor(policy, { files: paths.length, lines, forced });
  const reasons = [];
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
  return requires(policy, tier).includes("skeptic") ? optionalSteps(ledger) : [];
}

function blank(step) {
  Object.assign(step, { state: null, note: null, evidence: null, seq: nextSeq() });
}

// Prediction from the files the plan names. Small marks the optional steps N/A; a later,
// larger prediction gives those (and only those) back.
export function applyPrediction(ledger, policy, config, paths) {
  if (!tiered(ledger)) return null;
  const tier = tierOf(ledger);
  const pred = predictTier(policy, config, paths);
  const wasDelegated = tier.predicted !== null && tier.predicted !== "small";
  tier.predicted = pred.tier;
  tier.predictedFiles = paths;
  // R16 counts the lead's source edits from the moment the task became a delegated size;
  // a later re-prediction never moves that mark forward and erases a standing finding
  if (pred.tier !== "small" && (!wasDelegated || tier.predictedSeq === null)) tier.predictedSeq = nextSeq();
  if (pred.tier === "small") tier.predictedSeq = null;
  if (pred.tier === "small") {
    for (const key of optionalSteps(ledger)) {
      const step = ledger.steps.find((s) => s.key === key);
      if (step && step.state === null) {
        Object.assign(step, { state: "N/A", note: AUTO_NOTE, evidence: null, seq: nextSeq() });
        if (!tier.autoNa.includes(key)) tier.autoNa.push(key);
      }
    }
  } else {
    for (const key of tier.autoNa) {
      const step = ledger.steps.find((s) => s.key === key);
      if (step && step.state === "N/A" && step.note === AUTO_NOTE) blank(step);
    }
    tier.autoNa = [];
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
  return reopened;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function renderTierBlock(ledger, policy, measured, { details = false } = {}) {
  const t = tierOf(ledger);
  const eff = effectiveTier(policy, ledger, measured);
  const out = [];
  const predicted = t.predicted ? `predicted ${t.predicted}${t.predictedFiles.length ? ` (${plural(t.predictedFiles.length, "file")})` : ""}` : "predicted: none (no --files)";
  const measuredText = measured
    ? `measured ${measured.tier}: ${plural(measured.files, "file")}, ${plural(measured.lines, "line")}${measured.forced.length ? ` · forced: ${measured.forced.join(", ")}` : ""}`
    : "measured: not yet";
  out.push(`tier: ${eff} · ${predicted} · ${measuredText}`);
  const helpers = requires(policy, eff).map((h) => {
    const [role, model] = h.split(":");
    return `${role} (${model ?? policy.roles[role] ?? "?"})`;
  });
  const esc = policy.escalate?.reviewerRound2;
  const escText = esc ? ` · round 2 on ${esc.model} when ${esc.whenActOnAtLeast}+ Act-on or tier ${esc.orTier}` : "";
  out.push(`requires: ${helpers.join(", ")}${escText} · ceiling ${policy.ceiling.helpersPerTask} helpers/task`);
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

