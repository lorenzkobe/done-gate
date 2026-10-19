import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The newest released done-gate, read from the GitHub repo the done-gate marketplace installs
// from, and saved so the check goes online at most every few hours and gate open never does.
const FRESH_MS = 6 * 3600 * 1000;
const home = () => process.env.DONE_GATE_HOME || homedir();
const savedFile = () => path.join(home(), ".claude", "done-gate-release.json");

const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

function newer(a, b) {
  const parts = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

function githubRepo() {
  const source = read(path.join(home(), ".claude", "plugins", "known_marketplaces.json"))?.["done-gate"]?.source;
  return source?.source === "github" && typeof source.repo === "string" ? source.repo : null;
}

// The newer version, or null: offline, a private repo, a slow answer or no GitHub marketplace
// all mean no check, never a block.
export async function checkRelease(running, now = Date.now()) {
  let saved = read(savedFile());
  if (!saved || !(now - Date.parse(saved.checkedAt) < FRESH_MS)) {
    const repo = githubRepo();
    if (repo) {
      let latest = null;
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/plugin.json`, { signal: AbortSignal.timeout(3000) });
        latest = res.ok ? (await res.json()).version : null;
      } catch {
        // offline or refused: the saved answer, if any, stands
      }
      // a failed try also waits its six hours, so an offline machine does not pay the timeout at every start
      saved = { latest: typeof latest === "string" ? latest : (saved?.latest ?? null), checkedAt: new Date(now).toISOString(), repo };
      try {
        mkdirSync(path.dirname(savedFile()), { recursive: true });
        writeFileSync(savedFile(), JSON.stringify(saved));
      } catch {
        // an unwritable home only costs the next start another try
      }
    }
  }
  return saved?.latest && newer(saved.latest, running) ? saved.latest : null;
}

// The saved answer only, for a verb that must not wait on the network.
export function knownNewer(running) {
  const saved = read(savedFile());
  return saved?.latest && newer(saved.latest, running) ? saved.latest : null;
}

// The running copy stays until a reload: the gate skill names its path when it loads.
export const UPDATE_COMMANDS = "`claude plugin marketplace update done-gate`, then `claude plugin update done-gate@done-gate --scope user -y`, then `/reload-plugins` (or restart) and load the gate skill again";
