/**
 * The lines, curves, and dots one row draws once its lane is known.
 *
 * Almost everything here traces back to one bug: a rail that crossed the row at text height
 * and struck through the subject beside it. The fix moved the bend into the gutter and made
 * the text indent for the widest lane a rail reaches rather than the row's own, so those two
 * tests are the ones that would catch a regression. The rest pin the scaling, since the
 * design panel changes the row height under all of it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutGraph } from "../src/webview/graph/layout.mts";
import {
  centerX,
  LANE_WIDTH,
  MAX_INDENT_LANE,
  railGeometry,
  rowHeightFor,
} from "../src/webview/graph/rails.mts";
import { base, commit, trunkTip } from "./graphRows.mjs";
import { present } from "./present.mjs";

const ROW_HEIGHT = 26;

/**
 * The dot a row draws. Only an ellipsis draws none, and the one test that covers that
 * reads `.node` directly.
 *
 * @param {Parameters<typeof railGeometry>} args
 */
const nodeOf = (...args) =>
  present(railGeometry(...args).node, "a node on the row");

test("a chained commit draws one straight vertical through its own lane", () => {
  const rows = [commit("aa", "bb"), commit("bb", "tt"), trunkTip("tt")];
  const layout = layoutGraph(rows);
  // Row 1 is both the parent of row 0 and the child of the trunk tip, so its lane runs
  // the full height: top half from the edge above, bottom half from the edge below.
  const rails = railGeometry(layout, 1, "commit", false, ROW_HEIGHT);
  // Sorted, because the order follows the edge list rather than the y axis, and what
  // matters is that the two halves meet at the middle and cover the row.
  assert.deepEqual(
    rails.lines.map(line => [line.y1, line.y2]).sort((a, b) => a[0] - b[0]),
    [
      [0, ROW_HEIGHT / 2],
      [ROW_HEIGHT / 2, ROW_HEIGHT],
    ]
  );
  assert.equal(rails.curves.length, 0);
});

/**
 * The bug the curve's control points were rewritten for. A fork that turned inside the
 * child lane crossed the row between y=6.5 and y=8.7 — through the subject beside it —
 * so the curve now leaves along the top edge and descends only once it has arrived.
 */
test("a fork curve clears the text vertically", () => {
  const rows = [commit("aa", "bs"), base("bs")];
  const layout = layoutGraph(rows);
  const rails = railGeometry(layout, 1, "base", false, ROW_HEIGHT);
  assert.equal(rails.curves.length, 1);
  const [curve] = rails.curves;
  assert.equal(curve.fromX, centerX(1));
  assert.equal(curve.toX, centerX(0), "it ends in the parent's lane");
  assert.ok(
    curve.turnY < ROW_HEIGHT / 2,
    "the bend finishes in the gutter, above text height"
  );
});

/**
 * The other half of that fix. The curve's horizontal run crosses every lane between the
 * two ends, so a base collecting three stacks has rails out at lane 3 while its own lane
 * is 0 — and indenting for its own lane alone printed all three through the subject.
 */
test("the indent clears the widest lane a rail touches, not just the row's own", () => {
  const rows = [
    commit("a1", "bs"),
    commit("b1", "bs"),
    commit("c1", "bs"),
    base("bs"),
  ];
  const layout = layoutGraph(rows);
  const rails = railGeometry(layout, 3, "base", false, ROW_HEIGHT);
  assert.equal(layout.laneAtRow[3], 0, "the base's own lane is the trunk");
  assert.equal(
    rails.indentLane,
    3,
    "but its curves reach lane 3, so the text must clear lane 3"
  );
});

test("the indent stops growing past the deepest lane the stylesheet covers", () => {
  const rows = [];
  // Twelve stacks all forking off one base, which is more lanes than there are indent
  // classes. The indent has to saturate rather than name a class that does not exist.
  for (let index = 0; index < 12; index++) {
    rows.push(commit(`s${index}`, "bs"));
  }
  rows.push(base("bs"));
  const layout = layoutGraph(rows);
  const rails = railGeometry(
    layout,
    rows.length - 1,
    "base",
    false,
    ROW_HEIGHT
  );
  assert.ok(layout.maxLane > MAX_INDENT_LANE);
  assert.equal(rails.indentLane, MAX_INDENT_LANE);
});

test("only lanes whose line reaches the bottom edge get a filler strip", () => {
  const rows = [commit("aa", "bb"), commit("bb", "tt"), trunkTip("tt")];
  const layout = layoutGraph(rows);
  // The trunk tip is the bottom row: nothing continues below it.
  assert.deepEqual(
    railGeometry(layout, 2, "trunk-tip", false, ROW_HEIGHT).bottomLaneCentres,
    []
  );
  // The top row's own lane carries on down to its parent.
  assert.deepEqual(
    railGeometry(layout, 0, "commit", false, ROW_HEIGHT).bottomLaneCentres,
    [centerX(1)]
  );
});

test("each row kind gets its own node, and an ellipsis gets none", () => {
  const rows = [commit("aa", "bs"), base("bs")];
  const layout = layoutGraph(rows);
  assert.equal(nodeOf(layout, 0, "commit", false, ROW_HEIGHT).variant, "plain");
  assert.equal(nodeOf(layout, 0, "commit", true, ROW_HEIGHT).variant, "head");
  assert.equal(nodeOf(layout, 1, "base", false, ROW_HEIGHT).variant, "hollow");
  assert.equal(
    nodeOf(layout, 1, "trunk-tip", false, ROW_HEIGHT).variant,
    "trunkdot"
  );
  assert.equal(
    railGeometry(layout, 1, "ellipsis", false, ROW_HEIGHT).node,
    null
  );
});

test("only the HEAD row carries a halo", () => {
  const layout = layoutGraph([commit("aa", null)]);
  assert.equal(nodeOf(layout, 0, "commit", false, ROW_HEIGHT).haloRadius, null);
  const head = nodeOf(layout, 0, "commit", true, ROW_HEIGHT);
  const halo = present(head.haloRadius, "the head halo");
  assert.ok(halo > head.radius, "the halo sits outside the dot");
});

/**
 * Everything scales with the row, which the design panel changes. A dot drawn for a 26px
 * row inside a 40px one rides above its own subject, and the lines stop short of the
 * next row.
 */
test("a dot scales with the row height and stays centred in it", () => {
  const layout = layoutGraph([commit("aa", null)]);
  const small = nodeOf(layout, 0, "commit", false, 22);
  const large = nodeOf(layout, 0, "commit", false, 40);
  assert.equal(small.cy, 11, "the dot sits at the middle of its own row");
  assert.equal(large.cy, 20);
  assert.ok(large.radius > small.radius);
  assert.ok(large.radius < 40 / 2, "but never wide enough to swallow its lane");
});

test("row height tracks the text size, with a floor", () => {
  assert.equal(rowHeightFor(13), 26, "the default ratio is preserved");
  assert.equal(rowHeightFor(20), 40);
  assert.equal(rowHeightFor(10), 22, "the floor keeps a dot inside its row");
});

test("the gutter is one lane wider than the deepest lane", () => {
  const rows = [commit("aa", "bs"), commit("bb", "bs"), base("bs")];
  const layout = layoutGraph(rows);
  const rails = railGeometry(layout, 0, "commit", false, ROW_HEIGHT);
  assert.equal(rails.width, (layout.maxLane + 1) * LANE_WIDTH);
});
