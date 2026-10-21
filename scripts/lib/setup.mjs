import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configPath, loadConfig, matchGlob } from "./config.mjs";
import { segments, withoutHeredocs } from "./guard.mjs";
import { UsageError } from "./context.mjs";
import { readEvents } from "./events.mjs";
import { currentLedger, isDone, openRuns } from "./ledger.mjs";
import { saidSince } from "./rules.mjs";
import { loadSession, saveSession } from "./session-state.mjs";
import { snapshot } from "./tree.mjs";
import { runsTests } from "./verify.mjs";

const GATE_JSON = ".claude/gate.json";

function rawConfig(root) {
  const file = configPath(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(`.claude/gate.json is not valid JSON (${error.message}): fix it first`);
  }
}
const usable = (testFiles) => typeof testFiles === "string" && testFiles.includes("{files}");

const has = (root, rel) => existsSync(path.join(root, rel));
const holds = (root, rel, re) => has(root, rel) && re.test(readFileSync(path.join(root, rel), "utf8"));

// The runner for given test files, from positive evidence only: a pyproject.toml that configures
// ruff or poetry alone is not pytest.
function runner(root) {
  let deps = {};
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (/node\s+--test/.test(String(pkg.scripts?.test ?? ""))) return "node --test {files}";
  } catch {
    // no package.json, or unreadable
  }
  if ("vitest" in deps) return "npx vitest run {files}";
  if ("jest" in deps) return "npx jest {files}";
  if ("mocha" in deps) return "npx mocha {files}";
  if ("ava" in deps) return "npx ava {files}";
  const pytest = has(root, "pytest.ini") || has(root, "conftest.py") || has(root, "tests/conftest.py")
    || holds(root, "pyproject.toml", /\[tool\.pytest/) || holds(root, "setup.cfg", /\[tool:pytest\]/) || holds(root, "tox.ini", /\[pytest\]/);
  if (!pytest) return null;
  if (has(root, "venv/bin/python")) return "./venv/bin/python -m pytest {files} -q";
  if (has(root, ".venv/bin/python")) return "./.venv/bin/python -m pytest {files} -q";
  if (has(root, "poetry.lock")) return "poetry run pytest {files} -q";
  if (has(root, "uv.lock")) return "uv run pytest {files} -q";
  return "python3 -m pytest {files} -q";
}

