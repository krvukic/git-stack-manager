/**
 * Fold. The happy path is one assertion; the value is in the refusals, since folding at
 * a fork point would silently move the ground under a sibling branch.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitFile, run } from "../scripts/git-fixture.mjs";
import { commitOn, present } from "./present.mjs";
import {
  filesIn,
  shaOf,
  stackBranches,
  statusOf,
  trunkRepository,
} from "./repoFixture.mjs";

/**
 * trunk <- feature <- feature-tests <- top, one branch per commit.
 *
 * @param {import("node:test").TestContext} t
 */
function buildFixture(t) {
  const fixture = trunkRepository(t, "gsm-fold-", { file: "f.txt" });
  stackBranches(fixture.repo, [
    { branch: "feature", file: "feature.txt", message: "add feature" },
    {
      branch: "feature-tests",
      file: "tests.txt",
      message: "add tests for feature",
      content: "tests\n",
    },
    {
      branch: "top",
      file: "later.txt",
      message: "later work",
      content: "later\n",
    },
  ]);
  return fixture;
}

test("folding keeps both changes, both messages, and re-parents the stack above", async t => {
  const { repo, repository } = buildFixture(t);
  const snapshot = await repository.read();
  const tests = commitOn(snapshot, "feature-tests");

  const result = await repository.fold(tests.sha);

  // One commit now holds both files — the upper tree already contained both.
  assert.deepEqual(filesIn(repo, "feature-tests"), [
    "feature.txt",
    "tests.txt",
  ]);
  const message = run(repo, "git", [
    "log",
    "-1",
    "--format=%B",
    "feature-tests",
  ]);
  assert.match(message, /add feature/);
  assert.match(message, /add tests for feature/);
  // Both branch pointers land on the combined commit, and work above follows.
  assert.equal(shaOf(repo, "feature"), shaOf(repo, "feature-tests"));
  assert.equal(shaOf(repo, "top^"), shaOf(repo, "feature-tests"));
  assert.deepEqual(result.branches.sort(), ["feature", "feature-tests"]);
  // No checkout happened, so nothing is left dirty.
  assert.equal(statusOf(repo), "");
  assert.equal(run(repo, "git", ["symbolic-ref", "--short", "HEAD"]), "top");
});

test("folding refuses at a fork point rather than stranding the sibling", async t => {
  const { repo, repository } = buildFixture(t);
  // A second branch off `feature`, so "the commit below" has two children.
  run(repo, "git", ["switch", "--detach", "-q", "feature"]);
  run(repo, "git", ["switch", "-qc", "sidebranch"]);
  commitFile(repo, "side.txt", "side\n", "side work");
  const before = shaOf(repo, "feature");

  const snapshot = await repository.read();
  const tests = commitOn(snapshot, "feature-tests");
  await assert.rejects(() => repository.fold(tests.sha), /fork point/);
  assert.equal(shaOf(repo, "feature"), before, "nothing moved");
});

test("folding refuses when the commit below is already on trunk", async t => {
  const { repository } = buildFixture(t);
  const snapshot = await repository.read();
  // `feature` sits directly on trunk, so there is no local commit beneath it.
  const feature = commitOn(snapshot, "feature");
  await assert.rejects(() => repository.fold(feature.sha), /already on trunk/);
});

test("folding a duplicate message does not repeat it", async t => {
  const { repo, repository } = buildFixture(t);
  // A `fixup!`-style commit reusing the target's subject is the common case.
  // It goes on `top`, the stack tip, so nothing forks beneath it.
  run(repo, "git", ["switch", "-q", "top"]);
  writeFileSync(join(repo, "later.txt"), "later, fixed\n");
  run(repo, "git", ["commit", "-qam", "later work"]);

  const snapshot = await repository.read();
  const tip = present(
    snapshot.commits.find(commit => commit.sha === snapshot.headSha),
    "the commit at HEAD"
  );
  await repository.fold(tip.sha);

  const message = run(repo, "git", ["log", "-1", "--format=%B", "HEAD"]).trim();
  assert.equal(message, "later work", "the identical message appears once");
});
