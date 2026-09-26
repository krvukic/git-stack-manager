# AGENTS.md

Repository rules for coding agents. They apply to a human contributor too;
[CONTRIBUTING.md](CONTRIBUTING.md) is the fuller version of the same ground.

## Every change bumps the version

Before finishing, raise `version` in `package.json` and add the change under a new heading in
[CHANGELOG.md](CHANGELOG.md):

- Patch for a fix a user would not describe as new behaviour.
- Minor for a new action, badge, setting, or recipe.
- Major when an existing setting or command stops working.

The version is not decoration. The top bar prints it, and `just package` names the `.vsix` after it.
The snapshot baselines print a fixed `v0.0.0` instead, so a bump re-records no picture.

## Tag once the commit is on main

One annotated tag per released version, named `v<version>`:

```bash
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

Leave the tag to the maintainer while the commit is still on a branch. A tag on a branch that later
gets rewritten points at a commit nothing reaches.

## What a change has to pass

`just check` covers formatting, types, lint, and both suites.

`just test-e2e-update` rewrites every failing picture without asking, so read each changed PNG and
name the cause before committing it. `test/e2e/fixtures/snapshot.mjs` documents the two traps that
make a blind re-record dangerous. A failing snapshot aborts its test, yet the later snapshots in
that same test get rewritten anyway, so count the changed files rather than the failures. And a
picture holds hover state, so a context menu grown in one place can move a Goto button hundreds of
pixels away, which looks like a graph bug and is not one.

## Read before editing

- [STYLE_GUIDE.md](STYLE_GUIDE.md) for prose and TypeScript. ESLint enforces the subset a linter can
  check, and `eslint.config.mjs` gives each of those rules its reason.
- [DESIGN_NOTES.md](DESIGN_NOTES.md) before anything under `src/history/`. Every edit there is
  computed rather than replayed as a patch, and that choice is not visible from the code alone.
- [LEARNINGS.md](LEARNINGS.md) before the webview's CSS or class lists. Each entry is a trap where
  nothing throws: the build succeeds and the screen is subtly wrong.

Product vocabulary from another project does not belong in this repository.
