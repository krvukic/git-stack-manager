/**
 * Split. The property that matters most is that the pair ends exactly where the original
 * commit did — a split that quietly changes the final tree would be hard to notice and
 * painful to unpick.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitFile, run } from "../scripts/git-fixture.mjs";
import { commitOn } from "./present.mjs";
import { fileAt, shaOf, statusOf, trunkRepository } from "./repoFixture.mjs";

/**
 * One commit changing opposite ends of a file, plus a commit above it.
 *
 * @param {import("node:test").TestContext} t
 */
function buildFixture(t) {
  const fixture = trunkRepository(t, "gsm-split-", {
    file: "f.txt",
    content: "one\ntwo\nthree\n",
  });
  const { repo } = fixture;
  run(repo, "git", ["switch", "-qc", "feature"]);
  writeFileSync(join(repo, "f.txt"), "ONE-changed\ntwo\nTHREE-changed\n");
  run(repo, "git", ["commit", "-qam", "do two things at once"]);
  run(repo, "git", ["switch", "-qc", "above"]);
  commitFile(repo, "z.txt", "z\n", "later work");
  return fixture;
}

test("splitting produces two commits whose combined result matches the original", async t => {
  const { repo, repository } = buildFixture(t);
  const originalTree = shaOf(repo, "feature^{tree}");

  const snapshot = await repository.read();
  const target = commitOn(snapshot, "feature");
  const preview = await repository.previewSplit(target.sha);
  assert.equal(preview.hunks.length, 2, "one hunk per changed region");

  const result = await repository.split(
    target.sha,
    [preview.hunks[0].id],
    "change ONE",
    "change THREE"
  );

  // The first commit carries only the selected hunk.
  assert.equal(
    fileAt(repo, result.firstSha, "f.txt"),
    "ONE-changed\ntwo\nthree"
  );
  // The second reuses the original tree, so the pair lands exactly where the
  // single commit did — this is what makes split conflict-free.
  assert.equal(shaOf(repo, `${result.secondSha}^{tree}`), originalTree);
  // Ancestry: trunk <- first <- second <- above.
  assert.equal(shaOf(repo, `${result.secondSha}^`), result.firstSha);
  assert.equal(shaOf(repo, "above^"), result.secondSha);
  assert.equal(shaOf(repo, "feature"), result.secondSha);
  assert.equal(statusOf(repo), "");
});

test("splitting refuses to leave either commit empty", async t => {
  const { repo, repository } = buildFixture(t);
  const snapshot = await repository.read();
  const target = commitOn(snapshot, "feature");
  const preview = await repository.previewSplit(target.sha);

  await assert.rejects(
    () => repository.split(target.sha, []),
    /at least one change/
  );
  await assert.rejects(
    () =>
      repository.split(
        target.sha,
        preview.hunks.map(hunk => hunk.id)
      ),
    /second commit empty/
  );
  // Nothing moved through either refusal.
  assert.equal(shaOf(repo, "feature"), target.sha);
});

test("a commit with a single change cannot be split", async t => {
  const { repository } = buildFixture(t);
  const snapshot = await repository.read();
  // `later work` adds one file, so there is nothing to separate.
  const single = commitOn(snapshot, "above");
  await assert.rejects(
    () => repository.previewSplit(single.sha),
    /only one change/
  );
});

test("undo restores the single commit after a split", async t => {
  const { repo, repository } = buildFixture(t);
  const before = shaOf(repo, "feature");
  const snapshot = await repository.read();
  const target = commitOn(snapshot, "feature");
  const preview = await repository.previewSplit(target.sha);

  await repository.undoable("Split commit", () =>
    repository.split(target.sha, [preview.hunks[0].id])
  );
  assert.notEqual(shaOf(repo, "feature"), before);

  await repository.undo();
  assert.equal(shaOf(repo, "feature"), before);
});
