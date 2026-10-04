/**
 * createBranch — start a branch at HEAD, and decide when a new commit needs one.
 *
 * The counterpart to `deleteBranch`, and it owns the same two things: the sentence saying why
 * an operation cannot go ahead, and the ref change itself. `renderModel` carries the sentence
 * to the commit form so the form and the refusal cannot word the rule differently.
 *
 * The rule exists because a commit advances whatever branch HEAD is on. On trunk, `main`
 * moves, and a remote that protects `main` then refuses the push. Moving the commit off
 * afterwards needs a reset, and this extension offers no button for one. A detached HEAD is
 * worse still: the commit belongs to no branch, and nothing but the reflog reaches it.
 *
 * `switch --create` is what runs, before the commit rather than after. It moves no file and
 * leaves the index exactly as it was, so the pathspec commit and the scratch-index one both
 * work unchanged against a dirty working copy. Creating the branch afterwards would mean
 * moving the trunk branch back off the new commit, which is the rewrite this avoids.
 */
import { GitError, GitRunner } from "#git/runner";
import { RawData } from "#git/snapshot";

const COMMAND = "create branch";

/**
 * Why a new commit needs a branch of its own, or null when HEAD's branch can take it.
 *
 * A clause rather than a sentence, so the caller frames it: both the refusal and the commit
 * form open with "Name a branch for this commit".
 */
export function commitBranchRefusal(snapshot: RawData): string | null {
  if (!snapshot.headBranch) {
    return "HEAD is detached, so a commit here would belong to no branch";
  }
  if (snapshot.headBranch === snapshot.trunkBranch) {
    return `${snapshot.headBranch} is the trunk this tree measures every branch against`;
  }
  return null;
}

/**
 * Why `name` cannot be created, or null when it can.
 *
 * Checked here rather than left to git for the reason every refusal in this codebase is: git
 * reports `fatal: a branch named 'x' already exists`, which does not say that the commit was
 * abandoned. A leading dash is rejected separately from the format check, because
 * `check-ref-format` accepts `-f` as a ref component while `switch` reads it as a flag.
 */
async function branchNameRefusal(
  git: GitRunner,
  name: string
): Promise<string | null> {
  if (!name.trim()) {
    return "a branch needs a name";
  }
  if (name.startsWith("-")) {
    return `"${name}" starts with a dash, which git reads as an option`;
  }
  if (!(await git.succeeds(["check-ref-format", `refs/heads/${name}`]))) {
    return `"${name}" is not a valid branch name`;
  }
  if (
    await git.succeeds([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${name}`,
    ])
  ) {
    return `"${name}" already exists here`;
  }
  return null;
}

/**
 * Run `work` on a new branch at HEAD, and take the branch away again if it fails.
 *
 * Shaped like `withScratchIndex`, and for the same reason: the cleanup has to run however the
 * work ends. A `pre-commit` hook that exits non-zero is the ordinary way to reach it, and
 * without the rollback that leaves the reader checked out on an empty branch, with the trunk
 * they started on nowhere on screen and no message naming the cause. `branchNameRefusal` and
 * `commitPaths` both refuse before the branch exists.
 *
 * Both steps back are `tryRun`: the original failure is the one worth reporting, and a
 * rollback that cannot finish must not replace it.
 */
export async function withNewBranch<T>(
  git: GitRunner,
  snapshot: RawData,
  name: string,
  work: () => Promise<T>
): Promise<T> {
  const refusal = await branchNameRefusal(git, name);
  if (refusal) {
    throw new GitError(`Cannot create that branch: ${refusal}.`, COMMAND);
  }
  await git.run(["switch", "--create", name]);
  try {
    return await work();
  } catch (error) {
    await git.tryRun(
      snapshot.headBranch
        ? ["switch", snapshot.headBranch]
        : ["switch", "--detach", snapshot.headSha]
    );
    await git.tryRun(["update-ref", "-d", `refs/heads/${name}`]);
    throw error;
  }
}
