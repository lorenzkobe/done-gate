import { assess, LedgerParseError, unmetLines } from "./assess.mjs";
import { recordGateError } from "./context.mjs";
import { appendEvents, nextSeq } from "./events.mjs";
import { loadLedger, saveLedger } from "./ledger.mjs";
import { loadSession, saveSession } from "./session-state.mjs";
import { HELPER_MAX_MS, unfinishedVerify } from "./rules.mjs";

// Stuck: from ASK_AFTER identical blocks the lead must ask the user; BRAKE_AFTER stops a gate-bug loop.
export const ASK_AFTER = 3;
export const BRAKE_AFTER = 20;
const PAUSE_RE = /(?:^|\n)\s*PAUSED:\s*(.+?)\s*$/;

// Every block is logged, so a turn that could not end can be diagnosed from the session's events.
function block(ctx, reason, rules = []) {
  appendEvents(ctx.stateDir, ctx.session, [{ seq: nextSeq(), ts: new Date().toISOString(), session: ctx.session, agent: null, agentType: null, kind: "block", rules }]);
  ctx.out({ decision: "block", reason, systemMessage: "done-gate blocked the stop; see reason." });
}

function bumpBlocks(ctx, key) {
  const session = loadSession(ctx.stateDir, ctx.session);
  const count = session.blocks?.key === key ? session.blocks.count + 1 : 1;
  saveSession(ctx.stateDir, { ...session, blocks: { key, count } });
  return count;
}

function clearBlocks(ctx) {
  const session = loadSession(ctx.stateDir, ctx.session);
  if (session?.blocks?.count) saveSession(ctx.stateDir, { ...session, blocks: { key: null, count: 0 } });
}

// An agent this session started since the user's last prompt and that has not stopped: a
// done-gate helper or any other agent the lead spawned. A helper's hand-back arrives as a
// prompt too (events.mjs tags it), and does not count as a new turn. Bounded: a start older
// than HELPER_MAX_MS is treated as gone, so a crashed or hung agent cannot let the turn end
// quietly forever.
function helperRunning(events, session, now = Date.now()) {
  const mine = events.filter((e) => e.session === session);
  const lastPrompt = mine.filter((e) => e.kind === "prompt" && !e.handback).pop()?.seq ?? 0;
  const starts = mine.filter((e) => e.kind === "subagent-start" && e.seq > lastPrompt);
  return starts.some((st) => now - Date.parse(st.ts ?? 0) < HELPER_MAX_MS && !mine.some((e) => e.kind === "subagent-stop" && e.agent === st.agent && e.seq > st.seq));
}

function renderReason(unmet, { ledgerOpen, repeat = false, stuck = 0 }) {
  // the full text went out with the last block; a repeat names each item and points at it
  const items = unmetLines(unmet, { cut: repeat ? 120 : 0 });
  const head = stuck
    ? `done-gate: stuck — the same ${items.length} unmet ${stuck} times in a row. Stop working on them and ask the user: end your message with a final line \`PAUSED: <what you need from them>\`, or ask with AskUserQuestion. The gate does not let the turn end otherwise.`
    : repeat
      ? `done-gate: the turn cannot end yet — the same ${items.length} unmet as the last stop (\`gate check\` prints them in full):`
      : `done-gate: the turn cannot end yet — ${items.length} unmet:`;
  const lines = [head, ...items];
  if (ledgerOpen && !stuck) {
    lines.push("");
    lines.push("Need the user? Ask with AskUserQuestion, or end your message with a final line `PAUSED: <what you need>` and the turn will end.");
    lines.push("Run `gate check` at any time to see this list.");
  }
  return lines.join("\n");
}

export const verbs = {
  stop(ctx) {
    if (ctx.input?.agent_id) return; // inside a subagent: the gate governs the main session only
    if (!ctx.session) return;
    const lastMessage = String(ctx.input?.last_assistant_message ?? "");

    let result;
    try {
      result = assess(ctx, { lastMessage });
    } catch (error) {
      if (!(error instanceof LedgerParseError)) throw error;
      const key = `parse:${error.message}`;
      const count = bumpBlocks(ctx, key);
      if (count >= 2) {
        recordGateError(error, "stop");
        return; // GATE ERROR stamped via the log; fail open rather than wedge
      }
      block(ctx, `done-gate: our own state is unreadable — ${error.message}. Restore it from the last good version (do not hand-edit), then try again. A second failure falls open with a GATE ERROR stamp.`);
      return;
    }

    const { state, unmet } = result;
    const ledgerOpen = Boolean(state.ledger);

    // a helper this session spawned is still running: the turn ends so the helper's
    // hand-back can wake the lead; nothing is finalised
    if (ledgerOpen && helperRunning(state.events ?? [], ctx.session)) {
      clearBlocks(ctx);
      return;
    }
    // so does a gate verify this session started that still runs (in the background, its exit
    // wakes the lead); another session's verify, or one running past the helper limit, does not
    const started = state.verifyStarted;
    if (ledgerOpen && started?.session === ctx.session && unfinishedVerify(state)?.running && Date.now() - Date.parse(started.startedAt) < HELPER_MAX_MS) {
      clearBlocks(ctx);
      return;
    }

    // a pause hands the turn to the user, run or no run: the stuck reason asks for exactly this
    const pause = PAUSE_RE.exec(lastMessage);
    if (pause) {
      const entry = { seq: nextSeq(), ts: new Date().toISOString(), session: ctx.session, text: pause[1] };
      if (ledgerOpen) {
        const ledger = loadLedger(state.dir);
        ledger.pauses.push(entry);
        saveLedger(state.dir, ledger);
      } else appendEvents(ctx.stateDir, ctx.session, [{ ...entry, agent: null, agentType: null, kind: "pause" }]);
      clearBlocks(ctx);
      return;
    }

    if (unmet.length === 0) {
      clearBlocks(ctx);
      return;
    }

    const key = unmet.map((u) => `${u.rule}:${u.text}`).join("\n");
    const count = bumpBlocks(ctx, key);
    if (count >= BRAKE_AFTER) {
      if (state.dir) {
        const ledger = loadLedger(state.dir);
        ledger.overridden = { at: new Date().toISOString(), session: ctx.session, blocks: count, unmet };
        saveLedger(state.dir, ledger);
      }
      // the emergency brake is the gate working as designed, not a gate error: it goes to the event log
      appendEvents(ctx.stateDir, ctx.session, [{ seq: nextSeq(), ts: new Date().toISOString(), session: ctx.session, agent: null, agentType: null, kind: "override", blocks: count, rules: unmet.map((u) => u.rule) }]);
      clearBlocks(ctx);
      return;
    }
    block(ctx, renderReason(unmet, { ledgerOpen, repeat: count > 1, stuck: count >= ASK_AFTER ? count : 0 }), unmet.map((u) => u.rule));
  },
};
