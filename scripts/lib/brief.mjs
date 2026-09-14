import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildState } from "./assess.mjs";
import { caseTable, section, verifyLines } from "./report.mjs";
import { renderTierBlock, tierOf } from "./size.mjs";
import { gitTracked } from "./tree.mjs";
import { ROLES, flag, positional } from "./verbs.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";

// A packet is everything a helper needs, generated from gate state and the working tree.
// The model authors none of it; the helper reads it instead of the ledger and the diff.

const DIFF_CAP = 1500;
const SAMPLE_LINES = 60;

export function detectFramework(root) {
  const pkgPath = path.join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const name of ["vitest", "jest", "mocha", "ava"]) if (name in deps) return name;
      if (/node\s+--test/.test(String(pkg.scripts?.test ?? ""))) return "node:test";
    } catch {
      // unreadable package.json: fall through
    }
  }
  if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "pytest.ini"))) return "pytest";
  return "unknown";
}

// Starting points for a reader, not a parser: named exports in JS/TS, defs and classes in Python.
export function exportedSymbols(abs) {
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, "utf8");
  const out = new Set();
  const js = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm;
  const braces = /^export\s*\{([^}]*)\}/gm;
  for (const m of text.matchAll(js)) out.add(m[1]);
  for (const m of text.matchAll(braces)) for (const part of m[1].split(",")) {
    const name = part.trim().split(/\s+as\s+/).pop();
    if (name) out.add(name);
  }
  if (/^export\s+default\b/m.test(text)) out.add("default");
  if (abs.endsWith(".py")) for (const m of text.matchAll(/^(?:def|class)\s+(\w+)/gm)) out.add(m[1]);
  return [...out];
}

function distance(a, b) {
  const pa = path.posix.dirname(a).split("/").filter((s) => s && s !== ".");
  const pb = path.posix.dirname(b).split("/").filter((s) => s && s !== ".");
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i += 1;
  return pa.length - i + (pb.length - i);
}

