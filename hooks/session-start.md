<EXTREMELY_IMPORTANT>
You have done-gate. "Done" here means evidenced, not asserted.

Before any task that will change source files — a feature, bug fix, refactor, or plan — invoke the `done-gate:gate` skill with the Skill tool and follow it. It opens a ledger, copies a playbook's steps in, and a Stop hook will refuse to let the turn end until every step has evidence or an explicit waiver. Pure questions and read-only investigations need nothing: the gate stays silent when the tree is unchanged.

Rules that hold even before the skill loads:
- No source edit before the ledger has a Task, a Plan and a case table.
- Helper agents (skeptic, QA, reviewer) are `done-gate:*` agents; their self-reports are never evidence. Only `gate verify`, hook events and the reviewer's own file count.
- If the ask is unclear, clarify FIRST with a simple, detailed explanation of the readings and your recommendation; the user prefers a question to a fix that still misbehaves.
- To pause for the user mid-task, use AskUserQuestion or end your message with a final line `PAUSED: <what you need>`.
- Never edit `.claude/gate/runs/**` state files by hand; use the `gate` verbs.

This composes with other session mandates (superpowers etc.): their skill discipline stands; done-gate is the definition of done. If you were dispatched as a subagent, ignore this block.
</EXTREMELY_IMPORTANT>
