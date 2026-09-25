/**
 * The trunk row: which local branch it stands for, how far that branch trails the ref, and
 * what a branch measured against trunk reads as.
 *
 * Three problems share one subject, so they share one file.
 *
 * *Which branch.* `git switch origin/main` detaches HEAD, so the row cannot offer the ref
 * it displays; it has to find the local branch behind it. Name is not enough — someone's
 * trunk is called `trunk` — and tracking is not enough either, because branching off a
 * remote ref inherits it as upstream, so ordinary feature branches track `origin/main` too.
 *
 * *How far behind.* A `main` that has simply not been pulled has no commits of its own, so
 * the local-only range yields nothing for it: no commit row, no branch pill, nowhere for a
 * sync badge to go. The graph showed a fetched `origin/main` and nothing at all about the
 * branch 42 commits below it, while the editor's own status bar said so. The count therefore
 * rides on the trunk row.
 *
 * *Inherited upstream.* That same inheritance makes a feature branch read "1 ahead, 32
 * behind" once trunk moves, on work that was never pushed. The badge used to call that
 * divergence, in red.
 *
 * The teammate clone is what moves `origin/main`: a branch cannot fall behind a remote it is
 * the only one pushing to.
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildModel } from "#ui/renderModel";
import { commitFile, run } from "../scripts/git-fixture.mjs";
import { syncBadge, trunkBehindBadge } from "../src/webview/model/badges.mts";
import { present } from "./present.mjs";
import {
  pushFromClone,
  teammateClone,
  trunkRepository,
} from "./repoFixture.mjs";

/**
 * A repository whose local `main` is two commits behind `origin/main` and has none of its
 * own, which is the state that used to show nothing.
 *
 * The reader never fetches, so the fixture is what makes `origin/main` the newer ref.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function behindTrunk(t, prefix) {
  const fixture = trunkRepository(t, prefix);
  const other = teammateClone(fixture.root, fixture.origin);
  pushFromClone(other, "theirs.txt", "other work theirs.txt");
  pushFromClone(other, "theirs2.txt", "other work theirs2.txt");
  run(fixture.repo, "git", ["fetch", "-q", "origin"]);
  return fixture;
}

/**
 * A repository where `main` and `dev/feature` are both one commit ahead of `origin/main`
 * and two behind it. The same counts against the same upstream leave which branch trunk
 * resolves to as the only thing separating the two verdicts, which is the whole of the
 * exclusion; asserting it any other way would pass on the counts alone. Local main really
 * has diverged here, and pull or rebase is the right advice for it.
 *
 * `branch.autoSetupMerge` is pinned per-command rather than left to the machine: the
 * behaviour under test is what the badge does with an inherited upstream, and this suite
 * would otherwise pass or fail according to the developer's own git configuration.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function inheritedUpstream(t, prefix) {
  const fixture = trunkRepository(t, prefix);
  const { repo } = fixture;
  const other = teammateClone(fixture.root, fixture.origin);

  run(repo, "git", [
    "-c",
    "branch.autoSetupMerge=true",
    "switch",
    "-c",
    "dev/feature",
    "origin/main",
  ]);
  commitFile(repo, "feature.txt", "feature\n", "feat: the branch's own commit");

  run(repo, "git", ["switch", "main"]);
  commitFile(
    repo,
    "trunk-local.txt",
    "local\n",
    "chore: unpushed work on main"
  );

  pushFromClone(other, "theirs.txt", "other work theirs.txt");
  pushFromClone(other, "theirs2.txt", "other work theirs2.txt");
  run(repo, "git", ["fetch", "-q", "origin"]);
  run(repo, "git", ["switch", "dev/feature"]);
  return fixture;
}

/**
 * The trunk row, which every fixture here has exactly one of.
 *
 * @param {import("#ui/renderModel").RenderModel} model
 */
function trunkRow(model) {
  return present(
    model.rows.find(row => row.type === "trunk-tip"),
    "a trunk row"
  );
}

/**
 * Every branch pill the model draws, by branch name.
 *
 * @param {import("#ui/renderModel").RenderModel} model
 */
function branchesByName(model) {
  return new Map(
    model.rows
      .filter(row => row.type === "commit")
      .flatMap(row => row.commit.branchDetails)
      .map(branch => [branch.name, branch])
  );
}

