import { existsSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./context.mjs";
import { readEvents } from "./events.mjs";
import { currentLedger, isDone, loadLedger, saveLedger } from "./ledger.mjs";
import { toPosixRel } from "./paths.mjs";
import { briefOf, fileRole, HELPER_MAX_MS, helperAlive, helpersOut, unfinishedFile, workerRuns } from "./rules.mjs";

// What a cut helper's notice means and what the lead does next. Outages, a cause only the user
// can fix and a stop someone chose are nobody's failure: they never move the ladder.
const NOT_COUNTED = new Set(["lost-connection", "api-problem", "session-limit", "only-you", "stopped-by-user"]);
const SAYS = {
  "turn-limit": "stopped at its turn limit",
  "lost-connection": "lost its connection to the API",
  "api-problem": "hit a passing API problem (overloaded, rate limit or server error)",
  "session-limit": "hit the session limit",
  stalled: "stalled with no progress",
  "only-you": "failed on something only the user can fix (login, billing or API key)",
  "stopped-by-user": "was stopped by the user",
  finished: "finished with its file unfinished",
  "no-file": "stopped with its file unfinished",
  gone: "has been silent for 45 minutes with no notice",
  unknown: "failed with wording the gate does not know",
};
const HELPER_FILE = /^(?:skeptic|review|review2|arbiter)-\d+\.md$/;

const summaryOf = (e) => (/<summary>([\s\S]*?)<\/summary>/.exec(e.text ?? "")?.[1] ?? "").replace(/^Agent ".*?" /s, "").trim();

// The file a helper works on: the one it wrote in the run dir, else the one brief of its role
// dated before its first start that no other helper wrote. A worker goes by the packet it read,
// so a fresh worker on the same piece takes over its record; QA, a worker that read none, or a
// helper two such briefs could be for, is counted under its own id.
function keyOf(agent, writes, claimed, records, bound) {
  if (agent.role === "worker") return bound.get(agent.id) != null ? `worker-${bound.get(agent.id)}.md` : agent.id;
  if (agent.role === "qa") return agent.id;
  if (writes.get(agent.id)) return writes.get(agent.id);
  const fits = Object.entries(records).filter(([f, r]) => fileRole(f) === agent.role && !claimed.has(f) && [...(r.earlier ?? []), r.seq].some((s) => s < agent.first));
  return fits.length === 1 ? fits[0][0] : agent.id;
}

function stepFor(cause, count) {
  if (cause === "session-limit") return "pause";
  if (cause === "only-you" || cause === "unknown") return "tell";
  if (cause === "stopped-by-user") return "ask-first";
  if (cause === "lost-connection" || cause === "api-problem") return "resume";
  if (count >= 4) return "ask";
  return count === 3 || cause === "gone" ? "fresh" : "resume";
}

function nextText(step, p, record, dir) {
  const again = Array.isArray(record?.files) ? ` --files ${record.files.join(",")}` : "";
  const holds = p.file && existsSync(path.join(dir, p.file)) ? `; ${p.file} holds what it wrote so far` : "";
  return {
    resume: `SendMessage ${p.agent} to continue${holds}`,
    fresh: `\`gate brief ${p.role}${again}\` and spawn a fresh one${p.file ? `, its packet continues from ${p.file}` : ""}`,
    ask: `ask the user what to do, with no option marked Recommended: it has failed ${p.attempts} times`,
    pause: `tell the user and pause until the session limit resets (the notice says when), then SendMessage ${p.agent} to resume`,
    tell: `tell the user what the notice says${p.cause === "unknown" ? " and ask" : ""}; do not retry`,
    "ask-first": "ask the user before starting it again",
  }[step];
}

// Every done-gate helper of the run that is cut off and not handled, one per file (or per id),
// with its cause, how often that file's helpers failed, and the next step.
export function helperProblems({ events, ledger, dir, root, now = Date.now() }) {
  const runRel = `${toPosixRel(root, dir)}/`;
  const agents = new Map();
  for (const e of events) {
    // an older run's arbiter has no brief to send it again
    if (e.kind !== "subagent-start" || e.seq <= (ledger.openedSeq ?? 0) || !String(e.agentType ?? "").startsWith("done-gate:") || e.agentType === "done-gate:arbiter") continue;
    if (!agents.has(e.agent)) agents.set(e.agent, { id: e.agent, role: e.agentType.slice("done-gate:".length), first: e.seq });
  }
  const writes = new Map();
  for (const e of events) {
    const name = e.kind === "edit" && agents.has(e.agent) && String(e.path ?? "").startsWith(runRel) ? e.path.slice(runRel.length) : null;
    if (name && HELPER_FILE.test(name) && fileRole(name) === agents.get(e.agent).role && !writes.has(e.agent)) writes.set(e.agent, name);
  }
  const claimed = new Set(writes.values());
  const records = { ...(ledger.briefed ?? {}), ...(ledger.seen ?? {}) };
  const bound = new Map(workerRuns({ ledger, events }).map((r) => [r.agent, r.n]));
  const groups = new Map();
  for (const a of agents.values()) {
    const key = keyOf(a, writes, claimed, records, bound);
    groups.set(key, [...(groups.get(key) ?? []), a.id]);
  }

  const problems = [];
  for (const [key, ids] of groups) {
    const own = events.filter((e) => ids.includes(e.agent) || ids.includes(e.notice?.agent));
    const newest = own.reduce((a, b) => (b.seq > a.seq ? b : a));
    const agent = newest.notice?.agent ?? newest.agent;
    const role = agents.get(agent).role;
    const file = HELPER_FILE.test(key) ? key : null;
    if (helperAlive(events, agent, now)) continue;
    if (file && existsSync(path.join(dir, file)) && !unfinishedFile(path.join(dir, file))) continue;
    const decides = own.filter((e) => e.notice?.agent === agent || (e.agent === agent && (e.kind === "subagent-start" || e.kind === "subagent-stop"))).reduce((a, b) => (b.seq > a.seq ? b : a));
    let cause = decides.notice?.cause ?? (decides.kind === "subagent-stop" ? "no-file" : "gone");
    if (cause === "waiting") cause = "gone";
    if (cause === "stopped-by-lead" || (!file && (cause === "finished" || cause === "no-file"))) continue;
    if ((ledger.handled?.[agent] ?? -1) >= decides.seq) continue;

    let attempts = 0;
    let lastFail = Math.min(...ids.map((id) => agents.get(id).first));
    for (const n of own.filter((e) => e.notice && e.notice.cause !== "waiting" && e.notice.cause !== "stopped-by-lead")) {
      const c = n.notice.cause;
      // a turn limit after new edits is progress, not a failure
      if (!NOT_COUNTED.has(c) && (c !== "turn-limit" || !own.some((e) => e.kind === "edit" && e.seq > lastFail && e.seq < n.seq))) attempts += 1;
      lastFail = n.seq;
    }
    if (cause === "no-file" || cause === "gone") attempts += 1;

    // a worker's record is its packet's brief, which names the piece it re-briefs
    const record = file ? briefOf(ledger, file) : role === "worker" && key !== agent ? ledger.briefed?.[key] ?? null : null;
    const piece = role === "worker" && Array.isArray(record?.files) ? record.files : null;
    const p = { agent, role, key, file, piece, n: piece ? Number(/\d+/.exec(key)[0]) : null, cause, attempts, seq: decides.seq };
    p.step = stepFor(cause, attempts);
    const raw = cause === "unknown" ? `: "${summaryOf(decides)}"` : "";
    const count = attempts > 1 ? ` (failure ${attempts} on this ${file ? "file" : piece ? "piece" : "helper"})` : "";
    p.line = `${role} ${agent}${file ? ` on ${file}` : piece ? ` on ${piece.join(", ")}` : ""} ${SAYS[cause]}${raw}${count}: ${nextText(p.step, p, record, dir)}`;
    problems.push(p);
  }
  return problems.sort((a, b) => a.seq - b.seq);
}

// The workers of a pieces run cut off and not handled: a fresh worker that read the same packet
// and is out, or stopped, takes the piece over.
export const cutWorkers = (state) => helperProblems({ events: state.events ?? [], ledger: state.ledger, dir: state.dir, root: state.root }).filter((p) => p.role === "worker");

// Why a cut worker holds the next step, for the lead to act on.
export const cutText = (p) => (p.piece ? `worker ${p.n} on ${p.piece.join(",")} was cut off` : `worker ${p.agent} was cut off before it read its packet`) + `: \`gate diagnose\` says what next (brief it again and spawn a fresh one), or \`gate diagnose --handled ${p.agent}\``;

function runEvents(ctx, ledger) {
  const sessions = [...new Set([...(ledger.sessions ?? []), ctx.session].filter(Boolean))];
  return sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
}

function openRun(ctx) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  return current && !isDone(current.ledger) ? current : null;
}

