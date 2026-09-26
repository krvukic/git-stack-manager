/**
 * Reading GitHub's own `Commit.statusCheckRollup.state` into the one word a badge has
 * room for. GitHub has already reduced every individual check run and status context to
 * this one enum, so translating it is the whole of the job.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rollupState } from "#github/pullRequests";

test("no rollup at all reports nothing rather than success", () => {
  assert.equal(rollupState(null), null);
  assert.equal(rollupState(undefined), null);
});

test("every rollup state maps to the badge's three-way verdict", () => {
  assert.equal(rollupState({ state: "SUCCESS" }), "success");
  assert.equal(rollupState({ state: "FAILURE" }), "failure");
  assert.equal(rollupState({ state: "ERROR" }), "failure");
  assert.equal(rollupState({ state: "PENDING" }), "pending");
  assert.equal(rollupState({ state: "EXPECTED" }), "pending");
});

/**
 * A state that is not a string reads as absent rather than decided, the same guard the
 * array-based version needed: `String(value)` on a non-string produces a truthy value
 * matching no case, which would otherwise fall past every branch undetected.
 */
test("an unreadable state reports nothing rather than a guess", () => {
  assert.equal(rollupState({ state: { unexpected: "shape" } }), null);
});
