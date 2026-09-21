import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildState } from "./assess.mjs";
import { evaluate } from "./rules.mjs";
import { loadLedger, runsDir, section } from "./ledger.mjs";
import { loadSession } from "./session-state.mjs";
import { readVerify, reviewFiles } from "./assess.mjs";
import { readEvents } from "./events.mjs";
import { effectiveTier, loadPolicy, renderTierBlock, requires, tiered, tierOf } from "./size.mjs";
import { isRole, lastEditSeq, lateOrder } from "./rules.mjs";
import { UsageError } from "./context.mjs";

function tailLines(file, n) {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").trim().split("\n").slice(-n).join("\n");
}

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function ledgerMd(dir) {
  const file = path.join(dir, "ledger.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// ---- pieces of the full report (text unchanged; the brief reuses the same facts) ----

export function summaryLine(ledger, events, unmet) {
  const count = (s) => ledger.steps.filter((x) => x.state === s).length;
  const blank = ledger.steps.filter((x) => !x.state).length;
  const closedCases = ledger.cases.filter((c) => c.status === "closed").length;
  const naCases = ledger.cases.filter((c) => c.na).length;
  const denies = events.filter((e) => e.kind === "deny" && !e.delegate).length;
  return (
    `DONE ${count("DONE")} · SKIPPED ${count("SKIPPED")} · WAIVED ${count("WAIVED")} · N/A ${count("N/A")} · blank ${blank} · ` +
    `cases ${closedCases}/${ledger.cases.length} closed (${naCases} n/a) · ` +
    `tampering attempts ${denies} · gate: ${unmet.length ? `${unmet.length} unmet` : "clean"}`
  );
}

export function caseTable(ledger) {
  if (!ledger.cases.length) return ["_none_"];
  const out = ["| id | case | kind | test | status |\n| --- | --- | --- | --- | --- |"];
  for (const c of ledger.cases) out.push(`| ${c.id} | ${cell(c.case)} | ${c.kind} | ${cell(c.test ?? (c.na ? `n/a: ${c.na}` : ""))} | ${c.status} |`);
  return out;
}

export function verifyLines(verify, { tails = true } = {}) {
  if (!verify) return ["_not run_"];
  const out = [];
  for (const c of verify.commands) {
    if (c.skipped) {
      out.push(`- – \`${c.cmd}\` — skipped: ${c.skipped}`);
      continue;
    }
    out.push(`- ${c.exit === 0 && !c.timedOut ? "✓" : "✗"} \`${c.cmd}\` — ${c.timedOut ? "timed out" : `exit ${c.exit}`}, ${(c.ms / 1000).toFixed(1)}s`);
    if (tails && (c.exit !== 0 || c.timedOut)) out.push(`\n\`\`\`\n${c.tail.split("\n").slice(-12).join("\n")}\n\`\`\``);
  }
  return out;
}

export function actOnRows(ledger, dir, reviews, { embed = true } = {}) {
  if (!ledger.huddles.length) return ["_none_"];
  const out = [];
  for (const h of ledger.huddles) {
    out.push(`### ${h.id} ${h.role} round ${h.round}${h.file ? ` — ${h.file}` : ""}`);
    if (h.summary) out.push(h.summary);
    const packet = `brief-${h.role}-${h.round}.md`;
    if (existsSync(path.join(dir, packet))) out.push(`packet: ${packet}`);
    for (const a of h.actOn) {
      const state = a.closed ? `closed [${a.closed}]` : a.dispute ? `**OPEN** — disagreed: ${cell(a.dispute.why)} [${a.dispute.evidence}] — ${a.dispute.verdict ?? "unanswered"}` : "**OPEN**";
      out.push(`- ${a.id} ${cell(a.text)} — ${state}`);
    }
    if (embed && h.file && reviews.includes(h.file)) out.push(`\n<details><summary>${h.file}</summary>\n\n${readFileSync(path.join(dir, h.file), "utf8").trim()}\n\n</details>`);
  }
  return out;
}

export function attentionLines(state, unmet) {
  const { ledger, events } = state;
  const denies = events.filter((e) => e.kind === "deny" && !e.delegate).length;
  const handoffs = events.filter((e) => e.kind === "deny" && e.delegate).length;
  const out = [];
  for (const w of ledger.waivers) out.push(`- waived ${w.key}: ${w.reason ?? w.quote}`);
  for (const s of ledger.steps.filter((x) => x.state === "SKIPPED")) out.push(`- skipped: ${s.text} — ${s.note}`);
  for (const a of ledger.huddles.flatMap((h) => h.actOn).filter((x) => x.dispute)) out.push(`- disputed ${a.id}: ${a.dispute.why} [${a.dispute.evidence}] — ${a.dispute.verdict ?? "unanswered"}${a.dispute.reviewerReason ? `; reviewer: ${a.dispute.reviewerReason}` : ""}${a.dispute.arbiterReason ? `; arbiter: ${a.dispute.arbiterReason}` : ""}`);
  if (denies) out.push(`- ${denies} denied write(s) to gate evidence files (see events)`);
  if (handoffs) out.push(`- ${handoffs} lead edit(s) fenced off at this size and handed to a worker`);
  const blocks = events.filter((e) => e.kind === "block" && e.seq > (ledger.openedSeq ?? 0)).length;
  if (blocks) out.push(`- the gate blocked the turn ${blocks} time${blocks === 1 ? "" : "s"} (see the block events for the rules each time)`);
  if (ledger.status === "abandoned") out.push(`- abandoned: ${ledger.abandonReason}`);
  if (ledger.overridden) out.push("- the gate was OVERRIDDEN; treat every claim above as unverified");
  const order = lateOrder(state);
  if (order.late.length) out.push(`- ${order.late.join(" and ")} written after the first source edit (${order.path})`);
  for (const u of unmet) out.push(`- unmet ${u.rule}: ${u.text}`);
  return out;
}

// Whether the policy wants a second review round: the first reviewer round returned enough
// Act-on items, or the task is large.
function round2Required(state) {
  const esc = state.policy?.escalate?.reviewerRound2;
  if (!esc) return false;
  const first = state.ledger.huddles.find((h) => h.role === "reviewer");
  const eff = effectiveTier(state.policy, state.ledger, state.tier?.measured ?? null);
  return Boolean(first && first.actOn.length >= (esc.whenActOnAtLeast ?? 2)) || eff === esc.orTier;
}

export function tierBlock(state) {
  const { ledger, policy, events } = state;
  if (!policy || !tiered(ledger)) return [];
  const measured = state.tier?.measured ?? tierOf(ledger).measured;
  const out = renderTierBlock(ledger, policy, measured);
  const eff = effectiveTier(policy, ledger, measured);
  // the second review round is satisfied by the reviewer stopping a second time (the same
  // agent resumed with a fresh packet) or by a reviewer-2 stop, so both ways of running it count
  const required = requires(policy, eff);
  // only this task's events: the session log spans every task the session worked on
  const opened = ledger.openedSeq ?? ledger.baseline?.seq ?? 0;
  const stops = events.filter((e) => e.kind === "subagent-stop" && e.seq > opened);
  const secondRound = () => stops.filter((e) => isRole(e.agentType, "reviewer"))[1] ?? stops.find((e) => isRole(e.agentType, "reviewer-2")) ?? null;
  const ran = (role) => stops.some((e) => isRole(e.agentType, role));
  const done = required.filter(ran);
  out.push(`helpers: spawned ${done.length} of ${required.length} required (${required.map((r) => `${r}${ran(r) ? " ✓" : ""}`).join(", ")})`);
  out.push(round2Required(state) ? `round 2: required, ${secondRound() ? "recorded" : "not yet"}` : "round 2: not required");
  return out;
}

export function renderReport(state, unmet) {
  const { ledger, dir, config, changed, verify, events, reviews } = state;
  const md = ledgerMd(dir);
  const out = [];

  out.push(`# ${ledger.slug} — ${ledger.playbook} — ${ledger.status}`);
  if (ledger.status === "abandoned") out.push(`\n**ABANDONED** at ${ledger.abandonedAt}: ${ledger.abandonReason}`);
  if (ledger.overridden) out.push(`\n**GATE OVERRIDDEN** at ${ledger.overridden.at} after ${ledger.overridden.blocks} identical blocks: ${ledger.overridden.unmet.map((u) => u.rule).join(", ")}`);
  const errLog = path.join(state.stateDir ?? path.resolve(dir, "..", ".."), "gate-error.log");
  const gateErrors = tailLines(errLog, 3);
  if (gateErrors) out.push(`\n**GATE ERROR** (last lines of gate-error.log):\n\`\`\`\n${gateErrors}\n\`\`\``);

  out.push(`\n${summaryLine(ledger, events, unmet)}`);

  out.push(`\n## Task\n\n${section(md, "Task") || "_not written_"}`);
  out.push(`\n## Plan\n\n${section(md, "Plan") || "_not written_"}`);

  out.push("\n## Case table\n");
  out.push(...caseTable(ledger));

  out.push("\n## Steps\n");
  for (const s of ledger.steps) {
    const st = s.state ?? "BLANK";
    out.push(`${s.n}. ${s.text} — **${st}**${s.note ? ` (${s.note})` : ""}${s.evidence ? ` [${s.evidence}]` : ""}`);
  }

  out.push("\n## Huddles\n");
  out.push(...actOnRows(ledger, dir, reviews));

  out.push("\n## Verify\n");
  out.push(...verifyLines(verify));
  if (verify) out.push(`\nsource hash at verify: \`${verify.sourceHash.slice(0, 12)}\` · now: \`${state.now.hash.slice(0, 12)}\``);

  out.push("\n## Changed files\n");
  const groups = [["source", config.isSource], ["tests", config.isTest], ["ui", config.isUi], ["schema", config.isSchema], ["high-risk", config.isHighRisk], ["docs", config.isDoc]];
  const seen = new Set();
  for (const [name, pred] of groups) {
    const files = changed.filter(pred);
    if (files.length) {
      out.push(`- ${name} (${files.length}): ${files.slice(0, 20).join(", ")}${files.length > 20 ? ", …" : ""}`);
      files.forEach((f) => seen.add(f));
    }
  }
  const other = changed.filter((f) => !seen.has(f));
  if (other.length) out.push(`- other (${other.length}): ${other.slice(0, 20).join(", ")}`);
  if (!changed.length) out.push("_none since baseline_");

  const tier = tierBlock(state);
  if (tier.length) out.push("\n## Tier\n", ...tier);

  const decisions = tailLines(path.join(dir, "decisions.tsv"), 200);
  out.push("\n## Decisions\n");
  if (decisions) {
    const rows = decisions.split("\n").slice(1);
    out.push("| ts | phase | decision | why | evidence | result |\n| --- | --- | --- | --- | --- | --- |");
    for (const r of rows) out.push(`| ${r.split("\t").map(cell).join(" | ")} |`);
  } else out.push("_none_");

  if (ledger.pauses.length) {
    out.push("\n## Pauses\n");
    for (const p of ledger.pauses) out.push(`- ${p.ts}: ${cell(p.text)}`);
  }

  out.push("\n## Attention\n");
  const attention = attentionLines(state, unmet);
  out.push(attention.length ? attention.join("\n") : "_nothing flagged_");

  return `${out.join("\n")}\n`;
}

// ---- the brief: what the user reads. Plain words only; the ledger's own names stay inside. ----

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// "npm run lint" → lint; the command itself when nothing recognisable is in it.
export function plainCommand(cmd) {
  const c = String(cmd).toLowerCase();
  const has = (word) => new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(c); // standalone, not inside a hyphenated name
  if (has("(?:es|ts)?lint")) return "lint";
  if (has("typecheck") || has("type-check") || has("tsc")) return "typecheck";
  if (has("tests?") || has("vitest") || has("jest") || has("pytest") || has("mocha")) return "tests";
  if (has("build")) return "build";
  return cmd;
}

function checksLine(verify) {
  if (!verify) return "Checks not run yet.";
  const ok = [];
  const bad = [];
  const skipped = [];
  for (const c of verify.commands) {
    if (c.skipped) skipped.push(plainCommand(c.cmd));
    else (c.exit === 0 && !c.timedOut ? ok : bad).push(plainCommand(c.cmd));
  }
  const parts = [];
  if (ok.length) parts.push(`${ok.join(", ")} green`);
  if (bad.length) parts.push(`${bad.join(", ")} failed`);
  if (skipped.length) parts.push(`${skipped.join(", ")} skipped (test-only change)`);
  if (!parts.length) return "Checks not run yet.";
  return `${cap(parts.join("; "))}.`;
}

function reviewLine(ledger) {
  const rounds = ledger.huddles.filter((h) => h.role === "reviewer" || h.role === "reviewer-2");
  if (!rounds.length) return "No independent review yet.";
  const items = rounds.flatMap((h) => h.actOn);
  if (!items.length) return "Reviewer found no problems.";
  const overruled = items.filter((a) => a.dispute?.verdict === "arbiter:implementer").length;
  const withdrawn = items.filter((a) => a.dispute?.verdict === "withdrawn").length;
  const open = items.filter((a) => !a.closed).length;
  const fixed = items.length - overruled - withdrawn - open;
  const parts = [];
  if (!open && !overruled && !withdrawn) return `Reviewer found ${plural(items.length, "problem")}, ${items.length === 1 ? "fixed" : "all fixed"}.`;
  if (fixed) parts.push(`${fixed} fixed`);
  if (withdrawn) parts.push(`${withdrawn} withdrawn by the reviewer`);
  if (overruled) parts.push(`${overruled} overruled by the arbiter`);
  if (open) parts.push(`${open} still open`);
  return `Reviewer found ${plural(items.length, "problem")}, ${parts.join(", ")}.`;
}

// The five lines of the brief. Plain words only: the user reads this as the final message.
const PLAIN_RULES = {
  R1: "no task was opened for this change",
  R2: "the plan or the case list came after the first edit",
  R3: "the checks are stale or red",
  R4: "the app was not driven after the last change",
  R5: "no review after the last change, or a finding is still open",
  R6: "the real schema was not probed",
  R7: "no test file changed",
  R8: "a case or a step is still blank",
  R9: "the second reviewer did not run",
  R10: "a repo check failed",
  R13: "the gate config changed mid-task",
  R15: "a helper's findings were not all recorded",
  R16: "the lead edited source at a size a worker should handle",
};

function changedLine(state) {
  const { ledger, config, changed, policy } = state;
  const src = changed.filter((p) => config.isSource(p) && !config.isTest(p));
  if (!src.length) return "Changed no source files.";
  const names = src.slice(0, 3).join(", ") + (src.length > 3 ? ` and ${src.length - 3} more` : "");
  const m = policy && tiered(ledger) ? (state.tier?.measured ?? tierOf(ledger).measured) : null;
  const size = m ? `, size ${effectiveTier(policy, ledger, m)}` : "";
  return `Changed ${plural(src.length, "file")} (${names})${size}.`;
}

function checksLine2(state) {
  const { ledger, config, changed, verify } = state;
  const tests = changed.filter((p) => config.isTest(p));
  const cases = ledger.cases;
  let casesText = "No test cases recorded.";
  if (cases.length) {
    const open = cases.filter((c) => c.status !== "closed").length;
    const na = cases.filter((c) => c.na).length;
    const parts = [];
    if (open) parts.push(`${open} still open`);
    if (na) parts.push(`${na} marked not applicable`);
    casesText = `Tested ${plural(cases.length, "case")}, ${parts.length ? parts.join(", ") : "all covered"}.`;
  }
  const testsText = tests.length ? `Test files changed (${plural(tests.length, "file")}).` : "No test file changed.";
  const src = changed.filter((p) => config.isSource(p));
  const checks = !verify && !src.length ? "Checks not needed: no source changed." : checksLine(verify);
  return `${checks} ${casesText} ${testsText}`;
}

function reviewLine2(ledger) {
  const rounds = ledger.huddles.filter((h) => h.role === "reviewer" || h.role === "reviewer-2");
  if (!rounds.length) return "No review yet.";
  const base = reviewLine(ledger).replace(/^Reviewer found/, "found").replace(/\.$/, "");
  return `Review: ${plural(rounds.length, "round")}, ${base}.`;
}

function appLine(state) {
  const { config, changed, events } = state;
  const ui = changed.filter((p) => config.isUi(p));
  if (!ui.length) return "No screen change.";
  // the same clock R4 uses, so line 4 and the missing list can never disagree
  const lastEdit = lastEditSeq(state, config, state.ledger);
  const driven = events.some((e) => !e.agent && e.seq > lastEdit && (e.kind === "browser" || (e.kind === "skill" && e.skill === "verify")));
  return driven ? "App driven after the last change." : "App not yet driven after the last change.";
}

// Free text written by helpers or the lead may carry the gate's own words; swap them for
// plain ones so the user never meets them. Standalone words only (ledger-service stays).
const alone = (word) => new RegExp(`(?<![\\w-])${word}(?![\\w-])`, "gi");
const PLAIN_WORDS = [
  [alone("ledger(?:\\.md|\\.json)?"), "task record"],
  [alone("huddles?"), "review round"],
  [alone("rungs?"), "proof level"],
  [alone("skeptic"), "design critic"],
  [alone("blast[- ]radius"), "side effects"],
  [alone("R\\d{1,2}"), "a check"],
  [alone("N/A"), "not applicable"],
];
function plain(text) {
  let t = String(text ?? "");
  for (const [re, word] of PLAIN_WORDS) t = t.replace(re, word);
  return t;
}

const FOR_YOU_MAX = 6;

function forYouLine(state, unmet) {
  const { ledger, events } = state;
  const items = [];
  for (const w of ledger.waivers) items.push(`skipped with your OK: ${plain(w.reason ?? w.quote)}`);
  for (const a of ledger.huddles.flatMap((h) => h.actOn)) {
    if (!a.dispute) continue;
    const v = a.dispute.verdict;
    const text = plain(a.text);
    if (v === "arbiter:implementer") items.push(`"${text}": the arbiter sided with me, not changed`);
    else if (v === "arbiter:reviewer") items.push(`"${text}": the arbiter sided with the reviewer${a.closed ? ", fixed" : ", fix pending"}`);
    else if (v === "upheld") items.push(`"${text}": the reviewer upheld it, waiting for the arbiter`);
    else if (v !== "withdrawn") items.push(`"${text}": disputed, waiting for the reviewer's answer`);
  }
  for (const s of ledger.steps.filter((x) => x.state === "SKIPPED")) items.push(`skipped: ${plain(s.text)} (${plain(s.note)})`);
  for (const p of ledger.pauses ?? []) items.push(`paused for: ${plain(p.text)}`);
  const denies = events.filter((e) => e.kind === "deny" && !e.delegate).length;
  if (denies) items.push(`${plural(denies, "blocked write")} to check files`);
  if (ledger.overridden) items.push("I could not satisfy the checks and ended anyway; treat everything above as unverified");
  const order = lateOrder(state);
  if (order.late.length) items.push(`the ${order.late.join(" and ").replace("case table", "list of test cases").replace("Plan", "plan")} was written after the first code change`);
  const errors = gateErrorsSince(state);
  if (errors) items.push(`the gate itself logged ${plural(errors, "error")}; see gate-error.log`);
  const missing = [...new Set(unmet.map((u) => PLAIN_RULES[u.rule] ?? u.text.replace(/\bR\d{1,2}\b/g, "a check")))];
  for (const m of missing) items.push(`missing: ${m}`);
  if (!items.length) return "For you: nothing.";
  const shown = items.slice(0, FOR_YOU_MAX);
  const more = items.length - shown.length;
  return `For you: ${shown.join("; ")}${more ? `; and ${more} more in the full report` : ""}.`;
}

// Only errors logged since this task opened belong to it; the log is shared and append-only.
function gateErrorsSince(state) {
  const errLog = path.join(state.stateDir ?? path.resolve(state.dir, "..", ".."), "gate-error.log");
  if (!existsSync(errLog)) return 0;
  const since = state.ledger.openedAt ?? "";
  return readFileSync(errLog, "utf8").split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l) && l.slice(0, 24) >= since).length;
}

