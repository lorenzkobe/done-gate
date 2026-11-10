# Friction log

One entry per thing that got in the way during real work. Newest first.

Each entry: the date, the project and run, what happened in plain words, and where the
evidence is (a run folder, a session, a command and its output).

## Open

Failed commands missing from headless trials, 2026-11-10 (re-trial 3 of the courtly discount task,
claude 2.1.321, `claude -p` with `--plugin-dir` this branch and `--permission-mode auto`; seen in
re-trial 2 too). The session transcript has 4 Bash results that are errors starting `Exit code 1`,
two of them red test runs, yet the gate's events.jsonl for that session holds 105 commands and none
with an exit other than 0. So the red-before-green runs reached the gate only when piped through
`grep`, whose exit is the pipe's, and the gate read the test counts from the output instead. The
hook is wired (`PostToolUseFailure` for `Bash` in hooks/hooks.json) and `events.mjs` reads
`Exit code <n>`; why nothing was logged is not checked. Seen only headless, not yet in real work.
First step when it is picked up: one `claude -p` call that runs `false`, and read whether the hook
fired.

To check when they first appear in a real run (0.22.0, decided 2026-11-09): the zero-test wording
of jest, pytest and cargo (`ranNoTests` in scripts/lib/verify.mjs is from memory, not from their
output), and the fields of Claude Code's StopFailure payload (`turn-failed` in
scripts/lib/events.mjs reads `error`, `error_details` and `last_assistant_message`, from the plan
notes). The first run that shows either: compare, and fix the pattern if it differs.

Helper tool check, 2026-11-09 (claude 2.1.319, a throwaway repo, this branch with `--plugin-dir`,
`--model claude-haiku-5-5`, $0.09). A `done-gate:worker` and a `done-gate:reviewer` were each told
to start an agent. Neither had an Agent or Task tool, and `ToolSearch select:Agent,Task` found none,
so `disallowedTools` in the plugin's agent frontmatter holds. Both still had SendMessage, ListAgents
and TaskStop among their deferred tools.

Sandbox trial, batch 3.11, 2026-11-08 (claude 2.1.319, macOS, a throwaway git repo, the plugin from
this branch with `--plugin-dir`, `--model claude-haiku-5-5`, 5 turns). Can a sandbox keep evidence out
of the shell's reach? It blocks the agent's writes and the gate's verbs alike; hooks still write.

Settings: `{ "sandbox": { "enabled": true, "allowUnsandboxedCommands": false, "filesystem": { "denyWrite": ["<repo>/.claude/gate"] } } }`
Command: `claude -p "<prompt>" --plugin-dir <plugin> --setting-sources project,local --model claude-haiku-5-5 --permission-mode dontAsk --allowedTools Bash`

| Through the Bash tool | What happened |
| --- | --- |
| `node <plugin>/scripts/gate.mjs open trial investigation` | blocked by the sandbox: `EPERM: operation not permitted, mkdir '<repo>/.claude/gate/runs/2026-11-07-trial'`, exit 1, no run opened |
| `touch .claude/gate/shell-forged.txt` | refused by the fence before it ran; no file |
| `python3 -c` writing a base64-hidden path into the gate folder | passed the fence, blocked by the sandbox: `PermissionError: [Errno 1] Operation not permitted`, exit 1, no file |

