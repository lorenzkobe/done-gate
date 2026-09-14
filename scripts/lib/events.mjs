import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { toPosixRel } from "./paths.mjs";

// Wall-clock microseconds, strictly increasing within a process. Orders events across
// parallel hook processes by wall clock without a shared counter file (which would race).
let lastSeq = 0;
export function nextSeq() {
  const candidate = Date.now() * 1000 + Number(process.hrtime.bigint() % 1000n);
  lastSeq = Math.max(candidate, lastSeq + 1);
  return lastSeq;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TEXT_LIMIT = 200;

function base(input) {
  return {
    seq: nextSeq(),
    ts: new Date().toISOString(),
    session: input.session_id ?? null,
    agent: input.agent_id ?? null,
    agentType: input.agent_type ?? null,
  };
}

function editPaths(input, root) {
  const ti = input.tool_input ?? {};
  const raw = input.tool_name === "MultiEdit" ? (ti.edits ?? []).map((e) => e?.file_path) : [ti.file_path ?? ti.notebook_path];
  return raw.map((p) => toPosixRel(root, p)).filter((p) => p !== null && p !== "");
}

// One hook payload → zero or more event records. Never throws on odd input.
export function eventsFromHookInput(input, root) {
  if (!input || typeof input !== "object" || input.__unparseable) return [];
  const event = input.hook_event_name;
  const b = () => base(input);

  if (event === "SubagentStart") return [{ ...b(), kind: "subagent-start" }];
  if (event === "SubagentStop") return [{ ...b(), kind: "subagent-stop" }];
  if (event === "UserPromptSubmit") {
    return [{ ...b(), kind: "prompt", text: String(input.user_message ?? input.prompt ?? "").slice(0, TEXT_LIMIT) }];
  }
  if (event === "SessionStart") return [{ ...b(), kind: "session-start", source: input.session_start_source ?? null }];
  if (event !== "PostToolUse") return [];

  const tool = input.tool_name ?? "";
  if (EDIT_TOOLS.has(tool)) {
    return editPaths(input, root).map((p) => ({ ...b(), kind: "edit", tool, path: p }));
  }
  if (tool === "Bash") {
    return [{ ...b(), kind: "command", tool, cmd: String(input.tool_input?.command ?? "").slice(0, TEXT_LIMIT) }];
  }
  if (tool === "Agent" || tool === "Task") {
    return [{ ...b(), kind: "agent", tool, spawned: input.tool_input?.subagent_type ?? null }];
  }
  if (tool === "Skill") {
    return [{ ...b(), kind: "skill", tool, skill: input.tool_input?.skill ?? null }];
  }
  if (tool.startsWith("mcp__claude-in-chrome__")) {
    return [{ ...b(), kind: "browser", tool }];
  }
  return [];
}

export function sessionDir(stateDir, session) {
  return path.join(stateDir, "sessions", String(session ?? "no-session"));
}

export function appendEvents(stateDir, session, events) {
  if (!events.length) return;
  const dir = sessionDir(stateDir, session);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => `${JSON.stringify(e)}\n`).join("");
  appendFileSync(path.join(dir, "events.jsonl"), lines);
}

export function readEvents(stateDir, session) {
  const file = path.join(sessionDir(stateDir, session), "events.jsonl");
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // a torn line from a crashed writer is dropped, not fatal
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export const SILENT = { continue: true, suppressOutput: true };

export const verbs = {
  log(ctx) {
    const events = eventsFromHookInput(ctx.input, ctx.root);
    appendEvents(ctx.stateDir, ctx.session, events);
    ctx.out(SILENT);
  },
};
