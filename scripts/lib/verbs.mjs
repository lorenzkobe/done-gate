import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nextSeq } from "./events.mjs";
import { addLessons, currentLedger, findRun, isDone, loadLedger, openRuns, saveLedger } from "./ledger.mjs";
import { loadConfig } from "./config.mjs";
import { applyPrediction, effectiveTier, groupPieces, inPlan, outsidePlan, PIECES_PER_GROUP, policyFor, samePiece, requiredSteps, requires, tierOf, tierOrder, tiered } from "./size.mjs";
import { toPosixRel } from "./paths.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";
import { renderReport } from "./report.mjs";
import { abandonWordsProblem, askedNotSaid, saidAt, LAPSING, ON_CODE, firstCodeEdit, notRecommended, wordsShapeProblem, saidSince, waiverWordsProblem, apiCalls, apiFiles, briefOf, caseOpen, editedIn, newRules, stepSurfaceFiles, writersOf, openItem, clickEvents, driverCommand, helperRun, lastEditSeq, isDraft, unfinishedFile, parseDisputes, parseFindings, sectionBullets, uncovered, afterReview, changedUnitsOf, parseEntry, pathOf, parseReplies, pointerResolver, proofProblem, wrongProblem, upheldItem, uiTrial, reviewTrialed, CONTEXT_PARTS, contextPart, tracedPointers, namesFile, ranEvents, ranText, WAIVERS, leadLookups, skippedLookups, skippedText, LOOKUP_KINDS, LOOKUP_EXAMPLE, slopHits, list, setUpServers, userSaid, workerRuns } from "./rules.mjs";
import { assess, broughtSinceOpen, buildState, cleanAtHead, foldIntoBaseline, otherSessionsEvents, ownWrites, readVerify, reviewFiles, readVerifyStarted, unmetCount, unmetLines } from "./assess.mjs";
import { loadSession, saveSession } from "./session-state.mjs";
import { diffSnapshots, gitHead, snapshot, withoutRepos } from "./tree.mjs";
import { weakened } from "./slop.mjs";
import { pointerFile } from "./verify.mjs";
import { endStanding, waiveStanding } from "./standing.mjs";
import { appendEvents, readEvents } from "./events.mjs";

// A reviewer's finding closed unfixed: on a run that shows it wrong, or on the user's words. A
// dispute still waiting is the reviewer's to answer; an upheld one is the user's call.
function closeAsWrong(ctx, state, item, aid, evidence, words) {
  if (!item) throw new UsageError(`no act-on item ${aid}`);
  const h = state.ledger.huddles.find((x) => x.actOn.some((a) => a.id === aid));
  if (h.role !== "reviewer" && h.role !== "reviewer-2") throw new UsageError(`--wrong is for a reviewer's finding; ${aid} is the ${h.role}'s: answer it with \`gate huddle resolve\` or \`gate huddle dispute\``);
  if (item.dispute && !item.dispute.verdict) throw new UsageError(`${aid} is disputed and the ${h.role} has not answered yet: \`gate brief ${h.role}\` sends it to be withdrawn or upheld`);
  const upheld = upheldItem(item);
  if (evidence) {
    if (upheld) throw new UsageError(`${aid}: the ${h.role} upheld it, so it is the user's call: ask them, then \`gate huddle resolve ${aid} --wrong --words "<their words>"\`, or fix it`);
    const problem = wrongProblem(state, item, evidence);
    if (problem) throw new UsageError(`${aid}: ${problem}`);
  } else {
    const shape = wordsShapeProblem(words);
    const tell = `ask the user whether to keep it, then \`gate huddle resolve ${aid} --wrong --words "<their words, at least three>"\``;
    if (shape) throw new UsageError(`${aid}: ${shape}. ${tell}`);
    const from = upheld ? item.dispute.answeredSeq ?? item.dispute.seq ?? h.seq ?? 0 : h.seq ?? 0;
    const hit = saidAt(notRecommended(state.events ?? []), from, words);
    if (!hit) throw new UsageError(`${aid}: the user did not say "${words}" ${upheld ? "since the reviewer upheld it" : "since this finding"}: ${tell}`);
    if (askedNotSaid(hit.text, words)) throw new UsageError(`${aid}: "${words}" was the user's question, not their decision: ${tell}`);
  }
  withLedger(ctx, (ledger, dir) => {
    const a = ledger.huddles.flatMap((x) => x.actOn).find((x) => x.id === aid);
    a.closed = `wrong: ${evidence ?? `the user said "${words}"`}`;
    a.wrong = evidence ? { evidence, seq: nextSeq() } : { words, seq: nextSeq() };
    a.closedSeq = nextSeq();
    settleCheck(ledger, dir);
  });
  ctx.out(`${aid} closed as wrong (${evidence ?? `the user: "${words}"`}); the report lists it`);
  printNext(ctx);
}

// The report of a run that is no longer current: the same renderer `gate report` uses.
export function writeReport(ctx, dir, ledger) {
  const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
  const state = { ...buildState(ctx, {}), ledger, dir, verify: readVerify(dir), verifyStarted: readVerifyStarted(dir), reviews: reviewFiles(dir), events, changed: ledger.changedAtClose ?? [], tier: ledger.tier ?? null, stateDir: ctx.stateDir };
  writeFileSync(path.join(dir, "report.md"), renderReport(state, []));
}

// A clean run closes: the ledger records the tree it closed on, and the session's baseline
// moves to that tree so the next task starts from zero changes.
function finalise(ctx, state) {
  const ledger = loadLedger(state.dir);
  ledger.status = "closed";
  ledger.closedAt = new Date().toISOString();
  ledger.closedTreeHash = state.now.hash;
  ledger.changedAtClose = state.changed;
  ledger.weakened = weakened(state);
  ledger.afterReview = afterReview(state);
  if (reviewTrialed(state)) ledger.uiTrial = true;
  if (state.tier) ledger.tier = state.tier;
  saveLedger(state.dir, ledger);
  const session = loadSession(ctx.stateDir, ctx.session);
  // a declared repo's files end with the run: session state holds main-root keys only
  const main = withoutRepos(state.now, state.repos);
  saveSession(ctx.stateDir, { ...session, current: null, lastClosed: path.basename(state.dir), baseline: { ...main, head: gitHead(ctx.root) }, foreignHead: null, lastTree: main, baselineSeq: nextSeq(), runEndSeq: nextSeq() });
  writeReport(ctx, state.dir, ledger);
  return ledger;
}

const SURFACE_KEYS = new Set(["driver", "schema"]);
// Steps whose evidence comes from a script or an agent: DONE or WAIVED only.
const EVIDENCED_KEYS = new Set(["context", "verify", "verify-before", "driver", "review", "tests", "qa", "skeptic", "close", "repro", "rootcause"]);
// Steps that claim something was run: DONE only on a run the hooks recorded.
const RUN_KEYS = new Set(["repro", "rootcause", "schema"]);
export const CASE_KINDS = ["happy", "edge", "refused", "boundary", "idempotent", "reported-surface", "performance", "click"];
export const ROLES = ["skeptic", "qa", "reviewer", "reviewer-2", "worker"];
// Step keys whose rule has no waiver: waiving the step would leave that rule blocking.
const NO_WAIVER = {
  verify: "Run `gate verify`",
  "verify-before": "Run `gate verify --step verify-before`",
  context: 'Write it with `gate note context "Traced: … · Related: … · Research: …"`',
  close: "Run `gate close`",
};

export function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const BARE_FLAGS = new Set(["--click", "--could-not-run"]);

