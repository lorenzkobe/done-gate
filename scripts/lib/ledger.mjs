import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, repoConfig } from "./config.mjs";
import { nextSeq, readEvents } from "./events.mjs";
import { repoPath } from "./paths.mjs";
import { ensureSession, loadSession, saveSession, updateSession } from "./session-state.mjs";
import { needsSetup, shellWord } from "./setup.mjs";
import { baseCopyPath, diffSnapshots, gitHead, gitNumstat, gitTop, gitTracked, snapshot, taskBaseline, withRepoAtHead, withRepos, withoutRepos } from "./tree.mjs";
import { emptyTier } from "./size.mjs";
// size.mjs imports assess.mjs, which imports this module: loadPolicy is only ever called at
// verb time, never at module top level, or the cycle would hit a TDZ error.
import { loadPolicy } from "./size.mjs";
import { helpersOut, implementationHash, newRules, saidSince } from "./rules.mjs";
import { carryStanding, requireLiveBatch } from "./standing.mjs";
import { leftBehind } from "./diagnose.mjs";
import { knownNewer, UPDATE_COMMANDS } from "./release.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLAYBOOKS = ["feature", "bugfix", "refactor", "plan", "investigation"];

// `## <heading>` section of a markdown file, HTML comments stripped, trimmed; "" when absent.
export function section(md, heading) {
  const m = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(md ?? "");
  return m ? m[1].replace(/<!--[\s\S]*?-->/g, "").trim() : "";
}

export function runsDir(stateDir) {
  return path.join(stateDir, "runs");
}

// A ledger the gate no longer governs: closed with evidence, or abandoned by the user.
export function isDone(ledger) {
  return ledger?.status === "closed" || ledger?.status === "abandoned";
}

export function loadLedger(dir) {
  return JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8").replace(/\r/g, ""));
}

// Written whole then renamed, so a reader (or a second writer) never sees a torn file.
export function saveLedger(dir, ledger) {
  ledger.seq = nextSeq();
  ledger.updatedAt = new Date().toISOString();
  const file = path.join(dir, "ledger.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, file);
  return ledger;
}

// Playbook steps: the `## <name>` section of playbooks.md, numbered lines, optional
// trailing {key} naming the evidence kind.
export function playbookSteps(playbook) {
  const file = path.join(pluginRoot, "skills", "gate", "playbooks.md");
  const text = section(readFileSync(file, "utf8").replace(/\r/g, ""), playbook);
  if (!PLAYBOOKS.includes(playbook) || !text) throw new UsageError(`unknown playbook "${playbook}" (have: ${PLAYBOOKS.join(", ")})`);
  const steps = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+)\.\s+(.*?)\s*(?:\{([a-z-]+)\})?\s*$/.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    steps.push({ n: Number(m[1]), key: m[3] ?? null, text: m[2], state: null, note: null, evidence: null, seq: null });
  }
  return steps;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
}

export function findRun(stateDir, slug) {
  const dir = runsDir(stateDir);
  if (!existsSync(dir)) return null;
  const s = slugify(slug);
  const candidates = readdirSync(dir)
    .filter((d) => d === s || d.endsWith(`-${s}`))
    .map((d) => path.join(dir, d))
    .filter((d) => existsSync(path.join(d, "ledger.json")))
    .sort();
  for (const d of candidates.reverse()) {
    const ledger = loadLedger(d);
    if (!isDone(ledger)) return { dir: d, ledger };
  }
  return null;
}

