import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { IGNORE_CASE } from "./paths.mjs";

// Dependency-free glob matcher over root-relative POSIX paths.
// Supports **, *, ?, and {a,b} alternation. Everything else is literal.

function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const before = pattern.slice(0, m.index);
  const after = pattern.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((alt) => expandBraces(`${before}${alt}${after}`));
}

function escapeRegex(ch) {
  return /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function toRegexSource(pattern) {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      const followedBySlash = pattern[i + 2] === "/";
      const precededBySlash = i > 0 && pattern[i - 1] === "/";
      if (followedBySlash) {
        // "**/" — zero or more leading directories
        out += "(?:.*/)?";
        i += 3;
        continue;
      }
      if (precededBySlash && i + 2 === pattern.length) {
        // trailing "/**" — the directory itself or anything beneath it
        out = out.slice(0, -1); // drop the "/" already emitted
        out += "(?:/.*)?";
        i += 2;
        continue;
      }
      out += ".*";
      i += 2;
      continue;
    }
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += escapeRegex(ch);
    i += 1;
  }
  return out;
}

const cache = new Map();

export function globToRegex(pattern, { ignoreCase = false } = {}) {
  const key = `${ignoreCase ? "i" : "s"}:${pattern}`;
  let re = cache.get(key);
  if (!re) {
    const source = expandBraces(pattern).map(toRegexSource).join("|");
    re = new RegExp(`^(?:${source})$`, ignoreCase ? "i" : "");
    cache.set(key, re);
  }
  return re;
}

export function matchGlob(pattern, relPath, opts) {
  return globToRegex(pattern, opts).test(relPath);
}

export function matchAny(patterns, relPath, opts) {
  return patterns.some((p) => matchGlob(p, relPath, opts));
}

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
  // build only matters when the implementation changed; lint, typecheck and test always run
  return SCRIPT_ORDER.filter((name) => typeof scripts[name] === "string").map((name) => ({ cmd: `${pm} ${name}`, when: name === "build" ? "source" : "always" }));
}

const WHEN = new Set(["always", "source"]);

// One package.json build script call and nothing else: `npm run build`, `pnpm build`. A
// compound command (&&, ;, |), or a tool whose build also tests (gradle, make), runs always.
const BUILD_ONLY = /^\s*(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+build\s*$/;

// An entry without `when` that only builds gets "source", the same default package.json's
// build script gets; an explicit `when` always wins.
function normaliseVerify(entries, fallbackTimeout) {
  return (entries ?? []).map((entry) => {
    const e = typeof entry === "string" ? { cmd: entry } : entry;
    const cmd = String(e.cmd);
    const when = WHEN.has(e.when) ? e.when : BUILD_ONLY.test(cmd) ? "source" : "always";
    return { cmd, timeout: Number(e.timeout ?? fallbackTimeout), when };
  });
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
  // R13 asks whether what the gate runs changed mid-task: the repo's config text (or its
  // absence) plus the verify command list it resolves to. A plugin upgrade that only
  // reshapes entries (a new field) does not move it; removing the test script does.
  const hash = createHash("sha1")
    .update(existsSync(file) ? readFileSync(file, "utf8") : "defaults")
    .update("\n")
    .update(resolved.verify.map((v) => v.cmd).join("\n"))
    .digest("hex");
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
