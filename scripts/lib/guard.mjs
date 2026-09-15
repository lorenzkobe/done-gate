import path from "node:path";
import { loadConfig } from "./config.mjs";
import { currentLedger } from "./ledger.mjs";
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

// Does a helper's shell write stay inside scratch space? Every path-looking token must be
// scratch; for cp/mv only the destination (the last path) is a write.
function shellWriteOutsideScratch(raw) {
  // quoted strings are arguments, not commands; discarding a stream is not a write
  const cmd = String(raw)
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
    .replace(/\d*>{1,2}\s*\/dev\/null/g, " ")
    .replace(/\d>&\d/g, " ");
  if (GIT_WRITE.test(cmd) || INLINE_CODE.test(cmd)) return true;
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

export function decide(input, root, config = loadConfig(root), currentRun = null) {
  const tool = input.tool_name ?? "";
  const agentType = input.agent_type ?? null;

  if (tool === "Bash") {
    const cmd = String(input.tool_input?.command ?? "");
    if (EVIDENCE_IN_COMMAND.test(cmd)) {
      return { deny: true, reason: "done-gate: that command touches gate evidence files (.claude/gate/...). Evidence is written only by `gate` verbs; read it with `gate check` or `gate report`.", paths: [] };
    }
    // Helpers write only through the edit tools, where the role rules apply; a shell write
    // would bypass them. Pattern-based, so a helper that needs to write says so instead.
    if (HELPER_ROLES.some((r) => agentType === `done-gate:${r}` || agentType === r) && shellWriteOutsideScratch(cmd)) {
      return { deny: true, reason: "done-gate: helpers write through the shell only under scratch paths (tests/.tmp, /tmp, a scratchpad), never with git write commands or inline interpreter code (node -e, python -c). Put code in a scratch script, use the Write tool for your own file, or report what should change.", paths: [] };
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
    try {
      const current = currentLedger(ctx.stateDir, ctx.session);
      if (current) currentRun = path.relative(ctx.root, current.dir).split(path.sep).join("/");
    } catch {
      // unreadable state: fall back to the role rules alone
    }
    const verdict = decide(ctx.input, ctx.root, undefined, currentRun);
    if (!verdict.deny) return;
    appendEvents(ctx.stateDir, ctx.session, [
      {
        seq: nextSeq(),
        ts: new Date().toISOString(),
        session: ctx.session,
        agent: ctx.input?.agent_id ?? null,
        agentType: ctx.input?.agent_type ?? null,
        kind: "deny",
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
