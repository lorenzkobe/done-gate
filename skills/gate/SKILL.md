---
name: gate
description: The done-gate workflow. Use before any task that will change source files (feature, bug fix, refactor, plan). Opens a ledger, copies a playbook's steps in, and works through them so the Stop hook's evidence rules pass. Pure questions and read-only investigations do not need it.
---

# done-gate: evidenced done

`gate` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Every mutating verb ends with a
`next:` line naming the next step and its verb: follow it. `gate check` lists what is unmet
(rules R1–R10, R13, R15, R16; the README has the table). You are the lead: you plan, size,
delegate and report; at size small you also edit.

## The loop

1. `gate open <slug> <feature|bugfix|refactor|plan>`.
2. Before any edit: `gate note task "<the ask, quoted, then your words>"`,
   `gate note plan "<approach>" --files a.ts,b.ts` (the files predict the size; one plain
   file is small and a feature then skips the skeptic), then
   `gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface>`
   per row. R2 checks the order.
3. Follow each `next:` line. Helpers are spawned from packets: `gate brief <role>` prints
   the prompt. Roles: `done-gate:skeptic` (writes `skeptic-<n>.md`), `done-gate:qa`
   (blind tests under the tests globs), `done-gate:worker` (edits the files its packet
   names, answers reviews in `worker-<n>.md`), `done-gate:reviewer` (writes
   `review-<n>.md`), `done-gate:reviewer-2` (high-risk paths), `done-gate:arbiter`.
4. Size small: implement yourself. Size standard or large: never edit source; `gate brief
   worker` per piece and spawn `done-gate:worker`; the fence refuses your own edits.
5. Review: `gate brief reviewer`, spawn, `gate huddle add reviewer --file review-<n>.md`.
   Small: fix and `gate huddle resolve H<k>.<i> --evidence <ptr>`. Standard+: `gate brief
   worker`, SendMessage the worker the review path, then `gate huddle reply --file
   worker-<n>.md` (fixed: closes, disagree: disputes). Repeat with the same reviewer
   (SendMessage it the next packet), at most three rounds; what is still disputed then goes
   to `gate brief arbiter --item H<k>.<i>` and `done-gate:arbiter`. A finding you believe
   wrong at small: `gate huddle dispute H<k>.<i> "<why>" --evidence <ptr>`, one round.
6. `gate verify` after the last edit; only verify.json counts. Drive the real surface
   yourself when UI changed (R4); probe the real schema when schema changed (R6).
7. `gate close`, `gate check`, then paste `gate report --brief` as your final message with
   at most two lines of your own before it, in the same plain words: say "the reviewer",
   "the tests", "the checks"; never "ledger", "huddle" or a rule number.

## Rules that hold throughout

- If two readings of the ask lead to different work, ask with `AskUserQuestion` before
  step 2.
- A helper's self-report is never evidence; only `gate verify`, hook events and the
  helper's own file count. A helper that stops with no file: SendMessage it once,
  "write <file> now"; never brief the next round without the file.
- Waiting for a helper is a legal turn end: just end the turn; its hand-back wakes you.
- `gate size` shows the size and the helpers it requires; never pick helper models
  yourself. Ceiling: ten helper invocations per task.
- Waivers are the only way past a keyed step you cannot do: ask, then
  `gate waive <key> "<the reason>"`; the report lists it.
- Never hand-edit `.claude/gate/runs/**` except `ledger.md`.
- Need the user mid-task? `AskUserQuestion`, or end with a last line `PAUSED: <need>`.
- No commits unless asked; the repo's CLAUDE.md wins over any playbook.
