---
name: gate
description: The done-gate workflow. Use before any task that will change source files (feature, bug fix, refactor, plan). Opens a ledger, copies a playbook's steps in, and works through them so the Stop hook's evidence rules pass. Pure questions and read-only investigations do not need it.
---

# done-gate: evidenced done

`gate` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Every mutating verb ends with a
`next:` line naming the next step and its exact verb: follow it. `gate check` lists what is
still unmet at any time.

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
| R11 | a claim without `[measured] (ptr)` / `[inferred]` / `[guess]`, or a pointer that does not resolve |
| R12 | a waiver quotes words the user never said |
| R13 | `.claude/gate.json` or the plugin's `models.json` changed mid-task |
| R14 | the task outgrew its predicted size and a step that size requires is blank again |

## The loop

1. `gate open <slug> <feature|bugfix|refactor|plan>`.
2. Before any edit: `gate note task "<the ask, quoted, then your words>"`,
   `gate note plan "<approach>" --files a.ts,b.ts` (the files predict the size; one plain
   file is small and a feature then skips the skeptic and the QA reconcile round), then
   `gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface>`
   per row. R2 checks the order.
3. Follow each `next:` line. Helpers are spawned from packets: `gate brief <role>` prints a
   one-sentence prompt; put nothing else in it. Roles: `done-gate:skeptic` (design huddle),
   `done-gate:qa` (writes tests blind to your code, under the tests globs only; reconcile
   at most two rounds), `done-gate:reviewer` (writes `review-<n>.md`; at most two rounds,
   the second on Opus when the size or the first round calls for it), `done-gate:reviewer-2`
   (high-risk paths). `gate size` shows the size and the helpers it
   requires from `models.json`; never pick helper models yourself. Ceiling: six helper
   invocations per task.
4. `gate verify` after your last edit; only verify.json counts. Drive the real surface
   yourself when UI changed (R4); probe the real schema when schema changed (R6).
5. `gate note attention "<what the user should see first>"`, `gate close`, `gate check`,
   then paste `gate report --brief` as your final message with at most two lines of your own
   before it, in the same plain words: say "the reviewer", "the tests", "the checks"; never
   "ledger", "huddle", "blast radius", "rung" or a rule number.

## Rules that hold throughout

- If two readings of the ask lead to different work, stop and ask with `AskUserQuestion`
  before step 2. The user prefers a question to a fix that still misbehaves.
- Every claim you write carries `[measured] (pointer)`, `[inferred]` or `[guess]`.
- A helper's self-report is never evidence; only `gate verify`, hook events and the
  helper's own file count.
- Waivers are the only way past a keyed step you cannot do: ask, then
  `gate waive <key> "<their exact words>"`.
- Never hand-edit `.claude/gate/runs/**` except `ledger.md`; the rest is fenced.
- Need the user mid-task? `AskUserQuestion`, or end with a final line `PAUSED: <need>`.
- No commits unless asked; the repo's CLAUDE.md wins over any playbook step.
- Blast rungs: 1 said so, 2 pointed at the line, 3 walked the failure, 4 ran code that
  fails loud, 5 reproduced in the app. Below 4 prints unproven, which is honest.