const problemsOf = (ctx, { dir, ledger }) => helperProblems({ events: runEvents(ctx, ledger), ledger, dir, root: ctx.root });

// The line a helper's notice brings the lead, or null when it needs nothing.
export function noticeLine(ctx, agent) {
  const current = openRun(ctx);
  const p = current ? problemsOf(ctx, current).find((x) => x.agent === agent) : null;
  return p ? `done-gate: ${p.line}` : null;
}

// What ended the lead's turn, by the error type Claude Code names. The session-limit wording
// and the refusal types are not seen in a real log yet, so unknown wording is shown as it came.
const PASSING = new Set(["rate_limit", "overloaded", "server_error"]);
const ONLY_USER = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "cloud_credential_error", "model_not_found"]);

function failedTurnText(e) {
  const said = [e.details, e.text].filter(Boolean).join(" · ");
  if (e.error === "rate_limit" && /session limit/i.test(said)) return `it hit the session limit (${said}): tell the user, wait for the reset, then carry on`;
  if (PASSING.has(e.error)) return `a passing API problem (${e.error}): carry on from where it stopped`;
  if (ONLY_USER.has(e.error)) return `something only the user can fix (${e.error}: ${said}): tell the user; do not retry`;
  if (e.error === "max_output_tokens") return "the reply ran past the output limit: carry on in smaller steps";
  return `${e.error}, "${said}", which the gate does not know: tell the user what it says and ask the user before going on`;
}

