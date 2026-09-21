/**
 * Moving one commit and everything above it to a new parent.
 *
 * A rebase here replays commits by hand rather than calling `git rebase`, because git moves
 * one branch and leaves the rest of the stack pointing at the commits it replaced. So the
 * assertion in nearly every test below is about refs: which branches followed the rewrite,
 * where HEAD ended up, and whether the scratch `gsm-rebase` ref was cleaned up.
 *
 * The tests share one repository and run in order, so a rebase sees whatever the previous
 * one left behind. Each reads the shape it needs from `repository.read()` instead of
 * assuming a sha, so what carries over is the topology, not a particular commit.
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { commitFile, OTHER, run } from "../scripts/git-fixture.mjs";
import { commitOn, present } from "./present.mjs";
import {
  branchPerCommitStack,
  markerRefs,
  shaOf,
  statusOf,
} from "./repoFixture.mjs";

const { repo, repository } = branchPerCommitStack({ after }, "gsm-rebase-");

/**
 * Add a second stack that forks: `fork-base` with two leaves above it.
 *
 * One bottom commit and two children is the shape that needs a marker ref. Rebasing the
 * bottom rewrites it once, and both leaves have to be relinked to the rewritten commit
 * rather than to the one it replaced.
 *
 * @param {string} repo
 */
function addForkedStack(repo) {
  run(repo, "git", ["switch", "-q", "--detach", "origin/main"]);
  run(repo, "git", ["switch", "-qc", "fork-base"]);
  commitFile(repo, "fork-base.txt", "base\n", "fork: shared bottom");
  const sharedBottom = shaOf(repo, "HEAD");
  run(repo, "git", ["switch", "-qc", "fork-left"]);
  commitFile(repo, "fork-left.txt", "left\n", "fork: left leaf");
  run(repo, "git", ["switch", "-q", "--detach", sharedBottom]);
  run(repo, "git", ["switch", "-qc", "fork-right"]);
  commitFile(repo, "fork-right.txt", "right\n", "fork: right leaf");
  run(repo, "git", ["switch", "-q", "feature-c"]);
}

/**
 * Advance trunk by one pushed commit and report the new tip, leaving HEAD on `main`.
 *
 * Every rebase-onto-trunk test needs somewhere new to land, and each has to make that
 * somewhere itself: the previous test's rebase already put its stack on the current tip,
 * where rebasing again would move nothing.
 *
 * @param {string} file
 * @param {string} message
 */
function advanceTrunk(file, message) {
  run(repo, "git", ["switch", "-q", "main"]);
  commitFile(repo, file, "trunk\n", message, OTHER);
  run(repo, "git", ["push", "-q", "origin", "main"]);
  return shaOf(repo, "origin/main");
}

addForkedStack(repo);

test("rebasing a bottom commit onto trunk carries every branch above it", async () => {
  const trunkTip = advanceTrunk("main4.txt", "other work 4");
  run(repo, "git", ["switch", "-q", "feature-c"]);

  const before = await repository.read();
  const featureA = commitOn(before, "feature-a");
  const outcome = await repository.rebase(featureA.sha, { kind: "trunk" });
  assert.equal(outcome.conflict, false);
  // The forked stack shares no ancestry with feature-a, so it stays put.
  assert.deepEqual(outcome.moved, ["feature-a", "feature-b", "feature-c"]);

  const after = await repository.read();
  const rebasedA = commitOn(after, "feature-a");
  const rebasedB = commitOn(after, "feature-b");
  const rebasedC = commitOn(after, "feature-c");
  // Every branch in between followed the rewrite, not just the leaf.
  assert.equal(rebasedA.parents[0], trunkTip);
  assert.equal(rebasedB.parents[0], rebasedA.sha);
  assert.equal(rebasedC.parents[0], rebasedB.sha);
  assert.equal(statusOf(repo), "");
  assert.equal(markerRefs(repo), "");
});

