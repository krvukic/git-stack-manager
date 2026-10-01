# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.17.0] - 2026-09-30

### Changed

- Pull request status is looked up through GitHub's GraphQL API — by branch name and by
  tip commit, in batches — rather than through `gh pr list --search`. Free-text search
  read an index that trailed a just-opened pull request and, on a monorepo with many
  checks, could time out and return nothing. The structured lookup still briefly trails a
  just-opened pull request — submitting fills that gap until the next fetch catches up —
  but it no longer times out on a monorepo with many checks.
- Every check on a pull request being cancelled now shows the CI badge as a failure, matching
  GitHub's own rollup, rather than showing no glyph at all.

### Added

- **Refresh PRs** counts off the branches it has answered while its fetch is still in
  flight, for a stack with enough branches to make that fetch worth watching.
- A **Git Stack Manager** output channel logs every pull request fetch's duration and outcome.
  Branch badges fetch on a timer with no action to blame a failure on, so this is where a stale
  "PRs stale — never loaded" indicator sends you, rather than the command log.

### Fixed

- `just package` no longer bundles `.tmp/`, the repo-local scratch directory, into the `.vsix`.

## [0.16.1] - 2026-09-29

### Changed

- [WRITING.md](WRITING.md) states the prose rules for every word this repository ships: comments,
  commit messages, CHANGELOG entries, UI text, and Markdown. AGENTS.md requires that guide on every
  change, and adds the two conventions the guide leaves out, 100-column wrapping and padded table
  cells. STYLE_GUIDE.md keeps commit-message form and the code conventions.
- Five refusals name the control that refused rather than reporting that nothing exists to act on:
  Goto with no local trunk branch, Pull on a detached HEAD, Pull on a branch tracking no remote,
  Fold at the bottom of a stack, and Split on a one-change commit. Two disabled-control
  descriptions follow, for Amend into and Open all files.

## [0.16.0] - 2026-09-28

### Added

- **Move stack onto the remote**, on a stacked commit's menu. Every layer moves to the commit that
  its remote branch holds, where GitHub's own restack leaves it once a lower pull request merges.
  The move pushes nothing, and **Undo** puts the branches back. It refuses when a layer holds a
  commit that the remote does not have, or carries the same changes under a different commit
  message.
- **Delete branch**, on any commit that carries a local branch. Three branches keep the entry and
  name the reason instead: trunk, the branch you have checked out, and a branch that another
  worktree holds. The toast names the reflog when no other ref reaches the commit.

## [0.15.2] - 2026-09-28

### Changed

- Five snapshot baselines re-record. No behaviour changes: each picture shows both the **Clear
  merged** button from 0.14.0 and the stack badges the rebase fixes above corrected.

## [0.15.1] - 2026-09-28

### Changed

- Each of the four rebase entries on a stacked commit says what it moves. The two `gh stack` ones
  replay recorded layers; the two below walk the graph, so they carry a fork above the commit and a
  branch no stack record names, and they re-record the bases of every layer they move.

## [0.15.0] - 2026-09-28

### Added

- A commit menu entry checks out a stack's top layer, the branch Push, Submit, and Sync need.

### Changed

- Push, Submit, and Sync dim while HEAD sits outside the stack, and give the reason under the
  cursor. All three find their stack through the checked-out branch, so from trunk they took the
  click and handed back `branch "main" belongs to multiple stacks; checkout a non-trunk branch
  first`.

## [0.14.4] - 2026-09-28

### Fixed

- The "needs rebase" badge applies `gh stack`'s own test: does the layer hold the tip of the one
  below? It compared the recorded sha before, so a rebase run outside the panel — from the
  terminal, or with `git rebase --update-refs` — badged every layer of a stack that needed nothing.

## [0.14.3] - 2026-09-28

### Fixed

- A rebase brings the `gh stack` record with it. Rebasing a stack moved every layer and left the
  record naming the commits it replaced, so the graph drew "needs rebase" on the stack just
  rebased, and `gh stack submit` would have opened its pull requests against abandoned commits.
  Restack and a rebase resumed after a conflict re-record too.
