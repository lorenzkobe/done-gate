import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { UsageError } from "./context.mjs";
import { processAlive } from "./rules.mjs";

// How long a run waits for the lock before it gives up as busy, so a wait inside a 10-minute
// Bash call leaves the tests their time. Tests shorten it with DONE_GATE_TEST_WAIT (seconds).
const WAIT_SECONDS = 300;
const POLL_MS = 500;
export const BUSY_EXIT = 75;

// not a UsageError subclass: this module loads inside the context.mjs import cycle
export class BusyError extends Error {}

const lockPath = (stateDir) => path.join(stateDir, "test.lock");

function readHolder(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return error.code === "ENOENT" ? undefined : {};
  }
}

function groupAlive(pgid) {
  if (!pgid || process.platform === "win32") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// A holder whose gate process died still holds the lock while the tests it started run on.
const holderAlive = (h) => processAlive(h.pid) || groupAlive(h.pgid);
const sameHolder = (a, b) => a?.pid === b?.pid && a?.startedAt === b?.startedAt;
export const describeHolder = (h) => `${h.label ?? "an unknown run"} (pid ${h.pid ?? "?"}, since ${h.startedAt ?? "?"})`;

// Removes a dead holder's lock, under a short guard so that of several waiters that judged it
// dead only one removes it, and only while it still names that holder: a live lock is never
// touched. A guard older than GUARD_STALE_MS was left by a crash and is cleared.
const GUARD_STALE_MS = 10_000;
function takeOver(file, dead) {
  const guard = `${file}.takeover`;
  try {
    writeFileSync(guard, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmSync(guard, { force: true });
    } catch {
      // released meanwhile
    }
    return;
  }
  try {
    if (sameHolder(readHolder(file), dead)) rmSync(file, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
}

const SIGNALS = { SIGINT: 2, SIGTERM: 15 };

// The repo-wide test lock: one run at a time, others wait. Taken by linking a fully written
// temp file, so a reader never sees half a lock. Resolves to the held lock; throws BusyError
// past the wait limit.
export async function acquireTestLock(stateDir, label, { onWait = () => {} } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const file = lockPath(stateDir);
  const mine = { pid: process.pid, pgid: null, label, startedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(mine));
  const waitMs = Number(process.env.DONE_GATE_TEST_WAIT ?? WAIT_SECONDS) * 1000;
  const deadline = Date.now() + waitMs;
  let told = false;
  try {
    for (;;) {
      try {
        linkSync(tmp, file);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const holder = readHolder(file);
      if (holder === undefined) continue;
      if (!holderAlive(holder)) {
        takeOver(file, holder);
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      if (Date.now() >= deadline) throw new BusyError(`busy: ${describeHolder(holder)} still holds the test lock; run it again`);
      if (!told) onWait(holder);
      told = true;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    rmSync(tmp, { force: true });
  }

  const release = () => {
    for (const [sig, fn] of handlers) process.off(sig, fn);
    if (sameHolder(readHolder(file), mine)) rmSync(file, { force: true });
  };
  // a killed holder stops its tests before it frees the lock
  const handlers = Object.entries(SIGNALS).map(([sig, n]) => {
    const fn = () => {
      if (mine.pgid) groupKill(mine.pgid);
      release();
      process.exit(128 + n);
    };
    process.on(sig, fn);
    return [sig, fn];
  });
  return {
    setGroup(pgid) {
      mine.pgid = pgid;
      writeFileSync(tmp, JSON.stringify(mine));
      renameSync(tmp, file);
    },
    release,
  };
}

function groupKill(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

// Set for the commands a lock holder starts, so a `gate test` inside them does not wait on it.
export const HELD_ENV = "DONE_GATE_TEST_LOCK_HELD";
const lockHeldAbove = () => processAlive(Number(process.env[HELD_ENV]));

export const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// The test files `gate test` was given, root-relative: each an existing file of this repo that
// the tests globs match.
function testArgs(ctx, config) {
  if (!ctx.args.length) throw new UsageError("usage: gate test <test file>... (files of this repo the tests globs match)");
  return ctx.args.map((arg) => {
    const abs = path.resolve(ctx.root, arg);
    const rel = path.relative(ctx.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new UsageError(`${arg} is outside this repo: a declared repo's tests run through \`gate verify\``);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new UsageError(`${arg}: no such file`);
    const posix = rel.split(path.sep).join("/");
    if (!config.isTest(posix)) throw new UsageError(`${arg} is not a test file by the tests globs (${config.tests.join(", ")})`);
    return posix;
  });
}

export const verbs = {
  async test(ctx) {
    const config = loadConfig(ctx.root);
    if (!config.testFiles) throw new UsageError('no testFiles with {files} in .claude/gate.json: add the command that runs given test files, with {files} where they go, e.g. "testFiles": "npx vitest run {files}"');
    const files = testArgs(ctx, config);
    const cmd = config.testFiles.split("{files}").join(files.map(quote).join(" "));
    let lock = null;
    // a verify command that calls `gate test` runs under verify's own lock
    if (config.serialTests && !lockHeldAbove()) {
      try {
        lock = await acquireTestLock(ctx.stateDir, `gate test ${files.join(" ")}`, { onWait: (h) => ctx.err(`waiting: ${describeHolder(h)} holds the test lock; this run starts when it ends`) });
      } catch (error) {
        if (!(error instanceof BusyError)) throw error;
        ctx.err(`done-gate: ${error.message}`);
        process.exitCode = BUSY_EXIT;
        return;
      }
    }
    try {
      const child = spawn(cmd, { cwd: ctx.root, shell: true, detached: process.platform !== "win32", stdio: "inherit", env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...(lock ? { [HELD_ENV]: String(process.pid) } : {}) } });
      lock?.setGroup(child.pid);
      process.exitCode = await new Promise((resolve) => {
        child.on("error", () => resolve(127));
        child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      });
    } finally {
      lock?.release();
    }
  },
};
