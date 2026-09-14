# smart-gate: the gate does the busywork

Date: 2026-09-14. Status: draft for user review.

## Goal

Cut the tokens done-gate costs per task without loosening a single guarantee. Four wastes
were named by the user and all four are in scope:

1. The main model hand-writes every helper brief and reasons about escalation rules.
2. Every task walks the full playbook, even a one-file change.
3. Verb output is chatty: `open`, `check`, `verify`, `report` print whole ledgers and tails.
4. Helpers re-read what the main model already read (diff, ledger, test conventions).

Not in scope: a `gate next` state machine that drives the whole loop (approach B, deferred),
any change to which evidence counts, and any change to the Stop hook's block/override policy.

## Decisions already made with the user

- A small tier may drop **only** the skeptic huddle and the QA reconcile round. QA tests,
  `gate verify` and the independent reviewer stay mandatory on every source change.
- The escalation policy moves from prose in `models.json` and the skill into a `policy`
  object the scripts read. The model never reasons about escalation again.
- The final message uses `gate report --brief`; the full report still lands in `report.md`.

## Part 1: tier policy

### Policy shape (`models.json`)

```json
{
  "roles": { "skeptic": "sonnet", "qa": "opus", "reviewer": "sonnet", "reviewer-2": "opus" },
  "policy": {
    "tiers": {
      "small":    { "maxFiles": 1,  "maxLines": 40,  "requires": ["qa", "reviewer"] },
      "standard": { "maxFiles": 10, "maxLines": 400, "requires": ["skeptic", "qa", "reviewer"] },
      "large":    {                                   "requires": ["skeptic", "qa", "reviewer", "reviewer:opus"] }
    },
    "forceStandard": ["ui", "schema", "highRisk"],
    "escalate": { "reviewerRound2": { "model": "opus", "whenActOnAtLeast": 2, "orTier": "large" } },
    "ceiling": { "helpersPerTask": 6 }
  }
}
```

`roles` keeps its meaning. The old `escalate`, `never` and `ceiling` prose keys are removed;
their content is now either policy (above) or two sentences in the skill.

### Measuring the tier

`scripts/lib/size.mjs` exports `measure(state)` returning
`{ tier, files, lines, forced: [...], reasons: [...] }`.

- `files` = changed paths that are source and not test (tests do not count toward size).
- `lines` = changed lines for those files. The baseline is a content-hash snapshot, not a
  git ref, and it stores no file content, so the count comes from two sources:
  - `snapshot()` in `tree.mjs` already reads every rehashed file; it now also stores the
    line count `l` per entry. Costs nothing extra.
  - `gate open` runs `git diff --numstat HEAD` once (when the repo is git) and stores the
    set of files that were already dirty on the ledger as `baseline.dirty`.
  - Per changed file: if the repo is git, the file is tracked, and it is not in
    `baseline.dirty`, use `git diff --numstat HEAD -- <file>` (added + deleted). Otherwise
    use `max(1, |l_now - l_baseline|)` for modified files, `l_now` for added files, and
    `l_baseline` for deleted files. The fallback undercounts edits that keep the line count,
    which can only make a task look smaller, so the forced categories and the reviewer are
    the backstop there; `gate size` prints `(line-delta estimate)` next to such files.
  This is deliberately coarse: it only has to sort tasks into three bins.
- `forced` lists which of `ui`, `schema`, `highRisk` matched any changed file. Any match
  raises the tier to at least `standard`.
- The tier is the smallest whose `maxFiles` and `maxLines` both hold, then raised by
  `forced`.

### Predicting the tier before a diff exists

`gate note plan` gains `--files <a,b,c>` (paths the plan intends to touch). The predicted
tier is computed as if each listed file changed by 0 lines, so it is `small` for one
non-forced file and `standard` otherwise. The prediction and the file list are stored on
the ledger (`ledger.tier = { predicted, predictedFiles, measured, autoNa: [...] }`).

When the predicted tier is `small`, the ledger marks steps `{skeptic}` and `{reconcile}`
`N/A` with note `tier small (predicted)` and records their keys in `autoNa`. Bugfix and
refactor playbooks have no `{skeptic}` step, so only `{reconcile}` is affected there. The
plan playbook has no source edits and is never tiered.

Without `--files`, the prediction is `standard` and nothing is auto-N/A'd. Calling
`gate note plan --files` again overwrites the prediction and the list; if the new
prediction is no longer `small`, the steps in `autoNa` return to blank and `autoNa` empties.

### Re-measuring, and rule R14

`evaluate` stays pure. The mutation lives in `assess.mjs`: `buildState` calls `measure`,
stores it as `tier.measured`, and when the measured tier requires a helper whose step is
`N/A`, it sets that step back to blank, appends the key to `tier.reopened`, and saves the
ledger. This applies to any `N/A` on `{skeptic}` or `{reconcile}`, not only the auto ones,
so closing a step by hand with a throwaway N/A before growing the diff does not escape it.
A step that is `DONE` or `WAIVED` is never touched, so further growth after the skeptic ran
does not re-fire.

