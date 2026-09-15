<div align="center">

# done-gate

**A Claude Code plugin that makes "done" mean *evidenced*, not *asserted*.**

Hooks record what actually happened. A Stop hook refuses to end the turn until every gate
item has script-written evidence or a waiver in your own words. The final message is the
report, not a summary.

`node ≥ 18` · zero dependencies · macOS / Linux / Windows · one plugin, every repo

</div>

---

## Why

You delegate work to Claude the way a senior dev delegates to a mid-level dev. You want
to trust the result the same way: it works, it's tested, nothing was quietly skipped, and
nothing in the summary was made up.

Prose rules ("run the tests before saying done") don't get you there, because the model
that skips the step is the same model that writes the summary. done-gate moves the
judgment out of the model and into hooks that can't be talked out of it.

| The failure you've seen | What done-gate does about it |
| --- | --- |
| "Done" with the click-through quietly skipped | Every playbook step ends `DONE`, `SKIPPED (reason)`, `WAIVED ("your words")` or `N/A (reason)`. Blank is impossible. |
| Tests written from the same wrong assumption as the code | A QA agent writes tests from the **requirements and case table**, fenced so it can't read the new code or write outside `tests/`. |
| "Tests pass" that were never run | `gate verify` runs lint/test/build itself and records exit codes. Only that file counts, and it goes stale the moment source changes again. |
| Nobody else looked at it | An independent reviewer on a different model, fresh context, writes its own findings file. Act-on items block the close. |
| A "waiver" you never gave | Every waiver is listed in the final report with its reason. |

## How it works

```
 you: "add a badge to venue cards"
   │
   ▼
 gate open badge feature ──► ledger.json + playbook steps
   │
   ├─ note task / plan      ─┐
   ├─ case table             ├─ must exist BEFORE the first source edit (R2)
   ├─ skeptic huddle        ─┘
   │
   ├─ QA writes tests (blind to src)  ║  you implement
   │
   ├─ gate verify        ──► verify.json  (exit codes, tails, source hash)
   ├─ drive the real app ──► browser events logged by hooks
   ├─ reviewer           ──► review-1.md, written by the reviewer itself
   │
   ▼
 gate close · gate check · gate report
   │
   ▼
 Stop hook: every rule met? ──yes──► turn ends, ledger closed
                            └─no───► blocked with the unmet list; keep working
```

Three things make this hard to game:

- **The trigger is a content hash, not tool events.** Edits made with `sed`, `git apply`,
  codegen or by hand all count. Verify evidence is keyed to the source hash, so any later
  edit invalidates it.
- **Evidence files are fenced.** A PreToolUse hook denies writes to `events.jsonl`,
  `verify.json`, `ledger.json` and friends, for the model and every helper. Attempts are
  counted in the report.
- **Helpers read packets, not the ledger.** `gate brief <role>` writes each helper's inputs
  (ask, plan, case table, size, test conventions, and for the reviewer the diff and check
  results) into the run dir, and the model spawns it with one sentence. QA's packet withholds
  the diff; its blindness is a convention the prompt asks for, since the fence denies writes,
  not reads.
- **Findings are recorded, not paraphrased, and can be disputed once.** `gate huddle add`
  records every Act-on bullet of the reviewer's file (R15 blocks if one is missing). A
  finding the model believes wrong is disputed with evidence; the reviewer withdraws or
  upholds it in writing; an upheld one goes to a fresh arbiter on the stronger model that
  rules for one side. Every outcome is in the short report, and you can overrule.
- **Helpers can't vouch for themselves.** QA may write only under the tests globs; the
  reviewer may write only `review-<n>.md`; the skeptic writes nothing. Their replies are
  never evidence; their files and the hook events are.

## Install

```
/plugin marketplace add lorenzkobe/done-gate
/plugin install done-gate@done-gate
```

Restart the session (hooks load at start). That's it for a default setup: verify commands
come from `package.json` (`lint`, `typecheck`, `test`, `build`), and every non-ignored,
non-doc file counts as source.

Per repo, optionally:

- add `.claude/gate.json` to name your test, UI, schema and high-risk paths (schema in
  [`gate.schema.json`](gate.schema.json));
- run `/done-gate:verify-setup` once to generate `.claude/skills/verify/`, a driver that
  launches your app and drives it like a user, phone viewport first.

Both travel with the repo through git. The run state under `.claude/gate/` is local and
gitignored automatically. A verify entry may say `"when": "source"`: it then runs only when
a file that is not a test or a doc changed since the task opened, and is recorded as skipped
otherwise (the short report says so). The `build` script from package.json gets that by
default; lint, typecheck and test always run. If your build type-checks tests or builds a
docs site, write `{ "cmd": "npm run build", "when": "always" }` to opt out. A build command
written into gate.json by hand as a plain string runs always; give it `"when": "source"`
yourself to get the skip.

## What you see

You delegate as usual. The last message of a task is short and in plain words:

```
venue-badge: done

Changed 3 files. Tested 6 cases, all covered.
Lint, tests, build green.
Reviewer found 2 problems, all fixed.
Design check: 3 concerns, all addressed.

Please look at first:
- Skipped with your OK: "skip the phone pass this time".
- The badge hides for unrated venues — my belief, not verified.

Full report: .claude/gate/runs/2026-09-14-venue-badge/report.md
```

Lines that would be empty are left out. The full report on disk has every case with its
test, each step with its evidence, the reviewer's own file, the check output, the decision log and the changed files; `gate report` prints it
when you want the detail.

