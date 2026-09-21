/**
 * What every refusal has in common: it changes nothing.
 *
 * The suites beside this one check that each guard fires and what it says. The property a
 * reader actually leans on is the other half — a refusal that has already staged a file,
 * moved a branch, or left a rebase half-applied is worse than one that never ran, because
 * the message promises nothing happened. Sideways `amend into` was exactly that: it reported
 * the refusal and left the change in the target commit as well as in the working copy.
 *
 * One case per guard, all driven through the controller, so the payload narrowing and the
 * `{ok: false}` contract sit in the path too. `arrange` runs before the state is recorded,
 * which leaves a case free to check out a branch, dirty a file, or make a successful edit on
 * the way to the guard it is after.
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Controller } from "#ui/controller";
import { run } from "../scripts/git-fixture.mjs";
import {
  markerRefs,
  shaOf,
  stackBranches,
  statusOf,
  trunkRepository,
} from "./repoFixture.mjs";

/**
 * @typedef {object} Fixture
 * @property {string} repo
 * @property {Controller} controller
 */

/**
 * @typedef {object} Refusal
 * @property {string} what Names the guard, and becomes the test's name.
 * @property {(fixture: Fixture) => void | Promise<void>} [arrange] Reach the guard's state.
 * @property {(fixture: Fixture) => Promise<import("#ui/controller").ActionResult>} act
 * @property {RegExp} error
 */

/**
 * A pushed trunk commit, two local commits above it with a branch each, HEAD on the upper
 * one — the position a reader acts from. Cases that need more build it in `arrange`.
 *
 * @param {import("node:test").TestContext} t
 */
function refusalRepository(t) {
  const fixture = trunkRepository(t, "gsm-refusal-");
  stackBranches(fixture.repo, [
    { branch: "feature-a", file: "a.txt", message: "feat: A" },
    { branch: "feature-b", file: "b.txt", message: "feat: B" },
  ]);
  return { ...fixture, controller: new Controller(fixture.repository) };
}

/**
 * Everything a refusal has to leave alone, in one comparable value.
 *
 * The field names carry the failure: a diff that names `markers` is a leaked scratch ref,
 * one that names `status` is a file staged on the way out.
 *
 * Local refs only. Rebasing onto trunk fetches before it plans, so a refusal downstream of
 * that fetch legitimately writes `refs/remotes/*` — and writes `origin/HEAD` for the first
 * time. What the reader stands to lose is their own history, which is what these fields hold.
 *
 * @param {string} repo
 */
function stateOf(repo) {
  return {
    refs: run(repo, "git", [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/tags",
      "refs/stash",
    ]),
    head: shaOf(repo, "HEAD"),
    // "HEAD" itself when detached, which is what makes a stray checkout visible here.
    branch: run(repo, "git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    status: statusOf(repo),
    markers: markerRefs(repo),
    rebasing:
      existsSync(join(repo, ".git", "rebase-merge")) ||
      existsSync(join(repo, ".git", "rebase-apply")),
  };
}

/**
 * Edit a tracked file, for the guards that need a dirty working copy.
 *
 * @param {string} repo
 * @param {string} [file]
 */
const dirty = (repo, file = "b.txt") =>
  writeFileSync(join(repo, file), "edited\n");

/**
 * A branch off trunk with a commit of its own, which no ancestry connects to HEAD.
 *
 * @param {string} repo
 */
function siblingStack(repo) {
  const onBranch = run(repo, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  run(repo, "git", ["switch", "-qc", "feature-side", "origin/main"]);
  writeFileSync(join(repo, "side.txt"), "side\n");
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "feat: sideways"]);
  run(repo, "git", ["switch", "-q", onBranch]);
}