- When that repair fails, the toast names the `gh stack rebase <bottom> --no-trunk` to run by hand.

## [0.14.2] - 2026-09-28

### Fixed

- The two `gh stack` rebase entries name the layer they were clicked on. Both read the checked-out
  branch before, so from trunk in a repository with two stacks they refused with `branch "main"
  belongs to multiple stacks`.
- "Rebase this layer and above" checks that layer out before running, so it starts where the label
  says. `gh stack rebase --upstack` takes its starting layer from HEAD, and from the top of the
  stack it rebased nothing, reported success, and left the middle layer on an abandoned commit.

## [0.14.1] - 2026-09-28

### Changed

- The Node floor is 24, and `.nvmrc` is the only place it lives: `just init-repo` and CI both read
  it. The unit suite imports the webview's `.mts` modules as source, so Node has to strip types
  without a flag, and 24 is the oldest line where every release does.
- `just init-repo` installs Node through fnm rather than only reporting a version as too old.

### Fixed

- Two trunk tests no longer depend on the contributor's `branch.autoSetupMerge`. Under the `simple`
  this repository recommends, git attached no upstream and both failed on a clean clone.

## [0.14.0] - 2026-09-28

### Added

- **Clear merged** in the top bar sweeps merged branches on demand, whichever way **Auto-remove
  merged commits** stands. It re-reads pull request status first, then names every branch it kept
  and why: amended past the commit that merged, checked out here, held by another worktree, or a
  stopped rebase. Previously a merged branch that stayed gave no reason, which read as a broken
  setting.
- The **Config** setting says when automatic removal runs: as the view opens and as **Refresh PRs**
  finishes, never on a timer of its own.

### Fixed

- One branch that moved no longer keeps the rest of a sweep. `git update-ref` refuses a batch
  whole, so a single amended branch used to save every other merged branch in the same pass.
- A removal git refuses is tried again. The webview recorded a branch as dealt with before asking
  the host, so a refusal — a branch held by another worktree, say — left it permanently untouched
  until its tip moved.

## [0.13.0] - 2026-09-25

### Added

- `just check-ci` runs `just check` without comparing snapshot pictures. GitHub Actions runs it on
  every pull request.
- STYLE_GUIDE.md states the prose and commit message rules that coding agents read.

## [0.12.2] - 2026-09-25

### Changed

- The end-to-end snapshots print a fixed `v0.0.0` in the top bar, so a version bump no longer
  re-records every full-page picture.

## [0.12.1] - 2026-09-25

### Fixed

- A HEAD on an older trunk commit shows "You are here" on a row of its own. A detached checkout of
  that commit, or a branch cut there with no commits yet, used to leave HEAD off the graph. The
  branch, when there is one, gets its pill on that row.

## [0.12.0] - 2026-09-25

### Added

- The graph always shows the local trunk branch. While `main` is level with `origin/main`, its pill
  sits beside `origin/main` on the trunk row. Once a fetch moves `origin/main` on, `main` gets a row
  of its own on trunk, with its own Goto. That row carries "You are here" when `main` is checked
  out.

### Fixed

- After Goto on the trunk row, a background fetch no longer takes "You are here" off the graph.

## [0.11.0] - 2026-09-25

### Added

- **Submit stack**, in the right-click menu and the commit panel, submits every branch from the
  bottom of the stack up to the selected one, bottom first.

### Fixed

- Submitting a branch whose base was never pushed is refused before the push, naming Submit stack.
  GitHub used to reject the pull request with "Base ref must be a branch", after the push.
- The panel refreshes after a commit or checkout in a linked worktree, and after `gh stack` records
  a stack. The watcher looked for `.git` as a directory, which a linked worktree has as a file.

## [0.10.0] - 2026-09-22

### Changed

- **View changes** on the checked-out commit opens VS Code's multi-file diff editor, with each
  file on disk on the right, so every file is editable. Other commits, and the web host, keep the
  read-only overlay.

## [0.9.0] - 2026-09-22

### Changed

