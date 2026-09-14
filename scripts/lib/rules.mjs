import { createHash } from "node:crypto";

// Hash of the SOURCE files in a snapshot. verify.json stores it, so a docs or ledger
// edit after `gate verify` does not force a re-run, but any source edit does.
export function sourceHash(snap, config) {
  const digest = createHash("sha1");
  for (const rel of Object.keys(snap?.files ?? {}).sort()) {
    if (config.isSource(rel)) digest.update(`${rel}\0${snap.files[rel].h}\n`);
  }
  return digest.digest("hex");
}

function list(paths, max = 3) {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown}, +${paths.length - max} more` : shown;
}

function waived(ledger, key) {
  return (ledger.waivers ?? []).some((w) => w.key === key && w.found !== false);
}

// Pure: state in, unmet rules out. Every item says what to do next.
export function evaluate(state) {
  const { config, ledger, changed, now, verify } = state;
  const unmet = [];
  const src = changed.filter((p) => config.isSource(p));

  if (!ledger) {
    if (src.length) {
      unmet.push({
        rule: "R1",
        text: `source changed (${list(src)}) but no ledger is open for this session. Run \`gate open <slug> <feature|bugfix|refactor|plan>\` (or \`gate attach <slug>\`), write Task, Plan and the case table, then continue.`,
      });
    }
    return unmet;
  }

  if (src.length) {
    if (!verify) {
      unmet.push({ rule: "R3", text: "no verify.json for this run. Run `gate verify` after your last source edit." });
    } else {
      const red = (verify.commands ?? []).filter((c) => c.exit !== 0 || c.timedOut);
      if (red.length) {
        unmet.push({
          rule: "R3",
          text: `verify is red: ${red.map((c) => `\`${c.cmd}\` ${c.timedOut ? "timed out" : `exit ${c.exit}`}`).join("; ")}. Fix, then run \`gate verify\` again.`,
        });
      } else if (verify.sourceHash !== sourceHash(now, config)) {
        unmet.push({ rule: "R3", text: "verify.json is stale: source changed after the last `gate verify`. Run it again." });
      }
    }

    if (!changed.some((p) => config.isTest(p)) && !waived(ledger, "qa")) {
      unmet.push({
        rule: "R7",
        text: `source changed (${list(src)}) but no test file changed. Have QA write tests for the case table, or get the user's waiver (\`gate waive qa "<their words>"\`).`,
      });
    }
  }

  return unmet;
}
