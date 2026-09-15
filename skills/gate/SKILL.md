---
name: gate
description: The done-gate workflow. Use before any task that will change source files (feature, bug fix, refactor, plan). Opens a ledger, copies a playbook's steps in, and works through them so the Stop hook's evidence rules pass. Pure questions and read-only investigations do not need it.
---

# done-gate: evidenced done

`gate` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Every mutating verb ends with a
`next:` line naming the next step and its verb: follow it. `gate check` lists what is unmet.

## What the Stop hook enforces

| Rule | Unmet when |
| --- | --- |
| R1 | source changed and no ledger is open |
| R2 | Plan or case table written after the first source edit |
| R3 | `gate verify` missing, red, or older than the last source edit |
| R4 | UI changed and the real surface was not driven after the last edit |
| R5 | no reviewer pass after the last implementation edit, or an Act-on item open |
| R6 | schema changed and no real-schema probe recorded |
| R7 | source changed and no test file changed |
| R8 | a case, step or blast-radius row left blank |
| R9 | high-risk paths changed without the second reviewer |
| R10 | a repo check failed (CLAUDE.md budget, migration number) |
| R13 | gate.json or models.json changed mid-task |
| R14 | the task outgrew its predicted size and a step that size requires is blank again |
| R15 | a helper's file lists more findings than the ledger recorded |

## The loop

1. `gate open <slug> <feature|bugfix|refactor|plan>`.
2. Before any edit: `gate note task "<the ask, quoted, then your words>"`,
   `gate note plan "<approach>" --files a.ts,b.ts` (the files predict the size; one plain
   file is small and a feature then skips the skeptic and reconcile), then
   `gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface>`
   per row. R2 checks the order.
3. Follow each `next:` line. Helpers are spawned from packets: `gate brief <role>` prints a
   one-sentence prompt. Roles: `done-gate:skeptic` (writes
   `skeptic-<n>.md`), `done-gate:qa` (blind tests under the tests globs;
   reconcile at most twice), `done-gate:reviewer` (writes `review-<n>.md`; at most two
   rounds, the second on Opus when size or round one calls for it),
   `done-gate:reviewer-2` (high-risk paths). A finding you believe wrong:
   `gate huddle dispute H<k>.<i> "<why>" --evidence <ptr>`, one round; if the reviewer
   upholds it, `gate brief arbiter --item H<k>.<i>`, spawn `done-gate:arbiter`; it rules.
   `gate size` shows the size and the helpers it requires; never pick helper models
   yourself. Ceiling: seven helper invocations per task.
4. `gate verify` after your last edit; only verify.json counts. Drive the real surface
   yourself when UI changed (R4); probe the real schema when schema changed (R6).
5. `gate note attention "<what the user should see first>"`, `gate close`, `gate check`,
   then paste `gate report --brief` as your final message with at most two lines of your own
   before it, in the same plain words: say "the reviewer", "the tests", "the checks"; never
   "ledger", "huddle", "blast radius", "rung" or a rule number.

## Rules that hold throughout

- If two readings of the ask lead to different work, ask with `AskUserQuestion` before
  step 2.
- A helper's self-report is never evidence; only `gate verify`, hook events and the
  helper's own file count.
- Waivers are the only way past a keyed step you cannot do: ask, then
  `gate waive <key> "<the reason>"`; the report lists it.
- Never hand-edit `.claude/gate/runs/**` except `ledger.md`.
- Need the user mid-task? `AskUserQuestion`, or end with a last line `PAUSED: <need>`.
- No commits unless asked; the repo's CLAUDE.md wins over any playbook.
- Blast rungs: 1 said so, 2 pointed at the line, 3 walked the failure, 4 ran code that
  fails loud, 5 reproduced in the app. Below 4 prints unproven.