test("rebasing a shared bottom commit replays both chains of a forked stack", async () => {
  const trunkTip = advanceTrunk("main5.txt", "other work 5");
  run(repo, "git", ["switch", "-q", "fork-base"]);

  const before = await repository.read();
  const bottom = commitOn(before, "fork-base");
  const outcome = await repository.rebase(bottom.sha, { kind: "trunk" });
  assert.equal(outcome.conflict, false);

  const after = await repository.read();
  const base = commitOn(after, "fork-base");
  const left = commitOn(after, "fork-left");
  const right = commitOn(after, "fork-right");
  assert.equal(
    base.parents[0],
    trunkTip,
    "shared bottom sits on the new trunk tip"
  );
  // Both leaves point at the rewritten bottom rather than the one it replaced.
  assert.equal(left.parents[0], base.sha, "left leaf follows the moved bottom");
  assert.equal(
    right.parents[0],
    base.sha,
    "right leaf follows the moved bottom"
  );
  assert.notEqual(left.sha, right.sha);
  assert.equal(markerRefs(repo), "");
  assert.equal(statusOf(repo), "");
});

test("rebasing onto the stack base lands on the fork point, not the newer trunk tip", async () => {
  // A branch that forked mid-stack, which the user wants beside the stack rather than
  // dragged forward onto whatever trunk has merged since.
  run(repo, "git", ["switch", "-q", "fork-left"]);
  run(repo, "git", ["switch", "-qc", "side-branch"]);
  commitFile(repo, "side.txt", "side\n", "side: independent work");

  // The destination is this stack's own fork base: the first ancestor that is not local
  // work, found by walking first parents. Picking an entry from `bases` would be
  // ambiguous as soon as two stacks exist.
  const before = await repository.read();
  const side = commitOn(before, "side-branch");
  const localShas = new Set(before.commits.map(commit => commit.sha));
  let walk = side;
  for (
    let parent = walk.parents[0];
    parent !== undefined && localShas.has(parent);
    parent = walk.parents[0]
  ) {
    walk = present(
      before.commits.find(commit => commit.sha === parent),
      `the local commit ${parent}`
    );
  }
  const expectedBaseSha = walk.parents[0];

  const outcome = await repository.rebase(side.sha, { kind: "base" });
  assert.equal(outcome.conflict, false);

  const after = await repository.read();
  assert.equal(
    commitOn(after, "side-branch").parents[0],
    expectedBaseSha,
    "landed on the stack's fork base"
  );
  assert.equal(statusOf(repo), "");
});

test("a rebase from a detached HEAD leaves HEAD on the rewritten commit", async () => {
  // Detached inside the moving set. Restoring HEAD by its original sha would leave the
  // user reading history the rebase abandoned.
  const trunkTip = advanceTrunk("main6.txt", "other work 6");
  run(repo, "git", ["switch", "-q", "fork-left"]);
  const detachedSha = shaOf(repo, "HEAD");
  run(repo, "git", ["switch", "-q", "--detach", detachedSha]);

  const before = await repository.read();
  const bottom = commitOn(before, "fork-base");
  const outcome = await repository.rebase(bottom.sha, { kind: "trunk" });
  assert.equal(outcome.conflict, false);

  const headSha = shaOf(repo, "HEAD");
  assert.notEqual(
    headSha,
    detachedSha,
    "HEAD left the commit the rebase abandoned"
  );
  assert.equal(
    headSha,
    shaOf(repo, "fork-left"),
    "HEAD follows the rewritten commit"
  );
  assert.equal(shaOf(repo, "fork-base"), shaOf(repo, "fork-left^"));
  assert.equal(shaOf(repo, "fork-base^"), trunkTip);
  assert.equal(markerRefs(repo), "");
});

