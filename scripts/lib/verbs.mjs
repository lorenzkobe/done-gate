import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nextSeq } from "./events.mjs";
import { currentLedger, loadLedger, saveLedger } from "./ledger.mjs";
import { loadConfig } from "./config.mjs";
import { loadPolicy } from "./policy.mjs";
import { applyPrediction, tiered } from "./size.mjs";
import { toPosixRel } from "./paths.mjs";

// Steps whose evidence comes from a script or an agent: DONE or WAIVED only.
export const EVIDENCED_KEYS = new Set(["verify", "verify-before", "driver", "review", "qa", "skeptic", "close"]);
export const CASE_KINDS = ["happy", "edge", "refused", "boundary", "idempotent", "reported-surface"];
export const ROLES = ["skeptic", "qa", "reviewer", "reviewer-2"];

export function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function open(ctx) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if (!current || current.ledger.status === "closed") {
    throw new Error("no open ledger for this session — run `gate open <slug> <playbook>` first");
  }
  return current;
}

function withLedger(ctx, fn) {
  const { dir, ledger } = open(ctx);
  const out = fn(ledger, dir);
  saveLedger(dir, ledger);
  return out;
}

function markStep(ledger, key, patch) {
  const step = ledger.steps.find((s) => s.key === key);
  if (step && step.state === null) Object.assign(step, { seq: nextSeq(), ...patch });
}

function readText(ctx, text) {
  if (text === "-") {
    const raw = ctx.input?.__raw ?? ctx.rawStdin ?? "";
    return raw;
  }
  return text ?? "";
}

function replaceSection(md, heading, body) {
  const re = new RegExp(`(## ${heading}\\n)([\\s\\S]*?)(?=\\n## |$)`);
  const m = re.exec(md);
  if (!m) return `${md.trimEnd()}\n\n## ${heading}\n\n${body}\n`;
  const existing = m[2].replace(/<!--[\s\S]*?-->/g, "").trim();
  const next = existing ? `${existing}\n\n${body}` : body;
  return md.replace(re, `$1\n${next}\n`);
}

