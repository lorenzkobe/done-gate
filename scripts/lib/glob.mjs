// Dependency-free glob matcher over root-relative POSIX paths.
// Supports **, *, ?, and {a,b} alternation. Everything else is literal.

function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const before = pattern.slice(0, m.index);
  const after = pattern.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((alt) => expandBraces(`${before}${alt}${after}`));
}

function escapeRegex(ch) {
  return /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function toRegexSource(pattern) {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      const followedBySlash = pattern[i + 2] === "/";
      const precededBySlash = i > 0 && pattern[i - 1] === "/";
      if (followedBySlash) {
        // "**/" — zero or more leading directories
        out += "(?:.*/)?";
        i += 3;
        continue;
      }
      if (precededBySlash && i + 2 === pattern.length) {
        // trailing "/**" — the directory itself or anything beneath it
        out = out.slice(0, -1); // drop the "/" already emitted
        out += "(?:/.*)?";
        i += 2;
        continue;
      }
      out += ".*";
      i += 2;
      continue;
    }
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += escapeRegex(ch);
    i += 1;
  }
  return out;
}

const cache = new Map();

export function globToRegex(pattern, { ignoreCase = false } = {}) {
  const key = `${ignoreCase ? "i" : "s"}:${pattern}`;
  let re = cache.get(key);
  if (!re) {
    const source = expandBraces(pattern).map(toRegexSource).join("|");
    re = new RegExp(`^(?:${source})$`, ignoreCase ? "i" : "");
    cache.set(key, re);
  }
  return re;
}

export function matchGlob(pattern, relPath, opts) {
  return globToRegex(pattern, opts).test(relPath);
}

export function matchAny(patterns, relPath, opts) {
  return patterns.some((p) => matchGlob(p, relPath, opts));
}
