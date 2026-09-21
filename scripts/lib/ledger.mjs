import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { nextSeq } from "./events.mjs";
import { ensureSession, loadSession, updateSession } from "./session-state.mjs";
import { gitHead, gitNumstat } from "./tree.mjs";
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

const TEMPLATE = `# {{slug}} — {{playbook}} (opened {{opened}})

## Task

<!-- The user's ask, quoted. Then one paragraph in your own words. -->

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
  if (!ledger.sessions.includes(ctx.session)) {
    ledger.sessions.push(ctx.session);
    saveLedger(dir, ledger);
  }
  ensureSession(ctx.stateDir, ctx.root, ctx.session);
  updateSession(ctx.stateDir, ctx.session, { current: path.basename(dir) });
  return { dir, ledger };
}

export function openLedger(ctx, slug, playbook) {
  const existing = findRun(ctx.stateDir, slug);
  if (existing) return attachLedger(ctx, slug);
  if (!PLAYBOOKS.includes(playbook)) throw new UsageError(`unknown playbook "${playbook}" (have: ${PLAYBOOKS.join(", ")})`);
  const session = ensureSession(ctx.stateDir, ctx.root, ctx.session);
  const config = loadConfig(ctx.root);
  // a closed or abandoned run with the same slug on the same day keeps its folder; the new
  // run takes the next free name
  const base = `${new Date().toISOString().slice(0, 10)}-${slugify(slug)}`;
  let name = base;
  for (let i = 2; existsSync(path.join(runsDir(ctx.stateDir), name)); i++) name = `${base}-${i}`;
  const dir = path.join(runsDir(ctx.stateDir), name);
  mkdirSync(dir, { recursive: true });
  const ledger = {
    slug: slugify(slug),
    playbook,
    status: "open",
    openedAt: new Date().toISOString(),
    openedSeq: nextSeq(),
    closedAt: null,
    sessions: [ctx.session],
    gateHash: config.hash,
    policyHash: loadPolicy().hash,
    // the freshness clock starts here, so the first real edit gets a real timestamp
    lastSourceHash: implementationHash(session.baseline, config),
    lastSourceChangeSeq: 0,
    // files already dirty vs HEAD now cannot be measured by git later; they get a line-count estimate
    baseline: { hash: session.baseline.hash, files: session.baseline.files, seq: session.baselineSeq, head: gitHead(ctx.root), dirty: [...gitNumstat(ctx.root).keys()] },
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
  updateSession(ctx.stateDir, ctx.session, { current: name });
  return { dir, ledger };
}

// Every run whose ledger is still open or closing (not closed, not abandoned), newest first.
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

// `open` and `attach` show only the keyed steps (the ones with script or agent evidence);
// `gate steps` shows all of them.
function printOpen(ctx, dir, ledger) {
  ctx.out(`ledger: ${dir}`);
  printStepLines(ctx, ledger.steps.filter((s) => s.key));
  printNext(ctx);
}

export const verbs = {
  open(ctx) {
    const [slug, playbook] = ctx.args;
    if (!slug) throw new UsageError("usage: gate open <slug> <feature|bugfix|refactor|plan|investigation>");
    const { dir, ledger } = openLedger(ctx, slug, playbook ?? "feature");
    printOpen(ctx, dir, ledger);
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
