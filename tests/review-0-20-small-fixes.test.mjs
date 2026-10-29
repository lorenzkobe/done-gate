import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { makeRepo, gate, lookedUp, pluginRoot, write } from "./helpers.mjs";
import { snapshot } from "../scripts/lib/tree.mjs";
import { decide } from "../scripts/lib/guard.mjs";
import { eventsFromHookInput } from "../scripts/lib/events.mjs";
import { loadLedger } from "../scripts/lib/ledger.mjs";
import { loadSession } from "../scripts/lib/session-state.mjs";

// Three bugs from the 0.20.0 review: a git-listed folder crashed the snapshot (3.4), inline
// interpreter code that writes nothing could not close a --ran step (3.5), and a helper's shell
// edit of its own findings file was refused as an evidence write (3.6).

const RUN = ".claude/gate/runs/2026-10-29-t";
const env = (repo) => ({ ...process.env, CLAUDE_PROJECT_DIR: repo, DONE_GATE_SESSION: "S1" });
const cli = (repo, ...args) => spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", env: env(repo) });
const bash = (command, agent_type = null, agent_id = "A1") => ({ tool_name: "Bash", tool_input: { command }, ...(agent_type ? { agent_type, agent_id } : {}) });
const posted = (repo, command, agent_type = null) => ({ session_id: "S1", cwd: repo, hook_event_name: "PostToolUse", ...bash(command, agent_type), tool_response: {} });

function runRepo(name, files = {}) {
  const repo = makeRepo(name, files);
  mkdirSync(path.join(repo, RUN), { recursive: true });
  return repo;
}
const denied = (repo, command, agent_type) => decide(bash(command, agent_type), repo, null, RUN, null, {}).deny;

