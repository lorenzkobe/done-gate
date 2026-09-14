---
name: verify-setup
description: Generate a project-local /verify driver skill that launches the real app and drives it the way a user would, so done-gate's R4 rule has something to run. Use once per repo, or when the app's surface changed enough that the driver is stale.
---

# verify-setup

Writes `.claude/skills/verify/SKILL.md` (+ `features/`) in the current repo. The next
agent reads it cold, mid-task, having never seen the app, so it must be concrete: real
commands, real routes, real selectors.

## 1. Interview the repo, not the user

Answer from the codebase; ask only what you cannot observe:

- **Surface**: web UI, CLI, API, mobile, library? Pick the primary; note the rest.
- **Run**: the documented dev command (package scripts, Makefile, README), port, env vars,
  seed data, auth. If the checkout does not start as-is, fix or report that first.
- **Drive**: for a web app, the Claude-in-Chrome tools (`tabs_create_mcp`, `navigate`,
  `resize_window`, `computer`, `read_page`, `find`, `read_console_messages`,
  `read_network_requests`). Existing harnesses (Playwright, curl-able endpoints) come first
  when present. Prefer stable handles: routes, ARIA labels, data attributes, visible text.
- **Observe**: what proves a feature worked — a visible state, a network response, a
  console line, a DB row, a file.
- **Isolate**: can two instances run side by side? If not, the driver must refuse to
  double-drive a shared instance.

## 2. Write the driver

`.claude/skills/verify/SKILL.md` with frontmatter (`name: verify`, a description naming the
app and surface) and these sections, no placeholders:

- **Launch**: the exact start command, how to tell it is ready (a port answering, a log
  line), and teardown. Say whether a running instance can be reused.
- **Doctor**: one read-only check that says "this instance is worth driving" (port owned by
  us, right build, signed-in state).
- **Drive**: the recipe with this repo's real routes and selectors. For a web app: **open at
  a 360 px-wide viewport first**, then desktop; watch the console and network tabs, not
  only the screen, because a query that fails soft renders like an empty state.
- **Evidence**: what to capture (the hooks already log every browser call as events; add a
  `gate decide driver ...` row per feature naming what was driven and the observable
  result; screenshots stay in the transcript). Exercise the real user path, never a
  test-only endpoint; verify side effects beside what is visible.
- **Cleanup**: stop only what you started; never kill by process name; evidence survives.
- **Helpers**: any script the driver ships is executable and its invocation shown.

## 3. Seed the feature map

`.claude/skills/verify/features/README.md` plus one file per user-facing feature (top 3–5
from routes, nav, docs). Each: what it is, how a user reaches it, how to drive it with the
harness, what end state proves it, gotchas.

## 4. Prove it before handing over

Run the driver's own instructions once end to end: launch, doctor, drive ONE mapped
feature at 360 px, capture evidence, clean up. Fix what fails. A generated driver that was
never executed is a draft, not a deliverable; say so if you could not run it (for example
the Chrome extension was not connected) rather than presenting it as proven.

## 5. Point gate.json at it

Set `"driver": "skill:verify"` in `.claude/gate.json` so R4's message names the driver.
