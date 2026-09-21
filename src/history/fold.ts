/**
 * fold — combine a commit with its parent.
 *
 * Like reword and absorb, this is a computed rewrite rather than a replay: the
 * combined commit keeps the *upper* commit's tree, which is by definition the
 * result of applying both changes. So folding cannot conflict, needs no checkout,
 * and reduces to one `commit-tree` plus the usual atomic ref move.
 *
 * The subtlety is which commit survives. Git's own `rebase --squash` keeps the
 * lower commit and discards the upper one's identity; here the lower commit is
 * the one removed, and its branch pointer moves up to the combined commit. That
 * matches how a branch-per-commit stack reads: folding "add tests" into "add
 * feature" should leave one branch, named for the work, not for the tests.
 */
import { GitError, GitRunner } from "#git/runner";
import { RawData } from "#git/snapshot";
import { authorEnvironment, withNewline } from "#history/objects";
import { rebuildStack } from "#history/rewrite";

export type FoldResult = {
  /** Sha of the combined commit. */
  newSha: string;
  /** Branches that ended up on the combined commit. */
  branches: string[];
};

/**
 * Fold `sha` into its parent, keeping `sha`'s tree and both messages.
 *
 * Refuses when the parent is not a local commit (it is on trunk, so not ours to
 * rewrite) or when the parent has other local children, where "fold downwards"
 * has no single meaning — the sibling would silently lose its base.
 */
export async function foldIntoParent(
  git: GitRunner,
  snapshot: RawData,
  sha: string
): Promise<FoldResult> {
  const bySha = new Map(snapshot.commits.map(commit => [commit.sha, commit]));
  const commit = bySha.get(sha);
  if (!commit) {
    throw new GitError(
      "Commit is not a local commit — nothing to fold.",
      "fold"
    );
  }

  const parentSha = commit.parents[0];
  const parent = parentSha ? bySha.get(parentSha) : undefined;
  // Testing the sha as well as the commit is what narrows it to a string for the
  // sibling scan and the rewrite map below; a root commit has no parent to fold into.
  if (parentSha === undefined || !parent) {
    throw new GitError(
      "The commit below is already on trunk, so there is nothing local to fold into.",
      "fold"
    );
  }
  if (commit.parents.length > 1) {
    throw new GitError("Cannot fold a merge commit.", "fold");
  }

  const siblings = snapshot.commits.filter(
    candidate => candidate.sha !== sha && candidate.parents.includes(parentSha)
  );
  if (siblings.length) {
    const names = siblings.flatMap(sibling => sibling.branches).join(", ");
    throw new GitError(
      `The commit below is a fork point${names ? ` (also the base of ${names})` : ""}, ` +
        "so folding into it would move the ground under the other branch. Rebase that branch first.",
      "fold"
    );
  }

  // The upper tree already contains both changes, so no merge is needed.
  const message = combineMessages(parent.body, commit.body);
  const grandparents = parent.parents.flatMap(ancestor => ["-p", ancestor]);
  const combined = await git.run(
    ["commit-tree", `${sha}^{tree}`, ...grandparents],
    {
      input: withNewline(message),
      // The surviving change is the lower commit's work extended, so keep its
      // authorship rather than the upper commit's.
      env: authorEnvironment(parent),
    }
  );

  // Both folded commits now resolve to the combined one, so anything above
  // re-parents onto it and both branch pointers land there.
  const rewritten = await rebuildStack(git, snapshot, {
    presetRewrites: new Map([
      [parentSha, combined],
      [sha, combined],
    ]),
  });

  const newSha = rewritten.get(sha) ?? combined;
  const branches = [...parent.branches, ...commit.branches];
  return { newSha, branches };
}

/**
 * Join two commit messages the way a person would read them: the lower commit's
 * message first, then the upper one's, separated by a blank line. Duplicate text
 * is dropped, since folding a `fixup!`-style commit into its target is common and
 * repeating the subject reads badly.
 */
function combineMessages(lower: string, upper: string): string {
  const first = lower.trim();
  const second = upper.trim();
  if (!second || first === second) {
    return first;
  }
  if (first.includes(second)) {
    return first;
  }
  return `${first}\n\n${second}`;
}