function ensureGitignore(root) {
  const file = path.join(root, ".gitignore");
  const line = ".claude/gate/";
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) return;
  appendFileSync(file, `${current.length && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

const BASED_MAX_FILES = 200;
const BASED_MAX_BYTES = 1024 * 1024;

// Copies each source file already modified or untracked at open to its base copy in the run
// dir, so its diff starts at open; only text whose content is what the task baseline holds qualifies.
function copyBases(root, dir, start, dirty, config, repos, head, heads) {
  if (!head && !repos.length) return [];
  const tracked = gitTracked(root, repos);
  const untracked = Object.keys(start.files).filter((rel) => !tracked.has(rel)).sort();
  const based = [];
  for (const rel of [...dirty, ...untracked]) {
    if (based.length === BASED_MAX_FILES) break;
    const entry = start.files[rel];
    if (!entry || entry.l === null || entry.s > BASED_MAX_BYTES || !config.isSource(rel)) continue;
    const at = repoPath(root, rel, repos);
    // in a root with no commit every file is untracked: nothing there is copied
    if (!(at.index < 0 ? head : heads[at.prefix])) continue;
    const abs = path.join(at.repoRoot, at.rel);
    if (!existsSync(abs) || statSync(abs).size !== entry.s) continue;
    const buf = readFileSync(abs);
    if (createHash("sha1").update(buf).digest("hex") !== entry.h) continue;
    const copy = baseCopyPath(dir, rel, repos);
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, buf);
    based.push(rel);
  }
  return based;
}

const TEMPLATE = `# {{slug}} — {{playbook}} (opened {{opened}})

## Task

<!-- The user's ask, quoted. Then one paragraph in your own words. -->

## Context

<!-- Traced: entry points, callers, data flow as file:line. Related: what depends on it. Research: what was looked up, or none needed: why. -->

## Plan

<!-- Approach. Files to touch. If data is touched: queries, indexes, payload, client fetching, cost surface. -->
`;

function template() {
  return TEMPLATE;
}

export function attachLedger(ctx, slug) {
  const found = findRun(ctx.stateDir, slug);
  if (!found) throw new UsageError(`no run for slug "${slug}" — use \`gate open ${slug} <playbook>\``);
  const { dir, ledger } = found;
  // a session that attaches again has a fresh context: its step hints start over in full
  const hinted = ledger.hinted?.[ctx.session];
  if (hinted) delete ledger.hinted[ctx.session];
  const joins = !ledger.sessions.includes(ctx.session);
  if (joins) ledger.sessions.push(ctx.session);
  if (joins || hinted) saveLedger(dir, ledger);
  ensureSession(ctx.stateDir, ctx.root, ctx.session);
  updateSession(ctx.stateDir, ctx.session, { current: path.basename(dir) });
  return { dir, ledger };
}

// One directory is one repo whatever its spelling: symlinks resolved, and the letter case the
// volume stores (plain realpathSync keeps the case it was given on macOS).
const realDir = realpathSync.native;

// The real path of a directory named as a further repo; a relative one is read from the main
// root, as --files paths are.
function repoDir(ctx, given) {
  const abs = path.resolve(ctx.root, given);
  if (!existsSync(abs)) throw new UsageError(`repo ${given}: no such directory (${abs})`);
  if (!statSync(abs).isDirectory()) throw new UsageError(`repo ${given}: not a directory`);
  return realDir(abs);
}

const within = (outer, inner) => inner.startsWith(`${outer}${path.sep}`);

// A further repo is a git work tree root of its own, apart from the main root and from every
// repo the run already declared. gateHash is its config as declared, for R13.
function declarable(ctx, given, declared) {
  const dir = repoDir(ctx, given);
  const main = realDir(ctx.root);
  if (dir === main || within(main, dir)) throw new UsageError(`repo ${given}: it is inside this repo, whose files are part of the run already`);
  if (within(dir, main)) throw new UsageError(`repo ${given}: it contains this repo`);
  const top = gitTop(dir);
  if (!top || realDir(top) !== dir) throw new UsageError(`repo ${given}: not the root of a git work tree${top ? ` (that is ${top})` : ""}`);
  for (const r of declared) {
    if (r.root === dir) throw new UsageError(`repo ${given}: already declared as ${r.prefix}`);
    if (within(r.root, dir) || within(dir, r.root)) throw new UsageError(`repo ${given}: it ${within(r.root, dir) ? "is inside" : "contains"} the declared repo ${r.prefix}`);
  }
  let gateHash;
  try {
    gateHash = repoConfig(dir).hash;
  } catch (error) {
    throw new UsageError(`repo ${given}: ${error.message}`);
  }
  return { prefix: path.relative(main, dir).split(path.sep).join("/"), root: dir, gateHash };
}

