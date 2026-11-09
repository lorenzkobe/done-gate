import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// D1 Part B: a seal (sha1) of each piece of evidence the gate writes, kept outside the repo, so a
// change no gate command or hook made shows at the close. Detection of slips, not a lock: a shell
// that writes the seals too gets past it, and any version the gate once wrote still passes.

const hash = (text) => createHash("sha1").update(text).digest("hex");
const GAPS = "seal-gaps";
// a helper's findings file, sealed as the log hook sees it written
export const FINDINGS = /^(?:review2?|skeptic|arbiter|worker)-\d+\.md$/;
const RUN_FILES = ["ledger.json", "verify.json", "decisions.tsv"];
// the seal goes in before the line: a seal whose line is this new may still be on its way
const ON_ITS_WAY_MS = 5000;

const sealsRoot = () => process.env.DONE_GATE_SEALS || path.join(os.homedir(), ".claude", "done-gate", "seals");
function storeOf(stateDir) {
  let real = path.resolve(stateDir);
  try {
    real = realpathSync(stateDir);
  } catch {
    // a state dir not made yet is keyed by its path
  }
  return path.join(sealsRoot(), hash(real).slice(0, 16));
}
const runStore = (dir, openedSeq) => path.join(storeOf(path.resolve(dir, "..", "..")), `run-${path.basename(dir)}-${openedSeq}.seals`);
const eventStore = (stateDir, session) => path.join(storeOf(stateDir), `events-${session}.seals`);

