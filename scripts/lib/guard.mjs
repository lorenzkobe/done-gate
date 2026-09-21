import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { currentLedger } from "./ledger.mjs";
import { leadDelegates } from "./size.mjs";
import { appendEvents, nextSeq } from "./events.mjs";
import { toPosixRel } from "./paths.mjs";

// Files only the gate's own verbs may write. A model that could edit these could
// forge its evidence, so the deny is unconditional and every attempt is logged.
const EVIDENCE_FILES = new Set(["events.jsonl", "verify.json", "decisions.tsv", "ledger.json", "blocks.json", "state.json", "gate-error.log", "current-session"]);
const EVIDENCE_IN_COMMAND = /\.claude\/gate\/\S*(events\.jsonl|verify\.json|decisions\.tsv|ledger\.json|blocks\.json|state\.json|current-session|brief-[a-z0-9-]+-\d+\.md|(?:review|skeptic|arbiter|worker)-\d+\.md)/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const HELPER_ROLES = ["skeptic", "qa", "reviewer", "reviewer-2", "arbiter"];
// Shell forms that create or change files. Helpers may use them only on scratch paths
// (tests/.tmp, /tmp, a scratchpad dir); git commands that change the repo are never theirs.
const SHELL_WRITE = /(?:^|[;&|(]\s*|\s)(?:tee|rm|mv|cp|touch|mkdir|truncate|install|dd|tar)\s|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|(?:^|[^<>])>{1,2}(?!&)/;
const GIT_WRITE = /\bgit\s+(?:add|commit|checkout|switch|reset|restore|stash|apply|am|merge|rebase|mv|rm|clean|push)\b/;
// inline code handed to an interpreter can write anywhere and cannot be inspected; helpers
// put such code in a scratch script instead, where the write shows as a path
const INLINE_CODE = /\b(?:node|nodejs|deno|bun|python3?|perl|ruby|sh|bash|zsh)\s+(?:-[a-zA-Z]*[ecp]\b|--eval\b|--print\b)|\bphp\s+-r\b/;
const SCRATCH = /(?:^|\/)(?:tests\/\.tmp|tmp|scratchpad)(?:\/|$)|^\/private\/tmp\//;
const INLINE_WRITE = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?|truncate(?:Sync)?|createWriteStream|open\s*\([^)]*["'][wa][+]?["'])|os\.(?:remove|rename|unlink|makedirs|mkdir)|shutil\.|file_put_contents|fopen|fwrite|unlink/;

// Does a helper's shell write stay inside scratch space? Every path-looking token must be
// scratch; for cp/mv only the destination (the last path) is a write.
function shellWriteOutsideScratch(raw) {
  // quoted strings are arguments, not commands; discarding a stream is not a write
  const cmd = String(raw)
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
    .replace(/\d*>{1,2}\s*\/dev\/null/g, " ")
    .replace(/\d>&\d/g, " ");
  if (GIT_WRITE.test(cmd)) return true;
  // inline code is fine to read with; it is a write only when the snippet names a write call
  // or the command redirects output (tested with quoted strings stripped, so `2 > 1` inside
  // the snippet is not a redirection)
  if (INLINE_CODE.test(cmd) && (INLINE_WRITE.test(String(raw)) || />\s*[^&\s]/.test(cmd))) return true;
  if (!SHELL_WRITE.test(cmd)) return false;
  const tokens = cmd.split(/\s+/).filter((t) => /[\/.]/.test(t) && !t.startsWith("-") && !/^https?:/.test(t) && !/^\d+([.]\d+)?$/.test(t));
  const paths = tokens.map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => !/^s[\/|#].*[\/|#]$/.test(t)); // sed expressions are not paths
  if (!paths.length) return true; // a write with no visible target (e.g. `echo x > $FILE`) is not provable as scratch
  // cp reads its sources; mv also removes them, so every path of an mv must be scratch
  const cpLike = /(?:^|[;&|]\s*)cp\s/.test(cmd) && !/(?:^|[;&|]\s*)mv\s/.test(cmd);
  const targets = cpLike ? paths.slice(-1) : paths;
  return targets.some((t) => !SCRATCH.test(t));
}

function targetPaths(input, root) {
  const ti = input.tool_input ?? {};
  const raw = input.tool_name === "MultiEdit" ? (ti.edits ?? []).map((e) => e?.file_path) : [ti.file_path ?? ti.notebook_path];
  return raw.map((p) => toPosixRel(root, p)).filter((p) => typeof p === "string" && p.length);
}

const PACKET = /^\.claude\/gate\/runs\/[^/]+\/brief-[a-z0-9-]+-\d+\.md$/;

function isEvidence(rel) {
  if (!rel.startsWith(".claude/gate/")) return false;
  if (rel.startsWith(".claude/gate/sessions/")) return true;
  if (PACKET.test(rel)) return true; // a helper's packet is written by `gate brief` only
  return EVIDENCE_FILES.has(rel.split("/").pop());
}

function isReviewFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/review-\d+\.md$/.test(rel);
}

function isSkepticFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/skeptic-\d+\.md$/.test(rel);
}

function isArbiterFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/arbiter-\d+\.md$/.test(rel);
}

function isWorkerFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/worker-\d+\.md$/.test(rel);
}

// A helper's own file must land in the run it was spawned for, never another task's folder.
// With no open ledger there is no task, so there is nowhere a helper may write.
function inCurrentRun(rel, current) {
  return Boolean(current) && rel.startsWith(`${current}/`);
}

// A reading helper (skeptic, reviewer, arbiter) owes a draft when the run dir holds more
// packets for its role family than files it wrote. Until the draft exists it may only read
// its packet and write its file, so a helper that runs out of turns always leaves a file.
const OWN_FILE = { skeptic: "skeptic", reviewer: "review", "reviewer-2": "review", arbiter: "arbiter" };
function draftOwed(roleName, root, currentRun) {
  const prefix = OWN_FILE[roleName];
  if (!prefix || !currentRun) return null;
  const dir = path.join(root, currentRun);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir);
  const family = prefix === "review" ? ["reviewer", "reviewer-2"] : [roleName];
  const packets = names.filter((f) => family.some((r) => new RegExp(`^brief-${r}-\\d+\\.md$`).test(f))).length;
  const files = names.filter((f) => new RegExp(`^${prefix}-\\d+\\.md$`).test(f));
  if (packets <= files.length) return null;
  const n = (files.length ? Math.max(...files.map((f) => Number(/\d+/.exec(f)[0]))) : 0) + 1;
  return `${currentRun}/${prefix}-${n}.md`;
}

