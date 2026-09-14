import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildState } from "./assess.mjs";
import { evaluate } from "./rules.mjs";
import { loadLedger, runsDir } from "./ledger.mjs";
import { loadSession } from "./session-state.mjs";
import { readVerify, reviewFiles } from "./assess.mjs";
import { readEvents } from "./events.mjs";

function section(md, heading) {
  const m = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(md ?? "");
  return m ? m[1].replace(/<!--[\s\S]*?-->/g, "").trim() : "";
}

function tailLines(file, n) {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").trim().split("\n").slice(-n).join("\n");
}

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderReport(state, unmet) {
  const { ledger, dir, config, changed, verify, events, reviews } = state;
  const md = existsSync(path.join(dir, "ledger.md")) ? readFileSync(path.join(dir, "ledger.md"), "utf8") : "";
  const out = [];

  out.push(`# ${ledger.slug} — ${ledger.playbook} — ${ledger.status}`);
  if (ledger.overridden) out.push(`\n**GATE OVERRIDDEN** at ${ledger.overridden.at} after ${ledger.overridden.blocks} identical blocks: ${ledger.overridden.unmet.map((u) => u.rule).join(", ")}`);
  const errLog = path.join(state.stateDir ?? path.resolve(dir, "..", ".."), "gate-error.log");
  const gateErrors = tailLines(errLog, 3);
  if (gateErrors) out.push(`\n**GATE ERROR** (last lines of gate-error.log):\n\`\`\`\n${gateErrors}\n\`\`\``);

  const count = (s) => ledger.steps.filter((x) => x.state === s).length;
  const blank = ledger.steps.filter((x) => !x.state).length;
  const closedCases = ledger.cases.filter((c) => c.status === "closed").length;
  const naCases = ledger.cases.filter((c) => c.na).length;
  const unproven = ledger.blast.filter((b) => b.unproven).length;
  const denies = events.filter((e) => e.kind === "deny").length;
  out.push(
    `\nDONE ${count("DONE")} · SKIPPED ${count("SKIPPED")} · WAIVED ${count("WAIVED")} · N/A ${count("N/A")} · blank ${blank} · ` +
      `cases ${closedCases}/${ledger.cases.length} closed (${naCases} n/a) · blast ${ledger.blast.length} fact(s), ${unproven} unproven · ` +
      `tampering attempts ${denies} · gate: ${unmet.length ? `${unmet.length} unmet` : "clean"}`,
  );

  out.push(`\n## Task\n\n${section(md, "Task") || "_not written_"}`);
  out.push(`\n## Plan\n\n${section(md, "Plan") || "_not written_"}`);

  out.push("\n## Case table\n");
  if (ledger.cases.length) {
    out.push("| id | case | kind | test | status |\n| --- | --- | --- | --- | --- |");
    for (const c of ledger.cases) out.push(`| ${c.id} | ${cell(c.case)} | ${c.kind} | ${cell(c.test ?? (c.na ? `n/a: ${c.na}` : ""))} | ${c.status} |`);
  } else out.push("_none_");

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
  if (ledger.huddles.length) {
    for (const h of ledger.huddles) {
      out.push(`### ${h.id} ${h.role} round ${h.round}${h.file ? ` — ${h.file}` : ""}`);
      if (h.summary) out.push(h.summary);
      for (const a of h.actOn) out.push(`- ${a.id} ${cell(a.text)} — ${a.closed ? `closed [${a.closed}]` : "**OPEN**"}`);
      if (h.file && reviews.includes(h.file)) out.push(`\n<details><summary>${h.file}</summary>\n\n${readFileSync(path.join(dir, h.file), "utf8").trim()}\n\n</details>`);
    }
  } else out.push("_none_");

  out.push("\n## Verify\n");
  if (verify) {
    for (const c of verify.commands) {
      out.push(`- ${c.exit === 0 && !c.timedOut ? "✓" : "✗"} \`${c.cmd}\` — ${c.timedOut ? "timed out" : `exit ${c.exit}`}, ${(c.ms / 1000).toFixed(1)}s`);
      if (c.exit !== 0 || c.timedOut) out.push(`\n\`\`\`\n${c.tail.split("\n").slice(-12).join("\n")}\n\`\`\``);
    }
    out.push(`\nsource hash at verify: \`${verify.sourceHash.slice(0, 12)}\` · now: \`${state.now.hash.slice(0, 12)}\``);
  } else out.push("_not run_");

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
  const attention = [];
  const prose = section(md, "Attention");
  if (prose) attention.push(prose);
  for (const w of ledger.waivers) attention.push(`- waived ${w.key}: "${w.quote}" — ${w.found === true ? "found in transcript" : w.found === false ? "**NOT found in transcript**" : "not yet checked"}`);
  for (const b of ledger.blast.filter((x) => x.unproven)) attention.push(`- unproven: ${b.fact} (rung ${b.rung})`);
  for (const s of ledger.steps.filter((x) => x.state === "SKIPPED")) attention.push(`- skipped: ${s.text} — ${s.note}`);
  if (denies) attention.push(`- ${denies} denied write(s) to gate evidence files (see events)`);
  if (ledger.overridden) attention.push("- the gate was OVERRIDDEN; treat every claim above as unverified");
  for (const u of unmet) attention.push(`- unmet ${u.rule}: ${u.text}`);
  out.push(attention.length ? attention.join("\n") : "_nothing flagged_");

  return `${out.join("\n")}\n`;
}

export const verbs = {
  report(ctx) {
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
    const md = renderReport({ ...state, stateDir: ctx.stateDir }, unmet);
    writeFileSync(path.join(state.dir, "report.md"), md);
    process.stdout.write(md);
  },
};
