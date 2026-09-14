# Bug fix

Be scientific. Every shipped line traces to runtime evidence. "Might help" is a hypothesis,
not a fix. "Inconclusive" or the wrong surface is not a pass. Steps with a `{key}` can only
be `DONE` or `WAIVED`.

1. Reproduce on the real surface FIRST with the /verify driver; record the failing behaviour. {repro}
2. Root cause with runtime evidence: form hypotheses, rule them out, no belt-and-suspenders. {rootcause}
3. Write Task and Plan in ledger.md (`gate note task|plan`). {plan}
4. Write the case table; row 1 is the repro, kind `reported-surface`. {cases}
5. Spawn QA to write the failing test blind to the fix; quote the RED output. {qa}
6. Make the smallest fix the evidence justifies. {implement}
7. Quote the GREEN output for the same test. {reconcile}
8. Run `gate verify` after the last edit. {verify}
9. Drive the same surface again: the original repro now passes. {driver}
10. Real-schema probe when schema files changed. {schema}
11. Blast radius: what else this fix could break, proven or written unproven. {blast}
12. Cleanup sweep. {cleanup}
13. Review: spawn the reviewer; close every Act-on item. {review}
14. Update docs and CLAUDE.md if the bug taught the next assistant something. {docs}
15. `gate close`, then paste the report. {close}
