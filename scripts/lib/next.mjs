import { currentLedger } from "./ledger.mjs";
import { optionalSteps, tiered } from "./size.mjs";

// One line after every verb: what to do next and the exact verb. The skill no longer has
// to spell the workflow out, and the model no longer has to remember it.

const VERB_FOR = {
  read: "read the affected code, then `gate step read done \"<what you saw>\" --evidence <file>`",
  repro: "reproduce on the real surface, then `gate step repro done \"<what failed>\" --evidence <ptr>`",
  rootcause: "find the root cause with runtime evidence, then `gate step rootcause done \"<cause>\" --evidence <file:line>`",
  skeptic: "`gate brief skeptic`, spawn done-gate:skeptic with the prompt it prints (it writes skeptic-<n>.md and replies with its Act-on list), then `gate huddle add skeptic --file skeptic-<n>.md`, answer each item, and `gate step skeptic done … --evidence skeptic-<n>.md`",
  qa: "`gate brief qa`, spawn done-gate:qa with the prompt it prints, then `gate step qa done … --evidence <test file>`",
  implement: "implement, keeping the diff to the plan, then `gate step implement done \"…\" --evidence <file>`",
  reconcile: "reconcile with QA (code-wrong, test-wrong, or ask the user), close each case with `gate case close C<n> --test <file:name>`, then `gate step reconcile done … --evidence <test file>`",
  verify: "`gate verify`",
  "verify-before": "`gate verify --step verify-before`",
  driver: "drive the real surface yourself (phone viewport first), then `gate decide driver …` and `gate step driver done … --evidence decisions#<n>` (or `na` when no UI changed); never ask for a waiver here to save time",
  schema: "probe the real schema yourself, then `gate step schema done \"<what you ran>\" --evidence <ptr>` (or `na` when no schema file changed); never ask for a waiver here to save time",
  cleanup: "sweep dead code and duplication, then `gate step cleanup done \"…\" --evidence <file>`",
  review: "`gate brief reviewer`, spawn done-gate:reviewer with the prompt it prints, then `gate huddle add reviewer --file review-<n>.md`, one `gate huddle acton` per Act-on item, fix, `gate huddle resolve`, then `gate step review done … --evidence review-<n>.md`; you own the diff and the summary, the reviewer's file is embedded as it wrote it; a finding you believe is wrong: `gate huddle dispute H<k>.<i> \"<why>\" --evidence <ptr>`, one round with the reviewer, and if it upholds, `gate brief arbiter --item H<k>.<i>` and spawn done-gate:arbiter",
  docs: "update docs and CLAUDE.md if the next assistant must know something, then `gate step docs done|na …`",
  close: "`gate close`",
};

export function nextHint(ledger) {
  if (!ledger || ledger.status === "closed") return "";
  if (ledger.status === "closing") return "next: `gate check`; when it prints clean, `gate report --brief` and paste it as your final message";
  if (!ledger.taskSeq) return "next: `gate note task \"<the user's ask, quoted, then your own words>\"`";
  if (!ledger.planSeq) return "next: `gate note plan \"<approach, files, data plan>\" --files a.ts,b.ts`";
  if (tiered(ledger) && !ledger.cases.length) return "next: `gate case add \"<case>\" --kind happy|edge|refused|boundary|idempotent|reported-surface`, one per row";
  const blank = ledger.steps.filter((s) => !s.state);
  const step = blank[0];
  const open = ledger.cases.filter((c) => c.status !== "closed");
  const closeCases = `next: close ${open.map((c) => c.id).join(", ")} with \`gate case close C<n> --test <file:name>\` or \`--na "<reason>"\``;
  // open cases come before the close step: closing with a blank case would only bounce off R8
  if (open.length && (!step || step.key === "close")) return closeCases;
  if (step) {
    const how = step.key ? VERB_FOR[step.key] : null;
    return `next: step ${step.n}: ${how ?? `${step.text} then \`gate step ${step.n} done|skipped|na "…"\``}`;
  }
  return "next: `gate close`";
}

export function printNext(ctx) {
  try {
    const current = currentLedger(ctx.stateDir, ctx.session);
    const hint = nextHint(current?.ledger ?? null);
    if (hint) ctx.out(hint);
  } catch {
    // a hint is a courtesy; never turn a successful verb into a failure
  }
}

export { optionalSteps };
