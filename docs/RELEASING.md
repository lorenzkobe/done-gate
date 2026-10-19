# Releasing done-gate

Projects install done-gate from GitHub (`lorenzkobe/done-gate`). A push to `main` with a new
version is a release: every project that updates gets it. So nothing is pushed until the
owner has read what changed and said "push".

## The freeze

After a release, real work runs on it for two weeks before anything new is built. During
the freeze only a crash, or something that stops work, is fixed, as a patch (0.18.1, 0.18.2).
No new rules and no new features.

## Friction goes in one place

Whatever gets in the way during real work goes into `docs/friction.md`: what happened, in
which project and run, and when. Nothing is changed straight from a review or from theory;
a change needs an entry there with real evidence.

## One release at the end of the freeze

1. Read `docs/friction.md` and the run records, and propose a short list: each problem in
   plain words, the fix, and what is left out and why.
2. The owner picks.
3. Build it, one run per item, with tests first. Try the result in a throwaway copy of a
   real project (`claude --plugin-dir <this repo>`), never in the real one.
4. Give the owner the list of problems and what was done.
5. Push only when the owner says "push".

## A release does not grow the plugin

A release that adds a rule removes or simplifies one. Advice that never blocks is preferred
over a new rule.

## Proof that a release is safe to install

- `npm test` passes in full.
- A run opened on the previous version is read by the new one with only its normal open
  items (open it with the installed copy, then run `gate check` with this repo's
  `scripts/gate.mjs`).
- The three manifests (`package.json`, `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`) carry the same new version.
- After the owner updates (`claude plugin marketplace update done-gate`, then
  `claude plugin update done-gate@done-gate --scope user -y`, then `/reload-plugins`), the
  installed copy in `~/.claude/plugins/cache/done-gate/done-gate/<version>/` matches the repo.
