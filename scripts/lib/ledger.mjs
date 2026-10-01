import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, repoConfig } from "./config.mjs";
import { nextSeq } from "./events.mjs";
import { repoPath } from "./paths.mjs";
import { ensureSession, loadSession, saveSession, updateSession } from "./session-state.mjs";
import { baseCopyPath, diffSnapshots, gitHead, gitNumstat, gitTop, gitTracked, snapshot, taskBaseline, withRepoAtHead, withRepos, withoutRepos } from "./tree.mjs";
import { emptyTier } from "./size.mjs";
// size.mjs imports assess.mjs, which imports this module: loadPolicy is only ever called at
// verb time, never at module top level, or the cycle would hit a TDZ error.
import { loadPolicy } from "./size.mjs";
import { implementationHash } from "./rules.mjs";
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
  if (!PLAYBOOKS.includes(playbook)) throw new UsageError(`unknown playbook "${playbook}" (have: ${PLAYBOOKS.join(", ")})`);
  const repos = [];
  for (const given of repoPaths) repos.push(declarable(ctx, given, repos));
  const session = ensureSession(ctx.stateDir, ctx.root, ctx.session);
  const config = loadConfig(ctx.root, repos);
  const policy = loadPolicy();
  // a closed or abandoned run with the same slug on the same day keeps its folder; the new
  // run takes the next free name
  const base = `${new Date().toISOString().slice(0, 10)}-${slugify(slug)}`;
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
    slug: slugify(slug),
    playbook,
    version: ctx.version ?? null,
    status: "open",
    openedAt: new Date().toISOString(),
    openedSeq: nextSeq(),
    closedAt: null,
    sessions: [ctx.session],
    ...(repos.length ? { repos } : {}),
    gateHash: config.hash,
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

function printStepLines(ctx, steps) {
  for (const s of steps) ctx.out(`${String(s.n).padStart(2)}. [${s.state ?? "    "}] ${s.text}${s.key ? `  {${s.key}}` : ""}`);
}

function printRepo(ctx, repo) {
  ctx.out(`repo: ${repo.prefix} (${repo.root}) · ${repo.fromHead ? "measured from its HEAD: every uncommitted change and untracked file there counts as this run's" : "measured from when the run opened"}`);
}

// `open` and `attach` show only the keyed steps (the ones with script or agent evidence);
// `gate steps` shows all of them.
function printOpen(ctx, dir, ledger) {
  ctx.out(`ledger: ${dir}`);
  for (const repo of ledger.repos ?? []) printRepo(ctx, repo);
  const config = loadConfig(ctx.root, ledger.repos);
  const cmds = config.verify.map((v) => v.cmd);
  ctx.out(`verify: ${cmds.length ? `${cmds.join(" · ")} (${config.verifySource})` : "none — add verify commands to .claude/gate.json"}`);
  for (const repo of config.repos ?? []) {
    const own = repo.config.verify.map((v) => v.cmd);
    ctx.out(`verify in ${repo.prefix}: ${own.length ? `${own.join(" · ")} (its ${repo.config.verifySource})` : "none"}`);
  }
  if (ledger.verifyAdded?.length) ctx.out(`verify added by this run: ${ledger.verifyAdded.join(" · ")}`);
  printStepLines(ctx, ledger.steps.filter((s) => s.key));
  printNext(ctx);
}

export const verbs = {
  open(ctx) {
    const rest = [];
    const repos = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      const named = arg.startsWith("--repo=") ? arg.slice(7) : arg === "--repo" ? ctx.args[++i] : null;
      if (named) repos.push(named);
      else if (arg === "--repo" || arg.startsWith("--repo=")) throw new UsageError("--repo needs a path: gate open <slug> <playbook> --repo ../other");
      // an ignored flag would open the run without what it asked for
      else if (arg.startsWith("--")) throw new UsageError(`gate open: unknown option ${arg} (have: --repo <path>)`);
      else rest.push(arg);
    }
    const [slug, playbook] = rest;
    if (!slug) throw new UsageError("usage: gate open <slug> <feature|bugfix|refactor|plan|investigation> [--repo <path>]");
    const { dir, ledger } = openLedger(ctx, slug, playbook ?? "feature", repos);
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
    const { dir, ledger } = attachLedger(ctx, slug);
    printOpen(ctx, dir, ledger);
  },
  steps(ctx) {
    const current = currentLedger(ctx.stateDir, ctx.session);
    if (!current || isDone(current.ledger)) throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
    ctx.out(`ledger: ${current.dir}`);
    ctx.out(`playbook: ${current.ledger.playbook} (${current.ledger.status})`);
    printStepLines(ctx, current.ledger.steps);
  },
};
