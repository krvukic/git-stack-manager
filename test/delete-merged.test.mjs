/**
 * Deleting the branches whose pull request merged, and reporting the ones that stay.
 *
 * The rule under test is what makes deletion safe: a branch goes only while its tip is the
 * commit the pull request merged. Every test that keeps a branch covers one way that proof
 * fails or does not apply, and each of those also checks the sentence the branch carries —
 * a merged badge on a branch that stays reads as a broken setting until something says why.
 * The rest check that a deletion is complete and reversible.
 *
 * Pull request status is handed to the cache through `remember`, which is what submit uses
 * for a status read outside the search index. It keeps `gh` out of a suite about git refs.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { deleteMergedBranches, mergedBranches } from "#history/pruneMerged";
import { Controller } from "#ui/controller";
import { commitFile, run } from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import {
  branchShas,
  scratchRoot,
  shaOf,
  stackBranches,
  trunkRepository,
} from "./repoFixture.mjs";

/** @typedef {import("#github/pullRequests").PullRequestStatus} PullRequestStatus */
/** @typedef {import("#history/pruneMerged").MergedBranch} MergedBranch */
/** @typedef {import("#ui/renderModel").RenderModel} RenderModel */

/**
 * @param {string} state
 * @param {string} headSha
 * @returns {PullRequestStatus}
 */
function pullRequest(state, headSha) {
  return {
    number: 7,
    state,
    isDraft: false,
    title: "feat: B",
    url: "https://github.com/example/example/pull/7",
    headSha,
    reviewDecision: null,
    checks: null,
  };
}

/**
 * Two stacked branches with trunk checked out, so neither is HEAD.
 *
 * @param {import("node:test").TestContext} t
 */
function buildFixture(t) {
  const fixture = trunkRepository(t, "gsm-delete-merged-");
  stackBranches(fixture.repo, [
    { branch: "feature-a", file: "a.txt", message: "feat: A" },
    { branch: "feature-b", file: "b.txt", message: "feat: B" },
  ]);
  run(fixture.repo, "git", ["switch", "-q", "main"]);
  return { ...fixture, controller: new Controller(fixture.repository) };
}

/**
 * @param {ReturnType<typeof buildFixture>} fixture
 * @param {string} branch
 * @param {string} state
 * @param {string} [headSha] Defaults to the branch's current tip.
 */
function recordPullRequest(fixture, branch, state, headSha) {
  fixture.repository.pullRequests.remember(
    branch,
    pullRequest(state, headSha ?? shaOf(fixture.repo, branch))
  );
}

/** @param {RenderModel} model */
function subjects(model) {
  return model.rows.flatMap(row =>
    row.type === "commit" ? [row.commit.subject] : []
  );
}

/** The merged branches the host reports as safe to delete. @param {RenderModel} model */
function deletableNames(model) {
  return model.mergedBranches
    .filter(branch => !branch.keptReason)
    .map(branch => branch.name);
}

/**
 * @param {MergedBranch[]} merged
 * @param {string} name
 */
function reasonFor(merged, name) {
  const found = present(
    merged.find(branch => branch.name === name),
    `merged branch ${name}`
  );
  return present(found.keptReason, `a reason for keeping ${name}`);
}

/**
 * @param {Controller} controller
 * @param {string[]} branches
 */
async function requestDeletion(controller, branches) {
  const result = await controller.handle("deleteMergedBranches", { branches });
  assert.ok(result.ok, result.ok ? "" : result.error);
  return /** @type {{ deleted: string[], kept: MergedBranch[], model: RenderModel }} */ (
    result.data
  );
}

test("a branch merged at its tip is deleted, and its commit leaves the tree", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-b", "MERGED");

  const before = await fixture.controller.model();
  assert.deepEqual(before.mergedBranches, [
    {
      name: "feature-b",
      sha: shaOf(fixture.repo, "feature-b"),
      keptReason: null,
    },
  ]);
  assert.ok(subjects(before).includes("feat: B"));

  const { deleted, kept, model } = await requestDeletion(fixture.controller, [
    "feature-b",
  ]);
  assert.deepEqual(deleted, ["feature-b"]);
  assert.deepEqual(kept, []);
  assert.equal(branchShas(fixture.repo).has("feature-b"), false);
  assert.deepEqual(model.mergedBranches, []);
  // The commit only feature-b reached is gone; the layer below keeps its own.
  assert.deepEqual(subjects(model), ["feat: A"]);
});

