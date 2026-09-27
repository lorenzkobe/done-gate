---
name: gate
description: The done-gate workflow. Use before any task that will change source files (feature, bug fix, refactor, plan). Opens a ledger, copies a playbook's steps in, and works through them so the Stop hook's evidence rules pass. Pure questions and read-only investigations need nothing.
---

# done-gate: evidenced done

`gate` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Every mutating verb ends with a
`next:` line: follow it. `gate check` lists what is unmet (rules R1–R10, R13, R15, R16; README
has the table). You are the lead: you plan, size, delegate, report and, below large, edit.

## The loop

1. `gate open <slug> <feature|bugfix|refactor|plan>`.
2. Before any edit: `gate note task "<the ask, quoted, then your words>"`; understand
   first: trace the code, then `gate note context "Traced: <file:line pointers> Related:
   <what depends on it> Research: <what you looked up, or none needed: why>"`;
   `gate note plan "<approach>" --files a.ts,b.ts` (the files predict the size; one plain
   file is tiny and skips the skeptic and the reviewer; the measured diff gives them back
   past 15 lines or a second file), then
   `gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface|performance>`
   per row (R2 checks the order). The plan names the hot paths, their data sizes and cost
   shape (one pass, one query) or says "no hot path"; a `performance` row names the size
   that matters and what must not happen at it.
3. Follow each `next:` line. Tests first, from the case table, red before green.
   `gate brief <role>` prints each helper's prompt. Roles:
   `done-gate:skeptic` (writes `skeptic-<n>.md`), `done-gate:qa` (blind tests, large only),
   `done-gate:worker` (edits the files its packet names, answers reviews in `worker-<n>.md`),
   `done-gate:reviewer` (writes `review-<n>.md`), `done-gate:reviewer-2` (high-risk, `review2-<n>.md`),
   `done-gate:arbiter`.
4. Tiny, small, standard: implement yourself; you hold the context. No slop: no comment
   that restates code or narrates the change, no hedging name (helper, util, data2), no guard
   or try/catch with no case behind it, no docstring on a trivial function, no leftover TODO,
   console.log or commented-out code, no emoji. Large: never edit source; `gate brief worker`
   per piece, spawn `done-gate:worker`; the fence refuses yours.
5. Review: `gate brief reviewer`, spawn, `gate huddle add reviewer --file review-<n>.md`.
   Below large: fix and `gate huddle resolve H<k>.<i> --evidence <ptr>`. Large: `gate brief
   worker`, SendMessage the worker the review path, then `gate huddle reply --file
   worker-<n>.md`. Repeat with the same reviewer
   until a round is clean, three rounds at most; still disputed: `gate brief arbiter --item H<k>.<i>`, `done-gate:arbiter`. Disagree:
   `gate huddle dispute H<k>.<i> "<why>" --evidence <ptr>`, one round.
6. `gate verify` after the last edit, Bash timeout 600000 ms (builds take minutes). Drive
   the real surface when UI changed (R4); probe the real schema when schema changed (R6).
7. `gate close`, `gate check`, then paste `gate report --brief` as your final message, at
   most two plain lines of yours before it; never "ledger", "huddle" or a rule number.

## Rules that hold throughout

- Two readings of the ask that lead to different work: `AskUserQuestion` before step 2.
- A helper's self-report is never evidence; only `gate verify`, hook events and its own
  file count. One that stops with no file: SendMessage it once, "write <file> now"; never
  brief the next round without the file.
- Waiting for a helper is a turn end; its hand-back wakes you. A run left
  open by a session that is over: `gate abandon <slug> "<reason>"`.
- Ceiling: ten helpers per task (`gate size` shows them).
- A keyed step you cannot do: ask the user, then `gate waive <key> "<reason>"`.
- Never hand-edit `.claude/gate/runs/**` except `ledger.md`. No commits unless asked; the
  repo's CLAUDE.md wins over any playbook.
- Need the user mid-task? `AskUserQuestion`, or a final line `PAUSED: <need>`.
