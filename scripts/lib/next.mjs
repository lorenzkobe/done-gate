import { currentLedger, isDone, saveLedger } from "./ledger.mjs";
import { optionalSteps, policyFor, tiered } from "./size.mjs";
import { loadConfig } from "./config.mjs";
import { readEvents } from "./events.mjs";
import { clickStale, driverCommand, lastEditSeq, newRules } from "./rules.mjs";
import { UsageError } from "./context.mjs";

// One line after every verb: what to do next and the exact verb. The skill no longer has
// to spell the workflow out, and the model no longer has to remember it.

const VERB_FOR = {
  context: "understand first: search the code and memory yourself before grep (e.g. SocratiCode `codebase_search`, MemPalace `mempalace_search`; load deferred tools with ToolSearch; a search or query call counts (symbol, impact, flow, find and follow too), a list, status, read or get does not; lookups only, confirm a hit with grep or Read; run `codebase_update` once if the index watcher is not active), trace the code the task touches (entry points, callers, data flow; `grep -a` for callers), list what depends on it, and research better ways when the problem is a known one (docs, context7, web); then `gate note context \"Traced: <file:line pointers> · Related: <what depends on it> · Research: <what you looked up, or none needed: why>\"` (the parts on one line with · between them, or one per line; add `--no-code \"<tool>: not installed|not indexed\"` or `--no-memory \"<tool>: not installed|not indexed\"` when a tool is missing or the project is not indexed: tell the user, ask whether to go on without it, and add \`--user-ok \"<their words>\"\`)",
  repro: "reproduce on the real surface (run it: the Bash tool, the browser or the /verify driver), then `gate step repro done \"<what failed>\" --ran \"<part of the command or url>\"`; it closes on the recorded run, not on a note",
  rootcause: "find the root cause with runtime evidence (\"might help\" is a hypothesis, not a fix): run the probe that shows it, then `gate step rootcause done \"<file:line of the fault and what the run showed>\" --ran \"<part of the command>\"`; a cause you did not see is a guess",
  skeptic: "a non-empty \"The one question\" in skeptic-<n>.md is the user's to answer: ask it with AskUserQuestion before any code. `gate brief skeptic`, spawn done-gate:skeptic with the prompt it prints (it writes skeptic-<n>.md and replies with its Act-on list); code and tests wait for it, so end the turn while it reads (if it stops before finishing its file, `gate brief skeptic` again and spawn a fresh one, which continues from the file); then `gate huddle add skeptic --file skeptic-<n>.md` and answer each item: fold it into the plan and cases, then `gate huddle resolve H<k>.<i> --evidence <ptr>` (or `gate huddle dispute`); the step closes itself once every item is answered",
  tests: "write the tests from the case table before the code, one per case, and run them red; then `gate step tests done \"<red output, trimmed>\" --evidence <test file>`; at size large `gate brief qa` and spawn done-gate:qa instead; a change with no code (config, lockfile, CSS, images, docs): `gate step tests na \"<why>\"`",
  qa: "`gate brief qa`, spawn done-gate:qa with the prompt it prints, then `gate step qa done … --evidence <test file>`",
  implement: "implement, keeping the diff to the plan (a code file outside it: `gate plan add <file> \"<why>\"`, asking the user first when it changes behaviour they did not ask for); where the tests and the code disagree, decide code-wrong, test-wrong or ask the user, close each case with `gate case close C<n> --test <file:name>`, then `gate step implement done \"…\" --evidence <file>`",
  verify: "`gate verify`, run with a Bash timeout of 600000 ms, or in the background (run_in_background) when the commands' own timeouts (`gate doctor` prints them) add up to more; lint, test and build can take minutes, and a killed run writes no verify.json",
  "verify-before": "`gate verify --step verify-before`, run with a Bash timeout of 600000 ms, or in the background when the commands' timeouts add up to more",
  driver: "drive the real surface yourself (phone viewport first), then `gate decide driver …` and `gate step driver done … --evidence decisions#<n>`; an API change is driven by calling the endpoint and closes on that call, `gate step driver done \"<what it returned>\" --ran \"<part of the command or url>\"` (or `na` when no UI or API file changed); never ask for a waiver here to save time",
  schema: "probe the real schema yourself, then `gate step schema done \"<what it returned>\" --ran \"<part of the command or url>\"` (or `na` when no schema file changed); never ask for a waiver here to save time",
  review: "the loop: `gate brief reviewer` (past the piece cap, `--files a,b` per piece under it, or `--files a.ts:1-400` for a slice of one big file; a line counts as reviewed once a clean round saw it), spawn done-gate:reviewer with the prompt it prints (on high-risk paths `gate brief reviewer-2` too and spawn both at once; `gate verify` may run in the background meanwhile), `gate huddle add reviewer --file review-<n>.md` (it prints each finding's id; a reviewer that stops before finishing its file is briefed again and a fresh one continues from the file); fix the items yourself and `gate huddle resolve H<k>.<i> --evidence <ptr>` (or `gate huddle dispute`); for a worker's piece `gate brief worker --files <its files>`, SendMessage the worker its packet, which lists the finding ids (or spawn done-gate:worker with the prompt), then `gate huddle reply --file worker-<n>.md` when it answers (fixed: closes, disagree: disputes); repeat with the same reviewer (SendMessage it the next packet) until a round comes back clean: one round plus one re-check, a fix-check over the lines the fixes changed, which is the last (after a clean round or the re-check, lines changed later need a round when behaviour changed, else `gate huddle unchanged <lines> \"<why>\"`, which the report lists; a file comes back once, then later lines are listed; a new file needs a round; the fix-check runs in parts past the piece cap; a run pinned before keeps three rounds and needs no new round after a clean one); what is still disputed after it goes to `gate brief arbiter --item H<k>.<i>` and done-gate:arbiter; then `gate step review done … --evidence review-<n>.md`; you own the diff and the summary, the reviewer's file is embedded as it wrote it",
  close: "`gate close`",
};

