import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assess } from "./assess.mjs";
import { ensureSession, loadSession } from "./session-state.mjs";
import { recordGateError } from "./context.mjs";
import { attachLedger, openRuns } from "./ledger.mjs";

function mandate(ctx) {
  return readFileSync(path.join(ctx.pluginRoot, "hooks", "session-start.md"), "utf8");
}

export const verbs = {
  "session-start"(ctx) {
    if (ctx.input?.agent_id) return; // subagents get no mandate and no snapshot
    if (!ctx.session) return;
    ensureSession(ctx.stateDir, ctx.root, ctx.session);
    try {
      mkdirSync(ctx.stateDir, { recursive: true });
      writeFileSync(path.join(ctx.stateDir, "current-session"), ctx.session);
    } catch (error) {
      // courtesy for shell-run verbs; the hooks keep their own id, and the mandate must still ship
      try {
        recordGateError(error, "session-start");
      } catch {
        // the state dir itself is unwritable; nothing left to record
      }
    }
    const parts = [mandate(ctx)];
    // A /clear, resume or compaction must not orphan a task: join the newest open run.
    try {
      if (!loadSession(ctx.stateDir, ctx.session)?.current) {
        const [newest] = openRuns(ctx.stateDir);
        if (newest) attachLedger(ctx, newest.ledger.slug);
      }
    } catch {
      // attach is a courtesy; the Stop gate will still say R1 if it matters
    }
    try {
      const { state, unmet } = assess(ctx, {});
      if (state.ledger) {
        // a run opened by an earlier session may be stale: say so, and how to let it go
        const inherited = state.ledger.sessions?.[0] !== ctx.session;
        parts.push(
          `\n<done-gate-status>\nOpen ledger: ${state.dir} (${state.ledger.playbook}, ${state.ledger.status}). ` +
            `${unmet.length} unmet gate item(s). Run \`gate check\` before continuing.` +
            (inherited ? ` This ledger was opened by another session on ${String(state.ledger.openedAt).slice(0, 10)}; if that work is over, \`gate abandon ${state.ledger.slug} "<reason>"\` lets it go.` : "") +
            `\n</done-gate-status>`,
        );
      }
    } catch {
      // status is a courtesy; the mandate still ships
    }
    ctx.out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n") } });
  },
};
