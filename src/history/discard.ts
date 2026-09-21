/**
 * discard — throw one working-copy change away, the way Source Control's per-file revert does.
 *
 * The status letter plays no part in choosing the commands. Every letter a discard has to
 * handle — modified, added, deleted, renamed, type-changed, staged or not — reduces to one
 * question: does HEAD have a version of this path? If it does, `checkout HEAD --` puts both
 * the index and the working tree back to it, which covers a modification and a deletion in one
 * command. If it does not, the path only exists because someone created it, so it leaves the
 * index and then the working tree. Switching on the letter instead would need a branch per
 * letter and would still be wrong for the pairs git reports together.
 *
 * A rename is the case that makes the pairing visible: git reports `R` against the *new* path,
 * and HEAD only knows the old one. Discarding the new path alone would restore nothing and
 * leave the file missing, so `oldPath` joins the target list and lands in the restore half.
 *
 * Nothing here is undoable, and that is not an oversight: `UndoHistory` restores refs, and no
 * ref moves. The content is gone once git overwrites the working tree, which is why the UI
 * confirms first.
 */
import { uniqueSorted } from "#core/values";
import { GitError, GitRunner } from "#git/runner";
import { FileChange, RawData } from "#git/snapshot";

export type DiscardResult = {
  /** Paths put back to the content HEAD holds. */
  restored: string[];
  /** Paths removed from the working tree, because HEAD has no version of them. */
  removed: string[];
};

/**
 * Discard `paths`, which must name changes the snapshot reports.
 *
 * The two halves run restore-first so a failure leaves the loud half done rather than the
 * quiet one: a `checkout` that fails on a locked file stops before anything is deleted.
 */
export async function discardPaths(
  git: GitRunner,
  snapshot: RawData,
  paths: string[]
): Promise<DiscardResult> {
  const changes = requireDiscardable(snapshot, paths);
  const targets = uniqueSorted(
    changes.flatMap(change =>
      change.oldPath ? [change.path, change.oldPath] : [change.path]
    )
  );
  const inHead = await pathsInHead(git, targets);
  const restored = targets.filter(path => inHead.has(path));
  const removed = targets.filter(path => !inHead.has(path));

  if (restored.length) {
    // One command for the index and the working tree both: a discard that left the staged
    // copy behind would redraw the file as still changed the moment the panel refreshed.
    await git.run(["checkout", "HEAD", "--", ...restored]);
  }
  if (removed.length) {
    // `clean` only deletes what git does not track, so a staged addition has to leave the
    // index first. `--ignore-unmatch` is what lets the never-staged case share the command.
    await git.run([
      "rm",
      "-q",
      "--cached",
      "--ignore-unmatch",
      "--",
      ...removed,
    ]);
    // `-d` covers an untracked *directory*: `status` collapses one into a single entry with a
    // trailing slash, and `clean` without `-d` refuses to descend into it.
    await git.run(["clean", "-q", "-fd", "--", ...removed]);
  }
  return { restored, removed };
}

/**
 * Which of `paths` HEAD holds a version of.
 *
 * One `ls-tree` rather than a probe per path, and `tryRun` because a repository with no commit
 * yet has no HEAD to read — there every change is an addition, so an empty answer is correct
 * rather than an error.
 */
async function pathsInHead(
  git: GitRunner,
  paths: string[]
): Promise<Set<string>> {
  const output = await git.tryRun([
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    "HEAD",
    "--",
    ...paths,
  ]);
  return new Set((output ?? "").split("\0").filter(Boolean));
}

/**
 * The changes `paths` names, refusing anything a discard must not touch.
 *
 * An unmerged path is refused rather than resolved to HEAD. `checkout HEAD --` on one throws
 * away both sides of the merge *and* git's record that a conflict existed, so a reader who
 * meant "undo my edit" would lose the incoming commit's version with no way back. Resolving
 * or aborting the rebase is the operation they want, and both are already on the banner.
 */
function requireDiscardable(snapshot: RawData, paths: string[]): FileChange[] {
  const wanted = new Set(paths.filter(path => path.length > 0));
  if (!wanted.size) {
    throw new GitError("Select at least one change to discard.", "discard");
  }
  const changes = snapshot.uncommitted.filter(file => wanted.has(file.path));
  const found = new Set(changes.map(change => change.path));
  const unknown = [...wanted].filter(path => !found.has(path));
  if (unknown.length) {
    throw new GitError(
      `Not an uncommitted change: ${unknown.join(", ")}`,
      "discard"
    );
  }
  const unmerged = changes.filter(change => change.status === "U");
  if (unmerged.length) {
    throw new GitError(
      `${unmerged.map(change => change.path).join(", ")} is still being merged. ` +
        "Resolve the conflict or abort the rebase — discarding it would throw away the " +
        "other side of the merge too.",
      "discard"
    );
  }
  return changes;
}
