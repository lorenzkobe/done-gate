# Playbooks

One section per playbook. `gate open <slug> <name>` copies that section's numbered steps
into the ledger. A step that does not apply is closed `N/A (reason)`, never deleted.
Steps with a `{key}` have script or agent evidence and can only be `DONE` or `WAIVED`,
never `SKIPPED`.

No slop: no comment that restates the code or narrates the change; no hedging names (helper, util, data2, newX, handleStuff); no guard or try/catch with no case behind it; no docstring on a trivial function; no TODO that names no task, console.log or commented-out code; no emojis. Nor a comment that numbers the steps (`// Step 1`), labels a block (`// main logic`), echoes a signature (`@param price the price`) or marks an end (`} // end if`), nor a banner comment. A comment says why, in one line, two when the second carries a new fact, or it goes. Keep the comment that explains a business rule, a workaround, a concurrency or security constraint, or an API contract. `gate check` scans the diff for the greppable ones (R10).

## feature

You own the design and the diff. Plan, build, verify, get reviewed.

1. Understand first: trace the code the task touches (entry points, callers, data flow; `grep -a` for callers), list what depends on it, and research better ways when the problem is a known one (docs, context7, web); write it with `gate note context`. {context}
2. Write Task and Plan in ledger.md (`gate note task|plan`); include the data/cost plan when data is touched, and the performance plan: the hot paths touched, the data sizes they see, the cost shape of the main operation (one pass, one query), or "no hot path" in one line. {plan}
3. Write the case table (`gate case add`): happy path, each edge, the refused side of every gate, boundaries, idempotency, the surface the user reported, and a performance row per hot path: the size that matters and what must not happen at it; a `click` row per new or changed link, button or tab, closed by clicking it in the real app after the last edit (`gate case close C<n> --click`). {cases}
4. Design huddle: spawn the skeptic on the plan, answer every finding, amend the plan (N/A below standard). {skeptic}
5. Write the tests from the case table before the code, one per case, and run them red; at size large spawn QA (blind to src) instead. {tests}
6. Implement, keeping the diff to the plan, no slop; reconcile with QA's tests as you go: each disagreement ends as code-wrong, test-wrong, or ask-the-user. {implement}
7. Run `gate verify` (lint, test, build) after the last edit. {verify}
8. Drive the real surface with the project's /verify driver, phone viewport first for UI. {driver}
9. Real-schema probe when schema files changed: hit the endpoint or run the query once. {schema}
10. Review: spawn the reviewer (it also checks dead code, duplication, slop and docs); close every Act-on item with an evidence pointer (N/A at tiny). {review}
11. `gate close`, then paste the report as the final message. {close}

## bugfix

Be scientific. Every shipped line traces to runtime evidence. "Might help" is a hypothesis,
not a fix. "Inconclusive" or the wrong surface is not a pass.

1. Reproduce on the real surface FIRST with the /verify driver; record the failing behaviour. {repro}
2. Root cause with runtime evidence: form hypotheses, rule them out, no belt-and-suspenders. {rootcause}
3. Understand first: trace the code the task touches (entry points, callers, data flow; `grep -a` for callers), list what depends on it, and research better ways when the problem is a known one (docs, context7, web); write it with `gate note context`. {context}
4. Write Task and Plan in ledger.md (`gate note task|plan`); name the hot path the fix touches, the data sizes it sees and its cost shape, or "no hot path" in one line. {plan}
5. Write the case table; row 1 is the repro, kind `reported-surface`; a performance row when the fix sits on a hot path; a `click` row per link, button or tab the fix changes. {cases}
6. Design huddle: spawn the skeptic on the plan, answer every finding, amend the plan (N/A below standard). {skeptic}
7. Write the failing test before the fix and quote the RED output; at size large spawn QA (blind to the fix) instead. {tests}
8. Make the smallest fix the evidence justifies, no slop; quote the GREEN output for the same test. {implement}
9. Run `gate verify` after the last edit. {verify}
10. Drive the same surface again: the original repro now passes. {driver}
11. Real-schema probe when schema files changed. {schema}
12. Review: spawn the reviewer (it also checks dead code, duplication, slop, cost, security and docs); close every Act-on item (N/A at tiny). {review}
13. `gate close`, then paste the report. {close}

## refactor

Behaviour-preserving. The tests that pin the behaviour exist BEFORE anything moves.

1. Understand first: trace the code the task touches (entry points, callers, data flow; `grep -a` for callers), list what depends on it, and research better ways when the problem is a known one (docs, context7, web); write it with `gate note context`. {context}
2. Write Task and Plan (`gate note task|plan`): what moves, what must not change, and the hot paths whose data sizes and cost shape must not grow, or "no hot path" in one line. {plan}
3. Case table: the existing tests that pin current behaviour, plus the pins that are missing, and a performance row per hot path that moves; a `click` row per link, button or tab that moves. {cases}
4. Design huddle: spawn the skeptic on the plan, answer every finding, amend the plan (N/A below standard). {skeptic}
5. Write the missing pins BEFORE the move and run them green on the current code (they must stay green after it); at size large spawn QA instead. {tests}
6. Run `gate verify` on the unmoved code so the baseline is green. {verify-before}
7. Make the move: no compat shims, no re-exports, names reflect the new shape, no slop. {implement}
8. Run `gate verify` again after the last edit. {verify}
9. Drive the real surface if UI files changed. {driver}
10. Real-schema probe when schema files changed. {schema}
11. Review: spawn the reviewer (it also checks for compat shims, re-exports, stale names, slop and docs); close every Act-on item (N/A at tiny). {review}
12. `gate close`, then paste the report. {close}

## plan

Produces a spec or plan document, no source edits. The skeptic is mandatory.

1. Understand first: trace the code the task touches (entry points, callers, data flow; `grep -a` for callers), list what depends on it, and research better ways when the problem is a known one (docs, context7, web); write it with `gate note context`. {context}
2. Write Task and Plan (`gate note task|plan`): goal, constraints, open decisions. {plan}
3. Design huddle: spawn the skeptic; answer every finding; amend. {skeptic}
4. Write the spec/plan document with every open decision resolved or listed as a question for the user. {implement}
5. `gate close`, then paste the report. {close}

## investigation

Read-only. No ledger is required because nothing changes; the gate stays silent.

1. Read the code and, where it is cheap, run it: an answer from running code outranks one from reading it.
2. End with a recommendation, not a survey of options.

A security or exposure finding cites the deployed state or the handler code; one read off a config file alone is labelled "from config, unverified".
