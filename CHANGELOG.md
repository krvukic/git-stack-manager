# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