test("rebase refuses a destination inside the moving set", async () => {
  // Landing a commit on one of its own descendants has no meaning, and attempting it
  // would drop everything between.
  const snapshot = await repository.read();
  const bottom = commitOn(snapshot, "fork-base");
  const leaf = commitOn(snapshot, "fork-left");
  await assert.rejects(
    () => repository.rebase(bottom.sha, { kind: "commit", sha: leaf.sha }),
    /own descendants/
  );
});

test("rebase refuses while the working copy is dirty", async () => {
  writeFileSync(join(repo, "dirty-rebase.txt"), "x\n");
  const snapshot = await repository.read();
  const leaf = commitOn(snapshot, "fork-left");
  await assert.rejects(
    () => repository.rebase(leaf.sha, { kind: "trunk" }),
    /uncommitted changes/
  );
  rmSync(join(repo, "dirty-rebase.txt"));
});

test("a conflicting rebase stops with its state readable, then finishes once resolved", async () => {
  // Trunk and the branch rewrite the same line, so the replay cannot proceed on its own.
  run(repo, "git", ["switch", "-q", "main"]);
  writeFileSync(join(repo, "shared.txt"), "trunk version\n");
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "trunk: take shared.txt"], OTHER);
  run(repo, "git", ["push", "-q", "origin", "main"]);
  const conflictBase = shaOf(repo, "HEAD~1");

  run(repo, "git", ["switch", "-q", "--detach", conflictBase]);
  run(repo, "git", ["switch", "-qc", "conflicting"]);
  writeFileSync(join(repo, "shared.txt"), "branch version\n");
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "branch: take shared.txt"]);

  const before = await repository.read();
  const target = commitOn(before, "conflicting");
  const outcome = await repository.rebase(target.sha, { kind: "trunk" });
  assert.equal(outcome.conflict, true, "stops instead of throwing");

  // A stopped rebase has to reach the model, or the panel cannot offer to resolve it.
  const during = await repository.read();
  assert.ok(during.conflict, "conflict state reported");
  assert.equal(during.conflict.branch, "conflicting");
  assert.deepEqual(during.conflict.unmergedFiles, ["shared.txt"]);

  // Continuing with the markers still in the file would commit them.
  await assert.rejects(() => repository.continueRebase(), /Conflict markers/);

  writeFileSync(join(repo, "shared.txt"), "resolved version\n");
  const finished = await repository.continueRebase();
  assert.equal(finished.conflict, false);

  const after = await repository.read();
  assert.equal(after.conflict, null, "conflict cleared");
  assert.equal(
    commitOn(after, "conflicting").parents[0],
    shaOf(repo, "origin/main")
  );
  assert.equal(
    run(repo, "git", ["show", "HEAD:shared.txt"]).trim(),
    "resolved version"
  );
  assert.equal(statusOf(repo), "");
});

test("aborting a conflicting rebase restores the original commits", async () => {
  run(repo, "git", ["switch", "-q", "main"]);
  writeFileSync(join(repo, "shared2.txt"), "trunk take\n");
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "trunk: take shared2.txt"], OTHER);
  run(repo, "git", ["push", "-q", "origin", "main"]);
  const base = shaOf(repo, "HEAD~1");

  run(repo, "git", ["switch", "-q", "--detach", base]);
  run(repo, "git", ["switch", "-qc", "abortable"]);
  writeFileSync(join(repo, "shared2.txt"), "branch take\n");
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "branch: take shared2.txt"]);
  const originalSha = shaOf(repo, "abortable");

  const before = await repository.read();
  const target = commitOn(before, "abortable");
  const outcome = await repository.rebase(target.sha, { kind: "trunk" });
  assert.equal(outcome.conflict, true);

  await repository.abortRebase();
  const after = await repository.read();
  assert.equal(after.conflict, null, "no rebase left in progress");
  assert.equal(
    shaOf(repo, "abortable"),
    originalSha,
    "the branch is back where it started"
  );
  assert.equal(statusOf(repo), "");
  assert.equal(markerRefs(repo), "");
});
