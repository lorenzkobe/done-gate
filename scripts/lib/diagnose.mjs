import { existsSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./context.mjs";
import { readEvents } from "./events.mjs";
import { currentLedger, isDone, saveLedger } from "./ledger.mjs";
import { toPosixRel } from "./paths.mjs";
import { briefOf, fileRole, helperAlive, unfinishedFile } from "./rules.mjs";

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
// dated before its first start that no other helper wrote. A worker or QA, or a helper two
// such briefs could be for, is counted under its own id.
function keyOf(agent, writes, claimed, records) {
  if (agent.role === "worker" || agent.role === "qa") return agent.id;
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
  const again = p.role === "arbiter" && record?.item ? ` --item ${record.item}` : Array.isArray(record?.files) ? ` --files ${record.files.join(",")}` : "";
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
    if (e.kind !== "subagent-start" || e.seq <= (ledger.openedSeq ?? 0) || !String(e.agentType ?? "").startsWith("done-gate:")) continue;
    if (!agents.has(e.agent)) agents.set(e.agent, { id: e.agent, role: e.agentType.slice("done-gate:".length), first: e.seq });
  }
  const writes = new Map();
  for (const e of events) {
    const name = e.kind === "edit" && agents.has(e.agent) && String(e.path ?? "").startsWith(runRel) ? e.path.slice(runRel.length) : null;
    if (name && HELPER_FILE.test(name) && fileRole(name) === agents.get(e.agent).role && !writes.has(e.agent)) writes.set(e.agent, name);
  }
  const claimed = new Set(writes.values());
  const records = { ...(ledger.briefed ?? {}), ...(ledger.seen ?? {}) };
  const groups = new Map();
  for (const a of agents.values()) {
    const key = keyOf(a, writes, claimed, records);
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

    const p = { agent, role, key, file, cause, attempts, seq: decides.seq };
    p.step = stepFor(cause, attempts);
    const raw = cause === "unknown" ? `: "${summaryOf(decides)}"` : "";
    const count = attempts > 1 ? ` (failure ${attempts} on this ${file ? "file" : "helper"})` : "";
    p.line = `${role} ${agent}${file ? ` on ${file}` : ""} ${SAYS[cause]}${raw}${count}: ${nextText(p.step, p, file ? briefOf(ledger, file) : null, dir)}`;
    problems.push(p);
  }
  return problems.sort((a, b) => a.seq - b.seq);
}

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

export const verbs = {
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
