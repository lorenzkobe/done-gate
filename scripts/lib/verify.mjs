import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULTS, loadConfig, matchAny } from "./config.mjs";
import { segments, withoutHeredocs } from "./guard.mjs";
import { buildState } from "./assess.mjs";
import { currentLedger, isDone, loadLedger, saveLedger } from "./ledger.mjs";
import { appendEvents, nextSeq, readEvents } from "./events.mjs";
import { diffTextOf, driverCommand, implementationHash, newRules, surfaceClear, notRecommended, saidSince, sourceHash, verifyKey, verifyWhere, waiverWordsProblem, workOutSteps } from "./rules.mjs";
import { repoPath } from "./paths.mjs";
import { loadSession } from "./session-state.mjs";
import { diffSnapshots, gitIgnored, parseHunks, snapshot } from "./tree.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";
import { BusyError, HELD_ENV, acquireTestLock, describeHolder, quote } from "./testlock.mjs";
import { policyFor, splitAdvice } from "./size.mjs";

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
export function runCommand({ cmd, timeout, onlyNew = false, whole = false }, cwd, { onSpawn = () => {}, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let full = onlyNew || whole ? "" : null;
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...env } });
    onSpawn(child.pid);
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
        resolve({ cmd, exit, ms: Date.now() - started, timedOut, tail: tail(output), ...(onlyNew || whole ? { output: full } : {}) });
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
function lastGreen(file, field = "greenAt") {
  try {
    return JSON.parse(readFileSync(file, "utf8"))[field] ?? {};
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
    const words = ctx.args.includes("--user-ok") ? ctx.args[ctx.args.indexOf("--user-ok") + 1]?.trim() : null;
    if (newRules(ledger)) {
      // the last test command is what R18 cannot catch once no case points at a test file; a repo
      // that configured none gives nothing up
      const config = loadConfig(ctx.root, ledger.repos);
      const testEntry = (v) => v.related || runsTests(v.cmd, config.testFiles);
      if (config.verify.some(testEntry) && verifyEntries(config, ledger).filter((v) => v.cmd !== cmd && testEntry(v)).length === 0 && verifyEntries(config, ledger).some((v) => v.cmd === cmd && testEntry(v))) {
        const tell = 'dropping the last test command is the user\'s call: ask them, then pass --user-ok "<their words, at least three, naming the tests>"';
        if (!words || words.startsWith("--")) throw new UsageError(tell);
        const problem = waiverWordsProblem("tests", words);
        if (problem) throw new UsageError(`gate verify --drop: ${problem}. ${tell}`);
        const events = ledger.sessions.flatMap((s) => readEvents(ctx.stateDir, s)).sort((a, b) => a.seq - b.seq);
        if (!saidSince(notRecommended(events), ledger.openedSeq ?? 0, words)) throw new UsageError(`the user did not say "${words}" in this task: ${tell}`);
        ledger.verifyDropWords = { ...ledger.verifyDropWords, [cmd]: words };
      }
    }
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
// gate.json's testFiles template (`scripts/test_db.sh run {files} -q`) is the repo's own test
// runner: a segment that starts with its words before {files} runs tests, its paths after them.
// A one-word lead is a program that may do more than test (`./run.sh lint`): a plain word after it
// is another task, while nothing, a flag or a path is a test run.
function templateAt(words, template) {
  const parts = template ? template.trim().split(/\s+/) : [];
  const lead = parts.slice(0, Math.max(0, parts.indexOf("{files}")));
  if (!lead.length || !lead.every((w, i) => words[i] === w)) return -1;
  const next = words[lead.length];
  return lead.length > 1 || next === undefined || /^-|[/.*?[]/.test(next) ? lead.length - 1 : -1;
}
const testRunnerAt = (words, template) => {
  const at = runnerAt(words);
  return at >= 0 ? at : templateAt(words, template);
};
export const runsTests = (cmd, template = null) => segments(withoutHeredocs(cmd)).some((seg) => testRunnerAt(seg.map((w) => w.text).filter((w) => w !== ""), template) >= 0);

const GLOB = /[*?[{]/;
const DROPS = new Set(["--ignore", "--ignore-glob", "--deselect"]);
const TAKES_VALUE = new Set([...DROPS, "-k", "-m", "-c", "-p", "-t", "-g", "--config", "--rootdir", "--junitxml", "--reporter", "--testNamePattern", "--testPathIgnorePatterns", "--exclude", "--grep", "--coverage-dir", "--outputFile"]);

// What one verify command runs and leaves out, per test-runner segment (a `cd` is followed):
// the folders, globs and test files it names after the runner (none: the folder it runs in),
// and what its --ignore, --ignore-glob or --deselect file::name take out. A flag's value never
// names what runs: --config or --junitxml point at other files.
function testScopes(cmd, cwd, isTest, template = null) {
  const scopes = [];
  let base = cwd;
  for (const seg of segments(withoutHeredocs(cmd))) {
    const words = seg.map((w) => w.text).filter((w) => w !== "");
    if (words[0] === "cd" && words[1]) {
      base = path.resolve(base, words[1]);
      continue;
    }
    const at = testRunnerAt(words, template);
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

// Module names too common to say which tests a change touches: a change to one of them is left
// to the final check.
const GENERIC = new Set(["index", "__init__", "main", "app", "apps", "utils", "util", "helpers", "types", "config", "constants", "settings", "models", "views", "urls", "serializers", "services", "admin", "tasks", "forms", "schemas", "api", "routes", "common", "base", "conftest", "mod", "lib"]);
const RELATED_MAX_BYTES = 1024 * 1024;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What sits under the tests folder without being a test: conftest, package markers, helpers,
// support code, fixtures and mocks. Anything else the tests globs match counts as a test.
const NOT_TEST = /(?:^|\/)(?:conftest\.py|__init__\.py|[^/]*_(?:helpers?|support|fixtures?|utils?)\.[^/.]+|(?:helpers?|support|fixtures?|utils?)\.[^/.]+)$|(?:^|\/)(?:fixtures|__fixtures__|__mocks__|helpers|support)\//;
// a name that says test wins over a helper-sounding name or folder
const NAMED_TEST = /(?:^|\/)(?:test_[^/]*|[^/]*_test\.[^/.]+|[^/]*\.(?:test|spec)\.[^/.]+|[^/]*_spec\.[^/.]+|[^/]*Test\.[^/.]+)$/;
const isTestFile = (config, p) => config.isTest(p) && (NAMED_TEST.test(p) || !NOT_TEST.test(p));
// A changed module that more of the repo's tests reference than this is a hub: its tests are
// most of the suite, which the final check runs.
const HUB_SHARE = 0.1;
const HUB_MIN = 20;

// This task's related test files in the main repo: closed cases' test files, changed test files
// that still exist, and test files that reference a changed module by its folder or package
// (src/booking, app.booking, from app import booking); a bare word is not enough. Helpers and
// fixtures are not picked, and a hub module picks only the tests named after it.
export function relatedTests(root, config, ledger, snap, touched) {
  const mine = (p) => !p.startsWith("../");
  const out = new Set();
  for (const c of ledger.cases ?? []) {
    const f = caseTestFile(c, root, config);
    if (f && mine(f)) out.add(f);
  }
  for (const p of touched) if (mine(p) && isTestFile(config, p) && existsSync(path.join(root, p))) out.add(p);
  const patterns = touched
    .filter((p) => mine(p) && config.isSource(p) && !config.isTest(p) && !config.isDoc(p))
    .map((p) => ({ stem: path.posix.basename(p).replace(/\.[^.]+$/, ""), parent: path.posix.basename(path.posix.dirname(p)) }))
    .filter(({ stem, parent }) => stem.length >= 3 && !GENERIC.has(stem.toLowerCase()) && parent !== ".")
    .map(({ stem, parent }) => ({ stem, re: new RegExp(`\\b${escapeRe(parent)}[./]${escapeRe(stem)}\\b|\\bfrom\\s+[\\w.]*\\b${escapeRe(parent)}\\s+import\\s+[^\\n]*\\b${escapeRe(stem)}\\b`) }));
  if (patterns.length) {
    const tests = Object.keys(snap.files).filter((p) => mine(p) && isTestFile(config, p));
    const hits = patterns.map(() => []);
    for (const p of tests) {
      if (snap.files[p].s > RELATED_MAX_BYTES) continue;
      let text;
      try {
        text = readFileSync(path.join(root, p), "utf8");
      } catch {
        continue;
      }
      patterns.forEach(({ re }, i) => re.test(text) && hits[i].push(p));
    }
    // a hub's tests are left to the final check, except the ones named after it
    const hub = Math.max(HUB_MIN, tests.length * HUB_SHARE);
    hits.forEach((found, i) => {
      const own = (p) => path.posix.basename(p).toLowerCase().includes(patterns[i].stem.toLowerCase());
      for (const p of found) if (found.length <= hub || own(p)) out.add(p);
    });
  }
  return [...out].sort();
}

// The file a test pointer names: file:line, file:name, file::name.
export const pointerFile = (pointer) => /^(.+?\.\w+)(?::|$)/.exec(pointer)?.[1] ?? null;

// A closed case's test file from its pointer (file:line, file::name), when it exists and is a
// test file; a click or n/a case has none.
export function caseTestFile(c, root, config) {
  if (c.status !== "closed" || !c.test) return null;
  const rel = pointerFile(c.test);
  return rel && existsSync(path.resolve(root, rel)) && config.isTest(rel) ? rel : null;
}

// Closed cases whose test file (it exists and is a test file) no green, run test command covers.
export function coverageGaps(state) {
  const { ledger, verify, config, root } = state;
  if (!ledger || !verify) return [];
  const repoRoot = (prefix) => (prefix ? (config.repos ?? []).find((r) => r.prefix === prefix)?.root : root);
  const scopes = verify.commands
    .filter((c) => c.covers || (!c.skipped && c.exit === 0 && !c.timedOut))
    .flatMap((c) => {
      const cwd = repoRoot(c.repo ?? null);
      return cwd ? testScopes(c.cmd, cwd, (abs) => config.isTest(path.relative(root, abs).split(path.sep).join("/")), config.testFiles) : [];
    });
  const listed = new Set(verify.commands.filter((c) => (c.covers || (!c.skipped && c.exit === 0 && !c.timedOut)) && Array.isArray(c.files)).flatMap((c) => c.files));
  const gaps = [];
  for (const c of ledger.cases ?? []) {
    const rel = caseTestFile(c, root, config);
    if (!rel || listed.has(rel)) continue;
    const abs = path.resolve(root, rel);
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

// What `gate verify` runs for this run, in order: gate.json's commands minus the ones the run
// dropped, the ones it added, then each declared repo's own. Helper packets list the same.
export function verifyEntries(config, ledger) {
  const dropped = new Set(ledger.verifyDropped ?? []);
  return [
    ...config.verify.filter((v) => !dropped.has(v.cmd)),
    ...(ledger.verifyAdded ?? []).map((cmd) => ({ cmd, timeout: DEFAULTS.verifyTimeout, when: "always" })),
    ...(config.repos ?? []).flatMap((r) => r.config.verify.map((v) => ({ ...v, repo: r.prefix, cwd: r.root }))),
  ];
}

const VERIFY_STEPS = new Set(["verify", "verify-before"]);

const HISTORY_KEPT = 20;
const PORT_IN_USE = /EADDRINUSE|address already in use|port \d+ is (?:already )?(?:in use|used)/i;

// The test totals a runner's own summary states. A count no pattern here reads is unknown, so it
// is never a zero. Past the read cap (false) nothing is judged.
const ANSI = /\x1b\[[0-9;]*m/g;
const ZERO_LINES = [/No tests found, exiting with code 0/, /No test files found, exiting with code 0/, /^\s*(?:Test Files|Tests)\s+no tests\s*$/m, /\bno tests ran\b/, /\[no test files\]/, /\[no tests to run\]/];
const TOTALS = [/^\s*Tests:\s+.*?(\d+) total\s*$/gm, /^\s*Tests\s+.*\((\d+)\)\s*$/gm, /^(?:ℹ|#) tests (\d+)\s*$/gm, /^collected (\d+) items?/gm, /^running (\d+) tests?\s*$/gm];
const SOME_RAN = /\b[1-9]\d* (?:passed|passing|tests?\b)|^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)\s*$/m;
export function ranNoTests(output) {
  if (typeof output !== "string") return false;
  const text = output.replace(ANSI, "");
  const totals = TOTALS.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => Number(m[1])));
  if (totals.some((n) => n > 0) || SOME_RAN.test(text)) return false;
  return totals.length > 0 || ZERO_LINES.some((pattern) => pattern.test(text));
}

const REPORT_READ = 1024 * 1024;
const WRITE_SLACK_MS = 1000;

// Why a declared report does not show a test ran, or null when it does: it must be written by this
// command, and name at least one test (junit's suite tests=, jest's numTotalTests) near its start.
function reportProblem(file, startedMs) {
  let head;
  try {
    if (statSync(file).mtimeMs < startedMs - WRITE_SLACK_MS) return `its report ${path.basename(file)} was not written by this run`;
    const fd = openSync(file, "r");
    const buffer = Buffer.alloc(REPORT_READ);
    head = buffer.toString("utf8", 0, readSync(fd, buffer, 0, REPORT_READ, 0));
    closeSync(fd);
  } catch {
    return `its report ${path.basename(file)} could not be read`;
  }
  const counts = [...head.matchAll(/<testsuites?\b[^>]*\btests="(\d+)"/g), ...head.matchAll(/"numTotalTests"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  return counts.some((n) => n > 0) ? null : `its report ${path.basename(file)} shows no test`;
}

// A report the tree holds as source would move the source hash on every run, so verify could never
// settle: it has to be git-ignored, or outside the source globs.
function refuseSourceReport(entries, config, root) {
  for (const entry of entries.filter((e) => e.report)) {
    const rel = entry.repo ? `${entry.repo}/${entry.report}` : entry.report;
    if (config.isSource(rel) && !gitIgnored(entry.cwd ?? root, entry.report)) {
      throw new UsageError(`verify entry \`${entry.cmd}\`: its report ${entry.report} counts as source and is not git-ignored, so each run would change the code verify judged. Add it to .gitignore, or write it outside the source globs.`);
    }
  }
}

export async function runVerify(ctx, { stepKey = "verify", final = false, force = false } = {}) {
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
  const entries = verifyEntries(config, current.ledger);
  if (newRules(current.ledger)) refuseSourceReport(entries, config, ctx.root);
  if (entries.length === 0) throw new UsageError("nothing to verify: no verify commands in .claude/gate.json, no lint/test/build scripts in package.json and none added with `gate verify --add`");
  if (entries.some((e) => e.related && !e.repo) && !config.testFiles) throw new UsageError(`a {"related": true} verify entry needs testFiles in .claude/gate.json: the command that runs given test files, with {files} where they go`);

  const session = loadSession(ctx.stateDir, ctx.session);
  const snap = snapshot(ctx.root, session?.lastTree ?? current.ledger.baseline, repos);
  // a "source" command (the build, by default) only runs when the implementation changed
  const touched = diffSnapshots(current.ledger.baseline, snap).changed;
  const changed = touched.filter((p) => config.isSource(p) && !config.isTest(p) && !config.isDoc(p));
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
  // a final command's whole source (tests too) at its last green run: a skip on that same code
  // still covers its test files, and --final reruns it once tests changed
  const greenSource = lastGreen(file, "greenSource");
  const sourceNow = sourceHash(snap, config);
  // what each command last went green on: the whole tree and the command as it ran. An ignored
  // file (.env) is not in the tree, so a command that reads one declares itself external
  const stamped = newRules(current.ledger);
  const greenTree = lastGreen(file, "greenTree");
  const greenOnThisTree = (entry, key, cmd) => stamped && !force && !entry.external && greenTree[key]?.tree === snap.hash && greenTree[key]?.cmd === cmd;
  const repeated = (row, key) => {
    const { tree: _tree, cmd: _cmd, ...old } = greenTree[key];
    ctx.err(`verify: ${row.cmd}${verifyWhere(row)} skipped (green on this exact tree already)`);
    return { ...row, ...old, skipped: "already green on this exact tree", covers: true, ms: 0 };
  };
  // with serialTests verify waits for any `gate test` and holds the lock while it runs
  let lock = null;
  try {
    if (config.serialTests) lock = await acquireTestLock(ctx.stateDir, "gate verify", { onWait: (h) => ctx.err(`waiting: ${describeHolder(h)} holds the test lock; verify starts when it ends`) });
  } catch (error) {
    throw error instanceof BusyError ? new UsageError(error.message) : error;
  }
  const driverCmd = driverCommand(config);
  const startedAt = new Date().toISOString();
  // A run the shell dies under leaves this behind; R3 and the report then say so.
  const started = path.join(current.dir, "verify.started.json");
  writeFileSync(started, JSON.stringify({ startedAt, pid: process.pid, session: ctx.session, commands: entries.map((v) => `${v.cmd}${verifyWhere(v)}`) }));
  const commands = [];
  for (const entry of entries) {
    const row = { cmd: entry.cmd, ...(entry.repo ? { repo: entry.repo } : {}) };
    const key = verifyKey(row);
    const name = `${entry.cmd}${verifyWhere(row)}`;
    const isFinal = entry.when === "final";
    if (isFinal) row.final = true;
    if (isFinal && !force && !entry.repo && entry.cmd.trim() === driverCmd && surfaceClear("driver", current.ledger, config, touched)) {
      ctx.err(`verify: ${name} skipped (no UI or API file changed)`);
      commands.push({ ...row, skipped: "no UI or API file changed", ms: 0 });
      continue;
    }
    if (!entry.related && greenOnThisTree(entry, key, entry.cmd)) {
      commands.push(repeated(row, key));
      continue;
    }
    const scope = entry.when === "source" || isFinal ? scopeOf(entry.repo ?? null) : null;
    if (scope && !scope.changed && !force) {
      ctx.err(`verify: ${name} skipped (no implementation change)`);
      commands.push({ ...row, skipped: "no implementation change (tests or docs only)", ms: 0 });
      continue;
    }
    const sameCode = isFinal && greenSource[key] === sourceNow;
    if (scope && !force && greenAt[key] === scope.implementation && !(isFinal && final && !sameCode)) {
      ctx.err(`verify: ${name} skipped (green on this implementation already)`);
      commands.push({ ...row, skipped: "already green on this code", ms: 0, greenCode: true, ...(sameCode ? { covers: true } : {}) });
      continue;
    }
    // the area suite runs once, when the edits are done; until then it is owed
    if (isFinal && !final) {
      ctx.err(`verify: ${name} owed (the final check: \`gate verify --final\`)`);
      commands.push({ ...row, skipped: "the final check: runs with `gate verify --final`", owed: true, ms: 0 });
      continue;
    }
    let run = entry;
    if (entry.related) {
      if (entry.repo) {
        commands.push({ ...row, skipped: "related tests run for the main repo only", ms: 0 });
        continue;
      }
      const files = relatedTests(ctx.root, config, current.ledger, snap, touched);
      // a deleted file or another repo's path would break a runner handed it
      const sources = config.testRelated ? changed.filter((p) => !p.startsWith("../") && p in snap.files) : [];
      if (!files.length && !sources.length) {
        ctx.err(`verify: ${name} skipped (no related test files)`);
        commands.push({ ...row, skipped: "no related test files", ms: 0 });
        continue;
      }
      row.files = files;
      run = { ...entry, cmd: (config.testRelated ?? config.testFiles).split("{files}").join([...sources, ...files].map(quote).join(" ")) };
      if (greenOnThisTree(entry, key, run.cmd)) {
        commands.push(repeated(row, key));
        continue;
      }
    }
    ctx.err(`verify: ${name} (timeout ${entry.timeout}s)`);
    // a related template handed only source may find no test for it: the final suite runs later
    const readsTotals = stamped && runsTests(run.cmd, config.testFiles) && !(config.testRelated && entry.related && !row.files.length);
    const ranAt = Date.now();
    const { output, ...result } = { ...row, ...(await runCommand({ ...run, whole: readsTotals }, entry.cwd ?? ctx.root, { onSpawn: (pgid) => lock?.setGroup(pgid), env: lock ? { [HELD_ENV]: String(process.pid) } : {} })) };
    if (entry.related) Object.assign(result, { cmd: entry.cmd, ran: run.cmd });
    // a test run's failures print file:line too: onlyNew never reads one
    if (entry.onlyNew && !runsTests(entry.cmd) && result.exit === 1 && !result.timedOut && output) {
      const old = oldFindingsOnly(output, entry, ctx, config);
      if (old) Object.assign(result, { exit: 0, rawExit: 1, oldFindings: old.length, oldList: old.slice(0, 20) });
    }
    if (stamped && result.exit === 0 && !result.timedOut) {
      const why = entry.report ? reportProblem(path.resolve(entry.cwd ?? ctx.root, entry.report), ranAt) : readsTotals && ranNoTests(output) ? "its summary shows no test" : null;
      if (why) Object.assign(result, { exit: 1, rawExit: 0, noTests: true, noTestsWhy: why });
    }
    commands.push(result);
    if (result.exit === 0 && !result.timedOut) {
      greenAt[key] = scopeOf(entry.repo ?? null).implementation;
      if (isFinal) greenSource[key] = sourceNow;
      const { oldFindings, oldList, rawExit } = result;
      greenTree[key] = { tree: snap.hash, cmd: run.cmd, ...(oldFindings ? { oldFindings, oldList, rawExit } : {}) };
    } else {
      delete greenAt[key];
      delete greenSource[key];
      delete greenTree[key];
    }
    ctx.err(`  → ${result.timedOut ? "TIMED OUT" : `exit ${result.exit}`} in ${(result.ms / 1000).toFixed(1)}s`);
  }
  // code that moved while the commands ran was not what they judged: none of this counts as green
  const after = stamped ? snapshot(ctx.root, snap, repos) : snap;
  const moved = sourceHash(after, config) === sourceNow ? [] : diffSnapshots(snap, after).changed.filter((p) => config.isSource(p));
  const greens = moved.length
    ? { greenAt: lastGreen(file), greenSource: lastGreen(file, "greenSource"), greenTree: lastGreen(file, "greenTree") }
    : { greenAt, greenSource, ...(stamped ? { greenTree } : {}) };
  const before = lastGreen(file, "history");
  const history = [...(Array.isArray(before) ? before : []), {
    at: startedAt,
    sourceHash: sourceNow,
    treeHash: snap.hash,
    ran: commands.filter((c) => !c.skipped).map(verifyKey),
    skipped: commands.filter((c) => c.skipped).length,
    ms: commands.reduce((sum, c) => sum + (c.ms ?? 0), 0),
  }].slice(-HISTORY_KEPT);
  const record = { startedAt, finishedAt: new Date().toISOString(), sourceHash: sourceNow, ...greens, commands, history };
  // a green e2e entry is the drive, for this code only: nothing if it moved. On a skip the code is
  // what a green run judged, as after an edit and an undo, so the mark says so and is no run itself.
  const drove = stamped && !moved.length && driverCmd ? commands.find((c) => !c.repo && c.cmd.trim() === driverCmd && (c.skipped ? c.covers || c.greenCode : c.exit === 0 && !c.timedOut)) : null;
  const driveEvent = drove ? { seq: nextSeq(), ts: new Date().toISOString(), session: ctx.session, agent: null, agentType: null, kind: "command", tool: "Bash", cmd: driverCmd, exit: 0, readOnly: true, runs: true, viaVerify: true, ...(drove.skipped ? { reused: true } : {}) } : null;
  if (driveEvent) appendEvents(ctx.stateDir, ctx.session, [driveEvent]);
  // written whole: a Stop hook may read it while a background verify is still writing
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${file}.${process.pid}.tmp`, file);
  rmSync(started, { force: true });
  lock?.release();

  const red = commands.filter((c) => !c.skipped && (c.exit !== 0 || c.timedOut));
  const ledger = loadLedger(current.dir);
  const step = ledger.steps.find((s) => s.key === stepKey);
  if (step && red.length === 0 && !moved.length) {
    Object.assign(step, { state: "DONE", evidence: "verify.json", note: `${commands.length} command(s) green`, seq: nextSeq() });
    // judged from the tree this run started on: an edit during the commands is the next check's
    if (stepKey === "verify") workOutSteps(ledger, config, touched, implementationHash(snap, config));
  }
  saveLedger(current.dir, ledger);
  return { record, red, moved, driveEvent, driverCmd, dir: current.dir };
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
    const force = ctx.args.includes("--force");
    const { record, red, moved, driveEvent, driverCmd, dir } = await runVerify(ctx, { stepKey, force, final: force || ctx.args.includes("--final") });
    for (const c of record.commands) {
      if (c.skipped) {
        ctx.out(`– ${c.cmd}${verifyWhere(c)} — skipped: ${c.skipped}${c.oldFindings ? ` (${c.oldFindings} old finding${c.oldFindings === 1 ? "" : "s"} off this task's lines ignored)` : ""}`);
        continue;
      }
      const green = c.exit === 0 && !c.timedOut;
      ctx.out(`${green ? "✓" : "✗"} ${c.cmd}${verifyWhere(c)} — ${c.timedOut ? "timed out" : c.noTests ? `no tests ran: ${c.noTestsWhy}` : `exit ${c.exit}`}${c.oldFindings ? ` (exit ${c.rawExit}: ${c.oldFindings} old finding${c.oldFindings === 1 ? "" : "s"} off this task's lines ignored)` : ""}, ${(c.ms / 1000).toFixed(1)}s`);
      if (!green) ctx.out("```\n" + c.tail.split("\n").slice(-12).join("\n") + "\n```"); // the failing tail: the same 12 lines the report shows
      if (!green && c.cmd.trim() === driverCmd && PORT_IN_USE.test(c.tail ?? "")) ctx.out(`hint: \`${c.cmd}\` says its port is in use: a dev server may still be running. Stop it, or have the run reuse it.`);
    }
    if (driveEvent) ctx.out(`drive recorded${driveEvent.reused ? " (the code is as it was at that green run)" : ""}: close the step with \`gate step driver done "<what it showed>" --evidence events#${driveEvent.seq}\``);
    const ran = record.commands.filter((c) => !c.skipped).length;
    if (record.commands.some((c) => c.owed)) ctx.out("final check owed: run `gate verify --final` once your edits are done (it may run in the background while review runs)");
    if (moved.length) ctx.out(`source changed while verify ran (${moved.slice(0, 5).join(", ")}): nothing recorded green and step {${stepKey}} stays open; run \`gate verify\` again once nothing is writing`);
    else ctx.out(red.length ? `${red.length} of ${ran} red — fix and run \`gate verify\` again` : `all ${ran} green — step {${stepKey}} closed with verify.json`);
    // the lead runs verify after its edits, so the advice reaches it mid-run, not only in the report
    const ledger = loadLedger(dir);
    const advice = splitAdvice(policyFor(ledger), ledger.tier?.measured);
    if (advice) ctx.out(`advice: ${advice}`);
    printNext(ctx);
  },
};
