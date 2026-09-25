/**
 * One row of the tree: its rail gutter, then content indented past the rails.
 *
 * The four row kinds share the gutter and differ only in what they put beside it, so each
 * is its own small component over a common `RowShell`.
 *
 * Pills live in their own group so the Config setting can move the whole set to the far
 * side without reordering anything else. The group is emitted first either way and `order`
 * in the stylesheet does the moving — swapping the elements here would mean two orderings
 * to keep in step.
 */
import type { Row as ModelRow, UICommit } from "#ui/renderModel";
import { memo } from "react";
import { classes } from "../classes";
import type { GraphLayout } from "../graph/layout.mjs";
import { railGeometry, type RowKind } from "../graph/rails.mjs";
import { trunkBehindBadge } from "../model/badges.mjs";
import { gotoTarget } from "../model/commits.mjs";
import { Button } from "./Button";
import { Badge, BranchPills, Pill, YouAreHere } from "./Pills";
import { RailFillers, RailGutter } from "./Rails";

/**
 * An abbreviated commit hash.
 *
 * Its size tracks the body text rather than sitting at a fixed 11px: a reader who scales the
 * text up is scaling what they read, and the sha is part of that.
 */
function Sha({ value }: { value: string }) {
  return (
    <span className="sha flex-none font-[monospace] text-sha leading-none text-muted">
      {value}
    </span>
  );
}

type RowShellProps = {
  layout: GraphLayout;
  rowIndex: number;
  kind: RowKind;
  isHead: boolean;
  rowHeight: number;
  className: string;
  sha?: string;
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  children: React.ReactNode;
};