- The diff editor for a file in the checked-out commit shows the file on disk on its right side,
  so the diff is editable, as an uncommitted file's is. Any uncommitted edit to the file shows in
  that diff too. Every other commit's diff stays read-only.

## [0.8.0] - 2026-09-22

Committing part of a file, and amending it into any commit under the one you are on.

### Added

- The **±** on an uncommitted file's row opens its change with a box beside every changed line, as
  Sapling's selection does. Every line starts chosen; untick what stays behind, shift-click to set
  a range, or use a hunk's or the file's box for all of its lines. The overlay's footer commits the
  chosen lines, or amends them into HEAD or any commit under it, picked from a list that starts at
  the commit selected in the tree. The choice holds after the overlay closes, so the sidebar's
  **Commit…** and **Amend into** send the same lines, and the row reads "3 of 4 lines". The lines
  left out stay uncommitted, and the working tree is never written.
- A file edited on disk after its lines were chosen goes back to whole, with a toast naming it,
  because the numbers the choice names now point at other lines. The host also refuses a choice
  made against a diff that no longer describes the file, and changes nothing.

### Fixed

- Amending into a commit below one that edited the same file put the whole working file in the
  target, let the later commit revert it, and checked HEAD out over the working file, so the edit
  was lost. Each later commit now keeps exactly its own lines, and a change to one of them is
  refused, naming the commit it belongs in.

## [0.7.1] - 2026-09-22

### Changed

- The **Config** setting that deletes merged branches is titled **Auto-remove merged commits**,
  which names what leaves the tree.

## [0.7.0] - 2026-09-22

Clearing merged branches out of the tree, without risking work the merge never saw.

### Added

- **Config** can delete the local branch once its pull request merges, which takes the branch and
  its commits out of the tree. It is off by default. A branch goes only while its tip is the exact
  commit GitHub reports as the pull request's head, so one amended or added to after the merge
  stays, as do the checked-out branch, a branch another worktree holds, and every branch while a
  rebase is stopped. One `git update-ref` batch deletes them, and it refuses the whole batch if a
  branch moved since the tree was read. Undo brings a deleted branch back, and it is not deleted
  again, even after a reload.

### Changed

- The **Design** drawer is now **Config**, since it holds settings as well as looks. Stored choices
  carry over.

## [0.6.0] - 2026-09-21

Reading a diff and writing a message at the size you chose, not the size the layout picked.

### Added

- The changes overlay resizes from either edge, from 520 pixels wide up to 48 pixels short of each
  window edge. It stays centred, so each edge carries the far one with it and the width changes by
  twice the travel; the margin that remains keeps the tree visible on both sides, which is what says
  a diff is a step in a flow rather than a new place. Tab to an edge and `←` / `→` move it, `Home`
  restores the default — the same three keys the commit panel's divider answers.
- The commit panel's **Description** and the working copy's keep the height you drag their
  bottom-right corner to, and the changes overlay keeps its width. All three hold across a reload
  and across a restart of the editor, and none of them is per commit: a height is how much message
  you want to see and a width is how wide you want to read code, so selecting another commit opens
  at what you last chose. A window too short or too narrow for a stored measurement cuts it back
  rather than hiding the controls around it.

## [0.5.0] - 2026-09-21

Reading an uncommitted change before deciding what to do with it.

### Added

- The **✎ N uncommitted changes** chip opens every uncommitted change in the changes overlay, the
  same view a commit's **View changes** gives. Staged changes are included, so what the overlay
  shows and what the checkboxes commit agree.
- A diff icon on each uncommitted file's row opens that one change: in VS Code, a diff editor with
  the version at HEAD on the left and the file itself on the right, which stays editable — a typo
  noticed while reading is fixed where it is. In the browser, which has no diff editor, the row
  falls back to the overlay scoped to that file. The icon stays on screen rather than waiting for
  the pointer, because it is the only way to read the change; a commit's file row, whose plain click
  opens the same diff, still reveals its icons on hover.
- A file git has never seen is shown too, as every line added, since no `git diff` reports one. An
  untracked image is drawn as a picture, and one too large to draw carries its size instead.

### Changed

