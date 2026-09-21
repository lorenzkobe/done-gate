import path from "node:path";
import { assess, LedgerParseError } from "./assess.mjs";
import { recordGateError } from "./context.mjs";
import { appendEvents, nextSeq } from "./events.mjs";
import { loadLedger, saveLedger } from "./ledger.mjs";
import { loadSession, saveSession } from "./session-state.mjs";

export const OVERRIDE_AFTER = 6;
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
const HELPER_MAX_MS = 45 * 60 * 1000;
function helperRunning(events, session, now = Date.now()) {
  const mine = events.filter((e) => e.session === session);
  const lastPrompt = mine.filter((e) => e.kind === "prompt" && !e.handback).pop()?.seq ?? 0;
  const starts = mine.filter((e) => e.kind === "subagent-start" && e.seq > lastPrompt);
  return starts.some((st) => now - Date.parse(st.ts ?? 0) < HELPER_MAX_MS && !mine.some((e) => e.kind === "subagent-stop" && e.agent === st.agent && e.seq > st.seq));
}

// The ledger closes only when the gate agrees it is clean; the session's baseline
// moves to the current tree so the next task starts from zero changes.
function finalise(ctx, state) {
  const ledger = loadLedger(state.dir);
  ledger.status = "closed";
  ledger.closedAt = new Date().toISOString();
  ledger.closedTreeHash = state.now.hash;
  ledger.changedAtClose = state.changed;
  if (state.tier) ledger.tier = state.tier;
  saveLedger(state.dir, ledger);
  const session = loadSession(ctx.stateDir, ctx.session);
  saveSession(ctx.stateDir, { ...session, current: null, lastClosed: path.basename(state.dir), baseline: { files: state.now.files, hash: state.now.hash }, baselineSeq: nextSeq() });
}

function renderReason(unmet, { ledgerOpen }) {
  const lines = [`done-gate: the turn cannot end yet — ${unmet.length} unmet:`];
  unmet.forEach((u, i) => lines.push(`${i + 1}. ${u.rule} — ${u.text}`));
  if (ledgerOpen) {
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

    if (ledgerOpen) {
      const pause = PAUSE_RE.exec(lastMessage);
      if (pause) {
        const ledger = loadLedger(state.dir);
        ledger.pauses.push({ seq: nextSeq(), ts: new Date().toISOString(), session: ctx.session, text: pause[1] });
        saveLedger(state.dir, ledger);
        clearBlocks(ctx);
        return;
      }
    }

    if (unmet.length === 0) {
      clearBlocks(ctx);
      if (state.ledger?.status === "closing") finalise(ctx, state);
      return;
    }

    const key = unmet.map((u) => `${u.rule}:${u.text}`).join("\n");
    const count = bumpBlocks(ctx, key);
    if (count >= OVERRIDE_AFTER) {
      if (state.dir) {
        const ledger = loadLedger(state.dir);
        ledger.overridden = { at: new Date().toISOString(), session: ctx.session, blocks: count, unmet };
        saveLedger(state.dir, ledger);
      }
      recordGateError(new Error(`GATE OVERRIDDEN after ${count} identical blocks: ${unmet.map((u) => u.rule).join(", ")}`), "stop");
      clearBlocks(ctx);
      return;
    }
    block(ctx, renderReason(unmet, { ledgerOpen }), unmet.map((u) => u.rule));
  },
};