test("a branch amended after its pull request merged is kept, and says which commit merged", async t => {
  const fixture = buildFixture(t);
  const mergedSha = shaOf(fixture.repo, "feature-b");
  recordPullRequest(fixture, "feature-b", "MERGED", mergedSha);

  run(fixture.repo, "git", ["switch", "-q", "feature-b"]);
  run(fixture.repo, "git", ["commit", "-q", "--amend", "-m", "feat: B, v2"]);
  run(fixture.repo, "git", ["switch", "-q", "main"]);
  const amendedSha = shaOf(fixture.repo, "feature-b");
  assert.notEqual(amendedSha, mergedSha);

  const model = await fixture.controller.model();
  assert.deepEqual(deletableNames(model), []);
  const reason = reasonFor(model.mergedBranches, "feature-b");
  assert.match(reason, /holds commits its pull request never had/);
  // Both shas, so the reader can check the claim rather than take it.
  assert.match(
    reason,
    new RegExp(`${amendedSha.slice(0, 8)}.*${mergedSha.slice(0, 8)}`)
  );

  // Asked for by name anyway, as a webview holding an older model would.
  const { deleted } = await requestDeletion(fixture.controller, ["feature-b"]);
  assert.deepEqual(deleted, []);
  assert.equal(shaOf(fixture.repo, "feature-b"), amendedSha);
});

test("a commit added after the read keeps the branch, and reports git's refusal", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-b", "MERGED");
  const staleSnapshot = await fixture.repository.read();

  // The race the expected sha exists for: the branch moves between the read that qualified
  // it and the delete.
  run(fixture.repo, "git", ["switch", "-q", "feature-b"]);
  commitFile(fixture.repo, "c.txt", "C\n", "feat: C");
  run(fixture.repo, "git", ["switch", "-q", "main"]);
  const movedSha = shaOf(fixture.repo, "feature-b");

  const { deleted, kept } = await deleteMergedBranches(
    fixture.repository.git,
    staleSnapshot,
    fixture.repository.pullRequests.cached(),
    ["feature-b"]
  );
  assert.deepEqual(deleted, []);
  assert.match(reasonFor(kept, "feature-b"), /git refused to delete it/);
  assert.equal(shaOf(fixture.repo, "feature-b"), movedSha);
});

test("a moved branch keeps only itself, not the rest of the batch", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-a", "MERGED");
  recordPullRequest(fixture, "feature-b", "MERGED");
  const staleSnapshot = await fixture.repository.read();

  run(fixture.repo, "git", ["switch", "-q", "feature-b"]);
  commitFile(fixture.repo, "c.txt", "C\n", "feat: C");
  run(fixture.repo, "git", ["switch", "-q", "main"]);

  // `update-ref` refuses the whole batch for the one branch that moved, so the retry goes
  // branch by branch. Refusing feature-a as well would leave it in the tree with nothing
  // wrong with it, and the webview would already have recorded it as asked for.
  const { deleted, kept } = await deleteMergedBranches(
    fixture.repository.git,
    staleSnapshot,
    fixture.repository.pullRequests.cached(),
    ["feature-a", "feature-b"]
  );
  assert.deepEqual(deleted, ["feature-a"]);
  assert.deepEqual(
    kept.map(branch => branch.name),
    ["feature-b"]
  );
  assert.equal(branchShas(fixture.repo).has("feature-a"), false);
  assert.ok(branchShas(fixture.repo).has("feature-b"));
});

test("an open or closed pull request makes the branch no business of this at all", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-a", "OPEN");
  recordPullRequest(fixture, "feature-b", "CLOSED");
  assert.deepEqual((await fixture.controller.model()).mergedBranches, []);
});

