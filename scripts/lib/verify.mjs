import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULTS, loadConfig } from "./config.mjs";
import { currentLedger, isDone, loadLedger, saveLedger } from "./ledger.mjs";
import { nextSeq } from "./events.mjs";
import { implementationHash, sourceHash, verifyKey, verifyWhere } from "./rules.mjs";
import { repoPath } from "./paths.mjs";
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

// Per command (verifyKey), the implementation hash at its last green run in this ledger; carried
// through every verify.json so a skipped run does not forget it.
function lastGreen(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).greenAt ?? {};
  } catch {
    return {};
  }
}

function changeAdded(ctx, flag, cmd) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if (!current || isDone(current.ledger)) throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
  cmd = cmd?.trim();
  if (!cmd) throw new UsageError(`usage: gate verify ${flag} "<command>"`);
  const { ledger } = current;
  const added = ledger.verifyAdded ?? [];
  const inConfig = loadConfig(ctx.root, ledger.repos).verify.some((v) => v.cmd === cmd);
  if (flag === "--add") {
    if (inConfig) throw new UsageError(`\`${cmd}\` is already a verify command of the repo config`);
    if (!added.includes(cmd)) ledger.verifyAdded = [...added, cmd];
    ledger.verifyDropped = (ledger.verifyDropped ?? []).filter((c) => c !== cmd);
    ctx.out(`verify command added for this run: ${cmd} — it runs after the config commands, and the run cannot close until \`gate verify\` has run it`);
  } else {
    if (inConfig) throw new UsageError(`\`${cmd}\` comes from the repo config; --drop removes only a command this run added`);
    if (!added.includes(cmd)) throw new UsageError(`\`${cmd}\` was not added by this run${added.length ? `; added: ${added.join(" · ")}` : ""}`);
    ledger.verifyAdded = added.filter((c) => c !== cmd);
    ledger.verifyDropped = [...(ledger.verifyDropped ?? []), cmd];
    ctx.out(`verify command dropped: ${cmd}`);
  }
  saveLedger(current.dir, ledger);
}

export async function runVerify(ctx, { stepKey = "verify" } = {}) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if (!current || isDone(current.ledger)) {
    throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
  }
  const repos = current.ledger.repos ?? [];
  const config = loadConfig(ctx.root, repos);
  const entries = [
    ...config.verify,
    ...(current.ledger.verifyAdded ?? []).map((cmd) => ({ cmd, timeout: DEFAULTS.verifyTimeout, when: "always" })),
    ...(config.repos ?? []).flatMap((r) => r.config.verify.map((v) => ({ ...v, repo: r.prefix, cwd: r.root }))),
  ];
  if (entries.length === 0) throw new UsageError("nothing to verify: no verify commands in .claude/gate.json, no lint/test/build scripts in package.json and none added with `gate verify --add`");

  const session = loadSession(ctx.stateDir, ctx.session);
  const snap = snapshot(ctx.root, session?.lastTree ?? current.ledger.baseline, repos);
  // a "source" command (the build, by default) only runs when the implementation changed
  const changed = diffSnapshots(current.ledger.baseline, snap).changed.filter((p) => config.isSource(p) && !config.isTest(p) && !config.isDoc(p));
  // a "source" command last green on this same implementation has nothing new to judge; with
  // declared repos each command is judged by the implementation of its own repo alone
  const scopes = new Map();
  const scopeOf = (prefix) => {
    if (!scopes.has(prefix)) {
      const mine = repos.length ? (p) => repoPath(ctx.root, p, repos).prefix === prefix : () => true;
      const files = repos.length ? Object.fromEntries(Object.entries(snap.files).filter(([p]) => mine(p))) : snap.files;
      scopes.set(prefix, { changed: changed.some(mine), implementation: implementationHash({ files }, config) });
    }
    return scopes.get(prefix);
  };
  const file = path.join(current.dir, "verify.json");
  const greenAt = lastGreen(file);
  const startedAt = new Date().toISOString();
  // A run the shell dies under leaves this behind; R3 and the report then say so.
  const started = path.join(current.dir, "verify.started.json");
  writeFileSync(started, JSON.stringify({ startedAt, pid: process.pid, commands: entries.map((v) => `${v.cmd}${verifyWhere(v)}`) }));
  const commands = [];
  for (const entry of entries) {
    const row = { cmd: entry.cmd, ...(entry.repo ? { repo: entry.repo } : {}) };
    const key = verifyKey(row);
    const name = `${entry.cmd}${verifyWhere(row)}`;
    const scope = entry.when === "source" ? scopeOf(entry.repo ?? null) : null;
    if (scope && !scope.changed) {
      ctx.err(`verify: ${name} skipped (no implementation change)`);
      commands.push({ ...row, skipped: "no implementation change (tests or docs only)", ms: 0 });
      continue;
    }
    if (scope && greenAt[key] === scope.implementation) {
      ctx.err(`verify: ${name} skipped (green on this implementation already)`);
      commands.push({ ...row, skipped: "already green on this code", ms: 0 });
      continue;
    }
    ctx.err(`verify: ${name} (timeout ${entry.timeout}s)`);
    const result = { ...row, ...(await runCommand(entry, entry.cwd ?? ctx.root)) };
    commands.push(result);
    if (result.exit === 0 && !result.timedOut) greenAt[key] = scopeOf(entry.repo ?? null).implementation;
    else delete greenAt[key];
    ctx.err(`  → ${result.timedOut ? "TIMED OUT" : `exit ${result.exit}`} in ${(result.ms / 1000).toFixed(1)}s`);
  }
  const record = { startedAt, finishedAt: new Date().toISOString(), sourceHash: sourceHash(snap, config), greenAt, commands };
  // written whole: a Stop hook may read it while a background verify is still writing
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${file}.${process.pid}.tmp`, file);
  rmSync(started, { force: true });

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
    const flag = ["--add", "--drop"].find((f) => ctx.args.includes(f));
    if (flag) {
      changeAdded(ctx, flag, ctx.args[ctx.args.indexOf(flag) + 1]);
      printNext(ctx);
      return;
    }
    const stepIdx = ctx.args.indexOf("--step");
    const stepKey = stepIdx >= 0 ? ctx.args[stepIdx + 1] : "verify";
    const { record, red } = await runVerify(ctx, { stepKey });
    for (const c of record.commands) {
      if (c.skipped) {
        ctx.out(`– ${c.cmd}${verifyWhere(c)} — skipped: ${c.skipped}`);
        continue;
      }
      const green = c.exit === 0 && !c.timedOut;
      ctx.out(`${green ? "✓" : "✗"} ${c.cmd}${verifyWhere(c)} — ${c.timedOut ? "timed out" : `exit ${c.exit}`}, ${(c.ms / 1000).toFixed(1)}s`);
      if (!green) ctx.out("```\n" + c.tail.split("\n").slice(-12).join("\n") + "\n```"); // the failing tail: the same 12 lines the report shows
    }
    const ran = record.commands.filter((c) => !c.skipped).length;
    ctx.out(red.length ? `${red.length} of ${ran} red — fix and run \`gate verify\` again` : `all ${ran} green — step {${stepKey}} closed with verify.json`);
    printNext(ctx);
  },
};
