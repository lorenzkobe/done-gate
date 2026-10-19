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

## Done (moved here when a release fixes it, with the version)