test("the trunk row offers the local branch that tracks trunk, not the remote ref", async t => {
  const { repository } = trunkRepository(t, "gsm-trunk-branch-");
  const snapshot = await repository.read();

  assert.equal(snapshot.trunkRef, "origin/main");
  assert.equal(snapshot.trunkBranch, "main");
  // Trunk is checked out right here, which is the one worktree that never blocks a Goto.
  assert.equal(snapshot.heldBranches.size, 0);
});

test("a differently named branch is found by what it tracks", async t => {
  const { repo, repository } = trunkRepository(t, "gsm-trunk-renamed-");
  // Tracking is the authority, not the name: someone whose local trunk is called
  // `trunk` still gets a working Goto.
  run(repo, "git", ["branch", "-m", "main", "trunk"]);
  run(repo, "git", ["branch", "--set-upstream-to=origin/main", "trunk"]);

  const snapshot = await repository.read();

  assert.equal(snapshot.trunkRef, "origin/main");
  assert.equal(snapshot.trunkBranch, "trunk");
});

test("a feature branch that also tracks trunk does not become the trunk row's branch", async t => {
  const { repo, repository } = trunkRepository(t, "gsm-trunk-shared-upstream-");
  // Taking the first tracker made Goto on the `origin/main` row check out
  // `dev/feature`, which sorts ahead of `main`.
  run(repo, "git", ["switch", "-qc", "dev/feature", "origin/main"]);
  assert.equal(
    run(repo, "git", ["rev-parse", "--abbrev-ref", "dev/feature@{upstream}"]),
    "origin/main"
  );
  commitFile(repo, "feature.txt", "feature\n", "feature work");

  const snapshot = await repository.read();

  assert.equal(snapshot.trunkBranch, "main");
  assert.equal(snapshot.heldBranches.size, 0);
});

test("several trackers and no branch named for trunk offer nothing rather than a guess", async t => {
  const { repo, repository } = trunkRepository(t, "gsm-trunk-ambiguous-");
  // Two branches track `origin/main` and neither is named `main`, so nothing
  // distinguishes them. Offering either would send Goto somewhere the row never named.
  run(repo, "git", ["branch", "-m", "main", "trunk"]);
  run(repo, "git", ["branch", "--set-upstream-to=origin/main", "trunk"]);
  run(repo, "git", ["switch", "-qc", "dev/feature", "origin/main"]);

  const snapshot = await repository.read();

  assert.equal(snapshot.trunkRef, "origin/main");
  assert.equal(snapshot.trunkBranch, null);
});

test("trunk held by another worktree names the directory holding it", async t => {
  const { root, repo, repository } = trunkRepository(t, "gsm-trunk-worktree-");
  // Git binds a branch to one worktree, so `git switch main` here would fail outright.
  // The row needs the path to say so instead of surfacing git's refusal.
  run(repo, "git", ["switch", "-qc", "side"]);
  const held = join(root, "held");
  run(repo, "git", ["worktree", "add", "-q", held, "main"]);

  const snapshot = await repository.read();

  assert.equal(snapshot.trunkBranch, "main");
  assert.equal(snapshot.heldBranches.get("main"), realpathSync(held));
  // The row carries it, since the row is what draws the disabled Goto.
  assert.equal(
    trunkRow(buildModel(snapshot)).trunkBranchWorktree,
    realpathSync(held)
  );
});

test("trunk with no local counterpart offers no branch at all", async t => {
  const { repo, repository } = trunkRepository(t, "gsm-trunk-none-");
  // Work on a side branch and delete the local trunk: `origin/main` still exists, but
  // nothing local reaches it, so the row must offer nothing rather than detach HEAD.
  run(repo, "git", ["switch", "-qc", "feature"]);
  commitFile(repo, "feature.txt", "feature\n", "feature work");
  run(repo, "git", ["branch", "-D", "main"]);

  const snapshot = await repository.read();

  assert.equal(snapshot.trunkRef, "origin/main");
  assert.equal(snapshot.trunkBranch, null);
});

