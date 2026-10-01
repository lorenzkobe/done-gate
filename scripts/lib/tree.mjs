import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { IGNORE_CASE, repoPath } from "./paths.mjs";

// Never part of a snapshot: the gate's own state, dependencies, VCS internals.
const SKIP_PREFIXES = [".claude/gate/", "node_modules/", ".git/"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage"]);

// Claude Code's own harness files under .claude/ are never part of a snapshot either.
const SKIP_HARNESS = new RegExp(String.raw`^\.claude/(?:.*\.lock|scheduled_tasks[^/]*|settings\.local\.json)$`, IGNORE_CASE ? "i" : "");

function skip(rel) {
  return SKIP_PREFIXES.some((p) => rel.startsWith(p)) || SKIP_HARNESS.test(rel);
}

function gitFiles(root) {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
  );
  const deleted = new Set(
    execFileSync("git", ["ls-files", "--deleted", "-z"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    }).split("\0").filter(Boolean),
  );
  return out.split("\0").filter((f) => f && !deleted.has(f));
}

function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  visit(root);
  return out;
}

export function listFiles(root) {
  let files;
  try {
    files = existsSync(path.join(root, ".git")) ? gitFiles(root) : walk(root);
  } catch {
    files = walk(root);
  }
  return [...new Set(files.map((f) => f.split(path.sep).join("/")).filter((f) => !skip(f)))].sort();
}

function sha1(buf) {
  return createHash("sha1").update(buf).digest("hex");
}

