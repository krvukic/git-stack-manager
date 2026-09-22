/**
 * Commit and amend-into-commit.
 *
 * The interesting cases are all about what the selection leaves behind. A commit that
 * takes two of three changes has to leave the third exactly as it was — including its
 * staged-ness, since a pathspec commit runs against whatever the user had in the index.
 * Amending into a commit below HEAD is the other half: the descendants need re-parenting
 * rather than orphaning, which is the failure a plain `git commit --amend` would produce.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitFile, run } from "../scripts/git-fixture.mjs";
import { commitOn } from "./present.mjs";
import {
  filesIn,
  shaOf,
  stackBranches,
  statusOf,
  trunkRepository,
} from "./repoFixture.mjs";

/**
 * trunk <- feature <- top, one branch per commit.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function buildFixture(t, prefix) {
  const fixture = trunkRepository(t, prefix);
  stackBranches(fixture.repo, [
    { branch: "feature", file: "feature.txt", message: "add feature" },
    { branch: "top", file: "top.txt", message: "later work" },
  ]);
  return fixture;
}

test("committing a subset takes only those paths and leaves the rest dirty", async t => {
  const { repo, repository } = buildFixture(t, "gsm-commit-");
  writeFileSync(join(repo, "picked.txt"), "picked\n");
  writeFileSync(join(repo, "left.txt"), "left\n");
  writeFileSync(join(repo, "top.txt"), "top\nmodified\n");

  const result = await repository.commit(
    ["picked.txt", "top.txt"],
    "feat: take two paths"
  );

  assert.deepEqual(filesIn(repo, "HEAD"), ["picked.txt", "top.txt"]);
  assert.equal(shaOf(repo, "HEAD"), result.newSha);
  assert.equal(
    run(repo, "git", ["log", "-1", "--format=%s"]),
    "feat: take two paths"
  );
  // The untouched file is still untracked, not swept in and not deleted.
  assert.equal(statusOf(repo), "?? left.txt");
  // The new commit sits on top of the branch, carrying it along.
  assert.equal(shaOf(repo, "top"), result.newSha);
});

test("a commit message keeps its body and its quotes", async t => {
  const { repo, repository } = buildFixture(t, "gsm-commit-msg-");
  writeFileSync(join(repo, "new.txt"), "new\n");
  // The message goes to git on stdin rather than as `-m`, so a quote or a newline
  // needs no escaping. Passing it through a shell is what this guards against.
  const message =
    'fix: don\'t drop the "quoted" path\n\nBody line one.\nBody line two.\n';

  await repository.commit(["new.txt"], message);

  assert.equal(
    run(repo, "git", ["log", "-1", "--format=%s"]),
    'fix: don\'t drop the "quoted" path'
  );
  assert.equal(
    run(repo, "git", ["log", "-1", "--format=%b"]).trim(),
    "Body line one.\nBody line two."
  );
});

test("committing leaves another file's staged state alone", async t => {
  const { repo, repository } = buildFixture(t, "gsm-commit-index-");
  writeFileSync(join(repo, "picked.txt"), "picked\n");
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  run(repo, "git", ["add", "--", "staged.txt"]);

  await repository.commit(["picked.txt"], "feat: only the picked one");

  assert.deepEqual(filesIn(repo, "HEAD"), ["picked.txt"]);
  // "A " is a staged addition: the file the user staged is still staged, neither
  // committed alongside nor reset. A pathspec commit is what preserves this.
  assert.equal(statusOf(repo), "A  staged.txt");
});

test("committing a deletion records the removal", async t => {
  const { repo, repository } = buildFixture(t, "gsm-commit-delete-");
  rmSync(join(repo, "top.txt"));

  await repository.commit(["top.txt"], "chore: drop top.txt");

  assert.equal(
    run(repo, "git", ["show", "--name-status", "--format=", "HEAD"]).trim(),
    "D\ttop.txt"
  );
  assert.equal(statusOf(repo), "");
});

test("amending with no target folds the changes into HEAD", async t => {
  const { repo, repository } = buildFixture(t, "gsm-amend-head-");
  const before = shaOf(repo, "HEAD");
  writeFileSync(join(repo, "top.txt"), "top\nmore\n");

  const result = await repository.amendInto(["top.txt"]);

  assert.notEqual(result.newSha, before);
  assert.equal(shaOf(repo, "HEAD"), result.newSha);
  // The message is kept and no commit is added: amending is not committing.
  assert.equal(run(repo, "git", ["log", "-1", "--format=%s"]), "later work");
  assert.equal(run(repo, "git", ["rev-list", "--count", "HEAD"]), "3");
  assert.equal(run(repo, "git", ["show", "HEAD:top.txt"]), "top\nmore");
  assert.equal(statusOf(repo), "");
});

test("amending everything at once needs no selection", async t => {
  // The entry point behind the "amend all" command, as opposed to the pathspec amend
  // above it: whatever is dirty goes in, including a file git has never seen.
  const { repo, repository } = buildFixture(t, "gsm-amend-all-");
  writeFileSync(join(repo, "top.txt"), "top\nmore\n");
  writeFileSync(join(repo, "extra.txt"), "extra\n");

  await repository.amendChangesIntoHead();

  const snapshot = await repository.read();
  assert.equal(snapshot.uncommitted.length, 0);
  assert.deepEqual(filesIn(repo, "top"), ["extra.txt", "top.txt"]);
  assert.equal(run(repo, "git", ["show", "HEAD:top.txt"]), "top\nmore");
  assert.equal(run(repo, "git", ["log", "-1", "--format=%s"]), "later work");
});

test("amending into a commit below HEAD re-parents the stack above it", async t => {
  const { repo, repository } = buildFixture(t, "gsm-amend-deep-");
  const snapshot = await repository.read();
  const feature = commitOn(snapshot, "feature");
  const topBefore = shaOf(repo, "top");
  writeFileSync(join(repo, "feature.txt"), "feature\namended\n");

  const result = await repository.amendInto(["feature.txt"], feature.sha);

  // The target carries the change and kept its message.
  assert.equal(
    run(repo, "git", ["show", `${result.newSha}:feature.txt`]),
    "feature\namended"
  );
  assert.equal(
    run(repo, "git", ["log", "-1", "--format=%s", result.newSha]),
    "add feature"
  );
  assert.equal(shaOf(repo, "feature"), result.newSha);

  // This is the whole point: `top` moved onto the rewritten commit rather than
  // being left on the one the amend replaced. A plain `git commit --amend` here
  // would have orphaned it.
  assert.notEqual(shaOf(repo, "top"), topBefore);
  assert.equal(shaOf(repo, "top^"), result.newSha);
  // `top` keeps its own change and inherits the amended one from its new parent.
  assert.deepEqual(filesIn(repo, "top"), ["top.txt"]);
  assert.equal(
    run(repo, "git", ["show", "top:feature.txt"]),
    "feature\namended"
  );
  // The change left the working copy, so it is not shown twice.
  assert.equal(statusOf(repo), "");
});

test("a descendant does not revert what was amended below it", async t => {
  // `rebuildStack` reuses a commit's original tree unless handed a new one, and that
  // tree still holds the pre-amend content. Grafting only the target left `top`
  // carrying a stale `feature.txt`, so the row above the amend showed a spurious
  // "M feature.txt" and checking it out undid the change.
  const { repo, repository } = buildFixture(t, "gsm-amend-revert-");
  const snapshot = await repository.read();
  const feature = commitOn(snapshot, "feature");
  writeFileSync(join(repo, "feature.txt"), "feature\namended\n");

  await repository.amendInto(["feature.txt"], feature.sha);

  // The amended content survives all the way up the stack, and no commit above the
  // target lists the path as one of its own changes.
  assert.equal(
    run(repo, "git", ["show", "top:feature.txt"]),
    "feature\namended"
  );
  assert.deepEqual(filesIn(repo, "top"), ["top.txt"]);
});

test("an edit to a line a later commit wrote is refused, with nothing changed", async t => {
  // This used to graft the whole working file into `feature`, keep the later commit's own
  // copy, and check HEAD out over the working file: `amended` landed in `feature`, the later
  // commit reverted it, and the edit was gone from the working copy.
  const { repo, repository } = buildFixture(t, "gsm-amend-later-");
  writeFileSync(join(repo, "feature.txt"), "feature\nlater edit\n");
  run(repo, "git", ["commit", "-qam", "edit feature later"]);
  const snapshot = await repository.read();
  const feature = commitOn(snapshot, "feature");
  const headBefore = shaOf(repo, "HEAD");
  writeFileSync(join(repo, "feature.txt"), "feature\namended\n");

  await assert.rejects(
    () => repository.amendInto(["feature.txt"], feature.sha),
    /"edit feature later" changed the same lines\. Amend into "edit feature later" instead/
  );
  assert.equal(shaOf(repo, "feature"), feature.sha);
  assert.equal(shaOf(repo, "HEAD"), headBefore);
  assert.equal(
    readFileSync(join(repo, "feature.txt"), "utf8"),
    "feature\namended\n"
  );
  assert.equal(statusOf(repo), "M feature.txt");
});

test("an edit to the target's lines keeps what a later commit added to the same file", async t => {
  const { repo, repository } = buildFixture(t, "gsm-amend-compatible-");
  writeFileSync(join(repo, "feature.txt"), "feature\nlater edit\n");
  run(repo, "git", ["commit", "-qam", "edit feature later"]);
  const snapshot = await repository.read();
  const feature = commitOn(snapshot, "feature");
  writeFileSync(join(repo, "feature.txt"), "feature, amended\nlater edit\n");

  const result = await repository.amendInto(["feature.txt"], feature.sha);

  assert.equal(
    run(repo, "git", ["show", `${result.newSha}:feature.txt`]),
    "feature, amended"
  );
  assert.equal(
    run(repo, "git", ["show", "HEAD:feature.txt"]),
    "feature, amended\nlater edit"
  );
  // The later commit still adds exactly its own line, and nothing is left to commit.
  assert.deepEqual(
    run(repo, "git", [
      "diff",
      "-U0",
      "--no-color",
      "HEAD^",
      "HEAD",
      "--",
      "feature.txt",
    ])
      .split("\n")
      .filter(line => /^[-+][^-+]/.test(line)),
    ["+later edit"]
  );
  assert.equal(statusOf(repo), "");
});

test("a branch forked above the target takes the amend too", async t => {
  // `side` forks from `feature` next to `top`. It re-parents onto the amended commit, and it
  // must carry the change rather than revert it — both when it left the file alone and when
  // it edited other lines of it.
  const { repo, repository } = buildFixture(t, "gsm-amend-fork-");
  run(repo, "git", ["switch", "-qc", "side", "feature"]);
  writeFileSync(join(repo, "feature.txt"), "feature\nside line\n");
  run(repo, "git", ["commit", "-qam", "side work"]);
  run(repo, "git", ["switch", "-q", "top"]);
  const snapshot = await repository.read();
  const feature = commitOn(snapshot, "feature");
  writeFileSync(join(repo, "feature.txt"), "amended feature\n");

  const result = await repository.amendInto(["feature.txt"], feature.sha);

  assert.equal(shaOf(repo, "side^"), result.newSha);
  assert.equal(
    run(repo, "git", ["show", "side:feature.txt"]),
    "amended feature\nside line"
  );
  assert.equal(
    run(repo, "git", ["show", "top:feature.txt"]),
    "amended feature"
  );
  assert.equal(statusOf(repo), "");
});

test("a branch forked above the target that edited the same line refuses the amend", async t => {
  const { repo, repository } = buildFixture(t, "gsm-amend-fork-clash-");
  run(repo, "git", ["switch", "-qc", "side", "feature"]);
  writeFileSync(join(repo, "feature.txt"), "side feature\n");
  run(repo, "git", ["commit", "-qam", "side work"]);
  run(repo, "git", ["switch", "-q", "top"]);
  const snapshot = await repository.read();
  const feature = commitOn(snapshot, "feature");
  const sideBefore = shaOf(repo, "side");
  writeFileSync(join(repo, "feature.txt"), "amended feature\n");

  await assert.rejects(
    () => repository.amendInto(["feature.txt"], feature.sha),
    /"side work", on another branch, changed the same lines/
  );
  assert.equal(shaOf(repo, "side"), sideBefore);
  assert.equal(shaOf(repo, "feature"), feature.sha);
  assert.equal(statusOf(repo), "M feature.txt");
});

test("a file a later commit added cannot be amended below it", async t => {
  const { repo, repository } = buildFixture(t, "gsm-amend-added-later-");
  const snapshot = await repository.read();
  const feature = commitOn(snapshot, "feature");
  writeFileSync(join(repo, "top.txt"), "top\nmore\n");

  await assert.rejects(
    () => repository.amendInto(["top.txt"], feature.sha),
    /top\.txt cannot be amended into "add feature": "later work" added it after the target/
  );
  assert.equal(statusOf(repo), "M top.txt");
});

test("amending into a commit on another branch is refused", async t => {
  // Grafting working-copy content sideways left the change in two places: the commit
  // got it, and the file stayed dirty, because the checkout that clears the working
  // copy reads HEAD — which never received it. Only an ancestor of HEAD is valid.
  const { repo, repository } = buildFixture(t, "gsm-amend-sideways-");
  run(repo, "git", ["switch", "-q", "main"]);
  run(repo, "git", ["switch", "-qc", "sibling"]);
  commitFile(repo, "sibling.txt", "sibling\n", "sibling work");
  const snapshot = await repository.read();
  const feature = commitOn(snapshot, "feature");
  writeFileSync(join(repo, "sibling.txt"), "sibling\nedited\n");
  const featureBefore = shaOf(repo, "feature");

  await assert.rejects(
    () => repository.amendInto(["sibling.txt"], feature.sha),
    /not in the stack you have checked out/i
  );
  // Nothing moved and the edit is still where the user left it.
  assert.equal(shaOf(repo, "feature"), featureBefore);
  assert.equal(statusOf(repo), "M sibling.txt");
});

test("amending into a commit already on trunk is refused", async t => {
  const { repo, repository } = buildFixture(t, "gsm-amend-trunk-");
  const trunkSha = shaOf(repo, "origin/main");
  writeFileSync(join(repo, "top.txt"), "top\nmore\n");

  await assert.rejects(
    () => repository.amendInto(["top.txt"], trunkSha),
    /not a local-only commit/i
  );
  // Refusing must change nothing: the edit is still unstaged in the working copy,
  // so the refusal happens before anything is staged.
  assert.equal(statusOf(repo), "M top.txt");
});

test("an empty selection is refused rather than making an empty commit", async t => {
  const { repo, repository } = buildFixture(t, "gsm-commit-empty-");
  writeFileSync(join(repo, "new.txt"), "new\n");

  await assert.rejects(
    () => repository.commit([], "feat: nothing"),
    /select at least one/i
  );
  await assert.rejects(() => repository.amendInto([]), /select at least one/i);
  // A path git does not report as changed would otherwise commit nothing at all.
  await assert.rejects(
    () => repository.commit(["absent.txt"], "feat: ghost"),
    /not an uncommitted change/i
  );
});

test("a commit with a blank message is refused", async t => {
  const { repo, repository } = buildFixture(t, "gsm-commit-nomsg-");
  writeFileSync(join(repo, "new.txt"), "new\n");

  await assert.rejects(
    () => repository.commit(["new.txt"], "   \n"),
    /needs a message/i
  );
  assert.equal(statusOf(repo), "?? new.txt");
});
