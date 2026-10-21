import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assess, unmetCount } from "./assess.mjs";
import { ensureSession, loadSession } from "./session-state.mjs";
import { recordGateError, UsageError } from "./context.mjs";
import { attachLedger, currentLedger, isDone, loadLedger, openRuns, runsDir, saveLedger } from "./ledger.mjs";
import { writeReport } from "./verbs.mjs";
import { checkRelease, UPDATE_COMMANDS } from "./release.mjs";
import { needsSetup } from "./setup.mjs";

const DAY_MS = 24 * 3600 * 1000;
const STALE_MS = 14 * DAY_MS;

// Session folders grow without end: once a day, those whose events and state are both untouched
// for 14 days go, except this session, no-session, and any session an open run, or a run changed
// in that time, lists (its rules and report read their events).
function pruneSessions(ctx) {
  const dir = path.join(ctx.stateDir, "sessions");
  const marker = path.join(ctx.stateDir, "last-prune");
  const mtime = (f) => statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (!existsSync(dir) || Date.now() - mtime(marker) < DAY_MS) return;
  writeFileSync(marker, new Date().toISOString());
  const keep = new Set([ctx.session, "no-session"]);
  const runs = runsDir(ctx.stateDir);
  for (const run of existsSync(runs) ? readdirSync(runs) : []) {
    const file = path.join(runs, run, "ledger.json");
    try {
      const ledger = loadLedger(path.join(runs, run));
      if (isDone(ledger) && Date.now() - mtime(file) >= STALE_MS) continue;
      for (const s of ledger.sessions ?? []) keep.add(s);
    } catch {
      // an unreadable ledger keeps nothing
    }
  }
  for (const name of readdirSync(dir)) {
    const folder = path.join(dir, name);
    if (keep.has(name) || Date.now() - Math.max(mtime(path.join(folder, "events.jsonl")), mtime(path.join(folder, "state.json")), mtime(folder)) < STALE_MS) continue;
    rmSync(folder, { recursive: true, force: true });
  }
}

function mandate(ctx) {
  return readFileSync(path.join(ctx.pluginRoot, "hooks", "session-start.md"), "utf8");
}

export const verbs = {
  async "session-start"(ctx) {
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
    try {
      pruneSessions(ctx);
    } catch (error) {
      recordGateError(error, "session-start");
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
            `${unmetCount(unmet)} unmet gate item(s). Run \`gate check\` before continuing.` +
            (inherited ? ` This ledger was opened by another session on ${String(state.ledger.openedAt).slice(0, 10)}; if that work is over, \`gate abandon ${state.ledger.slug} "<reason>"\` lets it go.` : "") +
            `\n</done-gate-status>`,
        );
      }
    } catch {
      // status is a courtesy; the mandate still ships
    }
    // a git checkout outside Claude Code's plugin folders is a working copy loaded in place: every
    // edit there reaches this session at once, which once fed half-done changes to long runs
    const root = ctx.pluginRoot.split(path.sep).join("/");
    if (existsSync(path.join(ctx.pluginRoot, ".git")) && !root.includes("/.claude/plugins/")) {
      parts.push(`\n<done-gate-status>\ndone-gate runs in place from ${ctx.pluginRoot}, a git working folder: every edit there reaches this session at once, half-done ones included. That is right for testing the plugin (claude --plugin-dir); for real work install it from a release (claude plugin marketplace add <owner>/<repo>, then claude plugin install done-gate@done-gate).\n</done-gate-status>`);
    }
    // a repo with tests but no testFiles is asked once, before a run opens: gate.json changed
    // mid-run trips R13
    try {
      const running = Boolean(currentLedger(ctx.stateDir, ctx.session)) || foreign !== null || openRuns(ctx.stateDir).some((r) => r.ledger.status !== "closed");
      if (!running && needsSetup(ctx.root)) {
        parts.push("\n<done-gate-setup>\nThis repo is not set up for the faster test loop (.claude/gate.json has no testFiles): verify runs whole test commands on every call. Before the first task, run `gate setup`, check its proposal against how this repo runs tests, and show it to the user. On their yes, `gate setup --apply [edited.json] --user-ok \"<their words>\"`; on a no, `gate setup --decline --user-ok \"<their words>\"` so it is not asked again. Do it before `gate open`: changing gate.json mid-run trips R13.\n</done-gate-setup>");
      }
    } catch (error) {
      // a gate.json that is not valid JSON is the repo's to fix, not a gate failure
      if (!(error instanceof UsageError)) recordGateError(error, "session-start");
    }
    const latest = await checkRelease(ctx.version);
    if (latest) {
      parts.push(`\n<done-gate-status>\ndone-gate ${latest} is out; this session runs ${ctx.version}. Before any task, tell the user and ask: update now (${UPDATE_COMMANDS}), or carry on with ${ctx.version}. \`gate open\` waits for one or the other: an update, or \`--old-version-ok "<their words>"\`.\n</done-gate-status>`);
    }
    ctx.out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n") } });
  },
};
