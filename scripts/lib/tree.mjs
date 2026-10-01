import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { IGNORE_CASE } from "./paths.mjs";

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

// Tracked files, or an empty set when git cannot answer (no repo, no commits).
export function gitTracked(root) {
  try {
    return new Set(git(root, ["ls-files", "-z"]).split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

// Paths that differ between two commits, a rename as both its paths; empty when git cannot answer.
export function gitChanged(root, from, to) {
  try {
    return new Set(git(root, ["diff", "--name-only", "--no-renames", "-z", from, to]).split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

// Files where indentation is meaning: a whitespace-only change to one is a real change.
const INDENTED = /\.(?:py|pyi|ya?ml|pug|haml|sass|styl|coffee|nim|mk)$|(?:^|\/)Makefile$/;
export const indentMatters = (rel) => INDENTED.test(rel);

// Added/deleted line counts of uncommitted changes vs HEAD, keyed by the current path;
// empty when git cannot answer. NUL-separated output, so quoted or odd filenames survive,
// and renames arrive as one row with `from` set (a pure move is 0 lines).
export function gitNumstat(root, paths = [], ref = "HEAD", { ignoreWhitespace = false } = {}) {
  const out = new Map();
  try {
    const raw = git(root, ["diff", "--numstat", "-z", "-M", ...(ignoreWhitespace ? ["-w"] : []), ref, "--", ...paths]);
    const parts = raw.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const m = /^(\S+)\t(\S+)\t(.*)$/.exec(parts[i]);
      if (!m) continue;
      const binary = m[1] === "-" || m[2] === "-";
      const row = { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary, from: null };
      if (m[3] === "") {
        // rename: the path field is empty and the next two parts are old and new path
        row.from = parts[i + 1];
        out.set(parts[i + 2], row);
        i += 2;
      } else out.set(m[3], row);
    }
  } catch {
    // no HEAD (fresh repo) or not a git repo: callers fall back to line-count deltas
  }
  return out;
}

// The copy `gate open` kept of a file already modified then (base/<rel>.base, a name no
// test or lint glob picks up), or null: baseline.based does not list it or the copy is gone.
export function baseCopy(dir, baseline, rel) {
  if (!dir || !baseline?.based?.includes(rel)) return null;
  const copy = path.join(dir, "base", `${rel}.base`);
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
export function copyNumstat(root, copy, rel, { ignoreWhitespace = false } = {}) {
  const m = /^(\d+)\t(\d+)\t/.exec(gitNoIndex(root, ["--numstat", ...(ignoreWhitespace ? ["-w"] : []), "--", copy, path.join(root, rel)]));
  return m ? Number(m[1]) + Number(m[2]) : 0;
}

// {hash, files: {rel: {h, s, m, l}}, rehashed}. Content-hashed; size+mtime only decide
// whether a previous snapshot's hash can be reused, so a touch never counts as a change.
// `l` is the line count, kept so the tier can be estimated without a second read.
export function snapshot(root, previous = null) {
  const files = {};
  let rehashed = 0;
  for (const rel of listFiles(root)) {
    const abs = path.join(root, rel);
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
  return { hash: treeHash(files), files, rehashed, at: new Date().toISOString() };
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
// else git's against ref for a tracked file, else a synthetic all-added block.
export function fileDiff(root, ref, rel, tracked, { base = null, ignoreWhitespace = false } = {}) {
  const abs = path.join(root, rel);
  const w = ignoreWhitespace ? ["-w"] : [];
  if (base) {
    if (!existsSync(abs)) return "";
    const lines = gitNoIndex(root, [...w, "--", base, abs]).trim().split("\n");
    const first = lines.findIndex((l) => l.startsWith("@@"));
    return first < 0 ? "" : [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`, ...lines.slice(first)].join("\n");
  }
  if (tracked) {
    try {
      const text = git(root, ["diff", ...w, ref, "--", rel]).trim();
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