// Newline count, plus one for an unterminated last line; an empty file has no lines and a
// binary file (a NUL byte in its first 8 KB) has null, so it is never sized by lines.
export function countLines(buf) {
  if (!buf.length) return 0;
  const probe = buf.subarray(0, 8000);
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return null;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n += 1;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

// The commit HEAD points at, or null (no repo, no commits). Recorded at `gate open` so a
// commit made mid-task does not shrink the diff the reviewer sees.
export function gitHead(root) {
  try {
    return git(root, ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

// The root of the git work tree a directory is in, or null when it is in none.
export function gitTop(dir) {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]).trim() || null;
  } catch {
    return null;
  }
}

// Tracked files, a declared repo's under its prefix; nothing for a root where git cannot
// answer (no repo, no commits, a directory that is gone).
export function gitTracked(root, repos = []) {
  const out = new Set();
  for (const { dir, key } of [{ dir: root, key: "" }, ...repos.map((r) => ({ dir: r.root, key: `${r.prefix}/` }))]) {
    try {
      for (const f of git(dir, ["ls-files", "-z"]).split("\0")) if (f) out.add(`${key}${f}`);
    } catch {
      // this root adds nothing
    }
  }
  return out;
}

// Paths that differ between two commits, a rename as both its paths; empty when git cannot answer.
export function gitChanged(root, from, to) {
  try {
    return new Set(git(root, ["diff", "--name-only", "--no-renames", "-z", from, to]).split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

const DIFFERS_CHUNK = 500;

// The paths among `rels` whose working copy differs from a commit; null when git cannot answer.
export function gitDiffers(dir, ref, rels) {
  try {
    const out = new Set();
    // in chunks, so thousands of paths never outgrow one command line
    for (let i = 0; i < rels.length; i += DIFFERS_CHUNK) {
      for (const f of git(dir, ["diff", "--name-only", "--no-renames", "-z", ref, "--", ...rels.slice(i, i + DIFFERS_CHUNK)]).split("\0")) if (f) out.add(f);
    }
    return out;
  } catch {
    return null;
  }
}

// Files where indentation is meaning: a whitespace-only change to one is a real change.
const INDENTED = /\.(?:py|pyi|ya?ml|pug|haml|sass|styl|coffee|nim|mk)$|(?:^|\/)Makefile$/;
export const indentMatters = (rel) => INDENTED.test(rel);

// Added/deleted line counts of uncommitted changes vs HEAD, keyed by the current path;
// empty when git cannot answer. NUL-separated output, so quoted or odd filenames survive,
// and renames arrive as one row with `from` set (a pure move is 0 lines).
export function gitNumstat(root, paths = [], ref = "HEAD", { ignoreWhitespace = false, repos = [], heads = {} } = {}) {
  const out = new Map();
  const groups = new Map([[-1, { dir: root, key: "", ref, rels: repos.length ? [] : paths }]]);
  // a declared repo's paths are asked of its own git against its own ref (heads[prefix], else
  // HEAD) and come back under their prefix: one process per repo named
  for (const p of repos.length ? paths : []) {
    const at = repoPath(root, p, repos);
    if (!groups.has(at.index)) groups.set(at.index, { dir: at.repoRoot, key: `${at.prefix}/`, ref: heads?.[at.prefix] ?? "HEAD", rels: [] });
    groups.get(at.index).rels.push(at.rel);
  }
  for (const g of groups.values()) {
    // no path asks git about the whole tree: right for a call that named none, wrong for the
    // main group when every named path is in a declared repo
    if (paths.length && !g.rels.length) continue;
    try {
      const raw = git(g.dir, ["diff", "--numstat", "-z", "-M", ...(ignoreWhitespace ? ["-w"] : []), g.ref, "--", ...g.rels]);
      const parts = raw.split("\0");
      for (let i = 0; i < parts.length; i++) {
        const m = /^(\S+)\t(\S+)\t(.*)$/.exec(parts[i]);
        if (!m) continue;
        const binary = m[1] === "-" || m[2] === "-";
        const row = { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary, from: null };
        if (m[3] === "") {
          // rename: the path field is empty and the next two parts are old and new path
          row.from = `${g.key}${parts[i + 1]}`;
          out.set(`${g.key}${parts[i + 2]}`, row);
          i += 2;
        } else out.set(`${g.key}${m[3]}`, row);
      }
    } catch {
      // no HEAD (fresh repo) or not a git repo: callers fall back to line-count deltas
    }
  }
  return out;
}

// Where the copy of a file already modified at open is kept: base/<rel>.base (a name no test
// or lint glob picks up), a declared repo's file under base/@<its index>/.
export function baseCopyPath(dir, rel, repos = []) {
  const at = repoPath(null, rel, repos);
  return path.join(dir, "base", ...(at.index < 0 ? [] : [`@${at.index}`]), `${at.rel}.base`);
}

// The copy `gate open` kept of a file already modified then, or null: baseline.based does
// not list it or the copy is gone.
export function baseCopy(dir, baseline, rel, repos = []) {
  if (!dir || !baseline?.based?.includes(rel)) return null;
  const copy = baseCopyPath(dir, rel, repos);
  return existsSync(copy) ? copy : null;
}

// git diff --no-index exits 1 when the two files differ; that is its answer, not a failure.
function gitNoIndex(root, args) {
  try {
    return git(root, ["diff", "--no-index", ...args]);
  } catch (error) {
    if (error.status === 1) return String(error.stdout ?? "");
    throw error;
  }
}

// Lines added plus deleted between a base copy and the file now. --no-index prints its row
// in rename form (copy => file), so only the two counts are read; no row is no difference.
export function copyNumstat(root, copy, rel, { ignoreWhitespace = false, repos = [] } = {}) {
  const at = repoPath(root, rel, repos);
  const m = /^(\d+)\t(\d+)\t/.exec(gitNoIndex(at.repoRoot, ["--numstat", ...(ignoreWhitespace ? ["-w"] : []), "--", copy, path.join(at.repoRoot, at.rel)]));
  return m ? Number(m[1]) + Number(m[2]) : 0;
}

// {hash, files: {rel: {h, s, m, l}}, rehashed}. Content-hashed; size+mtime only decide
// whether a previous snapshot's hash can be reused, so a touch never counts as a change.
// `l` is the line count, kept so the tier can be estimated without a second read.
export function snapshot(root, previous = null, repos = []) {
  const files = {};
  let rehashed = addFiles(files, root, "", previous);
  // a declared repo's files sit under its prefix, each repo listed once; a directory that is gone adds nothing
  for (const repo of repos) rehashed += addFiles(files, repo.root, `${repo.prefix}/`, previous);
  return { hash: treeHash(files), files, rehashed, at: new Date().toISOString() };
}

function addFiles(files, dir, key, previous) {
  if (key && !existsSync(dir)) return 0;
  let rehashed = 0;
  for (const name of listFiles(dir)) {
    const rel = `${key}${name}`;
    const abs = path.join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // deleted between listing and stat
    }
    const prev = previous?.files?.[rel];
    if (prev && prev.s === st.size && prev.m === st.mtimeMs && "l" in prev) {
      files[rel] = prev;
      continue;
    }
    const buf = readFileSync(abs);
    files[rel] = { h: sha1(buf), s: st.size, m: st.mtimeMs, l: countLines(buf) };
    rehashed += 1;
  }
  return rehashed;
}

// A tree with the declared repos' files added as they are now: what a repo declared at
// `gate open` starts from.
export function withRepos(tree, repos) {
  if (!repos.length) return tree;
  const files = { ...tree.files };
  for (const repo of repos) addFiles(files, repo.root, `${repo.prefix}/`, null);
  return { hash: treeHash(files), files };
}

// A tree without the files of the given repos: session state holds main-root keys only.
export function withoutRepos(tree, repos = []) {
  if (!repos.length) return { files: tree.files, hash: tree.hash };
  const files = {};
  for (const rel of Object.keys(tree.files)) if (repoPath(null, rel, repos).index < 0) files[rel] = tree.files[rel];
  return { files, hash: treeHash(files) };
}

// A baseline with one repo's files as its HEAD has them: a tracked file that differs gets a placeholder
// (h "HEAD", its HEAD line count), an untracked one only a place in untrackedAtHead. Throws when git cannot compare.
export function withRepoAtHead(baseline, repo, now) {
  const key = `${repo.prefix}/`;
  // with no commit yet nothing was there before the run: staged or not, every file counts whole
  const head = gitHead(repo.root);
  const tracked = head ? gitTracked(repo.root) : new Set();
  const dirty = new Map();
  if (head) {
    for (const part of git(repo.root, ["diff", "--numstat", "-z", "--no-renames", "HEAD"]).split("\0")) {
      const m = /^(\S+)\t(\S+)\t(.+)$/.exec(part);
      // a path no snapshot lists would stay "deleted" for the whole run
      if (m && !skip(m[3])) dirty.set(m[3], m[1] === "-" ? null : Number(m[2]) - Number(m[1]));
    }
  }
  const files = { ...baseline.files };
  for (const [rel, delta] of dirty) files[`${key}${rel}`] = { h: "HEAD", s: -1, m: 0, l: delta === null ? null : (now.files[`${key}${rel}`]?.l ?? 0) + delta };
  const untracked = [];
  for (const rel of Object.keys(now.files)) {
    if (!rel.startsWith(key) || dirty.has(rel.slice(key.length))) continue;
    if (tracked.has(rel.slice(key.length))) files[rel] = now.files[rel];
    else untracked.push(rel);
  }
  return { ...baseline, files, hash: treeHash(files), untrackedAtHead: [...(baseline.untrackedAtHead ?? []), ...untracked] };
}

function treeHash(files) {
  const digest = createHash("sha1");
  for (const rel of Object.keys(files).sort()) digest.update(`${rel}\0${files[rel].h}\n`);
  return digest.digest("hex");
}

// The baseline a new task starts from: the session's, except that a file clean against HEAD
// right now takes its current state. Work already committed (an earlier task in a long
// session) is not this task's; an uncommitted or untracked edit made before open still is.
// With no commit to compare against, the session's baseline stands.
export function taskBaseline(root, base, dirty) {
  if (!gitHead(root)) return base;
  // git answers in top-level paths; a project root below it keeps the session's baseline
  try {
    if (git(root, ["rev-parse", "--show-prefix"]).trim()) return base;
  } catch {
    return base;
  }
  const now = snapshot(root, base);
  const tracked = gitTracked(root);
  const pending = new Set(dirty);
  const files = { ...base.files };
  for (const rel of new Set([...Object.keys(base.files), ...Object.keys(now.files)])) {
    if (pending.has(rel)) continue;
    if (rel in now.files && !tracked.has(rel)) continue; // untracked: made before open, still pending
    if (rel in now.files) files[rel] = now.files[rel];
    else delete files[rel]; // gone and not tracked: a committed deletion
  }
  return { hash: treeHash(files), files };
}

export function diffSnapshots(before, after) {
  const b = before?.files ?? {};
  const a = after?.files ?? {};
  const modified = [];
  const added = [];
  const deleted = [];
  for (const rel of Object.keys(a)) {
    if (!(rel in b)) added.push(rel);
    else if (b[rel].h !== a[rel].h) modified.push(rel);
  }
  for (const rel of Object.keys(b)) if (!(rel in a)) deleted.push(rel);
  const changed = [...modified, ...added, ...deleted].sort();
  return { modified: modified.sort(), added: added.sort(), deleted: deleted.sort(), changed };
}

// One file's unified diff as hunks of tagged lines, each with the new-file line number it
// sits at (a deletion sits at the line that follows it). The header lines before the first
// hunk are kept for re-rendering.
export function parseHunks(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const header = [];
  const hunks = [];
  let hunk = null;
  for (const line of lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      hunk = { header: line, pos: Number(m[1]), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      header.push(line);
      continue;
    }
    const tag = line[0];
    if (tag === "+") hunk.lines.push({ tag, text: line, pos: hunk.pos++ });
    else if (tag === "-") hunk.lines.push({ tag, text: line, pos: hunk.pos });
    else if (tag === " " || line === "") hunk.lines.push({ tag: " ", text: line, pos: hunk.pos++ });
    else hunk.lines.push({ tag: "\\", text: line, pos: hunk.pos });
  }
  return { header, hunks };
}

// Every changed line of a diff as a unit: its new-file position and a key made of its text
// and the line before it, so a unit survives an edit above it (which moves its position) and
// dies with an edit to it. A deletion is keyed on the text it removed.
// Repeated line pairs get an occurrence ordinal, so a key is unique within the file.
export function changedUnits(text) {
  const out = [];
  const seen = new Map();
  for (const h of parseHunks(text).hunks) {
    let prev = "";
    for (const l of h.lines) {
      if (l.tag === "+" || l.tag === "-") {
        const base = createHash("sha1").update(`${l.tag}${l.text.slice(1)}\u0000${prev}`).digest("hex").slice(0, 12);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        out.push({ pos: l.pos, key: n === 1 ? base : `${base}#${n}` });
      }
      if (l.tag !== "-") prev = l.text.slice(1);
    }
  }
  return out;
}

// Whether a diff could shrink when whitespace is ignored: some removed line equals an added
// one once its whitespace is gone. Spares the second diff process when it cannot.
export function hasReindent(text) {
  const lines = parseHunks(text).hunks.flatMap((h) => h.lines);
  const bare = (l) => l.text.slice(1).replace(/\s+/g, "");
  const removed = new Set(lines.filter((l) => l.tag === "-").map(bare));
  return lines.some((l) => l.tag === "+" && removed.has(bare(l)));
}

// The last position a slice from the units' first position may reach and still hold at most
// cap units; a first position that alone holds more is the slice (it cannot be narrowed).
export function sliceEnd(units, cap) {
  let to = units[0].pos;
  let count = 0;
  for (const u of units) {
    if (u.pos !== to && count + 1 > cap) break;
    if (u.pos !== to && units.filter((x) => x.pos === u.pos).length + count > cap) break;
    to = u.pos;
    count += 1;
  }
  return to;
}

// The part of a diff whose lines fall inside any of the ranges, hunk by hunk, re-headed
// with the new-file span each slice covers.
export function sliceDiff(text, ranges) {
  const { header, hunks } = parseHunks(text);
  const inside = (pos) => ranges.some(([from, to]) => pos >= from && pos <= to);
  const out = [...header];
  for (const h of hunks) {
    const kept = h.lines.filter((l) => inside(l.pos));
    if (!kept.some((l) => l.tag === "+" || l.tag === "-")) continue;
    out.push(`@@ lines ${kept[0].pos}-${kept[kept.length - 1].pos} of the new file @@`);
    out.push(...kept.map((l) => l.text));
  }
  return out.join("\n");
}

// The raw unified diff of one changed file: against its base copy (headed with the repo path),
// else git's against ref (heads[prefix] in a declared repo), else a synthetic all-added block.
export function fileDiff(root, ref, rel, tracked, { base = null, ignoreWhitespace = false, repos = [], heads = {} } = {}) {
  const at = repoPath(root, rel, repos);
  const abs = path.join(at.repoRoot, at.rel);
  const w = ignoreWhitespace ? ["-w"] : [];
  if (base) {
    if (!existsSync(abs)) return "";
    const lines = gitNoIndex(at.repoRoot, [...w, "--", base, abs]).trim().split("\n");
    const first = lines.findIndex((l) => l.startsWith("@@"));
    return first < 0 ? "" : [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`, ...lines.slice(first)].join("\n");
  }
  if (tracked) {
    try {
      const text = at.index < 0
        ? git(root, ["diff", ...w, ref, "--", rel]).trim()
        : git(at.repoRoot, ["diff", ...w, `--src-prefix=a/${at.prefix}/`, `--dst-prefix=b/${at.prefix}/`, heads?.[at.prefix] ?? "HEAD", "--", at.rel]).trim();
      if (text || ignoreWhitespace) return text;
    } catch {
      // no ref or not a repo: fall through to the synthetic block
    }
  }
  if (!existsSync(abs)) return "";
  const buf = readFileSync(abs);
  for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return `diff --git a/${rel} b/${rel}\nbinary file (${buf.length} bytes), contents not shown`;
  const lines = buf.toString("utf8").replace(/\r/g, "").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return [`diff --git a/${rel} b/${rel}`, "new file (no git history for this task)", "--- /dev/null", `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}
