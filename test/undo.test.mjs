/**
 * Undo. Each test covers a property that would be expensive to get wrong: that a rewrite
 * is fully reversed, that files are never touched, that a concurrent ref change aborts
 * rather than clobbers, and that a failed mutation leaves nothing to undo.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitFile, OTHER, run } from "../scripts/git-fixture.mjs";
import { commitOn, present } from "./present.mjs";
import {
  branchShas,
  stackBranches,
  statusOf,
  trunkRepository,
} from "./repoFixture.mjs";

/**
 * A stack of three branch-per-commit layers on a pushed trunk.
 *
 * @param {import("node:test").TestContext} t
 */
function buildFixture(t) {
  const fixture = trunkRepository(t, "gsm-undo-", {
    file: "README.md",
    content: "hi\n",
  });
  stackBranches(fixture.repo, [
    { branch: "feature-a", file: "a.txt", message: "feat: A", content: "A\n" },
    { branch: "feature-b", file: "b.txt", message: "feat: B", content: "B\n" },
  ]);
  return fixture;
}

test("undo restores every branch a mid-stack reword rewrote", async t => {
  const { repo, repository } = buildFixture(t);
  const before = branchShas(repo);

  const snapshot = await repository.read();
  const target = commitOn(snapshot, "feature-a");
  await repository.undoable("Amend message", () =>
    repository.reword(snapshot, target.sha, "feat: A reworded")
  );
  // The reword rewrites feature-a and re-parents feature-b on top of it.
  assert.notEqual(branchShas(repo).get("feature-a"), before.get("feature-a"));
  assert.notEqual(branchShas(repo).get("feature-b"), before.get("feature-b"));

  assert.equal(await repository.undo(), "Amend message");
  assert.deepEqual(
    branchShas(repo),
    before,
    "both branches back to their original commits"
  );
  assert.equal(
    run(repo, "git", ["symbolic-ref", "--short", "HEAD"]),
    "feature-b"
  );
});

test("undo leaves uncommitted work in place", async t => {
  const { repo, repository } = buildFixture(t);
  // Undo is a ref operation; reverting someone's edits to restore history would
  // be worse than the problem it solves.
  writeFileSync(join(repo, "scratch.txt"), "unsaved work\n");
  const snapshot = await repository.read();
  const target = commitOn(snapshot, "feature-a");
  await repository.undoable("Amend message", () =>
    repository.reword(snapshot, target.sha, "reworded")
  );
  await repository.undo();

  assert.match(statusOf(repo), /scratch\.txt/);
});

test("undo reverses a rebase, including the branches --update-refs moved", async t => {
  const { repo, repository } = buildFixture(t);
  run(repo, "git", ["switch", "main"]);
  commitFile(repo, "trunk.txt", "more\n", "other work", OTHER);
  run(repo, "git", ["push", "origin", "main"]);
  run(repo, "git", ["switch", "feature-b"]);
  const before = branchShas(repo);

  const snapshot = await repository.read();
  const bottom = commitOn(snapshot, "feature-a");
  const outcome = await repository.undoable("Rebase onto trunk", () =>
    repository.rebase(bottom.sha, { kind: "trunk" })
  );
  assert.equal(outcome.conflict, false);
  assert.notEqual(branchShas(repo).get("feature-a"), before.get("feature-a"));

  await repository.undo();
  assert.deepEqual(
    branchShas(repo),
    before,
    "the whole stack is back where it started"
  );
});

test("undo refuses when a branch moved underneath, restoring nothing", async t => {
  const { repo, repository } = buildFixture(t);
  const snapshot = await repository.read();
  const target = commitOn(snapshot, "feature-a");
  await repository.undoable("Amend message", () =>
    repository.reword(snapshot, target.sha, "reworded")
  );
  const afterReword = branchShas(repo);

  // Someone else moves a branch the checkpoint recorded. The restore is atomic,
  // so it must abort rather than partially apply.
  run(repo, "git", ["branch", "-f", "feature-a", "main"]);
  await assert.rejects(
    () => repository.undo(),
    /changed outside this extension/
  );
  assert.equal(
    branchShas(repo).get("feature-b"),
    afterReword.get("feature-b"),
    "feature-b untouched"
  );

  // The checkpoint survives a failed restore, so it can be retried.
  run(repo, "git", [
    "branch",
    "-f",
    "feature-a",
    present(afterReword.get("feature-a"), "the reworded feature-a"),
  ]);
  assert.equal(await repository.undo(), "Amend message");
});

test("a failed mutation leaves nothing to undo", async t => {
  const { repo, repository } = buildFixture(t);
  writeFileSync(join(repo, "dirty.txt"), "x\n");
  const snapshot = await repository.read();
  const leaf = commitOn(snapshot, "feature-b");

  // A dirty tree makes rebase refuse; the checkpoint must be discarded so Undo
  // does not offer to reverse something that never happened.
  await assert.rejects(
    () =>
      repository.undoable("Rebase onto trunk", () =>
        repository.rebase(leaf.sha, { kind: "trunk" })
      ),
    /uncommitted changes/
  );
  assert.equal(repository.undoHistory.nextLabel(), null);
  await assert.rejects(() => repository.undo(), /Nothing to undo/);
});

test("undo restores a detached HEAD to the commit it was on", async t => {
  const { repo, repository } = buildFixture(t);
  const detachedSha = run(repo, "git", ["rev-parse", "feature-a"]);
  run(repo, "git", ["switch", "--detach", detachedSha]);

  const snapshot = await repository.read();
  const target = present(
    snapshot.commits.find(commit => commit.sha === detachedSha),
    "the commit HEAD is detached at"
  );
  await repository.undoable("Amend message", () =>
    repository.reword(snapshot, target.sha, "reworded")
  );
  await repository.undo();

  assert.equal(run(repo, "git", ["rev-parse", "HEAD"]), detachedSha);
  // `symbolic-ref -q` exits non-zero on a detached HEAD, which `run` turns into
  // a throw — so the throw itself is the assertion.
  assert.throws(
    () => run(repo, "git", ["symbolic-ref", "-q", "HEAD"]),
    "still detached"
  );
});
