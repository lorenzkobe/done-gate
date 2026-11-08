import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { toPosixRel } from "./paths.mjs";
import { commandReflog } from "./tree.mjs";
// guard.mjs imports this module back: both sides only call each other inside functions
import { gitMoves, gitWrites, ownFileWrites, readsOnly, runsInline, scratchOnly } from "./guard.mjs";

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
// the user's own words are kept longer: an OK can come late in a long message
const WORDS_LIMIT = 2000;
const CHROME_PREFIX = "mcp__claude-in-chrome__";

function base(input) {
  return {
    seq: nextSeq(),
    ts: new Date().toISOString(),
    session: input.session_id ?? null,
    agent: input.agent_id ?? null,
    agentType: input.agent_type ?? null,
  };
}

function editPaths(input, root, repos) {
  const ti = input.tool_input ?? {};
  const raw = input.tool_name === "MultiEdit" ? (ti.edits ?? []).map((e) => e?.file_path) : [ti.file_path ?? ti.notebook_path];
  return raw.map((p) => toPosixRel(root, p, repos)).filter((p) => p !== null && p !== "");
}

function exitOf(response) {
  if (!response || typeof response !== "object") return null;
  if (response.interrupted === true) return 130;
  const code = response.exitCode ?? response.exit_code;
  return typeof code === "number" ? code : null;
}

// A helper's shell write to its own findings file is its edit, as a Write would be; the command
// itself then wrote nothing a source change could come from, so it is tagged like a scratch write.
// The fence let it through only into the current run, so any run dir here is that one.
function ownEdits(input, cmd, root, b) {
  if (!input.agent_id) return [];
  return ownFileWrites(cmd, input.agent_type, root).map((p) => ({ ...b(), kind: "edit", tool: "Bash", path: p }));
}

// HEAD's newest reflog entries; those above the one the fence saw at its start are this command's
const reflogField = (root) => {
  const reflog = commandReflog(root);
  return reflog.length ? { reflog } : {};
};

// The call's id, which pairs a command with the start the fence logged for it.
export const toolUse = (input) => (typeof input.tool_use_id === "string" && input.tool_use_id ? { toolUseId: input.tool_use_id } : {});

