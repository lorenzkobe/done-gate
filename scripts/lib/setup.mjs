import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configPath, loadConfig, matchGlob } from "./config.mjs";
import { segments, withoutHeredocs } from "./guard.mjs";
import { UsageError } from "./context.mjs";
import { readEvents } from "./events.mjs";
import { currentLedger, isDone, openRuns, saveLedger, staleForeign } from "./ledger.mjs";
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
// programs that read a folder without running its tests: never the testFiles wrapper
const CHECKERS = new Set(["ruff", "eslint", "prettier", "black", "flake8", "pylint", "mypy", "pyright", "tsc", "biome", "isort", "stylelint", "rubocop", "golangci-lint", "shellcheck"]);
const DROPS = new Set(["--deselect", "--ignore", "--ignore-glob", "-k"]);
export const shellWord = (w) => (/^[\w@%+=:,./{}-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

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
    // the repo folder itself names no tests: `./lint.sh .` reads everything
    const isPath = (w, i) => {
      if (i === 0 || w.startsWith("-")) return false;
      const bare = w.split("::")[0].replace(/\/$/, "");
      if (GLOB.test(bare)) return files.some((f) => matchGlob(bare, f));
      const abs = path.join(root, bare);
      return abs !== root && existsSync(abs) && (statSync(abs).isDirectory() || config.isTest(bare));
    };
    const at = words.map((w, i) => (isPath(w, i) ? i : -1)).filter((i) => i >= 0);
    if (!at.length || at[0] === 0 || words.slice(0, at[0]).some((w) => CHECKERS.has(path.basename(w)))) continue;
    const rest = [];
    for (let i = at.at(-1) + 1; i < words.length; i++) {
      if (DROPS.has(words[i])) i++;
      else if (!/^(?:--deselect|--ignore|--ignore-glob|-k)=/.test(words[i])) rest.push(words[i]);
    }
    return [...words.slice(0, at[0]).map(shellWord), "{files}", ...rest.map(shellWord)].join(" ");
  }
  return null;
}

const API_LAYOUTS = ["app/api", "pages/api", "src/app/api", "src/pages/api"];
const INTERACTIVE = /\s--(?:ui|headed|debug)\b|\bcypress open\b/;
const E2E_SCRIPT = /\b(?:playwright test|cypress run)\b/;
const E2E_IN_VERIFY = /\b(?:playwright|cypress)\b|e2e/i;

function packageRun(root, script) {
  if (has(root, "pnpm-lock.yaml")) return `pnpm run ${script}`;
  return has(root, "yarn.lock") ? `yarn ${script}` : `npm run ${script}`;
}

// The repo's end-to-end command: one verify already runs, else a package script, else a config
// file. A script that waits for a person, or runs something else first, is no run to wait on.
function e2eCommand(root, config) {
  const there = config.verify.find((v) => !v.related && E2E_IN_VERIFY.test(v.cmd));
  if (there) return { cmd: there.cmd, inVerify: true };
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
  } catch {
    // no package.json, or one that does not parse: the config files can still say
  }
  const named = typeof scripts["test:e2e"] === "string" && !INTERACTIVE.test(scripts["test:e2e"]) ? "test:e2e" : null;
  const script = named ?? Object.keys(scripts).sort().find((s) => typeof scripts[s] === "string" && E2E_SCRIPT.test(scripts[s]) && !INTERACTIVE.test(scripts[s]) && !/&&|;/.test(scripts[s]));
  if (script) return { cmd: packageRun(root, script) };
  const configured = (tool) => ["ts", "js", "mjs", "cjs"].some((ext) => has(root, `${tool}.config.${ext}`));
  if (configured("playwright")) return { cmd: "npx playwright test" };
  return configured("cypress") ? { cmd: "npx cypress run" } : null;
}

