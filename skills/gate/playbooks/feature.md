# Feature

You own the design and the diff. Plan, build, verify, get reviewed. A step that does not
apply is closed `N/A (reason)`, never deleted. Steps with a `{key}` have script or agent
evidence and can only be `DONE` or `WAIVED`, never `SKIPPED`.

1. Read the affected code paths and write down how they behave today. {read}
2. Write Task and Plan in ledger.md (`gate note task|plan`); include the data/cost plan when data is touched. {plan}
3. Write the case table (`gate case add`): happy path, each edge, the refused side of every gate, boundaries, idempotency, and the surface the user reported. {cases}
4. Design huddle: spawn the skeptic on the plan, answer every finding, amend the plan (N/A at tier small). {skeptic}
5. Spawn QA on the case table, blind to src; QA writes the tests under the tests globs. {qa}
6. Implement, keeping the diff to the plan. {implement}
7. Reconcile with QA (at most 2 rounds): each disagreement ends as code-wrong, test-wrong, or ask-the-user (N/A at tier small). {reconcile}
8. Run `gate verify` (lint, test, build) after the last edit. {verify}
9. Drive the real surface with the project's /verify driver, phone viewport first for UI. {driver}
10. Real-schema probe when schema files changed: hit the endpoint or run the query once. {schema}
11. Cleanup sweep: dead code, comments that restate code, duplication, cost, security. {cleanup}
12. Review (at most 2 rounds): spawn the reviewer; close every Act-on item with an evidence pointer. {review}
13. Update docs and CLAUDE.md with anything the next assistant must know. {docs}
14. `gate close`, then paste the report as the final message. {close}
