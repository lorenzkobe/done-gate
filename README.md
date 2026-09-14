# done-gate

A Claude Code plugin that makes "done" mean *evidenced*, not *asserted*.

Hooks record what actually happened during a task (file edits, commands, browser calls,
agent runs). A Stop hook refuses to let a turn end until the task's ledger holds
script-written evidence for every gate rule, or an explicit waiver quoting the user. A
report renders the ledger; the final message *is* that report.

It was built for one reason: delegating work to Claude the way a senior dev delegates to a
mid-level dev, and trusting the result the same way. No silent skips, tests derived from
the requirements rather than the code, an independent reviewer every time, and no claim
without a pointer to what proves it.

## Install

```
/plugin marketplace add lorenzkobe/done-gate
/plugin install done-gate@done-gate
```

Restart the session (hooks load at start). Then in each repo, optionally add
`.claude/gate.json` (see `gate.schema.json`) and run `/done-gate:verify-setup` once to
generate the app driver. Without a config the gate derives verify commands from
`package.json` and treats every non-ignored, non-doc file as source.

## How a task runs

```
gate open <slug> <feature|bugfix|refactor|plan>   # copies the playbook's steps into the ledger
gate note task "..." · gate note plan "..."        # before any edit (R2)
gate case add "..." --kind happy|edge|refused|boundary|idempotent|reported-surface
  → skeptic huddle (features/plans) · QA writes tests blind to the code · implement · reconcile
gate verify                                        # lint/test/build, detached, with timeouts → verify.json
  → drive the real surface via the repo's /verify driver (UI) · schema probe (schema)
gate blast add "<fact>" --rung 1-5 --proof "<ptr>"
  → reviewer writes review-<n>.md · gate huddle add/acton/resolve
gate close · gate check · gate report              # paste the report; the Stop hook finalises
```

`gate check` lists what is unmet at any time. `gate doctor` shows the resolved config.

## The rules

R1 no ledger · R2 plan/cases after first edit · R3 verify missing/red/stale · R4 UI not
driven · R5 no review or open Act-on item · R6 schema not probed · R7 no test changed ·
R8 blank rows · R9 high-risk without second review · R10 repo checks · R11 unlabelled or
unresolvable claim · R12 waiver the user never said · R13 gate.json changed mid-task.

## Guarantees and their limits

- **Cannot end a turn with a gap**: the Stop hook blocks with the unmet list. After six
  identical blocks it lets go and stamps `GATE OVERRIDDEN` on the report so the failure is
  loud, never silent.
- **Cannot forge evidence**: a PreToolUse fence denies writes to the ledger's evidence
  files and counts attempts in the report. Helper agents are fenced to their own paths.
- **Cannot invent a waiver**: the quoted words must appear in a user message of the
  transcript.
- **Fails open, loudly**: a bug in the gate itself exits 0 and stamps `GATE ERROR`. A
  hook that could wedge every session would be worse than one missed task.
- **What it cannot do**: know that a test asserts the right thing, or that a blast-radius
  fact is true. It makes those visible (case → test mapping, rung per fact, reviewer's own
  file) so a human can check them in two minutes.

## Models

Helpers never run on Fable. `models.json`: skeptic Sonnet, QA Opus, reviewer Sonnet,
second reviewer Opus (high-risk paths only).

## Develop

`npm test` runs the plugin's own suite (`node --test`). `npm run reinstall` refreshes the
user-scope install from this working tree (hooks reload on the next session).
