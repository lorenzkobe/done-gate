import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildState } from "./assess.mjs";
import { caseTable, verifyLines } from "./report.mjs";
import { saveLedger, section } from "./ledger.mjs";
import { leadDelegates, pieceLines, renderTierBlock, tierMax, tierOf } from "./size.mjs";
import { gitTracked } from "./tree.mjs";
import { ROLES, flag, positional } from "./verbs.mjs";
import { toPosixRel } from "./paths.mjs";
import { REVIEW_CAP, isDraft, isRole, reviewScope, uncovered } from "./rules.mjs";
import { UsageError } from "./context.mjs";
import { printNext } from "./next.mjs";
import { nextSeq } from "./events.mjs";

// A packet is everything a helper needs, generated from gate state and the working tree.
// The model authors none of it; the helper reads it instead of the ledger and the diff.

const DIFF_CAP = 300;
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
export function unifiedDiff(state, { cap = DIFF_CAP, files = state.diff.changed } = {}) {
  const { diff, baseline, root } = state;
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
  out.push("## Context", "", section(md, "Context") || "_not written_", "");
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

function mayWrite(state, role, reviewN, skepticN, arbiterN = 1) {
  if (role === "skeptic") return `only ${path.join(state.dir, `skeptic-${skepticN}.md`)}; reply with its Act-on list only.`;
  if (role === "arbiter") return `only ${path.join(state.dir, `arbiter-${arbiterN}.md`)}; reply with the ruling line only.`;
  if (role === "qa") return `only files under the tests globs (${state.config.tests.join(", ")}); nothing else.`;
  if (role === "worker") return `the files named in this packet and files under the tests globs (${state.config.tests.join(", ")}); on a review round also ${path.join(state.dir, `worker-${reviewN}.md`)}.`;
  return `only ${path.join(state.dir, `${reviewPrefix(role)}-${reviewN}.md`)}.`;
}

// The reviewer writes review-<n>.md, the second reviewer review2-<n>.md: two streams, so
// two packets briefed before either file exists never name the same file.
export function reviewPrefix(role) {
  return role === "reviewer-2" ? "review2" : "review";
}

// The round number of a helper file: the digits before .md, never the 2 in review2-.
export function fileNumber(name) {
  return Number(/-(\d+)\.md$/.exec(name)?.[1] ?? 0);
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

// The one disagreement an arbiter settles: the finding, both sides' evidence, the cited code.
function arbiterBody(state, item) {
  const out = ["## The disagreement", ""];
  out.push(`Finding ${item.id}: ${item.text}`, "");
  out.push(`Implementer's dispute: ${item.dispute.why}`, `Implementer's evidence: ${item.dispute.evidence}`, "");
  out.push(`Reviewer upheld it: ${item.dispute.reviewerReason ?? "(no reason recorded)"}`, "");
  const cited = /([\w./-]+\.[a-z]+):(\d+)/i.exec(item.text);
  out.push("## The cited code", "");
  if (cited) {
    const rel = cited[1];
    const full = unifiedDiff(state, { cap: 100000 });
    const block = full.split("\n\n").find((b) => b.startsWith(`diff --git a/${rel} `));
    out.push(block ?? `no diff for ${rel} in this task; read the file at ${path.join(state.root, rel)}`, "");
  } else out.push("the finding cites no file:line; read the files in the diff below", "", unifiedDiff(state), "");
  out.push("## Rule", "", "Rule for exactly one side, in writing, from the evidence. If neither side's evidence holds, rule for the reviewer (the safe side) and say why.", "");
  out.push("## File shape", "", "```", `# Arbiter <n> — ${state.ledger.slug}`, "", "## Ruling", `- ${item.id} — implementer: <reason>   (or)   - ${item.id} — reviewer: <reason>`, "```", "");
  return out;
}

// The verify commands a helper may run itself; "when: source" entries are listed too.
function testCommands(state) {
  const cmds = (state.config.verify ?? []).map((v) => `- \`${v.cmd}\``);
  return cmds.length ? cmds : ["_no verify command in gate.json_"];
}

// The diff is inlined while it is short; past the cap the helper gets the file list with line
// counts and reads what it needs, instead of a packet it cannot hold.
function diffOrFiles(state, heading = "Diff", files = state.changed ?? []) {
  const diff = unifiedDiff(state, { cap: Infinity, files });
  const lines = diff.split("\n").length;
  if (lines <= DIFF_CAP) return [`## ${heading}`, "", diff, ""];
  const changed = files;
  const kind = (p) => (state.config.isTest(p) ? "test" : state.config.isSource(p) ? "source" : "other");
  return [
    `## Changed files (diff too long to inline: ${lines} lines)`,
    "",
    ...changed.map((p) => `- ${p} (${kind(p)}, ${state.now?.files?.[p]?.l ?? "?"} lines now)`),
    "",
    "Read the files you need with the Read tool; `git diff` in the repo shows the change.",
    "",
  ];
}

export function renderPacket(state, role, { round, reviewN, skepticN = 1, arbiterN = 1, item = null, piece = null }) {
  const out = header(state, role, round);
  out.push("## You may write", "", mayWrite(state, role, reviewN, skepticN, arbiterN), "");
  const files = planFiles(state.ledger);
  if (role === "arbiter") {
    out.push(...arbiterBody(state, item));
  } else if (role === "skeptic") {
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
  } else if (role === "worker") {
    out.push("## Files you own", "", ...fileList(state, files), "");
    const qaTests = (state.changed ?? []).filter((p) => state.config.isTest(p));
    out.push("## Tests QA wrote", "", ...(qaTests.length ? qaTests.map((t) => `- ${t}`) : ["_none yet_"]), "");
    out.push("## Test command", "", ...testCommands(state), "");
    const open = state.ledger.huddles.filter((h) => h.role === "reviewer" || h.role === "reviewer-2").flatMap((h) => h.actOn.filter((a) => !a.closed));
    if (open.length) {
      out.push(...diffOrFiles(state, "Diff so far"));
      out.push("## Open findings", "", ...open.map((a) => `- ${a.id} — ${a.text}`), "");
      out.push("## Write your replies to", "", path.join(state.dir, `worker-${reviewN}.md`), "");
    }
  } else {
    if (piece) {
      const scope = reviewScope(state);
      out.push("## Piece", "", `${piece.files.length} of ${scope.length} changed source file${scope.length === 1 ? "" : "s"}, ${plural(piece.lines, "line")}: ${piece.files.join(", ")}${piece.over ? ` (over the ${state.policy.reviewMaxLines}-line cap: one file cannot be split, so read it in passes and say in Noted where you stopped reading closely)` : ""}`, "");
    }
    // the piece's implementation files plus everything else that changed (tests, docs): those
    // travel with every piece
    const scopeSet = new Set(reviewScope(state));
    const shown = piece ? (state.changed ?? []).filter((p) => piece.files.includes(p) || !scopeSet.has(p)) : state.changed ?? [];
    out.push(...diffOrFiles(state, "Diff", shown));
    out.push("## Verify", "", ...verifyLines(state.verify, { tails: false }), "");
    out.push("## Test command", "", ...testCommands(state), "");
    out.push("", "## Write your findings to", "", path.join(state.dir, `${reviewPrefix(role)}-${reviewN}.md`), "");
    if (role === "reviewer-2") {
      // the newest finished review-<n>.md; a draft (the reviewer still running) says nothing yet
      const finished = state.reviews.filter((f) => /^review-\d+\.md$/.test(f)).map((f) => ({ n: fileNumber(f), text: readFileSync(path.join(state.dir, f), "utf8") })).filter((r) => !isDraft(r.text)).sort((a, b) => b.n - a.n)[0];
      out.push(finished ? `## Review ${finished.n}` : "## Review", "", finished ? finished.text.trim() : "_no finished review-<n>.md yet; the reviewer may still be running_", "");
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

export const verbs = {
  brief(ctx) {
    const [role] = positional(ctx.args);
    if (!ROLES.includes(role)) throw new UsageError(`usage: gate brief <${ROLES.join("|")}> [--round n] [--files a,b]`);
    const state = buildState(ctx, {});
    if (!state.ledger) throw new UsageError("no open ledger for this session — run `gate open <slug> <playbook>` first");
    const reviewing = role === "reviewer" || role === "reviewer-2";
    // a review round covers a piece: --files names it, or the whole change when that fits
    // the cap; past the cap the lead splits by file
    let piece = null;
    if (reviewing) {
      const scope = reviewScope(state);
      const named = flag(ctx.args, "--files");
      const files = named ? [...new Set(named.split(",").map((f) => toPosixRel(ctx.root, f.trim())).filter(Boolean))] : scope;
      const outside = files.filter((f) => !scope.includes(f));
      if (outside.length) throw new UsageError(`--files: ${outside.join(", ")} is not a changed implementation file of this task (have: ${scope.join(", ") || "none"})`);
      const rows = pieceLines(state.tier?.measured ?? null, state.now, files);
      const lines = rows.reduce((n, r) => n + r.lines, 0);
      const cap = state.policy.reviewMaxLines;
      // one file cannot be split by file: alone it is always a piece, and the packet says so
      if (lines > cap && files.length > 1) {
        const listed = rows.map((r) => `${r.path} (${r.lines} lines)`).join(", ");
        throw new UsageError(`${lines} source lines is more than one review round can read well (cap ${cap}). Review it in pieces: \`gate brief ${role} --files <some of: ${listed}>\`, each piece under ${cap} lines; a file counts as reviewed once a clean round saw it.`);
      }
      piece = { files, lines, over: lines > cap };
    }
    // below the delegated size the lead implements with its own context; a worker packet
    // would hand that context away for nothing
    // a predicted size below policy.delegatesAt: no worker, no blind QA (a plan that named no
    // files predicted nothing, and is not refused)
    if ((role === "worker" || role === "qa") && tierOf(state.ledger).predicted !== null && !leadDelegates(state.ledger, state.policy)) {
      const eff = tierMax(state.policy, tierOf(state.ledger).predicted, state.tier?.measured?.tier ?? null);
      const at = `size ${state.policy.delegatesAt} (a plan naming more than ${state.policy.tiers.standard?.maxFiles ?? 10} files)`;
      throw new UsageError(role === "worker"
        ? `size ${eff}: implement it yourself; the worker is for ${at}`
        : `size ${eff}: write the tests yourself from the case table, red first; blind QA is for ${at}`);
    }
    const rounds = state.ledger.huddles.filter((h) => h.role === role).length;
    const round = Number(flag(ctx.args, "--round")) || rounds + 1;
    // a round whose earlier file never appeared is not a round: the helper is resumed and
    // told to write, not briefed again
    const missing = state.ledger.huddles.filter((h) => h.role === role && h.file && !existsSync(path.join(state.dir, h.file)));
    if (missing.length) throw new UsageError(`${role} round ${missing[0].round} recorded ${missing[0].file} but the file is not in the run dir; resume that helper and have it write the file (SendMessage: "write ${missing[0].file} now") before briefing another round`);
    // the cap counts review files written as well as huddles recorded, so skipping
    // `gate huddle add` cannot stretch the loop; each reviewer role has its own file stream
    // a draft left by a cut-off helper (every bullet "unverified") is not a finished file: it
    // does not consume a round number, so a re-brief reuses it instead of orphaning it
    const isDraftFile = (f) => {
      const full = path.join(state.dir, f);
      return existsSync(full) && isDraft(readFileSync(full, "utf8"));
    };
    const finished = (prefix) => state.reviews.filter((f) => f.startsWith(prefix) && !isDraftFile(f)).length;
    // a ledger from before the second stream recorded reviewer-2 rounds on review-<n>.md
    const legacySeconds = state.ledger.huddles.filter((h) => h.role === "reviewer-2" && /^review-/.test(h.file ?? "")).length;
    const written = finished("review-") - legacySeconds;
    // past the cap a round is briefed only for a file no round of this role saw, so the cap
    // can never leave R5/R9 waiting on a round nobody may brief. With pieces the cap counts
    // the rounds that saw the piece's files (finished files, recorded or not), as R5 does.
    const seenRounds = Object.entries(state.ledger.seen ?? {}).filter(([f]) => f.startsWith(`${reviewPrefix(role)}-`) && state.reviews.includes(f) && !isDraftFile(f)).map(([, v]) => v.files ?? []);
    const perFile = piece && state.ledger.seen ? Math.max(0, ...piece.files.map((f) => seenRounds.filter((files) => files.includes(f)).length)) : null;
    const done = perFile ?? (role === "reviewer" ? Math.max(round - 1, written) : role === "reviewer-2" ? finished("review2-") + legacySeconds : 0);
    const unseen = reviewing ? uncovered(state, role) : null;
    // a ledger from before seen sets keeps its old, uncapped second reviewer
    const legacy = !state.ledger.seen;
    // past the cap a round is briefed only for a piece holding a file no round of this role saw
    const seenByRole = new Set(state.ledger.huddles.filter((h) => h.role === role && Array.isArray(h.files)).flatMap((h) => h.files));
    const neverSeen = unseen === null ? [] : reviewScope(state).filter((f) => !seenByRole.has(f));
    const stillOpen = piece ? piece.files.some((f) => neverSeen.includes(f)) : neverSeen.length > 0;
    if (done >= REVIEW_CAP && !(legacy && role === "reviewer-2") && !stillOpen) {
      throw new UsageError(`${role} round ${done + 1}: three rounds is the cap. What is still disputed goes to the arbiter (\`gate brief arbiter --item H<k>.<i>\`, spawn done-gate:arbiter); what is still open is fixed and closed with \`gate huddle resolve\`.`);
    }
    const numbers = (prefix) => state.reviews.filter((f) => f.startsWith(prefix)).map(fileNumber);
    const next = (prefix) => {
      const ns = numbers(prefix);
      if (!ns.length) return 1;
      const n = Math.max(...ns);
      return isDraftFile(`${prefix}${n}.md`) ? n : n + 1;
    };
    const reviewN = next(`${reviewPrefix(role)}-`);
    // one round of a role at a time: a second piece briefed while the first reviewer is still
    // running (its file a draft, no stop since its brief) would take the same number and
    // overwrite what that round saw; a cut-off reviewer's draft is re-briefed as before
    const draftName = `${reviewPrefix(role)}-${reviewN}.md`;
    const briefedAt = state.ledger.seen?.[draftName]?.seq ?? Infinity;
    const roleEvents = (state.events ?? []).filter((e) => isRole(e.agentType, role) && e.seq > briefedAt);
    const started = roleEvents.find((e) => e.kind === "subagent-start");
    const running = piece && isDraftFile(draftName) && Boolean(started) && !roleEvents.some((e) => e.kind === "subagent-stop" && e.seq > started.seq);
    if (running) {
      throw new UsageError(`${draftName} is still a draft and that ${role} has not stopped: wait for its hand-back (or SendMessage it "write ${draftName} now") before briefing the next piece; reviewer and reviewer-2 may run side by side, two rounds of one role may not.`);
    }
    // a packet already names another piece for this same file and nobody has run it yet: a
    // second brief would swap the piece under it without a word
    const prior = state.ledger.seen?.[draftName];
    const samePiece = prior && piece && prior.files.length === piece.files.length && prior.files.every((f) => piece.files.includes(f));
    const stoppedSince = prior && (state.events ?? []).some((e) => e.kind === "subagent-stop" && isRole(e.agentType, role) && e.seq > prior.seq);
    if (prior && piece && !samePiece && !stoppedSince) {
      throw new UsageError(`${draftName} is already briefed for ${prior.files.join(", ")} and that ${role} has not run: spawn it with the prompt from brief-${role}-${round}.md, or re-brief the same files; a different piece waits for its hand-back.`);
    }
    const skepticN = next("skeptic-");
    const arbiterN = next("arbiter-");
    let item = null;
    if (role === "arbiter") {
      const aid = flag(ctx.args, "--item");
      if (!aid) throw new UsageError("usage: gate brief arbiter --item <H#.#> (a disputed item the reviewer upheld)");
      item = state.ledger.huddles.flatMap((h) => h.actOn).find((a) => a.id === aid);
      if (!item) throw new UsageError(`no act-on item ${aid}`);
      if (!item.dispute || item.dispute.verdict !== "upheld") throw new UsageError(`${aid} is not a disputed item the reviewer upheld; the arbiter only settles those`);
    }
    // what this round's reviewer is shown; the huddle for its file inherits it, and edits
    // after a clean round are judged against it
    if (piece) {
      state.ledger.seen = { ...(state.ledger.seen ?? {}), [`${reviewPrefix(role)}-${reviewN}.md`]: { files: piece.files, seq: nextSeq() } };
      saveLedger(state.dir, state.ledger);
    }
    const file = path.join(state.dir, `brief-${role}-${round}.md`);
    writeFileSync(file, renderPacket(state, role, { round, reviewN, skepticN, arbiterN, item, piece }));
    const own = { skeptic: `skeptic-${skepticN}.md`, arbiter: `arbiter-${arbiterN}.md`, reviewer: `review-${reviewN}.md`, "reviewer-2": `review2-${reviewN}.md`, worker: `worker-${reviewN}.md` }[role];
    ctx.out(`packet: ${file}`);
    ctx.out(`prompt: Read ${file} and follow your role brief.${own && role !== "worker" ? ` Your file is ${path.join(state.dir, own)}: write it first, then investigate and rewrite it.` : ""}`);
    printNext(ctx);
  },
};
