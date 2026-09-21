/**
 * Reducing a pull request's many checks to the one word a badge has room for.
 *
 * Precedence is the whole of this function's behaviour, and getting it wrong is worse than
 * showing nothing: a green tick beside a workflow that is still running tells the reader the
 * branch is safe to merge. So every test below pairs a passing check with something else and
 * asserts the something else wins.
 *
 * The shapes come from `gh`'s JSON, which arrives as `unknown`: a check run carries
 * `conclusion` plus `status`, while the older commit statuses carry only `state`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rollUpChecks } from "#github/pullRequests";

test("no checks at all reports nothing rather than success", () => {
  assert.equal(rollUpChecks([]), null);
  assert.equal(rollUpChecks(null), null);
});

test("one failure outweighs any number of passes", () => {
  assert.equal(
    rollUpChecks([
      { conclusion: "SUCCESS", status: "COMPLETED" },
      { conclusion: "FAILURE", status: "COMPLETED" },
    ]),
    "failure"
  );
});

test("a running check outweighs a pass, so the badge never reads green early", () => {
  assert.equal(
    rollUpChecks([
      { conclusion: "SUCCESS", status: "COMPLETED" },
      { status: "IN_PROGRESS" },
    ]),
    "pending"
  );
});

test("skipped and neutral checks count as neither, so a skipped workflow still passes", () => {
  assert.equal(
    rollUpChecks([
      { conclusion: "SUCCESS", status: "COMPLETED" },
      { conclusion: "SKIPPED", status: "COMPLETED" },
      { conclusion: "NEUTRAL", status: "COMPLETED" },
    ]),
    "success"
  );
});

test("a legacy commit status reports through `state` alone", () => {
  assert.equal(rollUpChecks([{ state: "SUCCESS" }]), "success");
  assert.equal(rollUpChecks([{ state: "ERROR" }]), "failure");
});

/**
 * A conclusion that is not a string reads as running, not as decided.
 *
 * `String(value)` used to produce `"[object Object]"` here — truthy, and matching no case,
 * so the check fell past every branch including the `!conclusion` guard that marks it
 * pending. A sibling's success then carried the rollup and the badge went green while this
 * check was still in flight, which is the one outcome the function exists to prevent.
 */
test("an unreadable conclusion keeps the rollup pending rather than green", () => {
  assert.equal(
    rollUpChecks([
      { conclusion: "SUCCESS", status: "COMPLETED" },
      { conclusion: { unexpected: "shape" } },
    ]),
    "pending"
  );
});
