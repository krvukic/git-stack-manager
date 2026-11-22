/**
 * Which merged branches the automatic removal asks for, and what it reports afterwards.
 *
 * These functions take the host's branch list as an argument, which is what makes the choice
 * and the sentence assertable without rendering a tree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deletableMerged,
  describeMergedDeletion,
} from "../src/webview/model/mergedBranches.mts";

/**
 * @param {string} name
 * @param {string | null} keptReason
 */
function branch(name, keptReason) {
  return { name, sha: `${name}-sha`, keptReason };
}

test("only branches with no reason count as ready", () => {
  const merged = [
    branch("ready", null),
    branch("held", "you have it checked out — check out trunk first"),
  ];
  assert.deepEqual(
    deletableMerged(merged).map(each => each.name),
    ["ready"]
  );
});

test("the toast names each branch that went", () => {
  assert.equal(
    describeMergedDeletion(["a", "b"]),
    "Deleted merged branches a, b ✓"
  );
  // Singular, because "1 branches" is the detail that makes a report read as generated.
  assert.equal(describeMergedDeletion(["a"]), "Deleted merged branch a ✓");
});
