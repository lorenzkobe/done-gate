import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { currentLedger, isDone, loadLedger, saveLedger } from "./ledger.mjs";
import { nextSeq } from "./events.mjs";
import { sourceHash } from "./rules.mjs";
import { loadSession } from "./session-state.mjs";
import { diffSnapshots, snapshot } from "./tree.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";

const TAIL_LINES = 40;
const TAIL_BYTES = 8000;

function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function tail(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  return lines.slice(-TAIL_LINES).join("\n").slice(-TAIL_BYTES);
}

// Runs one command in its own process group. Resolves on the command's own exit, not
// on stream close, so a background child that inherited stdout cannot hold us hostage.
export function runCommand({ cmd, timeout }, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    const collect = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > TAIL_BYTES * 4) output = output.slice(-TAIL_BYTES * 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // give buffered output a tick to land, then detach from any orphan's pipes
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ cmd, exit, ms: Date.now() - started, timedOut, tail: tail(output) });
      }, 50);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish(null);
    }, Math.max(1, timeout) * 1000);
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(127);
    });
    child.on("exit", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

export async function runVerify(ctx, { stepKey = "verify" } = {}) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if (!current || isDone(current.ledger)) {
    throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
  }
  const config = loadConfig(ctx.root);
  if (config.verify.length === 0) throw new UsageError("nothing to verify: no verify commands in .claude/gate.json and no lint/test/build scripts in package.json");

  const session = loadSession(ctx.stateDir, ctx.session);
  const snap = snapshot(ctx.root, session?.lastTree ?? current.ledger.baseline);
  // a "source" command (the build, by default) only runs when the implementation changed
  const changed = diffSnapshots(current.ledger.baseline, snap).changed;
  const implementationChanged = changed.some((p) => config.isSource(p) && !config.isTest(p) && !config.isDoc(p));
  const startedAt = new Date().toISOString();
  const commands = [];
  for (const entry of config.verify) {
    if (entry.when === "source" && !implementationChanged) {
      ctx.err(`verify: ${entry.cmd} skipped (no implementation change)`);
      commands.push({ cmd: entry.cmd, skipped: "no implementation change (tests or docs only)", ms: 0 });
      continue;
    }
    ctx.err(`verify: ${entry.cmd} (timeout ${entry.timeout}s)`);
    const result = await runCommand(entry, ctx.root);
    commands.push(result);
    ctx.err(`  → ${result.timedOut ? "TIMED OUT" : `exit ${result.exit}`} in ${(result.ms / 1000).toFixed(1)}s`);
  }
  const record = { startedAt, finishedAt: new Date().toISOString(), sourceHash: sourceHash(snap, config), commands };
  writeFileSync(path.join(current.dir, "verify.json"), JSON.stringify(record, null, 2));

  const red = commands.filter((c) => !c.skipped && (c.exit !== 0 || c.timedOut));
  const ledger = loadLedger(current.dir);
  const step = ledger.steps.find((s) => s.key === stepKey);
  if (step && red.length === 0) {
    Object.assign(step, { state: "DONE", evidence: "verify.json", note: `${commands.length} command(s) green`, seq: nextSeq() });
  }
  saveLedger(current.dir, ledger);
  return { record, red, dir: current.dir };
}

export const verbs = {
  async verify(ctx) {
    const stepIdx = ctx.args.indexOf("--step");
    const stepKey = stepIdx >= 0 ? ctx.args[stepIdx + 1] : "verify";
    const { record, red } = await runVerify(ctx, { stepKey });
    for (const c of record.commands) {
      if (c.skipped) {
        ctx.out(`– ${c.cmd} — skipped: ${c.skipped}`);
        continue;
      }
      const green = c.exit === 0 && !c.timedOut;
      ctx.out(`${green ? "✓" : "✗"} ${c.cmd} — ${c.timedOut ? "timed out" : `exit ${c.exit}`}, ${(c.ms / 1000).toFixed(1)}s`);
      if (!green) ctx.out("```\n" + c.tail.split("\n").slice(-12).join("\n") + "\n```"); // the failing tail: the same 12 lines the report shows
    }
    const ran = record.commands.filter((c) => !c.skipped).length;
    ctx.out(red.length ? `${red.length} of ${ran} red — fix and run \`gate verify\` again` : `all ${ran} green — step {${stepKey}} closed with verify.json`);
    printNext(ctx);
  },
};