function RowShell({
  layout,
  rowIndex,
  kind,
  isHead,
  rowHeight,
  className,
  sha,
  onClick,
  onContextMenu,
  children,
}: RowShellProps) {
  const rails = railGeometry(layout, rowIndex, kind, isHead, rowHeight);
  return (
    <div
      className={classes("group/row", className)}
      data-sha={sha}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <RailGutter rails={rails} />
      <RailFillers centres={rails.bottomLaneCentres} />
      <div
        className="content"
        style={{ "--lane": rails.indentLane } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}

/** Revealed on hover, so it does not compete with the subject until it is wanted. */
function GotoButton({
  onGoto,
  description,
  disabled = false,
}: {
  onGoto: () => void;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <Button
      size="small"
      disabled={disabled}
      // `invisible` rather than `hidden`, so the row's width does not change when it appears.
      className="goto-btn invisible ml-auto flex-none group-hover/row:visible"
      title={description}
      onClick={event => {
        event.stopPropagation();
        onGoto();
      }}
    >
      Goto
    </Button>
  );
}

type CommitRowProps = {
  commit: UICommit;
  layout: GraphLayout;
  rowIndex: number;
  rowHeight: number;
  isSelected: boolean;
  /** `gsm.onlyMyCommits`: dim a commit somebody else wrote. */
  dimForeign: boolean;
  onSelect: (commit: UICommit) => void;
  onContextMenu: (event: React.MouseEvent, commit: UICommit) => void;
  onGoto: (commit: UICommit) => void;
  onOpenUrl: (url: string) => void;
};

/**
 * Memoised on the commit and its row position.
 *
 * The poll replaces the whole model every five seconds, so without this every row's rails
 * would be rebuilt from scratch on each one — and the SVG is the expensive part. A commit
 * object is only a new identity when the read actually produced different data, so
 * unchanged rows re-use their elements.
 */
export const CommitRow = memo(function CommitRow({
  commit,
  layout,
  rowIndex,
  rowHeight,
  isSelected,
  dimForeign,
  onSelect,
  onContextMenu,
  onGoto,
  onOpenUrl,
}: CommitRowProps) {
  // `foreign` dims the subject; only applied when the setting asks for it, so a shared
  // branch does not look broken by default.
  const foreign = dimForeign && !commit.isMine;
  // Where the button would land, so it can say so and refuse when another worktree holds
  // the branch — the same contract the trunk row below already follows.
  const goto = gotoTarget(commit);
  return (
    <RowShell
      layout={layout}
      rowIndex={rowIndex}
      kind="commit"
      isHead={commit.isHead}
      rowHeight={rowHeight}
      className={classes(
        "row clickable",
        commit.isHead && "head",
        isSelected && "selected"
      )}
      sha={commit.sha}
      onClick={() => onSelect(commit)}
      onContextMenu={event => onContextMenu(event, commit)}
    >
      <span className="pillgroup">
        {(commit.branchDetails ?? []).map(branch => (
          <BranchPills
            key={branch.name}
            branch={branch}
            onOpenUrl={onOpenUrl}
          />
        ))}
      </span>
      <span
        className={foreign ? "subject foreign" : "subject"}
        title={
          foreign ? `${commit.subject} — ${commit.authorName}` : commit.subject
        }
      >
        {commit.subject}
      </span>
      <Sha value={commit.shortSha} />
      {commit.isHead ? (
        <YouAreHere />
      ) : (
        <GotoButton
          onGoto={() => onGoto(commit)}
          disabled={Boolean(goto.heldBy)}
          description={
            goto.heldBy
              ? `${goto.ref} is checked out in ${goto.heldBy}`
              : goto.detach
                ? `Check out ${commit.shortSha}, leaving HEAD detached`
                : `Check out ${goto.ref}`
          }
        />
      )}
    </RowShell>
  );
});

/**
 * The trunk tip.
 *
 * Its Goto lands on this row's commit by way of `trunkBranch` — the local branch that
 * reaches trunk — because `git switch origin/main` detaches HEAD rather than putting you on
 * main. A branch that trails the ref is fast-forwarded on the way, so the destination is the
 * row that was clicked rather than wherever the branch was last left; `Repository.gotoTrunk`
 * owns that part. In a bare-ish checkout no local branch reaches trunk, and then there is
 * nothing to offer.
 *
 * When another worktree has that branch checked out, git refuses the switch. The button
 * stays visible but disabled, naming the directory that holds it: a missing button reads
 * as a bug in the row, whereas the path tells you where to look.
 *
 * The badge is how far that local branch trails this row. The branch has a pill of its own,
 * on this row while level and on a `BaseRow` further down once a fetch leaves it behind, but
 * only this row's Goto can bring it level, so the count sits beside that Goto. Goto goes away once
 * HEAD is already on the branch, where the switch would change nothing; the badge's own
 * wording then points at Pull instead, which is the only way left to move the branch.
 */
export function TrunkTipRow({
  row,
  headBranch,
  layout,
  rowIndex,
  rowHeight,
  onGotoTrunk,
}: {
  row: Extract<ModelRow, { type: "trunk-tip" }>;
  /** Branch HEAD is on, or null when detached. */
  headBranch: string | null;
  layout: GraphLayout;
  rowIndex: number;
  rowHeight: number;
  onGotoTrunk: () => void;
}) {
  const heldBy = row.trunkBranchWorktree;
  const isCheckedOut =
    Boolean(row.trunkBranch) && headBranch === row.trunkBranch;
  const canGoto = Boolean(row.trunkBranch) && !row.isHead && !isCheckedOut;
  const behind = trunkBehindBadge(
    row.trunkBranch,
    row.trunkBranchBehind,
    row.trunkRef,
    isCheckedOut
  );
  return (
    <RowShell
      layout={layout}
      rowIndex={rowIndex}
      kind="trunk-tip"
      isHead={row.isHead}
      rowHeight={rowHeight}
      className={classes(
        "row",
        row.isHead && "head",
        canGoto && !heldBy && "clickable"
      )}
    >
      <span className="pillgroup">
        <Pill label={row.trunkRef} variant="trunk" />
        {row.trunkBranchAtTip && row.trunkBranch ? (
          <Pill label={row.trunkBranch} />
        ) : null}
        {behind ? <Badge {...behind} /> : null}
      </span>
      <span className="subject text-muted" title={row.subject}>
        {row.subject}
      </span>
      <Sha value={row.shortSha} />
      {row.isHead ? <YouAreHere /> : null}
      {canGoto ? (
        <GotoButton
          onGoto={onGotoTrunk}
          disabled={Boolean(heldBy)}
          description={
            heldBy
              ? `${row.trunkBranch} is checked out in ${heldBy}`
              : row.trunkBranchBehind
                ? `Check out ${row.trunkBranch} and fast-forward it to ${row.trunkRef}`
                : `Check out ${row.trunkBranch}`
          }
        />
      ) : null}
    </RowShell>
  );
}

/**
 * A commit on trunk below the tip: where a stack forked, where the local trunk branch was
 * left when trunk moved on, where HEAD sits, or any mix of the three.
 *
 * Only two branches earn a pill here: the trunk branch, and the branch HEAD is on. Any other
 * branch with commits has a row of its own. The trunk branch's Goto is a plain checkout
 * rather than the trunk row's fast-forward, because this row names the commit it is on.
 */
export function BaseRow({
  row,
  headBranch,
  layout,
  rowIndex,
  rowHeight,
  onGotoBranch,
}: {
  row: Extract<ModelRow, { type: "base" }>;
  /** Branch HEAD is on, or null when detached. */
  headBranch: string | null;
  layout: GraphLayout;
  rowIndex: number;
  rowHeight: number;
  onGotoBranch: (branch: string) => void;
}) {
  const branch = row.trunkBranch;
  const heldBy = row.trunkBranchWorktree;
  const canGoto = Boolean(branch) && !row.isHead && headBranch !== branch;
  return (
    <RowShell
      layout={layout}
      rowIndex={rowIndex}
      kind="base"
      isHead={row.isHead}
      rowHeight={rowHeight}
      className={classes(
        "row",
        row.isHead && "head",
        canGoto && !heldBy && "clickable"
      )}
    >
      {branch || row.headBranch ? (
        <span className="pillgroup">
          {branch ? <Pill label={branch} /> : null}
          {row.headBranch ? <Pill label={row.headBranch} /> : null}
        </span>
      ) : null}
      <span className="subject text-muted" title={row.subject}>
        {row.subject}
      </span>
      <Sha value={row.shortSha} />
      {row.isForkPoint ? (
        <span className="basehint text-muted">(base — where you branched)</span>
      ) : null}
      {row.isHead ? <YouAreHere /> : null}
      {canGoto && branch ? (
        <GotoButton
          onGoto={() => onGotoBranch(branch)}
          disabled={Boolean(heldBy)}
          description={
            heldBy
              ? `${branch} is checked out in ${heldBy}`
              : `Check out ${branch}`
          }
        />
      ) : null}
    </RowShell>
  );
}

/** Commits on trunk that are not drawn, or the seam where a stack leaves trunk. */
export function EllipsisRow({
  row,
  layout,
  rowIndex,
  rowHeight,
}: {
  row: Extract<ModelRow, { type: "ellipsis" }>;
  layout: GraphLayout;
  rowIndex: number;
  rowHeight: number;
}) {
  return (
    <RowShell
      layout={layout}
      rowIndex={rowIndex}
      kind="ellipsis"
      isHead={false}
      rowHeight={rowHeight}
      className="row ellipsis-row"
    >
      <span className="ellipsis-label">
        {row.count === -1
          ? "not on trunk"
          : `${row.count} commit${row.count > 1 ? "s" : ""} hidden`}
      </span>
    </RowShell>
  );
}