const GLOB = /[*?[{]/;
const DROPS = new Set(["--deselect", "--ignore", "--ignore-glob", "-k"]);
const shellWord = (w) => (/^[\w@%+=:,./{}-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

// The wrapper a verify command already runs named test files through (a test database script,
// a container): its words before the first path, {files}, then its flags after the last path
// without the ones that name tests (--deselect, --ignore, -k). Null when no command names one.
function wrapperOf(root, cmd, files, config) {
  for (const seg of segments(withoutHeredocs(cmd))) {
    const words = seg.map((w) => w.text).filter((w) => w !== "");
    if (/^(?:bash|sh|zsh)$/.test(path.basename(words[0] ?? "")) && words[1] === "-c" && words[2]) {
      const inner = wrapperOf(root, words[2], files, config);
      if (inner) return inner;
      continue;
    }
    // a test file by the repo's globs, a folder, or a glob over files; never the program itself
    const isPath = (w, i) => {
      if (i === 0 || w.startsWith("-")) return false;
      const bare = w.split("::")[0].replace(/\/$/, "");
      if (GLOB.test(bare)) return files.some((f) => matchGlob(bare, f));
      const abs = path.join(root, bare);
      return existsSync(abs) && (statSync(abs).isDirectory() || config.isTest(bare));
    };
    const at = words.map((w, i) => (isPath(w, i) ? i : -1)).filter((i) => i >= 0);
    if (!at.length || at[0] === 0) continue;
    const rest = [];
    for (let i = at.at(-1) + 1; i < words.length; i++) {
      if (DROPS.has(words[i])) i++;
      else if (!/^(?:--deselect|--ignore|--ignore-glob|-k)=/.test(words[i])) rest.push(words[i]);
    }
    return [...words.slice(0, at[0]).map(shellWord), "{files}", ...rest.map(shellWord)].join(" ");
  }
  return null;
}

// A repo is asked once: when it has tests and its gate.json has no usable testFiles key. An
// explicit null is a recorded no.
export function needsSetup(root) {
  const raw = rawConfig(root) ?? {};
  if ("testFiles" in raw && !(typeof raw.testFiles === "string" && !usable(raw.testFiles))) return false;
  return runner(root) !== null || loadConfig(root).verify.some((v) => runsTests(v.cmd));
}

// A verify entry as gate.json writes it: a plain string for an always command with nothing else.
function written(v) {
  if (v.related) return { related: true, ...(v.timeout !== 600 ? { timeout: v.timeout } : {}) };
  const extra = { ...(v.timeout !== 600 ? { timeout: v.timeout } : {}), ...(v.when !== "always" ? { when: v.when } : {}), ...(v.onlyNew ? { onlyNew: true } : {}) };
  return Object.keys(extra).length ? { cmd: v.cmd, ...extra } : v.cmd;
}

// gate.json with the faster test loop's keys added; every key it had is kept. The test-running
// verify commands become the final check, and the related entry runs before them.
export function proposeSetup(root) {
  const raw = rawConfig(root) ?? {};
  const config = loadConfig(root);
  const notes = [];
  const files = Object.keys(snapshot(root).files);
  const wrapped = config.verify.map((v) => (v.related ? null : { cmd: v.cmd, template: wrapperOf(root, v.cmd, files, config) })).find((w) => w?.template);
  const testFiles = usable(raw.testFiles) ? raw.testFiles : wrapped?.template ?? runner(root);
  const rawVerify = Array.isArray(raw.verify) ? raw.verify : null;
  const entries = config.verify.map((v, i) => {
    const original = rawVerify?.[i];
    if (v.related || v.when === "final" || v.when === "source" || !runsTests(v.cmd)) return original ?? written(v);
    const base = typeof original === "object" && original ? original : written(v);
    return typeof base === "string" ? { cmd: base, when: "final" } : { ...base, when: "final" };
  });
  // a related entry needs testFiles, or every verify refuses to start
  if (testFiles && !config.verify.some((v) => v.related)) {
    const at = entries.findIndex((e) => typeof e === "object" && e.when === "final");
    entries.splice(at < 0 ? entries.length : at, 0, { related: true });
  }
  const proposal = { ...raw, ...(testFiles ? { testFiles } : {}), verify: entries };
  if (!testFiles) delete proposal.testFiles;
  if (!testFiles) notes.push('No test runner was detected: fill in testFiles by hand, the command that runs given test files with {files} where they go, then add { "related": true } to verify.');
  else if (usable(raw.testFiles)) notes.push("testFiles is the one gate.json already has.");
  else if (wrapped) notes.push(`testFiles is taken from how verify already runs named test files: ${wrapped.cmd.length > 120 ? `${wrapped.cmd.slice(0, 117)}...` : wrapped.cmd}`);
  else notes.push(`testFiles is a guess from the repo (${testFiles}): if tests run through a wrapper (a test database script, a container), use that instead.`);
  if (wrapped && /(?:^|[^a-z])(?:db|database|postgres|mysql|mongo|docker|compose)(?![a-z])/i.test(wrapped.template)) notes.push("That wrapper looks like a shared test database: test runs through it likely must not overlap, so \"serialTests\": true is probably right.");
  if (!entries.some((e) => typeof e === "object" && e.when === "final")) notes.push('No test command to run as the final check: add one with "when": "final" (the area suite, green at HEAD).');
  else notes.push("The final command must pass at HEAD: deselect failures that are already there, or every close blocks on them. Narrow it to the area you work in if the whole suite is slow; CI runs the full suite.");
  notes.push('Ask the user whether tests share one database or folder; if they do, add "serialTests": true so test runs never overlap.');
  return { proposal, notes };
}

function guardSetUp(ctx) {
  if (!needsSetup(ctx.root)) throw new UsageError("this repo is already set up (gate.json has testFiles, or a recorded no): change gate.json in a task run instead");
}

// what --apply would write: a testFiles with {files}, and a related entry only beside it
function validated(json, name) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new UsageError(`${name}: gate.json is a JSON object`);
  if ("testFiles" in json && json.testFiles !== null && !usable(json.testFiles)) throw new UsageError(`${name}: testFiles must be a command with {files} where the test files go`);
  if ("verify" in json && !Array.isArray(json.verify)) throw new UsageError(`${name}: verify is a list of commands`);
  if ((json.verify ?? []).some((e) => e && e.related === true) && !usable(json.testFiles)) throw new UsageError(`${name}: a {"related": true} entry needs testFiles`);
  return json;
}

function guardNoRun(ctx) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if ((current && !isDone(current.ledger)) || openRuns(ctx.stateDir).some((r) => r.ledger.status !== "closed")) {
    throw new UsageError("a run is open: changing gate.json now trips R13. Close or abandon the run first, then set up.");
  }
}

function userOk(ctx, args) {
  const at = args.indexOf("--user-ok");
  const words = at >= 0 ? args[at + 1] : undefined;
  const tell = 'show the user the proposal and ask; then pass --user-ok "<their words, at least three>"';
  if (!words?.trim() || words.startsWith("--")) throw new UsageError(`changing gate.json is the user's call: ${tell}`);
  const session = loadSession(ctx.stateDir, ctx.session);
  if (!saidSince(readEvents(ctx.stateDir, ctx.session), session?.baselineSeq ?? 0, words)) throw new UsageError(`the user did not say "${words}" in this session: ${tell}`);
  return words.trim();
}

// Writes gate.json and moves the session's baseline to it, so the write is not this session's
// task work (R1).
function writeConfig(ctx, json) {
  const file = configPath(ctx.root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  const session = loadSession(ctx.stateDir, ctx.session);
  if (!session) return;
  const entry = snapshot(ctx.root, session.lastTree ?? session.baseline).files[GATE_JSON];
  const at = (tree) => (tree ? { ...tree, files: { ...tree.files, [GATE_JSON]: entry } } : tree);
  saveSession(ctx.stateDir, { ...session, baseline: at(session.baseline), ...(session.lastTree ? { lastTree: at(session.lastTree) } : {}) });
}

export const verbs = {
  setup(ctx) {
    const args = ctx.args;
    if (args.includes("--decline")) {
      guardNoRun(ctx);
      guardSetUp(ctx);
      const words = userOk(ctx, args);
      writeConfig(ctx, { ...(rawConfig(ctx.root) ?? {}), testFiles: null });
      ctx.out(`gate.json: "testFiles": null recorded (the user: "${words}"); the faster test loop will not be proposed again`);
      return;
    }
    if (args.includes("--apply")) {
      guardNoRun(ctx);
      guardSetUp(ctx);
      const words = userOk(ctx, args);
      const named = args[args.indexOf("--apply") + 1];
      let json = proposeSetup(ctx.root).proposal;
      if (named && !named.startsWith("--")) {
        try {
          json = JSON.parse(readFileSync(path.resolve(ctx.root, named), "utf8"));
        } catch (error) {
          throw new UsageError(`${named}: not a JSON file the gate can read (${error.message})`);
        }
      }
      writeConfig(ctx, validated(json, named && !named.startsWith("--") ? named : "the proposal"));
      ctx.out(`gate.json written (the user: "${words}"); the next run uses it`);
      return;
    }
    const { proposal, notes } = proposeSetup(ctx.root);
    ctx.out(`Proposed ${GATE_JSON} (nothing written):\n${JSON.stringify(proposal, null, 2)}`);
    ctx.out(`\n${notes.map((n) => `- ${n}`).join("\n")}`);
    ctx.out('\nShow it to the user. On their yes: `gate setup --apply [edited.json] --user-ok "<their words>"`; on a no: `gate setup --decline --user-ok "<their words>"`.');
  },
};