export function renderBrief(state, unmet) {
  const { ledger, dir } = state;
  const out = [];
  out.push(unmet.length ? `${ledger.slug}: not finished (${plural(unmet.length, "thing")} missing)` : `${ledger.slug}: done`);
  out.push("");
  out.push(changedLine(state));
  out.push(checksLine2(state));
  out.push(reviewLine2(ledger));
  out.push(appLine(state));
  out.push(forYouLine(state, unmet));
  out.push("");
  out.push(`Full report: ${path.join(dir, "report.md")}`);
  return `${out.join("\n")}\n`;
}

export const verbs = {
  report(ctx) {
    const brief = ctx.args.includes("--brief");
    let state = buildState(ctx, {});
    let unmet;
    if (state.ledger) {
      unmet = evaluate(state);
    } else {
      const last = loadSession(ctx.stateDir, ctx.session)?.lastClosed;
      if (!last) throw new UsageError("no open or recently closed ledger for this session");
      const dir = path.join(runsDir(ctx.stateDir), last);
      const ledger = loadLedger(dir);
      const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
      state = { ...state, ledger, dir, verify: readVerify(dir), reviews: reviewFiles(dir), events, changed: ledger.changedAtClose ?? [], policy: state.policy ?? loadPolicy(), tier: ledger.tier ?? null };
      unmet = [];
    }
    const full = { ...state, stateDir: ctx.stateDir };
    const md = renderReport(full, unmet);
    writeFileSync(path.join(state.dir, "report.md"), md);
    process.stdout.write(brief ? renderBrief(full, unmet) : md);
  },
};