test("a trunk branch with no commits of its own still reports how far behind it is", async t => {
  const { repository } = behindTrunk(t, "gsm-trunk-behind-");
  const rawData = await repository.read();
  // Free with the ref read that already runs: `%(upstream:track,nobracket)` on main.
  assert.deepEqual(rawData.trunkBranchSync, {
    name: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 2,
    gone: false,
  });

  const model = buildModel(rawData);
  assert.equal(
    model.rows.filter(row => row.type === "commit").length,
    0,
    "nothing local is ahead of trunk, so the trunk row is the only place to say it"
  );

  const row = trunkRow(model);
  assert.equal(row.trunkBranchBehind, 2);
  const badge = present(
    trunkBehindBadge(
      row.trunkBranch,
      row.trunkBranchBehind,
      row.trunkRef,
      true
    ),
    "a behind badge"
  );
  assert.equal(badge.label, "main is 2 behind");
  assert.match(badge.description, /Pull fast-forwards it/);
});

test("the behind count holds while HEAD is on another branch, where the row's own Goto is the fix", async t => {
  const { repo, repository } = behindTrunk(t, "gsm-trunk-behind-elsewhere-");
  run(repo, "git", ["switch", "-qc", "dev/feature"]);
  commitFile(repo, "feature.txt", "feature\n", "feat: my work");

  const model = buildModel(await repository.read());
  assert.equal(model.headBranch, "dev/feature");
  const row = trunkRow(model);
  assert.equal(row.trunkBranchBehind, 2);

  // The advice follows where HEAD is, because Pull only ever moves the branch you are
  // on: from here the row's Goto is what both checks main out and brings it level.
  const badge = present(
    trunkBehindBadge(
      row.trunkBranch,
      row.trunkBranchBehind,
      row.trunkRef,
      false
    ),
    "a behind badge"
  );
  assert.match(badge.description, /Goto this row fast-forwards it/);
});

test("a fetch after Goto on the trunk row leaves You are here on main's own row", async t => {
  // Goto brought main level with origin/main; the next background fetch moved origin/main on.
  // Main's commit was then neither local nor a fork base, so no row drew HEAD at all.
  const fixture = trunkRepository(t, "gsm-trunk-left-behind-");
  const { repo, repository } = fixture;
  const other = teammateClone(fixture.root, fixture.origin);
  pushFromClone(other, "theirs.txt", "other work theirs.txt");
  run(repo, "git", ["fetch", "-q", "origin"]);
  await repository.gotoTrunk();
  pushFromClone(other, "theirs2.txt", "other work theirs2.txt");
  pushFromClone(other, "theirs3.txt", "other work theirs3.txt");
  run(repo, "git", ["fetch", "-q", "origin"]);

  const rawData = await repository.read();
  const model = buildModel(rawData);
  assert.deepEqual(
    model.rows.map(row => row.type),
    ["trunk-tip", "ellipsis", "base"]
  );
  assert.equal(trunkRow(model).isHead, false);
  assert.equal(trunkRow(model).trunkBranchAtTip, false);
  const ellipsis = present(model.rows[1], "the ellipsis row");
  assert.equal(ellipsis.type === "ellipsis" && ellipsis.count, 1);
  const mainRow = present(model.rows[2], "main's row");
  assert.equal(mainRow.type, "base");
  assert.equal(mainRow.type === "base" && mainRow.sha, rawData.headSha);
  assert.equal(mainRow.type === "base" && mainRow.isHead, true);
  assert.equal(mainRow.type === "base" && mainRow.trunkBranch, "main");
  assert.equal(
    mainRow.type === "base" && mainRow.isForkPoint,
    false,
    "nothing forked here, so the row claims no base"
  );
});

test("a trunk branch level with the ref rides on the trunk row as a pill", async t => {
  const { repository } = trunkRepository(t, "gsm-trunk-level-pill-");
  const model = buildModel(await repository.read());

  assert.equal(trunkRow(model).trunkBranchAtTip, true);
  assert.equal(trunkRow(model).isHead, true);
  assert.equal(
    model.rows.filter(row => row.type === "base").length,
    0,
    "main's commit is the tip, so it needs no row of its own"
  );
});

