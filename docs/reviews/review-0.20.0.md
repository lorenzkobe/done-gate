# done-gate 0.20.0: how it did

**Date:** 2026-10-29
**Version reviewed:** 0.20.0 (commit `66ba0ab`, released 2026-10-21)
**Where it ran:** rollcall (work, Django/Python, one shared Docker Postgres for tests), kwenta-web
(personal, Vite/React + Supabase, vitest), courtly (personal, Next.js + Supabase, vitest), plus a
few runs opened in sibling work repos.
**Purpose:** data for the next version. Every item below says what the evidence is, and whether
it was checked against the source or a run.

This repo is public, so the work repo is described only in general terms: no file paths, business
rules, ticket text or names from it. The run folders it cites stay on the laptop that made them
(`<repo>/.claude/gate/runs/`, git-ignored).

---

## How this was put together

- **Run records:** every `ledger.json` under each repo's `.claude/gate/runs/` whose `version` is
  `0.20.0`: **66 runs**. rollcall 39, kwenta-web 20, courtly 2, sibling work repos 5. To compare,
  the same fields were taken from rollcall's 0.19.0 runs (15) and its 0.16.0 and 0.17.1 runs.
- **Hook events:** every `events.jsonl` under `.claude/gate/sessions/`, for 2026-10-21 15:13Z to
  2026-10-29 (0.20). For rollcall, the window 2026-10-06 to 2026-10-21 was the "before" period.
  From these come Stop blocks, guard denials, gate verbs used, helper spawns and command durations
  (the gap from `command-start` to `command`).
- **Active time:** the gaps between events inside a run's open-to-close window, each gap capped
  at 10 minutes. This is not the same method as the 2026-10-21 look (which found a median of 107
  active minutes for large runs), so compare the 0.19 and 0.20 columns here with each other, not
  with that number.
- **Source:** each bug in section 3 was checked against the 0.20.0 source at the `file:line`
  given. Anything not checked is marked **unverified**.
- **Scripts:** the miners are in `docs/reviews/mine/` (see the appendix), so the next review can
  run the same numbers.

---

## 0. Summary

0.20 did what it was built for, but only where a repo was set up for it.

- **The queue waits mostly went away.** In rollcall, minutes spent inside "wait until the other
  test run ends" loops fell from 369 to 167, and `pgrep` loops from 172 to 9. Large runs needed
  fewer review rounds (median 15 down to 9) and took less active time (median 193 down to 161
  minutes).
- **Repos that ran `gate setup` got the whole fast loop.** kwenta-web (10 large runs) used
  `gate test` and `gate verify --final` and finished large runs in a median 64 active minutes,
  with no command near the 10-minute Bash limit.
- **rollcall never got set up.** Its `.claude/gate.json` still has no `testFiles` and no
  `serialTests`. It still holds the stale per-ticket verify list and the false-green `awk` lint the
  2026-10-21 look flagged. `gate setup` was never run there (0 calls in 14 sessions), so related
  tests, the final suite and the test lock never applied. That is why its test-run minutes rose
  (226 to 409) and 11 commands still ran into the 10-minute limit.
- **Reviews kept earning their cost.** 275 Act-on items across the 66 runs, 1 left open. reviewer-2
  found the most serious ones: double charges, an authorization hole, silent overwrites of newer
  data, and a race.
- **Biggest remaining waste:** git operations still cost whole runs (8 rebase or branch-switch runs
  in one day, all waived), and in sibling repos runs can't see their own hook events (all 5
  abandoned).

---

## 1. The numbers

### 1.1 Per repo, 0.20.0

| | rollcall | kwenta-web | courtly | sibling work repos |
| --- | --- | --- | --- | --- |
| runs | 39 | 20 | 2 | 5 |
| closed / abandoned / open | 37 / 1 / 1 | 19 / 1 / 0 | 2 / 0 / 0 | 0 / 5 / 0 |
| feature / bugfix / refactor / investigation | 10 / 18 / 10 / 1 | 15 / 5 / 0 / 0 | 2 / 0 / 0 / 0 | 0 / 3 / 2 / 0 |
| measured large (real work, rebases left out) | 6 | 10 | 0 | 0 |
| large: median active minutes | 161 | 64 | – | – |
| large: median review files | 9 | 9 | – | – |
| skeptic huddles | 18 | 18 | 2 | 0 |
| Act-on items (open at close) | 109 (0) | 158 (1) | 8 (0) | 0 |
| size predicted = measured | 29 / 38 | 20 / 20 | 2 / 2 | 1 / 1 |
| Stop blocks per 100 user prompts | 6.4 | 7.6 | 9.3 | – |
| guard denials | 73 | 64 | 2 | – |
| `gate test` / `gate verify --final` calls | 1 / 0 | 8 / 15 | 0 / 3 | – |
| `gate setup` run | no | yes | yes | – |

