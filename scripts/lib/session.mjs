import { readFileSync } from "node:fs";
import path from "node:path";
import { assess } from "./assess.mjs";
import { ensureSession } from "./session-state.mjs";

function mandate(ctx) {
  return readFileSync(path.join(ctx.pluginRoot, "hooks", "session-start.md"), "utf8");
}

export const verbs = {
  "session-start"(ctx) {
    if (ctx.input?.agent_id) return; // subagents get no mandate and no snapshot
    if (!ctx.session) return;
    ensureSession(ctx.stateDir, ctx.root, ctx.session);
    const parts = [mandate(ctx)];
    try {
      const { state, unmet } = assess(ctx, {});
      if (state.ledger) {
        parts.push(
          `\n<done-gate-status>\nOpen ledger: ${state.dir} (${state.ledger.playbook}, ${state.ledger.status}). ` +
            `${unmet.length} unmet gate item(s). Run \`gate check\` before continuing.\n</done-gate-status>`,
        );
      }
    } catch {
      // status is a courtesy; the mandate still ships
    }
    ctx.out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n") } });
  },
};
