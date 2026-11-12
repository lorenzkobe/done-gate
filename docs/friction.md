# Friction log

One entry per thing that got in the way during real work. Newest first.

Each entry: the date, the project and run, what happened in plain words, and where the
evidence is (a run folder, a session, a command and its output).

## Open

From the run records of courtly, kwenta.cc and this repo, 2026-11-10 to 11-12 (0.22.0 and 0.22.1),
left after the fence let a gate read run beside an unrelated command:

- A helper's fix to its own findings file through a python heredoc is still refused (it is told
  Write or `sed -i`): 9 of courtly's 77 evidence refusals in those days and 1 of kwenta.cc's 17.
- A deny event keeps the first 200 characters of its command, so a replay of the recorded
  refusals through a changed fence is rough: longer commands end in an unclosed quote.
- The lead's lookup of an event number (`SEQ=$(grep … events.jsonl | tail -1 | …)`) beside a test
  run stays refused: any `$` keeps the refusal.
- Older than this change, found by its reviewer and not fixed: `cat x >& .claude/gate/runs/<run>/verify.json`
  passes the fence as a read. `redirect()` in scripts/lib/guard.mjs takes every `>&` for a stream
  copy, though `>& file` writes the file.

From this repo, run stats-input-tokens, 2026-11-11 (0.22.1, an interactive session, not headless):

- A scratch probe written as `! node --test … > /dev/null && echo …` (exit 0 when the test fails)
  was refused as proof: it is read as a test run, and a test run must itself be red.
- A read of verify.json through `xargs -I{} node -e '…readFileSync…'` was refused as an evidence
  write; the same read without xargs passed.
- `gate stats` on this repo's 122 closed runs of 30 days: Opus read 1760M tokens from cache
  against 4.4M written, and the three reviewing roles account for about 203M of it. Most of a
  run's tokens are the lead re-reading its own conversation.

Found while building 0.22.1, 2026-11-11 (this repo, runs piece-tests-in-packet and
recheck-shows-the-fix, and the 0.22.0 run records of courtly and kwenta.cc):

- A red run does not count as proof when its command is piped through `tail` or `head` (the test
  totals are cut off) or when the test file's name sits past the first 200 characters of the
  command (a `cd … && gate() {…}; …` prefix is enough). Three times a real red-then-green run could
  not close a finding, and a mutation probe in a scratch copy closed it instead.
- kwenta.cc 2026-11-11-foundation: the lead repeated its ask for the gate.json OK in 12 status
  messages over about 90 minutes before it was answered.
- Every reviewer packet still lists every case test to run, so with several pieces each reviewer
  runs the same tests (the `freshness` lines in scripts/lib/brief.mjs).
- A finding that waits for another piece's re-check is not listed for re-check if that piece gets
  no further packet (its lines excused with `gate huddle unchanged`, or its round refused at the
  cap). Not seen in a real run.
- Not built, the owner's choice on 2026-11-11 ("Skip run 3"): a split of findings into blocking
  and notes, and a gate check that a finding sits on a changed line. Measured on the 0.22.0 runs:
  32 of 629 reviewer findings pointed at a line or file the run did not change, and the ones read
  were real effects of the change. A notes section would bring back something like the Consider
  section removed on 2026-11-08 and make slop non-blocking. Look again only if runs on 0.22.1
  still loop.

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

- 2026-11-12, done-gate, run size-by-behaviour: `sed -n '/^## Plan/,/^## /p' <run>/ledger.md | sed
  '1d;$d' > <scratchpad>/plan.txt` was refused as an evidence write: a read of ledger.md piped to a
  scratch file. Same shape as the 2026-10-19 entry above.

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

Built after 0.22.1 on the owner's word, with no friction item behind it (run read-before-relying,
2026-11-12):

- The owner's rule of 2026-11-12: memory says what was discussed, the current file is checked
  every time unless it is seen unchanged ("i want that as a policy"). Nothing recorded what an
  agent opened, and Claude Code applies an Edit to a file inside the working directory that was
  never read (an Edit of a file made by a shell command was applied in the session that built
  this). Now the log hook records each file an agent opened with a hash of its content, the
  fence refuses an edit of an existing file the agent has not opened as it is now, and
  `gate note context` refuses a Traced file the lead has not. The owner chose both moments. Also
  fixed on the way: a MultiEdit that names its file once, at the top, logged no edit event at
  all. Not measured: how often the refusal fires on a real run, and what it costs. Open edges: a
  Read of a few lines counts as the file opened; a shell write is not checked and is not an own
  write; the Grep tool does not count; a read before a compaction still counts.

