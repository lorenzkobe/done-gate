import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./context.mjs";
import { nextSeq, readEvents } from "./events.mjs";
import { openRuns, refuseElsewhere, saveLedger } from "./ledger.mjs";
import { lapseWaiver, notRecommended, saidSince, waiverWordsProblem } from "./rules.mjs";
import { loadSession } from "./session-state.mjs";

// One OK from the user for a named batch of runs. It lives beside the runs rather than in one, the
// fence guards the file like the rest of the evidence, and each run in the batch lists what it took.
const WINDOW_MS = 14 * 864e5;
// tests have no waiver, and a slop waiver covers lines seen at the time, which a batch has no way to name
const ALLOWED = new Set(["driver", "review", "review-2", "schema", "qa-pass", "lookups", "coverage"]);

const fileOf = (stateDir) => path.join(stateDir, "standing.json");

function readEntries(stateDir) {
  const file = fileOf(stateDir);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")).entries ?? [];
  } catch {
    return [];
  }
}

function writeEntries(stateDir, entries) {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${fileOf(stateDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
  renameSync(tmp, fileOf(stateDir));
}

const liveEntries = (stateDir) => readEntries(stateDir).filter((e) => Date.parse(e.until) > Date.now());

export function waiveStanding(ctx, key, batch, words, reason) {
  if (!batch?.trim() || batch.startsWith("--")) throw new UsageError('usage: gate waive <key> --standing "<batch>" --user-ok "<the user\'s words>"');
  if (!ALLOWED.has(key)) throw new UsageError(`${key} takes no standing waiver: it has to be earned or given run by run. A standing waiver takes ${[...ALLOWED].join(", ")}.`);
  refuseElsewhere(ctx, ["waive", key, "--standing", batch, ...(words ? ["--user-ok", words] : [])]);
  const tell = `ask the user, naming the check and the batch "${batch}", then pass --user-ok "<their words, at least three>"`;
  if (!words?.trim() || words.startsWith("--")) throw new UsageError(`a standing waiver is the user's call: ${tell}`);
  const problem = waiverWordsProblem(key, words);
  if (problem) throw new UsageError(`gate waive ${key} --standing: ${problem}. ${tell}`);
  if (!words.toLowerCase().includes(batch.toLowerCase())) throw new UsageError(`gate waive ${key} --standing: "${words.trim()}" does not name the batch ${batch}. ${tell}`);
  const events = notRecommended(readEvents(ctx.stateDir, ctx.session));
  if (!saidSince(events, loadSession(ctx.stateDir, ctx.session)?.baselineSeq ?? 0, words)) throw new UsageError(`the user did not say "${words.trim()}" in this session: ${tell}`);
  const at = new Date();
  const until = new Date(at.getTime() + WINDOW_MS).toISOString();
  const rest = readEntries(ctx.stateDir).filter((e) => e.key !== key || e.batch !== batch);
  writeEntries(ctx.stateDir, [...rest, { key, batch, reason: reason || `standing waiver for batch ${batch}`, words: words.trim(), at: at.toISOString(), until }]);
  ctx.out(`standing waiver: ${key} for batch ${batch}, until ${until.slice(0, 10)}. A run joins with \`gate open <slug> <playbook> --batch ${batch}\`; each report lists it, and \`gate waive --end ${batch}\` stops it.`);
}

// The refusal for a batch with nothing live, before a run opens on it.
export function requireLiveBatch(stateDir, batch) {
  const live = liveEntries(stateDir);
  if (live.some((e) => e.batch === batch)) return;
  const others = [...new Set(live.map((e) => e.batch))];
  throw new UsageError(`no live standing waiver for batch ${batch}${others.length ? ` (live: ${others.join(", ")})` : ""}. Open it with no --batch, or ask the user for one with \`gate waive <key> --standing "<batch>" --user-ok "<their words>"\`.`);
}

// A copy holds for the run it went into until the entry's 14 days end: it names no code, so an edit
// does not lapse it; `gate waive --end` takes it back sooner.
export function carryStanding(ctx, dir, ledger, batch) {
  const taken = liveEntries(ctx.stateDir).filter((e) => e.batch === batch);
  ledger.batch = batch;
  for (const e of taken) {
    ledger.waivers.push({ key: e.key, reason: e.reason, words: e.words, batch, until: e.until, seq: nextSeq() });
    const step = ledger.steps.find((s) => s.key === e.key);
    if (step) Object.assign(step, { state: "WAIVED", note: e.reason, evidence: null, seq: nextSeq() });
  }
  saveLedger(dir, ledger);
  ctx.out(`standing waiver for batch ${batch}: ${taken.map((e) => e.key).join(", ")}; it holds for this run and the report lists it`);
}

// Copies first, the entry last: a run that cannot be read stops this before anything is lost, and
// running it again finds the batch. An expired entry's copies still count.
export function endStanding(ctx, batch) {
  if (!batch?.trim() || batch.startsWith("--")) throw new UsageError('usage: gate waive --end "<batch>"');
  const runs = openRuns(ctx.stateDir);
  let copies = 0;
  for (const { dir, ledger } of runs) {
    const held = (ledger.waivers ?? []).filter((w) => w.batch === batch && !w.lapsed);
    for (const w of held) lapseWaiver(ledger, w, { ended: true });
    if (held.length) saveLedger(dir, ledger);
    copies += held.length;
  }
  const entries = readEntries(ctx.stateDir);
  const rest = entries.filter((e) => e.batch !== batch);
  if (rest.length === entries.length && !copies) throw new UsageError(`no standing waiver for batch ${batch}`);
  if (rest.length !== entries.length) writeEntries(ctx.stateDir, rest);
  ctx.out(`standing waiver for batch ${batch} ended; ${copies} copy${copies === 1 ? "" : "ies"} in open runs taken back`);
}
