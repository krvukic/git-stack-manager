# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
