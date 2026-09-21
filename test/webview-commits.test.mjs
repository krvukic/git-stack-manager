/**
 * The questions the webview asks about a render model it has already been handed.
 *
 * Selection, the rebase menu's count, the submit target, and the message the editor opens
 * with — all of it derived from rows rather than from git, so a hand-built model is the
 * fixture. The rows here are the shapes the real model produces: one commit per branch, and
 * a fork where one commit has two children.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitsInOrder,
  countDescendants,
  findCommit,
  gotoTarget,
  splitMessage,
  submitTarget,
  truncate,
} from "../src/webview/model/commits.mts";
import { present } from "./present.mjs";

/** @typedef {import("#ui/renderModel").RenderModel} RenderModel */
/** @typedef {import("#ui/renderModel").UIBranch} UIBranch */
/** @typedef {import("#ui/renderModel").UICommit} UICommit */

/**
 * @param {string} sha
 * @param {string[]} parents
 * @param {string[]} [branches]
 * @returns {Extract<import("#ui/renderModel").Row, { type: "commit" }>}
 */
function commitRow(sha, parents, branches = []) {
  return {
    type: "commit",
    commit: {
      sha,
      shortSha: sha.slice(0, 8),
      subject: `subject ${sha}`,
      body: `subject ${sha}`,
      branches,
      branchDetails: branches.map(
        name =>
          /** @type {UIBranch} */ ({
            name,
            sync: null,
            pullRequest: null,
            stack: null,
          })
      ),
      parents,
      isHead: false,
      isMine: true,
      authorName: "Test Dev",
      authorEmail: "dev@example.com",
      date: "2026-01-01T00:00:00Z",
    },
  };
}

const MODEL = /** @type {RenderModel} */ ({
  rows: [
    commitRow("aa", ["bb"]),
    commitRow("bb", ["tt"]),
    { type: "trunk-tip", sha: "tt" },
  ],
});

test("a commit is found by sha, and an absent one yields null", () => {
  assert.equal(present(findCommit(MODEL, "aa"), "the commit aa").sha, "aa");
  assert.equal(findCommit(MODEL, "nope"), null);
});

test("navigation order covers the commits and skips the rest", () => {
  assert.deepEqual(
    commitsInOrder(MODEL).map(commit => commit.sha),
    ["aa", "bb"]
  );
});

/** What the rebase menu's "this commit + N above" counts. */
test("descendants count the commit itself and everything above it", () => {
  assert.equal(countDescendants(MODEL, "aa"), 1);
  assert.equal(countDescendants(MODEL, "bb"), 2);
});

test("descendants follow every branch of a fork", () => {
  const forked = /** @type {RenderModel} */ ({
    rows: [
      commitRow("a2", ["a1"]),
      commitRow("a1", ["bs"]),
      commitRow("b1", ["bs"]),
      { type: "base", sha: "bs" },
    ],
  });
  assert.equal(countDescendants(forked, "bs"), 4);
  assert.equal(countDescendants(forked, "a1"), 2);
});

test("text shorter than the limit is left whole, and a cut is marked", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("a longer subject", 10), "a longer …");
  assert.equal(truncate(null, 10), "");
});

test("a commit with no branch cannot be submitted", () => {
  assert.equal(submitTarget(commitRow("aa", []).commit), null);
});

/**
 * A commit can carry several pills, and re-submitting has to update the pull request that
 * exists rather than opening a second one from a sibling name.
 */
test("submit prefers the branch that already has a pull request", () => {
  const commit = /** @type {UICommit} */ ({
    branchDetails: [
      { name: "plain", sync: null, pullRequest: null, stack: null },
      {
        name: "has-pr",
        sync: null,
        pullRequest: { number: 7 },
        stack: null,
      },
    ],
  });
  assert.equal(present(submitTarget(commit), "a submit target").name, "has-pr");
});

test("submit falls back to the first branch when none has a pull request", () => {
  const commit = /** @type {UICommit} */ ({
    branchDetails: [
      { name: "first", sync: null, pullRequest: null, stack: null },
      { name: "second", sync: null, pullRequest: null, stack: null },
    ],
  });
  assert.equal(present(submitTarget(commit), "a submit target").name, "first");
});

/**
 * A commit carrying `branches`, and the worktree holding each of them.
 *
 * @param {string[]} branches
 * @param {Record<string, string>} [heldBy]
 * @returns {UICommit}
 */
function commitWithBranches(branches, heldBy = {}) {
  return /** @type {UICommit} */ ({
    sha: "abcdef1234567890",
    shortSha: "abcdef12",
    branches,
    branchDetails: branches.map(
      name =>
        /** @type {UIBranch} */ ({
          name,
          sync: null,
          pullRequest: null,
          stack: null,
          tracksTrunk: false,
          worktree: heldBy[name] ?? null,
        })
    ),
  });
}

test("Goto on a commit with one branch checks that branch out", () => {
  assert.deepEqual(gotoTarget(commitWithBranches(["mask-utils"])), {
    ref: "mask-utils",
    detach: false,
    heldBy: null,
  });
});

/**
 * A commit no branch names is reachable only by its sha, and `detach` is what makes the
 * toast say so. Silence there leaves the reader on a HEAD no branch follows, where the next
 * commit lands somewhere nothing reaches.
 */
test("a branchless commit is reached by its sha, which detaches HEAD", () => {
  assert.deepEqual(gotoTarget(commitWithBranches([])), {
    ref: "abcdef1234567890",
    detach: true,
    heldBy: null,
  });
});

/** Two pills leave nothing to choose between, so picking either would guess. */
test("several branches detach rather than picking one of them", () => {
  const target = gotoTarget(commitWithBranches(["first", "second"]));
  assert.equal(target.ref, "abcdef1234567890");
  assert.equal(target.detach, true);
});

/**
 * Git binds a branch to one worktree, so this checkout cannot succeed. Reporting the
 * directory is what the row's disabled button and the keyboard path both say; letting the
 * click through instead produced git's own refusal as a red toast.
 */
test("a branch another worktree holds reports the directory holding it", () => {
  assert.deepEqual(
    gotoTarget(commitWithBranches(["main"], { main: "/work/other-worktree" })),
    { ref: "main", detach: false, heldBy: "/work/other-worktree" }
  );
});

/** Worktrees bind branches, not commits, so the detaching path is never blocked. */
test("a held branch among several still leaves the detached checkout open", () => {
  const target = gotoTarget(
    commitWithBranches(["held", "free"], { held: "/work/other-worktree" })
  );
  assert.equal(target.detach, true);
  assert.equal(target.heldBy, null);
});

/** git's `body` repeats the subject, so the editor would open with it printed twice. */
test("the editor's description drops the subject git repeats", () => {
  assert.deepEqual(
    splitMessage(
      /** @type {UICommit} */ ({
        subject: "feat: add words",
        body: "feat: add words\n\nwhy",
      })
    ),
    { subject: "feat: add words", body: "why" }
  );
});

test("a body that does not repeat the subject is left alone", () => {
  assert.deepEqual(
    splitMessage(
      /** @type {UICommit} */ ({ subject: "subject", body: "unrelated" })
    ),
    { subject: "subject", body: "unrelated" }
  );
});
