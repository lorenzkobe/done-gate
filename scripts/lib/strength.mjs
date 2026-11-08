import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { noteLine, listFiles } from "./tree.mjs";
import { openQuoteAt } from "./slop.mjs";
import { runCommand } from "./verify.mjs";
import { BusyError, HELD_ENV, acquireTestLock, quote } from "./testlock.mjs";

// The strength check: a few added lines are broken on purpose in a throwaway copy, and the related
// tests run against each. A break no test notices is a weak test, shown to the reviewer as advice.

const CODE = /\.(?:m?[jt]sx?|c[jt]s)$/i;
const IMPORT = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b)|\brequire\s*\(/;
const LOG = /\b(?:console|logger|log)\s*\.\s*\w+\s*\(/;
const STYLE = /\b(?:className|class|style)\s*=/;
const ENV = /\bprocess\.env\b|\bimport\.meta\.env\b|\bproduction\b/i;
// longest first, so === is never read as ==; no bare < or >, which generics and JSX also use
const SWAPS = [["===", "!=="], ["!==", "==="], ["==", "!="], ["!=", "=="], [">=", "<"], ["<=", ">"], ["&&", "||"], ["||", "&&"]];
const WORDS = [["true", "false"], ["false", "true"]];

// The leftmost swap on the line outside a string and before a // comment, or null.
function swapIn(text) {
  for (let i = 0; i < text.length; i++) {
    if (openQuoteAt(text, i)) continue;
    if (text.startsWith("//", i)) return null;
    // left to right, longest first: the first hit is the whole operator
    for (const [from, to] of SWAPS) {
      // >>= and <<= are shifts, not comparisons
      if (text.startsWith(from, i) && !(from.length === 2 && /[<>]/.test(from[0]) && text[i - 1] === from[0])) return `${text.slice(0, i)}${to}${text.slice(i + from.length)}`;
    }
    for (const [from, to] of WORDS) {
      if (text.startsWith(from, i) && !/[\w$]/.test(text[i - 1] ?? "") && !/[\w$]/.test(text[i + from.length] ?? "")) {
        return `${text.slice(0, i)}${to}${text.slice(i + from.length)}`;
      }
    }
  }
  return null;
}

// k of n spread evenly, the same k every time
const spread = (items, k) => (items.length <= k ? items : Array.from({ length: k }, (_, i) => items[Math.round(((i + 0.5) * items.length) / k - 0.5)]));

// The breaks for one file's added lines [{pos, text}]: at most perFile, spread over its candidates.
export function pickBreaks(file, lines, config, { perFile = 3 } = {}) {
  if (!CODE.test(file) || config.isSchema(file) || config.isHighRisk(file)) return [];
  const candidates = [];
  for (const { pos, text } of lines) {
    if (noteLine(file, text) || IMPORT.test(text) || LOG.test(text) || STYLE.test(text) || ENV.test(text)) continue;
    const now = swapIn(text);
    if (now !== null) candidates.push({ file, pos, was: text, now });
  }
  return spread(candidates, perFile);
}

// A run's breaks, at most max, spread over its files in order.
export const capRun = (breaks, max = 9) => spread(breaks, max);

const MARKER = "strength-pending";
const COPY_PREFIX = "done-gate-strength-";
const OLD_COPY_MS = 3600 * 1000;
// a child never sees the real repo as its project (a gate call inside it would work there), nor
// a parent node test runner, whose mark makes a nested node --test hand its results up and exit 0
const UNSET = ["CLAUDE_PROJECT_DIR", "DONE_GATE_SESSION", "NODE_TEST_CONTEXT"];

// Copies older than an hour are left from a run that was cut off.
function clearOldCopies() {
  const tmp = os.tmpdir();
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith(COPY_PREFIX)) continue;
    const dir = path.join(tmp, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > OLD_COPY_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // another run's copy, already gone
    }
  }
}