### 1.2 rollcall before and after

| | 0.19.0 runs | 0.20.0 runs |
| --- | --- | --- |
| runs | 15 | 39 |
| abandoned | 4 of 15 | 1 of 39 (+5 in sibling repos, section 3.2) |
| real large runs: median active minutes | 193 (n=4) | 161 (n=6) |
| real large runs: median review files | 15 | 9 |

| Hook events, rollcall | 2026-10-06 to 10-21 (0.16–0.19) | 0.20 window |
| --- | --- | --- |
| sessions with events / user prompts | 34 / 730 | 14 / 484 |
| Stop blocks (per 100 prompts) | 94 (12.9) | 31 (6.4) |
| R1 "source changed, no ledger" blocks | 11 | 9 |
| guard denials (per 100 prompts) | 108 (14.8) | 73 (15.1) |
| minutes in wait loops (`until`/`while` … `pgrep`/`grep`/`sleep`) | 369 (144 loops) | 167 (43 loops) |
| loops that use `pgrep` | 172 | 9 |
| minutes in test runs (pytest / test_db.sh) | 226 | 409 |
| commands that hit the ~10-minute Bash limit | 8 | 11 |

How to read it: the waits for another run to finish mostly went away, because reviewers reuse a
fresh `verify.json` and run only the case tests. That part did not depend on setup. Test runs
themselves grew, because without `testFiles` and `{"related": true}` every verify still runs the
long per-ticket command list. Most of the 10-minute hits in 0.20 came from one long session's
large payments runs, whose test files were slow on the shared database. Some were a new polling shape: `until grep -q passed
<background output>` loops, which replaced `pgrep`.

---

## 2. What went well (keep these)

### 2.1 Reviewers found real, serious defects
Act-on items: rollcall 109 (skeptic 69, reviewer-2 34, reviewer 6); kwenta-web 158 (skeptic 91,
reviewer-2 49, reviewer 18); courtly 8. reviewer-2 again found the ones that mattered most. By
kind:

- **Money.** In rollcall: a stale date window could issue a second paid entitlement for a period
  already paid for (a double charge). Undoing a charge reopened only one of the requests it had
  closed. One bad discount value failed a whole batch call.
- **Authorization.** In rollcall: a write path recorded a privileged action with no permission
  check. In kwenta-web: after a group was deleted, its creator could still insert live bills into
  it (`group-lifecycle-server`, review2-1), and clients could future-date another member's rows.
- **Data loss and races.** In kwenta-web: a row staged by a refused (conflict) queue entry was
  re-saved with no base, so a stale edit could silently overwrite the newer server row
  (`fresh-edits-and-conflicts`, review2-1). "Show more" and a reload raced, and the loser
  overwrote the winner (`shrink-write-responses`). A 500-row clamp stranded every bill past the
  500th (`shrink-write-responses`). In rollcall: two overlapping deletes in flight together left
  shared dates off for good.
- **Crashes and wrong output.** A popup wrote to IndexedDB inside a live query and crashed
  (`cloud-first-guards-and-screens`). An export file took its money from a different payload
  than the screen showed. A totals query credited a whole bundle to one payer
  (`payment-history-paging`).
- **Flaky tests caught before merge.** A 560-row test passed alone and timed out in the full
  suite (`shrink-write-responses`, review-3 and review2-3). The final suite is what caught it.

