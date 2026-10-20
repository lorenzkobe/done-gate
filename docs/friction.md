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
