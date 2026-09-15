# Team gate (done-gate 0.3) — design

Date: 2026-09-15. Branch `team-gate`. Plan: `~/.claude/plans/all-good-do-the-twinkling-matsumoto.md`.

## Why

done-gate 0.2 was slow (claim labels, blast radius, word-for-word waivers, the tier-outgrown
rule) and its final message was technical. The user wants: they give the task; the session
they talk to is a **lead** that plans, sizes and delegates; a team of agents (worker, QA,
reviewer, arbiter) talks through files; the hard blocks stay; the final message is five
plain lines; fewer files.

## Decisions

- Lead edits at size small; at standard or large it never edits source (the fence refuses,
  R16 catches shell edits after the fact, `gate waive delegate` is the escape hatch).
- One `done-gate:worker` per piece, briefed by `gate brief worker`; replies in
  `worker-<n>.md`, recorded with `gate huddle reply` (fixed: closes, disagree: disputes).
- Reviewer ⇄ worker up to three rounds, the same reviewer resumed with SendMessage; what is
  still disputed goes to the arbiter once.
- Removed: R11 claim labels, R12 transcript waivers, R14 tier-outgrown, blast radius,
  `gate note attention`. R8 is cases and steps only.
- Reviewer checklist: run the tests, cases, bugs and edge cases, security, performance,
  scope and leftovers, adjacent flows. Helpers write their file first (fence-enforced).
- `gate report --brief`: headline, five lines (changed, checks, review, app, for you), path.
- Files: five lib modules merged, one `playbooks.md`, template inlined, tests in 13 area files.
- Helper budget: read-only shell allowed, diff capped at 300 lines in packets, no round
  without the previous file, the turn may end while a helper runs, reviewer 40 turns at
  effort medium, skeptic 24.

## Not verified yet

Everything above runs from the branch's own scripts in tests; the installed plugin still
runs 0.2.0 until the branch is merged and reinstalled, so the helpers' new briefs and the
draft-first fence have not been exercised live.
