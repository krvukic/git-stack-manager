/**
 * pruneMerged — delete the local branches whose pull request merged, and say why the rest stay.
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
 * because `update-ref` refuses to delete a ref whose value is not the one it was given.
 *
 * Every branch it keeps carries the reason, because a merged badge next to a branch that
 * stays otherwise reads as a broken setting. The reason is written once here, on
 * `RenderModel.mergedBranches`.
 */
import { errorMessage, shortSha } from "#core/values";
import { GitRunner } from "#git/runner";
import { RawData } from "#git/snapshot";
import { BranchTip, PullRequestStatus } from "#github/pullRequests";

export type MergedBranch = BranchTip & {
  /** Why the branch stays, naming what would let it go. Null when it can be deleted. */
  keptReason: string | null;
};

export type MergedDeletion = {
  /** The branches deleted, in the order they were asked for. */
  deleted: string[];
  /** Every merged branch that stayed, each carrying its reason. */
  kept: MergedBranch[];
};

/**
 * Why `branch` stays, or null when nothing stands in the way.
 *
 * Ordered by how long each obstacle lasts. A stopped rebase covers the whole repository and
 * moves branches when it finishes, so a deletion now makes it fail. A tip past the merged
 * commit is a property of the branch itself, and outranks the two transient rules below it:
 * telling a reader to check out trunk first, when checking out trunk still would not let the
 * branch go, sends them the wrong way.
 */
function keptReason(
  snapshot: RawData,
  branch: BranchTip,
  pullRequest: PullRequestStatus
): string | null {
  if (snapshot.conflict) {
    return "a rebase is stopped — finish or abort it first";
  }
  if (!pullRequest.headSha) {
    return "GitHub reported no head commit for its pull request, so nothing proves the branch unchanged";
  }
  if (pullRequest.headSha !== branch.sha) {
    return `it holds commits its pull request never had (at ${shortSha(branch.sha)}, not the ${shortSha(pullRequest.headSha)} that merged)`;
  }
  if (branch.name === snapshot.headBranch) {
    return "you have it checked out — check out trunk first";
  }
  const worktree = snapshot.heldBranches.get(branch.name);
  if (worktree) {
    // git refuses to delete it for the same reason the checked-out branch is refused.
    return `another worktree holds it (${worktree})`;
  }
  return null;
}

/**
 * Every branch in the tree whose pull request merged: the ones safe to delete carry a null
 * reason, the rest carry theirs.
 *
 * Reaches only the branches the tree drew, since it walks the snapshot's commits. A branch
 * merged by a merge commit or a fast-forward already sits on trunk, so the walk never returns
 * its commit and nothing here names it — it draws no row to clear either.
 *
 * Trunk is left out rather than reported: a fork's trunk can carry a merged pull request, and
 * deleting the branch the tree measures everything against is never the intent.
 */
export function mergedBranches(
  snapshot: RawData,
  pullRequests: Map<string, PullRequestStatus>
): MergedBranch[] {
  return snapshot.commits.flatMap(commit =>
    commit.branches.flatMap(name => {
      const pullRequest = pullRequests.get(name);
      if (pullRequest?.state !== "MERGED" || name === snapshot.trunkBranch) {
        return [];
      }
      const branch = { name, sha: commit.sha };
      return [
        { ...branch, keptReason: keptReason(snapshot, branch, pullRequest) },
      ];
    })
  );
}

/**
 * Delete one batch of branches, answering git's complaint, or null when every ref went.
 *
 * Each `delete` names the sha the branch is expected to hold, so `update-ref` refuses the
 * whole batch when one branch has moved since the snapshot was read.
 */
async function deleteRefs(
  git: GitRunner,
  branches: BranchTip[]
): Promise<string | null> {
  try {
    await git.run(["update-ref", "--stdin", "-z"], {
      input: branches
        .map(branch => `delete refs/heads/${branch.name}\0${branch.sha}\0`)
        .join(""),
    });
    return null;
  } catch (error: unknown) {
    return errorMessage(error).split("\n")[0] ?? "";
  }
}

/**
 * Delete the merged branches `requested` names, and answer what went alongside what stayed.
 *
 * An explicit name list lets the automatic path skip one Undo brought back: it asks for the
 * branches it has not asked for before, so nothing deletes a hand-restored branch again when the
 * next pull request merges. Skips a requested branch that no longer qualifies rather than refusing
 * it: the rule is the host's, and the request may predate a commit on it.
 *
 * One `update-ref --stdin` batch in the ordinary case, and one call per branch only after that
 * batch is refused. The batch used to be the whole story, which meant a single branch committed
 * to between the read and the delete kept every other branch in the batch — and the webview had
 * already recorded them all as asked for, so they were never offered again. Retrying one by one
 * costs an extra process per branch on a path that runs almost never, and keeps the refusal to
 * the branch that earned it.
 *
 * Each deleted branch's `branch.<name>` config goes too, as `git branch -D` would remove it:
 * left behind, a branch later created under the same name silently inherits the old upstream.
 */
export async function deleteMergedBranches(
  git: GitRunner,
  snapshot: RawData,
  pullRequests: Map<string, PullRequestStatus>,
  requested: string[]
): Promise<MergedDeletion> {
  const merged = mergedBranches(snapshot, pullRequests);
  const kept = merged.filter(branch => branch.keptReason);
  const wanted = new Set(requested);
  const targets = merged.filter(
    branch => !branch.keptReason && wanted.has(branch.name)
  );
  const deleted: string[] = [];
  if (targets.length) {
    const refusal = await deleteRefs(git, targets);
    if (refusal === null) {
      deleted.push(...targets.map(branch => branch.name));
    } else {
      for (const target of targets) {
        const single = await deleteRefs(git, [target]);
        if (single === null) {
          deleted.push(target.name);
        } else {
          kept.push({
            ...target,
            keptReason: `git refused to delete it — ${single}. Refresh and try again.`,
          });
        }
      }
    }
  }
  for (const branch of deleted) {
    // Absent for a branch that never had an upstream, which is not a failure.
    await git.tryRun(["config", "--remove-section", `branch.${branch}`]);
  }
  return { deleted, kept };
}
