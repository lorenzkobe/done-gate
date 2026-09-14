# Refactor

Behaviour-preserving. The tests that pin the behaviour exist BEFORE anything moves.
Steps with a `{key}` can only be `DONE` or `WAIVED`.

1. Read the code being moved and list every caller (use `grep -a`). {read}
2. Write Task and Plan (`gate note task|plan`): what moves, what must not change. {plan}
3. Case table: the existing tests that pin current behaviour, plus the pins that are missing. {cases}
4. Spawn QA to add the missing pins BEFORE the move. {qa}
5. Run `gate verify` on the unmoved code so the baseline is green. {verify-before}
6. Make the move. {implement}
7. Run `gate verify` again after the last edit. {verify}
8. Drive the real surface if UI files changed. {driver}
9. Blast radius: every caller still behaves, proven or written unproven. {blast}
10. Cleanup sweep: no compat shims, no re-exports, names reflect the new shape. {cleanup}
11. Review: spawn the reviewer; close every Act-on item. {review}
12. Update docs and CLAUDE.md for any moved path. {docs}
13. `gate close`, then paste the report. {close}