Rule **R14** is then unmet while any key in `tier.reopened` is still blank. The text names
them: `tier grew from small to standard (3 files, 112 lines): step {skeptic} reopened;
spawn the skeptic, then close it with evidence.` R8 also lists the blank step, which is
fine: R14 says why, R8 says what.

A measured tier never lowers the predicted one. A predicted tier never lowers a measured
one. The only way past a reopened step is evidence or a waiver, as today.

### `gate size`

Prints one block: measured tier and numbers, predicted tier, forced categories, required
helpers with their models, whether review round 2 must be Opus, and the auto-N/A keys.
`gate open` prints the same block after the keyed steps.

## Part 2: helper packets

### `gate brief <skeptic|qa|reviewer|reviewer-2> [--round n]`

Writes `<run dir>/brief-<role>-<n>.md` and prints two lines: the packet path and the spawn
prompt. The packet is generated only from gate state and the working tree; the model
authors none of it.

Every packet starts with the same header:

- Task and Plan sections of `ledger.md`, verbatim.
- The case table (id, case, kind, status).
- The tier block from Part 1.
- Tests globs from config, and the detected test framework: the first of `vitest`, `jest`,
  `mocha`, `ava` found in `package.json` dependencies or devDependencies, else `node:test`
  when a `test` script mentions `node --test`, else `pytest` when `pyproject.toml` or
  `pytest.ini` exists, else `unknown`.
- Paths the packet author may write to, restated from the fence rules.

Per role, the body:

| role | body | deliberately absent |
| --- | --- | --- |
| skeptic | the Plan's `--files` list; for each, line count and exported symbols (regex over `export (function|const|class|default)` and top-level `def`/`class` for Python) | any diff (none exists yet) |
| qa | the Plan's `--files` list; up to three existing test files nearest to those paths by directory distance, each truncated to 60 lines, as convention samples; for a bugfix, the `reported-surface` case marked as the first test | diff hunks, and the implementer's edits to the listed files |
| reviewer | unified diff of changed source and test files against the baseline, capped at 1500 lines with a `[truncated: N more lines, see git diff]` marker; verify.json's per-command exit lines; blast-radius rows; the review number `n` and the exact output path `review-<n>.md` | nothing |
| reviewer-2 | the reviewer body plus `review-1.md` inline | nothing |

QA blindness is a prompt-level convention, today and after this change. The fence denies
writes, not reads, and QA keeps all tools. The packet simply does not hand QA the diff; QA
could still run `git diff` itself, and the agent prompt tells it not to. The skill and the
README say exactly this rather than claiming a structural guarantee.

The diff for the reviewer is computed the same way as Part 1's line count: `git diff` for
tracked files, full content marked as added for untracked or non-git files.

### Spawn prompt

One sentence: `Read <absolute packet path> and follow your role brief.` The agent files
change to: "Your inputs are in the packet named in your prompt. Do not re-derive them
(no `git diff`, no ledger read). Read source files the packet points at when you need
context." The reviewer's `git diff` instruction is removed.

Packets live in the run dir, so the fence already denies edits by any helper. `gate report`
lists the packet files under each huddle so a human can see exactly what a helper saw.

## Part 3: output

| verb | today | after |
| --- | --- | --- |
| `open` / `attach` | run dir, playbook, all steps | run dir, tier block, keyed steps only (`gate steps` prints all) |
| `check` | run dir, changed count, unmet list | unmet list only, or `clean` |
| `verify` | one line per command plus summary | same, plus a 12-line tail for each red command |
| `report` | full report | full report to `report.md`; `--brief` prints summary line, Task, case table, verify lines, Act-on rows, Attention |
| `note`, `case`, `step`, `blast`, `huddle`, `decide`, `waive` | one line | unchanged |
| `size`, `brief`, `steps` | new | one block each |

The Stop hook's block reason is unchanged. The session-start block is unchanged (about
500 tokens). The skill drops the "Spend where it pays" section in favour of two sentences
pointing at `gate size` and the ceiling.

## Part 4: rules

- **R14** (new): a step the measured tier requires was `N/A` and has been reopened by
  `assess`, and is still blank. Text names the reopened steps and the numbers behind the
  tier.
- **R5 is unchanged.** The design conversation proposed a model check for the Opus second
  round, but the SubagentStop payload in this Claude Code version carries no model field
  (`tests/fixtures/stdin/subagent-stop.json` mirrors the real payload), so the rule would be
  dead code. Instead: the `log` verb records `input.model` on subagent events if it ever
  appears, `gate size` prints the required model for round 2, and the report's Tier block
  prints `round 2 model: opus required, recorded: <model|unrecorded>`. Advisory, honest,
  and it becomes a real check for free the day the payload carries the field.
