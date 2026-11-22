/**
 * What **Move stack onto the remote** does to the layers.
 *
 * The fixture builds the state that GitHub leaves behind once a stacked pull request merges. A
 * teammate's clone substitutes for GitHub: the clone advances trunk, replays every layer onto it,
 * and force-pushes all three. The work repository then still points at the pre-rebase commits, and
 * holds nothing of its own.
 *
 * Most of these tests check a refusal, as `pull.test.mjs` does. The move replaces local commits
 * outright, so each refusal test asserts that no layer moved, rather than only that the call threw.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitFile, OTHER, run } from "../scripts/git-fixture.mjs";
import {
  branchShas,
  shaOf,
  statusOf,
  teammateClone,
  trunkRepository,
} from "./repoFixture.mjs";

const LAYERS = ["lower", "middle", "upper"];

/**
 * Three pushed layers, registered with `gh stack`, and HEAD on the middle one.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function pushedStack(t, prefix) {
  const fixture = trunkRepository(t, prefix);
  const { repo, root, origin } = fixture;
  for (const branch of LAYERS) {
    run(repo, "git", ["switch", "-qc", branch]);
    commitFile(repo, `${branch}.txt`, `${branch}\n`, `${branch} work`);
    run(repo, "git", ["push", "-qu", "origin", branch]);
  }
  run(repo, "git", ["switch", "-q", "middle"]);
  return { ...fixture, other: teammateClone(root, origin) };
}

/**
 * Advance trunk and replay every layer onto it from the clone, then force-push — what GitHub's
 * own restack does to the branches of a stack whose bottom pull request merged.
 *
 * @param {string} clone
 */
function restackFromClone(clone) {
  commitFile(clone, "theirs.txt", "theirs\n", "their trunk work", OTHER);
  run(clone, "git", ["push", "-q", "origin", "main"], OTHER);
  let base = "main";
  for (const branch of LAYERS) {
    run(clone, "git", ["switch", "-qc", branch, `origin/${branch}`], OTHER);
    run(clone, "git", ["rebase", "-q", base], OTHER);
    base = branch;
  }
  run(clone, "git", ["push", "-qf", "origin", ...LAYERS], OTHER);
}

test("every layer moves onto the commit that its remote holds", async t => {
  const { repo, other, repository } = pushedStack(t, "gsm-adopt-");
  restackFromClone(other);

  const outcome = await repository.adoptRemoteStack("middle");

  assert.deepEqual(outcome.moved, LAYERS);
  assert.deepEqual(outcome.skipped, []);
  assert.equal(outcome.checkedOut, "middle", "HEAD's layer moved with it");
  const shas = branchShas(repo);
  for (const branch of LAYERS) {
    assert.equal(
      shas.get(branch),
      shaOf(repo, `origin/${branch}`),
      `${branch} points at its remote's commit`
    );
  }
  // The point of adopting: the layers now hold the teammate's trunk commit, with no push.
  assert.equal(
    run(repo, "git", ["rev-list", "--count", "upper", "^origin/main"]),
    "3"
  );
  assert.equal(
    statusOf(repo),
    "",
    "the checked-out layer's files moved cleanly"
  );
});

test("the outcome lists a layer already on its remote's commit rather than moving it", async t => {
  const { repository } = pushedStack(t, "gsm-adopt-current-");

  const outcome = await repository.adoptRemoteStack("lower");

  assert.deepEqual(outcome.moved, []);
  assert.deepEqual(outcome.current, LAYERS);
});

test("the move refuses the whole stack when one layer holds an unpushed commit", async t => {
  const { repo, other, repository } = pushedStack(t, "gsm-adopt-unpushed-");
  restackFromClone(other);
  run(repo, "git", ["switch", "-q", "upper"]);
  commitFile(repo, "mine.txt", "mine\n", "work only I have");
  const before = branchShas(repo);

  await assert.rejects(
    () => repository.adoptRemoteStack("middle"),
    /upper holds 1 commit\(s\) that origin\/upper does not/
  );

  assert.deepEqual(
    branchShas(repo),
    before,
    "no layer moved, so the unpushed commit is still reachable"
  );
});

test("the move refuses a locally reworded layer, because --cherry-pick matches on the patch alone", async t => {
  const { repo, other, repository } = pushedStack(t, "gsm-adopt-reword-");
  restackFromClone(other);
  run(repo, "git", ["switch", "-q", "lower"]);
  run(repo, "git", ["commit", "-q", "--amend", "-m", "lower work, reworded"]);
  const before = branchShas(repo);

  await assert.rejects(
    () => repository.adoptRemoteStack("lower"),
    /different commit messages/
  );

  assert.deepEqual(
    branchShas(repo),
    before,
    "the reworded commit is still there"
  );
});

test("the move still runs when layers carry trunk commits from a local rebase", async t => {
  const { repo, other, repository } = pushedStack(t, "gsm-adopt-rebased-");
  restackFromClone(other);
  // The half-finished sync this action repairs: trunk fetched and the layers replayed onto it
  // locally, so each one carries trunk's new commit while the remote's copies do not. Those
  // commits belong to trunk, and counting them as local work refused the one case that needs this.
  run(repo, "git", ["fetch", "-q", "origin"]);
  run(repo, "git", ["switch", "-q", "main"]);
  run(repo, "git", ["merge", "-q", "--ff-only", "origin/main"]);
  run(repo, "git", ["rebase", "-q", "--update-refs", "main", "upper"]);
  run(repo, "git", ["switch", "-q", "middle"]);

  const outcome = await repository.adoptRemoteStack("middle");

  assert.deepEqual(outcome.moved, LAYERS);
  const shas = branchShas(repo);
  for (const branch of LAYERS) {
    assert.equal(shas.get(branch), shaOf(repo, `origin/${branch}`));
  }
});

test("the move refuses uncommitted changes on the checked-out layer before any ref moves", async t => {
  const { repo, other, repository } = pushedStack(t, "gsm-adopt-dirty-");
  restackFromClone(other);
  writeFileSync(join(repo, "middle.txt"), "edited in place\n");
  const before = branchShas(repo);

  await assert.rejects(
    () => repository.adoptRemoteStack("middle"),
    /Commit, amend, or stash your changes/
  );

  assert.deepEqual(branchShas(repo), before);
  assert.equal(
    run(repo, "git", ["show", ":middle.txt"]).length > 0,
    true,
    "the edit is untouched"
  );
});

test("a branch with nothing stacked on it is a stack of one, and the others stay put", async t => {
  const { repo, repository, other } = pushedStack(t, "gsm-adopt-unstacked-");
  restackFromClone(other);
  run(repo, "git", ["switch", "-qc", "solo", "main"]);
  commitFile(repo, "solo.txt", "solo\n", "solo work");
  const before = branchShas(repo);

  const outcome = await repository.adoptRemoteStack("solo");

  // Never pushed, so it has no remote commit to take, and the stack beside it is not asked.
  assert.deepEqual(outcome.moved, []);
  assert.deepEqual(
    outcome.skipped.map(layer => layer.branch),
    ["solo"]
  );
  assert.deepEqual(branchShas(repo), before);
});
