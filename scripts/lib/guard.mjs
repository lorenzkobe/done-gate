import { loadConfig } from "./config.mjs";
import { appendEvents, nextSeq } from "./events.mjs";
import { toPosixRel } from "./paths.mjs";

// Files only the gate's own verbs may write. A model that could edit these could
// forge its evidence, so the deny is unconditional and every attempt is logged.
const EVIDENCE_FILES = new Set(["events.jsonl", "verify.json", "decisions.tsv", "ledger.json", "blocks.json", "state.json", "gate-error.log", "current-session"]);
const EVIDENCE_IN_COMMAND = /\.claude\/gate\/\S*(events\.jsonl|verify\.json|decisions\.tsv|ledger\.json|blocks\.json|state\.json|current-session)/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function targetPaths(input, root) {
  const ti = input.tool_input ?? {};
  const raw = input.tool_name === "MultiEdit" ? (ti.edits ?? []).map((e) => e?.file_path) : [ti.file_path ?? ti.notebook_path];
  return raw.map((p) => toPosixRel(root, p)).filter((p) => typeof p === "string" && p.length);
}

function isEvidence(rel) {
  if (!rel.startsWith(".claude/gate/")) return false;
  if (rel.startsWith(".claude/gate/sessions/")) return true;
  return EVIDENCE_FILES.has(rel.split("/").pop());
}

function isReviewFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/review-\d+\.md$/.test(rel);
}

export function decide(input, root, config = loadConfig(root)) {
  const tool = input.tool_name ?? "";
  const agentType = input.agent_type ?? null;

  if (tool === "Bash") {
    const cmd = String(input.tool_input?.command ?? "");
    if (EVIDENCE_IN_COMMAND.test(cmd)) {
      return { deny: true, reason: "done-gate: that command touches gate evidence files (.claude/gate/...). Evidence is written only by `gate` verbs; read it with `gate check` or `gate report`.", paths: [] };
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
    return { deny: true, reason: "done-gate: the skeptic is read-only; return findings in your reply.", paths };
  }
  if (role("qa")) {
    const outside = paths.filter((p) => !config.isTest(p));
    if (outside.length) {
      return { deny: true, reason: `done-gate: QA may write only under the tests globs; ${outside.join(", ")} is outside them. Report what the implementation should change instead.`, paths };
    }
  }
  if (role("reviewer") || role("reviewer-2")) {
    const outside = paths.filter((p) => !isReviewFile(p));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the reviewer writes only its own review-<n>.md in the run dir; ${outside.join(", ")} is not that. Report findings, do not fix.`, paths };
    }
  }
  return { deny: false };
}

export const verbs = {
  fence(ctx) {
    const verdict = decide(ctx.input, ctx.root);
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