export function nearestTests(state, targets, max = 3) {
  const tests = Object.keys(state.now?.files ?? {}).filter((p) => state.config.isTest(p));
  if (!targets.length) return tests.sort().slice(0, max);
  const score = (t) => Math.min(...targets.map((x) => distance(x, t)));
  return tests.map((t) => [score(t), t]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, max).map(([, t]) => t);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

function isBinary(buf) {
  const probe = buf.subarray(0, 8000);
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return true;
  return false;
}

function syntheticAdd(root, rel) {
  const abs = path.join(root, rel);
  const buf = readFileSync(abs);
  if (isBinary(buf)) return `diff --git a/${rel} b/${rel}\nbinary file (${buf.length} bytes), contents not shown`;
  const lines = buf.toString("utf8").replace(/\r/g, "").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return [`diff --git a/${rel} b/${rel}`, "new file (no git history for this task)", `--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

// The reviewer's diff: every changed file (source, tests and docs alike; prompts and README
// changes are reviewable too), from git against the commit that was HEAD when the task
// opened, or a synthetic all-added block when git has no history for the file.
export function unifiedDiff(state, { cap = DIFF_CAP } = {}) {
  const { diff, baseline, root } = state;
  const files = diff.changed;
  const ref = baseline?.head ?? "HEAD";
  const dirty = new Set(baseline?.dirty ?? []);
  const tracked = gitTracked(root);
  const blocks = [];
  for (const rel of files) {
    if (diff.deleted.includes(rel)) {
      const n = baseline?.files?.[rel]?.l;
      blocks.push(`deleted: ${rel} (${typeof n === "number" ? plural(n, "line") : "? lines"})`);
      continue;
    }
    let text = "";
    if (tracked.has(rel)) {
      try {
        text = git(root, ["diff", ref, "--", rel]).trim();
      } catch {
        text = "";
      }
    }
    if (!text) text = syntheticAdd(root, rel);
    if (dirty.has(rel)) text = `${text.split("\n")[0]}\n(unreliable for this task: the file was already modified when the task opened, so this diff mixes earlier changes with this task's and may hide a change that cancelled one out)\n${text.split("\n").slice(1).join("\n")}`;
    blocks.push(text);
  }
  const all = blocks.join("\n\n").split("\n");
  if (all.length <= cap) return all.join("\n") || "_no source changes since the task opened_";
  return `${all.slice(0, cap).join("\n")}\n[truncated: ${all.length - cap} more lines, see git diff]`;
}

const fence = (text) => ["```", ...String(text).replace(/\r/g, "").split("\n").map((l) => `    ${l}`), "```"];

function planFiles(ledger) {
  return tierOf(ledger).predictedFiles ?? [];
}

function header(state, role, round) {
  const { ledger } = state;
  const md = existsSync(path.join(state.dir, "ledger.md")) ? readFileSync(path.join(state.dir, "ledger.md"), "utf8") : "";
  const out = [`# Brief: ${role} round ${round} — ${ledger.slug}`, ""];
  out.push("## Task", "", section(md, "Task") || "_not written_", "");
  out.push("## Plan", "", section(md, "Plan") || "_not written_", "");
  out.push("## Cases", "");
  if (ledger.playbook === "bugfix") {
    const reported = ledger.cases.find((c) => c.kind === "reported-surface");
    if (reported) out.push(`Start with ${reported.id}: ${reported.case}`, "");
  }
  out.push(...caseTable(ledger), "");
  out.push("## Tier", "", ...renderTierBlock(ledger, state.policy, state.tier?.measured ?? null), "");
  out.push("## Tests", "", `globs: ${state.config.tests.join(", ")}`, `framework: ${detectFramework(state.root)}`, "");
  return out;
}

function mayWrite(state, role, reviewN, skepticN) {
  if (role === "skeptic") return `only ${path.join(state.dir, `skeptic-${skepticN}.md`)}; reply with its Act-on list only.`;
  if (role === "qa") return `only files under the tests globs (${state.config.tests.join(", ")}); nothing else.`;
  return `only ${path.join(state.dir, `review-${reviewN}.md`)}.`;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// The skeptic reads the files as they are now (it runs before code exists). QA must not learn
// anything from the implementation, so its rows describe the files as they were when the
// task opened and carry no symbol names, which a later re-run could otherwise leak.
function fileList(state, files, { blind = false } = {}) {
  if (!files.length) return ["no files named in the plan (the implementer ran `gate note plan` without --files)"];
  return files.map((rel) => {
    const abs = path.join(state.root, rel);
    if (blind) {
      const before = state.baseline?.files?.[rel]?.l;
      return typeof before === "number" ? `- ${rel} (${plural(before, "line")} when the task opened)` : `- ${rel} (new file for this task)`;
    }
    if (!existsSync(abs)) return `- ${rel} (new file, does not exist yet)`;
    const known = state.now?.files?.[rel]?.l;
    if (known === null || (known === undefined && isBinary(readFileSync(abs)))) return `- ${rel} (binary file)`;
    const lines = known ?? readFileSync(abs, "utf8").split("\n").length;
    const symbols = exportedSymbols(abs);
    return `- ${rel} (${plural(lines, "line")})${symbols.length ? ` exports: ${symbols.join(", ")}` : ""}`;
  });
}

export function renderPacket(state, role, { round, reviewN, skepticN = 1 }) {
  const out = header(state, role, round);
  out.push("## You may write", "", mayWrite(state, role, reviewN, skepticN), "");
  const files = planFiles(state.ledger);
  if (role === "skeptic") {
    out.push("## Files", "", ...fileList(state, files), "");
  } else if (role === "qa") {
    // never a line starting with +, - or @@: the QA renderer uses numbered lists and indented fences
    out.push("## Files the implementer will touch", "", ...fileList(state, files, { blind: true }).map((l, i) => l.startsWith("-") ? `${i + 1}. ${l.slice(2)}` : l), "");
    out.push("Do not read the implementer's edits to those files; read the code around them, the types and the sources of truth for every literal.", "");
    out.push("## Test conventions", "");
    const samples = nearestTests(state, files);
    if (!samples.length) out.push("no existing test files found under the tests globs", "");
    samples.forEach((t, i) => {
      const text = readFileSync(path.join(state.root, t), "utf8").split("\n").slice(0, SAMPLE_LINES).join("\n");
      out.push(`${i + 1}. ${t}`, "", ...fence(text), "");
    });
  } else {
    out.push("## Diff", "", unifiedDiff(state), "");
    out.push("## Verify", "", ...verifyLines(state.verify, { tails: false }), "");
    out.push("## Blast radius", "");
    if (state.ledger.blast.length) for (const b of state.ledger.blast) out.push(`- ${b.fact} — rung ${b.rung}${b.unproven ? " (unproven)" : ""} — ${b.proof}`);
    else out.push("_none recorded yet_");
    out.push("", "## Write your findings to", "", path.join(state.dir, `review-${reviewN}.md`), "");
    if (role === "reviewer-2") {
      const first = path.join(state.dir, "review-1.md");
      out.push("## Review 1", "", existsSync(first) ? readFileSync(first, "utf8").trim() : "_review-1.md not found_", "");
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

export const verbs = {
  brief(ctx) {
    const [role] = positional(ctx.args);
    if (!ROLES.includes(role)) throw new UsageError(`usage: gate brief <${ROLES.join("|")}> [--round n]`);
    const state = buildState(ctx, {});
    if (!state.ledger) throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
    const rounds = state.ledger.huddles.filter((h) => h.role === role).length;
    const round = Number(flag(ctx.args, "--round")) || rounds + 1;
    const numbers = (prefix) => state.reviews.filter((f) => f.startsWith(prefix)).map((f) => Number(/\d+/.exec(f)[0]));
    const next = (prefix) => (numbers(prefix).length ? Math.max(...numbers(prefix)) : 0) + 1;
    const reviewN = next("review-");
    const skepticN = next("skeptic-");
    const file = path.join(state.dir, `brief-${role}-${round}.md`);
    writeFileSync(file, renderPacket(state, role, { round, reviewN, skepticN }));
    ctx.out(`packet: ${file}`);
    ctx.out(`prompt: Read ${file} and follow your role brief.`);
    printNext(ctx);
  },
};
