import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { leadDelegates } from "./size.mjs";

// Named repo checks, opted into via gate.json "checks". Each returns an unmet text or null.
const CHECKS = {
  "claude-md-budget": ({ root, changed }) => {
    const file = path.join(root, "CLAUDE.md");
    if (!existsSync(file)) return null;
    if (!changed.includes("CLAUDE.md")) return null;
    const size = statSync(file).size;
    return size > 150_000 ? `CLAUDE.md is ${size} chars, over the 150000 budget an assistant can load. Move detail into the linked docs before closing.` : null;
  },
  "migration-number": ({ root, changed }) => {
    const added = changed.filter((p) => /^supabase\/migrations\/\d{4}_.*\.sql$/.test(p));
    if (!added.length) return null;
    const dir = path.join(root, "supabase", "migrations");
    const max = Math.max(...readdirSync(dir).map((f) => Number(/^(\d{4})_/.exec(f)?.[1] ?? 0)));
    const claude = path.join(root, "CLAUDE.md");
    if (!existsSync(claude)) return null;
    const m = /Next number:\s*`?(\d{4})`?/.exec(readFileSync(claude, "utf8"));
    if (!m) return "CLAUDE.md has no `Next number:` line for migrations.";
    const expected = String(max + 1).padStart(4, "0");
    return m[1] === expected ? null : `migration ${String(max).padStart(4, "0")} was added but CLAUDE.md says the next number is ${m[1]}; it should say ${expected}.`;
  },
};

export function runChecks({ config, root, changed }) {
  const out = [];
  for (const name of config.checks ?? []) {
    const fn = CHECKS[name];
    if (!fn) {
      out.push(`unknown check "${name}" in gate.json (have: ${Object.keys(CHECKS).join(", ")})`);
      continue;
    }
    try {
      const text = fn({ root, changed });
      if (text) out.push(`${name}: ${text}`);
    } catch (error) {
      out.push(`${name} could not run: ${error.message}`);
    }
  }
  return out;
}

// Readers for the files helpers write: a reviewer's or skeptic's findings, a reviewer's
// answers to disputes, and an arbiter's ruling. Bullets only; prose is ignored.

function sectionLines(text, heading) {
  const re = new RegExp(`^## ${heading}\\s*$`, "m");
  const m = re.exec(String(text ?? "").replace(/\r/g, ""));
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length);
  const end = /^## /m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).split("\n");
}

function bullets(lines) {
  const out = [];
  for (const raw of lines) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    // "none", "none.", "none found", "nothing to act on": an empty section, not a finding
    if (/^(?:none|n\/a|nothing)\b[\s.,;:!-]*(?:found|to act on|here|so far)?[\s.]*$/i.test(m[1].trim())) continue;
    out.push(m[1].trim());
  }
  return out;
}

// Every Act-on bullet of a helper file. "none" and a missing section are empty.
export function parseFindings(text) {
  return bullets(sectionLines(text, "Act on")).map((t) => ({ text: t }));
}

const VERDICT = /^(H\d+\.\d+)\s*[—–-]+\s*(withdrawn|upheld)\s*:\s*(.*)$/i;

// A reviewer's answers to disputed items: `- H1.2 — withdrawn: reason` / `upheld: reason`.
export function parseDisputes(text) {
  const out = [];
  for (const b of bullets(sectionLines(text, "Disputes"))) {
    const m = VERDICT.exec(b);
    if (m) out.push({ id: m[1], verdict: m[2].toLowerCase(), reason: m[3].trim() });
  }
  return out;
}

const REPLY = /^(H\d+\.\d+)\s*[—–-]+\s*(fixed|disagree)\s*:\s*(.*)$/i;

// A worker's answers to review findings: `- H1.2 — fixed: <pointer>` or
// `- H1.2 — disagree: <why> — <pointer>`.
export function parseReplies(text) {
  const out = [];
  for (const b of bullets(sectionLines(text, "Replies"))) {
    const m = REPLY.exec(b);
    if (!m) continue;
    if (m[2].toLowerCase() === "fixed") {
      out.push({ id: m[1], kind: "fixed", pointer: m[3].trim() });
    } else {
      const parts = m[3].split(/\s+[—–-]+\s+/);
      const pointer = parts.length > 1 ? parts.pop().trim() : null;
      out.push({ id: m[1], kind: "disagree", why: parts.join(" — ").trim(), pointer });
    }
  }
  return out;
}

const RULING = /^(H\d+\.\d+)\s*[—–-]+\s*(implementer|reviewer)\s*:\s*(.*)$/i;

// An arbiter's ruling: `- H1.2 — implementer: reason` / `reviewer: reason`.
export function parseRuling(text) {
  const out = [];
  for (const b of bullets(sectionLines(text, "Ruling"))) {
    const m = RULING.exec(b);
    if (m) out.push({ id: m[1], side: m[2].toLowerCase(), reason: m[3].trim() });
  }
  return out;
}