// On a run under the new rules these steps close themselves (settleSteps), so the hint drops the hand close.
const SELF_CLOSE = {
  tests: ["then `gate step tests done \"<red output, trimmed>\" --evidence <test file>`;", "the step closes itself on that run, which comes before the code;"],
  implement: [", then `gate step implement done \"…\" --evidence <file>`", "; the step closes itself on a green `gate verify`"],
  driver: ["then `gate decide driver …` and `gate step driver done … --evidence decisions#<n>`;", "and the step closes itself on the recorded drive (one the gate did not see: `gate decide driver …` and `gate step driver done … --evidence decisions#<n>`);"],
  review: ["; then `gate step review done … --evidence review-<n>.md`;", "; the step closes itself once a round is clean and every item is closed;"],
};

// A run from before the plan check held code: tests while the skeptic reads, and a hand close.
const OLD_SKEPTIC = "`gate brief skeptic`, spawn done-gate:skeptic with the prompt it prints (it writes skeptic-<n>.md and replies with its Act-on list) and write the tests from the case table in the same turn while it reads (if it stops before finishing its file, `gate brief skeptic` again and spawn a fresh one, which continues from the file); then `gate huddle add skeptic --file skeptic-<n>.md`, answer each item (a new case gets a new test); a non-empty \"The one question\" in its file is the user's to answer: ask it with AskUserQuestion before any code; then `gate step skeptic done … --evidence skeptic-<n>.md`";

// `after` is the last implementation edit: a click case clicked before it is open again.
export function nextHint(ledger, after = 0) {
  return hintOf(ledger, after).text;
}

