/**
 * pruneMerged — delete the local branches whose pull request merged.
 *
 * A squash or rebase merge lands new commits on trunk, so the branch that was merged keeps
 * its own and goes on drawing a row with a merged badge until someone deletes it. Deleting
 * the branch is what takes those commits out of the tree: they stay in the object store,
 * reachable from the reflog, and Undo recreates the branch.
 *
 * The proof that a branch holds nothing new is that its tip is the exact commit GitHub
 * reports as the pull request's head. A branch amended after the merge, or one that gained
 * a commit, points elsewhere and is kept — deleting it would lose the only copy of that work.
 * The check runs twice: once against the snapshot, and again inside the deletion itself,
 * because `update-ref` refuses to delete a ref whose value is not the one it was given. A
 * commit made between the read and the delete therefore aborts the whole batch.
 */
import { errorMessage } from "#core/values";
import { GitError, GitRunner } from "#git/runner";
import { RawData } from "#git/snapshot";
import { BranchTip, PullRequestStatus } from "#github/pullRequests";

/**
 * The branches safe to delete: a merged pull request whose head is the branch's tip.
 *
 * Three kinds are kept whatever their pull request says. The checked-out branch, since
 * deleting it leaves HEAD pointing at nothing. A branch another worktree holds, which git
 * refuses to delete for the same reason. And every branch while a rebase is stopped, because
 * the rebase moves its branch when it finishes and a deleted one makes it fail.
 */
export function mergedBranches(
  snapshot: RawData,
  pullRequests: Map<string, PullRequestStatus>
): BranchTip[] {
  if (snapshot.conflict) {
    return [];
  }
  return snapshot.commits.flatMap(commit =>
    commit.branches
      .filter(name => {
        const pullRequest = pullRequests.get(name);
        return (
          pullRequest?.state === "MERGED" &&
          pullRequest.headSha === commit.sha &&
          name !== snapshot.headBranch &&
          name !== snapshot.trunkBranch &&
          !snapshot.heldBranches.has(name)
        );
      })
      .map(name => ({ name, sha: commit.sha }))
  );
}

/**
 * Delete the branches in `requested` that `mergedBranches` still names, and answer which
 * ones went.
 *
 * The caller names the branches rather than taking every candidate, so a branch Undo brought
 * back is not deleted again when another pull request merges. A requested branch that no
 * longer qualifies is skipped, not refused: the rule is the host's, and the request may
 * predate a commit on it.
 *
 * One `update-ref --stdin` batch, so either every branch goes or none does. Each branch's
 * `branch.<name>` config goes too, as `git branch -D` would remove it: left behind, a branch
 * later created under the same name silently inherits the old upstream.
 */
export async function deleteMergedBranches(
  git: GitRunner,
  snapshot: RawData,
  pullRequests: Map<string, PullRequestStatus>,
  requested: string[]
): Promise<string[]> {
  const wanted = new Set(requested);
  const branches = mergedBranches(snapshot, pullRequests).filter(branch =>
    wanted.has(branch.name)
  );
  if (!branches.length) {
    return [];
  }
  try {
    await git.run(["update-ref", "--stdin", "-z"], {
      input: branches
        .map(branch => `delete refs/heads/${branch.name}\0${branch.sha}\0`)
        .join(""),
    });
  } catch (error: unknown) {
    throw new GitError(
      `Kept ${branches.map(branch => branch.name).join(", ")}: a branch moved after its pull request merged, so nothing was deleted. ${errorMessage(error)}`,
      "delete merged branches"
    );
  }
  for (const branch of branches) {
    // Absent for a branch that never had an upstream, which is not a failure.
    await git.tryRun(["config", "--remove-section", `branch.${branch.name}`]);
  }
  return branches.map(branch => branch.name);
}
