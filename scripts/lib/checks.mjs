import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Named repo checks, opted into via gate.json "checks". Each returns an unmet text or null.
const CHECKS = {
  "claude-md-budget": ({ root, changed }) => {
    const file = path.join(root, "CLAUDE.md");
    if (!existsSync(file)) return null;
    if (!changed.includes("CLAUDE.md")) return null;
    const size = statSync(file).size;
    return size > 150_000 ? `CLAUDE.md is ${size} chars, over the 150000 budget an assistant can load. Move detail into the linked docs before closing.` : null;
  },
  "migration-number": ({ root, changed }) => {
    const added = changed.filter((p) => /^supabase\/migrations\/\d{4}_.*\.sql$/.test(p));
    if (!added.length) return null;
    const dir = path.join(root, "supabase", "migrations");
    const max = Math.max(...readdirSync(dir).map((f) => Number(/^(\d{4})_/.exec(f)?.[1] ?? 0)));
    const claude = path.join(root, "CLAUDE.md");
    if (!existsSync(claude)) return null;
    const m = /Next number:\s*`?(\d{4})`?/.exec(readFileSync(claude, "utf8"));
    if (!m) return "CLAUDE.md has no `Next number:` line for migrations.";
    const expected = String(max + 1).padStart(4, "0");
    return m[1] === expected ? null : `migration ${String(max).padStart(4, "0")} was added but CLAUDE.md says the next number is ${m[1]}; it should say ${expected}.`;
  },
};

export function runChecks({ config, root, changed }) {
  const out = [];
  for (const name of config.checks ?? []) {
    const fn = CHECKS[name];
    if (!fn) {
      out.push(`unknown check "${name}" in gate.json (have: ${Object.keys(CHECKS).join(", ")})`);
      continue;
    }
    try {
      const text = fn({ root, changed });
      if (text) out.push(`${name}: ${text}`);
    } catch (error) {
      out.push(`${name} could not run: ${error.message}`);
    }
  }
  return out;
}