// Told once, on the user's own first message after the failed turn; a hand-back does not use it up.
export function failedTurnLine(ctx) {
  const current = openRun(ctx);
  if (!current) return null;
  const mine = readEvents(ctx.stateDir, ctx.session);
  const failed = mine.filter((e) => e.kind === "turn-failed").pop();
  if (!failed || mine.filter((e) => e.kind === "prompt" && !e.handback && e.seq > failed.seq).length !== 1) return null;
  const out = helpersOut(mine, ctx.session, current.ledger.openedSeq ?? 0);
  const cut = problemsOf(ctx, current).filter((p) => !out.some((o) => o.agent === p.agent));
  const still = out.length ? ` Still out: ${out.map((e) => `${e.agentType} (${e.agent})`).join(", ")}.` : "";
  const lost = cut.length ? ` \`gate diagnose\` lists ${cut.length === 1 ? "1 helper" : `${cut.length} helpers`} it cut off.` : "";
  return `done-gate: your last turn ended on an error before it finished: ${failedTurnText(failed)}.${still}${lost}`;
}

const ago = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${Math.floor(h / 24)} days`;
};
// the lead acting again after a failed turn; a helper's records and the Stop hook's do not count
const LEAD_ACTS = new Set(["prompt", "command", "edit", "tool", "skill", "agent", "answer", "browser"]);

// Why a run nobody is on stopped, read from the sessions it names (never the one asking): its
// last activity, its steps, the helpers it cut off, and the failed turn nothing followed.
export function leftBehind(ctx, { dir, ledger }, now = Date.now()) {
  const events = (ledger.sessions ?? []).flatMap((s) => readEvents(ctx.stateDir, s)).filter((e) => e.seq > (ledger.openedSeq ?? 0)).sort((a, b) => a.seq - b.seq);
  const steps = ledger.steps ?? [];
  const done = steps.filter((s) => s.state).length;
  const next = steps.find((s) => !s.state)?.key ?? null;
  const last = events.at(-1);
  const quiet = last ? now - Date.parse(last.ts) : null;
  const failed = events.filter((e) => e.kind === "turn-failed").pop();
  const carried = failed && events.some((e) => e.seq > failed.seq && e.session === failed.session && e.agent == null && LEAD_ACTS.has(e.kind));
  let why = "it stopped with no failure on record";
  if (!last) why = "no event records are left for it (pruned, or its session ran in another repo): ask the user what became of it";
  else if (quiet < HELPER_MAX_MS) why = `it was active ${ago(quiet)} ago: ask the user first, another terminal may still be on it`;
  else if (failed && !carried) why = `its last turn ended on an error and nothing came after: ${failedTurnText(failed)}`;
  const helpers = last ? helperProblems({ events, ledger, dir, root: ctx.root, now }) : [];
  const when = last ? `last active ${ago(quiet)} ago` : "no activity on record";
  const stepText = `${done} of ${steps.length} steps done${next ? `, next {${next}}` : ""}`;
  const cut = helpers.length ? `; ${helpers.length === 1 ? "1 helper" : `${helpers.length} helpers`} never reported` : "";
  return {
    slug: ledger.slug, done, total: steps.length, next, why, helpers,
    summary: `${when}, ${stepText}; ${why}${cut}`,
    story: [`run ${ledger.slug}: ${when}${last ? ` (${last.ts})` : ""}`, `steps: ${done} of ${steps.length} done${next ? `; next {${next}}` : ""}`, `why it stopped: ${why}`, ...helpers.map((p) => `helper: ${p.line}`)],
  };
}

const envMs = (name, fallback, { zero = true } = {}) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) && (zero ? v >= 0 : v > 0) ? v : fallback;
};

const HELPER_IDLE_MS = 10 * 60 * 1000;
// This session's helpers out now that have done nothing for idleMs, counted from `from` at the
// earliest: no event of their own, no notice. One inside a Bash call, or waiting on its own
// background work, is busy.
function idleHelpers(events, out, session, now, { from = 0, idleMs = HELPER_IDLE_MS } = {}) {
  return out.filter((start) => start.session === session).flatMap((start) => {
    const own = events.filter((e) => e.agent === start.agent || e.notice?.agent === start.agent);
    const ended = new Set(own.filter((e) => e.kind === "command" && e.toolUseId).map((e) => e.toolUseId));
    if (own.some((e) => e.kind === "command-start" && e.toolUseId && !ended.has(e.toolUseId))) return [];
    if (own.filter((e) => e.notice).at(-1)?.notice.cause === "waiting") return [];
    const last = Math.max(...own.map((e) => Date.parse(e.ts) || 0));
    return now - Math.max(from, last) >= idleMs ? [{ agent: start.agent, agentType: start.agentType, idle: now - last }] : [];
  });
}
const idleLine = (h) => `done-gate: ${h.agentType.replace(/^done-gate:/, "")} ${h.agent} has done nothing for ${ago(h.idle)}: SendMessage it to ask where it stands, or run \`gate diagnose\`. Advice only; the gate stops waiting for it at 45 minutes.`;

