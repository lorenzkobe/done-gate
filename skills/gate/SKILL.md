---
name: gate
description: The done-gate workflow. Use before any task that will change source files (feature, bug fix, refactor, plan). Opens a ledger, copies a playbook's steps in, and works through them so the Stop hook's evidence rules pass. Pure questions and read-only investigations do not need it.
---

# done-gate: evidenced done

`gate` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Define it once per session:
`GATE='node "'"$CLAUDE_PLUGIN_ROOT"'/scripts/gate.mjs"'` — or call the full path each time.
If `CLAUDE_PLUGIN_ROOT` is not set in your shell, the plugin lives under
`~/.claude/plugins/cache/done-gate/done-gate/<version>/`.

## What the gate enforces (so you know why each step exists)

The Stop hook refuses to end a turn while any of these is unmet; `gate check` shows the
list at any time. Evidence comes from scripts, hooks and agent-written files, never from
what you or a helper say.

| Rule | Unmet when |
| --- | --- |
| R1 | source changed and no ledger is open |
| R2 | Plan or case table written after the first source edit |
| R3 | `gate verify` missing, red, or older than the last source edit |
| R4 | UI files changed and the real surface was not driven after the last edit |
| R5 | no reviewer pass after the last edit, or an Act-on item still open |
| R6 | schema files changed and no real-schema probe recorded |
| R7 | source changed and no test file changed |
| R8 | any case, step or blast-radius row left blank |
| R9 | high-risk paths changed without the second reviewer |
| R10 | a repo check failed (CLAUDE.md budget, migration number) |
| R11 | a verification claim without `[measured] (ptr)` / `[inferred]` / `[guess]`, or a pointer that does not resolve |
| R12 | a waiver quotes words the user never said |
| R13 | `.claude/gate.json` changed mid-task |

Waivers are the only way past a keyed step you cannot do: ask the user, then
`gate waive <key> "<their exact words>"`. The gate looks for those words in the transcript.

## The workflow

**0. Open.** `gate open <slug> <feature|bugfix|refactor|plan>`. It prints the playbook's
steps; they are now rows in the ledger and every one must end DONE / SKIPPED / WAIVED / N/A.
Read `gate doctor` once per repo to see the config the gate resolved.

**1. Before any edit.** `gate note task "<the user's ask, quoted, then your own words>"`,
`gate note plan "<approach, files, data/cost plan if data is touched>"` (use `-` to read a
long note from stdin), then the case table: one `gate case add "<case>" --kind <kind>` per
row. Kinds: `happy`, `edge`, `refused` (the side a gate turns away), `boundary` (empty,
null, midnight, timezone, first/last page), `idempotent` (retry, double submit), and
`reported-surface` (exactly what the user reported, when it is a bug). R2 is checked by
sequence number, so this order is not optional.

**2. Design huddle (feature, plan).** Spawn `done-gate:skeptic` (subagent_type; if the
scoped name is rejected use `skeptic`) with the ask, the Plan, the case table and the paths.
Answer each finding in the ledger (`gate huddle add skeptic --summary "<what changed>"`),
amend the Plan and cases. Close step `{skeptic}` with `--evidence` pointing at the huddle.

**3. QA in parallel.** Spawn `done-gate:qa` with the ask, the case table, the tests globs,
the repo's test conventions, and the files you will touch. It writes tests under the tests
globs only (the fence denies anything else) and must not read your new implementation.
While it works, implement. Then reconcile, at most two rounds, through `SendMessage` to the
same agent: each disagreement ends as code-wrong, test-wrong, or a question for the user.
Close each case with `gate case close C<n> --test <file:testname>` or `--na "<reason>"`.

**4. Verify.** `gate verify` after your last source edit. It runs the repo's verify
commands detached with timeouts, writes verify.json, and closes `{verify}` when green.
Red output is in the ledger; fix and run again. Never run the suite any other way for
evidence: only verify.json counts.

**5. Drive the real surface.** If UI changed, run the project's `/verify` driver skill
(phone viewport first, then desktop) through the Chrome tools; the hooks log the browser
calls. Record what you drove and saw: `gate decide driver "<feature>" "<why>" "events#<seq>"
"<result>"`. If the repo has no driver, run `/done-gate:verify-setup` once.

**6. Schema probe.** If schema files changed, hit the endpoint in dev or run the query once
against the real database, then `gate step schema done "<what you ran>" --evidence <ptr>`.

**7. Blast radius.** For each fact the change is safe because of:
`gate blast add "<fact>" --rung <1-5> --proof "<ptr>"`. Rungs: 1 you said so · 2 you
pointed at the line · 3 you walked the failure and it does not reach · 4 you ran code that
fails loud if wrong · 5 you reproduced it in the running app. Below 4 the report prints
*unproven*; that is allowed and honest.

**8. Review.** Spawn `done-gate:reviewer` with the run dir, the changed files, the
requirements and the review number `n`; it writes `review-<n>.md` there. Record it:
`gate huddle add reviewer --file review-<n>.md`, one `gate huddle acton H<k> "<finding>"`
per Act-on item, fix each, then `gate huddle resolve H<k>.<i> --evidence <ptr>`. At most
two rounds with the same agent via `SendMessage`. High-risk paths also need
`done-gate:reviewer-2` (`--file review-<n+1>.md`).

**9. Close.** Close remaining steps (`gate step <key|n> done "<note>" --evidence <ptr>`,
`skipped "<reason>"`, `na "<reason>"`), fill `gate note attention "<gaps the user should
see first>"`, then `gate close`, `gate check` (must be clean), `gate report`. Paste the
report verbatim as your final message, with at most five lines of your own framing before
it. The Stop hook finalises the ledger when it agrees the run is clean.

## Rules that hold throughout

- You own the diff and write your own summary. A helper's self-report is never evidence;
  the report embeds the reviewer's file, not your paraphrase of it.
- Every claim you write in ledger.md or the final message carries a label:
  `[measured] (verify.json)`, `[measured] (events#123)`, `[inferred]`, `[guess]`.
- Need the user mid-task? Use `AskUserQuestion`, or end your message with a final line
  `PAUSED: <what you need>`. Any other message with an open ledger is judged as a close.
- Never hand-edit files under `.claude/gate/runs/` except `ledger.md`; the fence denies it
  and counts the attempt in the report.
- Do not commit unless the user asks; the repo's CLAUDE.md rules win over any playbook step.
- `gate decide <phase> <decision> <why> <evidence> <result>` logs a decision row whenever you
  choose between approaches, revert, or hit a blocker.
