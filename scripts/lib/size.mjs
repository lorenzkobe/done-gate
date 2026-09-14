import { nextSeq } from "./events.mjs";
import { loadPolicy, requires, tierFor, tierMax } from "./policy.mjs";
import { gitNumstat, gitTracked } from "./tree.mjs";
import { buildState } from "./assess.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";

// Steps a small task may skip, per playbook. Only the feature playbook has a design huddle
// and a QA reconcile round; bugfix's {reconcile} is the proof that the failing test now
// passes and refactor has neither, so tier small skips nothing there. Skipped steps come
// back the moment the diff outgrows the tier.
export const OPTIONAL_STEPS = { feature: ["skeptic", "reconcile"], bugfix: [], refactor: [] };
const TIERED_PLAYBOOKS = new Set(Object.keys(OPTIONAL_STEPS));
export function optionalSteps(ledgerOrPlaybook) {
  const playbook = typeof ledgerOrPlaybook === "string" ? ledgerOrPlaybook : ledgerOrPlaybook?.playbook;
  return OPTIONAL_STEPS[playbook] ?? [];
}
const AUTO_NOTE = "tier small (predicted)";

export function tiered(ledger) {
  return Boolean(ledger) && TIERED_PLAYBOOKS.has(ledger.playbook);
}

// predicted stays null until `gate note plan --files` names the files; the measured diff
// alone then decides, so a task that never predicts is judged by what it actually changed.
export function emptyTier() {
  return { predicted: null, predictedFiles: [], measured: null, autoNa: [], reopened: [] };
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
    reopened: Array.isArray(t.reopened) ? t.reopened : [],
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
  tier.predicted = pred.tier;
  tier.predictedFiles = paths;
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
// goes back to blank. DONE, WAIVED and SKIPPED are never touched. Returns the reopened keys.
export function reconcileTier(ledger, policy, measured) {
  if (!tiered(ledger)) return [];
  const tier = (ledger.tier = tierOf(ledger));
  const reopened = [];
  for (const key of requiredSteps(policy, effectiveTier(policy, ledger, measured), ledger)) {
    const step = ledger.steps.find((s) => s.key === key);
    if (step && step.state === "N/A") {
      blank(step);
      if (!tier.reopened.includes(key)) tier.reopened.push(key);
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
  out.push(`auto-N/A: ${t.autoNa.length ? t.autoNa.map((k) => `{${k}}`).join(", ") : "none"} · reopened: ${t.reopened.length ? t.reopened.map((k) => `{${k}}`).join(", ") : "none"}`);
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

