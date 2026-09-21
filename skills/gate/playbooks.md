# Playbooks

One section per playbook. `gate open <slug> <name>` copies that section's numbered steps
into the ledger. A step that does not apply is closed `N/A (reason)`, never deleted.
Steps with a `{key}` have script or agent evidence and can only be `DONE` or `WAIVED`,
never `SKIPPED`.

## feature

You own the design and the diff. Plan, build, verify, get reviewed.

1. Read the affected code paths and write down how they behave today. {read}
2. Write Task and Plan in ledger.md (`gate note task|plan`); include the data/cost plan when data is touched, and the performance plan: the hot paths touched, the data sizes they see, the cost shape of the main operation (one pass, one query), or "no hot path" in one line. {plan}
3. Write the case table (`gate case add`): happy path, each edge, the refused side of every gate, boundaries, idempotency, the surface the user reported, and a performance row per hot path: the size that matters and what must not happen at it. {cases}
4. Design huddle: spawn the skeptic on the plan, answer every finding, amend the plan (N/A at tier small). {skeptic}
5. Write the tests from the case table before the code, one per case, and run them red; at size large spawn QA (blind to src) instead. {tests}
6. Implement, keeping the diff to the plan; reconcile with QA's tests as you go: each disagreement ends as code-wrong, test-wrong, or ask-the-user. {implement}
7. Run `gate verify` (lint, test, build) after the last edit. {verify}
8. Drive the real surface with the project's /verify driver, phone viewport first for UI. {driver}
9. Real-schema probe when schema files changed: hit the endpoint or run the query once. {schema}
10. Review: spawn the reviewer (it also checks dead code, duplication and docs); close every Act-on item with an evidence pointer. {review}
11. `gate close`, then paste the report as the final message. {close}

## bugfix

Be scientific. Every shipped line traces to runtime evidence. "Might help" is a hypothesis,
not a fix. "Inconclusive" or the wrong surface is not a pass.

1. Reproduce on the real surface FIRST with the /verify driver; record the failing behaviour. {repro}
2. Root cause with runtime evidence: form hypotheses, rule them out, no belt-and-suspenders. {rootcause}
3. Write Task and Plan in ledger.md (`gate note task|plan`); name the hot path the fix touches, the data sizes it sees and its cost shape, or "no hot path" in one line. {plan}
4. Write the case table; row 1 is the repro, kind `reported-surface`; a performance row when the fix sits on a hot path. {cases}
5. Write the failing test before the fix and quote the RED output; at size large spawn QA (blind to the fix) instead. {tests}
6. Make the smallest fix the evidence justifies; quote the GREEN output for the same test. {implement}
7. Run `gate verify` after the last edit. {verify}
8. Drive the same surface again: the original repro now passes. {driver}
9. Real-schema probe when schema files changed. {schema}
10. Review: spawn the reviewer (it also checks dead code, duplication, cost, security and docs); close every Act-on item. {review}
11. `gate close`, then paste the report. {close}

## refactor

Behaviour-preserving. The tests that pin the behaviour exist BEFORE anything moves.

1. Read the code being moved and list every caller (use `grep -a`). {read}
2. Write Task and Plan (`gate note task|plan`): what moves, what must not change, and the hot paths whose data sizes and cost shape must not grow, or "no hot path" in one line. {plan}
3. Case table: the existing tests that pin current behaviour, plus the pins that are missing, and a performance row per hot path that moves. {cases}
4. Write the missing pins BEFORE the move and run them green on the current code (they must stay green after it); at size large spawn QA instead. {tests}
5. Run `gate verify` on the unmoved code so the baseline is green. {verify-before}
6. Make the move: no compat shims, no re-exports, names reflect the new shape. {implement}
7. Run `gate verify` again after the last edit. {verify}
8. Drive the real surface if UI files changed. {driver}
9. Review: spawn the reviewer (it also checks for compat shims, re-exports, stale names and docs); close every Act-on item. {review}
10. `gate close`, then paste the report. {close}

## plan

Produces a spec or plan document, no source edits. The skeptic is mandatory.

1. Read the code the plan will touch and record how it behaves today. {read}
2. Write Task and Plan (`gate note task|plan`): goal, constraints, open decisions. {plan}
3. Design huddle: spawn the skeptic; answer every finding; amend. {skeptic}
4. Write the spec/plan document with every open decision resolved or listed as a question for the user. {implement}
5. `gate close`, then paste the report. {close}

## investigation

Read-only. No ledger is required because nothing changes; the gate stays silent.

1. Read the code and, where it is cheap, run it: an answer from running code outranks one from reading it.
2. End with a recommendation, not a survey of options.