// A repo declared on a run already open is measured from its HEAD: the run may have edited
// there while its edit events were still dropped, so every uncommitted change counts as the run's.
function declareLate(ctx, dir, ledger, declared) {
  const repo = { ...declared, fromHead: true };
  const repos = [...(ledger.repos ?? []), repo];
  const config = loadConfig(ctx.root, repos);
  const session = loadSession(ctx.stateDir, ctx.session);
  const now = snapshot(ctx.root, session?.lastTree ?? ledger.baseline, repos);
  // a source change not stamped yet keeps its own stamp: the hash moves only from a settled state
  const settled = implementationHash(withoutRepos(now, [repo]), config) === ledger.lastSourceHash;
  let baseline;
  try {
    baseline = withRepoAtHead(ledger.baseline, repo, now);
  } catch (error) {
    throw new UsageError(`repo ${repo.prefix}: git could not compare it with its HEAD, so it is not declared (${String(error.message).split("\n")[0]})`);
  }
  ledger.repos = repos;
  ledger.baseline = baseline;
  ledger.baseline.heads = { ...ledger.baseline.heads, [repo.prefix]: gitHead(repo.root) };
  if (settled) {
    ledger.lastSourceHash = implementationHash(now, config);
    const key = `${repo.prefix}/`;
    // what the repo already holds dates from now: a review or verify from before never saw it
    if (diffSnapshots(ledger.baseline, now).changed.some((p) => p.startsWith(key) && config.isSource(p) && !config.isTest(p))) ledger.lastSourceChangeSeq = nextSeq();
  }
  saveLedger(dir, ledger);
  if (session) saveSession(ctx.stateDir, { ...session, lastTree: { files: now.files, hash: now.hash } });
  return repo;
}

export function openLedger(ctx, slug, playbook, repoPaths = []) {
  const existing = findRun(ctx.stateDir, slug);
  if (existing) {
    // attaching again with the same command is not an error: a repo the run has is left as it
    // is. Every path is checked before the session attaches, so a refusal changes nothing.
    const declared = existing.ledger.repos ?? [];
    const has = (given) => declared.some((r) => r.root === repoDir(ctx, given));
    const fresh = [];
    for (const given of repoPaths) if (!has(given)) fresh.push(declarable(ctx, given, [...declared, ...fresh]));
    const found = attachLedger(ctx, slug);
    for (const repo of fresh) declareLate(ctx, found.dir, found.ledger, repo);
    return found;
  }
  if (!playbook) throw new UsageError(`gate open ${slug}: name a playbook (have: ${PLAYBOOKS.join(", ")})`);
  if (!PLAYBOOKS.includes(playbook)) throw new UsageError(`unknown playbook "${playbook}" (have: ${PLAYBOOKS.join(", ")})`);
  const repos = [];
  for (const given of repoPaths) repos.push(declarable(ctx, given, repos));
  const session = ensureSession(ctx.stateDir, ctx.root, ctx.session);
  const config = loadConfig(ctx.root, repos);
  const policy = loadPolicy();
  // the folder gets today's date; a slug that already starts with one would carry two
  const undated = slugify(String(slug).replace(/^\d{4}-\d{2}-\d{2}-(?=[a-z0-9])/i, ""));
  // a closed or abandoned run with the same slug on the same day keeps its folder; the new
  // run takes the next free name
  const base = `${new Date().toISOString().slice(0, 10)}-${undated}`;
  let name = base;
  for (let i = 2; existsSync(path.join(runsDir(ctx.stateDir), name)); i++) name = `${base}-${i}`;
  const dir = path.join(runsDir(ctx.stateDir), name);
  mkdirSync(dir, { recursive: true });
  const head = gitHead(ctx.root);
  const heads = Object.fromEntries(repos.map((r) => [r.prefix, gitHead(r.root)]));
  const dirty = [...gitNumstat(ctx.root).keys(), ...repos.flatMap((r) => [...gitNumstat(r.root).keys()].map((rel) => `${r.prefix}/${rel}`))];
  // a repo declared here starts as it is now: what it held before the run is not the run's
  const start = withRepos(taskBaseline(ctx.root, session.baseline, dirty), repos);
  const ledger = {
    slug: undated,
    playbook,
    version: ctx.version ?? null,
    status: "open",
    openedAt: new Date().toISOString(),
    openedSeq: nextSeq(),
    // the lead and its helpers search code and memory first (gate note context, R17)
    lookups: true,
    // which rules this run opened under: what a later release tightens reaches new runs only (newRules)
    rules: 1,
    closedAt: null,
    sessions: [ctx.session],
    ...(repos.length ? { repos } : {}),
    gateHash: config.hash,
    // the lead's searches for this task count from the first prompt after this point (rules.mjs)
    lookupsFrom: Math.max(session.baselineSeq ?? 0, session.runEndSeq ?? 0),
    // what gate.json had verify run at open, so the report can tell a command this run brought in
    verifyAtOpen: config.verify.map((v) => v.cmd),
    policyHash: policy.hash,
    // pinned: a plugin upgrade mid-task changes nothing for this ledger
    policy,
    // the freshness clock starts here, so the first real edit gets a real timestamp
    lastSourceHash: implementationHash(start, config),
    lastSourceChangeSeq: 0,
    // files already dirty vs HEAD now cannot be measured by git against HEAD later: the ones
    // in based are diffed against their copy from open, the rest get a line-count estimate
    baseline: { hash: start.hash, files: start.files, seq: session.baselineSeq, head, ...(repos.length ? { heads } : {}), dirty, based: copyBases(ctx.root, dir, start, dirty, config, repos, head, heads) },
    tier: ["feature", "bugfix", "refactor"].includes(playbook) ? emptyTier() : null,
    planSeq: null,
    taskSeq: null,
    cases: [],
    steps: playbookSteps(playbook),
    huddles: [],
    waivers: [],
    pauses: [],
  };
  // what the session took out of its changes before this run opened is reported with the run
  const carried = readEvents(ctx.stateDir, ctx.session).filter((e) => e.seq > (session.baselineSeq ?? 0));
  const byHand = carried.filter((e) => e.kind === "rebaseline").map((e) => ({ at: e.ts, seq: e.seq, reason: e.reason, paths: e.paths }));
  const byGit = carried.filter((e) => e.kind === "baseline-moved").flatMap((e) => e.paths ?? []);
  if (byHand.length) ledger.rebaselines = byHand;
  if (byGit.length) ledger.foreign = [...new Set(byGit)].sort();
  saveLedger(dir, ledger);
  writeFileSync(
    path.join(dir, "ledger.md"),
    template().replace("{{slug}}", ledger.slug).replace("{{playbook}}", playbook).replace("{{opened}}", ledger.openedAt),
  );
  ensureGitignore(ctx.root);
  // the hook's snapshot reuses hashes from lastTree: without the repos' entries there it would
  // read every file of a declared repo on each tool call until the first gate verb
  updateSession(ctx.stateDir, ctx.session, { current: name, ...(repos.length ? { lastTree: { files: start.files, hash: start.hash } } : {}) });
  return { dir, ledger };
}

