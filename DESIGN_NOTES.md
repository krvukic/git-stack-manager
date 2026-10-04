# Design notes

Every history edit here is *computed* rather than replayed as a patch: each commit's new content is
worked out up front, then written with `commit-tree` and one atomic ref update. That is why reword,
absorb, fold, and split cannot conflict, need no checkout, and leave the working copy alone. Each
module's header explains its own mechanism; this document covers what that means for you.

**Rebase** (`src/history/rebase.ts`) delegates to `git rebase --update-refs`, so one rebase carries
a whole stack rather than a loop over branches. Two of git's behaviours force a workaround:
`--update-refs` silently skips the branch HEAD is on, and it tracks refs under `refs/heads` only on
the single chain it replays. The implementation therefore detaches HEAD first and plants temporary
`gsm-rebase/<n>` markers on fork points. A conflict stops the replay and leaves git's own state for
you to resolve. Because a forked stack can stop with chains still queued, rebase journals the
remainder and resumes it after *Continue*.

**Absorb** (`src/history/absorbPlacement.ts`) works out which commit each hunk belongs to. It
deliberately does not use `git blame`, which cannot see lines deleted midway up a stack and so
misplaces any hunk spanning that seam. Absorb leaves the changes it cannot place confidently **in
the working copy** and reports `"7 of 9 changes absorbed"`, which is what makes a re-run safe. It
never places an added, deleted, or renamed file, a binary, or a symbolic link, because none of those
has line ownership in a usable form. Absorb walks down from HEAD, so a stack branch has to be
checked out.

**Commit and amend-into** (`src/history/commit.ts`) take an explicit path list, because the tree's
checkboxes exist to choose what goes in. Two of git's behaviours shape it. A pathspec commit ignores
whatever else is staged and leaves it staged, which lets the commit run against a dirty index
without saving and restoring it. And `git commit -- <path>` rejects a path git does not yet track,
so commit `git add`s every selected path first, which also stages a deletion and so covers modify,
add, and delete on one code path.

A new commit can also **start a branch** (`src/history/createBranch.ts`), and on trunk it has to.
A commit advances whatever branch HEAD is on, so one made on `main` leaves the work on the single
branch a protected remote refuses a push to. Moving it off again needs a reset, and this extension
offers no button for one. A detached HEAD is the same problem one step worse: nothing but the
reflog reaches the commit.

`git switch --create` runs *before* the commit rather than after. It moves no file and leaves the
index untouched, so both commit paths work against a dirty working copy unchanged. Creating the
branch afterwards would instead mean moving the trunk branch back off the new commit. A commit that
then fails (a rejecting hook is the ordinary case) puts HEAD back and removes the branch, or the
reader is left on an empty branch with the trunk they started on nowhere on screen.

One function owns both the rule and its wording, and `RenderModel.commitNeedsBranch` carries that
wording to the form. The form reads that field to know whether to insist, and prints its sentence
unchanged — the same split `deletionRefusal` already uses.

**Choosing lines** (`src/history/partialSelection.ts`) follows Sapling: every changed line starts
chosen, so a selection records the lines left out, and a file taken whole sends nothing. A pathspec
commit takes each path whole from the working tree, so `src/history/chosenChanges.ts` commits a
selection with any partly chosen file from a scratch index instead. The index starts as HEAD,
`git add` stages the chosen paths so clean filters and modes apply, and a blob rebuilt from the
file's two blobs replaces each partly chosen file. Nothing writes the working tree, so the lines
left out stay exactly where they were.

A selection names a line by its side and number, because two lines can carry identical text. Those
numbers belong to one diff, so each file's choice carries a fingerprint of that diff.
The host refuses a stale fingerprint with nothing changed. The webview asks for fingerprints after
every refresh and puts a file whose diff moved back to whole, since committing the old numbers
would leave out a different line.

Amend into HEAD is git's own `commit --amend`. No commit below HEAD can use it, since `--amend`
rewrites HEAD's parentage and would orphan the descendants. `amendIntoAncestor` therefore gives
each commit from the target up its own copy of every changed file, and `rebuildStack` recreates
them. A file no later commit touched takes the new content everywhere. A text file a later commit
edited goes line by line through `amendPlacement`, which puts the change in the target and leaves
each later commit exactly its own lines. `amendPlacement` refuses a change that would rewrite a
later commit's line, naming that commit. An earlier amend grafted the whole working file into the
target, which put the later commit's edit in the target and let the later commit revert it.

The target has to be an ancestor of HEAD. Working-copy content only makes sense in a commit the
working copy descends from: a graft sideways into another branch puts the change in two places at
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

**Pull request data** has two costs, one free and one around a second. Sync state is free, because
`%(upstream:track)` is already part of the ref read, so "has unsubmitted changes" adds no git
command. Pull request status needs a ~1s `gh pr list`, comparable to the whole rest of the read, so
it never runs in the render path: one call covers every branch, the cache holds the result for a
minute, and the first paint uses whatever the cache holds. A missing `gh`, a non-GitHub remote, or
an unauthenticated CLI all degrade to "no badges", since a plain git repository is a supported case.

That one call names the branches on screen rather than asking for the repository's newest 200 pull
requests. On a monorepo the unscoped form exceeds GitHub's GraphQL time budget and answers HTTP 504,
so no badge ever arrives. The unscoped form also misses any pull request that has dropped out of the
newest 200, which on a busy repository takes days.

Each branch contributes its tip commit as a second search term, because a name alone cannot find
every pull request. Sapling and `gh stack` push under a server-side branch of their own choosing, so
a local `dev/playwright_readme` becomes `pr26403`. No name-keyed lookup can match that, and the
commit reads unsubmitted long after its pull request merged. The sha finds it whatever the remote
branch was called. GitHub's `head:` qualifier also matches by prefix, so `head:main` returns
`main-refactor` too; the lookup filters the response against the names it asked for rather than
trusting it.

For the same reason, the badge reads **no local upstream** rather than "not submitted" when a pull
request exists for the commit. The branch tracks nothing here, but the work has plainly been
submitted.

Stack membership comes from `.git/gh-stack`, the `gh stack` extension's own state file, which is a
file read rather than a subprocess. Where `gh stack` has a command, this extension calls it: `gh
stack` owns the server-side stack object and pushes with `--force-with-lease`, so a parallel
implementation would only drift from GitHub's view.

**Submit** (`src/github/submit.ts`) exists because pushing and describing a change are two separate
things on GitHub. The push updates the branch, and GitHub sets the pull request's title and body
once, at creation, from whatever the commit message said then. An amended message plus a force push
therefore leaves the pull request describing the old message, with nothing on screen to say so.
Submit always writes the message across, subject to title and remainder to body, rather than
trusting the push to carry it. It is one button rather than a "push code" and "push message" pair,
because two buttons can disagree and that disagreement is the bug.

Its push uses `--force-with-lease` **and** `--force-if-includes`. The lease alone is not enough
here: it compares against the remote-tracking ref, which this extension's own fetch (every rebase
and restack does one) has already moved past a teammate's commit. With only the lease, that push
reports "forced update" and their work is gone. `--force-if-includes` also requires that this
checkout has seen the commits being replaced, which makes git reject that push. Submit names the
refspec explicitly and passes `-u`, because the branch it submits is usually not the checked-out
one. Without `-u` that branch would end up with no upstream, and the tree would still read "not
submitted" after a successful push.