Fixed after 0.22.1 (run compaction-and-fresh-session, 2026-11-12):

- Sessions ran task after task in one conversation. In the transcripts since 2026-10-20 the
  median session peaked at 449k tokens in this repo (24 sessions), 545k in courtly (33) and 536k
  in kwenta.cc (7), with 6, 22 and 1 compactions; every turn reads all of it again. Now a clean
  close says to start the next task in a fresh session once the conversation holds 100k tokens
  (the owner's number), and a PreCompact hook tells the summary what a run needs kept. Not seen
  live: whether a summary Claude Code built ahead of time takes the hook's text (one auto
  compaction here was precomputed), so the session start after a compaction also points at
  `gate report`.

Fixed after 0.22.1 (run fence-read-beside, 2026-11-12):

- A read of the gate folder beside another command in one shell line was refused and told to run
  the other command alone: 28 of courtly's 77 evidence refusals from 2026-11-10 to 11-12, 8 of
  kwenta.cc's 17 and 1 of this repo's 7, the other command being vitest, eslint, tsc, `gate test`,
  `git remote -v`, `node --version` or `docker ps`. Now it runs when nothing connects the two: no
  pipe between them, no `$` outside single quotes, no function or compound command, no shell
  builtin or assignment, no `cd` into `.claude` and no `xargs`. A line refused for a `$`, a
  function, a compound command, a builtin or an assignment is told which and to run the read
  alone; a pipe, a `cd` into `.claude` and `xargs` are refused as a write. On 2026-11-06 the refusal was kept because judging
  the parts one by one had eight ways past it; each of those keeps the refusal here. The owner
  chose on 2026-11-12 to let ordinary lines through and not to hold the line against a command
  built to get past the fence. So the lead's `git stash`, `pkill` or a `git tag`, `branch`,
  `reflog` or `worktree` write beside a gate read now runs, as each does alone. Replayed through
  the new fence, the recorded commands still refused fall from 43 to 33 in courtly and from 10 to
  7 in kwenta.cc (a rough count: see Open).

Fixed after 0.22.1 (run size-by-behaviour, 2026-11-12):

- The size came from files and lines alone. courtly's payment-type-refuse closed tiny at 13 lines
  with no helper, and operator-page-width closed large at 24 files and 84 lines (amigoes'
  back-buttons at 24 files and 138), with the plan check, blind QA and both reviewers. Now the lead
  says on the plan note what the change is: `--risk "<what it touches>"` sizes it as a listed
  high-risk path (at least standard, second reviewer, no UI trial); `--mechanical "<the edit that
  repeats>"` is a lead's call that sizes it small, one reviewer who confirms the claim. The owner's
  choices, 2026-11-12: mechanical gets one reviewer, in a UI folder too (no plan check there); risky
  gets what a listed risky folder gets. A schema or high-risk file keeps the plan check under a
  mechanical call, and back-buttons, which is also high-risk, would keep both reviewers and save
  only blind QA. Not built, no run points at them yet: a reviewer raising a risk the lead did not
  state, and a statement required on every plan, so a tiny risky change the lead says nothing about
  still gets no helper. Not yet measured on a real run; no recorded run reaches the small size
  outside a UI folder.

Fixed after 0.22.1 (run calls-reviewed, 2026-11-11):

- Nobody checked a call the lead made for itself (the door 0.22 closed: leads approving their
  own skips). Now each full review packet that shows a call's file lists the call, and the
  reviewer says nothing or raises it; a call no recorded round was shown blocks (R21) until a
  light check, `gate brief reviewer --calls`: the calls and the diff of their files, no tests, no
  code review, spawned at low effort, and not counted as a review in the final message. A raised
  call is taken back with `gate call <key> --withdraw`. A `lookups` call waits for nobody: a
  light check that skipped its own search would loop. Not yet measured: how long a light check
  takes, and how often a reviewer disagrees with a call.

Fixed after 0.22.1 (run lead-call, 2026-11-11):

