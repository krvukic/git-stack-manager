# Contributing

Issues and pull requests are welcome. There is no contributor agreement to sign.

## Getting set up

[just](https://github.com/casey/just) runs every task and wraps [Bun](https://bun.sh). Run
`just --list` for the full set, each with a one-line description.

```bash
just init-repo   # install Bun, and check the git and node floors
just init-e2e    # install the one Chromium build the end-to-end suite drives
just build       # install dependencies, compile
```

Then pick a host to work against:

```bash
just dev                        # VS Code window with the extension loaded
just web /path/to/repo 4000     # serve the UI, defaults to this repo on 6175
just demo                       # generate the "strkit" demo repo and serve its smartlog
just install                    # build a .vsix and install it
```

`just dev` needs no `.vscode/launch.json`, because it passes `--extensionDevelopmentPath`. Press
F5 instead when you want a debugger attached, which does need a launch config. Reload the VS Code
window after `just install`, since the running instance keeps the old copy loaded.

## Before opening a pull request

`just check` runs everything a change has to pass: formatting, types, lint, and both suites. The
parts, when one of them is what you are iterating on:

```bash
just typecheck                  # tsc --noEmit, across all three projects
just lint                       # ESLint; `just lint-fix` applies what it can
just format                     # Prettier; `just format-check` only reports
just test                       # unit and integration suites, on throwaway repos
just test-e2e                   # drive the real UI, and compare snapshots
just test-e2e-update            # re-record those snapshots; review the diff
just test-e2e-report            # open the report from the last e2e run
```

Every change also bumps `version` in `package.json` and adds a line to
[CHANGELOG.md](CHANGELOG.md). [AGENTS.md](AGENTS.md) states the same rule for coding agents.

## Code layout

`src/` is layered bottom-up through Node subpath imports such as `#git/runner`:

| Directory  | Holds                                            |
| ---------- | ------------------------------------------------ |
| `core/`    | Helpers with no dependencies of their own        |
| `git/`     | Running git, knowing nothing about the UI        |
| `history/` | The history edits                                |
| `github/`  | The `gh` integration                             |
| `ui/`      | Turning a snapshot into rows                     |
| `app/`     | The facade both hosts drive                      |
| `hosts/`   | The two entry points, extension and web server   |
| `webview/` | The React app both hosts load                    |

Each module's header explains its own mechanism. [DESIGN_NOTES.md](DESIGN_NOTES.md) covers why the
history edits work the way they do, and [LEARNINGS.md](LEARNINGS.md) records the cross-cutting
traps found while building the webview.

## Style

[STYLE_GUIDE.md](STYLE_GUIDE.md) is the whole of it. ESLint enforces the machine-checkable subset,
so `eslint.config.mjs` is where each of those rules carries the reason it exists. Prettier owns
layout and import order, which keeps both out of review. It covers `ts` and `mjs` sources only,
leaving HTML and Markdown alone, and it does not reflow prose inside comments: that is hard-wrapped
at 100 columns by hand.

## End-to-end snapshots

`test/e2e/` drives the whole stack rather than a module. Playwright loads the real web host against
a copy of the demo repository, clicks through an operation, then photographs the result **and**
asserts the resulting git state. The picture catches a graph that redraws wrong, the git assertions
catch a rewrite that lands wrong, and those assertions are also what keeps
`just test-e2e-update` from accepting a bad picture.

Snapshots are screenshots because the graph *is* the product. A serialised DOM records that a
badge's class changed. Only a picture shows that the badge now overlaps the branch pill, or that a
rail curves into the wrong lane. A failing test writes the actual and diff images beside the
expected one, so reviewing `test/e2e/snapshots/` *is* the workflow.
`test/e2e/fixtures/snapshot.mjs` documents what each picture captures and what it deliberately
leaves out.

Comparison runs through [odiff](https://github.com/dmtrKovalenko/odiff) via `playwright-odiff`,
tolerating a 0.0001 pixel ratio — about 140 pixels at this viewport, a short word — and overriding
the library's `threshold` and antialiasing defaults, which are loose enough to read a picture of the
wrong UI as equal. `just test-e2e-update` records with `--update-snapshots=all` rather than the bare
flag, since the bare flag corrects only what failed and leaves a drift small enough to pass in
place. `test/e2e/fixtures/snapshot.mjs` gives the numbers and what the old ones cost.

The images are recorded on Linux, and their path carries no `{platform}` segment on purpose. A
per-platform baseline is in practice a per-developer baseline, and the second one goes stale. Text
rendering differs enough between platforms that these tests may exceed the tolerance on macOS. When
they do, `just test` still covers the logic, and the images are best re-recorded from a Linux
checkout.

`just screenshot` re-records `media/screenshot.png`, the picture in the README, from the same demo
repository. It is not part of `just check`, so re-record it when a change alters the layout.

## Held-back dependencies

`bun outdated` is expected to list these two:

- **`@types/vscode` 1.106**, against 1.125 released. The types *are* the floor in `engines.vscode`.
  Raising them lets code call APIs that VS Code 1.106 does not have, and nothing fails until a user
  on 1.106 runs it.
- **`typescript` 5.9**, against 7.0 released. `typescript-eslint` 8 peers on `typescript <6.1`, and
  no release supports 7 yet. Upgrading silently drops every type-aware lint rule.
