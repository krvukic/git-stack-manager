/**
 * The commit tree.
 *
 * Lanes are computed once per model rather than per row, and memoised on `rows`: the poll
 * replaces the model every five seconds, so without this the whole graph would be laid out
 * again on each one even when nothing moved.
 */
import type { RenderModel, UICommit } from "#ui/renderModel";
import { useLayoutEffect, useMemo } from "react";
import { layoutGraph } from "../graph/layout.mjs";
import { LANE_WIDTH } from "../graph/rails.mjs";
import { EmptyState } from "./Field";
import { BaseRow, CommitRow, EllipsisRow, TrunkTipRow } from "./Row";

export function Tree({
  model,
  rowHeight,
  selectedSha,
  dimForeign,
  onSelect,
  onContextMenu,
  onGoto,
  onGotoTrunk,
  onOpenUrl,
}: {
  model: RenderModel;
  rowHeight: number;
  selectedSha: string | null;
  dimForeign: boolean;
  onSelect: (commit: UICommit) => void;
  onContextMenu: (event: React.MouseEvent, commit: UICommit) => void;
  onGoto: (commit: UICommit) => void;
  onGotoTrunk: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const layout = useMemo(() => layoutGraph(model.rows), [model.rows]);

  /**
   * The shared text edge for `pills-right`, from the widest rail in this graph — narrow
   * stacks then keep their text near the left rather than being indented for lanes they do
   * not have. Same arithmetic as the `il<n>` classes: lane * 18 + dot.
   *
   * On `:root` because `.row .content` reads it by inheritance, and a wrapper element here
   * would have to join the tree's own layout to pass it down.
   */
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--gutter",
      `${(layout.maxLane + 1) * LANE_WIDTH + 8}px`
    );
  }, [layout.maxLane]);

  if (!model.rows.length) {
    return (
      <EmptyState>
        {model.error ||
          `No local branches ahead of ${model.trunkRef || "trunk"}. Commit something to see your stacks here.`}
      </EmptyState>
    );
  }

  return (
    <>
      {model.rows.map((row, rowIndex) => {
        if (row.type === "commit") {
          return (
            <CommitRow
              key={row.commit.sha}
              commit={row.commit}
              layout={layout}
              rowIndex={rowIndex}
              rowHeight={rowHeight}
              isSelected={row.commit.sha === selectedSha}
              dimForeign={dimForeign}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onGoto={onGoto}
              onOpenUrl={onOpenUrl}
            />
          );
        }
        if (row.type === "trunk-tip") {
          return (
            <TrunkTipRow
              key={`trunk-${row.sha}`}
              row={row}
              headBranch={model.headBranch}
              layout={layout}
              rowIndex={rowIndex}
              rowHeight={rowHeight}
              onGotoTrunk={onGotoTrunk}
            />
          );
        }
        if (row.type === "base") {
          return (
            <BaseRow
              key={`base-${row.sha}`}
              row={row}
              layout={layout}
              rowIndex={rowIndex}
              rowHeight={rowHeight}
            />
          );
        }
        return (
          <EllipsisRow
            key={`ellipsis-${rowIndex}`}
            row={row}
            layout={layout}
            rowIndex={rowIndex}
            rowHeight={rowHeight}
          />
        );
      })}
    </>
  );
}
