---
name: gate
description: The done-gate workflow. Use before any task that changes source files (feature, bug fix, refactor, plan): opens a ledger and works its playbook's steps so the Stop hook's evidence rules pass. Questions and read-only investigations need nothing.
---

# done-gate

`gate` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Every mutating verb prints a
`next:` line: follow it. `gate check` lists what is unmet (R1–R10, R13, R15, R16; README has the table). You are the
lead: plan, size, delegate, report; below large, edit.

## The loop

1. `gate open <slug> <feature|bugfix|refactor|plan>`.
2. Before any edit: `gate note task "<the ask, quoted, then your words>"`; understand
   first: trace the code, then `gate note context "Traced: <file:line pointers> Related:
   <what depends on it> Research: <what you looked up, or none needed: why>"`;
   `gate note plan "<approach>" --files a.ts,b.ts [--size large]` (the files predict the
   size; one plain file is tiny, no skeptic or reviewer; past 15 lines or a second file
   the diff gives them back), then
   `gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface|performance>`
   per row (R2 checks the order). The plan names the hot paths, their data sizes and cost
   shape (one pass, one query) or says "no hot path"; a `performance` row names the size
   that matters and what must not happen there.
3. Follow each `next:` line. Tests first, from the case table, red before green: spawn the
   skeptic and write the tests in the same turn; fold its findings into the case table.
   `gate brief <role>` prints each helper's prompt. Roles:
   `done-gate:skeptic` (`skeptic-<n>.md`), `done-gate:qa` (blind tests, large only),
   `done-gate:worker` (edits the files its packet names, answers reviews in `worker-<n>.md`),
   `done-gate:reviewer` (`review-<n>.md`), `done-gate:reviewer-2` (high-risk, `review2-<n>.md`),
   `done-gate:arbiter`.
4. Tiny, small, standard: implement yourself. No slop: no comment
   that restates code or narrates the change, no hedging name (helper, util, data2), no guard or
   try/catch with no case behind it, no docstring on a trivial function, no TODO,
   console.log or commented-out code, no emoji. Large: never edit source; `gate brief worker`
   per piece, spawn `done-gate:worker`; the fence refuses yours.
5. Review: `gate brief reviewer`, spawn, `gate huddle add reviewer --file review-<n>.md`;
   high-risk paths: brief reviewer-2 too and spawn both at once; `gate verify` may run in
   the background meanwhile.
   Below large: fix and `gate huddle resolve H<k>.<i> --evidence <ptr>`. Large: `gate brief
   worker`, SendMessage the worker the review path, then `gate huddle reply --file
   worker-<n>.md`. Repeat with the same reviewer
   until a round is clean, three rounds at most; still disputed: `gate brief arbiter --item H<k>.<i>`, `done-gate:arbiter`. Disagree:
   `gate huddle dispute H<k>.<i> "<why>" --evidence <ptr>`, one round.
6. `gate verify` after the last edit, Bash timeout 600000 ms. Drive the real surface when
   UI changed (R4); probe the real schema when schema changed (R6).
7. `gate close`, `gate check`, then paste `gate report --brief` as your final message, at
   most two plain lines before it; never "ledger", "huddle" or a rule number.

## Rules throughout

- Two readings of the ask that mean different work: `AskUserQuestion` before step 2.
- A helper's self-report is never evidence; only `gate verify`, hook events and its file
  count. One that stops with no file: SendMessage it once, "write <file> now"; never
  brief the next round without the file.
- Waiting for a helper is a turn end; its hand-back wakes you. A run a dead session left
  open: `gate abandon <slug> "<reason>"`.
- Ceiling: ten helpers per task (`gate size`).
- A step you cannot do: ask the user, then `gate waive <key> "<reason>"`.
- Never hand-edit `.claude/gate/runs/**` except `ledger.md`. No commits unless asked; the
  repo's CLAUDE.md wins.
- Need the user mid-task? `AskUserQuestion`, or a final line `PAUSED: <need>`.
