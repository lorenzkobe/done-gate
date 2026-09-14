import { createHash } from "node:crypto";
import { lintClaims, pointerResolver } from "./claims.mjs";
import { runChecks } from "./checks.mjs";

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
function lastEditSeq(state, config, ledger) {
  const edits = (state.events ?? []).filter((e) => e.kind === "edit" && !e.agent && e.path && config.isSource(e.path));
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
  return (ledger.waivers ?? []).some((w) => w.key === key && w.found !== false);
}

// Which of Plan and case table came after the first source edit of this task, if any:
// { late: ["Plan", "case table"], path: "<first edited file>" } or { late: [], path: null }.
export function lateOrder(state) {
  const { config, ledger } = state;
  const none = { late: [], path: null };
  if (!ledger) return none;
  const firstEdit = (state.events ?? []).find((e) => e.kind === "edit" && !e.agent && e.path && config.isSource(e.path) && e.seq > (ledger.baseline?.seq ?? 0));
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
        text: `source changed (${list(src)}) but no test file changed. Have QA write tests for the case table, or get the user's waiver (\`gate waive qa "<their words>"\`).`,
      });
    }
  }

  const after = lastEditSeq(state, config, ledger);

  // R4: UI changed → the real surface was driven after the last edit
  if (changed.some((p) => config.isUi(p)) && !waived(ledger, "driver")) {
    const driven = (state.events ?? []).some((e) => !e.agent && e.seq > after && (e.kind === "browser" || (e.kind === "skill" && e.skill === "verify")));
    if (!driven) {
      unmet.push({ rule: "R4", text: config.driver
        ? "UI files changed but the real surface was not driven after the last edit. Run the project's /verify driver (phone viewport first), or get the user's waiver (`gate waive driver \"<their words>\"`)."
        : "UI files changed and this repo has no /verify driver. Run `/done-gate:verify-setup` once to create it, drive the surface, or get the user's waiver (`gate waive driver \"<their words>\"`)." });
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
    unmet.push({ rule: "R13", text: ".claude/gate.json changed since this ledger opened. Restore it, or get the user's waiver (`gate waive gate-config \"<their words>\"`)." });
  }
  if (ledger.policyHash && state.policy?.hash && state.policy.hash !== ledger.policyHash && !waived(ledger, "gate-config")) {
    unmet.push({ rule: "R13", text: "the plugin's models.json (tier policy) changed since this ledger opened. Restore it, or get the user's waiver (`gate waive gate-config \"<their words>\"`)." });
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
  const badBlast = (ledger.blast ?? []).filter((b) => !(b.rung >= 1 && b.rung <= 5));
  if (badBlast.length) unmet.push({ rule: "R8", text: "a blast-radius fact has no rung." });

  // R14: the task outgrew its predicted tier and a reopened step is still blank
  const reopened = (ledger.tier?.reopened ?? []).filter((k) => (ledger.steps ?? []).some((s) => s.key === k && !s.state));
  if (reopened.length) {
    const m = state.tier?.measured;
    const todo = { skeptic: "spawn the skeptic", reconcile: "run the QA reconcile round" };
    unmet.push({
      rule: "R14",
      text: `tier grew from ${ledger.tier.predicted ?? "unpredicted"} to ${m?.tier ?? "standard"}${m ? ` (${m.files} files, ${m.lines} lines)` : ""}: step(s) ${reopened.map((k) => `{${k}}`).join(", ")} reopened; ${reopened.map((k) => todo[k] ?? `do {${k}}`).join(", then ")}, then close with evidence.`,
    });
  }

  // R11: claims carry labels, and [measured] pointers resolve
  const resolves = pointerResolver(state);
  const findings = [...lintClaims(state.lastMessage, resolves), ...lintClaims(state.ledgerMd ?? "", resolves)];
  if (findings.length) {
    const f = findings[0];
    unmet.push({ rule: "R11", text: f.kind === "unlabelled"
      ? `unlabelled claim: "${f.line.slice(0, 80)}". Every verification claim carries [measured] (pointer), [inferred] or [guess].`
      : `[measured] pointer does not resolve: "${f.pointer}" in "${f.line.slice(0, 80)}".` });
  }

  // R12: a waiver the user never said
  for (const w of ledger.waivers ?? []) {
    if (w.found === false) unmet.push({ rule: "R12", text: `waiver for ${w.key} quotes "${w.quote}" but no user message in the transcript says that. Ask the user with AskUserQuestion and record their actual words.` });
  }

  return unmet;
}
