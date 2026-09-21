/**
 * Lane assignment for the commit graph.
 *
 * Lane 0 is the trunk spine: the trunk tip and every base sit there, joined by one
 * continuous vertical through the ellipses and stacks between them. Local stacks live
 * in lanes >= 1. Lanes come from parent SHAs rather than from the model's row order,
 * which is what keeps one column per in-flight chain so two independent sibling stacks
 * never collide in the same column.
 *
 * Every rail is an EDGE from a child row down to its parent row. An edge runs straight
 * down the child's lane, then at the parent row either continues straight (same lane, a
 * stacked commit) or bends into the parent's lane (a fork merging back onto its base).
 * Bases collect several such bends — every stack that forked off them curves back in.
 * The trunk spine is a synthetic chain of edges linking consecutive lane-0 anchors.
 *
 * Pure: no DOM, no measurement. `railGeometry` turns this into coordinates.
 */
import type { Row } from "#ui/renderModel";

/** A rail from a child row down to its parent row, with the lane at each end. */
export type Edge = {
  childRow: number;
  parentRow: number;
  childLane: number;
  parentLane: number;
};

export type GraphLayout = {
  /** Lane index per row, parallel to the rows passed in. */
  laneAtRow: number[];
  /** Widest lane in the graph, for the gutter width. */
  maxLane: number;
  edges: Edge[];
  rowCount: number;
};

/**
 * Rows that belong to the trunk spine.
 *
 * An ellipsis counts: it stands for commits on trunk that are not drawn, so the spine
 * has to pass through it rather than stop above it and resume below.
 */
function isTrunkRow(row: Row): boolean {
  return (
    row.type === "trunk-tip" || row.type === "base" || row.type === "ellipsis"
  );
}

/** The sha a row draws, or null for an ellipsis, which stands for several. */
function shaOf(row: Row): string | null {
  if (row.type === "commit") {
    return row.commit.sha;
  }
  return row.type === "ellipsis" ? null : row.sha;
}

export function layoutGraph(rows: Row[]): GraphLayout {
  const rowCount = rows.length;
  const parentAtRow = rows.map(row =>
    row.type === "commit" ? (row.commit.parents[0] ?? null) : null
  );
  const rowIndexOfSha = new Map<string, number>();
  rows.forEach((row, index) => {
    const sha = shaOf(row);
    if (sha !== null && !rowIndexOfSha.has(sha)) {
      rowIndexOfSha.set(sha, index);
    }
  });

  /**
   * Lane assignment. Lane 0 is reserved for the trunk; commit chains take >= 1.
   *
   * A lane stays reserved for the sha it heads toward until the row bearing that sha is
   * reached — including a base. Freeing at the fork point instead would let the next
   * stack reuse the column and its rail would cut straight through, so independent
   * stacks sharing one base must fan into separate lanes and only curve back in at the
   * base row.
   */
  const laneAtRow: number[] = new Array<number>(rowCount).fill(0);
  /** `targetShaByLane[lane >= 1]` is the sha that column is heading toward. */
  const targetShaByLane: (string | null)[] = ["__trunk__"];
  let maxLane = 0;
  for (const [rowIndex, row] of rows.entries()) {
    const sha = shaOf(row);
    if (isTrunkRow(row)) {
      laneAtRow[rowIndex] = 0;
      // A base collects every stack that forked off it: release those lanes here.
      for (let lane = 1; lane < targetShaByLane.length; lane++) {
        if (targetShaByLane[lane] === sha) {
          targetShaByLane[lane] = null;
        }
      }
      continue;
    }
    let lane = sha === null ? -1 : targetShaByLane.indexOf(sha);
    if (lane < 1) {
      lane = targetShaByLane.indexOf(null, 1);
      if (lane < 1) {
        lane = targetShaByLane.length;
      }
    }
    laneAtRow[rowIndex] = lane;
    // Several lanes can aim at this same commit (two stacks whose bottoms share a
    // parent commit). They all collapse here — free the others so later stacks reuse
    // the columns instead of leaving a permanent gap.
    for (let otherLane = 1; otherLane < targetShaByLane.length; otherLane++) {
      if (otherLane !== lane && targetShaByLane[otherLane] === sha) {
        targetShaByLane[otherLane] = null;
      }
    }
    // Head toward the parent whether it is a commit (the lane continues straight up
    // into it) or a base (the lane curves back to trunk at the base row).
    const parentSha = parentAtRow[rowIndex] ?? null;
    targetShaByLane[lane] =
      parentSha !== null && rowIndexOfSha.has(parentSha) ? parentSha : null;
    if (lane > maxLane) {
      maxLane = lane;
    }
  }

  // Edges: child row -> parent row, both on screen. A parent in lane 0 is a fork.
  const edges: Edge[] = [];
  for (const [rowIndex, parentSha] of parentAtRow.entries()) {
    if (parentSha === null) {
      continue;
    }
    const parentIndex = rowIndexOfSha.get(parentSha);
    if (parentIndex === undefined) {
      continue;
    }
    // `laneAtRow` was filled for every row above, so both lanes are assigned.
    edges.push({
      childRow: rowIndex,
      parentRow: parentIndex,
      childLane: laneAtRow[rowIndex] ?? 0,
      parentLane: laneAtRow[parentIndex] ?? 0,
    });
  }

  // Trunk spine: link consecutive lane-0 anchors (the trunk tip and the bases) so the
  // spine is one line through the ellipses and stacks between them.
  const anchorRows = rows.flatMap((row, rowIndex) =>
    row.type === "trunk-tip" || row.type === "base" ? [rowIndex] : []
  );
  for (const [index, childRow] of anchorRows.entries()) {
    const parentRow = anchorRows[index + 1];
    if (parentRow === undefined) {
      break;
    }
    edges.push({ childRow, parentRow, childLane: 0, parentLane: 0 });
  }

  return { laneAtRow, maxLane, edges, rowCount };
}
