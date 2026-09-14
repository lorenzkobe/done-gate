import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Never part of a snapshot: the gate's own state, dependencies, VCS internals.
const SKIP_PREFIXES = [".claude/gate/", "node_modules/", ".git/"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage"]);

function skip(rel) {
  return SKIP_PREFIXES.some((p) => rel.startsWith(p));
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

// {hash, files: {rel: {h, s, m}}, rehashed}. Content-hashed; size+mtime only decide
// whether a previous snapshot's hash can be reused, so a touch never counts as a change.
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
    if (prev && prev.s === st.size && prev.m === st.mtimeMs) {
      files[rel] = prev;
      continue;
    }
    files[rel] = { h: sha1(readFileSync(abs)), s: st.size, m: st.mtimeMs };
    rehashed += 1;
  }
  const digest = createHash("sha1");
  for (const rel of Object.keys(files).sort()) digest.update(`${rel}\0${files[rel].h}\n`);
  return { hash: digest.digest("hex"), files, rehashed, at: new Date().toISOString() };
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