Mid-task, Claude can only pause two ways: a question through the question prompt, or a
final line `PAUSED: <what it needs>`. Anything else with an open ledger is judged as an
attempt to finish.

## The rules

| # | Blocks the turn when |
| --- | --- |
| R1 | source changed and no ledger is open |
| R2 | Plan or case table was written after the first source edit |
| R3 | `gate verify` is missing, red, or older than the last source edit |
| R4 | UI files changed and the real surface wasn't driven afterwards |
| R5 | no reviewer pass after the last edit, or an Act-on item is still open |
| R6 | schema files changed with no real-schema probe |
| R7 | source changed and no test file changed |
| R8 | any case or step is blank |
| R9 | high-risk paths changed without the second reviewer |
| R10 | a repo check failed (`claude-md-budget`, `migration-number`) |
| R13 | `.claude/gate.json` changed mid-task |
| R15 | a helper's file lists more findings than the ledger recorded |

Waivers are the only way past a keyed step: the user OKs it, Claude records the reason
with `gate waive <key> "…"`, and the report lists every waiver.

## Guarantees, and their edges

- **Can't end a turn with a gap.** After six *identical* blocks in a row it lets go and
  stamps `GATE OVERRIDDEN` on the report, so a stuck loop is loud rather than infinite.
  Progress resets the counter.
- **Can't forge evidence, can't invent a waiver.** See above.
- **Fails open, loudly.** A bug in the gate itself exits 0 and stamps `GATE ERROR`. A hook
  that could wedge every session in every repo would cost more than one unreported task.
- **Zero friction when nothing changed.** Questions, investigations, a second terminal in
  the same repo: the tree hash is unchanged, the gate stays silent.
- **What it cannot know.** Whether a test asserts the right thing. It makes that visible
  instead: case → test mapping and the reviewer's own file, so a human can check them in
  two minutes.

## Cost

The gate sizes each task from the real diff and spends helpers accordingly. Helpers never
run on the most expensive tier.

| Tier | When | Helpers |
| --- | --- | --- |
| small | one source file, ≤ 40 lines, no UI, schema or high-risk path | QA (Opus), reviewer (Sonnet) |
| standard | ≤ 10 files, ≤ 400 lines, or any UI, schema or high-risk file | skeptic (Sonnet), QA, reviewer |
| large | more than that | skeptic, QA, reviewer with a second round on Opus |
| any | a review finding the model disputes with evidence and the reviewer upholds | arbiter (Opus), rules once in writing |

`gate note plan --files a.ts,b.ts` predicts the tier before the diff exists, so a small
feature skips the design critique up front; if the diff then outgrows the prediction, the
step comes back and the gate says so. `gate size` prints the
numbers. The policy is in `models.json`. Hard ceiling: **ten helper invocations per task**,
typically two or three. Always-on context cost is about 500 tokens; everything the hooks do
is off-model.

## Commands

All verbs are `node "$CLAUDE_PLUGIN_ROOT/scripts/gate.mjs" <verb>`; the skill calls them `gate …`.

| Verb | Does |
| --- | --- |
| `open <slug> <feature\|bugfix\|refactor\|plan>` | start a ledger with the playbook's steps |
| `note task\|plan "…"` · `note plan "…" --files a,b` | write the prose sections (stamps the order for R2); `--files` predicts the size |
| `case add "…" --kind <kind>` · `case close C1 --test file:name \| --na "…"` | the case table |
| `step <key\|n> done\|skipped\|na "…" [--evidence ptr]` | close a playbook step |
| `huddle add <role> --file review-1.md` · `acton` · `resolve` | reviewer rounds and Act-on items |
| `waive <key> "<reason>"` | record a waiver; it shows in the report |
| `verify [--step verify-before]` | run the repo's verify commands, write `verify.json` |
| `decide <phase> <decision> <why> <evidence> <result>` | append a decision-log row |
| `brief <skeptic\|qa\|reviewer\|reviewer-2> [--round n]` | write the helper's packet and print its spawn prompt |
| `check` · `steps` · `size` · `report [--brief]` · `close` · `doctor` | unmet items only · every step · the report, short or full · finish · inspect config |

## Configuration

`.claude/gate.json` (all keys optional):

```json
{
  "source":   ["src/**", "supabase/**", "tests/**", "package.json"],
  "tests":    ["tests/**"],
  "ui":       ["src/app/**", "src/components/**"],
  "schema":   ["src/lib/data/db.ts", "supabase/migrations/**"],
  "highRisk": ["src/lib/payments/**", "src/lib/auth/**", "supabase/migrations/**"],
  "verify":   ["npm run lint", { "cmd": "npm run test", "timeout": 1500 }, { "cmd": "npm run build", "when": "source" }],
  "checks":   ["claude-md-budget", "migration-number"],
  "driver":   "skill:verify"
}
```

## Develop

```
npm test           # the plugin's own suite (node --test), 87 tests
npm run reinstall  # refresh the user-scope install from this tree; restart the session
```

Layout: `scripts/gate.mjs` (dispatcher) → `scripts/lib/*` (pure modules) · `hooks/` ·
`skills/gate` (the workflow + playbooks) · `skills/verify-setup` · `agents/` · `models.json`.

Ideas borrowed with thanks from Lauren Tan's `poteto-mode` (playbooks with explicit skips,
ownership of delegated work, a per-project verify driver) and from Anthropic's `ralph-loop` (the Stop-hook contract).