// Another session's run, opened and last touched two days ago or more: nothing else prompts anyone
// to close it, and it no longer holds up the repo's setup.
const STALE_MS = 2 * 24 * 3600 * 1000;
export function staleForeign({ dir, ledger }, session, now = Date.now()) {
  if (ledger.sessions?.includes(session) || now - Date.parse(ledger.openedAt) < STALE_MS) return false;
  return now - statSync(path.join(dir, "ledger.json")).mtimeMs >= STALE_MS;
}

// Every run whose ledger is not closed or abandoned, newest first.
export function openRuns(stateDir) {
  const dir = runsDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((d) => path.join(dir, d))
    .filter((d) => existsSync(path.join(d, "ledger.json")))
    .sort()
    .reverse()
    .map((d) => ({ dir: d, ledger: loadLedger(d) }))
    .filter(({ ledger }) => !isDone(ledger));
}

export function currentLedger(stateDir, session) {
  const state = loadSession(stateDir, session);
  if (!state?.current) return null;
  const dir = path.join(runsDir(stateDir), state.current);
  if (!existsSync(path.join(dir, "ledger.json"))) return null;
  return { dir, ledger: loadLedger(dir) };
}

const SELF_CLOSING = ["skeptic", "tests", "implement", "driver", "review"];

function printStepLines(ctx, steps, { short = false } = {}) {
  for (const s of steps) ctx.out(`${String(s.n).padStart(2)}. [${s.state ?? "    "}] ${short ? firstClause(s.text) : s.text}${s.key ? `  {${s.key}}` : ""}`);
}

