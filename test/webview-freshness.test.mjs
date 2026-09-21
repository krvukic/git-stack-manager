/**
 * The note in the top bar that says how old the pull request badges are.
 *
 * The badges keep showing after a refresh fails, so the note is the only thing telling the
 * reader whether to trust them. `describeFreshness` takes the current time as an argument
 * rather than reading the clock, which is what makes exact wording assertable here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeAge,
  describeFreshness,
} from "../src/webview/model/freshness.mts";

/** @typedef {import("#github/pullRequests").PullRequestRefreshState} PullRequestRefreshState */

test("an age coarsens as it grows", () => {
  assert.equal(describeAge(0), "just now");
  assert.equal(describeAge(9_000), "just now");
  assert.equal(describeAge(30_000), "30s ago");
  assert.equal(describeAge(90_000), "1m ago");
  assert.equal(describeAge(3 * 3_600_000), "3h ago");
  assert.equal(describeAge(50 * 3_600_000), "2d ago");
});

test("a refresh that has never run produces no note at all", () => {
  const note = describeFreshness(
    /** @type {PullRequestRefreshState} */ ({ lastAttemptSucceeded: null }),
    1000
  );
  assert.equal(note.text, "");
});

test("a refresh in flight is reported as loading", () => {
  const note = describeFreshness(
    /** @type {PullRequestRefreshState} */ ({
      lastAttemptSucceeded: null,
      fetching: true,
    }),
    1000
  );
  assert.equal(note.text, "PRs: loading…");
});

test("a successful refresh reports its age", () => {
  const note = describeFreshness(
    /** @type {PullRequestRefreshState} */ ({
      lastAttemptSucceeded: true,
      lastSuccessAt: 0,
    }),
    120_000
  );
  assert.equal(note.text, "PRs 2m ago");
  assert.equal(note.failed, false);
});

/**
 * The reason a failure keeps the age rather than replacing it: the badges are still on
 * screen, and how old they are is what tells the reader whether to trust them.
 */
test("a failed refresh keeps the age of the last success and carries the error", () => {
  const note = describeFreshness(
    /** @type {PullRequestRefreshState} */ ({
      lastAttemptSucceeded: false,
      lastSuccessAt: 0,
      lastError: "gh: not logged in",
    }),
    20 * 60_000
  );
  assert.equal(note.text, "PRs stale — last ok 20m ago");
  assert.equal(note.failed, true);
  assert.match(note.description, /gh: not logged in/);
  assert.match(note.description, /from the last successful refresh/);
});

test("a refresh that has never succeeded reads as never loaded rather than showing an age", () => {
  const note = describeFreshness(
    /** @type {PullRequestRefreshState} */ ({
      lastAttemptSucceeded: false,
      lastSuccessAt: null,
    }),
    1000
  );
  assert.equal(note.text, "PRs stale — never loaded");
});