export function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // --click may name its event: `--click events#<seq>`
      if (!BARE_FLAGS.has(args[i]) || (args[i] === "--click" && /^events#\d+$/.test(args[i + 1] ?? ""))) i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

// A helper file is recorded only when every helper that wrote it searched first.
function refuseSkipped(ctx, dir, ledger, file) {
  if (!ledger.lookups) return;
  const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
  const skipped = skippedLookups({ ledger, dir, root: ctx.root, events }, file);
  if (skipped.length) throw new UsageError(`${file} was written by ${skipped.map(skippedText).join(", ")} without searching first; nothing recorded. Send it back (SendMessage) to search, e.g. ${LOOKUP_KINDS.map((k) => LOOKUP_EXAMPLE[k]).join(" and ")}, and recheck its file.`);
}

// Why the plan check is not done yet, or null: its newest file is finished and recorded and every
// finding in it is answered.
function checkAnswered(ledger, dir) {
  const last = ledger.huddles.filter((h) => h.role === "skeptic" && h.file).at(-1);
  if (!last) return "step {skeptic} needs a recorded skeptic huddle: `gate brief skeptic`, spawn done-gate:skeptic, then `gate huddle add skeptic --file skeptic-<n>.md`";
  const full = path.join(dir, last.file);
  if (!existsSync(full) || unfinishedFile(full)) return `step {skeptic}: ${last.file} is not finished. Run \`gate brief skeptic\` again and spawn a fresh helper; its packet continues from the file.`;
  const openItems = ledger.huddles.filter((h) => h.role === "skeptic").flatMap((h) => h.actOn.filter((a) => !a.closed));
  if (openItems.length) return `step {skeptic}: Act-on item(s) still open: ${openItems.map(openItem).join(", ")}. Answer each, then \`gate huddle resolve <id> --evidence <pointer>\`.`;
  return null;
}

// The skeptic's question for the user, or null when its file says none.
function oneQuestion(text) {
  const at = text.search(/^## The one question\s*$/m);
  if (at < 0) return null;
  const body = text.slice(at).split("\n").slice(1);
  const end = body.findIndex((l) => /^##\s/.test(l));
  const words = (end < 0 ? body : body.slice(0, end)).map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).join(" ");
  return !words || /^(?:none|unverified)\.?$/i.test(words) ? null : words;
}

// On a run under the new rules the plan check closes itself once every finding is answered. A
// question for the user leaves the close to the lead: the gate cannot tell it was asked.
function settleCheck(ledger, dir) {
  const step = ledger.steps.find((s) => s.key === "skeptic");
  if (!newRules(ledger) || !step || step.state !== null || checkAnswered(ledger, dir)) return;
  const last = ledger.huddles.filter((h) => h.role === "skeptic" && h.file).at(-1);
  if (oneQuestion(readFileSync(path.join(dir, last.file), "utf8"))) return;
  Object.assign(step, { state: "DONE", note: "closed by the gate: every finding answered", evidence: last.file, auto: "fact", seq: nextSeq() });
}

// Code and tests wait for an owed plan check; a run whose code already changed is not stalled
// mid-edit by growing into one, and R8 still asks for it.
function holdForCheck(ledger) {
  if (!newRules(ledger) || !tiered(ledger)) return;
  const check = ledger.steps.find((s) => s.key === "skeptic");
  ledger.checkHold = Boolean(check && check.state === null && (!ledger.lastSourceChangeSeq || ledger.checkHold));
}

// On a run under the new rules a plan names files: a folder or a pattern would let any file in.
function refuseNotFiles(ctx, ledger, given, named) {
  if (!newRules(ledger)) return;
  if (!named.length) throw new UsageError(`--files "${given}" names no file; leave --files out to keep the plan's list`);
  const loose = named.find((f) => /\/$|[*?]/.test(f) || (existsSync(path.resolve(ctx.root, f)) && statSync(path.resolve(ctx.root, f)).isDirectory()));
  if (loose) throw new UsageError(`"${loose}" is a folder or a pattern: a plan names each file it changes (a new file is fine)`);
}

const codeLimit = (ctx, ledger, paths) => {
  const limit = policyFor(ledger).splitPast.files;
  const config = loadConfig(ctx.root, ledger.repos);
  const code = paths.filter((f) => f && config.isSource(f) && !config.isTest(f));
  if (code.length > limit) throw new UsageError(`the plan names ${code.length} code files, past the ${limit} one task can be reviewed well at: split the work into separate tasks, each its own run, and plan only this one's part`);
};

// A click event as the lead would recognise it: what it did, then its pointer.
function clickLine(e) {
  const what = e.kind === "command" ? `\`${e.cmd}\`` : [e.action, e.target, e.url, e.actions?.map((a) => [a.action, a.target].filter(Boolean).join(" ")).join(", ")].filter(Boolean).join(" ");
  return `${what} (events#${e.seq})`;
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
function checkContext(text, root, repos) {
  const missing = CONTEXT_PARTS.filter((name) => contextPart(text, name) === null);
  if (missing.length) throw new UsageError(`${CONTEXT_USAGE} (missing: ${missing.join(", ")})`);
  const pointers = tracedPointers(contextPart(text, "Traced"), root, repos);
  if (!pointers.length) throw new UsageError("Traced needs at least one file:line pointer into the repo (the entry point, a caller, a data path); prose alone is not a trace");
  const bad = pointers.filter((p) => !p.exists);
  if (bad.length) throw new UsageError(`Traced: ${bad.map((p) => `${p.file}:${p.line}`).join(", ")} does not resolve (no such file in the repo, or the line is past its end); cite the lines you read`);
  const related = contextPart(text, "Related");
  if (!namesFile(related, root, repos) && !/^none\b[^`]*`[^`]+`/i.test(related)) {
    throw new UsageError("Related names no file that exists in the repo: name what depends on it (a caller, a test, a doc, config), or write \"none: `<the search you ran>`\" so the claim that nothing does has a run behind it");
  }
}

// The kinds the lead declares missing (--no-code / --no-memory "<why>"). Refused while a kind is
// neither declared nor searched by the lead itself since the user's message.
function checkLookups(ctx, ledger, rest) {
  const declared = {};
  for (const kind of LOOKUP_KINDS) {
    const name = `--no-${kind}`;
    if (!rest.includes(name)) continue;
    const why = flag(rest, name);
    if (!why?.trim() || why.startsWith("--")) throw new UsageError(`${name} needs the tool and why, e.g. ${name} "<tool>: not installed" or "<tool>: not indexed"`);
    declared[kind] = why.trim();
  }
  if (!ledger.lookups) return declared;
  const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
  const found = leadLookups(ledger, events);
  // a skipped search is the user's call, told what is set up: a tool that is set up and was not
  // even tried is named, so the user knows they are waiving a working tool
  if (Object.keys(declared).length) {
    const servers = setUpServers(ctx.root);
    const untried = Object.keys(declared).flatMap((k) => (found.failed[k].size ? [] : servers[k].map((s) => `${s.name} (set up in ${s.where}, not tried)`)));
    const ok = flag(rest, "--user-ok");
    const tell = `tell the user which search is missing or failing${untried.length ? `, and that ${untried.join(", ")} looks set up: try it first, or say why it cannot run` : ""}, and ask whether to continue without it; then pass --user-ok "<their words, at least three>"`;
    if (!ok?.trim() || ok.startsWith("--")) throw new UsageError(`skipping ${Object.keys(declared).join(" and ")} search is the user's call: ${tell}`);
    if (!userSaid(ledger, notRecommended(events), ok)) throw new UsageError(`the user did not say "${ok}" in this task (at least three of their words, from a message or a question answer): ${tell}`);
    for (const kind of Object.keys(declared)) declared[kind] = `${declared[kind]} (the user: "${ok.trim()}")`;
  }
  const missing = LOOKUP_KINDS.filter((k) => !found[k].size && !declared[k] && !ledger.lookupGap?.[k]);
  if (missing.length) {
    const what = missing.map((k) => `${k} (e.g. ${LOOKUP_EXAMPLE[k]})`).join(" and ");
    const flags = missing.map((k) => `--no-${k} "<tool>: not installed|not indexed"`).join(" and ");
    const failed = missing.flatMap((k) => [...found.failed[k]]);
    const failure = failed.length ? ` Your ${failed.map((t) => `\`${t}\``).join(", ")} call failed and does not count: retry it.` : "";
    throw new UsageError(`search the ${what} yourself before \`gate note context\` (a subagent's or Explore's search does not count), or pass ${flags} when the tool is missing or the project is not indexed.${failure}`);
  }
  return declared;
}

export const outsideRepos = (given) => `"${given}" is outside this repo and every declared repo: declare its repo with \`gate repo add <dir>\`, then name the file again`;

const PIECES_USAGE = 'gate plan pieces "<a.ts,b.ts>" "<c.ts>" ... [--shared <x.ts,y.ts>]';

// The pieces workers may edit at once: each names files, its code inside the plan. The gate
// groups them (groupPieces) and prints each group's briefs; one piece is the lead's own work.
function planPieces(ctx, given) {
  if (!given.length) throw new UsageError(`usage: ${PIECES_USAGE}`);
  const { ledger } = open(ctx);
  if (!newRules(ledger)) throw new UsageError(`run ${ledger.slug} opened before gate plan pieces: brief each worker with \`gate brief worker --files a,b\``);
  if (!tiered(ledger)) throw new UsageError(`a ${ledger.playbook} run has no file plan to split into pieces`);
  const out = workerRuns({ ledger, events: ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)) }).find((r) => r.running);
  if (out) throw new UsageError(`${out.n === null ? "a worker" : `worker ${out.n}`} is still running: the pieces change once it has stopped`);
  const sharedText = flag(ctx.args, "--shared");
  if (ctx.args.filter((a) => a === "--shared").length > 1) throw new UsageError("give --shared once, as a comma list: --shared a.ts,b.ts");
  if (ctx.args.includes("--shared") && (!sharedText || sharedText.startsWith("--"))) throw new UsageError(`--shared names no file: ${PIECES_USAGE}`);
  const config = loadConfig(ctx.root, ledger.repos);
  const plan = tierOf(ledger).predictedFiles;
  const filesOf = (text, what) => {
    const named = text.split(",").map((f) => f.trim()).filter(Boolean);
    if (!named.length) throw new UsageError(`${what} "${text}" names no file`);
    refuseNotFiles(ctx, ledger, text, named);
    const files = [];
    for (const f of named) {
      const rel = toPosixRel(ctx.root, f, ledger.repos);
      if (rel === null) throw new UsageError(`${what}: ${outsideRepos(f)}`);
      if (!inPlan(files, rel)) files.push(rel);
    }
    const outside = outsidePlan(plan, files, config);
    if (outside.length) throw new UsageError(`${what}: ${outside.join(", ")} is not in this task's plan: \`gate plan add ${outside.join(",")} "<why>"\` first, asking the user when it changes behaviour they did not ask for`);
    return files;
  };
  const pieces = given.map((text, i) => filesOf(text, `piece ${i + 1}`));
  pieces.forEach((p, i) => {
    const j = pieces.findIndex((q, k) => k > i && samePiece(p, q));
    if (j > i) throw new UsageError(`pieces ${i + 1} and ${j + 1} name the same files, and one worker number would hold both: list each piece once`);
  });
  const shared = sharedText === undefined ? [] : filesOf(sharedText, "--shared");
  const unheld = shared.filter((f) => !pieces.some((p) => inPlan(p, f)));
  if (unheld.length) throw new UsageError(`--shared ${unheld.join(", ")} is in no piece: a shared file is one a piece edits and the other pieces build on`);
  if (pieces.length === 1) {
    withLedger(ctx, (l) => {
      delete l.pieces;
    });
    ctx.out("one piece stays with the lead: edit it yourself, no worker needed");
    printNext(ctx);
    return;
  }
  const groups = groupPieces(pieces, shared);
  withLedger(ctx, (l) => {
    l.pieces = { list: pieces, shared, groups, seq: nextSeq() };
  });
  ctx.out(`${pieces.length} pieces in ${groups.length} group${groups.length === 1 ? "" : "s"}, at most ${PIECES_PER_GROUP} workers at once:`);
  groups.forEach((g, k) => {
    ctx.out(`group ${k + 1}:`);
    for (const i of g) ctx.out(`  gate brief worker --files ${pieces[i].join(",")}`);
  });
  ctx.out("brief and spawn one group's workers together; once every one has stopped, `gate verify`, then the next group");
  printNext(ctx);
}

// Opened and nothing more: no note, case, step, round, waiver, brief, decision, edit or helper.
function emptyRun(ctx, dir, ledger) {
  const briefs = Object.keys({ ...(ledger.briefed ?? {}), ...(ledger.seen ?? {}) }).length;
  if (ledger.taskSeq || ledger.contextSeq || ledger.planSeq || ledger.cases?.length || ledger.steps?.some((s) => s.state) || ledger.huddles?.length || ledger.waivers?.length || briefs || ledger.lastSourceChangeSeq) return false;
  const decisions = path.join(dir, "decisions.tsv");
  if (existsSync(decisions) && readFileSync(decisions, "utf8").trim().split("\n").length > 1) return false;
  const events = (ledger.sessions ?? []).flatMap((s) => readEvents(ctx.stateDir, s));
  return !events.some((e) => e.seq > (ledger.openedSeq ?? 0) && (e.kind === "edit" || e.kind === "subagent-start"));
}

// Giving up a used run is the user's call: their own words since it opened, saying to abandon,
// drop or give up this run, not asked as a question and not a recommended answer.
function abandonWords(ctx, dir, ledger, words) {
  const tell = `ask the user, then \`gate abandon ${ledger.slug} "<why>" --user-ok "<their words, at least three, saying to abandon, drop or give up this run or ${ledger.slug}>"\`; asking with a question, put the words in its option label, since an answer holds only the chosen label`;
  if (!words?.trim()) throw new UsageError(`giving up run ${ledger.slug} is the user's call: ${tell}`);
  const own = loadSession(ctx.stateDir, ctx.session)?.current === path.basename(dir);
  const problem = abandonWordsProblem(words, ledger.slug, { bareRunOk: own || openRuns(ctx.stateDir).length === 1 });
  if (problem) throw new UsageError(`gate abandon: ${problem}. ${tell}`);
  const sessions = [...new Set([ctx.session, ...(ledger.sessions ?? [])].filter(Boolean))];
  const events = notRecommended(sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq));
  const hit = saidAt(events, ledger.openedSeq ?? 0, words);
  if (!hit) throw new UsageError(`the user did not say "${words.trim()}" since run ${ledger.slug} opened: ${tell}`);
  if (askedNotSaid(hit.text, words)) throw new UsageError(`"${words.trim()}" was the user's question, not their decision: ${tell}`);
}

