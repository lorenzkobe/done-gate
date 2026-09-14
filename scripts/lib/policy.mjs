import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Plugin-level policy: which helpers a task of a given size needs and on which model.
// It lives in models.json, not in the repo's gate.json, so a plugin upgrade mid-task
// never trips R13 (which hashes the repo config).
export const DEFAULT_POLICY = Object.freeze({
  roles: { skeptic: "sonnet", qa: "opus", reviewer: "sonnet", "reviewer-2": "opus" },
  tiers: {
    small: { maxFiles: 1, maxLines: 40, requires: ["qa", "reviewer"] },
    standard: { maxFiles: 10, maxLines: 400, requires: ["skeptic", "qa", "reviewer"] },
    large: { requires: ["skeptic", "qa", "reviewer", "reviewer:opus"] },
  },
  forceStandard: ["ui", "schema", "highRisk"],
  escalate: { reviewerRound2: { model: "opus", whenActOnAtLeast: 2, orTier: "large" } },
  ceiling: { helpersPerTask: 6 },
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