// The tracked files copied (a clone where the disk can), node_modules folders and .env files
// linked; every other ignored path is left out, so a run cannot write into the real tree.
function makeCopy(root) {
  const dir = mkdtempSync(path.join(os.tmpdir(), COPY_PREFIX));
  for (const rel of listFiles(root)) {
    if (rel.startsWith(".claude/") || rel === ".git" || rel.startsWith(".git/")) continue;
    const from = path.join(root, rel);
    const to = path.join(dir, rel);
    const kind = lstatSync(from, { throwIfNoEntry: false });
    if (!kind || !(kind.isFile() || kind.isSymbolicLink())) continue; // a submodule's folder
    mkdirSync(path.dirname(to), { recursive: true });
    if (kind.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to, constants.COPYFILE_FICLONE);
  }
  let ignored = [];
  try {
    ignored = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    // not a git repo: nothing ignored to link
  }
  for (const entry of ignored) {
    const rel = entry.replace(/\/$/, "");
    const base = path.basename(rel);
    if (!(base === "node_modules" || /^\.env(?:\.|$)/.test(base)) || rel.startsWith(".claude")) continue;
    const to = path.join(dir, rel);
    if (existsSync(to)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    symlinkSync(path.join(root, rel), to);
  }
  return dir;
}

// Runs the breaks against the related tests on a copy. { skipped } says why nothing ran; else
// { tried, noticed, survivors, untried, ms, copyMs, resetFailed? }. The real tree is never written.
export async function runBreaks({ root, stateDir, config, tests, breaks, budgetMs = 90000, cleanCapMs = 45000 }) {
  const started = Date.now();
  if (!config.testFiles) return { skipped: "no testFiles template in .claude/gate.json to run given test files" };
  if (config.testFiles.includes(root)) return { skipped: "the testFiles template names the repo's own path, so a copy would run the real tree" };
  const serial = config.serialTests;
  if (serial && !config.strengthReset) return { skipped: "the tests share one database (serialTests) and .claude/gate.json has no strengthReset command to put it back" };
  let lock = null;
  if (serial) {
    try {
      lock = await acquireTestLock(stateDir, "strength check", { wait: false });
    } catch (error) {
      if (error instanceof BusyError) return { skipped: "the test lock is busy: another test run holds it" };
      throw error;
    }
  }
  const marker = path.join(stateDir, MARKER);
  let copy = null;
  try {
    clearOldCopies();
    const env = lock ? { [HELD_ENV]: String(process.pid) } : {};
    const onSpawn = (pgid) => lock?.setGroup(pgid);
    const run = (cmd, cwd, timeout) => runCommand({ cmd, timeout }, cwd, { onSpawn, env, unset: UNSET });
    const left = () => Math.max(0, budgetMs - (Date.now() - started));
    // a reset gets its own time, three times the first one's, so a late one is never cut short
    let resetSec = Math.max(1, Math.ceil(budgetMs / 1000));
    const reset = async (cwd) => {
      const t = Date.now();
      const r = await run(config.strengthReset, cwd, resetSec);
      resetSec = Math.max(2, Math.ceil((3 * (Date.now() - t)) / 1000));
      return r.exit === 0 && !r.timedOut;
    };
    // a run cut off after its first break left the database broken: put it back first
    if (serial && existsSync(marker)) {
      if (!(await reset(root))) return { skipped: "the reset after a cut-off strength run failed", resetFailed: true };
      rmSync(marker, { force: true });
    }
    if (!tests.length) return { skipped: "no related test files to run" };
    const copyStart = Date.now();
    copy = makeCopy(root);
    const copyMs = Date.now() - copyStart;
    const cmd = config.testFiles.split("{files}").join(tests.map(quote).join(" "));
    if (serial && !(await reset(copy))) return { skipped: "the reset command failed before the clean run", resetFailed: true, copyMs };
    const cleanStart = Date.now();
    const clean = await run(cmd, copy, Math.max(1, Math.ceil(Math.min(cleanCapMs, left()) / 1000)));
    const cleanMs = Date.now() - cleanStart;
    if (clean.timedOut || cleanMs > cleanCapMs) return { skipped: `the related tests took over ${Math.round(cleanCapMs / 1000)}s on the clean copy`, copyMs };
    if (clean.exit !== 0) return { skipped: "the related tests fail on the clean copy, so a break proves nothing", copyMs };
    const each = Math.max(1, Math.ceil((3 * cleanMs) / 1000));
    const noticed = [];
    const survivors = [];
    const untried = [];
    if (serial) writeFileSync(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    let resetFailed = false;
    for (const b of breaks) {
      if (resetFailed || left() < (each + (serial ? resetSec : 0)) * 1000) {
        untried.push(b);
        continue;
      }
      const file = path.join(copy, b.file);
      const original = readFileSync(file, "utf8");
      const lines = original.split("\n");
      lines[b.pos - 1] = b.now;
      writeFileSync(file, lines.join("\n"));
      const r = await run(cmd, copy, each);
      writeFileSync(file, original);
      (r.exit !== 0 || r.timedOut ? noticed : survivors).push(b);
      if (serial && !(await reset(copy))) resetFailed = true;
    }
    if (serial && !resetFailed) rmSync(marker, { force: true });
    return { tried: noticed.length + survivors.length, noticed, survivors, untried, ms: Date.now() - started, copyMs, ...(resetFailed ? { resetFailed: true } : {}) };
  } finally {
    if (copy) rmSync(copy, { recursive: true, force: true });
    lock?.release();
  }
}