### 2.2 Fix-check rounds were used
Of the briefs in the 16 runs with 4 or more review files, about 60 were fix-check briefs ("Findings
to re-check"). In the heaviest runs: kwenta-web `foreign-currency-bills` 13 of 27, rollcall's
largest payments run 12 of 22. A fixed finding no longer forces a full fresh read of the piece.

### 2.3 The test loop works when it is set up
kwenta-web is the clean case: `testFiles` + related tests while working + `npm run test` and
`test:sql` as `"when": "final"`. 8 `gate test` and 15 `gate verify --final` calls, 108 test-run
minutes in 6 sessions, and no command over the 10-minute limit. courtly ran `gate setup`, got the
same keys and had no slow commands.

### 2.4 Size prediction is right when the tree is clean
kwenta-web and courtly: 22 of 22 predicted sizes matched the measured size. In rollcall 6 of the
9 misses were a rebase or branch switch (section 3.1).

### 2.5 Fewer Stop blocks, no override
rollcall's blocks per 100 prompts halved (12.9 to 6.4). No `GATE OVERRIDDEN` appears in any 0.20
error log. The only 0.20 gate error is the crash in 3.4.

### 2.6 Users kept control of waivers
All 58 waived steps quote the user's choice ("Skip for rebases (Recommended)", "Waive this one;
use Playwright next", …). None was waived silently.

---

## 3. Problems, worst first

### 3.1 Git operations still cost whole runs (high: the biggest waste left)
Open since the 0.16 review. On 2026-10-25, rollcall had **8 runs that were only a rebase or
branch switch**: `*-rebase`, `return-to-*-checkout`, `*-after-*`. Each was measured **large**
because the rebased-in commits counted as the run's diff (12 to 35 files, 241 to 2,925 lines).
Each was then waived step by step: skeptic, tests, driver, schema, review, review-2, qa-pass and
delegate, about 65 waivers in all. R1 still fired 9 times. Four more `gate rebaseline` calls covered
the same thing.
**Evidence:** rollcall runs dated 2026-10-25 with those names; `waivers` in each `ledger.json`.
**Idea:** when HEAD moves (checkout, rebase, pull, merge) and the tree now matches a commit,
re-baseline on its own, with no run. Size a run against the merge-base of its branch, not the
tree at open.

### 3.2 Runs in a sibling repo can't see their own events (high: 5 of 5 abandoned)
A session started in rollcall that opens a run inside `../studentsync-serverless` or
`../reports-serverless` records its hook events under rollcall. The run there sees no searches,
no runs and no user messages, so it can never close. All 5 sibling-repo runs were abandoned with
reasons like "this session's hook events are filed under rollcall" and "opened in the wrong repo;
reopened from rollcall with --repo". `--repo` from the main repo works; opening in the sibling
does not, and nothing says so at open.
**Idea:** at `gate open`, if the session's events live in another repo's state dir, refuse and
print the `--repo` command. Or read events from the session's own repo.

### 3.3 Repos that need `gate setup` don't get it (high for rollcall)
The session-start notice asks for setup, but in rollcall no lead acted on it in 14 sessions.
There, gate.json still holds the previous tickets' verify commands, and every run starts by
dropping them: `verifyDropped` is set in 37 of 39 runs, `verifyAdded` in 37. The R18 coverage
rule doesn't count `scripts/test_db.sh run <files>` as a test command. `RUNNERS` in
`scripts/lib/verify.mjs:186` matches runner names only, and the wrapper hides `pytest`. That
produced 5 coverage waivers. ("the gate does not recognise test_db.sh as a pytest runner"; checked
against the source.) `testFiles` would cover it, but setup never ran.
**Ideas:** (a) make the setup ask a `gate open` refusal, once, until setup is applied or declined.
A notice is easy to miss in a busy session. (b) Have `gate setup` notice a per-ticket verify
list (paths that belong to closed runs) and propose resetting it. (c) Count a command as a test
run when it is gate.json's own `testFiles` template filled in, or when it names test files under
`tests` globs. Do this without hard-coding any wrapper; see the "plugin is general" rule.

### 3.4 `gate open` crashed with EISDIR (medium: crash, checked against the source)
`rollcall/.claude/gate/gate-error.log`, 2026-10-25T02:02:38Z, `verb=open`: `EISDIR: illegal
operation on a directory, read`, at `addFiles` (`scripts/lib/tree.mjs:238`) from `withRepos`
(`:250`). `addFiles` calls `readFileSync` on every path `listFiles` returns. `git ls-files` also
lists gitlinks (submodules) and symlinks to folders, which are directories, and nothing checks
`st.isFile()`. Which path it was is **unverified**; the run was opened with `--repo` for a sibling
repo.
**Fix:** skip anything where `!st.isFile()`, plus a test with a gitlink and a symlinked folder.

### 3.5 Short `node -e` repro runs don't count as runs (medium)
kwenta-web `2026-10-26-ios-input-zoom`: the lead reproduced the cause with `node -e
"…twMerge('h-10 text-base','h-8 rounded-lg text-sm')"`, which printed the wrong class. The gate
refused `gate step repro done --ran`, and repro and rootcause were waived ("the gate's run
recorder registers no Bash runs this session"). Cause: the guard marked those commands
`readOnly: true` (the events at 15:38:10Z and 15:38:47Z), and `ranEvents`
(`scripts/lib/rules.mjs:390`) drops every `readOnly` event. Running code that prints a result is a
run, even when it writes nothing.
**Fix:** treat `node -e` / `python -c` / `ruby -e` and the like as runs; readOnly should mean "only
read files". Add a test that `gate step repro done --ran "twMerge"` closes on such an event.

### 3.6 Helpers can't fix their own findings file with a shell command (medium: the top false denial)
28 denials (rollcall 10, kwenta-web 17, courtly 1) were a reviewer, reviewer-2, skeptic or worker
editing its **own** `review2-<n>.md` / `worker-<n>.md` with `sed -i`, a `python3` heredoc or
`cat >`. `EVIDENCE_IN_COMMAND` (`scripts/lib/guard.mjs:13`) matches every helper file name in a
command. Another ~31 denials were read-only looks at `verify.json` or a run folder (`head -c`,
`node -e require(...)`, `grep -n`). The Read tool can read them, but the shell form is refused.
**Fix:** let an agent write the helper file it was briefed for, matched by agent type and round,
by any means. Let plain reads of `verify.json` / `ledger.json` through.

### 3.7 Worker shell edits count as the lead's (medium)
kwenta-web: 5 `delegate` waivers ("edits were made by done-gate workers via shell commands",
"the change attributed to the lead was the Bills page worker's concurrent edit … during the lead's
scratch-folder command"). R16 credits a tree change to whoever's command was running when the
snapshot moved. When a worker runs in the background, that can be the lead.
**Idea:** credit a change to the agent whose own Edit/Write or command names the path. When two
agents are running, don't blame the lead on timing alone.

### 3.8 The reviewer-2 round cap ends long runs with lead-only review (low–medium)
kwenta-web, 3 runs (`foreign-currency-bills`, `fresh-edits-and-conflicts`,
`group-lifecycle-server`): reviewer-2 hit `REVIEW_CAP = 3` (`scripts/lib/rules.mjs:532`). The last
fix lines were "lead-reviewed" under a review-2 waiver. Those are the high-risk files where
reviewer-2 matters most. Fix-check rounds (only the changed lines) could be left out of the cap.

### 3.9 The driver step doesn't fit the real setups (low, but 19 waivers)
`driver` was the most-waived step: 19 times. The reasons fall into three groups:
- **Playwright was the real drive, but the gate doesn't take it as one.** kwenta-web ran headless
  Playwright at 360–390 px against local Supabase, which is better evidence than most driver runs.
  It still needed a waiver each time ("Accept Playwright proof", "use Playwright next"). The
  repo's `driver` is `skill:verify` and the run said "no /verify skill".
- **The Chrome extension can't reach `localhost:3000`** (courtly, 2 runs).
- **The surface can't be driven at all:** iOS-only rendering; local sign-in that hits the live
  project with no test account.
**Ideas:** count a recorded `npx playwright …` / `node <drive script>` run as driver evidence when
gate.json says so (`"driver": "cmd:<pattern>"`). Make "cannot drive here" a declared N/A with a
caveat, not a waiver.

### 3.10 Smaller things
- **`exit` is never recorded.** All ~17,000 `command` events in rollcall and kwenta-web have
  `exit: null`. `exitOf` (`scripts/lib/events.mjs:38`) reads `tool_response.exitCode` /
  `exit_code`, which the Bash PostToolUse payload doesn't seem to carry. Failures still arrive
  through `PostToolUseFailure`, so the impact is **unverified**. Anything that reads `exit` is
  reading nothing.
- **A run left open.** One rollcall run (opened 2026-10-26) is still `open` three days later,
  with nothing pointing at it. `gate doctor` could list open runs older than a day.
- **"wrong kind" abandon.** A rollcall run was abandoned with "wrong kind: test edits need a change
  run". An investigation run that found it needs test edits should be able to change its own
  playbook.
- **Case `test` field lost characters.** In one rollcall run, two case `test` values read like
  `…endpoint.pyest_c9_…`: the `tests/` prefix and `::t` are gone. Later rows in the same run are
  fine. Cause **unverified** (perhaps shell escaping in the `gate case` call).
- **New polling shape.** `until grep -q "passed" <background output>; do sleep 5; done` replaced
  `pgrep` loops (43 loops, 167 minutes in rollcall). These waits are for the agent's own
  background run. A `gate test --wait` or a note in the helper brief ("run tests in the
  foreground") would remove them.

---

## 4. What to build next, in order

1. **Git moves re-baseline on their own** (3.1): the largest waste, open since 0.16.
2. **Sibling-repo runs**: refuse to open where events can't be seen, and print the `--repo`
   command (3.2).
3. **Make setup hard to miss**, and propose resetting a stale per-ticket verify list (3.3a, 3.3b).
   Then set up rollcall: it holds the most test time, and none of 0.20's test-loop gains reached
   it.
4. **Small correctness fixes:** EISDIR (3.4), `node -e` as a run (3.5), helpers writing their own
   file (3.6). Each is a few lines plus a test.
5. **Credit worker shell edits to the worker** (3.7).
6. **Driver evidence from a recorded Playwright/script run**, and a declared "cannot drive" (3.9).
7. **Fix-check rounds outside the reviewer-2 cap** (3.8).

## 5. What to measure next time
Run the miners in the appendix on the same repos and compare:
- rollcall after setup: test-run minutes, 10-minute hits, wait-loop minutes, and large-run
  median active time (161 today).
- Rebase runs and R1 blocks (8 runs and 9 blocks today); after 3.1 both should be about zero.
- Sibling-repo abandons (5 of 5 today).
- Waived `driver` steps (19 today) and helper own-file denials (28 today).
- Act-on items per large run and how many came from reviewer-2. Make sure the speed work isn't
  costing catches.

---

## Appendix: the miners

In `docs/reviews/mine/`. Each takes repo roots as arguments and reads only `.claude/gate/`, so it
works on any repo.

| script | what it prints |
| --- | --- |
| `mine.mjs <repo>…` | one JSON row per run: version, playbook, status, size predicted/measured, cases, steps, waivers, huddles, Act-on counts, review/worker files. Save it as `runs.json`. |
| `agg.mjs` | reads `runs.json`; per-repo and per-version totals and medians. |
| `active.mjs` | reads `runs.json` and each repo's `events.jsonl`; active minutes per run (gaps capped at 10 min). Edit the `repos` map at the top. |
| `ev.mjs <from> <to> <repo>…` | from hook events: blocks by rule, gate verbs, helper spawns, test and verify minutes, commands near the 10-minute limit, denials. |
| `deny.mjs <from> <repo>…` | guard denials sorted into kinds (helper own-file edit, read-only look, lead edit before plan, …). |
| `acts.mjs <repo>…` | every Act-on item to `acts.json`, with a keyword pass for the serious ones. |

The 0.20 numbers came from:

```sh
R=~/Documents/Work/RollCall
node mine.mjs $R/rollcall $R/reports-serverless $R/studentsync-serverless ~/Documents/Personal/courtly ~/Documents/Personal/kwenta-web > runs.json
node agg.mjs; node active.mjs
node ev.mjs 2026-10-21T15:13 2026-10-30 $R/rollcall ~/Documents/Personal/kwenta-web ~/Documents/Personal/courtly
node ev.mjs 2026-10-06 2026-10-21T15:13 $R/rollcall
node deny.mjs 2026-10-21T15:13 $R/rollcall ~/Documents/Personal/kwenta-web ~/Documents/Personal/courtly
```
