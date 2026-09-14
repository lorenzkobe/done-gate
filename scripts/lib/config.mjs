import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { matchAny } from "./glob.mjs";
import { IGNORE_CASE } from "./paths.mjs";

export const DEFAULTS = Object.freeze({
  source: ["**"],
  sourceExclude: ["docs/**", "**/*.md"],
  tests: ["**/{tests,test,__tests__,spec}/**", "**/*.{test,spec}.*"],
  ui: ["**/*.{tsx,vue,svelte}"],
  schema: [],
  docs: ["docs/**", "**/*.md"],
  highRisk: [],
  checks: [],
  driver: null,
  verifyTimeout: 600,
});

// The gate's own state, dependencies and VCS internals never count as source.
const ALWAYS_EXCLUDE = [
  ".claude/gate/**",
  ".claude/**/*.lock",
  ".claude/scheduled_tasks*",
  ".claude/settings.local.json",
  "node_modules/**",
  ".git/**",
  ".gitignore",
];

const SCRIPT_ORDER = ["lint", "typecheck", "test", "build"];

function packageManager(root) {
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock"))) return "bun run";
  return "npm run";
}

function defaultVerify(root) {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
  } catch {
    return [];
  }
  const pm = packageManager(root);
  return SCRIPT_ORDER.filter((name) => typeof scripts[name] === "string").map((name) => `${pm} ${name}`);
}

function normaliseVerify(entries, fallbackTimeout) {
  return (entries ?? []).map((entry) =>
    typeof entry === "string"
      ? { cmd: entry, timeout: fallbackTimeout }
      : { cmd: String(entry.cmd), timeout: Number(entry.timeout ?? fallbackTimeout) },
  );
}

function arr(value, fallback) {
  return Array.isArray(value) ? value.map(String) : fallback;
}

export function configPath(root) {
  return path.join(root, ".claude", "gate.json");
}

export function loadConfig(root) {
  const file = configPath(root);
  let raw = null;
  if (existsSync(file)) {
    raw = JSON.parse(readFileSync(file, "utf8"));
  }
  const explicit = raw !== null;
  const r = raw ?? {};
  const resolved = {
    explicit,
    source: arr(r.source, DEFAULTS.source),
    sourceExclude: explicit && Array.isArray(r.source) ? [] : DEFAULTS.sourceExclude,
    tests: arr(r.tests, DEFAULTS.tests),
    ui: arr(r.ui, DEFAULTS.ui),
    schema: arr(r.schema, DEFAULTS.schema),
    docs: arr(r.docs, DEFAULTS.docs),
    highRisk: arr(r.highRisk, DEFAULTS.highRisk),
    checks: arr(r.checks, DEFAULTS.checks),
    driver: typeof r.driver === "string" ? r.driver : DEFAULTS.driver,
    verify: normaliseVerify(r.verify ?? defaultVerify(root), DEFAULTS.verifyTimeout),
  };
  const hash = createHash("sha1").update(JSON.stringify(resolved)).digest("hex");
  const opts = { ignoreCase: IGNORE_CASE };
  const not = (globs) => (p) => !matchAny(globs, p, opts);
  return {
    ...resolved,
    hash,
    isSource: (p) =>
      matchAny(resolved.source, p, opts) &&
      not(resolved.sourceExclude)(p) &&
      not(ALWAYS_EXCLUDE)(p),
    isTest: (p) => matchAny(resolved.tests, p, opts),
    isUi: (p) => matchAny(resolved.ui, p, opts),
    isSchema: (p) => matchAny(resolved.schema, p, opts),
    isDoc: (p) => matchAny(resolved.docs, p, opts),
    isHighRisk: (p) => matchAny(resolved.highRisk, p, opts),
  };
}
