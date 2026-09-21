/**
 * Restacking every local branch onto the newest trunk.
 *
 * Restack is the one-button version of what a stacked workflow needs after a teammate's
 * pull request merges. Two branches forked from different trunk commits have to end up on
 * the same tip, each keeping its own parent below it, and the panel has to stop drawing the
 * hidden-commit ellipsis once nothing is hidden.
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildModel } from "#ui/renderModel";
import { commitFile, OTHER, run } from "../scripts/git-fixture.mjs";
import { commitOn, present } from "./present.mjs";
import { branchPerCommitStack, statusOf } from "./repoFixture.mjs";

const { repo, repository } = branchPerCommitStack({ after }, "gsm-restack-");

test("restack lands every branch on the newest trunk tip, the hotfix included", async () => {
  // One more merged pull request, so the hotfix falls behind too and both fork points
  // have to move.
  run(repo, "git", ["switch", "-q", "main"]);
  commitFile(repo, "main4.txt", "4\n", "other work 4", OTHER);
  run(repo, "git", ["push", "origin", "main"]);
  run(repo, "git", ["switch", "-q", "feature-c"]);

  const outcome = await repository.restackAll();
  assert.equal(outcome.conflict, false);
  assert.deepEqual(outcome.moved, [
    "feature-a",
    "feature-b",
    "feature-c",
    "hotfix",
  ]);

  const rawData = await repository.read();
  const trunkTip = present(rawData.trunkTip, "the trunk tip").sha;
  // Both stacks now fork from the same commit, so one base covers them.
  assert.equal(rawData.bases.length, 1);
  const onlyBase = present(rawData.bases[0], "the single fork base");
  assert.equal(onlyBase.sha, trunkTip);
  assert.equal(onlyBase.distanceToTrunkTip, 0);

  // The chain survived the replay: trunk <- a <- b <- c, with the hotfix beside it.
  const featureA = commitOn(rawData, "feature-a");
  const featureB = commitOn(rawData, "feature-b");
  const featureC = commitOn(rawData, "feature-c");
  assert.equal(featureA.parents[0], trunkTip);
  assert.equal(featureB.parents[0], featureA.sha);
  assert.equal(featureC.parents[0], featureB.sha);
  assert.equal(commitOn(rawData, "hotfix").parents[0], trunkTip);

  // Whichever branch the user started on is the one they end on.
  assert.equal(rawData.headBranch, "feature-c");
  assert.equal(statusOf(repo), "");
  // Nothing sits between the bases and the tip any more, so there is nothing to hide.
  const model = buildModel(rawData);
  assert.equal(
    model.rows.some(row => row.type === "ellipsis"),
    false
  );
});

test("restack refuses while the working copy is dirty", async () => {
  // A replay checks out every commit in turn, which would carry the edit along or lose it.
  writeFileSync(join(repo, "dirty.txt"), "x\n");
  run(repo, "git", ["add", "dirty.txt"]);
  await assert.rejects(() => repository.restackAll(), /uncommitted/);
  run(repo, "git", ["reset", "-q", "HEAD", "dirty.txt"]);
  rmSync(join(repo, "dirty.txt"));
});