const holdsFile = (dir) => {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

// What later releases added that this repo has not been asked about. `set` is what an offer writes;
// one with none is a note the user may act on. gate.json's offered list keeps each one to one ask.
function offers(root, raw, config) {
  const asked = new Set(Array.isArray(raw.offered) ? raw.offered : []);
  const out = [];
  if (!asked.has("api") && !Array.isArray(raw.api)) {
    const api = API_LAYOUTS.filter((dir) => holdsFile(path.join(root, dir))).map((dir) => `${dir}/**`);
    if (api.length) out.push({ key: "api", set: { api }, note: `api is read from the folders here (${api.join(", ")}): a change there closes on a recorded call to the endpoint. Add other server routes, or use [] if this repo serves none.` });
  }
  const e2e = asked.has("e2e") ? null : e2eCommand(root, config);
  if (e2e) {
    const skill = has(root, ".claude/skills/verify/SKILL.md");
    if (raw.driver || skill) {
      out.push({ key: "e2e", note: `\`${e2e.cmd}\` looks like this repo's end-to-end run, and ${raw.driver ? `gate.json's driver is ${raw.driver}` : "this repo has a verify skill as its driver"}. Kept as it is. For a green run in verify to count as the drive instead, set "driver": "cmd:${e2e.cmd}" and list it in verify.` });
    } else {
      const entry = e2e.inVerify ? null : { cmd: e2e.cmd, when: "final" };
      out.push({ key: "e2e", entry, set: { driver: `cmd:${e2e.cmd}` }, note: `\`${e2e.cmd}\` becomes the driver${entry ? " and the final check" : ""}: a green run counts as driving the app. Tell the user what it costs: it runs at the close of a task that changed code, unless ui and api are both listed and no such file changed, and a red or flaky run blocks that close.` });
    }
  }
  return out;
}

function withOffers(json, list, config) {
  const out = { ...json };
  for (const offer of list) Object.assign(out, offer.set ?? {});
  const entries = list.map((o) => o.entry).filter(Boolean);
  if (entries.length) out.verify = [...(Array.isArray(out.verify) ? out.verify : config.verify.map(written)), ...entries];
  if (list.length) out.offered = [...new Set([...(Array.isArray(json.offered) ? json.offered : []), ...list.map((o) => o.key)])];
  return out;
}

// First setup has been answered: a usable testFiles, or a recorded no.
const answeredSetup = (raw) => Boolean(raw) && "testFiles" in raw && !(typeof raw.testFiles === "string" && !usable(raw.testFiles));

// What the session-start notice names: a note changes nothing, so it is not worth a turn each session.
export function pendingOffers(root) {
  const raw = rawConfig(root);
  if (!answeredSetup(raw)) return [];
  return offers(root, raw, loadConfig(root)).filter((o) => o.set);
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

// The paths a command's words name: test files by the repo's globs, and whether any is wider (a
// folder or a glob). `bash -c "…"` is read as the command it holds.
function namedPaths(root, cmd, config) {
  const out = { files: 0, wide: false };
  for (const seg of segments(withoutHeredocs(cmd))) {
    const words = seg.map((w) => w.text).filter((w) => w !== "");
    if (/^(?:bash|sh|zsh)$/.test(path.basename(words[0] ?? "")) && words[1] === "-c" && words[2]) {
      const inner = namedPaths(root, words[2], config);
      out.files += inner.files;
      out.wide ||= inner.wide;
      continue;
    }
    for (const w of words.slice(1)) {
      if (w.startsWith("-")) continue;
      const bare = w.split("::")[0].replace(/\/$/, "");
      if (GLOB.test(bare)) out.wide = true;
      else if (existsSync(path.join(root, bare)) && statSync(path.join(root, bare)).isDirectory()) out.wide = true;
      else if (config.isTest(bare) && existsSync(path.join(root, bare))) out.files += 1;
    }
  }
  return out;
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
  const testCmd = (v) => !v.related && runsTests(v.cmd, testFiles);
  // a test command that names single test files and nothing wider is the last tickets' list:
  // once testFiles exists, the related entry runs each task's own tests instead
  const perTicket = (v) => Boolean(testFiles) && testCmd(v) && v.when !== "final" && (({ files, wide }) => files > 0 && !wide)(namedPaths(root, v.cmd, config));
  const dropped = config.verify.filter(perTicket).map((v) => v.cmd);
  const entries = config.verify.flatMap((v, i) => {
    const original = rawVerify?.[i];
    if (perTicket(v)) return [];
    if (v.related || v.when === "final" || v.when === "source" || !testCmd(v)) return [original ?? written(v)];
    const base = typeof original === "object" && original ? original : written(v);
    return [typeof base === "string" ? { cmd: base, when: "final" } : { ...base, when: "final" }];
  });
  // a related entry needs testFiles, or every verify refuses to start
  if (testFiles && !config.verify.some((v) => v.related)) {
    const at = entries.findIndex((e) => typeof e === "object" && e.when === "final");
    entries.splice(at < 0 ? entries.length : at, 0, { related: true });
  }
  const list = offers(root, raw, config);
  const proposal = withOffers({ ...raw, ...(testFiles ? { testFiles } : {}), verify: entries }, list, config);
  if (!testFiles) delete proposal.testFiles;
  if (!testFiles) notes.push('No test runner was detected: fill in testFiles by hand, the command that runs given test files with {files} where they go, then add { "related": true } to verify.');
  else if (wrapped) notes.push(`testFiles is taken from how verify already runs named test files: ${wrapped.cmd.length > 120 ? `${wrapped.cmd.slice(0, 117)}...` : wrapped.cmd}`);
  else notes.push(`testFiles is a guess from the repo (${testFiles}): if tests run through a wrapper (a test database script, a container), use that instead.`);
  for (const cmd of dropped) notes.push(`Left out of verify, since it names only single test files (a past task's list) and the related entry runs each task's own tests (if it is the suite, put it back with "when": "final"): ${cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd}`);
  if (wrapped && /(?:^|[^a-z])(?:db|database|postgres|mysql|mongo|docker|compose)(?![a-z])/i.test(wrapped.template)) notes.push("That wrapper looks like a shared test database: test runs through it likely must not overlap, so \"serialTests\": true is probably right.");
  if (!entries.some((e) => typeof e === "object" && e.when === "final")) notes.push('No test command to run as the final check: add one with "when": "final" (the area suite, green at HEAD).');
  else notes.push("The final command must pass at HEAD: deselect failures that are already there, or every close blocks on them. Narrow it to the area you work in if the whole suite is slow; CI runs the full suite.");
  for (const offer of list) notes.push(offer.note);
  notes.push('Ask the user whether tests share one database or folder; if they do, add "serialTests": true so test runs never overlap.');
  return { proposal, notes };
}

function guardSetUp(ctx) {
  if (!needsSetup(ctx.root) && !pendingOffers(ctx.root).length) throw new UsageError("this repo is already set up (gate.json has testFiles, or a recorded no): change gate.json in a task run instead");
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
  if ((current && !isDone(current.ledger)) || openRuns(ctx.stateDir).some((r) => r.ledger.status !== "closed" && !staleForeign(r, ctx.session))) {
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
  // only stale runs can still be open here: the change is the user's, not a task's, so it is no R13 when one resumes
  const hash = loadConfig(ctx.root).hash;
  for (const { dir, ledger } of openRuns(ctx.stateDir).filter((r) => r.ledger.status !== "closed")) {
    saveLedger(dir, { ...ledger, gateHash: hash, caveats: [...(ledger.caveats ?? []), `gate setup changed gate.json on ${new Date().toISOString().slice(0, 10)} while this run sat idle.`] });
  }
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
      const raw = rawConfig(ctx.root) ?? {};
      const asked = offers(ctx.root, raw, loadConfig(ctx.root)).map((o) => ({ key: o.key }));
      if (needsSetup(ctx.root)) {
        writeConfig(ctx, withOffers({ ...raw, testFiles: null }, asked));
        ctx.out(`gate.json: "testFiles": null recorded (the user: "${words}"); the faster test loop will not be proposed again`);
      } else {
        writeConfig(ctx, withOffers(raw, asked));
        ctx.out(`gate.json: offered ${asked.map((o) => o.key).join(", ")} recorded (the user: "${words}"); they will not be proposed again`);
      }
      return;
    }
    if (args.includes("--apply")) {
      guardNoRun(ctx);
      guardSetUp(ctx);
      const words = userOk(ctx, args);
      const named = args[args.indexOf("--apply") + 1];
      const first = needsSetup(ctx.root);
      const raw = rawConfig(ctx.root) ?? {};
      const config = loadConfig(ctx.root);
      const list = offers(ctx.root, raw, config);
      if (!first && named && !named.startsWith("--")) throw new UsageError("this repo is already set up: gate setup --apply writes only the new keys it proposed, not a whole file. Change anything else in a task run.");
      let json = first ? proposeSetup(ctx.root).proposal : withOffers(raw, list, config);
      if (named && !named.startsWith("--")) {
        try {
          json = JSON.parse(readFileSync(path.resolve(ctx.root, named), "utf8"));
        } catch (error) {
          throw new UsageError(`${named}: not a JSON file the gate can read (${error.message})`);
        }
      }
      // a file the user edited still counts as the answer to what was asked
      if (list.length) json = { ...json, offered: [...new Set([...(json.offered ?? []), ...(raw.offered ?? []), ...list.map((o) => o.key)])] };
      writeConfig(ctx, validated(json, named && !named.startsWith("--") ? named : "the proposal"));
      ctx.out(`gate.json written (the user: "${words}"); the next run uses it`);
      return;
    }
    const raw = rawConfig(ctx.root);
    if (answeredSetup(raw)) {
      const config = loadConfig(ctx.root);
      const list = offers(ctx.root, raw, config);
      if (!list.some((o) => o.set)) {
        ctx.out("this repo is already set up: nothing new to propose.");
        for (const offer of list) ctx.out(`- ${offer.note}`);
        return;
      }
      ctx.out(`Proposed ${GATE_JSON}, new keys only (nothing written):\n${JSON.stringify(withOffers(raw, list, config), null, 2)}`);
      ctx.out(`\n${list.map((o) => `- ${o.note}`).join("\n")}`);
      ctx.out('\nShow it to the user. On their yes: `gate setup --apply --user-ok "<their words>"`; on a no: `gate setup --decline --user-ok "<their words>"`. It is asked once.');
      return;
    }
    const { proposal, notes } = proposeSetup(ctx.root);
    ctx.out(`Proposed ${GATE_JSON} (nothing written):\n${JSON.stringify(proposal, null, 2)}`);
    ctx.out(`\n${notes.map((n) => `- ${n}`).join("\n")}`);
    ctx.out('\nShow it to the user. On their yes: `gate setup --apply [edited.json] --user-ok "<their words>"`; on a no: `gate setup --decline --user-ok "<their words>"`.');
  },
};
