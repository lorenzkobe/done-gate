import { currentLedger, isDone } from "./ledger.mjs";
import { optionalSteps, tiered } from "./size.mjs";

// One line after every verb: what to do next and the exact verb. The skill no longer has
// to spell the workflow out, and the model no longer has to remember it.

const VERB_FOR = {
  read: "read the affected code, then `gate step read done \"<what you saw>\" --evidence <file>`",
  context: "understand first: trace the code the task touches (entry points, callers, data flow; `grep -a` for callers), list what depends on it, and research better ways when the problem is a known one (docs, context7, web); then `gate note context \"Traced: <file:line pointers> · Related: <what depends on it> · Research: <what you looked up, or none needed: why>\"` (each part on its own line)",
  repro: "reproduce on the real surface, then `gate step repro done \"<what failed>\" --evidence <ptr>`",
  rootcause: "find the root cause with runtime evidence, then `gate step rootcause done \"<cause>\" --evidence <file:line>`",
  skeptic: "`gate brief skeptic`, spawn done-gate:skeptic with the prompt it prints (it writes skeptic-<n>.md and replies with its Act-on list), then `gate huddle add skeptic --file skeptic-<n>.md`, answer each item, and `gate step skeptic done … --evidence skeptic-<n>.md`",
  tests: "write the tests from the case table before the code, one per case, and run them red; then `gate step tests done \"<red output, trimmed>\" --evidence <test file>`; at size large `gate brief qa` and spawn done-gate:qa instead",
  qa: "`gate brief qa`, spawn done-gate:qa with the prompt it prints, then `gate step qa done … --evidence <test file>`",
  implement: "implement, keeping the diff to the plan; where the tests and the code disagree, decide code-wrong, test-wrong or ask the user, close each case with `gate case close C<n> --test <file:name>`, then `gate step implement done \"…\" --evidence <file>`",
  verify: "`gate verify`, run with a Bash timeout of 600000 ms, or in the background (run_in_background) when the commands' own timeouts (`gate doctor` prints them) add up to more; lint, test and build can take minutes, and a killed run writes no verify.json",
  "verify-before": "`gate verify --step verify-before`, run with a Bash timeout of 600000 ms, or in the background when the commands' timeouts add up to more",
  driver: "drive the real surface yourself (phone viewport first), then `gate decide driver …` and `gate step driver done … --evidence decisions#<n>` (or `na` when no UI changed); never ask for a waiver here to save time",
  schema: "probe the real schema yourself, then `gate step schema done \"<what you ran>\" --evidence <ptr>` (or `na` when no schema file changed); never ask for a waiver here to save time",
  review: "the loop: `gate brief reviewer`, spawn done-gate:reviewer with the prompt it prints, `gate huddle add reviewer --file review-<n>.md`; at small and standard fix the items yourself and `gate huddle resolve H<k>.<i> --evidence <ptr>` (or `gate huddle dispute`); at size large `gate brief worker`, SendMessage the worker the review file's path (or spawn done-gate:worker with the prompt), then `gate huddle reply --file worker-<n>.md` when it answers (fixed: closes, disagree: disputes); repeat with the same reviewer (SendMessage it the next packet) until a round comes back clean, at most three rounds (after a clean or third round, edits to files it saw need no new round; a new file does); what is still disputed after round three goes to `gate brief arbiter --item H<k>.<i>` and done-gate:arbiter; then `gate step review done … --evidence review-<n>.md`; you own the diff and the summary, the reviewer's file is embedded as it wrote it",
  close: "`gate close`",
};

export function nextHint(ledger) {
  if (!ledger || isDone(ledger)) return "";
  if (ledger.status === "closing") return "next: `gate check`; when it prints clean, `gate report --brief` and paste it as your final message";
  if (!ledger.taskSeq) return "next: `gate note task \"<the user's ask, quoted, then your own words>\"`";
  if (!ledger.planSeq) {
    // the steps before {plan} (understand first: context; for a bugfix repro and root cause
    // before it) come before the plan itself
    const planAt = ledger.steps.findIndex((s) => s.key === "plan");
    const before = ledger.steps.slice(0, planAt < 0 ? ledger.steps.length : planAt).find((s) => !s.state && s.key && s.key !== "read" && VERB_FOR[s.key]);
    if (before) return `next: step ${before.n}: ${VERB_FOR[before.key]}`;
    return "next: `gate note plan \"<approach, files, data plan>\" --files a.ts,b.ts`";
  }
  if (tiered(ledger) && !ledger.cases.length) return "next: `gate case add \"<case>\" --kind happy|edge|refused|boundary|idempotent|reported-surface|performance`, one per row";
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