export const verbs = {
  note(ctx) {
    const [section, ...rest] = ctx.args;
    if (!["task", "context", "plan", "caveat"].includes(section)) throw new UsageError('usage: gate note <task|context|plan|caveat> "<text>" [--files a,b] [--size <tier>] (or - to read stdin)');
    const files = flag(rest, "--files");
    const size = flag(rest, "--size");
    const text = readText(ctx, positional(rest).join(" ")).trim();
    if (!text) throw new UsageError("note: empty text");
    if (section === "caveat") {
      if (files !== undefined || size !== undefined) throw new UsageError('usage: gate note caveat "<what was not shown>" (--files and --size belong to gate note plan)');
      const added = withLedger(ctx, (ledger) => {
        if (ledger.caveats?.includes(text)) return false;
        ledger.caveats = [...(ledger.caveats ?? []), text];
        return true;
      });
      ctx.out(added ? "caveat noted: the report will show it" : "caveat already noted");
      printNext(ctx);
      return;
    }
    let gap = {};
    if (section === "context") {
      checkContext(text, ctx.root, ctx.repos);
      gap = checkLookups(ctx, open(ctx).ledger, rest);
    }
    const named = section === "plan" ? (files ?? "").split(",").map((f) => f.trim()).filter(Boolean) : [];
    const outside = named.filter((f) => toPosixRel(ctx.root, f, ctx.repos) === null);
    if (outside.length && outside.length === named.length) throw new UsageError(`--files: ${outsideRepos(outside.join(", "))}`);
    if (section === "plan" && files !== undefined) {
      const { ledger } = open(ctx);
      refuseNotFiles(ctx, ledger, files, named);
      // once code changed a list the plan named is what it promised: it grows only by gate plan add
      const paths = named.map((f) => toPosixRel(ctx.root, f, ledger.repos)).filter(Boolean);
      const now = tierOf(ledger).predictedFiles;
      const same = paths.every((p) => inPlan(now, p)) && now.every((p) => inPlan(paths, p));
      if (newRules(ledger) && tiered(ledger) && ledger.lastSourceChangeSeq && now.length && !same) throw new UsageError('the code has changed, so the plan\'s files are fixed: add one with `gate plan add <file> "<why>"`; the list no longer drops a file');
    }
    // a plan past the split limit is several tasks: one review cannot cover it well
    if (named.length) {
      const { ledger } = open(ctx);
      codeLimit(ctx, ledger, named.map((f) => toPosixRel(ctx.root, f, ledger.repos)));
    }
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
        if (Object.keys(gap).length) ledger.lookupGap = { ...ledger.lookupGap, ...gap };
        markStep(ledger, "context", { state: "DONE", evidence: "ledger.md#context", note: "Context written" });
      }
      if (section === "plan") {
        // the first plan is what R2 dates; an amendment after the skeptic keeps that date
        if (!ledger.planSeq) ledger.planSeq = seq;
        if (ledger.taskSeq) markStep(ledger, "plan", { state: "DONE", evidence: "ledger.md#plan", note: "Task and Plan written" });
        if ((files !== undefined || size !== undefined) && tiered(ledger)) {
          // a path outside the main root and every declared repo cannot be part of this task's diff
          // --size alone keeps the files the plan already named
          const paths = files === undefined ? tierOf(ledger).predictedFiles : named.map((f) => toPosixRel(ctx.root, f, ledger.repos)).filter((f) => f);
          predicted = applyPrediction(ledger, policyFor(ledger), loadConfig(ctx.root, ledger.repos), paths, size ?? null);
        }
        holdForCheck(ledger);
      }
    });
    ctx.out(predicted ? `${section} noted · tier predicted ${predicted.tier} (${predicted.files} file${predicted.files === 1 ? "" : "s"}${predicted.declared ? `, declared ${predicted.declared}` : ""}${predicted.forced.length ? `, forced by ${predicted.forced.join(", ")}` : ""})` : `${section} noted`);
    if (outside.length) ctx.out(`not counted: ${outsideRepos(outside.join(", "))}`);
    printNext(ctx);
  },

  plan(ctx) {
    const [action, files, ...words] = positional(ctx.args);
    if (action === "pieces") return planPieces(ctx, positional(ctx.args).slice(1));
    const why = words.join(" ").trim();
    if (action !== "add" || !files || !why) throw new UsageError(`usage: gate plan add <a.ts,b.ts> "<why the task needs them>" · ${PIECES_USAGE}`);
    const { ledger } = open(ctx);
    if (!newRules(ledger)) throw new UsageError(`run ${ledger.slug} opened before gate plan add: name every file with \`gate note plan "<plan>" --files <every file>\``);
    if (!tiered(ledger)) throw new UsageError(`a ${ledger.playbook} run has no file plan to add to`);
    const named = files.split(",").map((f) => f.trim()).filter(Boolean);
    if (!named.length) throw new UsageError(`gate plan add: "${files}" names no file`);
    refuseNotFiles(ctx, ledger, files, named);
    const outside = named.filter((f) => toPosixRel(ctx.root, f, ledger.repos) === null);
    if (outside.length) throw new UsageError(`gate plan add: ${outsideRepos(outside.join(", "))}`);
    const now = tierOf(ledger).predictedFiles;
    const fresh = [];
    for (const p of named.map((f) => toPosixRel(ctx.root, f, ledger.repos))) if (!inPlan([...now, ...fresh], p)) fresh.push(p);
    if (!fresh.length) {
      ctx.out("already in the plan: nothing added");
      printNext(ctx);
      return;
    }
    codeLimit(ctx, ledger, [...now, ...fresh]);
    let predicted = null;
    withLedger(ctx, (l) => {
      predicted = applyPrediction(l, policyFor(l), loadConfig(ctx.root, l.repos), [...tierOf(l).predictedFiles, ...fresh], null);
      l.planAdds = [...(l.planAdds ?? []), { files: fresh, why, seq: nextSeq() }];
      if (l.planDrift) l.planDrift = l.planDrift.filter((p) => !inPlan(fresh, p));
      holdForCheck(l);
    });
    ctx.out(`added to the plan: ${fresh.join(", ")} · tier predicted ${predicted.tier} (${predicted.files} file${predicted.files === 1 ? "" : "s"})`);
    printNext(ctx);
  },

  case(ctx) {
    const [action, ...rest] = ctx.args;
    const pos = positional(rest);
    const batch = flag(rest, "--batch");
    if (action === "add" && batch !== undefined) {
      if (!batch || !existsSync(batch)) throw new UsageError(`gate case add --batch: no file "${batch ?? ""}"; one case per line as <kind><TAB><text>`);
      let content;
      try {
        content = readFileSync(batch, "utf8");
      } catch (error) {
        throw new UsageError(`gate case add --batch: cannot read "${batch}" (${error.code}); name a file with one case per line as <kind><TAB><text>`);
      }
      const lines = content.split("\n").map((l, i) => ({ n: i + 1, line: l.replace(/\r$/, "") })).filter((l) => l.line.trim());
      // every line is checked before any case is added: a bad line adds nothing
      const rows = lines.map(({ n, line }) => {
        const tab = line.indexOf("\t");
        const kind = tab < 0 ? "" : line.slice(0, tab).trim();
        const text = tab < 0 ? "" : line.slice(tab + 1).trim();
        if (!CASE_KINDS.includes(kind) || !text) throw new UsageError(`${batch} line ${n}: expected <kind><TAB><text> with kind one of ${CASE_KINDS.join(", ")}; nothing was added`);
        return { kind, text };
      });
      if (!rows.length) throw new UsageError(`${batch} holds no case; one per line as <kind><TAB><text>`);
      const ids = withLedger(ctx, (ledger) => {
        const ids = rows.map(({ kind, text }) => {
          const id = `C${ledger.cases.length + 1}`;
          ledger.cases.push({ id, case: text, kind, test: null, na: null, status: "open", seq: nextSeq() });
          return id;
        });
        markStep(ledger, "cases", { state: "DONE", evidence: "ledger.json#cases", note: "case table written" });
        return ids;
      });
      ctx.out(`${ids.length} case${ids.length === 1 ? "" : "s"} added: ${ids.join(", ")}`);
      printNext(ctx);
      return;
    }
    if (action === "add") {
      const text = pos.join(" ");
      const kind = flag(rest, "--kind") ?? "happy";
      if (!text) throw new UsageError('usage: gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface|performance|click>');
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
      const ranPart = flag(rest, "--ran");
      const byClick = rest.includes("--click");
      const afterClick = flag(rest, "--click");
      const named = byClick ? /^events#(\d+)$/.exec(afterClick ?? "") : null;
      if (byClick && !named && /^(?:events#|\d)/.test(afterClick ?? "")) throw new UsageError(`--click names a click as events#<seq>, not "${afterClick}"`);
      if (!id || (!testPtr && !na && !byClick && !ranPart)) throw new UsageError('usage: gate case close <id> --test <file:testname> | --ran "<part of the command>" | --click [events#<seq>] | --na "<reason>" [--user-ok "<their words>"]');
      const kind = open(ctx).ledger.cases.find((c) => c.id === id)?.kind;
      if (kind === "click" && (testPtr || ranPart)) throw new UsageError(`${id} is a click case: a test or a run does not close it. Click the control in the real app after the last edit, then \`gate case close ${id} --click\` (or \`--na "<reason>"\`).`);
      if (byClick && kind && kind !== "click") throw new UsageError(`${id} is a ${kind} case: --click closes a click case only`);
      const state = byClick && !na ? buildState(ctx, {}) : null;
      let shared = [];
      const taken = withLedger(ctx, (ledger) => {
        const row = ledger.cases.find((c) => c.id === id);
        if (!row) throw new UsageError(`no case ${id}`);
        if (testPtr) shared = ledger.cases.filter((c) => c.id !== id && c.status === "closed" && c.test === testPtr).map((c) => c.id);
        const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
        const config = loadConfig(ctx.root, ledger.repos ?? []);
        if (testPtr && newRules(ledger)) {
          const file = pointerFile(testPtr);
          if (!file) throw new UsageError(`${id}: "${testPtr}" names no test file. Close on the test as <file:name> or <file:line>.`);
          if (!existsSync(path.resolve(ctx.root, file))) throw new UsageError(`${id}: ${file} does not exist. Write the test first, then close the case on it.`);
        }
        let saidWords = null;
        if (na && newRules(ledger)) {
          // an edit from before this run opened, kept by an abandoned run, is not this run's code
          const first = firstCodeEdit({ events, config, ledger }, ledger.openedSeq ?? 0);
          if (!first || row.seq < first.seq) {
            const tell = 'a case written before the code goes N/A only on the user\'s word: ask them, then pass --user-ok "<their words, at least three>", or close it on a test or a run (--ran)';
            saidWords = flag(rest, "--user-ok")?.trim() ?? null;
            if (!saidWords || saidWords.startsWith("--")) throw new UsageError(`${id}: ${tell}`);
            const problem = wordsShapeProblem(saidWords);
            if (problem) throw new UsageError(`${id}: ${problem}. ${tell}`);
            if (!saidSince(notRecommended(events), row.seq, saidWords)) throw new UsageError(`${id}: the user did not say "${saidWords}" after this case was written: ${tell}`);
          }
        }
        let run = null;
        if (ranPart) {
          if (ranPart.trim().length < 4) throw new UsageError("--ran needs at least four characters of the command or url, enough to name one run");
          const state = { ledger, events, config };
          // one run closes one case: nothing else ties a run to what the case claims
          const taken = new Set(ledger.cases.filter((c) => c.id !== id && c.ran).map((c) => c.event));
          run = apiCalls(state, lastEditSeq(state, config, ledger)).filter((e) => !e.reused && !taken.has(`events#${e.seq}`) && ranText(e).includes(ranPart)).pop();
          if (!run) throw new UsageError(`${id}: no recorded run of yours after the last edit that names "${ranPart}" and that no other case holds. Run it (a failed, background, read-only or helper's run does not count), then close on it.`);
        }
        let event = null;
        if (state) {
          // one event closes one case: two controls need two clicks
          const held = new Set(ledger.cases.filter((c) => c.id !== id && c.event && c.kind === "click").map((c) => c.event));
          const after = lastEditSeq(state, state.config, state.ledger);
          // a green e2e run clicks every control it reaches, so no case holds it for itself
          const free = clickEvents(state, after).filter((e) => e.viaVerify || !held.has(`events#${e.seq}`));
          const driven = free.filter((e) => e.viaVerify).pop();
          // one click case open: every click since the edit was on its way to that control
          const openClicks = ledger.cases.filter((c) => c.kind === "click" && caseOpen(c, after)).length;
          if (named) {
            event = free.find((e) => e.seq === Number(named[1]));
            if (!event) throw new UsageError(`${id}: events#${named[1]} is not a click of yours after the last edit that no other case holds.${free.length ? ` Unclaimed: ${free.map(clickLine).join("; ")}.` : ""}`);
          } else if (driven) {
            event = driven;
          } else if (free.length > 1 && openClicks > 1) {
            throw new UsageError(`${id}: ${free.length} clicks after the last edit are unclaimed, and the gate cannot tell which one was this case's control: ${free.map(clickLine).join("; ")}. Name it: \`gate case close ${id} --click events#<seq>\`.`);
          } else event = free.pop();
          if (!event) throw new UsageError(`${id}: no click of yours after the last edit that another case does not already hold. Click the link, button or tab in the real app (left_click or form_input; navigate, screenshot, javascript_tool and a helper's click do not count)${driverCommand(state.config) !== null ? `, or run \`${driverCommand(state.config)}\` green` : ""}, then run this again.`);
        }
        delete row.ran;
        delete row.words;
        Object.assign(row, { test: testPtr ?? null, na: na ?? null, ...(saidWords ? { words: saidWords } : {}), ...(row.kind === "click" ? { event: event ? `events#${event.seq}` : null } : {}), ...(run ? { event: `events#${run.seq}`, ran: ranText(run).slice(0, 120) } : {}), status: "closed", closedSeq: nextSeq() });
        return event;
      });
      ctx.out(taken ? `${id} closed by ${clickLine(taken)}` : `${id} closed`);
      if (shared.length) ctx.out(`note: ${testPtr} also closes ${shared.join(", ")}; the reviewer is asked whether it can fail for each case on its own`);
      printNext(ctx);
      return;
    }
    if (action === "amend") {
      const [id, ...words] = pos;
      const text = words.join(" ").trim();
      if (!id || !text) throw new UsageError('usage: gate case amend <id> "<the corrected case>"');
      withLedger(ctx, (ledger) => {
        const row = ledger.cases.find((c) => c.id === id);
        if (!row) throw new UsageError(`no case ${id}`);
        // seq stays: the case table is dated by when the case was first written (R2)
        row.history = [...(row.history ?? []), { text: row.case, seq: nextSeq() }];
        Object.assign(row, { case: text, test: null, na: null, status: "open" });
        delete row.event;
        delete row.ran;
        delete row.words;
        delete row.closedSeq;
      });
      ctx.out(`${id} amended and open again; the report keeps the earlier text`);
      printNext(ctx);
      return;
    }
    throw new UsageError("usage: gate case add|amend|close ...");
  },

  step(ctx) {
    const [ref, stateWord, ...rest] = ctx.args;
    const note = positional(rest).join(" ");
    let evidence = flag(rest, "--evidence");
    const ran = flag(rest, "--ran");
    const states = { done: "DONE", skipped: "SKIPPED", na: "N/A", "n/a": "N/A" };
    const state = states[String(stateWord).toLowerCase()];
    if (!ref || !state) throw new UsageError('usage: gate step <n|key> <done|skipped|na> "<note>" [--evidence <pointer> | --ran "<part of the command or url>"]');
    // the check's N/A is judged on the size measured now, not the last one saved
    const naKey = state === "N/A" ? open(ctx).ledger.steps.find((s) => s.key === ref || String(s.n) === ref)?.key : null;
    const checkNa = naKey === "skeptic" || naKey === "review";
    const gateState = state === "DONE" || checkNa ? buildState(ctx, {}) : null;
    let by = null;
    withLedger(ctx, (ledger, dir) => {
      const step = ledger.steps.find((s) => s.key === ref || String(s.n) === ref);
      if (!step) throw new UsageError(`no step "${ref}"`);
      if (step.key === "close") throw new UsageError("step {close} is closed by `gate close`, which closes the run once `gate check` is clean; run `gate close`");
      if (state === "SKIPPED" && step.key && EVIDENCED_KEYS.has(step.key)) {
        throw new UsageError(`step {${step.key}} has script/agent evidence and cannot be SKIPPED — ${Object.hasOwn(NO_WAIVER, step.key) ? `it has no waiver either. ${NO_WAIVER[step.key]}.` : step.key === "tests" && newRules(ledger) ? 'write them; `gate step tests na "<why>"` when this change holds no code (config, lockfile, CSS, images, docs). A code change with no test has no waiver' : `do it,${step.key === "tests" ? ' close it `gate step tests na "<why>"` when this change touches no source file,' : ""} or get the user's waiver with \`gate waive ${step.key} "<reason>" --user-ok "<their words>"\``}`);
      }
      if (step.key === "context" && ledger.lookups) throw new UsageError('step {context} is closed by `gate note context "Traced: … · Related: … · Research: …"` after you search the code and memory yourself; run that instead.');
      if (state === "N/A" && (step.key === "repro" || step.key === "rootcause")) {
        throw new UsageError(`step {${step.key}} cannot be N/A: a bug fix with no ${step.key === "repro" ? "reproduction" : "root cause"} is a guess. Do it, or get the user's waiver with \`gate waive ${step.key} "<reason>" --user-ok "<their words>"\``);
      }
      if (state === "N/A" && step.key === "skeptic" && newRules(ledger) && tiered(ledger)) {
        const policy = policyFor(ledger);
        const size = effectiveTier(policy, ledger, gateState?.tier?.measured ?? tierOf(ledger).measured);
        if (requiredSteps(policy, size, ledger).includes("skeptic")) throw new UsageError(`step {skeptic} cannot be N/A at size ${size}: the plan check is owed there. Run it (\`gate brief skeptic\`), or get the user's waiver with \`gate waive skeptic "<reason>" --user-ok "<their words>"\``);
      }
      if (state === "N/A" && step.key === "review" && gateState && tiered(ledger)) {
        const policy = policyFor(ledger);
        const size = effectiveTier(policy, ledger, gateState.tier?.measured ?? tierOf(ledger).measured);
        const owed = (gateState.changed ?? []).some((p) => gateState.config.isSource(p) && !gateState.config.isTest(p)) && requires(policy, size).includes("reviewer");
        if (owed && !uiTrial(gateState)) throw new UsageError(`step {review} cannot be N/A at size ${size}: the review is owed. Only the UI trial skips it, for a looks-only change where every changed file is UI or a stylesheet and none is server, API, schema or high-risk code; otherwise run the review, or get the user's waiver with \`gate waive review "<reason>" --user-ok "<their words>"\``);
        if (owed) step.trial = true;
      }
      if (state === "N/A" && newRules(ledger) && SURFACE_KEYS.has(step.key)) {
        // the tree alone: a full assess here would reopen the N/A steps it judges as a next check does
        const repos = ledger.repos ?? [];
        const tree = snapshot(ctx.root, loadSession(ctx.stateDir, ctx.session)?.lastTree ?? ledger.baseline, repos);
        const owed = stepSurfaceFiles(step.key, ledger, loadConfig(ctx.root, repos), diffSnapshots(ledger.baseline, tree).changed);
        if (owed.length) throw new UsageError(`step {${step.key}} cannot be N/A: ${owed.slice(0, 5).join(", ")} changed. Do it, or get the user's waiver with \`gate waive ${step.key} "<reason>" --user-ok "<their words>"\``);
      }
      const onCall = state === "DONE" && step.key === "driver" && apiFiles(ledger, gateState.config, gateState.changed).length > 0;
      if (state === "DONE" && (RUN_KEYS.has(step.key) || onCall)) {
        const runs = onCall ? apiCalls(gateState, lastEditSeq(gateState, gateState.config, ledger)) : ranEvents(gateState);
        if (ran !== undefined && ran !== null && ran.trim().length < 4) throw new UsageError("--ran needs at least four characters of the command or url, enough to name one run");
        by = (ran ? runs.filter((e) => ranText(e).includes(ran)).pop() : runs.find((e) => `events#${e.seq}` === evidence)) ?? null;
        if (!by) throw new UsageError(`step {${step.key}} closes on a run the gate recorded, not on a note: run it (the Bash tool, the browser or the /verify driver) after ${onCall ? "the last edit" : "this run opened"}, then \`gate step ${step.key} done "<what it showed>" --ran "<part of the command or url>"\` (the gate keeps the first 200 characters of a command; a background run, a read of the code and a memory, docs or code-search lookup do not count)`);
        if (step.key === "rootcause" && !tracedPointers(note, ctx.root, ctx.repos).some((p) => p.exists)) {
          throw new UsageError("step {rootcause}: the note names the line at fault as a file:line that resolves; a cause with no line is a guess");
        }
        evidence = `events#${by.seq}`;
      } else if (state === "DONE") {
        if (!evidence) throw new UsageError("DONE needs --evidence <pointer> (events#seq, verify.json, review-<n>.md, decisions#n, or a file path)");
        if (!pointerResolver(gateState)(evidence)) throw new UsageError(`step evidence "${evidence}" does not resolve; point at a file, a file:line, ledger.md#<section>, verify.json, events#<seq>, decisions#<n> or a helper file`);
      }
      if (state !== "DONE" && !note) throw new UsageError(`${state} needs a reason`);
      // the design huddle is done when its newest file is finished and recorded and every
      // finding in it is answered, not when the lead says so
      const unanswered = state === "DONE" && step.key === "skeptic" ? checkAnswered(ledger, dir) : null;
      if (unanswered) throw new UsageError(unanswered);
      delete step.auto;
      Object.assign(step, { state, note: note || null, evidence: evidence ?? null, seq: nextSeq() });
    });
    ctx.out(by ? `step ${ref} → ${state} by \`${ranText(by).slice(0, 80)}\`${by.exit == null ? "" : ` exit ${by.exit}`} (events#${by.seq})` : `step ${ref} → ${state}`);
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
      const prefix = { skeptic: "skeptic", worker: "worker", "reviewer-2": "review2" }[role] ?? "review";
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
        if (!existsSync(full)) throw new UsageError(`${file} is not there: the helper left no file. Nothing recorded. Run \`gate brief ${role}\` again and spawn a fresh helper.`);
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
        refuseSkipped(ctx, dir, ledger, file);
      }
      const reviewing = role === "reviewer" || role === "reviewer-2";
      const same = (a, b) => String(a).toLowerCase().replace(/\s+/g, " ").trim() === String(b).toLowerCase().replace(/\s+/g, " ").trim();
      const { id, answered, added, question } = withLedger(ctx, (ledger, dir) => {
        // adding the same file again re-reads it into the same huddle instead of a new round
        let huddle = file ? ledger.huddles.find((h) => h.role === role && h.file === file) : null;
        const seen = file ? ledger.seen?.[file] : null;
        const seenFacts = () => Array.isArray(seen?.files)
          ? { files: seen.files, briefSeq: seen.seq, ...(seen.units ? { units: seen.units } : {}), ...(seen.at ? { at: seen.at } : {}), ...(seen.edges ? { edges: seen.edges } : {}), ...(seen.fixCheck ? { fixCheck: true } : {}), ...(seen.part ? { part: true } : {}), ...(seen.answers ? { answers: true } : {}), ...(seen.disputes ? { disputes: seen.disputes } : {}), ...(seen.flats ? { flats: seen.flats } : {}), ...(seen.notes ? { notes: seen.notes } : {}), ...(seen.late ? { late: seen.late } : {}) }
          : {};
        // a round whose file was lost and briefed again takes what the newer brief showed
        if (huddle && seen?.seq > (huddle.briefSeq ?? Infinity)) {
          for (const key of ["files", "briefSeq", "units", "at", "edges", "fixCheck", "part", "answers", "disputes", "flats", "notes", "late"]) delete huddle[key];
          Object.assign(huddle, seenFacts());
        }
        if (!huddle) {
          const id = `H${ledger.huddles.length + 1}`;
          const round = ledger.huddles.filter((h) => h.role === role).length + 1;
          huddle = { id, role, round, file, summary: flag(rest, "--summary") ?? null, actOn: [], seq: nextSeq() };
          // from the brief that named this file: a re-add of the same brief never widens it
          Object.assign(huddle, seenFacts());
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
            const cited = tracedPointers(f.text, ctx.root, ctx.repos);
            if (cited.length && !cited.some((p) => p.exists)) item.unresolved = cited.map((p) => `${p.file}:${p.line}`);
            huddle.actOn.push(item);
            added.push(item);
          });
          if (reviewing) {
            const cant = sectionBullets(text, "Can't verify");
            if (cant.length) huddle.cantVerify = cant;
            else delete huddle.cantVerify;
          }
          const item = (aid) => ledger.huddles.flatMap((h) => h.actOn).find((a) => a.id === aid);
          for (const d of parseDisputes(text)) {
            const a = item(d.id);
            if (!a || !a.dispute) continue;
            a.dispute.verdict = d.verdict;
            a.dispute.reviewerReason = d.reason;
            a.dispute.answeredSeq = nextSeq();
            if (d.verdict === "withdrawn" && !a.closed) {
              a.closed = `withdrawn (${file})`;
              a.closedSeq = nextSeq();
            }
            answered += 1;
          }
          // a dispute this round's packet listed and its file left out stands as upheld
          const replied = new Set(parseDisputes(text).map((d) => d.id));
          for (const aid of huddle.disputes ?? []) {
            const a = item(aid);
            if (!a?.dispute || a.dispute.verdict || a.closed || replied.has(aid)) continue;
            Object.assign(a.dispute, { verdict: "upheld", reviewerReason: `not answered in ${file}` });
          }
        }
        if (role === "skeptic") settleCheck(ledger, dir);
        const question = role === "skeptic" && text !== null && ledger.steps.find((s) => s.key === "skeptic")?.state === null ? oneQuestion(text) : null;
        // inside the ledger's lock, so two reviewer adds at once cannot drop a lesson
        if (text !== null && reviewing) addLessons(ctx.stateDir, sectionBullets(text, "Lessons"));
        return { id, answered, added, question };
      });
      ctx.out(`${id} added (${role})${added.length ? ` · ${added.length} Act-on item${added.length === 1 ? "" : "s"} recorded` : ""}${answered ? ` · ${answered} dispute${answered === 1 ? "" : "s"} answered` : ""}`);
      // the ids the worker and the reviewer will be asked about, next to what each one says
      for (const a of added) ctx.out(`${a.id} — ${a.text}`);
      for (const a of added.filter((x) => x.unresolved)) ctx.out(`note: ${a.id} cites ${a.unresolved.join(", ")}, which does not resolve: check the claim yourself before acting on it`);
      if (question) ctx.out(`The one question: ${question} Ask the user with AskUserQuestion before any code; once every item is answered, \`gate step skeptic done "<their answer>" --evidence ${file}\`.`);
      printNext(ctx);
      return;
    }
    if (action === "unchanged") {
      const [list, ...words] = pos;
      const why = words.join(" ").trim();
      if (!list || !why) throw new UsageError('usage: gate huddle unchanged <path[:from-to],...> "<why behaviour did not change>"');
      const state = buildState(ctx, {});
      if (!state.ledger) throw new UsageError("no open ledger for this session");
      if (state.policy.lateLines !== "call") throw new UsageError("this run's pinned policy has no calls on late lines: lines changed after review are covered as before");
      const owed = ["reviewer", "reviewer-2"].flatMap((r) => uncovered(state, r) ?? []);
      const sawn = new Set(state.ledger.huddles.filter((h) => (h.role === "reviewer" || h.role === "reviewer-2") && !h.answers).flatMap((h) => (h.files ?? []).map(pathOf)));
      const inside = (a, b) => !a.from || !b.from || (a.from <= b.to && b.from <= a.to);
      const entries = list.split(",").map((t) => t.trim()).filter(Boolean);
      const keys = {};
      const kept = {};
      let count = 0;
      for (const entry of entries) {
        const e = parseEntry(entry);
        const rel = toPosixRel(ctx.root, e.path, state.repos);
        if (!rel || !sawn.has(rel)) throw new UsageError(`${entry}: no round saw ${rel ?? e.path}; a file no review has read needs a round, not a reason`);
        const mine = owed.map(parseEntry).filter((u) => u.path === rel && inside(u, e));
        if (!mine.length) throw new UsageError(`${entry}: none of these lines owe a review (\`gate check\` lists what does)`);
        const units = changedUnitsOf(state, rel).filter((u) => (!e.from || (u.pos >= e.from && u.pos <= e.to)) && mine.some((m) => !m.from || (u.pos >= m.from && u.pos <= m.to)));
        keys[rel] = [...(keys[rel] ?? []), ...units.map((u) => u.key)];
        // the whole file: what it held now, so a deletion made later is not excused with it
        if (!e.from) kept[rel] = changedUnitsOf(state, rel).map((u) => u.key);
        count += units.length;
      }
      withLedger(ctx, (ledger) => {
        ledger.unchanged = [...(ledger.unchanged ?? []), { entries, files: Object.keys(keys), keys, ...(Object.keys(kept).length ? { kept } : {}), why, seq: nextSeq() }];
      });
      ctx.out(`unchanged: ${count} line${count === 1 ? "" : "s"} in ${entries.join(", ")} — ${why}; the report lists it`);
      printNext(ctx);
      return;
    }
    if (action === "reopen") {
      const [aid, ...why] = pos;
      const reason = why.join(" ").trim();
      if (!aid || !reason) throw new UsageError('usage: gate huddle reopen <H#.#> "<why the close does not hold>"');
      withLedger(ctx, (ledger) => {
        const item = ledger.huddles.flatMap((h) => h.actOn).find((a) => a.id === aid);
        if (!item) throw new UsageError(`no act-on item ${aid}`);
        if (!item.closed) throw new UsageError(`${aid} is open: there is no close to take back`);
        const { closed, wrong, dispute } = item;
        item.reopened = [...(item.reopened ?? []), { closed, ...(wrong ? { wrong } : {}), ...(dispute ? { dispute } : {}), why: reason, seq: nextSeq() }];
        item.closed = null;
        for (const key of ["closedSeq", "closedBy", "wrong", "dispute"]) delete item[key];
      });
      ctx.out(`${aid} reopened: ${reason}`);
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
      const wrong = rest.includes("--wrong");
      const words = flag(rest, "--words")?.trim() || null;
      if (!aid || (!evidence && !(wrong && words))) throw new UsageError('usage: gate huddle resolve <H#.#> --evidence <pointer> | --wrong --evidence events#<seq> | --wrong --words "<the user\'s words>"');
      const state = buildState(ctx, {});
      const found = state.ledger?.huddles.flatMap((h) => h.actOn).find((a) => a.id === aid);
      if (found?.closed) throw new UsageError(`${aid} is already closed (${found.closed}); \`gate huddle reopen ${aid} "<why>"\` takes the close back first`);
      if (wrong) {
        if (evidence && words) throw new UsageError(`${aid}: --wrong takes a run (--evidence events#<seq>) or the user's words (--words), not both`);
        closeAsWrong(ctx, state, found, aid, evidence, words);
        return;
      }
      const proof = found ? proofProblem(state, found, evidence) : undefined;
      if (proof) throw new UsageError(`${aid}: on this run ${proof}`);
      if (proof === undefined && !pointerResolver(state)(evidence)) throw new UsageError(`resolve evidence "${evidence}" does not resolve; point at a test (file:name), a file:line, ledger.md#<section>, verify.json, events#<seq> or a helper file`);
      withLedger(ctx, (ledger, dir) => {
        const item = ledger.huddles.flatMap((h) => h.actOn).find((a) => a.id === aid);
        if (!item) throw new UsageError(`no act-on item ${aid}`);
        item.closed = evidence;
        item.closedSeq = nextSeq();
        settleCheck(ledger, dir);
      });
      ctx.out(`${aid} resolved`);
      printNext(ctx);
      return;
    }
    if (action === "reply") {
      const file = flag(rest, "--file");
      if (!file || !/^worker-\d+\.md$/.test(file)) throw new UsageError("usage: gate huddle reply --file worker-<n>.md (the worker's own file in the run dir)");
      const { dir, ledger } = open(ctx);
      if (!existsSync(path.join(dir, file))) throw new UsageError(`gate huddle reply: ${file} does not exist in the run dir; the worker must write it first`);
      refuseSkipped(ctx, dir, ledger, file);
      const text = readFileSync(path.join(dir, file), "utf8");
      const replies = parseReplies(text);
      const shape = "'H<k>.<i> — fixed: <ptr>' or 'H<k>.<i> — disagree: <why> — <ptr>'";
      if (!replies.length) throw new UsageError(`${file} has no '## Replies' lines of the form ${shape}`);
      const bulletCount = parseFindings(text.replace(/^## Replies\s*$/m, "## Act on")).length;
      if (bulletCount > replies.length) throw new UsageError(`${file}: ${bulletCount - replies.length} line(s) under ## Replies do not read ${shape}; every bullet must be a reply`);
      const state = buildState(ctx, {});
      const resolves = pointerResolver(state);
      const lines = [];
      withLedger(ctx, (ledger, dir) => {
        const items = ledger.huddles.flatMap((h) => h.actOn);
        // validate every line first, so a bad reply changes nothing
        for (const r of replies) {
          const a = items.find((x) => x.id === r.id);
          if (!a) throw new UsageError(`no act-on item ${r.id} (open: ${items.filter((x) => !x.closed).map((x) => x.id).join(", ") || "none"})`);
          if (a.closed) continue;
          // a fix is shown by a test, a source line, verify.json or an event, never by the
          // worker's own reply file or a packet
          const proof = r.kind === "fixed" ? proofProblem(state, a, r.pointer) : undefined;
          if (proof) throw new UsageError(`${r.id} fixed: on this run ${proof}`);
          if (r.kind === "fixed" && proof === undefined && (/^(?:worker|brief)-/.test(r.pointer) || !resolves(r.pointer))) throw new UsageError(`${r.id} fixed: pointer "${r.pointer}" does not resolve; point at a test (file:name), a file:line, ledger.md#<section>, verify.json or events#<seq>`);
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
        settleCheck(ledger, dir);
      });
      for (const l of lines) ctx.out(l);
      printNext(ctx);
      return;
    }
    throw new UsageError("usage: gate huddle add|acton|resolve|reopen|dispute|reply|unchanged ...");
  },

  waive(ctx) {
    if (ctx.args.includes("--end")) {
      endStanding(ctx, flag(ctx.args, "--end"));
      return;
    }
    const [named, ...why] = positional(ctx.args);
    const reason = why.join(" ").trim();
    if (ctx.args.includes("--standing")) {
      if (!named) throw new UsageError('usage: gate waive <key> --standing "<batch>" --user-ok "<the user\'s words>"');
      waiveStanding(ctx, /^R\d+$/.test(named) ? Object.keys(WAIVERS).find((k) => WAIVERS[k] === named) ?? named : named, flag(ctx.args, "--standing"), flag(ctx.args, "--user-ok"), reason);
      return;
    }
    const usage = 'usage: gate waive <key|stepKey|R#> "<why>" --user-ok "<their words>"';
    if (!named || !reason) throw new UsageError(usage);
    const words = flag(ctx.args, "--user-ok");
    if (ctx.args.includes("--user-ok") && (!words?.trim() || words.startsWith("--"))) throw new UsageError(usage);
    const byRule = /^R\d+$/.test(named);
    const key = byRule ? Object.keys(WAIVERS).find((k) => WAIVERS[k] === named) : named;
    const valid = `valid keys: ${Object.keys(WAIVERS).filter((k) => k !== "qa").map((k) => `${k} (${WAIVERS[k]})`).join(", ")}`;
    if (byRule && !key) throw new UsageError(`${named} has no waiver: do what \`gate check\` says for it. ${valid}`);
    const couldNot = ctx.args.includes("--could-not-run");
    if (couldNot && key !== "driver" && key !== "schema") throw new UsageError(`--could-not-run is for a surface that cannot run: driver or schema, not ${key}`);
    if (Object.hasOwn(NO_WAIVER, key)) throw new UsageError(`${key} cannot be waived: a rule with no waiver would still block behind the step. ${NO_WAIVER[key]}.`);
    const flagged = key === "slop" ? slopHits(buildState(ctx, {})).map((h) => h.key) : null;
    if (flagged && !flagged.length) throw new UsageError("gate waive slop: the slop check flags no line in this task's diff that a waiver does not already cover; there is nothing to waive");
    // an edit no hook saw is dated to an older command on the assess that finds it: words cannot predate it
    const hashBefore = ON_CODE.has(key) ? open(ctx).ledger.lastSourceHash : null;
    if (ON_CODE.has(key)) buildState(ctx, {});
    const clears = withLedger(ctx, (ledger) => {
      const step = ledger.steps.find((s) => s.key === key);
      const rule = Object.hasOwn(WAIVERS, key) ? WAIVERS[key] : null;
      if (!rule && !step) {
        const stepKeys = ledger.steps.map((s) => s.key).filter((k) => k && EVIDENCED_KEYS.has(k) && !Object.hasOwn(NO_WAIVER, k) && !Object.hasOwn(WAIVERS, k));
        throw new UsageError(`unknown waiver key "${key}". ${valid}${stepKeys.length ? `; step keys of this run: ${stepKeys.join(", ")}` : ""}`);
      }
      // a step with no script or agent evidence is closed by hand; a waiver there would clear nothing a rule reads
      if (!rule && !EVIDENCED_KEYS.has(key)) throw new UsageError(`step {${key}} has no waiver: close it with \`gate step ${key} done|skipped|na "<note>"\`. ${valid}`);
      if (couldNot && !newRules(ledger)) throw new UsageError("--could-not-run is for a run opened under the new rules; this one takes a plain waiver");
      if (newRules(ledger) && (key === "tests" || key === "qa") && ledger.steps.some((s) => s.key === "tests")) {
        throw new UsageError(`${key} cannot be waived in this run: a code change with no test has no waiver. Write the tests. (\`qa-pass\` covers only the blind QA pass at size large; a change with no code owes no test.)`);
      }
      if (newRules(ledger)) {
        const tell = 'ask the user, naming what is given up, then pass --user-ok "<their words, at least three>"; a question\'s options must name it too, since an answer holds only the chosen label';
        if (!words) throw new UsageError(`giving up ${key} is the user's call: ${tell}`);
        const problem = waiverWordsProblem(key, words);
        if (problem) throw new UsageError(`gate waive ${key}: ${problem}. ${tell}`);
        const events = notRecommended(ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq));
        if (!userSaid(ledger, events, words)) throw new UsageError(`the user did not say "${words.trim()}" in this task: ${tell}`);
        if (ON_CODE.has(key) && (ledger.lastSourceHash !== hashBefore || !saidSince(events, ledger.lastSourceChangeSeq ?? 0, words))) {
          throw new UsageError(`the user said "${words.trim()}" before the last code edit, about other code: ${tell}`);
        }
      }
      const onCode = newRules(ledger) && LAPSING.has(key) ? { code: ledger.lastSourceHash } : {};
      ledger.waivers.push({ key, reason, ...(words ? { words: words.trim() } : {}), ...onCode, ...(couldNot ? { could: true } : {}), seq: nextSeq(), ...(flagged ? { lines: flagged } : {}) });
      if (step) {
        delete step.auto;
        Object.assign(step, { state: couldNot ? "COULD NOT RUN" : "WAIVED", note: reason, evidence: null, seq: nextSeq() });
      }
      if (flagged) return `the ${flagged.length} slop line${flagged.length === 1 ? "" : "s"} flagged now; a new one is flagged again`;
      return [rule, step ? `step {${key}}` : null].filter(Boolean).join(" and ");
    });
    ctx.out(`waived ${key} (clears ${clears}) — the report will show the reason`);
    const gone = key === "gate-config" ? ctx.repos.filter((r) => !existsSync(r.root)).map((r) => r.prefix) : [];
    if (gone.length) ctx.out(`not cleared: the R13 line for the declared repo ${gone.join(", ")}, whose directory is gone; restore it, or ask the user whether to give the run up`);
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

  // Takes the changes the task did not write itself (another terminal's edit, a stash pop) out
  // of it; what it wrote is kept and named, and the reason is reported.
  rebaseline(ctx) {
    const reason = ctx.args.join(" ").trim();
    if (!reason) throw new UsageError('usage: gate rebaseline "<why, with the user\'s OK>"');
    const state = buildState(ctx, {});
    const paths = state.changed.filter((p) => state.config.isSource(p));
    const split = (holder) => {
      // seq is wall-clock microseconds, so the baseline's seq dates the other logs worth reading
      const since = holder.baseline?.seq ?? holder.openedSeq ?? 0;
      const others = otherSessionsEvents(ctx.stateDir, state.ledger?.sessions ?? [ctx.session], new Date(since / 1000).toISOString());
      const own = ownWrites(holder, state.events, state.now, paths, others);
      // a command that chains git with something else claims every file the move wrote: take back
      // what git brought, unless the last writer ran no git (a conflict fixed with sed)
      const brought = state.ledger ? broughtSinceOpen(ctx.root, holder, state.events) : null;
      const chained = brought ? paths.filter((p) => own.has(p) && brought.has(p) && !editedIn(state.events, since, p) && writersOf(state.events, since, state.now.files[p]?.m).every((e) => e.git)) : [];
      const taken = new Set(cleanAtHead(ctx.root, chained, state.now, holder.repos ?? []));
      const fold = paths.filter((p) => !own.has(p) || taken.has(p));
      const kept = paths.filter((p) => own.has(p) && !taken.has(p));
      if (!fold.length) throw new UsageError(`gate rebaseline: no changed source file to take in${kept.length ? `; ${list(kept)} ${kept.length === 1 ? "was" : "were"} written by this ${state.ledger ? "run" : "session"} and stay${kept.length === 1 ? "s" : ""} its own` : ""}`);
      foldIntoBaseline(holder, fold, state.now, state.config);
      return { fold, kept };
    };
    let result;
    if (state.ledger) {
      result = withLedger(ctx, (ledger) => {
        const r = split(ledger);
        ledger.rebaselines = [...(ledger.rebaselines ?? []), { at: new Date().toISOString(), seq: nextSeq(), reason, paths: r.fold }];
        return r;
      });
    } else {
      const session = loadSession(ctx.stateDir, ctx.session);
      const holder = { baseline: session.baseline, openedSeq: session.baselineSeq ?? 0 };
      result = split(holder);
      saveSession(ctx.stateDir, { ...session, baseline: holder.baseline });
      appendEvents(ctx.stateDir, ctx.session, [{ seq: nextSeq(), ts: new Date().toISOString(), session: ctx.session, agent: null, agentType: null, kind: "rebaseline", reason, paths: result.fold }]);
    }
    ctx.out(`starting point moved for ${list(result.fold)}: no longer this ${state.ledger ? "run's" : "session's"} change — the report will show the reason`);
    if (result.kept.length) ctx.out(`kept (written by this ${state.ledger ? "run" : "session"}): ${list(result.kept)}`);
    if (state.ledger) printNext(ctx);
  },

  // The user gives up on a task: the ledger is marked abandoned with the reason, so it no
  // longer attaches to later sessions or blocks their turns. Nothing is finalised: the
  // baseline stays, so the next ledger still sees the changes this one left behind.
  abandon(ctx) {
    const [slug, ...rest] = positional(ctx.args);
    const reason = rest.join(" ").trim();
    if (!slug || !reason) throw new UsageError('usage: gate abandon <slug> "<why>" --user-ok "<the user\'s words>"');
    const found = findRun(ctx.stateDir, slug);
    if (!found) throw new UsageError(`no open run for slug "${slug}" (a closed or abandoned run cannot be abandoned)`);
    const { dir, ledger } = found;
    if (!emptyRun(ctx, dir, ledger)) abandonWords(ctx, dir, ledger, flag(ctx.args, "--user-ok"));
    ledger.status = "abandoned";
    ledger.abandonedAt = new Date().toISOString();
    ledger.abandonReason = reason;
    ledger.abandonedBy = ctx.session;
    saveLedger(dir, ledger);
    const name = path.basename(dir);
    const session = loadSession(ctx.stateDir, ctx.session);
    const lastTree = session?.lastTree && ledger.repos?.length ? { lastTree: withoutRepos(session.lastTree, ledger.repos) } : {};
    if (session) saveSession(ctx.stateDir, { ...session, ...lastTree, current: session.current === name ? null : session.current, lastClosed: name, ...(ledger.sessions?.includes(ctx.session) ? { runEndSeq: nextSeq() } : {}) });
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
      for (const line of unmetLines(unmet)) ctx.out(line);
      throw new UsageError(`not closed: ${unmetCount(unmet)} unmet`);
    }
    const ledger = finalise(ctx, state);
    ctx.out(`${ledger.slug} closed`);
    ctx.out("next: `gate report --brief`, pasted as your final message");
  },
};
