import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assess } from "./assess.mjs";
import { ensureSession, loadSession } from "./session-state.mjs";
import { recordGateError } from "./context.mjs";
import { attachLedger, currentLedger, openRuns, saveLedger } from "./ledger.mjs";
import { writeReport } from "./verbs.mjs";

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
    // A run a plugin before 0.10 left "closing" (its lead ran `gate close`, and no stop came
    // before the next task opened) is closed late here, never joined as if it were open.
    // A /clear, resume or compaction must not orphan a task: join the newest open run. A
    // new session is another task until it says otherwise: it is told the run is there.
    const continuing = ["clear", "resume", "compact"].includes(ctx.input?.session_start_source);
    let foreign = null;
    try {
      const runs = openRuns(ctx.stateDir);
      for (const { dir, ledger } of runs.filter((r) => r.ledger.status === "closing")) {
        Object.assign(ledger, { status: "closed", closedAt: new Date().toISOString(), closedLate: true, changedAtClose: ledger.changedAtClose ?? [] });
        saveLedger(dir, ledger);
        writeReport(ctx, dir, ledger);
      }
      if (!loadSession(ctx.stateDir, ctx.session)?.current) {
        const [newest] = runs.filter((r) => r.ledger.status !== "closed");
        if (newest && continuing) attachLedger(ctx, newest.ledger.slug);
        else if (newest) foreign = newest.ledger;
      }
      // a cleared, resumed or compacted context no longer holds the step texts it was shown
      const current = continuing ? currentLedger(ctx.stateDir, ctx.session) : null;
      if (current?.ledger.hinted?.[ctx.session]) {
        delete current.ledger.hinted[ctx.session];
        saveLedger(current.dir, current.ledger);
      }
    } catch {
      // attach is a courtesy; the Stop gate will still say R1 if it matters
    }
    if (foreign) {
      parts.push(`\n<done-gate-status>\nOpen run ${foreign.slug} (${foreign.playbook}) was left by another session on ${String(foreign.openedAt).slice(0, 10)} and is not joined. To continue it: \`gate attach ${foreign.slug}\`; if that work is over: \`gate abandon ${foreign.slug} "<reason>"\`. A new task opens its own run.\n</done-gate-status>`);
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
