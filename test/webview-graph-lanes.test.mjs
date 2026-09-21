/**
 * Which column each row's dot sits in, and which dots are joined.
 *
 * A screenshot was the only thing standing behind this for a long time, and a screenshot
 * reports "these pixels moved" rather than "two independent stacks collided in one column".
 * The two tests carrying the most weight are the pair about sharing a lane: one says
 * overlapping stacks must not, the other says non-overlapping stacks must, and together they
 * pin the allocator's only interesting decision.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutGraph } from "../src/webview/graph/layout.mts";
import { base, commit, ellipsis, trunkTip } from "./graphRows.mjs";

test("a single stack takes lane 1 and the trunk keeps lane 0", () => {
  const rows = [commit("aa", "bb"), commit("bb", "tt"), trunkTip("tt")];
  const { laneAtRow, maxLane } = layoutGraph(rows);
  assert.deepEqual(laneAtRow, [1, 1, 0]);
  assert.equal(maxLane, 1);
});

test("every row of a chain gets an edge down to its parent", () => {
  const rows = [commit("aa", "bb"), commit("bb", "tt"), trunkTip("tt")];
  const { edges } = layoutGraph(rows);
  assert.deepEqual(edges, [
    { childRow: 0, parentRow: 1, childLane: 1, parentLane: 1 },
    { childRow: 1, parentRow: 2, childLane: 1, parentLane: 0 },
  ]);
});

/**
 * The rule the lane allocator exists for. Two stacks off one base must occupy separate
 * columns for their whole height and only converge at the base row — freeing the lane at
 * the fork point instead lets the second stack reuse the column, and its rail then cuts
 * straight through the first stack's rows.
 */
test("two stacks sharing a base fan into separate lanes", () => {
  const rows = [
    commit("a2", "a1"),
    commit("a1", "bs"),
    commit("b2", "b1"),
    commit("b1", "bs"),
    base("bs"),
  ];
  const { laneAtRow, maxLane } = layoutGraph(rows);
  assert.equal(laneAtRow[4], 0, "the base sits on the trunk spine");
  const first = new Set([laneAtRow[0], laneAtRow[1]]);
  const second = new Set([laneAtRow[2], laneAtRow[3]]);
  assert.equal(first.size, 1, "each stack keeps one lane for its whole height");
  assert.equal(second.size, 1);
  assert.notDeepEqual(
    [...first],
    [...second],
    "the two stacks must not share a column"
  );
  assert.equal(maxLane, 2);
});

test("a lane is reused once the stack holding it has converged", () => {
  // Two stacks that do NOT overlap vertically: the first ends at its base before the
  // second begins, so the column is free to take again.
  const rows = [commit("a1", "b1"), base("b1"), commit("a2", "b2"), base("b2")];
  const { laneAtRow, maxLane } = layoutGraph(rows);
  assert.deepEqual(laneAtRow, [1, 0, 1, 0]);
  assert.equal(
    maxLane,
    1,
    "one column serves both, so the gutter stays narrow"
  );
});

test("the trunk spine links consecutive anchors through what sits between them", () => {
  const rows = [trunkTip("tt"), ellipsis(4), commit("aa", "bs"), base("bs")];
  const { edges } = layoutGraph(rows);
  const spine = edges.filter(
    edge => edge.childLane === 0 && edge.parentLane === 0
  );
  assert.deepEqual(
    spine,
    [{ childRow: 0, parentRow: 3, childLane: 0, parentLane: 0 }],
    "one edge spans the ellipsis and the stack, so the spine is unbroken"
  );
});

test("an ellipsis stays on the trunk spine", () => {
  const rows = [trunkTip("tt"), ellipsis(), base("bs")];
  assert.deepEqual(layoutGraph(rows).laneAtRow, [0, 0, 0]);
});

test("a parent that is not on screen produces no edge", () => {
  const rows = [commit("aa", "offscreen")];
  assert.deepEqual(layoutGraph(rows).edges, []);
});

test("an empty graph lays out without throwing", () => {
  assert.deepEqual(layoutGraph([]), {
    laneAtRow: [],
    maxLane: 0,
    edges: [],
    rowCount: 0,
  });
});