export const verbs = {
  note(ctx) {
    const [section, ...rest] = ctx.args;
    if (!["task", "plan", "attention"].includes(section)) throw new Error('usage: gate note <task|plan|attention> "<text>" (or - to read stdin)');
    const files = flag(rest, "--files");
    const text = readText(ctx, positional(rest).join(" ")).trim();
    if (!text) throw new Error("note: empty text");
    let predicted = null;
    withLedger(ctx, (ledger, dir) => {
      const file = path.join(dir, "ledger.md");
      const heading = section[0].toUpperCase() + section.slice(1);
      writeFileSync(file, replaceSection(readFileSync(file, "utf8"), heading, text));
      const seq = nextSeq();
      if (section === "task") ledger.taskSeq = seq;
      if (section === "plan") {
        ledger.planSeq = seq;
        if (ledger.taskSeq) markStep(ledger, "plan", { state: "DONE", evidence: "ledger.md#plan", note: "Task and Plan written" });
        if (files !== undefined && tiered(ledger)) {
          // paths outside the repo are dropped: they cannot be part of this task's diff
          const paths = files.split(",").map((f) => f.trim()).filter(Boolean).map((f) => toPosixRel(ctx.root, f)).filter((f) => f);
          predicted = applyPrediction(ledger, loadPolicy(), loadConfig(ctx.root), paths);
        }
      }
    });
    ctx.out(predicted ? `${section} noted · tier predicted ${predicted.tier} (${predicted.files} file${predicted.files === 1 ? "" : "s"}${predicted.forced.length ? `, forced by ${predicted.forced.join(", ")}` : ""})` : `${section} noted`);
  },

  case(ctx) {
    const [action, ...rest] = ctx.args;
    const pos = positional(rest);
    if (action === "add") {
      const text = pos.join(" ");
      const kind = flag(rest, "--kind") ?? "happy";
      if (!text) throw new Error('usage: gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface>');
      if (!CASE_KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" (have: ${CASE_KINDS.join(", ")})`);
      const id = withLedger(ctx, (ledger) => {
        const id = `C${ledger.cases.length + 1}`;
        ledger.cases.push({ id, case: text, kind, test: null, na: null, status: "open", seq: nextSeq() });
        markStep(ledger, "cases", { state: "DONE", evidence: "ledger.json#cases", note: "case table written" });
        return id;
      });
      ctx.out(`${id} added (${kind})`);
      return;
    }
    if (action === "close") {
      const [id] = pos;
      const testPtr = flag(rest, "--test");
      const na = flag(rest, "--na");
      if (!id || (!testPtr && !na)) throw new Error("usage: gate case close <id> --test <file:testname> | --na <reason>");
      withLedger(ctx, (ledger) => {
        const row = ledger.cases.find((c) => c.id === id);
        if (!row) throw new Error(`no case ${id}`);
        Object.assign(row, { test: testPtr ?? null, na: na ?? null, status: "closed", closedSeq: nextSeq() });
      });
      ctx.out(`${id} closed`);
      return;
    }
    throw new Error("usage: gate case add|close ...");
  },

  step(ctx) {
    const [ref, stateWord, ...rest] = ctx.args;
    const note = positional(rest).join(" ");
    const evidence = flag(rest, "--evidence");
    const states = { done: "DONE", skipped: "SKIPPED", na: "N/A", "n/a": "N/A" };
    const state = states[String(stateWord).toLowerCase()];
    if (!ref || !state) throw new Error('usage: gate step <n|key> <done|skipped|na> "<note>" [--evidence <pointer>]');
    withLedger(ctx, (ledger) => {
      const step = ledger.steps.find((s) => s.key === ref || String(s.n) === ref);
      if (!step) throw new Error(`no step "${ref}"`);
      if (state === "SKIPPED" && step.key && EVIDENCED_KEYS.has(step.key)) {
        throw new Error(`step {${step.key}} has script/agent evidence and cannot be SKIPPED — do it, or get the user's waiver with \`gate waive ${step.key} "<their words>"\``);
      }
      if (state === "DONE" && !evidence) throw new Error("DONE needs --evidence <pointer> (events#seq, verify.json, review-<n>.md, decisions#n, or a file path)");
      if (state !== "DONE" && !note) throw new Error(`${state} needs a reason`);
      Object.assign(step, { state, note: note || null, evidence: evidence ?? null, seq: nextSeq() });
    });
    ctx.out(`step ${ref} → ${state}`);
  },

  blast(ctx) {
    const [action, ...rest] = ctx.args;
    if (action !== "add") throw new Error('usage: gate blast add "<fact the change is safe because of>" --rung <1-5> --proof "<pointer>"');
    const fact = positional(rest).join(" ");
    const rung = Number(flag(rest, "--rung"));
    const proof = flag(rest, "--proof") ?? "";
    if (!fact || !(rung >= 1 && rung <= 5)) throw new Error("blast add needs a fact and --rung 1..5 (1 said so · 2 pointed at the line · 3 walked the failure · 4 ran it · 5 reproduced in the app)");
    withLedger(ctx, (ledger) => {
      ledger.blast.push({ fact, rung, proof, unproven: rung < 4, seq: nextSeq() });
      markStep(ledger, "blast", { state: "DONE", evidence: "ledger.json#blast", note: "blast radius recorded" });
    });
    ctx.out(`blast fact recorded at rung ${rung}${rung < 4 ? " (unproven)" : ""}`);
  },

  huddle(ctx) {
    const [action, ...rest] = ctx.args;
    const pos = positional(rest);
    if (action === "add") {
      const [role] = pos;
      if (!ROLES.includes(role)) throw new Error(`usage: gate huddle add <${ROLES.join("|")}> [--file review-<n>.md] [--summary "<text>"]`);
      const id = withLedger(ctx, (ledger) => {
        const id = `H${ledger.huddles.length + 1}`;
        const round = ledger.huddles.filter((h) => h.role === role).length + 1;
        ledger.huddles.push({ id, role, round, file: flag(rest, "--file") ?? null, summary: flag(rest, "--summary") ?? null, actOn: [], seq: nextSeq() });
        return id;
      });
      ctx.out(`${id} added (${role})`);
      return;
    }
    if (action === "acton") {
      const [hid, ...words] = pos;
      const text = words.join(" ");
      if (!hid || !text) throw new Error('usage: gate huddle acton <H#> "<finding>"');
      const id = withLedger(ctx, (ledger) => {
        const h = ledger.huddles.find((x) => x.id === hid);
        if (!h) throw new Error(`no huddle ${hid}`);
        const id = `${hid}.${h.actOn.length + 1}`;
        h.actOn.push({ id, text, closed: null });
        return id;
      });
      ctx.out(`${id} recorded`);
      return;
    }
    if (action === "resolve") {
      const [aid] = pos;
      const evidence = flag(rest, "--evidence");
      if (!aid || !evidence) throw new Error("usage: gate huddle resolve <H#.#> --evidence <pointer>");
      withLedger(ctx, (ledger) => {
        for (const h of ledger.huddles) {
          const item = h.actOn.find((a) => a.id === aid);
          if (item) {
            item.closed = evidence;
            item.closedSeq = nextSeq();
            return;
          }
        }
        throw new Error(`no act-on item ${aid}`);
      });
      ctx.out(`${aid} resolved`);
      return;
    }
    throw new Error("usage: gate huddle add|acton|resolve ...");
  },

  waive(ctx) {
    const [key, ...words] = ctx.args;
    const quote = words.join(" ").trim();
    if (!key || !quote) throw new Error('usage: gate waive <stepKey|R#> "<the user\'s exact words>"');
    withLedger(ctx, (ledger) => {
      ledger.waivers.push({ key, quote, found: null, seq: nextSeq() });
      const step = ledger.steps.find((s) => s.key === key);
      if (step) Object.assign(step, { state: "WAIVED", note: quote, evidence: null, seq: nextSeq() });
    });
    ctx.out(`waived ${key} — the stop gate will look for that quote in the transcript`);
  },

  decide(ctx) {
    const cells = ctx.args;
    if (cells.length !== 5) throw new Error("usage: gate decide <phase> <decision> <why> <evidence> <result>");
    const { dir } = open(ctx);
    const file = path.join(dir, "decisions.tsv");
    if (!existsSync(file)) writeFileSync(file, "ts\tphase\tdecision\twhy\tevidence\tresult\n");
    const clean = (v) => {
      const s = String(v).replace(/[\t\r\n]+/g, " ");
      return /^[=+\-@]/.test(s) ? `'${s}` : s;
    };
    appendFileSync(file, `${new Date().toISOString()}\t${cells.map(clean).join("\t")}\n`);
    ctx.out("decision logged");
  },

  close(ctx) {
    withLedger(ctx, (ledger) => {
      ledger.status = "closing";
      ledger.closingSeq = nextSeq();
      markStep(ledger, "close", { state: "DONE", evidence: "report.md", note: "closing" });
    });
    ctx.out("ledger closing — run `gate check`; when it is clean, `gate report --brief` and paste it as your final message (the full report is written to report.md). The stop gate finalises the close.");
  },
};