- The user was asked to skip checks they could not judge. The owner, 2026-11-11: "the plugin or
  the run owns the task and not me. im just there to decide on behavior, infra changes and
  stuff". Since 2026-10-20 courtly recorded 40 driver waivers, kwenta.cc 5 review waivers and
  this repo 1 for blind QA, each on a message that offered "or get the user's waiver". Now the
  lead decides the app drive, the real-schema check, the blind QA pass and a helper's missed
  search itself (`gate call <key> "<why>"`, a reason of six words naming a file, case or helper
  of the task), the messages offer that and no waiver, the review messages offer no skip, and the
  report, the final message and `gate stats` show each call as the lead's. The owner's choice:
  a bug-fix run has no call on the app drive, only `--could-not-run`. `gate waive` with the
  user's words is unchanged for a user who says it unasked. A reviewer checks each call (run calls-reviewed, above). Left as they were, with no run that points at them: the waivers of
  slop, coverage, the plan check, a bug fix's repro and root cause, and an upheld dispute, which
  still go to the user. Not yet measured on a real run.

Fixed after 0.22.1 (run review-ends-after-recheck, 2026-11-11):

- A third review pass over the fixes of the second. kwenta.cc on 2026-11-11 asked the user to
  waive it three times (components-controls for both reviewers, components-sheets, foundation):
  the lines left were fixes of the re-check's own findings, each closed on a test that went red
  then green. Read in the code: only a late round ended a file, so a re-check's fix was owed
  another round, and when it replaced a line the re-check had recorded, every line of the first
  round came back with it. Now a re-check that raised findings ends its file once each is closed;
  later lines are listed in the report. A clean re-check still holds a later edit, and a part of a
  re-check ends nothing (the part that takes the rest does). Not yet measured on a real run.

Fixed after 0.22.1 (run reviewer-correctness-brief, 2026-11-11):

- Reviewers blocked on style. Of 60 graded findings that only the first reviewer raised in
  courtly's and kwenta.cc's large runs since 2026-11-10, 20 were style, and each went through the
  fix and re-check loop. Read again from the same 127-finding list: the comment-length and
  docstring ones closed as `doc`, and 4 of 7 file-or-function-length ones were withdrawn by the
  reviewer; the stale-doc and wrong-comment ones were real. Both reviewer files now say style is
  not a finding and is left out of the file (a comment's length or wording, a weak name, a docstring,
  formatting, a TODO, a needless guard, a file's or function's length). Still blocking: a comment
  or doc that now says something false, dead code, duplication, a leftover console.log or
  commented-out code, a guard that hides a real error (the owner's call on those last three).
  The slop scan and the author's no-slop list are unchanged, so a comment past two lines or one
  that restates the code is now caught by nobody. Not yet measured on a real run.

Fixed after 0.22.1 (run failed-commands-recorded, 2026-11-11):

- No failed Bash command was ever recorded: 0 of 38836 commands in the events of courtly, kwenta.cc
  and this repo has a failing exit, while 11 failed MCP calls are there, so the hook fires. Seen
  headless on 2026-11-10 and in real work on 2026-11-11 (two red runs in a scratch copy could not
  close two reviewer findings; the same runs through `| cat` did). Cause: `scripts/lib/events.mjs`
  read the failure text from `tool_error`, the name a 2026-10-03 lookup gave; Claude Code sends it
  as `error` (hooks page, read 2026-11-11). Every red-first rule had been judged from piped output
  only. Reviewer findings in courtly and kwenta.cc since 11-10 took 957 and 332 close attempts for
  545 and 161 findings. Not yet measured on a real run with the fix.

Fixed in 0.22.1:

- 2026-11-10 and 11-11, courtly (27 closed runs on 0.22.0) and kwenta.cc: review took 6.1 and
  5.6 rounds per run for the two reviewers (2.6 and 2.2 on 0.21.0), and 182 of 358 rounds were
  re-checks or rounds on lines changed after review, each still raising about 0.9 findings; three
  runs asked for a review waiver to end it. Causes read in the packets: a re-check was handed the
  piece's whole diff (129 fix-check rounds were shown 35174 changed lines, 8881 of them new to
  that reviewer), every fix-check listed every closed finding of its role, every packet carried
  every changed test and doc (17 tests and 5 docs beside one source file in
  2026-11-11-new-screens-g6-monitoring/brief-reviewer-2-15.md), and a whole-file piece got no
  diff at all once those pushed it past 300 lines. Fixed: 5f745ed (a piece's own diff is inlined;
  a test or doc travels once per role) and 7904c0e (a re-check shows the owed lines and lists
  each finding once). Not yet measured on a real run.

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