export const HANDBACK = /^\s*(?:\[SYSTEM NOTIFICATION[\s\S]*?)?<(?:agent-message|task-notification|cross-session-message)\b/;

// One hook payload → zero or more event records. Never throws on odd input.
export function eventsFromHookInput(input, root, repos = []) {
  if (!input || typeof input !== "object" || input.__unparseable) return [];
  const event = input.hook_event_name;
  const b = () => base(input);

  // the model a helper ran on, when the harness says so (advisory: nothing blocks on it)
  const model = typeof input.model === "string" && input.model ? { model: input.model } : {};
  if (event === "SubagentStart") return [{ ...b(), kind: "subagent-start", ...model }];
  if (event === "SubagentStop") return [{ ...b(), kind: "subagent-stop", ...model }];
  if (event === "UserPromptSubmit") {
    const text = String(input.user_message ?? input.prompt ?? "");
    // a helper's hand-back, the harness's task notification and a message from another session
    // arrive as prompts too; they are tagged so the Stop hook does not mistake them for a new
    // turn from the user
    const handback = HANDBACK.test(text);
    // the helper it names sits inside notice, not as the event's agent: the prompt stays the lead's
    const notice = handback ? helperNotice(text) : null;
    return [{ ...b(), kind: "prompt", text: text.slice(0, WORDS_LIMIT), ...(handback ? { handback: true } : {}), ...(notice ? { notice } : {}) }];
  }
  if (event === "SessionStart") return [{ ...b(), kind: "session-start", source: input.session_start_source ?? null }];
  const tool = input.tool_name ?? "";
  // PostToolUse fires only on success; a failed Bash call (a red test run) arrives here. Only
  // one that ran and exited non-zero counts: a denied or interrupted call ran nothing.
  if (event === "PostToolUseFailure") {
    // a failed lookup (server down, project not indexed) is still an attempt; it is never a run
    if (tool.startsWith("mcp__") && !tool.startsWith(CHROME_PREFIX)) return [{ ...b(), kind: "tool", tool, input: JSON.stringify(input.tool_input ?? {}).slice(0, TEXT_LIMIT), failed: true }];
    const code = /exit code:?\s*(\d+)/i.exec(String(input.tool_error ?? ""));
    if (tool !== "Bash" || !code) return [];
    const cmd = String(input.tool_input?.command ?? "");
    const own = ownEdits(input, cmd, root, b);
    return [{ ...b(), kind: "command", tool, cmd: cmd.slice(0, TEXT_LIMIT), exit: Number(code[1]), ...toolUse(input), ...(gitWrites(cmd) ? { git: true, commits: !gitMoves(cmd), ...reflogField(root) } : {}), ...(readsOnly(cmd) ? { readOnly: true } : {}), ...(runsInline(cmd) ? { runs: true } : {}), ...(own.length ? { scratch: true } : {}) }, ...own];
  }
  if (event !== "PostToolUse") return [];

  if (EDIT_TOOLS.has(tool)) {
    return editPaths(input, root, repos).map((p) => ({ ...b(), kind: "edit", tool, path: p }));
  }
  if (tool === "Bash") {
    // a background run reports at launch, before it can fail, so its exit is never known
    const background = input.tool_input?.run_in_background === true;
    const cmd = String(input.tool_input?.command ?? "");
    // both flags are read from the whole command, since the stored text is cut: git when this
    // run may have moved HEAD itself, readOnly when the command cannot have written source
    const git = gitWrites(cmd);
    const readOnly = readsOnly(cmd);
    const own = ownEdits(input, cmd, root, b);
    const scratch = !readOnly && (own.length > 0 || scratchOnly(cmd));
    return [{ ...b(), kind: "command", tool, cmd: cmd.slice(0, TEXT_LIMIT), exit: background ? null : exitOf(input.tool_response), ...toolUse(input), ...(background ? { background: true } : {}), ...(git ? { git: true, commits: !gitMoves(cmd), ...reflogField(root) } : {}), ...(readOnly ? { readOnly: true } : {}), ...(runsInline(cmd) ? { runs: true } : {}), ...(scratch ? { scratch: true } : {}) }, ...own];
  }
  if (tool === "Agent" || tool === "Task") {
    return [{ ...b(), kind: "agent", tool, spawned: input.tool_input?.subagent_type ?? null }];
  }
  if (tool === "Skill") {
    return [{ ...b(), kind: "skill", tool, skill: input.tool_input?.skill ?? null }];
  }
  if (tool.startsWith(CHROME_PREFIX)) {
    return [{ ...b(), kind: "browser", tool, ...browserFields(tool.slice(CHROME_PREFIX.length), input.tool_input ?? {}) }];
  }
  // the user's answer to a question counts as their words, like a message
  if (tool === "AskUserQuestion") {
    const r = input.tool_response ?? {};
    const notes = Object.values(r.annotations ?? {}).map((a) => a?.notes).filter(Boolean);
    return [{ ...b(), kind: "answer", text: [...Object.values(r.answers ?? {}), ...notes].map(String).join(" | ").slice(0, WORDS_LIMIT) }];
  }
  // a probe through another MCP server (a database, the built-in browser) or WebFetch
  if (tool.startsWith("mcp__") || tool === "WebFetch") {
    return [{ ...b(), kind: "tool", tool, input: JSON.stringify(input.tool_input ?? {}).slice(0, TEXT_LIMIT) }];
  }
  return [];
}

// What a browser call did: the computer tool's action, else the tool's short name; the
// element ref or the coordinates it aimed at; a batch keeps the same for each inner call.
function browserFields(short, ti) {
  const target = ti.ref ?? (Array.isArray(ti.coordinate) ? ti.coordinate.join(",") : null);
  return {
    action: short === "computer" && ti.action ? String(ti.action) : short,
    ...(target !== null ? { target: String(target).slice(0, TEXT_LIMIT) } : {}),
    ...(typeof ti.url === "string" ? { url: ti.url.slice(0, TEXT_LIMIT) } : {}),
    // a batch item is {name, input}; a flat {tool, ...input} item is read the same way
    ...(short === "browser_batch" && Array.isArray(ti.actions) ? { actions: ti.actions.map((a) => browserFields(String(a?.name ?? a?.tool ?? ""), a?.input ?? a ?? {})) } : {}),
  };
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

const NOTICE_START = /^\s*(?:\[SYSTEM NOTIFICATION[\s\S]*?)?<task-notification\b/;
const NOTICE_CAUSES = [
  [/stopped at its \d+-turn limit/, "turn-limit"],
  [/Can't reach the API server/, "lost-connection"],
  [/session limit/i, "session-limit"],
  [/stalled: no progress/i, "stalled"],
  [/overloaded|rate limit|server error/i, "api-problem"],
  [/\/login\b|\b(?:log in|logged in|billing|credit balance|api key)\b/i, "only-you"],
  [/was stopped by user/, "stopped-by-user"],
  [/was stopped by Claude/, "stopped-by-lead"],
  [/^finished\b/, "finished"],
  [/^is waiting\b/, "waiting"],
];

// What a helper's notice says became of it, read from the summary's tail so that a task named
// "fix billing" says nothing. A background command or another agent's words give null.
export function noticeCause(text) {
  if (typeof text !== "string" || !NOTICE_START.test(text)) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? "";
  const tail = /^Agent ".*?" ((?:stopped at|failed|finished|was stopped|is waiting).*)$/s.exec(summary)?.[1];
  if (tail === undefined) return null;
  const status = /<status>([^<]*)<\/status>/.exec(text)?.[1] ?? null;
  return { status, cause: NOTICE_CAUSES.find(([pattern]) => pattern.test(tail))?.[1] ?? "unknown" };
}

// A helper's notice with the helper it names: the task id is the id its start and stop carry.
export function helperNotice(text) {
  const found = noticeCause(text);
  if (!found) return null;
  return { agent: /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1] ?? null, ...found };
}

export const SILENT = { continue: true, suppressOutput: true };

const WRITING_TOOLS = new Set([...EDIT_TOOLS, "Bash"]);

export const verbs = {
  async log(ctx) {
    const events = eventsFromHookInput(ctx.input, ctx.root, () => ctx.repos);
    appendEvents(ctx.stateDir, ctx.session, events);
    // Right after a tool that can change files, record whether the implementation moved,
    // so the freshness clock for R4/R5 points at the tool call that made the change.
    // Subagents are skipped: their edits carry an agent event, and the next assess dates
    // the change to it; skipping keeps helper tool calls from racing the main session.
    let warning = null;
    const failedBash = ctx.input?.hook_event_name === "PostToolUseFailure" && ctx.input.tool_name === "Bash" && events.length > 0;
    if ((failedBash || (ctx.input?.hook_event_name === "PostToolUse" && WRITING_TOOLS.has(ctx.input.tool_name))) && ctx.session && !ctx.input.agent_id) {
      try {
        const { stampNow } = await import("./assess.mjs");
        warning = stampNow(ctx);
      } catch {
        // a stamp is a courtesy; the next assess dates the change itself
      }
    }
    // a cut helper's notice brings its cause and the next step with it
    const noticed = events.find((e) => e.notice?.agent)?.notice.agent;
    let told = null;
    if (noticed && ctx.session) {
      try {
        const { noticeLine } = await import("./diagnose.mjs");
        told = noticeLine(ctx, noticed);
      } catch {
        // advice only: `gate diagnose` reads the same events
      }
    }
    // additionalContext is the one hook output the model reads after a tool call or a prompt
    const context = [warning, told].filter(Boolean).join("\n");
    ctx.out(context ? { hookSpecificOutput: { hookEventName: ctx.input.hook_event_name, additionalContext: context } } : SILENT);
  },
};