test("C1 reported-surface: a gitlink and a symlinked folder in the index snapshot without throwing, and only regular files are kept", () => {
  const repo = makeRepo("rsf-c1");
  mkdirSync(path.join(repo, "sub"));
  mkdirSync(path.join(repo, "real"));
  write(repo, "real/inside.txt", "x\n");
  symlinkSync("real", path.join(repo, "linkdir"));
  execFileSync("git", ["add", "src/a.ts", "linkdir", "real/inside.txt"], { cwd: repo });
  const blob = execFileSync("git", ["hash-object", "-w", "src/a.ts"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${blob},sub`], { cwd: repo });
  const files = snapshot(repo).files;
  assert.equal(files.sub, undefined);
  assert.equal(files.linkdir, undefined);
  assert.ok(files["src/a.ts"]?.h);
  assert.ok(files["real/inside.txt"]?.h);
});

test("C2 edge: a symlink to a regular file is still hashed", () => {
  const repo = makeRepo("rsf-c2");
  symlinkSync("src/a.ts", path.join(repo, "alias.ts"));
  execFileSync("git", ["add", "alias.ts"], { cwd: repo });
  const files = snapshot(repo).files;
  assert.equal(files["alias.ts"]?.h, files["src/a.ts"].h);
});

test("C3 reported-surface: node -e and python -c that write nothing stay readOnly, are tagged as runs, and close a repro step with --ran", () => {
  for (const command of ['node -e "console.log(require(\'tailwind-merge\').twMerge(\'h-10\', \'h-8\'))"', 'python3 -c "print(1 + 1)"', "node - <<'EOF'\nconsole.log(1)\nEOF"]) {
    const [e] = eventsFromHookInput(posted("/repo", command), "/repo");
    assert.equal(e.readOnly, true, command);
    assert.equal(e.runs, true, command);
  }
  const repo = makeRepo("rsf-c3");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  assert.equal(cli(repo, "open", "t", "bugfix").status, 0);
  lookedUp(repo);
  spawnSync(process.execPath, [gate, "log"], { input: JSON.stringify(posted(repo, `node -e "console.log(twMerge('h-10 text-base','h-8 text-sm'))"`)), env: env(repo) });
  const r = cli(repo, "step", "repro", "done", "twMerge drops text-base (src/a.ts:1)", "--ran", "twMerge");
  assert.equal(r.status, 0, r.stderr);
  const dir = path.join(repo, ".claude", "gate", "runs", loadSession(path.join(repo, ".claude", "gate"), "S1").current);
  assert.equal(loadLedger(dir).steps.find((s) => s.key === "repro").state, "DONE");
});

test("C4 refused: cat, grep and sh -c 'grep x' carry no runs tag", () => {
  for (const command of ["cat src/a.ts", "grep -n a src/a.ts", "sh -c 'grep -n a src/a.ts'", "node scripts/x.mjs"]) {
    const [e] = eventsFromHookInput(posted("/repo", command), "/repo");
    assert.equal(e.runs, undefined, command);
  }
});

test("C5 reported-surface: reviewer-2's sed -i, cat > heredoc, printf >> and python heredoc on its own review2-<n>.md are allowed and logged as its edits", () => {
  const repo = runRepo("rsf-c5");
  const own = `${repo}/${RUN}/review2-1.md`;
  const commands = [
    `sed -i '' 's/High/Medium/' ${own}`,
    `cat > ${own} <<'EOF'\n# review\nEOF`,
    `printf '%s\\n' '- more' >> ${own}`,
    `python3 - <<'EOF'\np = '${own}'\ns = open(p).read()\nopen(p, 'w').write(s.replace('a', 'b'))\nEOF`,
  ];
  for (const command of commands) {
    assert.equal(denied(repo, command, "done-gate:reviewer-2"), false, command);
    const evs = eventsFromHookInput(posted(repo, command, "done-gate:reviewer-2"), repo);
    const edit = evs.find((e) => e.kind === "edit");
    assert.equal(edit?.path, `${RUN}/review2-1.md`, command);
    assert.equal(edit.agent, "A1");
    assert.ok(evs.some((e) => e.kind === "command"), command);
  }
});

test("C6 happy: skeptic, arbiter, worker and reviewer shell-edit their own files", () => {
  const repo = runRepo("rsf-c6");
  for (const [role, file] of [["skeptic", "skeptic-2.md"], ["arbiter", "arbiter-1.md"], ["worker", "worker-3.md"], ["reviewer", "review-1.md"]]) {
    assert.equal(denied(repo, `sed -i '' 's/x/y/' ${repo}/${RUN}/${file}`, `done-gate:${role}`), false, role);
  }
});

test("C7 refused: a helper's shell write to another role's file, another run, evidence, or its own file plus anything else is denied", () => {
  const repo = runRepo("rsf-c7");
  const rv = "done-gate:reviewer";
  for (const command of [
    `sed -i '' s/a/b/ ${repo}/${RUN}/review2-1.md`,
    `sed -i '' s/a/b/ ${repo}/${RUN}/skeptic-1.md`,
    `sed -i '' s/a/b/ ${repo}/.claude/gate/runs/other/review-1.md`,
    `sed -i '' s/a/b/ ${repo}/${RUN}/verify.json`,
    `printf x > ${repo}/${RUN}/ledger.json`,
    // test repos sit under tests/.tmp, which is scratch: the code target is the plugin's own file
    `sed -i '' s/a/b/ ${repo}/${RUN}/review-1.md ${pluginRoot}/README.md`,
    `sed -i '' s/a/b/ ${repo}/${RUN}/review-1.md && echo x > ${repo}/${RUN}/verify.json`,
  ]) assert.equal(denied(repo, command, rv), true, command);
  // the worker's own file never covers the worker's other evidence
  assert.equal(denied(repo, `sed -i '' s/a/b/ ${repo}/${RUN}/worker-1.md ${repo}/${RUN}/review-1.md`, "done-gate:worker"), true);
});

test("C8 refused: the lead's shell write to a helper's file is still denied", () => {
  const repo = runRepo("rsf-c8");
  assert.equal(denied(repo, `sed -i '' s/a/b/ ${repo}/${RUN}/review-1.md`, null), true);
  assert.equal(eventsFromHookInput(posted(repo, `sed -i '' s/a/b/ ${repo}/${RUN}/review-1.md`), repo).some((e) => e.kind === "edit"), false);
});

test("C9 refused: an unknown target, an unfollowable cd, a computed python path or a git write alongside the own file is denied", () => {
  const repo = runRepo("rsf-c9");
  const own = `${repo}/${RUN}/review-1.md`;
  for (const command of [
    `sed -i '' s/a/b/ $OUT`,
    `cd $D && sed -i '' s/a/b/ review-1.md`,
    `python3 - <<'EOF'\nimport sys\nopen(sys.argv[0] + '.md', 'w').write('x')\nEOF`,
    `sed -i '' s/a/b/ ${own} && git add -A`,
  ]) assert.equal(denied(repo, command, "done-gate:reviewer"), true, command);
});

test("C10 boundary: a skeptic that owes its draft may create it by shell, not another skeptic file", () => {
  const repo = runRepo("rsf-c10");
  write(repo, `${RUN}/brief-skeptic-1.md`, "packet\n");
  const where = { stateDir: path.join(repo, ".claude", "gate"), session: "S1" };
  const ask = (command) => decide(bash(command, "done-gate:skeptic"), repo, null, RUN, null, where).deny;
  assert.equal(ask(`cat > ${repo}/${RUN}/skeptic-1.md <<'EOF'\n- unverified\nEOF`), false);
  assert.equal(ask(`cat > ${repo}/${RUN}/skeptic-2.md <<'EOF'\n- unverified\nEOF`), true);
  assert.equal(ask(`grep -rn a ${repo}/src`), true);
});

test("C11 idempotent: two shell writes of the own file are both allowed and each logs an edit", () => {
  const repo = runRepo("rsf-c11");
  const command = `printf '%s\\n' x >> ${repo}/${RUN}/review-1.md`;
  const edits = [1, 2].flatMap(() => {
    assert.equal(denied(repo, command, "done-gate:reviewer"), false);
    return eventsFromHookInput(posted(repo, command, "done-gate:reviewer"), repo).filter((e) => e.kind === "edit");
  });
  assert.equal(edits.length, 2);
  assert.ok(edits[1].seq > edits[0].seq);
});

test("C12 refused: a helper's own-file shell write is tagged scratch and never named as a source change's writer", async () => {
  const { writersOf } = await import("../scripts/lib/rules.mjs");
  const repo = runRepo("rsf-c12");
  const [command] = eventsFromHookInput(posted(repo, `sed -i '' s/a/b/ ${repo}/${RUN}/review-1.md`, "done-gate:reviewer"), repo);
  assert.equal(command.kind, "command");
  assert.equal(command.scratch, true);
  assert.deepEqual(writersOf([command], 0, Date.parse(command.ts)), []);
});

test("C13 edge: a failed command still logs the own-file edit, and a failed node -e repro is a run", () => {
  const repo = runRepo("rsf-c13");
  const failure = (command, agent_type = null) => ({ session_id: "S1", cwd: repo, hook_event_name: "PostToolUseFailure", ...bash(command, agent_type), tool_error: "Exit code 1" });
  const evs = eventsFromHookInput(failure(`printf x >> ${repo}/${RUN}/review2-1.md && false`, "done-gate:reviewer-2"), repo);
  assert.equal(evs.find((e) => e.kind === "edit")?.path, `${RUN}/review2-1.md`);
  const [repro] = eventsFromHookInput(failure(`node -e "process.exit(1)"`), repo);
  assert.equal(repro.exit, 1);
  assert.equal(repro.runs, true);
});
