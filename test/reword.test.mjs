/**
 * Rewording a commit that has commits above it.
 *
 * Changing a message changes the commit's sha, which strands every descendant on the
 * replaced commit unless they are rewritten too. That re-parenting is what separates this
 * from `git commit --amend`, and it is what these tests check — along with the tree staying
 * byte-identical, since a reword that touches content is a different operation.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ME } from "../scripts/git-fixture.mjs";
import { commitOn, present } from "./present.mjs";
import { branchPerCommitStack, shaOf, statusOf } from "./repoFixture.mjs";

const { repo, repository, forkPoint } = branchPerCommitStack(
  { after },
  "gsm-reword-"
);

test("rewording a mid-stack commit re-parents the branches above it", async () => {
  const before = await repository.read();
  const partA = present(
    before.commits.find(commit => commit.subject === "feat: part A"),
    "the part A commit"
  );
  const featureCTipBefore = shaOf(repo, "feature-c");

  await repository.reword(
    before,
    partA.sha,
    "feat: part A (reworded)\n\nnow with a body"
  );

  const after = await repository.read();
  const rewordedA = commitOn(after, "feature-a");
  assert.equal(rewordedA.subject, "feat: part A (reworded)");
  assert.match(rewordedA.body, /now with a body/);
  assert.notEqual(rewordedA.sha, partA.sha);

  // The point of the operation: B and C were rewritten onto the new A, so the stack is
  // still a chain. Leaving them behind is what a bare `--amend` does.
  const rewordedB = commitOn(after, "feature-b");
  const rewordedC = commitOn(after, "feature-c");
  assert.equal(rewordedB.parents[0], rewordedA.sha);
  assert.equal(rewordedC.parents[0], rewordedB.sha);
  assert.notEqual(rewordedC.sha, featureCTipBefore);
  assert.equal(after.headBranch, "feature-c");
  assert.equal(after.headSha, rewordedC.sha);

  assert.equal(rewordedA.authorEmail, ME.GIT_AUTHOR_EMAIL);
  // The hotfix forked below A, so nothing about it should move.
  assert.equal(commitOn(after, "hotfix").subject, "fix: urgent thing");

  // Identical trees all the way to the tip, which is why the working copy stays clean.
  assert.equal(statusOf(repo), "");
  assert.equal(
    shaOf(repo, `${rewordedC.sha}^{tree}`),
    shaOf(repo, `${featureCTipBefore}^{tree}`)
  );
});

test("reword refuses a commit that is already on trunk", async () => {
  // Rewriting a pushed commit would make every teammate's clone diverge.
  const snapshot = await repository.read();
  await assert.rejects(
    () => repository.reword(snapshot, forkPoint, "nope"),
    /not a local-only commit/
  );
});