// One line to the store; when it cannot be written, the gap is noted beside the evidence and that
// evidence is not checked, so a gate with no write access there keeps working.
function append(store, line, gapDir, gapName) {
  try {
    mkdirSync(path.dirname(store), { recursive: true });
    appendFileSync(store, line);
  } catch {
    try {
      appendFileSync(path.join(gapDir, GAPS), `${gapName}\n`);
    } catch {
      // nowhere to note it either; the check reads a missing seals file as not checked
    }
  }
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

// A run file about to be written: what is on disk now is marked when no seal has it, so the
// write that follows cannot hide the change; then the new content is sealed.
// A store that begins mid-run (a moved repo, a cleaned home) takes the files it finds as they are,
// and the report says they were not checked before then.
export function sealRunFile(dir, openedSeq, name, text) {
  const store = runStore(dir, openedSeq);
  const seals = readLines(store);
  const file = path.join(dir, name);
  if (!seals) {
    const found = presentIn(dir);
    if (found.length) append(store, `${found.map((f) => `${f}\t${hash(readFileSync(path.join(dir, f), "utf8"))}\n`).join("")}#adopted\t${new Date().toISOString()}\n`, dir, name);
  } else if (existsSync(file) && (RUN_FILES.includes(name) || seals.some((l) => l.startsWith(`${name}\t`)))) {
    // a run file is there only from a gate write; a findings file the hook did not see written is
    // sealed as recorded (a helper's Write always passes the hook, and R15 asks for the helper's run)
    const now = hash(readFileSync(file, "utf8"));
    if (!seals.includes(`${name}\t${now}`)) append(store, `!${name}\t${now}\n`, dir, name);
  }
  append(store, `${name}\t${hash(text)}\n`, dir, name);
}

// A file a hook saw written, sealed as it is now.
export function sealWritten(dir, name) {
  try {
    const { openedSeq } = JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8"));
    if (openedSeq) append(runStore(dir, openedSeq), `${name}\t${hash(readFileSync(path.join(dir, name), "utf8"))}\n`, dir, name);
  } catch {
    // no run there, or the file is gone again: nothing to seal
  }
}

// every event opens with its seq; a line that does not parse is torn
function seqOf(line) {
  const fast = /^\{"seq":(\d+),/.exec(line);
  try {
    return fast && line.endsWith("}") ? Number(fast[1]) : JSON.parse(line).seq ?? null;
  } catch {
    return null;
  }
}

const presentIn = (dir) => {
  try {
    return readdirSync(dir).filter((f) => RUN_FILES.includes(f) || FINDINGS.test(f));
  } catch {
    return [];
  }
};

export function sealEvents(stateDir, session, lines) {
  const dir = path.join(stateDir, "sessions", String(session ?? "no-session"));
  append(eventStore(stateDir, session ?? "no-session"), lines.map((l) => `${seqOf(l)}\t${hash(l)}\n`).join(""), dir, "events.jsonl");
}

// What changed outside the gate on a run, as {key, text}; the key names the change, so a waiver
// covers the changes it saw. `unchecked` lists what had no seals to compare with.
export function sealProblems({ stateDir, dir, ledger }) {
  const out = [];
  const unchecked = [];
  if (!dir || !stateDir || !ledger?.openedSeq) return withUnchecked(out, unchecked);
  const gaps = new Set(readLines(path.join(dir, GAPS)) ?? []);
  if (gaps.size) unchecked.push(`${[...gaps].join(", ")} (the gate could not keep its seals)`);
  const seals = readLines(runStore(dir, ledger.openedSeq));
  if (!seals) unchecked.push(`the run's files (no seals kept for ${path.basename(dir)})`);
  else {
    const sealed = new Map();
    for (const line of seals) {
      const [name, h] = line.split("\t");
      if (name === "#adopted") unchecked.push(`the run's files before ${h} (its seals began then)`);
      else if (name.startsWith("!")) out.push({ key: `${name.slice(1)}@${h}`, text: `${name.slice(1)} was changed outside the gate before a gate write` });
      else sealed.set(name, (sealed.get(name) ?? new Set()).add(h));
    }
    for (const name of new Set([...presentIn(dir), ...sealed.keys()])) {
      if (gaps.has(name)) continue;
      const file = path.join(dir, name);
      if (!existsSync(file)) {
        out.push({ key: `${name}@removed`, text: `${name} was removed` });
        continue;
      }
      const now = hash(readFileSync(file, "utf8"));
      // a findings file counts from when it was recorded or a hook saw its helper write it; one
      // never recorded is R15's
      if (!sealed.has(name) && FINDINGS.test(name)) continue;
      if (!sealed.get(name)?.has(now)) out.push({ key: `${name}@${now}`, text: sealed.has(name) ? `${name} was changed outside the gate` : `${name} was written outside the gate` });
    }
  }
  for (const session of ledger.sessions ?? []) {
    const file = path.join(stateDir, "sessions", String(session), "events.jsonl");
    const lines = readLines(file);
    if (!lines) continue; // a session folder the gate pruned whole
    if (readLines(path.join(path.dirname(file), GAPS))?.includes("events.jsonl")) {
      unchecked.push(`the events of session ${session} (the gate could not keep its seals)`);
      continue;
    }
    const kept = readLines(eventStore(stateDir, session));
    if (!kept) {
      unchecked.push(`the events of session ${session} (no seals kept)`);
      continue;
    }
    const sealedSeqs = new Map(kept.map((l) => l.split("\t")).map(([seq, h]) => [h, Number(seq)]));
    // lines from before the seals began, by an older gate or before a move, are not judged
    let began = Infinity;
    for (const seq of sealedSeqs.values()) began = Math.min(began, seq);
    if (began > ledger.openedSeq) unchecked.push(`the events of session ${session} before events#${began} (its seals began then)`);
    const from = Math.max(ledger.openedSeq, began - 1);
    const seen = new Set();
    let newest = 0;
    for (const line of lines) {
      const seq = seqOf(line);
      if (seq === null) continue; // a torn line from a crashed writer
      newest = Math.max(newest, seq);
      const h = hash(line);
      seen.add(h);
      if (seq > from && !sealedSeqs.has(h)) out.push({ key: `events-${session}@${h}`, text: `events of session ${session}: events#${seq} was not written by the gate` });
    }
    const now = Date.now() * 1000;
    for (const [h, seq] of sealedSeqs) {
      if (seq <= from || seen.has(h) || (seq > newest && now - seq < ON_ITS_WAY_MS * 1000)) continue;
      out.push({ key: `events-${session}@${h}`, text: `events of session ${session}: events#${seq} was removed or changed` });
    }
  }
  const unique = [...new Map(out.map((p) => [p.key, p])).values()];
  return withUnchecked(unique, unchecked);
}
// what had nothing to compare with rides along, out of the list's own entries
const withUnchecked = (list, unchecked) => Object.defineProperty(list, "unchecked", { value: unchecked, enumerable: false });
