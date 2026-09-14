import path from "node:path";

// Every path the gate stores or compares is root-relative POSIX. Hook payloads carry
// absolute paths (sometimes with backslashes on Windows); rules carry globs.
export function toPosixRel(root, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
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

export const IGNORE_CASE = process.platform === "win32" || process.platform === "darwin";
