# done-gate feedback — courtly session, 2026-10-01

Two runs in one session on the courtly repo:

- `season-1-preseason-labels` (feature): it was planned as standard and measured large at the end, at 496 lines.
- `season-1-chip-hold-link` (bugfix, standard). The user found this bug after the first run had closed as done.

Most important first.

## 1. The drive step let a broken link through

The first run passed tests, three review rounds and R4. The user then found that the new
**Season 1** chip did nothing. During the seal hold it linked to the bare URL, and that URL still
showed the Pre-Season.

The drive had only *loaded* pages and read their text. It never clicked the new chip. R4 counts
that browser events exist. It does not check that each new interactive element was used.

**Proposal:** let the plan name the new or changed interactive elements (links, buttons, tabs).
R4 then requires, for each one, a browser click event followed by a change of URL or DOM. This
is the gap with the most real-world cost.

## 2. Size and review coverage are measured from HEAD, not from when the run opened

The second run started on top of the first run's uncommitted diff of about 500 lines, so:

- `gate brief reviewer` refused with "445 changed lines … cap 400", although the fix was
  about 3 lines;
- R5 demanded a clean round on `LadderBoard.tsx:8-99`, where this run only removed one import.

**Proposal:** snapshot the tree at `gate open` and measure size, pieces and R5 coverage against
that snapshot. A second option is to carry "reviewed" line coverage across runs in the same
session.

## 3. Tier escalates after the fact, and whitespace counts as work

The first run was predicted standard and only became large at `gate check`. Most of the 496
lines were the venue page shifting one indent level. By then R16 (only workers edit at large)
could only be met by a waiver. Redoing the edits through a worker would have produced the same
code.

**Proposals:**

- Measure the diff with whitespace ignored (`git diff -w`).
- Warn from the edit hook at the moment a task crosses into a delegated tier, while switching to
  a worker is still cheap.

## 4. Waiver keys are hard to find

- `gate waive worker "<reason>"` was accepted silently but did not satisfy R16. The key R16
  reads is `delegate`, which I found only by grepping `lib/rules.mjs`.
- The R16 message says "hand the piece to a worker" and never names the waiver key.

**Proposals:**

- Every unmet-rule message should name the key that waives it.
- `waive` should reject a key that no rule reads.

## 5. A case can't be corrected once written

A design change made the wording of C7 ("with no pre-season months the chip is absent") wrong.
The reviewer flagged it. Since there is no edit verb, the only option was to add C15 saying
"supersedes C7". The stale row still shows in the table.

**Proposal:** add `gate case amend C<n> "<text>"`, recorded with history, or `gate case supersede C<n>`.

## 6. One test can close several cases unchallenged

C9 ("fetch all Pre-Season months at once, never one month after another") was closed with C11's
test. That test counted calls and could not detect a serial `await`. A reviewer caught it; the
gate did not.

**Proposal:** flag a test that closes two or more cases, at least when their kinds differ (here
`performance` vs `edge`).

## 7. Full verify reruns are slow and frequent

Lint, test and build took about 3.5 minutes per run and ran six times across the two runs.
Several of those runs followed edits that touched only tests or comments.

**Proposals:**

- Allow cheap targeted runs (for example `vitest related`) while working.
- Require one full `gate verify` after the last edit, which is already the rule.
- Optionally skip `build` when the edits since the last green run are test-only.

## 8. The phone viewport is not checked

`resize_window` to 360×740 did not take effect, and the window stayed at 1280. R4 accepted a
desktop-only drive because the gate never sees the viewport.

**Proposal:** record the viewport size with each browser event, and flag a UI change that was
driven only at desktop width.

## 9. Smaller friction

- **Session id.** Every verb still needs `{"session_id": …}` piped on stdin. Without it, the hooks'
  events land under a different session and R4, R5 and R9 never clear. I used a wrapper
  script. `open` should adopt the newest live session when stdin carries none.
- **Close-step evidence.** `gate step close done` demands `--evidence`, which adds nothing for the
  close step itself.
- **Verbose `next:` line.** The long `next:` line repeats in full after every verb, roughly 1 KB
  each time, which costs tokens over a run. A short form after the first time would help.
- **Two-line limit.** Only two plain lines are allowed before the report, and that pushed real
  caveats out of the final message, such as "driven at desktop only" and "the user owes the
  phone check". The report could carry a "caveats" line itself.

## What worked well

- **Skeptic.** It found five real problems before any code existed. For example, the Pre-Season
  view key would have reached `conquestLadderFor` and read the wrong ladder, about 100× off. A
  per-view `sealed` flag would also have broken the cache TTL.
- **Reviewers.** They found that the Pre-Season months were derived from a capped sealed-season
  list, which would have emptied the view in 2027. They also found that the C9 test could not
  fail.
- **Bugfix playbook.** The order (reproduce, root cause, failing test, fix, drive) fit the
  reported bug well.
