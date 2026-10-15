import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULTS, loadConfig, matchAny } from "./config.mjs";
import { segments, withoutHeredocs } from "./guard.mjs";
import { buildState } from "./assess.mjs";
import { currentLedger, isDone, loadLedger, saveLedger } from "./ledger.mjs";
import { nextSeq } from "./events.mjs";
import { diffTextOf, implementationHash, sourceHash, verifyKey, verifyWhere } from "./rules.mjs";
import { repoPath } from "./paths.mjs";
import { loadSession } from "./session-state.mjs";
import { diffSnapshots, parseHunks, snapshot } from "./tree.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";

const TAIL_LINES = 40;
const TAIL_BYTES = 8000;
// an onlyNew linter's whole output is read for findings; past this it stays red
const ONLY_NEW_MAX = 2 * 1024 * 1024;

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
export function runCommand({ cmd, timeout, onlyNew = false }, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let full = onlyNew ? "" : null;
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    const collect = (chunk) => {
      const text = chunk.toString("utf8");
      if (full !== null && full !== false) full = full.length + text.length > ONLY_NEW_MAX ? false : full + text;
      output += text;
      if (output.length > TAIL_BYTES * 4) output = output.slice(-TAIL_BYTES * 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let open = 2;
    const ended = () => (open -= 1);
    child.stdout.on("end", ended);
    child.stderr.on("end", ended);
    const finish = (exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // give buffered output a tick to land, then detach from any orphan's pipes; an onlyNew
      // linter's output is read whole: its streams get two seconds to end, else it stays red
      const waited = Date.now();
      const done = () => {
        if (onlyNew && open > 0 && Date.now() - waited < 2000) return setTimeout(done, 20);
        if (onlyNew && open > 0) full = false;
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ cmd, exit, ms: Date.now() - started, timedOut, tail: tail(output), ...(onlyNew ? { output: full } : {}) });
      };
      setTimeout(done, 50);
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
  const dropped = ledger.verifyDropped ?? [];
  const inConfig = loadConfig(ctx.root, ledger.repos).verify.some((v) => v.cmd === cmd);
  if (flag === "--add") {
    if (inConfig && !dropped.includes(cmd)) throw new UsageError(`\`${cmd}\` is already a verify command of the repo config`);
    if (!inConfig && !added.includes(cmd)) ledger.verifyAdded = [...added, cmd];
    if (inConfig) ledger.verifyRestored = [...new Set([...(ledger.verifyRestored ?? []), cmd])];
    ledger.verifyDropped = dropped.filter((c) => c !== cmd);
    ctx.out(inConfig
      ? `verify command restored for this run: ${cmd} — the run cannot close until \`gate verify\` has run it`
      : `verify command added for this run: ${cmd} — it runs after the config commands, and the run cannot close until \`gate verify\` has run it`);
  } else {
    if (!inConfig && !added.includes(cmd)) throw new UsageError(`\`${cmd}\` is neither a verify command of the repo config nor one this run added${added.length ? `; added: ${added.join(" · ")}` : ""}`);
    ledger.verifyAdded = added.filter((c) => c !== cmd);
    ledger.verifyRestored = (ledger.verifyRestored ?? []).filter((c) => c !== cmd);
    if (!dropped.includes(cmd)) ledger.verifyDropped = [...dropped, cmd];
    ctx.out(inConfig ? `verify command dropped for this run: ${cmd} — gate.json is unchanged; the report names the drop` : `verify command dropped: ${cmd}`);
  }
  saveLedger(current.dir, ledger);
}

// A place a tool prints: path:line[:col] or path(line,col).
const PLACE = /([^\s"'(),]+?)(?::(\d+)(?::\d+)?|\((\d+),\d+\))(?=$|[\s:),])/g;

// The folder a command ends up in after its `cd`s.
function lastCd(cmd, cwd) {
  let base = cwd;
  for (const seg of segments(withoutHeredocs(cmd))) {
    const words = seg.map((w) => w.text).filter((w) => w !== "");
    if (words[0] === "cd" && words[1]) base = path.resolve(base, words[1]);
  }
  return base;
}

// An onlyNew linter's exit 1 as its findings ("path:line") when every place it prints is a
// source file of its repo off this task's changed lines; null keeps it red.
function oldFindingsOnly(output, entry, ctx, config) {
  const root = entry.cwd ?? ctx.root;
  const base = lastCd(entry.cmd, root);
  const found = [];
  for (const line of output.replace(/\r/g, "").split("\n")) {
    for (const m of line.matchAll(PLACE)) {
      const abs = path.resolve(base, m[1]);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const key = entry.repo ? `${entry.repo}/${rel}` : rel;
      // a place in a test file is a test failing, whatever runs it behind a script name
      if (rel.startsWith("..") || /(?:^|\/)node_modules\//.test(rel) || !existsSync(abs) || !statSync(abs).isFile() || !config.isSource(key) || config.isTest(key)) return null;
      found.push({ key, line: Number(m[2] ?? m[3]) });
    }
  }
  if (!found.length) return null;
  const state = buildState(ctx, {});
  const touched = new Map();
  const linesOf = (key) => {
    if (!touched.has(key)) {
      const lines = new Set();
      if (state.changed.includes(key)) {
        for (const h of parseHunks(diffTextOf(state, key)).hunks) {
          for (const l of h.lines) {
            if (l.tag === "+") lines.add(l.pos);
            if (l.tag === "-") lines.add(l.pos - 1).add(l.pos);
          }
        }
      }
      touched.set(key, lines);
    }
    return touched.get(key);
  };
  if (found.some((f) => linesOf(f.key).has(f.line))) return null;
  return found.map((f) => `${f.key}:${f.line}`);
}

// Where a test runner sits in one command segment, or -1: a runner by name (not a folder of
// that name, not a flag's value), a tool's test script, or a language's test verb.
const RUNNERS = new Set(["pytest", "py.test", "jest", "vitest", "mocha", "ava", "tap", "rspec", "phpunit", "nose2", "ctest", "karma", "unittest"]);
const SCRIPT_TOOLS = new Set(["npm", "pnpm", "yarn", "bun", "make", "just", "task", "rake"]);
const TEST_VERBS = new Set(["go", "cargo", "mix", "dotnet", "deno", "mvn", "gradle", "gradlew"]);
const PATH_FLAGS = new Set(["-p", "--project", "-c", "--config", "--dir", "--cwd", "--root", "-C", "--prefix"]);
const runnerWord = (words, i) => {
  const dir = path.basename(path.dirname(words[i]));
  return RUNNERS.has(path.basename(words[i])) && (!words[i].includes("/") || dir === "bin" || dir === ".bin") && !PATH_FLAGS.has(words[i - 1]);
};
function runnerAt(words) {
  for (let i = 0; i < words.length; i++) {
    const name = path.basename(words[i]);
    const script = SCRIPT_TOOLS.has(name) ? words.findIndex((w, j) => j > i && /^test[:\w-]*$/.test(w)) : -1;
    if (script >= 0) return script;
    if (TEST_VERBS.has(name) && words[i + 1] === "test") return i + 1;
    if ((name === "node" || name === "bun") && words.includes("--test")) return words.indexOf("--test");
    if (runnerWord(words, i)) return i;
    if ((name === "playwright" && words[i + 1] === "test") || (name === "cypress" && words[i + 1] === "run")) return i + 1;
  }
  return -1;
}
export const runsTests = (cmd) => segments(withoutHeredocs(cmd)).some((seg) => runnerAt(seg.map((w) => w.text).filter((w) => w !== "")) >= 0);

const GLOB = /[*?[{]/;
const DROPS = new Set(["--ignore", "--ignore-glob", "--deselect"]);
const TAKES_VALUE = new Set([...DROPS, "-k", "-m", "-c", "-p", "-t", "-g", "--config", "--rootdir", "--junitxml", "--reporter", "--testNamePattern", "--testPathIgnorePatterns", "--exclude", "--grep", "--coverage-dir", "--outputFile"]);

// What one verify command runs and leaves out, per test-runner segment (a `cd` is followed):
// the folders, globs and test files it names after the runner (none: the folder it runs in),
// and what its --ignore, --ignore-glob or --deselect file::name take out. A flag's value never
// names what runs: --config or --junitxml point at other files.
function testScopes(cmd, cwd, isTest) {
  const scopes = [];
  let base = cwd;
  for (const seg of segments(withoutHeredocs(cmd))) {
    const words = seg.map((w) => w.text).filter((w) => w !== "");
    if (words[0] === "cd" && words[1]) {
      base = path.resolve(base, words[1]);
      continue;
    }
    const at = runnerAt(words);
    if (at < 0) continue;
    const scope = { base, names: [], drops: [] };
    for (let i = at + 1; i < words.length; i++) {
      const flag = /^(--?[\w.-]+)(?:=(.*))?$/.exec(words[i]);
      if (flag) {
        const value = flag[2] ?? (TAKES_VALUE.has(flag[1]) ? words[++i] : undefined);
        if (value !== undefined && DROPS.has(flag[1])) scope.drops.push(value.split("::")[0]);
        continue;
      }
      const w = words[i].split("::")[0].replace(/\/\.\.\.$/, "/");
      const abs = path.resolve(base, w);
      if (GLOB.test(w) || (existsSync(abs) && (statSync(abs).isDirectory() || isTest(abs)))) scope.names.push(w);
    }
    scopes.push(scope);
  }
  return scopes;
}

function holds(base, entry, abs) {
  if (GLOB.test(entry)) return matchAny([entry.replace(/^\.\//, "")], path.relative(base, abs).split(path.sep).join("/"));
  const at = path.resolve(base, entry);
  return abs === at || abs.startsWith(at.endsWith(path.sep) ? at : `${at}${path.sep}`);
}

// Closed cases whose test file (it exists and is a test file) no green, run test command covers.
export function coverageGaps(state) {
  const { ledger, verify, config, root } = state;
  if (!ledger || !verify) return [];
  const repoRoot = (prefix) => (prefix ? (config.repos ?? []).find((r) => r.prefix === prefix)?.root : root);
  const scopes = verify.commands
    .filter((c) => !c.skipped && c.exit === 0 && !c.timedOut)
    .flatMap((c) => {
      const cwd = repoRoot(c.repo ?? null);
      return cwd ? testScopes(c.cmd, cwd, (abs) => config.isTest(path.relative(root, abs).split(path.sep).join("/"))) : [];
    });
  const gaps = [];
  for (const c of ledger.cases ?? []) {
    if (c.status !== "closed" || !c.test) continue;
    const rel = /^(.+?\.\w+)(?::|$)/.exec(c.test)?.[1];
    if (!rel) continue;
    const abs = path.resolve(root, rel);
    if (!existsSync(abs) || !config.isTest(rel)) continue;
    const covered = scopes.some((s) => (s.names.length ? s.names.some((n) => holds(s.base, n, abs)) : holds(s.base, ".", abs)) && !s.drops.some((d) => holds(s.base, d, abs)));
    if (!covered) gaps.push({ id: c.id, file: rel });
  }
  return gaps;
}

// The tests a verify command leaves out, as written: --deselect, --ignore, --ignore-glob,
// -k with "not", --testPathIgnorePatterns and --exclude.
export function exclusionsOf(cmd) {
  const out = [];
  for (const seg of segments(withoutHeredocs(cmd))) {
    const words = seg.map((w) => w.text);
    for (let i = 0; i < words.length; i++) {
      const m = /^(--deselect|--ignore|--ignore-glob|-k|--testPathIgnorePatterns|--exclude)(?:=(.*))?$/.exec(words[i]);
      if (!m) continue;
      const value = m[2] ?? words[i + 1];
      if (value === undefined || (m[1] === "-k" && !/\bnot\b/.test(value))) continue;
      out.push({ text: m[2] === undefined ? `${m[1]} ${/\s/.test(value) ? `"${value}"` : value}` : words[i], value });
    }
  }
  return out;
}

const VERIFY_STEPS = new Set(["verify", "verify-before"]);

export async function runVerify(ctx, { stepKey = "verify" } = {}) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if (!current || isDone(current.ledger)) {
    throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
  }
  // a green run is evidence for a verify step only; any other step has its own evidence
  if (stepKey !== "verify") {
    const keys = current.ledger.steps.filter((s) => VERIFY_STEPS.has(s.key)).map((s) => s.key);
    if (!keys.includes(stepKey)) throw new UsageError(`gate verify --step takes a verify step of this run (${keys.join(", ") || "none"}), not ${stepKey === null ? "nothing" : `{${stepKey}}`}`);
  }
  const repos = current.ledger.repos ?? [];
  const config = loadConfig(ctx.root, repos);
  const dropped = new Set(current.ledger.verifyDropped ?? []);
  const entries = [
    ...config.verify.filter((v) => !dropped.has(v.cmd)),
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
    const { output, ...result } = { ...row, ...(await runCommand(entry, entry.cwd ?? ctx.root)) };
    // a test run's failures print file:line too: onlyNew never reads one
    if (entry.onlyNew && !runsTests(entry.cmd) && result.exit === 1 && !result.timedOut && output) {
      const old = oldFindingsOnly(output, entry, ctx, config);
      if (old) Object.assign(result, { exit: 0, rawExit: 1, oldFindings: old.length, oldList: old.slice(0, 20) });
    }
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
    const stepKey = stepIdx >= 0 ? ctx.args[stepIdx + 1] ?? null : "verify";
    const { record, red } = await runVerify(ctx, { stepKey });
    for (const c of record.commands) {
      if (c.skipped) {
        ctx.out(`– ${c.cmd}${verifyWhere(c)} — skipped: ${c.skipped}`);
        continue;
      }
      const green = c.exit === 0 && !c.timedOut;
      ctx.out(`${green ? "✓" : "✗"} ${c.cmd}${verifyWhere(c)} — ${c.timedOut ? "timed out" : `exit ${c.exit}`}${c.oldFindings ? ` (exit ${c.rawExit}: ${c.oldFindings} old finding${c.oldFindings === 1 ? "" : "s"} off this task's lines ignored)` : ""}, ${(c.ms / 1000).toFixed(1)}s`);
      if (!green) ctx.out("```\n" + c.tail.split("\n").slice(-12).join("\n") + "\n```"); // the failing tail: the same 12 lines the report shows
    }
    const ran = record.commands.filter((c) => !c.skipped).length;
    ctx.out(red.length ? `${red.length} of ${ran} red — fix and run \`gate verify\` again` : `all ${ran} green — step {${stepKey}} closed with verify.json`);
    printNext(ctx);
  },
};
