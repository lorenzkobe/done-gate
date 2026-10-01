import path from "node:path";

function relTo(root, candidate) {
  const normalisedRoot = path.resolve(root).replace(/\\/g, "/").replace(/\/+$/, "");
  let p = candidate.replace(/\\/g, "/");
  if (!path.posix.isAbsolute(p) && !/^[A-Za-z]:\//.test(p)) {
    p = `${normalisedRoot}/${p}`;
  }
  p = path.posix.normalize(p).replace(/\/+$/, "");
  const rootForCompare = process.platform === "win32" ? normalisedRoot.toLowerCase() : normalisedRoot;
  const pForCompare = process.platform === "win32" ? p.toLowerCase() : p;
  if (pForCompare === rootForCompare) return "";
  if (!pForCompare.startsWith(`${rootForCompare}/`)) return null;
  return p.slice(normalisedRoot.length + 1);
}

// Every path the gate stores or compares is root-relative POSIX. Hook payloads carry
// absolute paths (sometimes with backslashes on Windows); rules carry globs.
export function toPosixRel(root, candidate, repos = []) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const rel = relTo(root, candidate);
  if (rel !== null) return rel;
  const absolute = path.resolve(root, candidate);
  // outside the root: <prefix>/<rel> when a declared repo holds it. `repos` may be a function,
  // called only here, so an edit inside the root never loads the ledger
  for (const repo of typeof repos === "function" ? repos() : repos) {
    // the stored root is the real path; a payload may spell the repo through a symlinked parent
    const inside = relTo(repo.root, absolute) ?? relTo(path.resolve(root, repo.prefix), absolute);
    if (inside !== null) return inside ? `${repo.prefix}/${inside}` : repo.prefix;
  }
  return null;
}

// Where a stored path lives: a declared repo's file as that repo's root, its path there and
// the repo's position in ledger.repos; a main-root path as the root itself, index -1.
export function repoPath(root, rel, repos = []) {
  for (let index = 0; index < repos.length; index++) {
    const { prefix, root: repoRoot } = repos[index];
    if (rel.startsWith(`${prefix}/`)) return { repoRoot, rel: rel.slice(prefix.length + 1), index, prefix };
  }
  return { repoRoot: root, rel, index: -1, prefix: null };
}

export const IGNORE_CASE = process.platform === "win32" || process.platform === "darwin";
