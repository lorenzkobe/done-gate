import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildState } from "./assess.mjs";
import { evaluate } from "./rules.mjs";
import { loadLedger, runsDir } from "./ledger.mjs";
import { loadSession } from "./session-state.mjs";
import { readVerify, reviewFiles } from "./assess.mjs";
import { readEvents } from "./events.mjs";

export function section(md, heading) {
  const m = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(md ?? "");
  return m ? m[1].replace(/<!--[\s\S]*?-->/g, "").trim() : "";
}

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
  const unproven = ledger.blast.filter((b) => b.unproven).length;
  const denies = events.filter((e) => e.kind === "deny").length;
  return (
    `DONE ${count("DONE")} · SKIPPED ${count("SKIPPED")} · WAIVED ${count("WAIVED")} · N/A ${count("N/A")} · blank ${blank} · ` +
    `cases ${closedCases}/${ledger.cases.length} closed (${naCases} n/a) · blast ${ledger.blast.length} fact(s), ${unproven} unproven · ` +
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
    for (const a of h.actOn) out.push(`- ${a.id} ${cell(a.text)} — ${a.closed ? `closed [${a.closed}]` : "**OPEN**"}`);
    if (embed && h.file && reviews.includes(h.file)) out.push(`\n<details><summary>${h.file}</summary>\n\n${readFileSync(path.join(dir, h.file), "utf8").trim()}\n\n</details>`);
  }
  return out;
}

export function attentionLines(state, unmet) {
  const { ledger, events } = state;
  const denies = events.filter((e) => e.kind === "deny").length;
  const out = [];
  const prose = section(ledgerMd(state.dir), "Attention");
  if (prose) out.push(prose);
  for (const w of ledger.waivers) out.push(`- waived ${w.key}: "${w.quote}" — ${w.found === true ? "found in transcript" : w.found === false ? "**NOT found in transcript**" : "not yet checked"}`);
  for (const b of ledger.blast.filter((x) => x.unproven)) out.push(`- unproven: ${b.fact} (rung ${b.rung})`);
  for (const s of ledger.steps.filter((x) => x.state === "SKIPPED")) out.push(`- skipped: ${s.text} — ${s.note}`);
  if (denies) out.push(`- ${denies} denied write(s) to gate evidence files (see events)`);
  if (ledger.overridden) out.push("- the gate was OVERRIDDEN; treat every claim above as unverified");
  for (const u of unmet) out.push(`- unmet ${u.rule}: ${u.text}`);
  return out;
}

export function renderReport(state, unmet) {
  const { ledger, dir, config, changed, verify, events, reviews } = state;
  const md = ledgerMd(dir);
  const out = [];

  out.push(`# ${ledger.slug} — ${ledger.playbook} — ${ledger.status}`);
  if (ledger.overridden) out.push(`\n**GATE OVERRIDDEN** at ${ledger.overridden.at} after ${ledger.overridden.blocks} identical blocks: ${ledger.overridden.unmet.map((u) => u.rule).join(", ")}`);
  const errLog = path.join(state.stateDir ?? path.resolve(dir, "..", ".."), "gate-error.log");
  const gateErrors = tailLines(errLog, 3);
  if (gateErrors) out.push(`\n**GATE ERROR** (last lines of gate-error.log):\n\`\`\`\n${gateErrors}\n\`\`\``);

  out.push(`\n${summaryLine(ledger, events, unmet)}`);

  out.push(`\n## Task\n\n${section(md, "Task") || "_not written_"}`);
  out.push(`\n## Plan\n\n${section(md, "Plan") || "_not written_"}`);

  out.push("\n## Case table\n");
  out.push(...caseTable(ledger));

  out.push("\n## Blast radius\n");
  if (ledger.blast.length) {
    out.push("| fact | rung | proof |\n| --- | --- | --- |");
    for (const b of ledger.blast) out.push(`| ${cell(b.fact)} | ${b.rung} | ${b.unproven ? "unproven" : ""}${b.unproven && b.proof ? " — " : ""}${cell(b.proof)} |`);
  } else out.push("_none_");

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
  for (const c of verify.commands) (c.exit === 0 && !c.timedOut ? ok : bad).push(plainCommand(c.cmd));
  if (!bad.length) return `${cap(ok.join(", "))} green.`;
  const failed = `${bad.join(", ")} ${bad.length === 1 ? "failed" : "failed"}`;
  return ok.length ? `${cap(ok.join(", "))} green; ${failed}.` : `${cap(failed)}.`;
}

function reviewLine(ledger) {
  const rounds = ledger.huddles.filter((h) => h.role === "reviewer" || h.role === "reviewer-2");
  if (!rounds.length) return "No independent review yet.";
  const items = rounds.flatMap((h) => h.actOn);
  if (!items.length) return "Reviewer found no problems.";
  const open = items.filter((a) => !a.closed).length;
  if (!open) return `Reviewer found ${plural(items.length, "problem")}, ${items.length === 1 ? "fixed" : "all fixed"}.`;
  return `Reviewer found ${plural(items.length, "problem")}, ${open} still open.`;
}

