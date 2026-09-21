---
name: gate
description: The done-gate workflow. Use before any task that will change source files (feature, bug fix, refactor, plan). Opens a ledger, copies a playbook's steps in, and works through them so the Stop hook's evidence rules pass. Pure questions and read-only investigations do not need it.
---

# done-gate: evidenced done

`gate` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Every mutating verb ends with a
`next:` line naming the next step and its verb: follow it. `gate check` lists what is unmet
(rules R1–R10, R13, R15, R16; the README has the table). You are the lead: you plan, size,
delegate and report; below large you also edit.

## The loop

1. `gate open <slug> <feature|bugfix|refactor|plan>`.
2. Before any edit: `gate note task "<the ask, quoted, then your words>"`; understand
   first: trace the code, then `gate note context "Traced: <file:line pointers> Related:
   <what depends on it> Research: <what you looked up, or none needed: why>"`;
   `gate note plan "<approach>" --files a.ts,b.ts` (the files predict the size; one plain
   file is small and a feature then skips the skeptic), then
   `gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface|performance>`
   per row. R2 checks the order. The plan names the hot paths, their data sizes and the
   cost shape (one pass, one query) or says "no hot path"; a `performance` row names the
   size that matters and what must not happen at it.
3. Follow each `next:` line. Tests first, from the case table, red before green.
   Helpers are spawned from packets: `gate brief <role>` prints the prompt. Roles:
   `done-gate:skeptic` (writes `skeptic-<n>.md`), `done-gate:qa` (blind tests, size large
   only), `done-gate:worker` (edits the files its packet names, answers reviews in
   `worker-<n>.md`), `done-gate:reviewer` (writes `review-<n>.md`), `done-gate:reviewer-2`
   (high-risk paths), `done-gate:arbiter`.
4. Size small or standard: implement yourself; you hold the context. Size large: never
   edit source; `gate brief worker` per piece and spawn `done-gate:worker`; the fence
   refuses your own edits.
5. Review: `gate brief reviewer`, spawn, `gate huddle add reviewer --file review-<n>.md`.
   Below large: fix and `gate huddle resolve H<k>.<i> --evidence <ptr>`. Large: `gate brief
   worker`, SendMessage the worker the review path, then `gate huddle reply --file
   worker-<n>.md` (fixed: closes, disagree: disputes). Repeat with the same reviewer
   (SendMessage it the next packet), at most three rounds; what is still disputed then goes
   to `gate brief arbiter --item H<k>.<i>` and `done-gate:arbiter`. Disagree:
   `gate huddle dispute H<k>.<i> "<why>" --evidence <ptr>`, one round.
6. `gate verify` after the last edit, Bash timeout 600000 ms (builds take minutes). Drive the real surface
   yourself when UI changed (R4); probe the real schema when schema changed (R6).
7. `gate close`, `gate check`, then paste `gate report --brief` as your final message with
   at most two plain lines of your own before it; never "ledger", "huddle" or a rule number.

## Rules that hold throughout

- Two readings of the ask that lead to different work: `AskUserQuestion` before step 2.
- A helper's self-report is never evidence; only `gate verify`, hook events and its own
  file count. A helper that stops with no file: SendMessage it once, "write <file> now";
  never brief the next round without the file.
- Waiting for a helper (or any agent you spawned) is a legal turn end: just end the turn; its
  hand-back wakes you. A run left open by an earlier session that is over: `gate abandon
  <slug> "<reason>"`.
- Ceiling: ten helper invocations per task (`gate size` shows the size and its helpers).
- A keyed step you cannot do: ask the user, then
  `gate waive <key> "<the reason>"`; the report lists it.
- Never hand-edit `.claude/gate/runs/**` except `ledger.md`.
- Need the user mid-task? `AskUserQuestion`, or a last line `PAUSED: <need>`.
- No commits unless asked; the repo's CLAUDE.md wins over any playbook.
