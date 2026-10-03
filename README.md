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
| Nobody else looked at it | An independent reviewer, fresh context, writes its own findings file. Act-on items block the close. |
| A "waiver" you never gave | Every waiver is listed in the final report with its reason. |

## How it works

```
 you: "add a badge to venue cards"
   │
   ▼
 gate open badge feature ──► ledger.json + playbook steps
   │
   ├─ note task / context / plan ─┐
   ├─ case table             ├─ must exist BEFORE the first source edit (R2)
   ├─ skeptic huddle        ─┘
   │
   ├─ QA writes tests (blind to src)  ║  tiny, small, standard: you implement
   │                                   ║  large: a worker per piece
   ├─ gate verify        ──► verify.json  (exit codes, tails, source hash)
   ├─ drive the real app ──► browser events logged by hooks
   ├─ reviewer ⇄ worker  ──► review-<n>.md / worker-<n>.md, up to 3 rounds
   ├─ arbiter            ──► settles what is still disputed
   │
   ▼
 gate close: every rule met? ──yes──► ledger closed, report written
                             └─no───► the unmet list, exit 1; keep working
   │
   ▼
 Stop hook: source changed and a rule unmet? ──► blocked with the list
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
  upholds it in writing; an upheld one goes to a fresh arbiter that rules for one side. Every outcome is in the short report, and you can overrule.
- **Helpers can't vouch for themselves.** QA may write only under the tests globs; the
  reviewer may write only `review-<n>.md` (the second reviewer `review2-<n>.md`); the skeptic only `skeptic-<n>.md`. Their replies are
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
default, and so does an entry in gate.json with no `when` that is one build call and nothing
else (`npm run build`, `pnpm build`, `yarn build`, `bun run build`); a compound command (`&&`, `;`, `|`) and
lint, typecheck and test always run. If your build type-checks tests or builds a docs site,
write `{ "cmd": "npm run build", "when": "always" }` to opt out. A `"source"` command that was
green is also skipped while only tests or docs changed since: `verify.json` keeps, per
command, the hash of the non-test source at its last green run, and the next edit to a
non-test source file runs it again. A command that was red always runs.

## What you see

You delegate as usual. The last message of a task is short and in plain words: a headline,
five lines, and where the full report is.

```
venue-badge: done

Changed 3 files (src/badge.tsx, src/card.tsx, src/venue.ts), size standard.
Lint, tests, build green. Tested 6 cases, all covered. Test files changed (2 files).
Review: 2 rounds, found 2 problems, all fixed.
App driven after the last change.
For you: skipped with your OK: chrome is disconnected, no phone pass this time.

Full report: .claude/gate/runs/2026-09-14-venue-badge/report.md
```

The five lines are always there ("For you: nothing." when there is nothing). `For you` keeps
to what needs you: waivers, disputes and unmet rules; pauses and blocked writes are in the
full report only. A `Caveats:` line
follows them when the lead recorded what it could not show (`gate note caveat "the phone
viewport was not driven"`); the full report lists the same under Caveats. The full report on disk has every case with its
test, each step with its evidence, the reviewer's own file, the check output, the decision log and the changed files; `gate report` prints it
when you want the detail.

Mid-task, Claude can only pause two ways: a question through the question prompt, or a
final line `PAUSED: <what it needs>`. Anything else with an open ledger is judged as an
attempt to finish.

## The rules

