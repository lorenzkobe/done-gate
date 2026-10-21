# Friction log

One entry per thing that got in the way during real work. Newest first.

Each entry: the date, the project and run, what happened in plain words, and where the
evidence is (a run folder, a session, a command and its output).

## Open

- 2026-10-19, done-gate, run version-0-19-0: a version bump (three manifests, one line each, no
  source file changed, measured tiny) still needed a reviewer, because the plan's three files
  predicted "small" and the gate reopened the review step that was marked N/A. A whole helper run
  to check that 0.18.0 became 0.19.0. Evidence: that run's ledger (predicted small, measured tiny).

- 2026-10-19, done-gate, run search-tools-ask-user: `gate verify > <scratchpad>/v.txt 2>&1; node -e '…read .claude/gate/runs/…/ledger.json…'`
  was refused as an evidence write. A `gate()` wrapper call redirected to scratch is not seen as
  scratch-only, so naming the gate folder anywhere in the same command trips the fence. Workaround:
  run them as two commands. Evidence: this session's deny event for that command.

## Ideas, no evidence yet

Not problems: nothing here is built until an Open entry from a real run points at it. Each idea
names what to look for in the run records. From the 2026-10-20 look at pstack and Matt Pocock's
skills.

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

Fixed in 0.20.0, from a look at 134 RollCall runs (2026-10-21; ~38 active hours since 10-06,
the 12 large runs ~20 of them, median 107 active minutes and 8.5 review rounds each):

- 2026-10-06 to 10-21, rollcall, most large runs: helpers queued on the one shared test
  database in `until ! pgrep pytest; do sleep 5` loops: 347 of 474 test-command minutes, 12 hit
  the 10-minute Bash timeout, and overlapping runs deadlocked on a TRUNCATE and turned flaky
  ("the packet's test command does not reproduce"). Fixed: `gate test <files>` with
  `testFiles` and `serialTests` (one run at a time, no polling); reviewers reuse a verify.json
  the gate ran on exactly their code and run only the case tests; workers and QA run their own.
- rollcall, many runs: helper packets listed only gate.json's verify commands, not the run's
  `--add`/`--drop`, so leads kept editing the shared gate.json per ticket and it went stale
  (TICKET-3568's tests in later tickets' runs). Fixed: packets list what verify runs.
- rollcall, the user: "it kept on running like a whole repo test". Fixed: `{"related": true}`
  runs the task's related tests while working, and a `"when": "final"` area suite runs once
  with `gate verify --final`; the full suite stays with CI.
- rollcall, large runs: a fixed finding sent a fresh reviewer over the whole piece again (one run
  re-read ~2,000 lines). Fixed: after a fix only the changed lines need a fix-check round, whose
  packet lists the findings to re-check.
- 2026-10-21, the owner: the faster loop needs gate.json keys each repo lacks ("if those keys
  doesn't exist ... add it before starting"). Fixed: session start asks once, before any run,
  and `gate setup` proposes the keys from the repo (its runner, or the wrapper its verify already
  uses) and writes them only on the user's words (`--apply` / `--decline`).
- 2026-10-21, release trial on rollcall's tree: `{"related": true}` picked ~175 of 774 test files
  when a module most tests import changed, plus helper files. Fixed: hub modules leave their
  tests to the final check (except the ones named after them); helpers and fixtures are skipped.