// A step's opening words for `gate open`; `gate next` prints the whole step when it is due.
function firstClause(text) {
  const head = String(text).split(/[:;(]|\.\s/)[0].trim();
  return head.length > 60 ? `${head.slice(0, 59).replace(/\s+\S*$/, "")}…` : head;
}

// A newer done-gate beside this one in the plugin cache: the session still runs the old copy
// until it restarts. A dev checkout has no version folders beside it and prints nothing.
function newerInstalled(version) {
  const semver = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const mine = semver(String(version ?? ""));
  if (!mine || path.basename(pluginRoot) !== version) return null;
  let names = [];
  try {
    names = readdirSync(path.dirname(pluginRoot));
  } catch {
    return null;
  }
  const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return names.map(semver).filter((v) => v && newer(v, mine) > 0).sort(newer).pop()?.join(".") ?? null;
}

function printRepo(ctx, repo) {
  ctx.out(`repo: ${repo.prefix} (${repo.root}) · ${repo.fromHead ? "measured from its HEAD: every uncommitted change and untracked file there counts as this run's" : "measured from when the run opened"}`);
}

// `open` and `attach` show only the keyed steps (the ones with script or agent evidence);
// `gate steps` shows all of them.
function printOpen(ctx, dir, ledger, story = []) {
  ctx.out(`ledger: ${dir}`);
  for (const repo of ledger.repos ?? []) printRepo(ctx, repo);
  const config = loadConfig(ctx.root, ledger.repos);
  const cmds = config.verify.map((v) => v.cmd);
  ctx.out(`verify: ${cmds.length ? `${cmds.join(" · ")} (${config.verifySource})` : "none — add verify commands to .claude/gate.json"}`);
  // vitest does not type-check and a framework build skips tests/, so type errors pile up under green runs
  if (existsSync(path.join(ctx.root, "tsconfig.json")) && !cmds.some((c) => /\b(?:tsc|typecheck|type-check|vue-tsc|svelte-check)\b/.test(c))) {
    ctx.out("verify runs no type check, and this repo has tsconfig.json: add a typecheck script to package.json or `npx tsc --noEmit` to verify in .claude/gate.json");
  }
  for (const repo of config.repos ?? []) {
    const own = repo.config.verify.map((v) => v.cmd);
    ctx.out(`verify in ${repo.prefix}: ${own.length ? `${own.join(" · ")} (its ${repo.config.verifySource})` : "none"}`);
  }
  if (ledger.verifyAdded?.length) ctx.out(`verify added by this run: ${ledger.verifyAdded.join(" · ")}`);
  const newer = newerInstalled(ctx.version);
  if (newer) ctx.out(`done-gate ${newer} is installed, but this session runs ${ctx.version}: restart Claude Code to use it`);
  // the steps the gate closes from what it records are left out; `gate steps` lists every one
  const own = newRules(ledger) ? ledger.steps.filter((s) => SELF_CLOSING.includes(s.key)).map((s) => s.key) : [];
  printStepLines(ctx, ledger.steps.filter((s) => s.key && !own.includes(s.key)), { short: true });
  if (own.length) ctx.out(`the gate closes ${own.slice(0, -1).join(", ")}${own.length > 1 ? " and " : ""}${own.at(-1)} itself from what it records (\`gate steps\` lists them)`);
  for (const line of story) ctx.out(line);
  printNext(ctx);
}

// A verb from the model's shell has no CLAUDE_PROJECT_DIR and roots itself at its cwd, while the
// hooks file the session's events under the repo it started in. A run opened in a sibling (or in a
// repo inside that one) would never see them: the repo that has them, or null.
// Only the UserPromptSubmit hook writes a prompt record. A shell verb run in a folder (a
// rebaseline, a verify) can leave a log with none, and that is not where the hooks file events.
// Read in chunks up to the first one: a home log of megabytes costs one chunk.
function holdsPrompt(file) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let tail = "";
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      const text = tail + buf.toString("utf8", 0, n);
      if (text.includes('"kind":"prompt"')) return true;
      tail = text.slice(-16);
    }
    return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

function eventsElsewhere(ctx) {
  if (process.env.CLAUDE_PROJECT_DIR || !ctx.session) return null;
  const has = (dir) => holdsPrompt(path.join(dir, ".claude", "gate", "sessions", String(ctx.session), "events.jsonl"));
  if (has(ctx.root)) return null;
  const parent = path.dirname(ctx.root);
  let siblings = [];
  try {
    siblings = readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(parent, d.name));
  } catch {
    // an unreadable parent leaves the ancestors to check
  }
  const ancestors = [];
  for (let dir = parent; dir !== path.dirname(dir); dir = path.dirname(dir)) ancestors.push(dir);
  return [...siblings, ...ancestors].find((dir) => dir !== ctx.root && has(dir)) ?? null;
}

