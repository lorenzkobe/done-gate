import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assess } from "./assess.mjs";
import { loadConfig, configPath } from "./config.mjs";
import { currentLedger, openRuns } from "./ledger.mjs";
import { loadSession } from "./session-state.mjs";

// Read-only verbs. `check` prints only what is still unmet; "clean" when nothing is.
// `doctor` prints the plugin, config, session and ledger state for debugging.
export const verbs = {
  check(ctx) {
    const { unmet } = assess(ctx, {});
    if (unmet.length === 0) {
      ctx.out("clean");
      return;
    }
    unmet.forEach((u, i) => ctx.out(`${i + 1}. ${u.rule} — ${u.text}`));
  },

  doctor(ctx) {
    ctx.out(`done-gate ${ctx.version} · node ${process.version} · ${process.platform}`);
    ctx.out(`repo: ${ctx.root}`);
    const config = loadConfig(ctx.root);
    ctx.out(`config: ${config.explicit ? configPath(ctx.root) : "defaults (no .claude/gate.json)"}`);
    ctx.out(`  source: ${config.source.join(", ")}${config.sourceExclude.length ? ` (excluding ${config.sourceExclude.join(", ")})` : ""}`);
    ctx.out(`  tests: ${config.tests.join(", ")}`);
    ctx.out(`  ui: ${config.ui.join(", ")}`);
    ctx.out(`  schema: ${config.schema.join(", ") || "none"}`);
    ctx.out(`  highRisk: ${config.highRisk.join(", ") || "none"}`);
    ctx.out(`  verify: ${config.verify.map((v) => `${v.cmd} (${v.timeout}s)${v.when === "source" ? " (when source)" : ""}`).join(" · ") || "NOTHING — add verify commands to gate.json"}`);
    ctx.out(`  checks: ${config.checks.join(", ") || "none"}`);
    const driverSkill = path.join(ctx.root, ".claude", "skills", "verify", "SKILL.md");
    ctx.out(`  driver: ${existsSync(driverSkill) ? driverSkill : "none — run /done-gate:verify-setup once"}`);
    const session = ctx.session ? loadSession(ctx.stateDir, ctx.session) : null;
    ctx.out(`session: ${ctx.session ?? "none"}${session ? ` (baseline ${Object.keys(session.baseline.files).length} files, blocks ${session.blocks.count})` : " (no state yet — SessionStart hook has not run for it)"}`);
    let current = null;
    try {
      current = ctx.session ? currentLedger(ctx.stateDir, ctx.session) : null;
    } catch (error) {
      ctx.out(`ledger: UNREADABLE — ${error.message}`);
    }
    ctx.out(`ledger: ${current ? `${current.dir} (${current.ledger.playbook}, ${current.ledger.status})` : "none"}`);
    const open = openRuns(ctx.stateDir);
    if (open.length) ctx.out(`open runs: ${open.map((r) => path.basename(r.dir)).join(", ")}`);
    const errLog = path.join(ctx.stateDir, "gate-error.log");
    if (existsSync(errLog)) {
      const lines = readFileSync(errLog, "utf8").trim().split("\n");
      ctx.out(`gate errors: ${lines.length} (last: ${lines[lines.length - 1].slice(0, 120)})`);
    } else ctx.out("gate errors: none");
  },
};
