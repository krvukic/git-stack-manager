/**
 * Whether a stack matches GitHub, in one sentence.
 *
 * Each branch is judged by three commits: its local tip, the commit the last fetch or push left
 * its remote-tracking ref on, and the head of its open pull request. The cases below are the
 * ones a count of commits ahead and behind cannot tell apart, which is why the sentence exists.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stackStatus } from "#github/stackStatus";

/** @typedef {import("#github/stackStatus").StackStatusLayer} StackStatusLayer */

/**
 * One branch, named by its three commits: `local`, what the last fetch left (`fetched`), and
 * the open pull request's head on GitHub (`github`).
 *
 * @param {string} branch
 * @param {{ local: string, fetched?: string | null, github?: string | null, ahead?: number, behind?: number }} commits
 * @returns {StackStatusLayer}
 */
function layer(
  branch,
  { local, fetched = null, github = null, ahead = 0, behind = 0 }
) {
  return {
    branch,
    sha: local,
    upstreamSha: fetched,
    sync: fetched
      ? {
          name: branch,
          upstream: `origin/${branch}`,
          ahead,
          behind,
          gone: false,
        }
      : null,
    pullRequest: github
      ? {
          number: 1,
          state: "OPEN",
          isDraft: false,
          title: "",
          url: "",
          headSha: github,
          reviewDecision: null,
          checks: null,
          stack: null,
        }
      : null,
  };
}

const IN_SYNC = { local: "a1", fetched: "a1", github: "a1" };

test("every branch at the commit GitHub has is in sync, once the stack is linked", () => {
  const layers = [layer("a", IN_SYNC), layer("b", IN_SYNC)];
  assert.deepEqual(stackStatus(layers, true), {
    state: "in-sync",
    label: "in sync",
    sentence: "In sync with GitHub.",
  });
});

test("a stack in sync that GitHub does not link says to link it", () => {
  const layers = [layer("a", IN_SYNC), layer("b", IN_SYNC)];
  const status = stackStatus(layers, false);
  assert.equal(status.state, "unlinked");
  assert.equal(
    status.sentence,
    "These pull requests are not linked as a stack. Link stack links them."
  );
});

test("a stack nobody pushed is not on GitHub yet", () => {
  const status = stackStatus(
    [layer("a", { local: "a1" }), layer("b", { local: "b1" })],
    false
  );
  assert.equal(status.state, "unpushed");
  assert.equal(status.sentence, "Not on GitHub yet. Submit stack pushes it.");
});

test("a rebased branch is a local change, though it is both ahead and behind", () => {
  // The case a count gets wrong. GitHub has not moved since the last fetch, so the rewrite
  // is this checkout's alone, and nothing on GitHub would be lost by pushing it.
  const rebased = layer("b", {
    local: "b2",
    fetched: "b1",
    github: "b1",
    ahead: 1,
    behind: 1,
  });
  const status = stackStatus([layer("a", IN_SYNC), rebased], true);
  assert.equal(status.state, "local");
  assert.equal(
    status.sentence,
    "b has changes that GitHub does not have. Submit stack pushes them."
  );
});

test("a pull request head that moved since the last fetch means GitHub is newer", () => {
  // Nothing was fetched: the branch still matches its remote-tracking ref. Only the pull
  // request head, from the query that draws the badges, shows that GitHub moved.
  const stale = layer("b", { local: "b1", fetched: "b1", github: "b2" });
  const status = stackStatus([layer("a", IN_SYNC), stale], true);
  assert.equal(status.state, "remote");
  assert.equal(
    status.sentence,
    "GitHub has a newer version of b. Take GitHub's version."
  );
});

test("commits fetched and not yet taken also mean GitHub is newer", () => {
  const behind = layer("b", {
    local: "b1",
    fetched: "b2",
    github: "b2",
    behind: 1,
  });
  assert.equal(
    stackStatus([layer("a", IN_SYNC), behind], true).state,
    "remote"
  );
});

test("a branch moved here while GitHub moved too is reported as both", () => {
  const both = layer("b", {
    local: "b2",
    fetched: "b1",
    github: "b3",
    ahead: 1,
    behind: 1,
  });
  const status = stackStatus([layer("a", IN_SYNC), both], true);
  assert.equal(status.state, "both");
  assert.equal(
    status.sentence,
    "You and GitHub both changed b. Submit stack overwrites GitHub's version."
  );
});

test("local changes are reported before the others, and a never-pushed branch counts as one", () => {
  const layers = [
    layer("a", { local: "a2", fetched: "a1", github: "a1", ahead: 1 }),
    layer("b", { local: "b1", fetched: "b1", github: "b2" }),
    layer("c", { local: "c1" }),
  ];
  const status = stackStatus(layers, false);
  assert.equal(status.state, "local");
  // The never-pushed branch first, then the amended one: both are for Submit stack.
  assert.equal(
    status.sentence,
    "c and a have changes that GitHub does not have. Submit stack pushes them."
  );
});

test("more than two branches are named as two and a count", () => {
  const moved = (/** @type {string} */ name) =>
    layer(name, {
      local: `${name}2`,
      fetched: `${name}1`,
      github: `${name}1`,
      ahead: 1,
    });
  const status = stackStatus(["a", "b", "c", "d"].map(moved), true);
  assert.equal(
    status.sentence,
    "a, b and 2 more have changes that GitHub does not have. Submit stack pushes them."
  );
});

test("without a pull request, the counts from the last fetch are all there is", () => {
  const ahead = layer("b", { local: "b2", fetched: "b1", ahead: 1 });
  const diverged = layer("b", {
    local: "b2",
    fetched: "b3",
    ahead: 1,
    behind: 1,
  });
  const base = layer("a", { local: "a1", fetched: "a1" });
  assert.equal(stackStatus([base, ahead], false).state, "local");
  assert.equal(stackStatus([base, diverged], false).state, "both");
});