| # | Blocks the turn when |
| --- | --- |
| R1 | source changed and no ledger is open |
| R2 | Context, Plan or case table was written after the first source edit |
| R3 | `gate verify` is missing, red, older than the last source edit, still running, or started and never finished (the shell died under it); or a command added with `gate verify --add` has not run yet |
| R4 | UI files changed and the real surface wasn't driven afterwards |
| R5 | no reviewer pass after the last edit, or an Act-on item is still open; tier tiny needs no reviewer. A change past the piece cap (400 changed lines) is reviewed in pieces, `gate brief reviewer --files a,b`, and one big file in slices, `--files a.ts:1-400`; a line is covered once the last round that saw it came back clean (or was the file's third); new or uncovered lines need a round |
| R6 | schema files changed with no real-schema probe |
| R7 | source changed and no test file changed |
| R8 | any case or step is blank, or a click case's click is older than the last source edit; the close step is closed by `gate close`, never by `gate step close …` |
| R9 | high-risk paths changed without the second reviewer (same round rules as R5; an open reviewer-2 item is named) |
| R10 | a repo check failed: the slop scan found a banner comment, step narration, an empty label, an end marker, an emoji, a bare TODO or a `@param` that echoes its name on an added non-test line (`"slop": false` in gate.json turns it off between tasks; mid-task, `gate waive slop` clears a false positive), or an opted-in check (`claude-md-budget`, `migration-number`) |
| R13 | `.claude/gate.json` or the plugin's `models.json` changed mid-task |
| R15 | a helper's file lists more findings than the ledger recorded, or a briefed skeptic, reviewer or arbiter stopped before finishing its file |
| R16 | the lead edited source itself at size large (a worker's job); waivable with `gate waive delegate` |

Waivers are the only way past a keyed step: the user OKs it, Claude records the reason
with `gate waive <key> "…"`, and the report lists every waiver. The keys: `driver` (R4),
`review` (R5), `schema` (R6), `tests` (R7), `review-2` (R9), `slop` (R10), `gate-config`
(R13), `delegate` (R16), or the key of a step whose waiving clears something. A rule number
is taken for its key (`gate waive R16` records `delegate`). Any other key is refused with the
valid ones listed (`worker` is pointed at `delegate`), and so are `verify`, `verify-before`,
`context`, `close` and a rule with no waiver (R3): the message says what to run instead.
`gate waive` prints what the key clears, and the unmet text of R5, R6, R9 and R16 names its
key.

## Guarantees, and their edges

- **Can't end a turn with a gap.** After six *identical* blocks in a row it lets go and
  stamps `GATE OVERRIDDEN` on the report, so a stuck loop is loud rather than infinite.
  Progress resets the counter.
- **Can't forge evidence, can't invent a waiver.** See above.
- **Fails open, loudly.** A bug in the gate itself exits 0 and stamps `GATE ERROR`. A hook
  that could wedge every session in every repo would cost more than one unreported task.
- **Zero friction when nothing changed.** Questions, investigations, a second terminal in
  the same repo: the tree hash is unchanged, the gate stays silent.
- **Helpers write their file first.** A skeptic, reviewer or arbiter may only read its packet
  and write its own findings file until that file exists; every other read or shell call is
  refused with "write your draft first". It then rewrites the file after each confirmed
  finding, so a helper that runs out of turns leaves what it found. A file with a section
  still reading `- unverified` is not a finished round: `gate check` names it once its helper
  has stopped, `gate huddle add` refuses to record it, and `gate brief <role>` briefs the
  same round again with the file in the packet, so a fresh helper continues from it and
  keeps the finished sections. Turn limits: skeptic 40, reviewers and QA 60, worker 100,
  arbiter 12. Two reviewers
  of one role may be out at once, on two pieces: each packet carries its own file number
  (`brief-reviewer-2.md` asks for `review-2.md`), and a reviewer that has written its draft
  is free while the other still owes its own.
- **A helper's shell writes stay in scratch.** The fence reads where a command writes (a
  redirect, `tee`, `cp`, `mv`, `rm`, `sed -i`, inline code that writes, a git write) and lets
  it through when every target is under `tests/.tmp`, `/tmp` or a scratchpad; sources may be
  anywhere, a `cd` and variables set in the same command count, and a heredoc body is text.
  The lead's commands are refused only when they write an evidence file: quoting its path in
  a heredoc or reading it with `node -e` is fine.
- **Waiting for a helper is a legal turn end.** While any agent this session spawned (a
  `done-gate:*` helper, an Explore or Plan agent) is still running, the Stop hook lets the
  turn end quietly; the agent's hand-back wakes the lead. A hand-back, a task notification or
  a message from another session arrives as a prompt, but it is not a new turn: helpers still
  running are still seen.
- **`gate close` closes.** It judges the run there and then: clean, the ledger is closed, the
  session's baseline moves and report.md is written, so opening the next task in the same
  turn is safe; not clean, it prints the unmet list, exits 1 and changes nothing. A run an
  older plugin left "closing" is closed late at the next session start, never attached.
- **A usage mistake fails the command.** A verb called wrongly (an empty note, an unknown
  role, no open run) prints its usage on stderr and exits 1, so a `gate … && next` chain stops
  there; hooks always exit 0. `gate help` lists the verbs.
- **Every block is logged.** When the Stop hook refuses to end the turn, a `block` event with
  the unmet rule ids lands in the session's events, and the report counts them, so a turn
  that could not end can be diagnosed afterwards.
- **A stale ledger can be let go.** A ledger left open by an earlier session is joined again
  after a /clear, resume or compaction; a new session is only told it is there, with
  `gate attach <slug>` to continue it and `gate abandon <slug> "<reason>"` to mark it abandoned
  (reason in its report) so it no longer blocks anything. Nothing is finalised: the changes it
  left behind still count against the next ledger.
- **The lead implements below size large.** It holds the context, so handing a piece to a
  fresh worker would only lose it. At size large (`policy.delegatesAt` in `models.json`; a
  plan naming more than ten files) the lead's own `Edit`/`Write` on source or tests is
  refused and it is told to brief a worker per piece. A shell edit (`sed -i`, a heredoc) slips past this fence; the
  Stop hook's R16 catches it after the fact from the event log.
- **A new control is clicked, not just loaded.** A case of kind `click` (one per new or
  changed link, button or tab; the skeptic and the reviewer ask for them) cannot be closed
  with a test. `gate case close <id> --click events#<seq>` takes that click when it came after
  the last source edit and no other click case holds it, and stores it on the case. Plain
  `--click` takes the newest such click only while one click case is open; with more open
  and more than one unclaimed click it refuses and lists them, since it cannot tell which
  control each was on. A click is:
  a `left_click`, `double_click`, `triple_click`, `right_click` or `form_input` in Chrome,
  alone or inside a `browser_batch`, or a green run of the `cmd:` driver. Loading the page,
  a screenshot, `javascript_tool` and a helper's click do not count. One click closes one
  case, and a source edit after it opens the case again (R8). `--na "<reason>"` still works.
- **Size is counted from open.** A file that already had uncommitted work when the task
  opened (left by an earlier run of the session, or from before it) is copied to
  `<run>/base/<path>.base` at `gate open` and diffed against that copy, so the size, the review cap,
  the reviewer's diff, review coverage and the slop scan see only what this task changed.
  Copies are text files of at most 1 MB, at most 200 per run, fenced like other evidence; a
  file edited in the session before open with no run closed since keeps the old line-count
  estimate.
- **Re-indenting is not size.** Whitespace-only lines do not count toward the tier or the
  400-line piece cap; the reviewer still sees them and they still need a review round.
  Where indentation is meaning every line counts: `.py`, `.pyi`, `.yml`, `.yaml`, `.pug`,
  `.haml`, `.sass`, `.styl`, `.coffee`, `.nim`, `Makefile` and `*.mk`.
- **Another session's commits are not yours.** When HEAD moved and this run ran no git
  command that writes (any subcommand that is not read-only) and changed nothing through the shell, a file those commits changed that is clean
  against HEAD and that this run never edited is folded into the baseline: not sized, not
  reviewed, not scanned. The report says how many files from other commits were left out.
- **Another session's edits do not need your ledger.** With no ledger open, R1 leaves out a
  source file that another session's events account for (its edit of the file, or a writing
  command whose run holds the file's mtime) and this session's do not. A change no session's
  events explain stays this session's.
- **Outgrowing the size is said at the edit.** The first lead edit that takes a run
  predicted below large into it gets a note from the log hook with the measured size and
  `gate brief worker`; the fence refuses the lead's edits from the next gate verb on. Once
  per run.
- **A verb finds its own session.** Where the shell has no `CLAUDE_CODE_SESSION_ID`, the
  fence, which always has the real id, writes it to `.claude/gate/pids/<pid>` for its own
  ancestor processes (up to four levels, never pid 1) when the lead's Bash command runs
  `gate.mjs`, after removing the files of processes that are gone. With `DONE_GATE_SESSION` set
  nothing is written (the verb inherits it); `CLAUDE_CODE_SESSION_ID` in the hook's
  environment does not stop the write, since the shell may not have it. A verb with no id on stdin or in the environment walks its own ancestors,
  nearest first, and takes the first pid file it finds, then falls back to the
  `current-session` marker. Two sessions in one repo no longer read each other's run.
- **One test for two cases is said.** `gate case close --test` prints a note when the same
  pointer already closes another case, and the reviewer's packet lists every test that
  closes two or more under "Shared tests", so the reviewer checks it can fail for each.
- **A case can be corrected.** `gate case amend C2 "<text>"` keeps the old text in the case's
  history and opens the case again; the report marks it amended. Amending is not writing the
  case table late (R2).
- **A pointer may leave the repo.** An evidence pointer to an existing file by absolute path,
  `~` or `../` resolves (a plan kept outside the repo); a directory or an empty path does not.
- **A run can span repos.** See [Working across repos](#working-across-repos). A run with no
  further repo costs and behaves as before.
- **What it cannot know.** Whether a test asserts the right thing. It makes that visible
  instead: case → test mapping and the reviewer's own file, so a human can check them in
  two minutes.

## Cost

The gate sizes each task from the real diff and spends helpers accordingly. Every helper
runs on the session's own model (`model: inherit`), so the plugin behaves the same whatever
model the lead runs on; no policy file names one. Below size large the lead writes the
tests itself, from the case table, before the code.

| Tier | When | Helpers |
| --- | --- | --- |
| tiny | one source file, ≤ 15 lines, no UI, schema or high-risk path | none |
| small | one source file, ≤ 40 lines, no UI, schema or high-risk path | reviewer |
| standard | ≤ 10 files, ≤ 400 lines, or any UI, schema or high-risk file | skeptic, reviewer |
| large | more than that | skeptic, QA (blind tests), a worker per piece, reviewer, a second reviewer |
| any | 2+ Act-on items in round 1 | a second reviewer round, same reviewer, fresh context |
| any | a review finding the model disputes with evidence and the reviewer upholds | arbiter, rules once in writing |

`gate note plan --files a.ts,b.ts` predicts the tier before the diff exists, so a small
feature skips the design critique up front and a tiny one skips the reviewer too; if the diff
then outgrows the prediction, the step comes back and the gate says so. Tiny is reached only
by evidence: a plan naming exactly one source file, or a measurement with no estimated lines. `gate size` prints the
numbers. The skeptic step is on the feature, bugfix and refactor playbooks at standard and
large; it cannot close without a finished, recorded `skeptic-<n>.md` whose Act-on items are
all closed. The policy is in `models.json`. Hard ceiling: **ten helper invocations per task**,
typically two or three. Always-on context cost is about 500 tokens; everything the hooks do
is off-model.

## Commands

All verbs are `node "$CLAUDE_PLUGIN_ROOT/scripts/gate.mjs" <verb>`; the skill calls them `gate …`.

| Verb | Does |
| --- | --- |
| `open <slug> <feature\|bugfix\|refactor\|plan\|investigation> [--repo <path>]` | start a ledger with the playbook's steps; `--repo` (repeatable, anywhere among the arguments) adds a further git repo to the run; on a slug whose run is open it joins that run and declares the repo late |
| `repo add <path>` | add a further git repo to the open run, measured from its HEAD |
| `note task\|context\|plan "…"` · `note plan "…" --files a,b` · `note caveat "…"` | write the prose sections (stamps the order for R2); Context is Traced (file:line pointers), Related, Research; `--files` predicts the size; a caveat is something the run could not show, printed in both reports |
| `case add "…" --kind <kind>` · `case add --batch <file>` · `case amend C1 "…"` · `case close C1 --test file:name \| --click [events#<seq>] \| --na "…"` | the case table; kinds: happy, edge, refused, boundary, idempotent, reported-surface, performance, click; `--batch` reads one case per line as `<kind><TAB><text>`, adds all or none and prints one `next:` line; `amend` replaces a case's text and reopens it; `--click` closes a click case with the named click, or with the only unclaimed click, or with the newest one while only one click case is open, and prints it |
| `step <key\|n> done\|skipped\|na "…" [--evidence ptr \| --ran "<text>"]` | close a playbook step (not the close step: `gate close` does that); the pointer must resolve; `repro`, `rootcause` and `schema` close only on a recorded run (`--ran` picks the newest command, browser call or skill after the run opened whose text contains it), and `rootcause` names the line at fault as `file:line` in its note |
| `next` | the full `next:` hint; after a verb it is printed in full the first time a step is hinted and in a short form afterwards, and in full again once a session joins the run (clear, resume, compact, `gate attach`) |
| `huddle add <role> --file review-1.md` · `acton` · `resolve` · `dispute` | reviewer rounds and Act-on items; `add` prints each recorded id with its finding |
| `huddle reply --file worker-<n>.md` | record a worker's answers: `fixed:` closes an item, `disagree:` disputes it; an unknown id fails and lists the open ones. Worker reply files are their own stream, numbered like their packet (`brief-worker-2.md` asks for `worker-2.md`) |
| `waive <key\|R<n>> "<reason>"` | record a waiver and print what it clears; it shows in the report |
| `verify [--step verify-before]` | run the repo's verify commands, then each declared repo's in its own directory, write `verify.json` |
| `verify --add "<cmd>"` · `verify --drop "<cmd>"` | add a verify command for this run only, or remove one this run added; nothing runs. Added commands run after the config ones at every `gate verify`, with the default timeout, also when the config has none. They live on the ledger, not in gate.json (R13 stays quiet), and `gate doctor` and the report list them as added by this run. An added command that has not run blocks the close (R3); a dropped one stays in the report as dropped by this run |
| `decide <phase> <decision> <why> <evidence> <result>` | append a decision-log row |
| `brief <skeptic\|qa\|worker\|reviewer\|reviewer-2\|arbiter> [--files a,b \| a.ts:1-400] [--item H#.#]` | write the helper's packet and print its spawn prompt; a packet is numbered like the file it names; a worker's `--files` are the files it owns |
| `abandon <slug> "<reason>"` | give a run up: marks it abandoned with the reason; it stops attaching to sessions and blocking turns |
| `check` · `steps` · `size` · `report [--brief]` · `close` · `doctor` · `help` | unmet items only · every step · the report, short or full · close a clean run · inspect config · the verbs |

## Working across repos

A change that spans two checkouts is one run. Open it in the main repo and name the other:

```
gate open report-totals feature --repo ../reports-serverless
gate repo add ../shared-types        # later in the run
```

The path must be an existing directory outside the main repo that is the root of a git work
tree, not nested in or containing another declared repo. A relative path is read from the
main root, whatever the shell's directory. `gate open`, `gate attach` and
`gate doctor` print the declared repos.

- **One path namespace.** A file of a declared repo is named by its path from the main root:
  `../reports-serverless/src/a.py`. That is the path in `note plan --files`,
  `brief worker|reviewer --files`, Traced pointers, evidence pointers, `gate size`, the
  reviewer's diff, the slop scan, the fence and the report. Edits there are recorded like
  any other; edits in a repo nobody declared are still ignored, and a Traced pointer into
  one does not count. `--files` naming a file in a repo nobody declared says so and names
  `gate repo add`.
- **What each declaration measures from.** A repo named at `gate open` on a new run starts
  as it is: what it already held, committed or not, is not this run's (modified and
  untracked source files are copied aside under the run's `base/` and diffed against the
  copy). A repo added later, with `gate repo add` or `gate open --repo` on a run already
  open, is measured from its HEAD: the run may have edited there before the gate was
  looking, so every uncommitted change to a tracked file and every untracked file counts
  as this run's. More is reviewed, never less; the command's output says so.
- **Its own config.** A declared repo with a `.claude/gate.json` is classified by its own
  globs; without one, the main repo's globs read its repo-relative path. Its verify
  commands (its gate.json, else its package.json scripts) run in its directory after the
  main ones. The same command text in two repos is two commands: each has its own row in
  `verify.json` (`repo: "<prefix>"`), and a `when: "source"` command runs when the
  implementation of its own repo changed.
- **R13 covers it.** Changing a declared repo's gate.json or verify command list mid-run
  blocks like the main one (`gate waive gate-config`). A declared repo whose directory is
  gone is an unmet R13 line with no waiver: restore it or abandon the run.
- **Other sessions' commits** in a declared repo are left out the same way as in the main one.

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
  "slop":     true,
  "driver":   "skill:verify",
  "helperNote": "Never run two test runs at once: they share tests/.tmp."
}
```

`driver` may instead be `"cmd:npx playwright test"`: a foreground run of that command by the lead
after the last edit, with exit 0, counts as driving the surface (R4). Setting or changing `driver` mid-task is not a
config change (R13). A plan may declare its size, `gate note plan … --size large`, when the
file count would under-predict it (one 500-line migration). `helperNote` is printed in every
helper's packet under "Standing note"; changing it mid-task is a config change (R13).

The helper prompts hold four standing rules: the skeptic wants every claim the plan makes
about real data (names, rows, config values, ids) to cite the code that writes it or a
read-only query; QA takes rows for real tables from fixtures, exports or the writing code and
names hand-made rows in its reply; the reviewer checks a named audience against the real
callers; an investigation labels a security or exposure finding "from config, unverified"
unless it cites the deployed state or the handler code. An API change is driven by calling
the endpoint.

Facts over assumptions: the context note is refused when a Traced `file:line` does not resolve
(missing file, or a line past its end) or when Related names no existing file and is not
"none: `<the search you ran>`"; a helper finding whose `file:line` does not resolve is recorded
with a note to check it first; in read-only work a claim cites what was run or read, or is
labelled "unverified". A memory, docs or search MCP lookup is not a run. An evidence pointer
is checked: `ledger.md#<section>` needs text under that heading, `ledger.json#<key>` needs a record under one of the run's lists (cases, huddles, waivers, pauses, blast, caveats),
`file:<number>` needs the line inside the file.

## Develop

```
npm test           # the plugin's own suite (node --test)
npm run reinstall  # refresh the user-scope install from this tree; restart the session
```

Layout: `scripts/gate.mjs` (dispatcher) → `scripts/lib/*` (pure modules) · `hooks/` ·
`skills/gate` (the workflow + playbooks) · `skills/verify-setup` · `agents/` · `models.json`.

Ideas borrowed with thanks from Lauren Tan's `poteto-mode` (playbooks with explicit skips,
ownership of delegated work, a per-project verify driver) and from Anthropic's `ralph-loop` (the Stop-hook contract).