test("a merged pull request whose head GitHub did not report keeps the branch", async t => {
  const fixture = buildFixture(t);
  // Merged, but with no head commit to compare: nothing proves the branch unchanged.
  recordPullRequest(fixture, "feature-b", "MERGED", "");

  const model = await fixture.controller.model();
  assert.deepEqual(deletableNames(model), []);
  assert.match(reasonFor(model.mergedBranches, "feature-b"), /no head commit/);
});

test("the checked-out branch is kept, and the reason names what to do", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-b", "MERGED");
  run(fixture.repo, "git", ["switch", "-q", "feature-b"]);

  const model = await fixture.controller.model();
  assert.deepEqual(deletableNames(model), []);
  assert.match(
    reasonFor(model.mergedBranches, "feature-b"),
    /checked out — check out trunk first/
  );

  const { deleted } = await requestDeletion(fixture.controller, ["feature-b"]);
  assert.deepEqual(deleted, []);
  assert.ok(branchShas(fixture.repo).has("feature-b"));
});

test("a branch another worktree holds is kept, and the reason names the worktree", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-b", "MERGED");
  const elsewhere = join(scratchRoot(t, "gsm-delete-merged-worktree-"), "wt");
  run(fixture.repo, "git", ["worktree", "add", "-q", elsewhere, "feature-b"]);

  const model = await fixture.controller.model();
  assert.deepEqual(deletableNames(model), []);
  assert.match(
    reasonFor(model.mergedBranches, "feature-b"),
    /another worktree holds it/
  );
});

test("nothing qualifies while a rebase is stopped, and every branch says so", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-b", "MERGED");
  const snapshot = await fixture.repository.read();
  const pullRequests = fixture.repository.pullRequests.cached();
  assert.deepEqual(
    mergedBranches(snapshot, pullRequests).map(branch => branch.keptReason),
    [null]
  );

  const conflict = {
    branch: "feature-a",
    unmergedFiles: ["a.txt"],
    step: 1,
    totalSteps: 1,
  };
  const stopped = mergedBranches({ ...snapshot, conflict }, pullRequests);
  assert.match(reasonFor(stopped, "feature-b"), /a rebase is stopped/);
});

test("only the branches asked for are deleted", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-a", "MERGED");
  recordPullRequest(fixture, "feature-b", "MERGED");

  const { deleted } = await requestDeletion(fixture.controller, ["feature-b"]);
  assert.deepEqual(deleted, ["feature-b"]);
  assert.ok(branchShas(fixture.repo).has("feature-a"));
});

test("undo brings a deleted branch back at the commit it held", async t => {
  const fixture = buildFixture(t);
  recordPullRequest(fixture, "feature-b", "MERGED");
  const before = branchShas(fixture.repo);

  const { model } = await requestDeletion(fixture.controller, ["feature-b"]);
  assert.equal(model.undoLabel, "Delete merged branches");

  const undone = await fixture.controller.handle("undo", {});
  assert.ok(undone.ok);
  assert.deepEqual(branchShas(fixture.repo), before);
  assert.ok(subjects(await fixture.controller.model()).includes("feat: B"));
});

test("a request that deletes nothing leaves nothing to undo", async t => {
  const fixture = buildFixture(t);
  // No pull request recorded, so neither branch asked for qualifies.
  const { deleted, model } = await requestDeletion(fixture.controller, [
    "feature-a",
    "feature-b",
  ]);

  assert.deepEqual(deleted, []);
  // Undo restores refs, and a request that moved none would otherwise shadow the edit a reader
  // actually wants back.
  assert.equal(model.undoLabel, null);
});

test("a deleted branch takes its upstream config with it", async t => {
  const fixture = buildFixture(t);
  run(fixture.repo, "git", ["push", "-q", "-u", "origin", "feature-b"]);
  recordPullRequest(fixture, "feature-b", "MERGED");

  const result = await fixture.controller.handle("deleteMergedBranches", {
    branches: ["feature-b"],
  });
  assert.ok(result.ok);
  // Left behind, a branch created later under this name would silently track the old one.
  assert.throws(() =>
    run(fixture.repo, "git", ["config", "--get", "branch.feature-b.remote"])
  );
  // What ran is in the command log, as for every other edit.
  const commands = present(result.log, "the deletion's command log").commands;
  assert.ok(commands.some(command => command.includes("update-ref")));
});