export function decide(input, root, config = loadConfig(root), currentRun = null, ledger = null) {
  const tool = input.tool_name ?? "";
  const agentType = input.agent_type ?? null;
  const roleName = Object.keys(OWN_FILE).find((r) => agentType === `done-gate:${r}` || agentType === r) ?? null;
  const owed = roleName ? draftOwed(roleName, root, currentRun) : null;
  if (owed) {
    const rel = targetPaths(input, root)[0] ?? null;
    const packet = rel && PACKET.test(rel);
    const ownFile = rel === owed;
    if (!((tool === "Read" && packet) || (EDIT_TOOLS.has(tool) && ownFile))) {
      return { deny: true, reason: `done-gate: write your draft first: ${owed} (every section may read "- unverified"); until it exists you may only read your packet. Then investigate and rewrite it.`, paths: rel ? [rel] : [] };
    }
    return { deny: false };
  }
  if (tool === "Read") return { deny: false };

  if (tool === "Bash") {
    const cmd = String(input.tool_input?.command ?? "");
    if (EVIDENCE_IN_COMMAND.test(cmd)) {
      return { deny: true, reason: "done-gate: that command touches gate evidence files (.claude/gate/...). Evidence is written only by `gate` verbs; read it with `gate check` or `gate report`.", paths: [] };
    }
    // Helpers write only through the edit tools, where the role rules apply; a shell write
    // would bypass them. Pattern-based, so a helper that needs to write says so instead.
    if (HELPER_ROLES.some((r) => agentType === `done-gate:${r}` || agentType === r) && shellWriteOutsideScratch(cmd)) {
      return { deny: true, reason: "done-gate: helpers write through the shell only under scratch paths (tests/.tmp, /tmp, a scratchpad) and never with git write commands. Reading, grep, the test command and read-only node -e are fine; use the Write tool for your own file, or report what should change.", paths: [] };
    }
    return { deny: false };
  }
  if (!EDIT_TOOLS.has(tool)) return { deny: false };

  const paths = targetPaths(input, root);
  for (const rel of paths) {
    if (isEvidence(rel)) {
      return { deny: true, reason: `done-gate: ${rel} is gate evidence and is written only by \`gate\` verbs.`, paths };
    }
  }
  const role = (r) => agentType === `done-gate:${r}` || agentType === r;
  // the lead delegates at size standard and above: source and tests belong to the worker and
  // QA, and so does any other agent the lead might spawn instead of a worker. A "delegate"
  // waiver (R16 honours the same key) lifts this fence too.
  const delegateWaived = Boolean(ledger) && (ledger.waivers ?? []).some((w) => w.key === "delegate");
  const size = !role("worker") && !role("qa") && ledger && !delegateWaived ? leadDelegates(ledger) : null;
  if (size) {
    const owned = paths.filter((p) => config.isSource(p));
    if (owned.length) {
      const who = agentType === null ? "the lead does not edit source" : `${agentType} is not a worker`;
      return { deny: true, delegate: true, reason: `done-gate: size ${size}: ${who}; ${owned.join(", ")} belongs to a worker. Run \`gate brief worker\` and spawn done-gate:worker with the prompt it prints (or re-plan with \`gate note plan --files\` if this is really one small file).`, paths };
    }
  }
  if (role("skeptic")) {
    const outside = paths.filter((p) => !isSkepticFile(p) || !inCurrentRun(p, currentRun));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the skeptic writes only its own skeptic-<n>.md in the run dir; ${outside.join(", ")} is not that. Put findings in that file and reply with the Act-on list.`, paths };
    }
    return { deny: false };
  }
  if (role("arbiter")) {
    const outside = paths.filter((p) => !isArbiterFile(p) || !inCurrentRun(p, currentRun));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the arbiter writes only its own arbiter-<n>.md in the run dir; ${outside.join(", ")} is not that.`, paths };
    }
    return { deny: false };
  }
  // a helper's file is its evidence: nobody else writes it
  const foreign = paths.filter((p) => isSkepticFile(p) || isArbiterFile(p) || (isReviewFile(p) && !(role("reviewer") || role("reviewer-2"))) || (isWorkerFile(p) && !role("worker")));
  if (foreign.length) {
    return { deny: true, reason: `done-gate: ${foreign.join(", ")} is a helper's own evidence file and is written only by that helper.`, paths };
  }
  if (role("qa")) {
    const outside = paths.filter((p) => !config.isTest(p));
    if (outside.length) {
      return { deny: true, reason: `done-gate: QA may write only under the tests globs; ${outside.join(", ")} is outside them. Report what the implementation should change instead.`, paths };
    }
  }
  if (role("worker")) {
    const outside = paths.filter((p) => isWorkerFile(p) && !inCurrentRun(p, currentRun));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the worker writes its worker-<n>.md only in the current run dir; ${outside.join(", ")} is not that.`, paths };
    }
  }
  if (role("reviewer") || role("reviewer-2")) {
    const outside = paths.filter((p) => !isReviewFile(p) || !inCurrentRun(p, currentRun));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the reviewer writes only its own review-<n>.md in the run dir; ${outside.join(", ")} is not that. Report findings, do not fix.`, paths };
    }
  }
  return { deny: false };
}

export const verbs = {
  fence(ctx) {
    let currentRun = null;
    let ledger = null;
    try {
      const current = currentLedger(ctx.stateDir, ctx.session);
      if (current) {
        currentRun = path.relative(ctx.root, current.dir).split(path.sep).join("/");
        ledger = current.ledger;
      }
    } catch {
      // unreadable state: fall back to the role rules alone
    }
    const verdict = decide(ctx.input, ctx.root, undefined, currentRun, ledger);
    if (!verdict.deny) return;
    appendEvents(ctx.stateDir, ctx.session, [
      {
        seq: nextSeq(),
        ts: new Date().toISOString(),
        session: ctx.session,
        agent: ctx.input?.agent_id ?? null,
        agentType: ctx.input?.agent_type ?? null,
        kind: "deny",
        delegate: verdict.delegate === true,
        tool: ctx.input?.tool_name ?? null,
        path: verdict.paths?.[0] ?? null,
        reason: verdict.reason,
      },
    ]);
    ctx.out({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason,
      },
    });
  },
};
