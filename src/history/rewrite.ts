/**
 * rewrite — history edits that never touch the working tree.
 *
 * Rewording, absorbing, folding, and splitting a mid-stack commit are all pure object-graph
 * operations: every tree is either reused verbatim or computed beforehand, so `commit-tree`
 * can rebuild the affected commits and their descendants without a checkout and without any
 * chance of conflict. Only the refs move afterwards, in a single atomic transaction.
 */
import { GitError, GitRunner } from "#git/runner";
import { RawCommit, RawData } from "#git/snapshot";
import { authorEnvironment, withNewline } from "#history/objects";

export type RewordResult = {
  newSha: string;
  /** Old sha -> new sha for every commit the rewrite recreated. */
  rewritten: Map<string, string>;
};

/**
 * What an edit changes about the stack being rebuilt. A commit named by none of these is
 * recreated verbatim, and only because a commit below it moved.
 */
export type StackEdits = {
  /** New tree per commit, for the edits that change content: absorb and amend. */
  treeBySha?: Map<string, string>;
  /** New message per commit, for the edit that changes wording: reword. */
  messageBySha?: Map<string, string>;
  /**
   * Commits the caller rewrote itself, as old sha -> new sha. Fold points both folded
   * commits at the single combined one and split points the original at its second half;
   * everything above then re-parents onto that in the normal pass.
   */
  presetRewrites?: Map<string, string>;
};

/**
 * Recreate every commit an edit disturbs, then move the refs onto the results.
 *
 * Reword, absorb, fold, and split differ only in what they hand in: reword keeps every tree
 * and changes a message, absorb and amend keep every message and change trees, fold and split
 * rewrite one commit themselves and let the rest follow. All four are conflict-free for the
 * same reason — each commit's content is computed, not replayed — so they share this path.
 */
export async function rebuildStack(
  git: GitRunner,
  snapshot: RawData,
  edits: StackEdits = {}
): Promise<Map<string, string>> {
  const { treeBySha, messageBySha, presetRewrites } = edits;
  // Oldest first, so a commit's parents are rewritten before the commit itself.
  const oldestFirst = [...snapshot.commits].reverse();
  const rewritten = new Map(presetRewrites);

  for (const commit of oldestFirst) {
    // A preset commit is already accounted for; recreating it would duplicate it.
    if (presetRewrites?.has(commit.sha)) {
      continue;
    }
    const newTree = treeBySha?.get(commit.sha);
    const newMessage = messageBySha?.get(commit.sha);
    const parentMoved = commit.parents.some(parent => rewritten.has(parent));
    // A commit is recreated when its own content or wording changed, or an ancestor moved.
    if (!newTree && newMessage === undefined && !parentMoved) {
      continue;
    }

    const parentArguments = commit.parents.flatMap(parent => [
      "-p",
      rewritten.get(parent) ?? parent,
    ]);
    const newSha = await git.run(
      ["commit-tree", newTree ?? `${commit.sha}^{tree}`, ...parentArguments],
      {
        input: withNewline(newMessage ?? commit.body),
        env: authorEnvironment(commit),
      }
    );
    rewritten.set(commit.sha, newSha);
  }

  await moveRefs(git, oldestFirst, rewritten, snapshot);
  return rewritten;
}

/**
 * Rewrite `targetSha`'s message, recreating its descendants on top.
 *
 * Takes the snapshot the caller already read rather than re-reading the repo: the controller
 * fetches `RawData` to render, and rewording immediately after would otherwise walk the
 * entire history a second time for no new information.
 */
export async function rewordCommit(
  git: GitRunner,
  snapshot: RawData,
  targetSha: string,
  newMessage: string
): Promise<RewordResult> {
  if (!snapshot.commits.some(commit => commit.sha === targetSha)) {
    throw new GitError(
      "Commit is not a local-only commit (already on trunk?) — refusing to rewrite.",
      "reword"
    );
  }
  const rewritten = await rebuildStack(git, snapshot, {
    messageBySha: new Map([[targetSha, newMessage]]),
  });
  return { newSha: rewritten.get(targetSha)!, rewritten };
}

/**
 * Repoint every affected branch (and a detached HEAD) in one transaction.
 *
 * Each update asserts the ref's old value, so a branch someone moved meanwhile
 * aborts the whole batch instead of clobbering their work — and because
 * `update-ref --stdin` is atomic, a failure leaves every ref untouched rather
 * than stranding the stack half-rewritten.
 */
async function moveRefs(
  git: GitRunner,
  commits: RawCommit[],
  rewritten: Map<string, string>,
  snapshot: RawData
): Promise<void> {
  const updates: string[] = [];
  for (const commit of commits) {
    const newSha = rewritten.get(commit.sha);
    if (!newSha) {
      continue;
    }
    for (const branch of commit.branches) {
      updates.push(`update refs/heads/${branch}\0${newSha}\0${commit.sha}\0`);
    }
  }
  const headSha = rewritten.get(snapshot.headSha);
  if (!snapshot.headBranch && headSha) {
    updates.push(
      `option no-deref\0`,
      `update HEAD\0${headSha}\0${snapshot.headSha}\0`
    );
  }
  if (!updates.length) {
    return;
  }
  await git.run(["update-ref", "--stdin", "-z"], { input: updates.join("") });
}
