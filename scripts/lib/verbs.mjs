import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nextSeq } from "./events.mjs";
import { currentLedger, findRun, isDone, loadLedger, saveLedger } from "./ledger.mjs";
import { loadConfig } from "./config.mjs";
import { applyPrediction, policyFor, tierOrder, tiered } from "./size.mjs";
import { toPosixRel } from "./paths.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";
import { renderReport } from "./report.mjs";
import { briefOf, helperRun, isDraft, unfinishedFile, parseDisputes, parseFindings, parseReplies, parseRuling, pointerResolver, CONTEXT_PARTS, contextPart, tracedPointers } from "./rules.mjs";
import { assess, buildState, readVerify, reviewFiles, readVerifyStarted } from "./assess.mjs";
import { loadSession, saveSession } from "./session-state.mjs";
import { readEvents } from "./events.mjs";

// The report of a run that is no longer current: the same renderer `gate report` uses.
export function writeReport(ctx, dir, ledger) {
  const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
  const state = { ...buildState(ctx, {}), ledger, dir, verify: readVerify(dir), verifyStarted: readVerifyStarted(dir), reviews: reviewFiles(dir), events, changed: ledger.changedAtClose ?? [], tier: ledger.tier ?? null, stateDir: ctx.stateDir };
  writeFileSync(path.join(dir, "report.md"), renderReport(state, []));
}

// A clean run closes: the ledger records the tree it closed on, and the session's baseline
// moves to that tree so the next task starts from zero changes.
export function finalise(ctx, state) {
  const ledger = loadLedger(state.dir);
  ledger.status = "closed";
  ledger.closedAt = new Date().toISOString();
  ledger.closedTreeHash = state.now.hash;
  ledger.changedAtClose = state.changed;
  if (state.tier) ledger.tier = state.tier;
  saveLedger(state.dir, ledger);
  const session = loadSession(ctx.stateDir, ctx.session);
  saveSession(ctx.stateDir, { ...session, current: null, lastClosed: path.basename(state.dir), baseline: { files: state.now.files, hash: state.now.hash }, baselineSeq: nextSeq() });
  writeReport(ctx, state.dir, ledger);
  return ledger;
}

