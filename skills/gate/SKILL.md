---
name: gate
description: The done-gate workflow. Use before any task that changes source files: opens a ledger and works its playbook's steps so the Stop hook's evidence rules pass. Questions and read-only work need nothing.
---

# done-gate

Start each Bash command with `gate() { node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" "$@"; };`
Every verb prints a `next:` line: follow it. `gate check` lists what is unmet (R1-R10, R13, R15, R17, R18).

## The loop

1. `gate open <slug> <feature|bugfix|refactor|plan|investigation>`.
2. Before any edit: `gate note task "<the ask, quoted, then your words>"`; search code and
   memory before grep (missing: ask the user), trace, then `gate note context "Traced: … Related:
   … Research: …"`; `gate note plan "<approach>" --files a.ts,b.ts [--size large]` (the files
   predict the size; tiny: no reviewer), naming hot paths, data sizes and cost shape or "no hot
   path"; then per row (R2)
   `gate case add "<case>" --kind <happy|edge|refused|boundary|idempotent|reported-surface|performance|click>`;
   a `click` row per new link, button or tab.
3. Tests first, from the case table, red before green. Past small, code and
   tests wait for the skeptic; fold its findings into the cases. `gate brief <role>` prints the prompt of
   each `done-gate:<role>` helper: skeptic (`skeptic-<n>.md`), qa (blind tests, large), worker,
   reviewer, reviewer-2 (high-risk/large), arbiter.
4. Tiny, small, standard, large: implement yourself; independent pieces may go to workers
   (`gate brief worker`, spawn `done-gate:worker`). No slop: no comment that restates code,
   narrates, numbers steps, labels a block, echoes a signature or marks an end; no banner;
   no hedging name (helper); no guard with no case behind it; no docstring on a
   trivial function; no TODO without a task, console.log or commented-out code; no emoji.
   Why, in one line, two at most; keep workaround notes.
5. Review: `gate brief reviewer` (`--files a,b` past the 400-line cap), spawn,
   `gate huddle add reviewer --file review-<n>.md`; high-risk/large: reviewer-2 too, both
   at once. Fix and `gate huddle resolve H<k>.<i> --evidence <ptr>`. A worker's: `gate brief
   worker`, SendMessage the worker its packet, then `gate huddle reply --file worker-<n>.md`.
   Until a round is clean, three rounds + a fix-check; still disputed: `gate brief arbiter --item
   H<k>.<i>`. Disagree: `gate huddle dispute`, one round.
6. `gate verify` after the last edit, Bash timeout 600000 ms or in the background. Drive the
   real UI if it changed (R4); probe the real schema likewise (R6).
7. Not everything shown? `gate note caveat`. `gate close`, then paste
   `gate report --brief` as your final message; never "ledger", "huddle" or a rule number.

## Common sense

1. Do what was agreed, the simplest way that works.
2. If the plan has to change, say so first.
3. Answer the question you were asked before anything else.
4. If you are told to stop, stop.
5. If a rule gets in the way of doing the obvious right thing, say so. Do not work around it.
6. Do not do work nobody asked for.
7. Before a slow step, ask whether a quicker one answers the same question.

Never reshape work to fit a rule. Same failure twice: stop and work out why. Only the user
accepts a known gap. Plan so each file is edited once. When unsure, trace the code and the task
first, and ask only what they can't answer. New code: needed at all, already here, standard
library, installed dependency, one line, then the minimum; never cut validation or the ask. End
with what you skipped or did not check: `gate note caveat`.

## Rules throughout

- Two readings of the ask: `AskUserQuestion` before step 2. New ask mid-run: new run.
- A helper that stops mid-file: `gate brief <role>` again; a fresh one continues
  from it.
- At most ten helpers a task.
- A step you cannot do: ask, then `gate waive <key> "<why>" --user-ok "<words>"`.
- Never hand-edit `.claude/gate/runs/**` except `ledger.md`. No commits unless asked; the
  repo's CLAUDE.md wins.