// The idle lines for a prompt that reaches the lead, or null.
export function idleLines(ctx) {
  const current = openRun(ctx);
  if (!current) return null;
  const events = runEvents(ctx, current.ledger);
  const now = Date.now();
  const idle = idleHelpers(events, outNow(events, current.ledger, now), ctx.session, now);
  return idle.length ? idle.map(idleLine).join("\n") : null;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The done-gate helpers of the run still out now, one start each.
function outNow(events, ledger, now) {
  const starts = new Map();
  for (const e of events) {
    if (e.kind === "subagent-start" && e.seq > (ledger.openedSeq ?? 0) && String(e.agentType ?? "").startsWith("done-gate:")) starts.set(e.agent, e);
  }
  return [...starts.values()].filter((e) => helperAlive(events, e.agent, now));
}

export const verbs = {
  // Waits, reading only, until no helper of the run is out, then prints what became of each one
  // it saw. A notice already wakes the lead; this is for helpers that end without one. Run in
  // the background, its exit is what wakes the lead.
  async watch(ctx) {
    const current = openRun(ctx);
    if (!current) throw new UsageError("no open run for this session: gate watch waits on the open run's helpers");
    const poll = envMs("DONE_GATE_WATCH_POLL_MS", 5000);
    const grace = envMs("DONE_GATE_WATCH_GRACE_MS", 30 * 1000);
    const quiet = envMs("DONE_GATE_WATCH_QUIET_MS", 20 * 60 * 1000);
    const idleMs = envMs("DONE_GATE_WATCH_IDLE_MS", HELPER_IDLE_MS, { zero: false });
    const started = Date.now();
    const seen = new Map();
    let emptyPolls = 0;
    for (;;) {
      const ledger = loadLedger(current.dir);
      const events = runEvents(ctx, ledger);
      const now = Date.now();
      const out = outNow(events, ledger, now);
      for (const e of out) seen.set(e.agent, e.agentType);
      emptyPolls = out.length ? 0 : emptyPolls + 1;
      const newest = events.length ? Date.parse(events.at(-1).ts) : 0;
      const idle = idleHelpers(events, out, ctx.session, now, { from: started, idleMs });
      if (idle.length) {
        for (const h of idle) ctx.out(idleLine(h));
        return;
      }
      // the backstop when every helper out waits on its own background work
      if (out.length && now - Math.max(started, newest) >= quiet) {
        ctx.out(`quiet: no new event for ${ago(quiet)} with ${out.map((e) => `${e.agentType} (${e.agent})`).join(", ")} still out: run \`gate watch\` again to keep waiting; this is not a failure`);
        return;
      }
      // a helper waiting on its own background work stops, then says so seconds later: a second
      // empty poll confirms none came back
      if (!out.length && (seen.size ? emptyPolls >= 2 : now - started >= grace)) {
        const problems = helperProblems({ events, ledger, dir: current.dir, root: ctx.root, now });
        for (const [id, type] of seen) ctx.out(problems.find((p) => p.agent === id)?.line ?? `${type.slice("done-gate:".length)} ${id} finished`);
        if (!seen.size) ctx.out("no helper is out");
        const older = problems.filter((p) => !seen.has(p.agent)).length;
        if (older) ctx.out(`\`gate diagnose\` lists ${older === 1 ? "1 helper" : `${older} helpers`} cut off before this watch`);
        if (seen.size) ctx.out("If their hand-backs already reached you, nothing more is owed; otherwise act on the lines above.");
        return;
      }
      await pause(poll);
    }
  },

  diagnose(ctx) {
    const current = openRun(ctx);
    if (!current) throw new UsageError("no open run for this session: gate diagnose reads the open run's helpers");
    const problems = problemsOf(ctx, current);
    const at = ctx.args.indexOf("--handled");
    if (at < 0) {
      for (const p of problems) ctx.out(p.line);
      if (!problems.length) ctx.out("no helper problems");
      return;
    }
    const id = ctx.args[at + 1];
    const p = problems.find((x) => x.agent === id);
    if (!p) throw new UsageError(`gate diagnose --handled: no helper problem for ${id ?? "<agent id>"} (open: ${problems.map((x) => x.agent).join(", ") || "none"})`);
    current.ledger.handled = { ...(current.ledger.handled ?? {}), [id]: p.seq };
    saveLedger(current.dir, current.ledger);
    ctx.out(`${id} handled: gate diagnose hides it until a newer notice`);
  },
};