test("a trunk branch left at a fork point shares that base row", async t => {
  const fixture = trunkRepository(t, "gsm-trunk-left-at-base-");
  const { repo, repository } = fixture;
  const other = teammateClone(fixture.root, fixture.origin);
  run(repo, "git", ["switch", "-qc", "dev/feature"]);
  commitFile(repo, "feature.txt", "feature\n", "feat: my work");
  pushFromClone(other, "theirs.txt", "other work theirs.txt");
  run(repo, "git", ["fetch", "-q", "origin"]);

  const model = buildModel(await repository.read());
  const bases = model.rows.filter(row => row.type === "base");
  assert.equal(bases.length, 1, "one row, not a base and a main side by side");
  const [forkPoint] = bases;
  assert.equal(forkPoint?.isForkPoint, true);
  assert.equal(forkPoint?.trunkBranch, "main");
  assert.equal(forkPoint?.isHead, false);
});

/**
 * The anchor rows below the trunk row, which is where a HEAD on an old trunk commit lands.
 *
 * @param {import("#ui/renderModel").RenderModel} model
 */
function anchorsBelowTip(model) {
  return model.rows.flatMap(row => (row.type === "base" ? [row] : []));
}

/**
 * `behindTrunk`, with main then brought level so the only commit below the tip left to draw
 * is the one HEAD moves to.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function levelTrunk(t, prefix) {
  const fixture = behindTrunk(t, prefix);
  run(fixture.repo, "git", ["merge", "-q", "--ff-only", "origin/main"]);
  return fixture;
}

test("a HEAD detached on an old trunk commit gets a row of its own", async t => {
  // Nothing forks there and no branch points there, so the walk, which leaves out
  // everything reachable from trunk, gave the commit no row and "You are here" no place.
  const { repo, repository } = levelTrunk(t, "gsm-head-detached-old-");
  run(repo, "git", ["switch", "-q", "--detach", "origin/main~1"]);

  const rawData = await repository.read();
  const model = buildModel(rawData);
  assert.equal(trunkRow(model).isHead, false);
  const [row, ...rest] = anchorsBelowTip(model);
  assert.equal(rest.length, 0);
  assert.equal(row?.sha, rawData.headSha);
  assert.equal(row?.isHead, true);
  assert.equal(row?.isForkPoint, false);
  assert.equal(row?.trunkBranch, null, "main is on the tip, not here");
  assert.equal(row?.headBranch, null, "a detached HEAD has no branch to pill");
});

test("a branch cut from an old trunk commit and not yet committed to shows its pill there", async t => {
  const { repo, repository } = levelTrunk(t, "gsm-head-empty-branch-");
  run(repo, "git", ["switch", "-qc", "spike", "origin/main~2"]);

  const model = buildModel(await repository.read());
  const [row] = anchorsBelowTip(model);
  assert.equal(row?.isHead, true);
  assert.equal(row?.headBranch, "spike");
  assert.equal(
    present(model.rows[1], "the row between").type,
    "ellipsis",
    "the commit between the tip and HEAD is folded, not drawn"
  );
});

test("a HEAD detached on the trunk branch's commit shares that branch's row", async t => {
  const { repo, repository } = behindTrunk(t, "gsm-head-detached-on-main-");
  run(repo, "git", ["switch", "-q", "--detach", "main"]);

  const bases = anchorsBelowTip(buildModel(await repository.read()));
  assert.equal(bases.length, 1, "one row, not main's and HEAD's side by side");
  assert.equal(bases[0]?.trunkBranch, "main");
  assert.equal(bases[0]?.isHead, true);
  assert.equal(bases[0]?.headBranch, null);
});

test("a HEAD detached on the trunk tip stays on the trunk row", async t => {
  const { repo, repository } = trunkRepository(t, "gsm-head-detached-tip-");
  run(repo, "git", ["switch", "-q", "--detach", "origin/main"]);

  const rawData = await repository.read();
  assert.equal(rawData.headCommit, null, "the trunk row already draws it");
  const model = buildModel(rawData);
  assert.equal(trunkRow(model).isHead, true);
  assert.equal(anchorsBelowTip(model).length, 0);
});

test("a trunk branch level with the ref earns no badge", async t => {
  const { repository } = behindTrunk(t, "gsm-trunk-behind-current-");
  await repository.pull();

  const row = trunkRow(buildModel(await repository.read()));
  assert.equal(row.trunkBranchBehind, 0);
  assert.equal(
    trunkBehindBadge(
      row.trunkBranch,
      row.trunkBranchBehind,
      row.trunkRef,
      true
    ),
    null,
    "a branch with nothing to pull earns no badge"
  );
});

test("a diverged trunk branch leaves the counts to its own commit row", async t => {
  const { repo, repository } = behindTrunk(t, "gsm-trunk-behind-diverged-");
  // An unpushed commit on main puts it on the graph, where its pill carries `1↑2↓`.
  // Repeating "2 behind" on the trunk row above states the same lag twice, in two
  // vocabularies, and the row's own advice — Pull — would be refused as a divergence.
  commitFile(repo, "mine.txt", "mine\n", "chore: unpushed work on main");

  const rawData = await repository.read();
  const sync = present(rawData.trunkBranchSync, "the trunk branch's sync");
  assert.equal(sync.ahead, 1);
  assert.equal(sync.behind, 2);

  const model = buildModel(rawData);
  assert.equal(trunkRow(model).trunkBranchBehind, 0);
  assert.deepEqual(
    model.rows
      .filter(row => row.type === "commit")
      .flatMap(row => row.commit.branchDetails ?? [])
      .map(branch => branch.name),
    ["main"],
    "main has a row of its own to carry the counts"
  );
  assert.equal(
    model.rows.some(row => row.type === "base" && row.trunkBranch),
    false,
    "a main with commits of its own is not also drawn on trunk"
  );
});

test("a trunk branch whose upstream is gone reports nothing rather than a stale count", async t => {
  const { repo, repository } = behindTrunk(t, "gsm-trunk-behind-gone-");
  // Point main at a remote branch that then disappears — a merged-and-deleted branch,
  // or a renamed remote. Git keeps answering `[gone]` for the tracking field, and a
  // count against a branch nobody has is noise rather than something to pull.
  run(repo, "git", ["update-ref", "refs/remotes/origin/deleted", "HEAD"]);
  run(repo, "git", ["branch", "--set-upstream-to=origin/deleted", "main"]);
  run(repo, "git", ["update-ref", "-d", "refs/remotes/origin/deleted"]);

  const rawData = await repository.read();
  // Trunk still resolves to main by name, now that nothing tracks `origin/main`.
  assert.equal(rawData.trunkBranch, "main");
  assert.equal(present(rawData.trunkBranchSync, "the trunk sync").gone, true);
  assert.equal(trunkRow(buildModel(rawData)).trunkBranchBehind, 0);
});

test("a branch that inherited trunk as upstream is marked, and trunk's own branch is not", async t => {
  const { repository } = inheritedUpstream(t, "gsm-tracks-trunk-");
  const rawData = await repository.read();
  assert.equal(rawData.trunkRef, "origin/main");
  assert.equal(rawData.trunkBranch, "main");

  const branches = branchesByName(buildModel(rawData));
  const feature = present(branches.get("dev/feature"), "the feature branch");
  const trunk = present(branches.get("main"), "the local trunk branch");

  // Same upstream, same counts: the verdicts below cannot come from the numbers.
  for (const branch of [feature, trunk]) {
    const sync = present(branch.sync, `sync for ${branch.name}`);
    assert.equal(sync.upstream, "origin/main");
    assert.equal(sync.ahead, 1);
    assert.equal(sync.behind, 2);
  }

  assert.equal(feature.tracksTrunk, true);
  assert.equal(trunk.tracksTrunk, false);
});

test("the inherited upstream reads as tracking trunk, while trunk's branch reads as diverged", async t => {
  // The model flag exists to change what the reader sees, so this asserts the badge
  // rather than stopping at the boolean.
  const { repository } = inheritedUpstream(t, "gsm-tracks-trunk-badge-");
  const branches = branchesByName(buildModel(await repository.read()));
  /** @param {string} name */
  const badgeFor = name => {
    const branch = present(branches.get(name), `the branch ${name}`);
    return present(
      syncBadge(branch.sync, branch.pullRequest, branch.tracksTrunk),
      `a sync badge for ${name}`
    );
  };

  const feature = badgeFor("dev/feature");
  assert.equal(feature.variant, "trackstrunk");
  assert.equal(feature.label, "1↑2↓ vs origin/main");

  assert.equal(badgeFor("main").variant, "diverged");
});
