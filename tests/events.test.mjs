import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventsFromHookInput, readEvents, appendEvents } from "../scripts/lib/events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const stdin = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", "stdin", `${name}.json`), "utf8"));
const tmp = path.join(here, ".tmp", "events-state");

beforeEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});

function pick(e) {
  const { seq, ts, ...rest } = e;
  assert.equal(typeof seq, "number");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/);
  return rest;
}

test("Edit/Write become edit events with root-relative POSIX paths", () => {
  assert.deepEqual(pick(eventsFromHookInput(stdin("edit"), "/repo")[0]), {
    session: "S1", agent: null, agentType: null, kind: "edit", tool: "Edit", path: "src/app/page.tsx",
  });
  assert.equal(eventsFromHookInput(stdin("write"), "/repo")[0].path, "tests/x.test.ts");
});

test("MultiEdit emits one edit event per file", () => {
  const evs = eventsFromHookInput(stdin("multiedit"), "/repo");
  assert.deepEqual(evs.map((e) => e.path), ["src/a.ts", "src/b.ts"]);
  assert.ok(evs.every((e) => e.kind === "edit" && e.tool === "MultiEdit"));
});

test("Bash is attribution only: a truncated command, never a path", () => {
  const [e] = eventsFromHookInput(stdin("bash"), "/repo");
  assert.equal(e.kind, "command");
  assert.equal(e.cmd, "rtk npm run test");
  assert.equal(e.path, undefined);
});

test("Agent, Skill and Chrome tools map to agent, skill and browser kinds", () => {
  assert.deepEqual(pick(eventsFromHookInput(stdin("agent"), "/repo")[0]), {
    session: "S1", agent: null, agentType: null, kind: "agent", tool: "Agent", spawned: "done-gate:reviewer",
  });
  assert.deepEqual(pick(eventsFromHookInput(stdin("skill"), "/repo")[0]), {
    session: "S1", agent: null, agentType: null, kind: "skill", tool: "Skill", skill: "verify",
  });
  assert.deepEqual(pick(eventsFromHookInput(stdin("chrome"), "/repo")[0]), {
    session: "S1", agent: null, agentType: null, kind: "browser", tool: "mcp__claude-in-chrome__computer",
  });
});

test("an edit inside a subagent keeps the agent id and type", () => {
  const [e] = eventsFromHookInput(stdin("sub-edit"), "/repo");
  assert.equal(e.agent, "A9");
  assert.equal(e.agentType, "done-gate:qa");
  assert.equal(e.path, "tests/y.test.ts");
});

test("SubagentStart/Stop, UserPromptSubmit and SessionStart map to their kinds", () => {
  assert.equal(eventsFromHookInput(stdin("subagent-start"), "/repo")[0].kind, "subagent-start");
  const stop = eventsFromHookInput(stdin("subagent-stop"), "/repo")[0];
  assert.equal(stop.kind, "subagent-stop");
  assert.equal(stop.agentType, "done-gate:reviewer");
  const prompt = eventsFromHookInput(stdin("prompt"), "/repo")[0];
  assert.equal(prompt.kind, "prompt");
  assert.equal(prompt.text, "fix the badge on the venue card please");
  const start = eventsFromHookInput(stdin("session-start"), "/repo")[0];
  assert.equal(start.kind, "session-start");
  assert.equal(start.source, "startup");
});

test("an unrecognised payload produces no events and never throws", () => {
  assert.deepEqual(eventsFromHookInput({ __unparseable: "garbage" }, "/repo"), []);
  assert.deepEqual(eventsFromHookInput({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, "/repo"), []);
});

test("appendEvents/readEvents round-trip per session, in seq order", () => {
  const a = eventsFromHookInput(stdin("edit"), "/repo");
  const b = eventsFromHookInput(stdin("bash"), "/repo");
  appendEvents(tmp, "S1", a);
  appendEvents(tmp, "S1", b);
  appendEvents(tmp, "S2", eventsFromHookInput(stdin("write"), "/repo"));
  const s1 = readEvents(tmp, "S1");
  assert.deepEqual(s1.map((e) => e.kind), ["edit", "command"]);
  assert.ok(s1[0].seq < s1[1].seq);
  assert.equal(readEvents(tmp, "S2").length, 1);
  assert.deepEqual(readEvents(tmp, "nope"), []);
});

test("`gate log` CLI writes the line and answers the silent PostToolUse envelope", () => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "gate.mjs"), "log"], {
    input: readFileSync(path.join(here, "fixtures", "stdin", "edit.json"), "utf8"),
    encoding: "utf8",
    env: { ...process.env, DONE_GATE_STATE_DIR: tmp, CLAUDE_PROJECT_DIR: "/repo" },
  });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { continue: true, suppressOutput: true });
  const file = path.join(tmp, "sessions", "S1", "events.jsonl");
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).path, "src/app/page.tsx");
});
