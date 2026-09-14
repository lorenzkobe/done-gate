import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { nextSeq } from "./events.mjs";
import { ensureSession, loadSession, updateSession } from "./session-state.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLAYBOOKS = ["feature", "bugfix", "refactor", "plan", "investigation"];

export function runsDir(stateDir) {
  return path.join(stateDir, "runs");
}

export function loadLedger(dir) {
  return JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8").replace(/\r/g, ""));
}

export function saveLedger(dir, ledger) {
  ledger.seq = nextSeq();
  ledger.updatedAt = new Date().toISOString();
  writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(ledger, null, 2));
  return ledger;
}

// Playbook steps: numbered lines, optional trailing {key} naming the evidence kind.
export function playbookSteps(playbook) {
  const file = path.join(pluginRoot, "skills", "gate", "playbooks", `${playbook}.md`);
  if (!existsSync(file)) throw new Error(`unknown playbook "${playbook}" (have: ${PLAYBOOKS.join(", ")})`);
  const steps = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
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
    if (ledger.status !== "closed") return { dir: d, ledger };
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

function template() {
  return readFileSync(path.join(pluginRoot, "skills", "gate", "templates", "ledger.md"), "utf8");
}

export function attachLedger(ctx, slug) {
  const found = findRun(ctx.stateDir, slug);
  if (!found) throw new Error(`no run for slug "${slug}" — use \`gate open ${slug} <playbook>\``);
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
  if (!PLAYBOOKS.includes(playbook)) throw new Error(`unknown playbook "${playbook}" (have: ${PLAYBOOKS.join(", ")})`);
  const session = ensureSession(ctx.stateDir, ctx.root, ctx.session);
  const config = loadConfig(ctx.root);
  const name = `${new Date().toISOString().slice(0, 10)}-${slugify(slug)}`;
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
    baseline: { hash: session.baseline.hash, files: session.baseline.files, seq: session.baselineSeq },
    planSeq: null,
    taskSeq: null,
    cases: [],
    blast: [],
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

export function currentLedger(stateDir, session) {
  const state = loadSession(stateDir, session);
  if (!state?.current) return null;
  const dir = path.join(runsDir(stateDir), state.current);
  if (!existsSync(path.join(dir, "ledger.json"))) return null;
  return { dir, ledger: loadLedger(dir) };
}

function printSteps(ctx, dir, ledger) {
  ctx.out(`ledger: ${dir}`);
  ctx.out(`playbook: ${ledger.playbook} (${ledger.status})`);
  for (const s of ledger.steps) ctx.out(`${String(s.n).padStart(2)}. [${s.state ?? "    "}] ${s.text}${s.key ? `  {${s.key}}` : ""}`);
}

export const verbs = {
  open(ctx) {
    const [slug, playbook] = ctx.args;
    if (!slug) throw new Error("usage: gate open <slug> <feature|bugfix|refactor|plan>");
    const { dir, ledger } = openLedger(ctx, slug, playbook ?? "feature");
    printSteps(ctx, dir, ledger);
  },
  attach(ctx) {
    const [slug] = ctx.args;
    if (!slug) throw new Error("usage: gate attach <slug>");
    const { dir, ledger } = attachLedger(ctx, slug);
    printSteps(ctx, dir, ledger);
  },
};