Hooks run outside the sandbox and wrote through it: `current-session`, `pids/*`, `sessions/<id>/state.json`
and `sessions/<id>/events.jsonl`, whose events held the prompt, 2 command starts, 2 commands and 2 denies.
That matches the docs: "command hooks ... run with your full access"
([sandboxing](https://code.claude.com/docs/en/sandboxing.md)).

So with this setting the gate cannot run at all: `gate` verbs go through the same shell the sandbox
limits. It does stop what the fence misses, the base64 path. Not run: an `allowWrite` carve-out for
verbs, which would hand the same folder back to the shell. Nothing changes in this release: the
wording stays tamper-evident. A real fix gets its own design: since hooks can write where the shell
cannot, verbs would have to reach the evidence through a hook rather than the shell.

From reading the run records on two laptops, 2026-11-05 to 11-06: 243 runs in a work repo, and
courtly's 115 runs closed since 10-20. The numbers come from each repo's `.claude/gate/runs/`,
`.claude/gate/sessions/` and session transcripts, and `gate stats` will print them once it exists.
"Change n" is the number in the next version's plan.

- Change 1, both repos: code did not wait for the plan check. Tests were written during it in 19
  of 43 runs and code in 7 (work repo); tests in 34 of 111 and code in 13 (courtly), an undercount
  because shell edits are not seen.
- Change 2, both repos: runs ended with code outside the plan: 25 of 65 (work repo, may include
  tests), 52 of 113 (courtly, code only). Only 10 to 27% of changed code files had an edit event, so
  the check has to read the diff.
- Change 3, courtly: 28 of 115 runs used workers, 24 of them among 42 large runs, and they overlapped
  in only 6. Independent pieces wait for each other today, and only large tasks may split.
- Change 4, both repos: 3 of 273 and 3 of 304 review findings were disputed, and the arbiter never
  ran. The lead fixes what it is told, so a wrong finding goes unnoticed.
- Change 5, both repos: the median run has 12 and 11 steps. Schema was not applicable in 84 of 115
  courtly runs.
- Change 6, work repo: 46 helpers stopped at their turn limit and were nudged by hand, one was left
  dead, and 3 lost connections and 2 session limits were not told apart.
- Change 7, work repo: 4 open runs were left behind, two of them from September, and none says why
  it stopped. `gate abandon` takes any reason.
- Change 8, work repo: tests are 34% of in-run time, and a timeout does not say whether the command
  never printed, went silent or was still printing.
- Change 9, both repos: the Sonnet reviewer finds 0.2 to 0.3 per round, and the session-model second
  reviewer 0.8 to 1. In 53 courtly runs with both: 28 against 247 findings.
- Change 10, both repos: waiting for the first reviewer to close is 54% and 59% of run minutes, yet
  on courtly reviewers themselves ran for about 10%.
- Change 11, work repo: lost hand-backs left runs waiting with nothing to wake the lead.
- Change 12, work repo: git moves caused 80 of 223 waivers. Courtly had none, so this one is mostly
  about shared repos.
- Change 13, both repos: about 2 full verifies per run at about 5 minutes each, with re-runs worth up
  to 10% of in-run time. Exit 0 with no tests run counts as green today.
- Change 14, both repos: `gate waive` takes any typed reason, so the agent can approve itself. 223
  waivers in the work repo; on courtly 27 of 38 were one decision carried from run to run.
- Change 15, both repos: 26 of 32 recent refusals in the work repo and about 190 of 268 on courtly
  were harmless (a text-match sort), and `gate setup` never reached the work repo.
- Change 16, both repos: every number here had to be mined by hand with one-off scripts.
- Change 17, courtly: review deadlock. A file's last round must take all its unreviewed lines, but
  any round over the cap is refused. One run was abandoned with 489 lines left, and another needed a
  waiver at 568. Read in the code at `scripts/lib/brief.mjs:388` and `:520`.
- Change 18, courtly: a reviewer holding three packets had its shell loop refused and left no files,
  yet those rounds were recorded as clean. A second reviewer's files were then refused after
  `gate open` moved the session to a new run, and the run was abandoned.
- Change 19, courtly: 3 of 30 sampled second-reviewer findings were follow-on lines of one finding,
  recorded as separate findings (`parseFindings`). Read by hand, all from one run.
- Change 20, courtly: "workers at large" caused 23 of 38 waivers, with no speed gain seen.
- Change 21, courtly: the cheap path never applies in a UI repo. Ten UI-only runs had 1 review finding
  and 20 plan-check findings.
- Change 22, courtly: 181 of 304 review findings closed on a test, so tests were missing things that
  could be caught before review.
- Change 23, amigoes and kwenta-web: an e2e run inside `gate verify` does not count as driving the
  app, so those runs needed a waiver, and slow e2e runs on every verify cost time.
- Change 24, this repo: old docs and scripts stay after their release, and code that keeps old rules
  for open runs has no end date. The owner asked for a cleanup on 2026-11-06.
- Change 25, both laptops: run records stay on the laptop that made them, so each laptop had to be
  asked by hand for these numbers. This is the "Feedback that travels" idea below, now with evidence.
- The common sense rules, this repo's sessions: a run was split in two and 3 cases closed as moved
  just to stay under a size limit; a plan check told to prototype took 26 minutes against 2 for the
  next; the 6-minute suite ran after nearly every batch of fixes; and the Stop hook blocked a turn
  that was only waiting for the owner's answer.

From the 0.20.0 review (66 runs over a work repo, kwenta-web and courtly, 2026-10-21 to 10-29).
Details and evidence are in that review's sections. It is no longer in the tree; read it with
`git show a0273a2:docs/reviews/review-0.20.0.md` (on main), its miners beside it in `docs/reviews/mine/`.

- 2026-10-25, a work repo: 8 runs were only a rebase or a branch switch. Each was measured large
  from the commits it brought in, then waived step by step (about 65 waivers). R1 is still the
  most common block. (3.1)
- 2026-10-21 to 10-29, a work repo: `gate setup` never ran, so 0.20's test loop never applied there.
  The per-ticket verify list was dropped and re-added in 37 of 39 runs. Its test wrapper with file names
  isn't counted as a test command (5 R18 waivers). (3.3)
- 2026-10-21 to 10-29, all three repos: 28 denials were helpers editing their own findings file
  with a shell command. (3.6)
- kwenta-web, 5 runs: worker shell edits were credited to the lead (`delegate` waivers). (3.7)
- kwenta-web, 3 runs: reviewer-2 hit the 3-round cap, and the last fix lines were lead-reviewed.
  (3.8)
- All repos: `driver` was the most waived step (19). The waived runs used Playwright, couldn't
  reach localhost from Chrome, or had a surface that can't be driven at all. (3.9)

- 2026-10-19, done-gate, run search-tools-ask-user: `gate verify > <scratchpad>/v.txt 2>&1; node -e '…read .claude/gate/runs/…/ledger.json…'`
  was refused as an evidence write. A `gate()` wrapper call redirected to scratch is not seen as
  scratch-only, so naming the gate folder anywhere in the same command trips the fence. Workaround:
  run them as two commands. Evidence: this session's deny event for that command.

## Ideas, no evidence yet

Not problems: nothing here is built until an Open entry from a real run points at it. Each idea
names what to look for in the run records. From the 2026-10-20 look at pstack and Matt Pocock's
skills.

- **Import loops between the library modules.** Seen 2026-11-10 in the pre-push check of 0.22.0:
  the code index reports 36 loops in `scripts/lib` (`events.mjs:7` and `guard.mjs:8` import each
  other; `rules.mjs` → `size.mjs` → `assess.mjs` → `rules.mjs`; `slop.mjs` and `rules.mjs`), and
  `rules.mjs` is 1,758 lines. Nothing in a real run was held up by them: the suite passes and four
  trials closed clean. Look for: a change that breaks at load time on import order, or a batch
  whose review keeps finding side effects in a module it did not mean to touch.
- **Feedback that travels (build first after the freeze).** Run records stay on the laptop that
  made them (`.claude/gate/` is git-ignored), so friction from other laptops only arrives when
  someone asks for a report. Idea: at `gate close`, save a few lines of friction from the run
  (blocks, refusals, waivers, steps that were wasted); `gate feedback` bundles the last two weeks
  into one file the owner brings here. Never posted anywhere automatically. Until it exists: ask
  the Claude on each laptop for a feedback report at the end of the freeze.
- **Try it before asking.** If a command can answer a question, the lead runs it; only taste and
  product calls go to the user. Look for: the lead asked something a quick run would have
  answered.
- **Three labels for claims.** Measured, inferred, guess, instead of only "unverified". Look for: a
  report stating an inference as fact.
- **Review in two passes.** One for code quality, one for "did it do what was asked", by turning
  reviewer-2 into the second pass rather than adding a reviewer. Look for: a review passed code
  that did the wrong thing.
- **Say how to cut in the split messages.** 0.19 says "split" but not how; add: split into thin
  pieces that each work end to end, not by layer. Look for: the split refusal fired and the run
  was split by layer.

Left out: an interview until every choice is settled (more questions), glossary and decision
files (project docs, not the gate's job), issue-tracker and teaching skills (outside the gate).

## Done (moved here when a release fixes it, with the version)

Fixed in 0.21.0, moved here in 0.22.0:

- 2026-10-22 to 10-29, sibling work repos: all 5 runs opened inside a sibling repo were
  abandoned, because the session's hook events are filed under the repo the session started in.
  (3.2) Fixed: `gate open` and `gate attach` refuse there and print the
  `cd … && gate open … --repo` line that works (48b5699, 91212f3).
- 2026-10-25, a work repo: `gate open` crashed with EISDIR in `addFiles` (`tree.mjs:238`); a
  directory listed by git was read as a file. (3.4) Fixed: a git-listed folder no longer crashes
  the snapshot (04eab49).
- 2026-10-26, kwenta-web, run ios-input-zoom: a `node -e` repro was marked readOnly, so `--ran`
  couldn't close repro or rootcause and both were waived. (3.5) Fixed: inline `node -e` and
  `python -c` code counts as a run (04eab49).
- 2026-10-19, done-gate, run version-0-19-0: a version bump (three manifests, one line each, no
  source file changed, measured tiny) still needed a reviewer, because the plan's three files
  predicted "small" and the gate reopened the review step that was marked N/A. A whole helper run
  to check that 0.18.0 became 0.19.0. Evidence: that run's ledger (predicted small, measured tiny).
  Fixed: a plan naming no source file, with none changed, is sized by its measurement (325c607).

Fixed in 0.20.0, from a look at 134 runs in a work repo (2026-10-21; ~38 active hours since 10-06,
the 12 large runs ~20 of them, median 107 active minutes and 8.5 review rounds each):

- 2026-10-06 to 10-21, a work repo, most large runs: helpers queued on the one shared test
  database in `until ! pgrep pytest; do sleep 5` loops: 347 of 474 test-command minutes, 12 hit
  the 10-minute Bash timeout, and overlapping runs deadlocked on a TRUNCATE and turned flaky
  ("the packet's test command does not reproduce"). Fixed: `gate test <files>` with
  `testFiles` and `serialTests` (one run at a time, no polling); reviewers reuse a verify.json
  the gate ran on exactly their code and run only the case tests; workers and QA run their own.
- A work repo, many runs: helper packets listed only gate.json's verify commands, not the run's
  `--add`/`--drop`, so leads kept editing the shared gate.json per ticket and it went stale
  (one ticket's tests in later tickets' runs). Fixed: packets list what verify runs.
- A work repo, the user: "it kept on running like a whole repo test". Fixed: `{"related": true}`
  runs the task's related tests while working, and a `"when": "final"` area suite runs once
  with `gate verify --final`; the full suite stays with CI.
- A work repo, large runs: a fixed finding sent a fresh reviewer over the whole piece again (one run
  re-read ~2,000 lines). Fixed: after a fix only the changed lines need a fix-check round, whose
  packet lists the findings to re-check.
- 2026-10-21, the owner: the faster loop needs gate.json keys each repo lacks ("if those keys
  doesn't exist ... add it before starting"). Fixed: session start asks once, before any run,
  and `gate setup` proposes the keys from the repo (its runner, or the wrapper its verify already
  uses) and writes them only on the user's words (`--apply` / `--decline`).
- 2026-10-21, release trial on a work repo's tree: `{"related": true}` picked ~175 of 774 test files
  when a module most tests import changed, plus helper files. Fixed: hub modules leave their
  tests to the final check (except the ones named after them); helpers and fixtures are skipped.