// step is set when the hint is a playbook step's own text, the part that repeats.
function hintOf(ledger, after, config = null) {
  const only = (text) => ({ text, step: null });
  if (!ledger || isDone(ledger)) return only("");
  if (!ledger.taskSeq) return only("next: `gate note task \"<the user's ask, quoted, then your own words>\"`");
  if (!ledger.planSeq) {
    // the steps before {plan} (understand first: context; for a bugfix repro and root cause
    // before it) come before the plan itself
    const planAt = ledger.steps.findIndex((s) => s.key === "plan");
    const before = ledger.steps.slice(0, planAt < 0 ? ledger.steps.length : planAt).find((s) => !s.state && s.key && s.key !== "read" && VERB_FOR[s.key]);
    if (before) return { text: `next: step ${before.n}: ${VERB_FOR[before.key]}`, step: before };
    return only("next: `gate note plan \"<approach, files, data plan>\" --files a.ts,b.ts [--size large]`");
  }
  if (tiered(ledger) && !ledger.cases.length) return only("next: `gate case add \"<case>\" --kind happy|edge|refused|boundary|idempotent|reported-surface|performance|click`, one per row (click: one per new or changed link, button or tab)");
  const blank = ledger.steps.filter((s) => !s.state);
  const step = blank[0];
  const open = ledger.cases.filter((c) => c.status !== "closed" || clickStale(c, after));
  const closeCases = `next: close ${open.map((c) => c.id).join(", ")} with \`gate case close C<n> --test <file:name>\`, \`--ran "<part of the command>"\` or \`--na "<reason>"\` (with \`--user-ok "<their words>"\` on a case written before the code)${open.some((c) => c.kind === "click") ? "; a click case: click the control in the real app after the last edit, then `gate case close C<n> --click` (with more than one click case open: `--click events#<seq>`)" : ""}`;
  // open cases come before the close step: closing with a blank case would only bounce off R8
  if (open.length && (!step || step.key === "close")) return only(closeCases);
  if (step) {
    const e2e = step.key === "driver" && config ? driverCommand(config) : null;
    const inVerify = e2e && config.verify.some((v) => v.cmd.trim() === e2e);
    const how = inVerify ? `\`gate verify --final\`: a green \`${e2e}\` counts as the drive, then \`gate step driver done "<what it showed>" --evidence events#<seq>\` with the pointer it prints` : step.key === "skeptic" && !newRules(ledger) ? OLD_SKEPTIC : step.key && SELF_CLOSE[step.key] && newRules(ledger) ? VERB_FOR[step.key].replace(...SELF_CLOSE[step.key]) : step.key ? VERB_FOR[step.key] : null;
    return { text: `next: step ${step.n}: ${how ?? `${step.text} then \`gate step ${step.n} done|skipped|na "…"\``}`, step };
  }
  return only("next: `gate close`");
}

export function printNext(ctx, { full = false } = {}) {
  try {
    const current = currentLedger(ctx.stateDir, ctx.session);
    const ledger = current?.ledger ?? null;
    // the event log is read only when a click case holds an event that an edit could outdate
    const after = ledger?.cases?.some((c) => c.event)
      ? lastEditSeq({ events: ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq) }, loadConfig(ctx.root, ledger.repos), ledger)
      : 0;
    const { text, step } = hintOf(ledger, after, ledger ? loadConfig(ctx.root, ledger.repos) : null);
    if (ledger && !isDone(ledger) && ledger.planDrift?.length && policyFor(ledger).guards.planDiff === "active") ctx.out(`warning: code outside the plan: ${ledger.planDrift.join(", ")}. \`gate plan add <files> "<why>"\` or revert it; the run cannot close until then`);
    if (!text) return;
    const key = step ? step.key ?? String(step.n) : null;
    const shown = ledger.hinted?.[ctx.session] ?? [];
    if (key && !full && shown.includes(key)) {
      ctx.out(`next: step ${step.n}${step.key ? ` {${step.key}}` : ""}, as before; \`gate next\` prints it in full`);
      return;
    }
    ctx.out(text);
    if (key && !shown.includes(key)) {
      ledger.hinted = { ...(ledger.hinted ?? {}), [ctx.session]: [...shown, key] };
      saveLedger(current.dir, ledger);
    }
  } catch {
    // a hint is a courtesy; never turn a successful verb into a failure
  }
}

export const verbs = {
  next(ctx) {
    const current = currentLedger(ctx.stateDir, ctx.session);
    if (!current || isDone(current.ledger)) throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
    printNext(ctx, { full: true });
  },
};

export { optionalSteps };