function designLine(ledger) {
  const rounds = ledger.huddles.filter((h) => h.role === "skeptic");
  if (!rounds.length) return null;
  const items = rounds.flatMap((h) => h.actOn);
  if (!items.length) return "Design check done.";
  const open = items.filter((a) => !a.closed).length;
  return open ? `Design check: ${plural(items.length, "concern")}, ${open} still open.` : `Design check: ${plural(items.length, "concern")}, all addressed.`;
}

function testedLine(ledger, changed, config) {
  const src = changed.filter((p) => config.isSource(p) && !config.isTest(p));
  const changedText = src.length ? `Changed ${plural(src.length, "file")}.` : "Changed no source files.";
  const cases = ledger.cases;
  if (!cases.length) return `${changedText} No test cases recorded.`;
  const open = cases.filter((c) => c.status !== "closed").length;
  const na = cases.filter((c) => c.na).length;
  const parts = [];
  if (open) parts.push(`${open} still open`);
  if (na) parts.push(`${na} marked not applicable`);
  return `${changedText} Tested ${plural(cases.length, "case")}, ${parts.length ? parts.join(", ") : "all covered"}.`;
}

// The Attention prose is written by the model and may slip into the gate's own vocabulary;
// the brief swaps those words for plain ones so the user never meets them.
// A word is replaced only when it stands alone: not inside another word and not part of a
// hyphenated name (ledger-service stays ledger-service).
const alone = (word, flags = "gi") => new RegExp(`(?<![\\w-])${word}(?![\\w-])`, flags);
const PLAIN_WORDS = [
  [alone("blast[- ]radius"), "side effects"],
  [alone("blast fact"), "side-effect fact"],
  [alone("ledger(?:\\.md|\\.json)?"), "task record"],
  [alone("huddles?"), "review round"],
  [alone("\\(?rung \\d+\\)?"), ""],
  [alone("rungs?"), "proof level"],
  [alone("R\\d{1,2}", "g"), "a gate check"],
  [alone("N/A", "g"), "not applicable"],
  [alone("skeptic"), "design critic"],
];
export function plainWords(text) {
  let t = String(text);
  for (const [re, word] of PLAIN_WORDS) t = t.replace(re, word);
  return t.replace(/  +/g, " ").replace(/ ([.,;])/g, "$1");
}

// Only errors logged since this task opened belong to it; the log is shared and append-only.
function gateErrorsSince(state) {
  const errLog = path.join(state.stateDir ?? path.resolve(state.dir, "..", ".."), "gate-error.log");
  if (!existsSync(errLog)) return 0;
  const since = state.ledger.openedAt ?? "";
  return readFileSync(errLog, "utf8").split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l) && l.slice(0, 24) >= since).length;
}

function lookFirst(state) {
  const { ledger, events } = state;
  const out = [];
  const prose = section(ledgerMd(state.dir), "Attention");
  if (prose) out.push(...prose.split("\n").filter((l) => l.trim()).map((l) => plainWords(l.trim().startsWith("-") ? l.trim() : `- ${l.trim()}`)));
  for (const w of ledger.waivers) {
    out.push(w.found === false ? `- Skipped, but I could not find you saying that: "${w.quote}".` : `- Skipped with your OK: "${w.quote}".`);
  }
  for (const b of ledger.blast.filter((x) => x.unproven)) out.push(`- ${b.fact} — my belief, not verified.`);
  for (const s of ledger.steps.filter((x) => x.state === "SKIPPED")) out.push(`- Skipped: ${s.text} — ${s.note}`);
  const denies = events.filter((e) => e.kind === "deny").length;
  if (denies) out.push(`- Blocked writes to check files: ${denies}.`);
  if (ledger.overridden) out.push("- ⚠ I could not satisfy the checks and ended anyway; treat everything above as unverified.");
  const errors = gateErrorsSince(state);
  if (errors) out.push(`- ⚠ The gate itself logged ${plural(errors, "error")} during this task; see gate-error.log.`);
  return out;
}

export function renderBrief(state, unmet) {
  const { ledger, dir, config, changed, verify } = state;
  const out = [];
  out.push(unmet.length ? `${ledger.slug}: not finished (${plural(unmet.length, "thing")} missing)` : `${ledger.slug}: done`);
  out.push("");
  out.push(testedLine(ledger, changed, config));
  out.push(checksLine(verify));
  out.push(reviewLine(ledger));
  const design = designLine(ledger);
  if (design) out.push(design);
  const look = lookFirst(state);
  if (look.length) {
    out.push("");
    out.push("Please look at first:");
    out.push(...look);
  }
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
      if (!last) throw new Error("no open or recently closed ledger for this session");
      const dir = path.join(runsDir(ctx.stateDir), last);
      const ledger = loadLedger(dir);
      const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
      state = { ...state, ledger, dir, verify: readVerify(dir), reviews: reviewFiles(dir), events, changed: ledger.changedAtClose ?? [] };
      unmet = [];
    }
    const full = { ...state, stateDir: ctx.stateDir };
    const md = renderReport(full, unmet);
    writeFileSync(path.join(state.dir, "report.md"), md);
    process.stdout.write(brief ? renderBrief(full, unmet) : md);
  },
};