const shellLine = (words) => words.map(shellWord).join(" ");
const realOf = (dir) => {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

// `words` is the verb and its arguments as the command from the other folder must repeat them; a
// declared repo that is either folder itself would be refused there, so it is left out
export function refuseElsewhere(ctx, words, repos = []) {
  const home = eventsElsewhere(ctx);
  if (!home) return;
  const others = repos.filter((r) => ![home, ctx.root].some((d) => realOf(d) === realOf(r)));
  throw new UsageError(`this session's hook events are filed under ${home}, the repo it started in, so a run in ${ctx.root} would never see its searches, runs or your messages. Run it from there and declare this repo: \`cd ${shellWord(home)} && gate ${shellLine([...words, ...[...others, ctx.root].flatMap((r) => ["--repo", r])])}\``);
}

// A session shown the setup notice at its start cannot open a run until the repo is set up or
// set aside: the notice alone went unread in busy sessions, and gate.json cannot change once a
// run is open. The user's own words for "later" hold for the rest of the session.
function refuseSetup(ctx, words, later) {
  const session = loadSession(ctx.stateDir, ctx.session);
  if (!session?.setupNoticed || session.setupLater || !needsSetup(ctx.root)) return;
  if (later && saidSince(readEvents(ctx.stateDir, ctx.session), session.baselineSeq ?? 0, later)) {
    updateSession(ctx.stateDir, ctx.session, { setupLater: later.trim() });
    return;
  }
  const again = `gate ${shellLine(words)}`;
  throw new UsageError(`this repo is not set up for the faster test loop, and gate.json cannot change once a run is open. Run \`gate setup\` now, check its proposal and show it to the user: on their yes \`gate setup --apply [edited.json] --user-ok "<their words>"\`, on a no \`gate setup --decline --user-ok "<their words>"\`. If they want to decide later: \`${again} --setup-later "<their words, at least three>"\`${later ? ` (the user did not say "${later}" in this session)` : ""}.`);
}

// A helper out on this session's run writes into that run's folder: moving the session to
// another run leaves its file outside the run it was briefed for.
function refuseWhileHelpersOut(ctx, slug) {
  const current = currentLedger(ctx.stateDir, ctx.session);
  if (!current || isDone(current.ledger) || findRun(ctx.stateDir, slug)?.dir === current.dir) return;
  const out = helpersOut(readEvents(ctx.stateDir, ctx.session), ctx.session, current.ledger.openedSeq ?? 0);
  if (!out.length) return;
  const one = out.length === 1;
  throw new UsageError(`${out.map((e) => `${e.agentType} (${e.agent})`).join(", ")} ${one ? "is" : "are"} still out on run ${current.ledger.slug}: wait for ${one ? "its" : "their"} hand-back, or, if the user says to give that run up, \`gate abandon ${current.ledger.slug} "<why>" --user-ok "<their words>"\`. Moving to another run now leaves ${one ? "its file" : "their files"} outside the run ${one ? "it was" : "they were"} briefed for.`);
}

export const verbs = {
  open(ctx) {
    const rest = [];
    const repos = [];
    let oldOk = "";
    let setupLater = "";
    let batch = "";
    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      const named = arg.startsWith("--repo=") ? arg.slice(7) : arg === "--repo" ? ctx.args[++i] : null;
      if (named) repos.push(named);
      else if (arg === "--repo" || arg.startsWith("--repo=")) throw new UsageError("--repo needs a path: gate open <slug> <playbook> --repo ../other");
      else if (arg === "--setup-later") {
        setupLater = ctx.args[++i] ?? "";
        if (!setupLater.trim() || setupLater.startsWith("--")) throw new UsageError('--setup-later needs the user\'s words: gate open <slug> <playbook> --setup-later "<their words>"');
      } else if (arg === "--batch") {
        batch = ctx.args[++i] ?? "";
        if (!batch.trim() || batch.startsWith("--")) throw new UsageError("--batch needs a batch name: gate open <slug> <playbook> --batch <name>");
      } else if (arg === "--old-version-ok") {
        oldOk = ctx.args[++i] ?? "";
        if (!oldOk.trim() || oldOk.startsWith("--")) throw new UsageError('--old-version-ok needs the user\'s words: gate open <slug> <playbook> --old-version-ok "<their words>"');
      }
      // an ignored flag would open the run without what it asked for
      else if (arg.startsWith("--")) throw new UsageError(`gate open: unknown option ${arg} (have: --repo <path>, --batch <name>, --old-version-ok "<the user's words>", --setup-later "<the user's words>")`);
      else rest.push(arg);
    }
    const [slug, playbook] = rest;
    if (!slug) throw new UsageError("usage: gate open <slug> <feature|bugfix|refactor|plan|investigation> [--repo <path>]");
    // a newer release is the user's call: update, or say (once a session) to carry on with this
    // one; joining a run that is already open is not a new task
    // each refusal prints the command that works, with every other flag this one was given
    const said = (key, words) => (words ? [key, words] : []);
    const named = repos.flatMap((r) => ["--repo", r]);
    // a run opened elsewhere sees none of this session's events, its words for an old version included
    refuseElsewhere(ctx, ["open", slug, ...(playbook ? [playbook] : []), ...said("--old-version-ok", oldOk), ...said("--setup-later", setupLater), ...said("--batch", batch)], repos.map((r) => path.resolve(ctx.root, r)));
    refuseWhileHelpersOut(ctx, slug);
    const latest = knownNewer(ctx.version);
    const joining = openRuns(ctx.stateDir).some(({ ledger }) => ledger.slug === slug);
    if (latest && !joining && !saidSince(readEvents(ctx.stateDir, ctx.session), 0, oldOk)) {
      throw new UsageError(`done-gate ${latest} is out and this session runs ${ctx.version}: tell the user and ask. To update: ${UPDATE_COMMANDS}. To carry on with ${ctx.version}: \`gate open ${shellWord(slug)} ${playbook ? shellWord(playbook) : "<playbook>"}${named.length || setupLater || batch ? ` ${shellLine([...named, ...said("--setup-later", setupLater), ...said("--batch", batch)])}` : ""} --old-version-ok "<their words, at least three>"\``);
    }
    if (!joining) refuseSetup(ctx, ["open", slug, ...(playbook ? [playbook] : []), ...named, ...said("--old-version-ok", oldOk), ...said("--batch", batch)], setupLater);
    if (batch && joining) {
      const held = openRuns(ctx.stateDir).find(({ ledger }) => ledger.slug === slug).ledger.batch;
      if (held !== batch) throw new UsageError(`run ${slug} is already open${held ? ` in batch ${held}` : ""}: --batch applies only when a run opens`);
    } else if (batch) requireLiveBatch(ctx.stateDir, batch);
    const { dir, ledger } = openLedger(ctx, slug, playbook, repos);
    if (batch && !joining) carryStanding(ctx, dir, ledger, batch);
    printOpen(ctx, dir, ledger);
  },
  repo(ctx) {
    const [action, given] = ctx.args;
    if (action !== "add" || !given) throw new UsageError("usage: gate repo add <path>");
    const current = currentLedger(ctx.stateDir, ctx.session);
    if (!current || isDone(current.ledger)) throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
    printRepo(ctx, declareLate(ctx, current.dir, current.ledger, declarable(ctx, given, current.ledger.repos ?? [])));
  },
  attach(ctx) {
    const [slug] = ctx.args;
    if (!slug) throw new UsageError("usage: gate attach <slug>");
    refuseElsewhere(ctx, ["open", slug]);
    refuseWhileHelpersOut(ctx, slug);
    // read before joining, so this session never counts as the run's last activity
    const found = findRun(ctx.stateDir, slug);
    let story = [];
    try {
      story = found ? leftBehind(ctx, found).story : [];
    } catch {
      // the story is read from the run's logs; one that cannot be read does not stop the attach
    }
    const { dir, ledger } = attachLedger(ctx, slug);
    printOpen(ctx, dir, ledger, story);
  },
  steps(ctx) {
    const current = currentLedger(ctx.stateDir, ctx.session);
    if (!current || isDone(current.ledger)) throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
    ctx.out(`ledger: ${current.dir}`);
    ctx.out(`playbook: ${current.ledger.playbook} (${current.ledger.status})`);
    printStepLines(ctx, current.ledger.steps);
  },
};