// Builds the "does this pointer resolve" predicate from gate state; dispute and resolve
// evidence must point at something real.
export function pointerResolver(state) {
  return (ptr) => {
    if (!ptr) return false;
    if (ptr === "ledger.md" || ptr === "ledger.json" || ptr === "report.md" || ptr === "decisions.tsv") return true;
    if (/^ledger\.(md|json)#/.test(ptr)) return true;
    if (ptr === "verify.json" || /^verify#\d+$/.test(ptr)) return Boolean(state.verify);
    if (/^events#\d+$/.test(ptr)) {
      const seq = Number(ptr.slice(7));
      return (state.events ?? []).some((e) => e.seq === seq);
    }
    if (/^(?:review|skeptic|arbiter)-\d+\.md$/.test(ptr)) return (state.reviews ?? []).includes(ptr);
    if (/^worker-\d+\.md$/.test(ptr)) return Boolean(state.dir) && existsSync(path.join(state.dir, ptr));
    if (/^decisions#\d+$/.test(ptr)) {
      // the row must exist: decisions.tsv has a header line, then one row per decision
      const file = state.dir ? path.join(state.dir, "decisions.tsv") : null;
      if (!file || !existsSync(file)) return false;
      const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length - 1;
      return Number(ptr.slice(10)) >= 1 && Number(ptr.slice(10)) <= rows;
    }
    const file = ptr.split(":")[0];
    return [state.dir, state.root].filter(Boolean).some((base) => existsSync(path.join(base, file)));
  };
}

// Hash of the SOURCE files in a snapshot. verify.json stores it, so a docs or ledger
// edit after `gate verify` does not force a re-run, but any source edit does.
export function sourceHash(snap, config) {
  const digest = createHash("sha1");
  for (const rel of Object.keys(snap?.files ?? {}).sort()) {
    if (config.isSource(rel)) digest.update(`${rel}\0${snap.files[rel].h}\n`);
  }
  return digest.digest("hex");
}

// Source minus tests: the freshness clock for R4/R5. QA's test files move the source hash
// (tests are source) but are agent work, which the "last edit" has always excluded.
export function implementationHash(snap, config) {
  const digest = createHash("sha1");
  for (const rel of Object.keys(snap?.files ?? {}).sort()) {
    if (config.isSource(rel) && !config.isTest(rel)) digest.update(`${rel}\0${snap.files[rel].h}\n`);
  }
  return digest.digest("hex");
}

function list(paths, max = 3) {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown}, +${paths.length - max} more` : shown;
}

export function isRole(agentType, role) {
  return agentType === `done-gate:${role}` || agentType === role;
}

// The last moment source changed: the newest Edit/Write event by the main session, or the
// moment the source hash moved (edits made with sed, perl or git apply leave no tool event).
// An implementation edit: a source edit by anyone but QA (the lead, a worker, or any other
// agent the lead spawned). QA's test edits and helper file writes are not implementation.
export function implementationEdit(e, config) {
  return e.kind === "edit" && Boolean(e.path) && config.isSource(e.path) && !isRole(e.agentType, "qa");
}

export function lastEditSeq(state, config, ledger) {
  const edits = (state.events ?? []).filter((e) => implementationEdit(e, config));
  const fromEvents = edits.length ? edits[edits.length - 1].seq : (ledger.baseline?.seq ?? 0);
  return Math.max(fromEvents, ledger.lastSourceChangeSeq ?? 0);
}

function reviewed(state, role, after) {
  const stopped = (state.events ?? []).some((e) => e.kind === "subagent-stop" && isRole(e.agentType, role) && e.seq > after);
  const huddles = (state.ledger.huddles ?? []).filter((h) => h.role === role && h.file && (state.reviews ?? []).includes(h.file));
  const openItems = huddles.flatMap((h) => h.actOn.filter((a) => !a.closed));
  return { stopped, hasFile: huddles.length > 0, openItems };
}

function waived(ledger, key) {
  return (ledger.waivers ?? []).some((w) => w.key === key);
}

// Which of Plan and case table came after the first source edit of this task, if any:
// { late: ["Plan", "case table"], path: "<first edited file>" } or { late: [], path: null }.
export function lateOrder(state) {
  const { config, ledger } = state;
  const none = { late: [], path: null };
  if (!ledger) return none;
  const firstEdit = (state.events ?? []).find((e) => implementationEdit(e, config) && e.seq > (ledger.baseline?.seq ?? 0));
  if (!firstEdit) return none;
  const firstCase = ledger.cases?.[0]?.seq ?? Infinity;
  const late = [];
  if (!(ledger.planSeq < firstEdit.seq)) late.push("Plan");
  if (!(firstCase < firstEdit.seq)) late.push("case table");
  return { late, path: firstEdit.path };
}

// Pure: state in, unmet rules out. Every item says what to do next.
export function evaluate(state) {
  const { config, ledger, changed, now, verify } = state;
  const unmet = [];
  const src = changed.filter((p) => config.isSource(p));

  const checkFailures = runChecks({ config, root: state.root, changed });
  for (const text of checkFailures) unmet.push({ rule: "R10", text });

  if (!ledger) {
    if (src.length) {
      unmet.push({
        rule: "R1",
        text: `source changed (${list(src)}) but no ledger is open for this session. Run \`gate open <slug> <feature|bugfix|refactor|plan>\` (or \`gate attach <slug>\`), write Task, Plan and the case table, then continue.`,
      });
    }
    return unmet;
  }

  if (src.length) {
    if (!verify) {
      unmet.push({ rule: "R3", text: "no verify.json for this run. Run `gate verify` after your last source edit." });
    } else {
      const red = (verify.commands ?? []).filter((c) => !c.skipped && (c.exit !== 0 || c.timedOut));
      if (red.length) {
        unmet.push({
          rule: "R3",
          text: `verify is red: ${red.map((c) => `\`${c.cmd}\` ${c.timedOut ? "timed out" : `exit ${c.exit}`}`).join("; ")}. Fix, then run \`gate verify\` again.`,
        });
      } else if (verify.sourceHash !== sourceHash(now, config)) {
        unmet.push({ rule: "R3", text: "verify.json is stale: source changed after the last `gate verify`. Run it again." });
      }
    }

    if (!changed.some((p) => config.isTest(p)) && !waived(ledger, "qa")) {
      unmet.push({
        rule: "R7",
        text: `source changed (${list(src)}) but no test file changed. Have QA write tests for the case table, or get the user's waiver (\`gate waive qa "<reason>"\`).`,
      });
    }
  }

  const after = lastEditSeq(state, config, ledger);

  // R4: UI changed → the real surface was driven after the last edit
  if (changed.some((p) => config.isUi(p)) && !waived(ledger, "driver")) {
    const driven = (state.events ?? []).some((e) => !e.agent && e.seq > after && (e.kind === "browser" || (e.kind === "skill" && e.skill === "verify")));
    if (!driven) {
      unmet.push({ rule: "R4", text: config.driver
        ? "UI files changed but the real surface was not driven after the last edit. Run the project's /verify driver (phone viewport first), or get the user's waiver (`gate waive driver \"<reason>\"`)."
        : "UI files changed and this repo has no /verify driver. Run `/done-gate:verify-setup` once to create it, drive the surface, or get the user's waiver (`gate waive driver \"<reason>\"`)." });
    }
  }

  // R5: source changed → an independent reviewer looked after the last edit and every Act-on item is closed
  if (src.length && !waived(ledger, "review")) {
    const r = reviewed(state, "reviewer", after);
    if (!r.stopped || !r.hasFile) {
      unmet.push({ rule: "R5", text: "no reviewer pass after the last edit. Spawn `done-gate:reviewer` (it writes review-<n>.md), then `gate huddle add reviewer --file review-<n>.md`." });
    } else if (r.openItems.length) {
      unmet.push({ rule: "R5", text: `reviewer Act-on item(s) still open: ${r.openItems.map((a) => a.id).join(", ")}. Fix, then \`gate huddle resolve <id> --evidence <pointer>\`.` });
    }
  }

  // R6: schema changed → the real-schema probe happened
  if (changed.some((p) => config.isSchema(p)) && !waived(ledger, "schema")) {
    const step = (ledger.steps ?? []).find((s) => s.key === "schema");
    if (!step || step.state !== "DONE" || !step.evidence) {
      unmet.push({ rule: "R6", text: "schema files changed: run the new/changed reader once against the real database (hit the endpoint in dev, or run the query) and close the schema step with `gate step schema done \"<what you ran>\" --evidence <pointer>`. N/A is not allowed here." });
    }
  }

  // R9: high-risk paths → a second reviewer on a stronger model
  if (changed.some((p) => config.isHighRisk(p)) && !waived(ledger, "review-2")) {
    const r = reviewed(state, "reviewer-2", after);
    if (!r.stopped || !r.hasFile || r.openItems.length) {
      unmet.push({ rule: "R9", text: `high-risk paths changed (${list(changed.filter((p) => config.isHighRisk(p)))}): a second review by \`done-gate:reviewer-2\` is required after the last edit, with its review-<n>.md recorded via \`gate huddle add reviewer-2 --file ...\` and every Act-on item closed.` });
    }
  }

  // R13: the gate's own config changed mid-task
  if (ledger.gateHash && config.hash !== ledger.gateHash && !waived(ledger, "gate-config")) {
    unmet.push({ rule: "R13", text: ".claude/gate.json changed since this ledger opened. Restore it, or get the user's waiver (`gate waive gate-config \"<reason>\"`)." });
  }
  if (ledger.policyHash && state.policy?.hash && state.policy.hash !== ledger.policyHash && !waived(ledger, "gate-config")) {
    unmet.push({ rule: "R13", text: "the plugin's models.json (tier policy) changed since this ledger opened. Restore it, or get the user's waiver (`gate waive gate-config \"<reason>\"`)." });
  }

  // R2: plan and case table must predate the first source edit this task. Blocks only while
  // a Plan or a case is missing altogether; a late order is recorded (lateOrder) and shown in
  // the report, since the model cannot travel back to write them earlier.
  const { late, path: firstPath } = lateOrder(state);
  if (late.length) {
    const missing = [];
    if (!ledger.planSeq) missing.push("Plan");
    if (!ledger.cases?.length) missing.push("case table");
    if (missing.length) {
      unmet.push({ rule: "R2", text: `${late.join(" and ")} written after the first source edit (${firstPath}). Write the ${missing.join(" and ")} now; the late order is recorded in the report.` });
    }
  }

  // R8: nothing blank
  const openCases = (ledger.cases ?? []).filter((c) => c.status !== "closed" || (!c.test && !c.na));
  if (openCases.length) unmet.push({ rule: "R8", text: `case(s) not closed: ${openCases.map((c) => c.id).join(", ")}. \`gate case close <id> --test <file:name>\` or \`--na <reason>\`.` });
  const blankSteps = (ledger.steps ?? []).filter((s) => !s.state);
  if (blankSteps.length) unmet.push({ rule: "R8", text: `step(s) blank: ${blankSteps.map((s) => `${s.n}${s.key ? ` {${s.key}}` : ""}`).join(", ")}. Close each with \`gate step <n|key> done|skipped|na "<note>"\`.` });

  // R16: at a size where the lead delegates, the lead's own source edits after the plan are a
  // worker's job. The fence stops the edit tools; this catches what slipped past it.
  const delegated = waived(ledger, "delegate") ? null : leadDelegates(ledger, state.policy ?? undefined);
  if (delegated) {
    const since = ledger.tier?.predictedSeq ?? ledger.planSeq ?? 0;
    // the lead's own edit-tool calls, or those of any agent that is not a worker
    const own = (state.events ?? []).filter((e) => implementationEdit(e, config) && !isRole(e.agentType, "worker") && e.seq > since);
    if (own.length) {
      unmet.push({ rule: "R16", text: `the lead edited ${list([...new Set(own.map((e) => e.path))])} at size ${delegated}; hand that piece to a worker (\`gate brief worker\`, spawn done-gate:worker) and let it own the file from here.` });
    }
    // source changed with no edit-tool event to explain it: a shell edit, unless the last
    // shell command was a worker's, whose shell edits are its own business
    const shell = (ledger.unexplainedChanges ?? []).filter((c) => c.seq > since && !isRole(c.agentType, "worker"));
    if (shell.length) {
      const last = shell[shell.length - 1];
      unmet.push({ rule: "R16", text: `source changed with no worker edit behind it (${last.cmd ? `after \`${String(last.cmd).slice(0, 60)}\`` : "a shell edit"}) at size ${delegated}; at this size only workers edit source. Hand the piece to a worker (\`gate brief worker\`).` });
    }
  }

  // R15: every Act-on finding in a helper file is recorded from the file (hand-typed items do
  // not count toward it), and every helper file in the run dir belongs to a huddle.
  for (const h of ledger.huddles ?? []) {
    if (!h.file || !state.dir) continue;
    const file = path.join(state.dir, h.file);
    if (!existsSync(file)) continue;
    const listed = parseFindings(readFileSync(file, "utf8")).length;
    const fromFile = h.actOn.filter((a) => typeof a.fileIndex === "number").length;
    if (listed > fromFile) {
      unmet.push({ rule: "R15", text: `${h.file} lists ${listed} Act-on finding(s) but ${h.id} records ${fromFile} from the file. Run \`gate huddle add ${h.role} --file ${h.file}\` again; it records every bullet.` });
    }
  }
  const recorded = new Set((ledger.huddles ?? []).map((h) => h.file).filter(Boolean));
  for (const f of state.reviews ?? []) {
    if (!recorded.has(f)) {
      const role = f.startsWith("review-") ? "reviewer" : f.startsWith("skeptic-") ? "skeptic" : "arbiter";
      unmet.push({ rule: "R15", text: `${f} was written but never recorded. Run \`gate huddle add ${role} --file ${f}\`.` });
    }
  }

  return unmet;
}
