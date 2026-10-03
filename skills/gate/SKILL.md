---
name: gate
description: The done-gate workflow. Use before any task that changes source files: opens a ledger and works its playbook's steps so the Stop hook's evidence rules pass. Questions and read-only work need nothing.
---

# done-gate

`gate` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Every verb prints a `next:`
line: follow it. `gate check` lists what is unmet (R1-R10, R13, R15, R16). You are the lead: plan, size, delegate, report; below large, edit.

## The loop

1. `gate open <slug> <feature|bugfix|refactor|plan>`.
2. Before any edit: `gate note task "<the ask, quoted, then your words>"`; understand
   first: trace, then `gate note context "Traced: <file:line pointers> Related:
   <what depends on it> Research: <what you looked up, or none needed: why>"`;
   `gate note plan "<approach>" --files a.ts,b.ts [--size large]` (the files predict the
   size; one plain file is tiny, no skeptic or reviewer), then
   `gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface|performance|click>`
   per row, in that order (R2). The plan names the hot paths, their data sizes and cost
   shape (one pass, one query) or says "no hot path"; a `performance` row names the size
   that matters and what must not happen there; a `click` row per new link, button
   or tab, closed by a real click after the last edit (`gate case close C<n> --click`).
3. Tests first, from the case table, red before green: spawn the
   skeptic and write the tests in the same turn; fold its findings into the case table.
   `gate brief <role>` prints each helper's prompt:
   `done-gate:skeptic` (`skeptic-<n>.md`), `done-gate:qa` (blind tests, large only),
   `done-gate:worker` (edits its packet's files, answers reviews in `worker-<n>.md`),
   `done-gate:reviewer` (`review-<n>.md`), `done-gate:reviewer-2` (high-risk, `review2-<n>.md`),
   `done-gate:arbiter`.
4. Tiny, small, standard: implement yourself. No slop: no comment that restates code,
   narrates, numbers steps, labels a block, echoes a signature or marks an end; no banner;
   no hedging name (helper); no guard with no case behind it; no docstring on a
   trivial function; no TODO without a task, console.log or commented-out code; no emoji.
   Why, in one line, two at most; keep workaround notes. Large: never edit source;
   `gate brief worker` per piece, spawn `done-gate:worker`.
5. Review: `gate brief reviewer` (`--files a,b` per piece past the 400-line cap), spawn, `gate huddle add reviewer --file review-<n>.md`; high-risk: brief
   reviewer-2 too and spawn both at once; `gate verify` may run in the background.
   Below large: fix and `gate huddle resolve H<k>.<i> --evidence <ptr>`. Large: `gate brief
   worker`, SendMessage the worker its packet, then `gate huddle reply --file
   worker-<n>.md`. Same reviewer until a round is clean, three rounds at most; still disputed: `gate brief arbiter --item H<k>.<i>`, `done-gate:arbiter`. Disagree:
   `gate huddle dispute H<k>.<i> "<why>" --evidence <ptr>`, one round.
6. `gate verify` after the last edit, Bash timeout 600000 ms. Drive the real UI if it
   changed (R4); probe the real schema likewise (R6).
7. Not everything shown? `gate note caveat "<what>"`. `gate close`, then paste `gate report --brief` as your final message, at most two plain
   lines before it; never "ledger", "huddle" or a rule number.

## Rules throughout

- Two readings of the ask: `AskUserQuestion` before step 2.
- A helper that stops with its file unfinished: `gate brief <role>` again; a fresh
  helper continues from the file.
- Waiting for a helper ends the turn; its hand-back wakes you. A run a dead session left open: `gate abandon <slug> "<reason>"`.
- Ceiling: ten helpers per task.
- A step you cannot do: ask the user, then `gate waive <key> "<why>"`.
- Never hand-edit `.claude/gate/runs/**` except `ledger.md`. No commits unless asked; the
  repo's CLAUDE.md wins.