- Nothing is relaxed. R3, R7 and R5 apply to every source change at every tier.

The report gains a `## Tier` block: predicted, measured, numbers, forced categories, auto-N/A
keys, and the helpers spawned versus required.

## Part 5: dispatcher stdin

`gate open` hung for over two minutes in this session: Claude Code's Bash tool gives the
process a stdin that is neither a TTY nor closed, and `readStdin` awaits EOF for every verb.
The dispatcher will read stdin only for hook verbs (`session-start`, `fence`, `log`,
`stop`) and when any argument is `-`. Every other verb, `doctor` included, ignores stdin.
Root resolution is unaffected: non-hook verbs are run by the model with no JSON on stdin,
so `input.cwd` was never populated for them and `CLAUDE_PROJECT_DIR` or `process.cwd()`
already decide the root. A test pins that.

## Build order

Parts 5 and 3 are independent of the rest and low risk; they ship first, each as its own
ledger. Then Part 1 (tier), then Part 2 (packets), then Part 4 (report Tier block and the
model recording). Each part is one done-gate task with its own QA, verify and review.

## Files

New: `scripts/lib/size.mjs`, `scripts/lib/brief.mjs`, `tests/size.test.mjs`,
`tests/brief.test.mjs`, `tests/rules3.test.mjs`.

Changed: `scripts/gate.mjs` (stdin, new verbs), `scripts/lib/{assess,rules,report,verify,
check,ledger,verbs,events}.mjs`, `models.json`, `agents/{skeptic,qa,reviewer,reviewer-2}.md`,
`skills/gate/SKILL.md`, `skills/gate/playbooks/{feature,bugfix,refactor}.md` (reconcile
step text mentions the tier), `README.md`, `tests/{report,verbs,smoke,events}.test.mjs`.

## Tests

- `size.test.mjs`: each threshold edge (1 file/40 lines is small, 41 lines is standard,
  11 files is large); each forced category raises small to standard; prediction from
  `--files`, and a second `--files` call that revises it; a file dirty at open is measured
  by line delta, not by `git diff HEAD`; non-git repos use line delta; growth from small to
  standard reopens `{skeptic}` and `{reconcile}` once, including a hand-written N/A; a
  `DONE` step is never reopened by further growth.
- `brief.test.mjs`: each role's packet contains every header item and its body items; the
  QA packet contains no `@@` hunk and no `+`/`-` diff line; the reviewer packet truncates
  past 1500 lines with the marker; round numbering.
- `rules3.test.mjs`: R14 fires, names the steps, clears on close or waiver; `evaluate`
  never writes (a check run leaves ledger.json byte-identical); the `log` verb records a
  model field when present and omits it when absent.
- `report.test.mjs`: `--brief` omits embedded review files and the Steps section, includes
  the Tier block. `verbs.test.mjs`: `note plan --files` stores the list and predicts.
  `smoke.test.mjs`: a non-hook verb with an open, never-closing stdin pipe exits promptly.

## Additions agreed after this spec was first committed (2026-09-14)

Decided in the same conversation, before any code changed. The implementation plan carries the
detail; this section keeps the spec and the plan in agreement.

- **Session fix, ships first.** Model-run verbs had no session id and wrote to
  `sessions/no-session/`, while the hooks read `sessions/<id>/`. The SessionStart hook now
  writes `.claude/gate/current-session`; non-hook verbs read it; the marker is a fenced
  evidence file.
- **Plain language, ten lines.** `gate report --brief` is the final message: a verdict line,
  what changed, what was tested, which checks ran, what the reviewer found, then only the
  items the user should look at, then the path to the full report. No internal names
  (ledger, huddle, blast radius, rung, rule ids) reach the user; they stay in scripts, the
  full report, the skill and hook messages.
- **Next-step hint.** Every mutating verb ends with one `next:` line, so the skill shrinks
  to under 4 KB. Usage errors (bad args, empty text) no longer stamp GATE ERROR; only real
  failures do.
- **Skeptic writes a file** (`skeptic-<n>.md`, fenced like the reviewer's) and replies with
  only its Act-on list. Every helper is told to write its file two turns before its cap.
- **Verify `when`.** A verify command may declare `when: "source"` (default for `build`);
  it is skipped, and recorded as skipped, when only tests or docs changed. One end-to-end
  test walks a whole session through the hooks and the shell verbs.
- **Review completeness (R15) and dispute.** `gate huddle add --file` records every Act-on
  bullet of the file; R15 blocks when the file lists more than the ledger has. A finding
  can be disputed once, with evidence; the reviewer answers `withdrawn` or `upheld` in its
  next file; an upheld dispute goes to a fresh arbiter agent (Opus) that rules once in
  writing for one side, defaulting to the reviewer when neither side's evidence holds. Both
  outcomes are shown to the user, who can overrule. Helper ceiling becomes seven.

## Open questions for the user

None. Every decision above was confirmed in the design conversation.
