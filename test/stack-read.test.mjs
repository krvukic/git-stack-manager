/**
 * Reading the branch-per-commit stack, which is the shape this extension exists to show.
 *
 * Four reads over one repository, none of which change it: what counts as local work,
 * where each stack forked from trunk, how the model compacts the trunk commits between two
 * fork points, and which paths one commit touched. `reader.test.mjs` covers the odd states
 * a well-formed stack never reaches, such as a repository with no commits at all.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildModel } from "#ui/renderModel";
import { present } from "./present.mjs";
import { branchPerCommitStack } from "./repoFixture.mjs";

/** @typedef {import("#ui/renderModel").Row} Row */

const { repository, forkPoint, newTrunkTip } = branchPerCommitStack(
  { after },
  "gsm-stack-read-"
);

test("trunk resolves to the remote branch rather than the local one", async () => {
  const snapshot = await repository.read();
  assert.equal(snapshot.trunkRef, "origin/main");
});

test("a read lists only the work above trunk, with one base per fork point", async () => {
  const rawData = await repository.read();
  // The three trunk commits and the two before the fork are excluded: everything
  // below trunk is somebody else's merged work, and drawing it would bury the stack.
  assert.equal(rawData.commits.length, 4);
  const subjects = rawData.commits.map(commit => commit.subject).sort();
  assert.deepEqual(
    subjects,
    ["feat: part A", "feat: part B", "feat: part C", "fix: urgent thing"].sort()
  );

  // Two bases, because the stack and the hotfix were cut from different trunk commits.
  assert.equal(rawData.bases.length, 2);
  const baseShas = rawData.bases.map(base => base.sha).sort();
  assert.deepEqual(baseShas, [forkPoint, newTrunkTip].sort());
  const oldBase = present(
    rawData.bases.find(base => base.sha === forkPoint),
    "the base at the fork point"
  );
  assert.equal(oldBase.onTrunk, true);
  // How far behind the stack sits, and what the ellipsis row counts from.
  assert.equal(oldBase.distanceToTrunkTip, 3);
});

test("the model hides the trunk commits between two fork points behind an ellipsis row", async () => {
  const model = buildModel(await repository.read());
  // The hotfix forked from the trunk tip, so its commit row sits above the trunk-tip
  // row and the older stack sits below the ellipsis.
  assert.deepEqual(
    model.rows.map(row => row.type),
    ["commit", "trunk-tip", "ellipsis", "commit", "commit", "commit", "base"]
  );
  const ellipsis = present(
    model.rows.find(row => row.type === "ellipsis"),
    "the ellipsis row"
  );
  // Three trunk commits after the fork point, less the one the trunk-tip row draws.
  assert.equal(ellipsis.count, 2);

  // Newest first, the way a log reads.
  const stack = model.rows
    .filter(row => row.type === "commit")
    .map(row => row.commit.subject);
  assert.deepEqual(stack, [
    "fix: urgent thing",
    "feat: part C",
    "feat: part B",
    "feat: part A",
  ]);

  // One commit, one branch, so every row carries a pill.
  const pills = model.rows
    .filter(row => row.type === "commit")
    .flatMap(row => row.commit.branches);
  assert.deepEqual(pills.sort(), [
    "feature-a",
    "feature-b",
    "feature-c",
    "hotfix",
  ]);

  const head = /** @type {Extract<Row, { type: "commit" }>} */ (
    present(
      model.rows.find(row => row.type === "commit" && row.commit.isHead),
      "the head commit row"
    )
  );
  assert.equal(head.commit.branches[0], "feature-c");
  assert.equal(
    present(
      model.rows.find(row => row.type === "base"),
      "the base row"
    ).sha,
    forkPoint
  );
});

test("a commit reports the paths it changed", async () => {
  const rawData = await repository.read();
  const partB = present(
    rawData.commits.find(commit => commit.subject.startsWith("feat: part B")),
    "the part B commit"
  );
  const files = await repository.filesForCommit(partB.sha);
  assert.deepEqual(files, [{ status: "A", path: "b.txt" }]);
});