/** @type {Refusal[]} */
const REFUSALS = [
  {
    what: "rewording a commit that is already on trunk",
    act: ({ controller, repo }) =>
      controller.handle("amendMessage", {
        sha: shaOf(repo, "origin/main"),
        message: "not mine to reword",
      }),
    error: /refusing to rewrite/,
  },
  {
    what: "folding the bottom of a stack, whose parent is on trunk",
    act: ({ controller, repo }) =>
      controller.handle("fold", { sha: shaOf(repo, "feature-a") }),
    error: /already on trunk/,
  },
  {
    what: "folding a commit that is already on trunk",
    act: ({ controller, repo }) =>
      controller.handle("fold", { sha: shaOf(repo, "origin/main") }),
    error: /not a local commit/,
  },
  {
    what: "folding into a commit two branches share",
    arrange: ({ repo }) => {
      run(repo, "git", ["switch", "-qc", "feature-fork", "feature-a"]);
      writeFileSync(join(repo, "fork.txt"), "fork\n");
      run(repo, "git", ["add", "-A"]);
      run(repo, "git", ["commit", "-qm", "feat: the fork"]);
      run(repo, "git", ["switch", "-q", "feature-b"]);
    },
    act: ({ controller, repo }) =>
      controller.handle("fold", { sha: shaOf(repo, "feature-b") }),
    error: /fork point/,
  },
  {
    what: "folding a merge commit",
    arrange: ({ repo }) => {
      siblingStack(repo);
      run(repo, "git", [
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "merge",
        "feature-side",
      ]);
    },
    act: ({ controller, repo }) =>
      controller.handle("fold", { sha: shaOf(repo, "HEAD") }),
    error: /merge commit/,
  },
  {
    what: "rebasing commits that already sit on the destination",
    act: ({ controller, repo }) =>
      controller.handle("rebase", {
        sha: shaOf(repo, "feature-a"),
        destination: "trunk",
      }),
    error: /already sit on that destination/,
  },
  {
    what: "rebasing with tracked changes in the working copy",
    arrange: ({ repo }) => dirty(repo),
    act: ({ controller, repo }) =>
      controller.handle("rebase", {
        sha: shaOf(repo, "feature-b"),
        destination: "base",
      }),
    error: /uncommitted changes/,
  },
  {
    what: "amending into a commit on a stack HEAD does not descend from",
    arrange: ({ repo }) => {
      siblingStack(repo);
      dirty(repo);
    },
    act: ({ controller, repo }) =>
      controller.handle("amendIntoCommit", {
        sha: shaOf(repo, "feature-side"),
        paths: ["b.txt"],
      }),
    error: /not in the stack you have checked out/,
  },
  {
    what: "committing with nothing selected",
    arrange: ({ repo }) => dirty(repo),
    act: ({ controller }) =>
      controller.handle("commit", { paths: [], message: "feat: nothing" }),
    error: /Select at least one change/,
  },
  {
    what: "committing a path git does not report as changed",
    arrange: ({ repo }) => dirty(repo),
    act: ({ controller }) =>
      controller.handle("commit", {
        paths: ["never-touched.txt"],
        message: "feat: a typo in the path",
      }),
    error: /Not an uncommitted change: never-touched\.txt/,
  },
  {
    what: "committing with a message of whitespace",
    arrange: ({ repo }) => dirty(repo),
    act: ({ controller }) =>
      controller.handle("commit", { paths: ["b.txt"], message: "   " }),
    error: /needs a message/,
  },
  {
    what: "discarding with nothing selected",
    arrange: ({ repo }) => dirty(repo),
    act: ({ controller }) => controller.handle("discard", { paths: [] }),
    error: /Select at least one change/,
  },
  {
    what: "discarding a path git does not report as changed",
    arrange: ({ repo }) => dirty(repo),
    act: ({ controller }) =>
      controller.handle("discard", { paths: ["never-touched.txt"] }),
    error: /Not an uncommitted change: never-touched\.txt/,
  },
  {
    what: "discarding a path that is still being merged",
    arrange: async ({ controller, repo }) => {
      // Trunk takes over a file the stack already added, so replaying the stack stops on it.
      run(repo, "git", ["switch", "-q", "main"]);
      writeFileSync(join(repo, "a.txt"), "trunk's own a\n");
      run(repo, "git", ["add", "-A"]);
      run(repo, "git", ["commit", "-qm", "trunk: takes a.txt"]);
      run(repo, "git", ["push", "-q", "origin", "main"]);
      run(repo, "git", ["switch", "-q", "feature-b"]);
      const stopped = await controller.handle("rebase", {
        sha: shaOf(repo, "feature-a"),
        destination: "trunk",
      });
      assert.equal(stopped.ok, true, "the rebase must stop, not fail");
    },
    act: ({ controller }) => controller.handle("discard", { paths: ["a.txt"] }),
    error: /still being merged/,
  },
  {
    what: "absorbing with a clean working copy",
    act: ({ controller }) => controller.handle("absorb", {}),
    error: /No modified tracked files/,
  },
  {
    what: "absorbing from trunk, where nothing local is below",
    arrange: ({ repo }) => {
      run(repo, "git", ["switch", "-q", "main"]);
      dirty(repo, "base.txt");
    },
    act: ({ controller }) => controller.handle("absorb", {}),
    error: /to absorb into/,
  },
  {
    what: "splitting with no change chosen for the first commit",
    act: ({ controller, repo }) =>
      controller.handle("split", {
        sha: shaOf(repo, "feature-b"),
        selected: [],
      }),
    error: /Select at least one change/,
  },
  {
    what: "splitting a commit that is already on trunk",
    act: ({ controller, repo }) =>
      controller.handle("split", {
        sha: shaOf(repo, "origin/main"),
        selected: ["b.txt:0"],
      }),
    error: /not a local commit/,
  },
  {
    what: "pulling while HEAD is detached",
    arrange: ({ repo }) =>
      run(repo, "git", ["switch", "-q", "--detach", "HEAD"]),
    act: ({ controller }) => controller.handle("pull", {}),
    error: /HEAD is detached/,
  },
  {
    what: "pulling a branch that tracks no remote branch",
    act: ({ controller }) => controller.handle("pull", {}),
    error: /tracks no remote branch/,
  },
  {
    what: "pulling with tracked changes a fast-forward would overwrite",
    arrange: ({ repo }) => {
      run(repo, "git", ["switch", "-q", "main"]);
      dirty(repo, "base.txt");
    },
    act: ({ controller }) => controller.handle("pull", {}),
    error: /would overwrite them/,
  },
  {
    what: "undoing when nothing has been edited yet",
    act: ({ controller }) => controller.handle("undo", {}),
    error: /Nothing to undo/,
  },
  {
    what: "undoing an edit whose refs moved outside the extension",
    arrange: async ({ controller, repo }) => {
      const amended = await controller.handle("amendMessage", {
        sha: shaOf(repo, "feature-b"),
        message: "feat: B, reworded",
      });
      assert.equal(amended.ok, true, "the edit to be undone must land first");
      // A branch the checkpoint recorded, moved by something this extension never saw.
      run(repo, "git", [
        "update-ref",
        "refs/heads/feature-b",
        shaOf(repo, "feature-a"),
      ]);
    },
    act: ({ controller }) => controller.handle("undo", {}),
    error: /changed outside this extension/,
  },
  {
    what: "continuing when no rebase is in progress",
    act: ({ controller }) => controller.handle("rebaseContinue", {}),
    error: /No rebase in progress/,
  },
];

for (const refusal of REFUSALS) {
  test(`${refusal.what} changes nothing`, async t => {
    const fixture = refusalRepository(t);
    await refusal.arrange?.(fixture);
    const before = stateOf(fixture.repo);

    const result = await refusal.act(fixture);

    assert.equal(result.ok, false);
    assert.match(result.error, refusal.error);
    assert.deepEqual(stateOf(fixture.repo), before);
  });
}
