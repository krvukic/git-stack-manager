/**
 * Rail coordinates for one row, as data rather than as SVG elements.
 *
 * Kept apart from the drawing so the geometry can be asserted directly — that a fork
 * curve clears the text, that the indent covers every lane a rail touches — instead of
 * through a rendered document. `Rails` is what the row component turns into `<line>`,
 * `<path>` and `<circle>`.
 *
 * Everything scales with the row height, which the design panel changes: the rails are
 * absolutely positioned SVG of exactly that height, so a row that grew for larger type
 * while the SVG stayed at 26px left the dots riding above their own subjects and the
 * lines stopping short of the next row.
 */
import type { Edge, GraphLayout } from "./layout.mjs";

/** Horizontal distance between lane centres. */
export const LANE_WIDTH = 18;

/** Deepest lane the indent classes cover; past this the indent stops growing. */
export const MAX_INDENT_LANE = 8;

/** What a row draws at its own lane, which decides the node's shape. */
export type RowKind = "commit" | "trunk-tip" | "base" | "ellipsis";

export type Line = { x: number; y1: number; y2: number };

/** A fork curve: leaves the child lane along the top edge, descends in the parent's. */
export type Curve = { fromX: number; toX: number; turnY: number; endY: number };

export type Node = {
  cx: number;
  cy: number;
  radius: number;
  /** Class the stylesheet paints it with. */
  variant: "trunkdot" | "hollow" | "head" | "plain";
  /** Radius of the focus halo behind the dot, or null when this row is not HEAD. */
  haloRadius: number | null;
};

export type Rails = {
  width: number;
  height: number;
  lines: Line[];
  curves: Curve[];
  node: Node | null;
  /**
   * Lane the row's content is indented past — the rightmost lane a rail occupies
   * anywhere in this row, not only at the middle where the text sits.
   */
  indentLane: number;
  /**
   * X centres of lanes whose line reaches the bottom edge. A wrapped row is taller than
   * the drawn SVG, so these get a filler strip to carry the line down to the next row.
   */
  bottomLaneCentres: number[];
};

export function centerX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/**
 * Row height for a text size. The ratio is the default's — 26px for 13px text — and the
 * floor keeps a dot from outgrowing its row at the smallest sizes.
 */
export function rowHeightFor(textFont: number): number {
  return Math.max(22, Math.round(textFont * 2));
}

/**
 * Where a fork curve turns from vertical to horizontal: a quarter of the row, so the
 * bend finishes inside the gutter rather than at text height.
 */
function forkTurnY(rowHeight: number): number {
  return rowHeight / 4;
}

/** Grows with the row but stops short of half of it, or a dot would swallow its lane. */
function dotRadius(rowHeight: number): number {
  return Math.min(7, Math.max(4.5, rowHeight * 0.21));
}

function nodeVariant(kind: RowKind, isHead: boolean): Node["variant"] {
  if (kind === "trunk-tip") {
    return "trunkdot";
  }
  if (kind === "base") {
    return "hollow";
  }
  return isHead ? "head" : "plain";
}

/**
 * The rails for row `rowIndex`.
 *
 * Each edge contributes to the rows it spans: the bottom half at the child row, full
 * verticals through the middle, and either a straight top half or a fork curve at the
 * parent row.
 *
 * The indent has to clear the rightmost lane a rail occupies ANYWHERE in the row, not
 * just at the middle line where the text sits. That was not always true: the fork curve
 * used to hold the child lane until mid-row and only then sweep left, so its excursion
 * was a bulge near y=0 that the text passed under, and counting it pushed merge rows a
 * lane too far right. The curve now runs horizontally along the row's top edge from the
 * child lane to the parent lane — which is what keeps it clear of the text vertically —
 * and that run crosses every lane between the two. A base collecting three stacks drew
 * curves from lanes 1, 2 and 3 while indenting for lane 0, so all three cut straight
 * through the subject beside it.
 */
export function railGeometry(
  layout: GraphLayout,
  rowIndex: number,
  kind: RowKind,
  isHead: boolean,
  rowHeight: number
): Rails {
  const { laneAtRow, maxLane, edges } = layout;
  // `layoutGraph` assigns a lane to every row, so a row outside the graph is the only
  // way this misses — and lane 0 is the trunk column, which draws no indent.
  const ownLane = laneAtRow[rowIndex] ?? 0;
  const middleY = rowHeight / 2;
  const turnY = forkTurnY(rowHeight);
  const radius = dotRadius(rowHeight);

  const lines: Line[] = [];
  const curves: Curve[] = [];
  const lanesToBottom = new Set<number>();
  let rightmostLane = ownLane;

  const spans = (edge: Edge) =>
    rowIndex >= edge.childRow && rowIndex <= edge.parentRow;

  for (const edge of edges) {
    if (!spans(edge)) {
      continue;
    }
    // The rightmost lane this edge reaches in this row, at any height.
    let laneUsed: number;
    if (rowIndex === edge.childRow) {
      lines.push({ x: centerX(edge.childLane), y1: middleY, y2: rowHeight });
      lanesToBottom.add(edge.childLane);
      laneUsed = edge.childLane;
    } else if (rowIndex === edge.parentRow) {
      if (edge.childLane === edge.parentLane) {
        lines.push({ x: centerX(edge.parentLane), y1: 0, y2: middleY });
        laneUsed = edge.parentLane;
      } else {
        // Both control points sit in the PARENT lane, so the curve leaves the child
        // lane along the row's top edge and has reached the parent lane before it
        // descends. That keeps it clear of the text vertically — every control-point
        // pair that turns *within* the child lane crosses the text — but it means the
        // horizontal run spans every lane from child to parent, which the indent covers.
        curves.push({
          fromX: centerX(edge.childLane),
          toX: centerX(edge.parentLane),
          turnY,
          endY: middleY,
        });
        laneUsed = Math.max(edge.childLane, edge.parentLane);
      }
    } else {
      lines.push({ x: centerX(edge.childLane), y1: 0, y2: rowHeight });
      lanesToBottom.add(edge.childLane);
      laneUsed = edge.childLane;
    }
    rightmostLane = Math.max(rightmostLane, laneUsed);
  }

  const node: Node | null =
    kind === "ellipsis"
      ? null
      : {
          cx: centerX(ownLane),
          cy: middleY,
          // A hollow base dot carries a stroke, which straddles the radius, so it is
          // drawn a touch smaller to end up the same visual size as a filled one.
          radius: kind === "base" ? radius - 0.5 : radius,
          variant: nodeVariant(kind, isHead),
          haloRadius: isHead ? radius + 3 : null,
        };

  return {
    width: (maxLane + 1) * LANE_WIDTH,
    height: rowHeight,
    lines,
    curves,
    node,
    indentLane: Math.min(rightmostLane, MAX_INDENT_LANE),
    bottomLaneCentres: [...lanesToBottom].map(centerX),
  };
}