- The discard icon is a **✕** and stays on screen rather than appearing on hover, turning the
  deletion colour under the pointer. Hidden, it was a control a reader had to find by sweeping the
  pointer across rows, which is not how anyone looks for a way to undo an edit; the confirmation
  dialog is what guards the click.

## [0.4.1] - 2026-09-21

Seeing an edit in the panel without having to do something to it first.

### Fixed

- A file saved while the smartlog sat in another tab now reaches the uncommitted list. The panel
  watched git's own writes — HEAD, refs, the index — and a save touches none of them, so the list
  stayed as it had been until some action happened to rebuild it. Saving, adding, deleting, or
  renaming a file now refreshes the panel, as does a command finishing in a terminal, the window
  regaining focus, and arriving back at the panel's tab.
- A burst of changes costs two reads rather than one per file: the first arrives immediately and a
  second lands on the state the burst ended in. A commit used to re-read three times over, once per
  git write, and a formatter run over forty files would now have read forty times. A panel off
  screen is not read for at all.

### Changed

- **Refresh repository** is now **Refresh local state**, in the command palette, in the top bar, and
  in the command log. The old name read as though it talked to the remote, which is what *Pull*
  does; the button re-reads the local repository and nothing else.

## [0.4.0] - 2026-09-18

Throwing one uncommitted change away without reaching for a terminal.

### Added

- An icon on each uncommitted file's row discards that file's change, the way Source Control's
  per-file revert does. A tracked file goes back to the version in the commit you are on; a file no
  commit holds yet is deleted. Every other change in the working copy stays.
- The click opens a confirmation naming the file and which of the two outcomes applies, because Undo
  restores refs and a discard moves none — no checkpoint holds content that only ever existed in the
  working tree. A path still being merged is refused outright: resolving it to HEAD would throw away
  the incoming side too, and the rebase banner already offers *Continue* and *Abort*.

## [0.3.0] - 2026-09-18

Opening a commit's files without losing your place in the panel.

### Added

- Holding `⌘` — `Ctrl` off a Mac — while clicking a file in a commit's list opens its tab without
  taking focus. Reading three files took three clicks and three trips back to the panel. The
  modifier works on the row, on its diff icon, and on its file icon; the platform split follows the
  editor's own accelerator, because macOS gives Control-click to the context menu.
- **Open all files**, beside *View changes in hash*, opens every file of the selected commit in the
  order the list shows them, each tab behind the panel. Web mode hands the paths to the desktop's
  own opener, which has no tab to open behind.

## [0.2.0] - 2026-09-18

One feature and the repository work for a public release.

### Added

- The changes overlay draws an image from a commit rather than noting it as binary, and the file
  row opens the copy on disk in VS Code's own editor.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `STYLE_GUIDE.md`, and this changelog.
- A screenshot in the README, recorded by `just screenshot` against the demo repository.
- `just init-repo` installs Bun through Homebrew when it is present, falls back to the upstream
  installer when it is not, and checks the git and node floors before reporting success.
- A 4MB request body cap in the web host, so an oversized POST is refused rather than buffered
  until the process dies.

### Changed

- `just init-repo` no longer needs Python. The packaged `.vsix` filename was read in a top-level
  variable, and just evaluates one of those before running any recipe, so the bootstrap recipe
  depended on a reader it was supposed to install. Both recipes that need the filename now read it
  themselves.
- `just --list` prints a one-line description per recipe. Just shows only the last line of a
  leading comment, so six recipes had been displaying a mid-sentence fragment.
- `just web-bg` keeps its pid and log files under `XDG_RUNTIME_DIR`, not `/tmp`.
- Fixture identities and pull request URLs use the `example.com` and `example` names that RFC 2606
  reserves.
- `learnings.md` is now `LEARNINGS.md`.
- The README hands its build and snapshot sections to `CONTRIBUTING.md`, and every prose file is
  rewrapped at 100 columns.

## 0.1.x

Pre-changelog. The smartlog, both hosts, every history edit, the `gh` integration, and the
end-to-end suite were built across those releases; `git log` is the record.