// Steps whose evidence comes from a script or an agent: DONE or WAIVED only.
export const EVIDENCED_KEYS = new Set(["context", "verify", "verify-before", "driver", "review", "tests", "qa", "skeptic", "close"]);
export const CASE_KINDS = ["happy", "edge", "refused", "boundary", "idempotent", "reported-surface", "performance"];
export const ROLES = ["skeptic", "qa", "reviewer", "reviewer-2", "arbiter", "worker"];

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
  if (!current || isDone(current.ledger)) {
    throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
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

// The Context note: what was traced (as file:line pointers), what is related, what was
// researched or why nothing needed to be. Each part is a line starting with its name.
const CONTEXT_USAGE = 'gate note context needs three parts, each a line starting with its name: "Traced: <entry points, callers, data flow as file:line pointers>", "Related: <surfaces, docs, tests, config that depend on it>", "Research: <what was looked up and where, or none needed: <why>>"';
function checkContext(text, root) {
  const missing = CONTEXT_PARTS.filter((name) => contextPart(text, name) === null);
  if (missing.length) throw new UsageError(`${CONTEXT_USAGE} (missing: ${missing.join(", ")})`);
  const pointers = tracedPointers(contextPart(text, "Traced"), root);
  if (!pointers.length) throw new UsageError("Traced needs at least one file:line pointer into the repo (the entry point, a caller, a data path); prose alone is not a trace");
  if (!pointers.some((p) => p.exists)) throw new UsageError(`Traced names no file that exists in the repo (${pointers.map((p) => `${p.file}:${p.line}`).join(", ")}); a file:line pointer must resolve`);
}

export const verbs = {
  note(ctx) {
    const [section, ...rest] = ctx.args;
    if (!["task", "context", "plan"].includes(section)) throw new UsageError('usage: gate note <task|context|plan> "<text>" [--files a,b] [--size <tier>] (or - to read stdin)');
    const files = flag(rest, "--files");
    const size = flag(rest, "--size");
    const text = readText(ctx, positional(rest).join(" ")).trim();
    if (!text) throw new UsageError("note: empty text");
    if (section === "context") checkContext(text, ctx.root);
    if (size !== undefined) {
      const sizes = tierOrder(policyFor(open(ctx).ledger));
      if (!sizes.includes(size)) throw new UsageError(`unknown size "${size}" (have: ${sizes.join(", ")})`);
    }
    let predicted = null;
    withLedger(ctx, (ledger, dir) => {
      const file = path.join(dir, "ledger.md");
      const heading = section[0].toUpperCase() + section.slice(1);
      writeFileSync(file, replaceSection(readFileSync(file, "utf8"), heading, text));
      const seq = nextSeq();
      if (section === "task") ledger.taskSeq = seq;
      if (section === "context") {
        ledger.contextSeq = seq;
        markStep(ledger, "context", { state: "DONE", evidence: "ledger.md#context", note: "Context written" });
      }
      if (section === "plan") {
        // the first plan is what R2 dates; an amendment after the skeptic keeps that date
        if (!ledger.planSeq) ledger.planSeq = seq;
        if (ledger.taskSeq) markStep(ledger, "plan", { state: "DONE", evidence: "ledger.md#plan", note: "Task and Plan written" });
        if ((files !== undefined || size !== undefined) && tiered(ledger)) {
          // paths outside the repo are dropped: they cannot be part of this task's diff
          const paths = (files ?? "").split(",").map((f) => f.trim()).filter(Boolean).map((f) => toPosixRel(ctx.root, f)).filter((f) => f);
          predicted = applyPrediction(ledger, policyFor(ledger), loadConfig(ctx.root), paths, size ?? null);
        }
      }
    });
    ctx.out(predicted ? `${section} noted · tier predicted ${predicted.tier} (${predicted.files} file${predicted.files === 1 ? "" : "s"}${predicted.declared ? `, declared ${predicted.declared}` : ""}${predicted.forced.length ? `, forced by ${predicted.forced.join(", ")}` : ""})` : `${section} noted`);
    printNext(ctx);
  },

  case(ctx) {
    const [action, ...rest] = ctx.args;
    const pos = positional(rest);
    if (action === "add") {
      const text = pos.join(" ");
      const kind = flag(rest, "--kind") ?? "happy";
      if (!text) throw new UsageError('usage: gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface|performance>');
      if (!CASE_KINDS.includes(kind)) throw new UsageError(`unknown kind "${kind}" (have: ${CASE_KINDS.join(", ")})`);
      const id = withLedger(ctx, (ledger) => {
        const id = `C${ledger.cases.length + 1}`;
        ledger.cases.push({ id, case: text, kind, test: null, na: null, status: "open", seq: nextSeq() });
        markStep(ledger, "cases", { state: "DONE", evidence: "ledger.json#cases", note: "case table written" });
        return id;
      });
      ctx.out(`${id} added (${kind})`);
    printNext(ctx);
      return;
    }
    if (action === "close") {
      const [id] = pos;
      const testPtr = flag(rest, "--test");
      const na = flag(rest, "--na");
      if (!id || (!testPtr && !na)) throw new UsageError("usage: gate case close <id> --test <file:testname> | --na <reason>");
      withLedger(ctx, (ledger) => {
        const row = ledger.cases.find((c) => c.id === id);
        if (!row) throw new UsageError(`no case ${id}`);
        Object.assign(row, { test: testPtr ?? null, na: na ?? null, status: "closed", closedSeq: nextSeq() });
      });
      ctx.out(`${id} closed`);
    printNext(ctx);
      return;
    }
    throw new UsageError("usage: gate case add|close ...");
  },

  step(ctx) {
    const [ref, stateWord, ...rest] = ctx.args;
    const note = positional(rest).join(" ");
    const evidence = flag(rest, "--evidence");
    const states = { done: "DONE", skipped: "SKIPPED", na: "N/A", "n/a": "N/A" };
    const state = states[String(stateWord).toLowerCase()];
    if (!ref || !state) throw new UsageError('usage: gate step <n|key> <done|skipped|na> "<note>" [--evidence <pointer>]');
    withLedger(ctx, (ledger, dir) => {
      const step = ledger.steps.find((s) => s.key === ref || String(s.n) === ref);
      if (!step) throw new UsageError(`no step "${ref}"`);
      if (state === "SKIPPED" && step.key && EVIDENCED_KEYS.has(step.key)) {
        throw new UsageError(`step {${step.key}} has script/agent evidence and cannot be SKIPPED — do it, or get the user's waiver with \`gate waive ${step.key} "<reason>"\``);
      }
      if (state === "DONE" && !evidence) throw new UsageError("DONE needs --evidence <pointer> (events#seq, verify.json, review-<n>.md, decisions#n, or a file path)");
      if (state !== "DONE" && !note) throw new UsageError(`${state} needs a reason`);
      // the design huddle is done when its newest file is finished and recorded and every
      // finding in it is answered, not when the lead says so
      if (state === "DONE" && step.key === "skeptic") {
        const huddles = ledger.huddles.filter((h) => h.role === "skeptic" && h.file);
        const last = huddles[huddles.length - 1];
        if (!last) throw new UsageError("step {skeptic} needs a recorded skeptic huddle: `gate brief skeptic`, spawn done-gate:skeptic, then `gate huddle add skeptic --file skeptic-<n>.md`");
        const full = path.join(dir, last.file);
        if (!existsSync(full) || unfinishedFile(full)) throw new UsageError(`step {skeptic}: ${last.file} is not finished. Run \`gate brief skeptic\` again and spawn a fresh helper; its packet continues from the file.`);
        const openItems = huddles.flatMap((h) => h.actOn.filter((a) => !a.closed));
        if (openItems.length) throw new UsageError(`step {skeptic}: Act-on item(s) still open: ${openItems.map((a) => a.id).join(", ")}. Answer each, then \`gate huddle resolve <id> --evidence <pointer>\`.`);
      }
      Object.assign(step, { state, note: note || null, evidence: evidence ?? null, seq: nextSeq() });
    });
    ctx.out(`step ${ref} → ${state}`);
    printNext(ctx);
  },

  huddle(ctx) {
    const [action, ...rest] = ctx.args;
    const pos = positional(rest);
    if (action === "add") {
      const [role] = pos;
      if (!ROLES.includes(role)) throw new UsageError(`usage: gate huddle add <${ROLES.join("|")}> [--file review-<n>.md] [--summary "<text>"]`);
      const file = flag(rest, "--file") ?? null;
      // every role whose evidence is a file must name it, or R15 could never count it, and the
      // file must be that role's own: a reviewer huddle cannot point at a skeptic file
      const prefix = { arbiter: "arbiter", skeptic: "skeptic", worker: "worker", "reviewer-2": "review2" }[role] ?? "review";
      if (!file && role !== "qa") throw new UsageError(`gate huddle add ${role} needs --file <${prefix}-<n>.md>: the helper's own file is the evidence`);
      if (file) {
        const { dir, ledger } = open(ctx);
        // a ledger from before the second reviewer had its own stream recorded it on
        // review-<n>.md; one that ever briefed a reviewer-2 on review2-<n>.md is not that
        const legacy = role === "reviewer-2" && !Object.keys(ledger.seen ?? {}).some((k) => k.startsWith("review2-"));
        const ownFile = legacy ? /^review2?-\d+\.md$/ : new RegExp(`^${prefix}-\\d+\\.md$`);
        if (!ownFile.test(file)) throw new UsageError(`gate huddle add ${role}: --file must be that role's own ${prefix}-<n>.md, not ${file}`);
        const other = ledger.huddles.find((h) => h.file === file && h.role !== role);
        if (other) throw new UsageError(`gate huddle add ${role}: ${file} is already recorded as ${other.id} (${other.role})`);
        const full = path.join(dir, file);
        // a draft left by a helper cut off mid-write: every bullet reads "unverified". The
        // round is unfinished, not done — record nothing and send the lead back to re-brief it.
        if (unfinishedFile(full)) {
          if (helperRun(buildState(ctx, {}), role, file, briefOf(ledger, file)?.seq ?? 0).running) {
            throw new UsageError(`${file} is unfinished and its helper is still running: wait for it. Nothing recorded.`);
          }
          throw new UsageError(isDraft(readFileSync(full, "utf8"))
            ? `${file} is a draft: the helper has not finished (every bullet reads "unverified"). Nothing recorded. Run \`gate brief ${role}\` again and spawn a fresh helper for the same round.`
            : `${file} is unfinished: a section still reads "- unverified". Nothing recorded. Run \`gate brief ${role}\` again and spawn a fresh helper; its packet continues from the file.`);
        }
      }
      const same = (a, b) => String(a).toLowerCase().replace(/\s+/g, " ").trim() === String(b).toLowerCase().replace(/\s+/g, " ").trim();
      const { id, answered, added } = withLedger(ctx, (ledger, dir) => {
        // adding the same file again re-reads it into the same huddle instead of a new round
        let huddle = file ? ledger.huddles.find((h) => h.role === role && h.file === file) : null;
        if (!huddle) {
          const id = `H${ledger.huddles.length + 1}`;
          const round = ledger.huddles.filter((h) => h.role === role).length + 1;
          huddle = { id, role, round, file, summary: flag(rest, "--summary") ?? null, actOn: [], seq: nextSeq() };
          // set once, from the brief that named this file: a re-add never widens it
          const seen = ledger.seen?.[file];
          if (Array.isArray(seen?.files)) Object.assign(huddle, { files: seen.files, briefSeq: seen.seq, ...(seen.units ? { units: seen.units } : {}) });
          ledger.huddles.push(huddle);
        }
        const id = huddle.id;
        let answered = 0;
        const added = [];
        const text = file && existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), "utf8") : null;
        if (text !== null) {
          // every Act-on bullet becomes an item, so nothing can be left out (R15 checks the count).
          // Bullets are matched by their position in the file, so two findings that read alike
          // are both recorded; a bullet the model already recorded by hand with the same text
          // is claimed as that position instead of duplicated.
          parseFindings(text).forEach((f, i) => {
            if (huddle.actOn.some((a) => a.fileIndex === i)) return;
            const byHand = huddle.actOn.find((a) => a.fileIndex === undefined && same(a.text, f.text));
            if (byHand) {
              byHand.fileIndex = i;
              return;
            }
            const item = { id: `${id}.${huddle.actOn.length + 1}`, text: f.text, closed: null, fileIndex: i };
            huddle.actOn.push(item);
            added.push(item);
          });
          const item = (aid) => ledger.huddles.flatMap((h) => h.actOn).find((a) => a.id === aid);
          for (const d of parseDisputes(text)) {
            const a = item(d.id);
            if (!a || !a.dispute) continue;
            a.dispute.verdict = d.verdict;
            a.dispute.reviewerReason = d.reason;
            if (d.verdict === "withdrawn" && !a.closed) {
              a.closed = `withdrawn (${file})`;
              a.closedSeq = nextSeq();
            }
            answered += 1;
          }
          if (role === "arbiter") {
            for (const r of parseRuling(text)) {
              const a = item(r.id);
              if (!a || !a.dispute) continue;
              a.dispute.verdict = `arbiter:${r.side}`;
              a.dispute.arbiterReason = r.reason;
              if (r.side === "implementer" && !a.closed) {
                a.closed = `overruled (${file})`;
                a.closedSeq = nextSeq();
              }
              answered += 1;
            }
          }
        }
        return { id, answered, added };
      });
      ctx.out(`${id} added (${role})${added.length ? ` · ${added.length} Act-on item${added.length === 1 ? "" : "s"} recorded` : ""}${answered ? ` · ${answered} dispute${answered === 1 ? "" : "s"} answered` : ""}`);
      // the ids the worker and the reviewer will be asked about, next to what each one says
      for (const a of added) ctx.out(`${a.id} — ${a.text}`);
      printNext(ctx);
      return;
    }
    if (action === "dispute") {
      const [aid, ...words] = pos;
      const why = words.join(" ");
      const evidence = flag(rest, "--evidence");
      if (!aid || !why || !evidence) throw new UsageError('usage: gate huddle dispute <H#.#> "<why the finding is wrong>" --evidence <pointer> (evidence is required)');
      if (!pointerResolver(buildState(ctx, {}))(evidence)) throw new UsageError(`dispute evidence "${evidence}" does not resolve; point at a test (file:name), a file:line, ledger.md#<section>, verify.json, events#<seq> or a helper file`);
      withLedger(ctx, (ledger) => {
        const a = ledger.huddles.flatMap((h) => h.actOn).find((x) => x.id === aid);
        if (!a) throw new UsageError(`no act-on item ${aid}`);
        if (a.closed) throw new UsageError(`${aid} is already closed; nothing to dispute`);
        if (a.dispute) throw new UsageError(`${aid} was already disputed once; one round is the limit${a.dispute.verdict?.startsWith("arbiter:") ? " and the arbiter has ruled" : ""}`);
        a.dispute = { why, evidence, seq: nextSeq(), verdict: null };
      });
      ctx.out(`${aid} disputed — send it to the reviewer; its next file answers under ## Disputes (withdrawn or upheld)`);
      printNext(ctx);
      return;
    }
    if (action === "acton") {
      const [hid, ...words] = pos;
      const text = words.join(" ");
      if (!hid || !text) throw new UsageError('usage: gate huddle acton <H#> "<finding>"');
      const norm = (t) => String(t).toLowerCase().replace(/\s+/g, " ").trim();
      const id = withLedger(ctx, (ledger) => {
        const h = ledger.huddles.find((x) => x.id === hid);
        if (!h) throw new UsageError(`no huddle ${hid}`);
        const existing = h.actOn.find((a) => norm(a.text) === norm(text));
        if (existing) return existing.id; // already recorded from the file
        const id = `${hid}.${h.actOn.length + 1}`;
        h.actOn.push({ id, text, closed: null });
        return id;
      });
      ctx.out(`${id} recorded`);
    printNext(ctx);
      return;
    }
    if (action === "resolve") {
      const [aid] = pos;
      const evidence = flag(rest, "--evidence");
      if (!aid || !evidence) throw new UsageError("usage: gate huddle resolve <H#.#> --evidence <pointer>");
      if (!pointerResolver(buildState(ctx, {}))(evidence)) throw new UsageError(`resolve evidence "${evidence}" does not resolve; point at a test (file:name), a file:line, ledger.md#<section>, verify.json, events#<seq> or a helper file`);
      withLedger(ctx, (ledger) => {
        for (const h of ledger.huddles) {
          const item = h.actOn.find((a) => a.id === aid);
          if (item) {
            item.closed = evidence;
            item.closedSeq = nextSeq();
            return;
          }
        }
        throw new UsageError(`no act-on item ${aid}`);
      });
      ctx.out(`${aid} resolved`);
    printNext(ctx);
      return;
    }
    if (action === "reply") {
      const file = flag(rest, "--file");
      if (!file || !/^worker-\d+\.md$/.test(file)) throw new UsageError("usage: gate huddle reply --file worker-<n>.md (the worker's own file in the run dir)");
      const { dir } = open(ctx);
      if (!existsSync(path.join(dir, file))) throw new UsageError(`gate huddle reply: ${file} does not exist in the run dir; the worker must write it first`);
      const text = readFileSync(path.join(dir, file), "utf8");
      const replies = parseReplies(text);
      const shape = "'H<k>.<i> — fixed: <ptr>' or 'H<k>.<i> — disagree: <why> — <ptr>'";
      if (!replies.length) throw new UsageError(`${file} has no '## Replies' lines of the form ${shape}`);
      const bulletCount = parseFindings(text.replace(/^## Replies\s*$/m, "## Act on")).length;
      if (bulletCount > replies.length) throw new UsageError(`${file}: ${bulletCount - replies.length} line(s) under ## Replies do not read ${shape}; every bullet must be a reply`);
      const resolves = pointerResolver(buildState(ctx, {}));
      const lines = [];
      withLedger(ctx, (ledger) => {
        const items = ledger.huddles.flatMap((h) => h.actOn);
        // validate every line first, so a bad reply changes nothing
        for (const r of replies) {
          const a = items.find((x) => x.id === r.id);
          if (!a) throw new UsageError(`no act-on item ${r.id} (open: ${items.filter((x) => !x.closed).map((x) => x.id).join(", ") || "none"})`);
          if (a.closed) continue;
          // a fix is shown by a test, a source line, verify.json or an event, never by the
          // worker's own reply file or a packet
          if (r.kind === "fixed" && (/^(?:worker|brief)-/.test(r.pointer) || !resolves(r.pointer))) throw new UsageError(`${r.id} fixed: pointer "${r.pointer}" does not resolve; point at a test (file:name), a file:line, ledger.md#<section>, verify.json or events#<seq>`);
          if (r.kind === "disagree" && (!r.pointer || /^(?:worker|brief)-/.test(r.pointer) || !resolves(r.pointer))) throw new UsageError(`${r.id} disagree: needs a pointer that resolves after the reason (… — <ptr>), not the worker's own file`);
          if (r.kind === "disagree" && a.dispute) throw new UsageError(`${r.id} was already disputed once; one round is the limit${a.dispute.verdict?.startsWith("arbiter:") ? " and the arbiter has ruled" : ""}`);
        }
        for (const r of replies) {
          const a = items.find((x) => x.id === r.id);
          if (a.closed) {
            lines.push(`${r.id} already closed (${a.closed}); reply ignored`);
          } else if (r.kind === "fixed") {
            Object.assign(a, { closed: r.pointer, closedSeq: nextSeq(), closedBy: file });
            lines.push(`${r.id} fixed [${r.pointer}]`);
          } else {
            a.dispute = { why: r.why, evidence: r.pointer, seq: nextSeq(), verdict: null, by: file };
            lines.push(`${r.id} disputed — the reviewer's next file answers under ## Disputes`);
          }
        }
      });
      for (const l of lines) ctx.out(l);
      printNext(ctx);
      return;
    }
    throw new UsageError("usage: gate huddle add|acton|resolve|dispute|reply ...");
  },

  waive(ctx) {
    const [key, ...words] = ctx.args;
    const reason = words.join(" ").trim();
    if (!key || !reason) throw new UsageError('usage: gate waive <stepKey|R#> "<why, with the user\'s OK>"');
    withLedger(ctx, (ledger) => {
      ledger.waivers.push({ key, reason, seq: nextSeq() });
      const step = ledger.steps.find((s) => s.key === key);
      if (step) Object.assign(step, { state: "WAIVED", note: reason, evidence: null, seq: nextSeq() });
    });
    ctx.out(`waived ${key} — the report will show the reason`);
    printNext(ctx);
  },

  decide(ctx) {
    const cells = ctx.args;
    if (cells.length !== 5) throw new UsageError("usage: gate decide <phase> <decision> <why> <evidence> <result>");
    const { dir } = open(ctx);
    const file = path.join(dir, "decisions.tsv");
    if (!existsSync(file)) writeFileSync(file, "ts\tphase\tdecision\twhy\tevidence\tresult\n");
    const clean = (v) => {
      const s = String(v).replace(/[\t\r\n]+/g, " ");
      return /^[=+\-@]/.test(s) ? `'${s}` : s;
    };
    appendFileSync(file, `${new Date().toISOString()}\t${cells.map(clean).join("\t")}\n`);
    ctx.out("decision logged");
    printNext(ctx);
  },

  // The user gives up on a task: the ledger is marked abandoned with the reason, so it no
  // longer attaches to later sessions or blocks their turns. Nothing is finalised: the
  // baseline stays, so the next ledger still sees the changes this one left behind.
  abandon(ctx) {
    const [slug, ...rest] = positional(ctx.args);
    const reason = rest.join(" ").trim();
    if (!slug || !reason) throw new UsageError('usage: gate abandon <slug> "<reason>"');
    const found = findRun(ctx.stateDir, slug);
    if (!found) throw new UsageError(`no open run for slug "${slug}" (a closed or abandoned run cannot be abandoned)`);
    const { dir, ledger } = found;
    ledger.status = "abandoned";
    ledger.abandonedAt = new Date().toISOString();
    ledger.abandonReason = reason;
    ledger.abandonedBy = ctx.session;
    saveLedger(dir, ledger);
    const name = path.basename(dir);
    const session = loadSession(ctx.stateDir, ctx.session);
    if (session) saveSession(ctx.stateDir, { ...session, current: session.current === name ? null : session.current, lastClosed: name });
    writeReport(ctx, dir, ledger);
    ctx.out(`${ledger.slug} abandoned — ${reason}`);
    ctx.out(`report: ${path.join(dir, "report.md")}`);
  },

  // The run closes here and now, not at the next stop: a lead that opens the next task in
  // the same turn would otherwise leave it half-closed. Not clean: nothing changes.
  close(ctx) {
    withLedger(ctx, (ledger) => markStep(ledger, "close", { state: "DONE", evidence: "report.md", note: "closed" }));
    const { state, unmet } = assess(ctx, {});
    if (unmet.length) {
      withLedger(ctx, (ledger) => {
        const step = ledger.steps.find((s) => s.key === "close");
        if (step?.note === "closed") Object.assign(step, { state: null, note: null, evidence: null, seq: null });
      });
      unmet.forEach((u, i) => ctx.out(`${i + 1}. ${u.rule} — ${u.text}`));
      throw new UsageError(`not closed: ${unmet.length} unmet`);
    }
    const ledger = finalise(ctx, state);
    ctx.out(`${ledger.slug} closed`);
    ctx.out("next: `gate report --brief`, pasted as your final message");
  },
};
