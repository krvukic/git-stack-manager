# Design notes

Every history edit here is *computed* rather than replayed as a patch: each commit's new content is
worked out up front, then written with `commit-tree` and one atomic ref update. That is why reword,
absorb, fold, and split cannot conflict, need no checkout, and leave the working copy alone. Each
module's header explains its own mechanism; this document covers what that means for you.

**Rebase** (`src/history/rebase.ts`) leans on `git rebase --update-refs`, so one rebase carries a
whole stack rather than a loop over branches. Two of git's behaviours need working around:
`--update-refs` silently skips the branch HEAD is on, and it tracks refs under `refs/heads` only on
the single chain it replays. So the implementation detaches HEAD first and plants temporary
`gsm-rebase/<n>` markers on fork points. A conflict stops the replay and leaves git's own state for
you to resolve. Because a forked stack can stop with chains still queued, the remainder is
journalled and resumed after *Continue*.

**Absorb** (`src/history/absorbPlacement.ts`) decides which commit each hunk belongs to. It
deliberately does not use `git blame`, which cannot see lines deleted midway up a stack and so
misplaces any hunk spanning that seam. Changes it cannot place confidently are **left in the working
copy** and reported as `"7 of 9 changes absorbed"`, which is what makes it safe to re-run. Not
absorbed at all: added, deleted, and renamed files, binaries, and symlinks. None of those has line
ownership in a usable form. Absorb walks down from HEAD, so a stack branch has to be checked out.

**Commit and amend-into** (`src/history/commit.ts`) take an explicit path list, because the tree's
checkboxes exist to choose what goes in. Two of git's behaviours shape it. A pathspec commit ignores
whatever else is staged and leaves it staged, which is what lets this run against a dirty index
without saving and restoring it. And `git commit -- <path>` rejects a path git does not yet track,
so every selected path is `git add`ed first, which also stages a deletion and so covers modify, add,
and delete on one code path.

Amending into HEAD is git's own `commit --amend`. Anything below HEAD cannot be, since `--amend`
rewrites HEAD's parentage and would orphan the descendants. The content is therefore grafted onto
the target's tree, and `rebuildStack` recreates the commits above it. Every descendant needs the
graft too, not just the target: `rebuildStack` reuses a commit's original tree unless given a new
one, and that tree still holds the pre-amend content, so grafting only the target leaves the next
commit up reverting it. A descendant that changes the same path keeps its own version, since the
user edited that content later.

The target has to be an ancestor of HEAD. Working-copy content only makes sense in a commit the
working copy descends from: grafting sideways into another branch put the change in two places at
once, because the checkout that clears the working copy reads HEAD, which never received it. Sapling
has the same rule, and its `amend` only ever targets the commit you are on.

**Fold** keeps the upper commit's tree, which already contains both changes. **Split** gives the
second commit the original tree, so whatever the first does not take is by definition what remains.
The pair therefore ends exactly where the single commit did.

**Undo** (`src/history/undo.ts`) restores the refs an edit moved, so it works for every command
rather than one at a time. It never touches your working copy: restoring refs recovers the history,
and reverting your uncommitted edits to get there would be worse than the problem. If a branch moved
outside the extension since the edit, undo refuses and changes nothing. Checkpoints live in memory,
so they last for the session.

**Pull request data** has two very different costs. Sync state is free, because `%(upstream:track)`
is already part of the ref read, so "has unsubmitted changes" adds no git command. Pull request
status needs a ~1s `gh pr list`, comparable to the whole rest of the read, so it never sits in the
render path: one call covers every branch, the result is cached for a minute, and the first paint
uses whatever is cached. A missing `gh`, a non-GitHub remote, or an unauthenticated CLI all degrade
to "no badges", since a plain git repository is a supported case.

That one call names the branches on screen rather than asking for the repository's newest 200 pull
requests. On a monorepo the unscoped form exceeds GitHub's GraphQL time budget and answers HTTP 504,
so no badge ever arrives. It also misses any pull request that has dropped out of the newest 200,
which on a busy repository takes days.

Each branch contributes its tip commit as a second search term, because a name alone cannot find
every pull request. Sapling and `gh stack` push under a server-side branch of their own choosing, so
a local `dev/playwright_readme` becomes `pr26403`. No name-keyed lookup can match that, and the
commit reads unsubmitted long after its pull request merged. The sha finds it whatever the remote
branch was called. GitHub's `head:` qualifier also matches by prefix, so `head:main` returns
`main-refactor` too; the response is filtered against the names actually asked for rather than
trusted.

For the same reason, a missing local upstream is reported as **no local upstream** when a pull
request exists for the commit, not as "not submitted". The branch tracks nothing here, but the work
has plainly been submitted.

Stack membership comes from `.git/gh-stack`, the `gh stack` extension's own state file, which is a
file read rather than a subprocess. Where `gh stack` has a command, this extension calls it: `gh
stack` owns the server-side stack object and pushes with `--force-with-lease`, so a parallel
implementation would only drift from GitHub's view.

**Submit** (`src/github/submit.ts`) exists because pushing and describing a change are two separate
things on GitHub. The push updates the branch; the pull request's title and body are set once, at
creation, from whatever the commit said then. So amending a message and force-pushing leaves the
pull request describing the old message, with nothing on screen to say so. Submit therefore always
writes the message across, subject to title and remainder to body, rather than trusting the push to
carry it. It is one button rather than a "push code" and "push message" pair, because two buttons
can disagree and that disagreement is the bug.

Its push uses `--force-with-lease` **and** `--force-if-includes`. The lease alone is not enough
here: it compares against the remote-tracking ref, which this extension's own fetch (every rebase
and restack does one) has already moved past a teammate's commit. With only the lease, that push
reports "forced update" and their work is gone. `--force-if-includes` also requires that the commits
being replaced are ones this checkout has seen, which rejects it. The refspec is explicit and `-u`
is set because the branch being submitted is usually not the checked-out one. Without `-u` it would
be left with no upstream, and the tree would still read "not submitted" after a successful push.
