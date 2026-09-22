/**
 * Every change in a commit, as one scrollable read-only view — Sapling's "View Changes in
 * <hash>" — and the same view for the uncommitted changes, which no commit holds.
 *
 * Shared with the per-file diff rather than written twice: `onlyPath` narrows it to one
 * file, which is what the web host falls back to when asked for a diff editor it does not
 * have. The rendering is the same either way, so a change to how a hunk looks lands in both.
 *
 * For the uncommitted changes it is also where lines are chosen, since it is the one place the
 * lines are on screen. The footer commits or amends from here, because the overlay covers the
 * tree those actions otherwise start from.
 *
 * Modal and near-full-screen: a diff is the thing being read, so it gets the room, unlike
 * the Config and legend drawers which are consulted beside the tree. How much room is the
 * reader's, through either edge — a diff is read at whatever column the code is written to,
 * and that is a property of the repository rather than of the commit being read, so the width
 * is remembered rather than asked for again.
 */
import type { CommitDiff, FileDiff } from "#git/diff";
import type { WorkingFileDiff } from "#history/partialSelection";
import type { UICommit } from "#ui/renderModel";
import { useCallback, useMemo, useRef } from "react";
import { classes } from "../classes";
import {
  CHANGES_KEYBOARD_STEP,
  CHANGES_MIN_WIDTH,
  clampChangesWidth,
  defaultChangesWidth,
  maxChangesWidth,
} from "../model/changesWidth.mjs";
import {
  changedLineKeys,
  rowPathFor,
  type LineChoice,
} from "../model/lineChoice.mjs";
import { useStoredWidth } from "../state/useStoredWidth";
import { useWidthDrag } from "../state/useWidthDrag";
import { readStoredChangesWidth, storeChangesWidth } from "../storage";
import { Button } from "./Button";
import { ChangesFooter, type ChosenCount } from "./ChangesFooter";
import { FileDiffView, type Chooser } from "./FileDiff";
import { Modal } from "./Modal";

export type ChangesState =
  | { state: "loading"; title: string }
  | { state: "error"; title: string; error: string }
  | {
      state: "ready";
      title: string;
      /** The commit being read. */
      sha: string;
      files: FileDiff[];
    }
  | {
      state: "ready";
      title: string;
      /** Null for the uncommitted changes, which no commit holds. */
      sha: null;
      files: WorkingFileDiff[];
    }
  | null;

/** What the uncommitted changes' overlay needs to choose lines and act on them. */
export type WorkingChoosing = {
  /** The working-copy list's paths, which the ticks and the choices are keyed on. */
  rowPaths: ReadonlySet<string>;
  pickedPaths: ReadonlySet<string>;
  choices: ReadonlyMap<string, LineChoice>;
  chooser: Chooser;
  targets: UICommit[];
  selectedSha: string | null;
  canAct: boolean;
  amending: boolean;
  onCommit: () => void;
  onAmend: (target: UICommit) => void;
};

/** How much of the files on screen is chosen, for the footer. */
function countChosen(
  files: WorkingFileDiff[],
  choosing: WorkingChoosing
): ChosenCount {
  const count = {
    files: files.length,
    pickedFiles: 0,
    lines: 0,
    chosenLines: 0,
  };
  for (const file of files) {
    const rowPath = rowPathFor(file.path, choosing.rowPaths);
    const picked = rowPath !== null && choosing.pickedPaths.has(rowPath);
    if (picked) {
      count.pickedFiles++;
    }
    if (rowPath !== file.path || file.wholeFileReason) {
      continue;
    }
    const lines = changedLineKeys(file.hunks).length;
    const choice = choosing.choices.get(file.path);
    count.lines += lines;
    if (picked) {
      count.chosenLines +=
        choice?.fingerprint === file.fingerprint
          ? lines - choice.excluded.size
          : lines;
    }
  }
  return count;
}

/**
 * One draggable edge of the overlay, the diff's equivalent of the commit panel's divider.
 *
 * Both edges rather than one, because the overlay is centred: a reader reaches for whichever
 * edge is nearer the hand, and an overlay that could only be widened from the left would
 * still move its right edge. Each edge moves both, so a drag changes the width by twice its
 * travel — the `gain` `useWidthDrag` takes.
 *
 * Just outside the border rather than just inside it. Inside, the right-hand strip would sit
 * on top of the diff's own scrollbar, and a reader reaching for the scrollbar would resize the
 * overlay instead.
 */
function ResizeEdge({
  side,
  width,
  maxWidth,
  onResize,
}: {
  side: "left" | "right";
  width: number;
  maxWidth: number;
  onResize: (width: number, persist: boolean) => void;
}) {
  const edge = useRef<HTMLDivElement>(null);
  const clamp = useCallback(
    (reached: number) => clampChangesWidth(reached, window.innerWidth),
    []
  );
  // Leftward travel widens from the left edge and narrows from the right, and each edge
  // carries the far one with it.
  const gain = side === "left" ? 2 : -2;
  const onPointerDown = useWidthDrag({
    handle: edge,
    gain,
    widthAtPress: () => width,
    clamp,
    onResize,
  });

  /**
   * Arrows and Home while the edge holds focus, the same pattern the divider follows.
   *
   * Each edge follows the arrow rather than both widening on the same key: pressing ← moves
   * the focused edge left, which widens the overlay from its left edge and narrows it from its
   * right. `gain` already says which, so the sign comes from there.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step =
      event.key === "ArrowLeft"
        ? CHANGES_KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? -CHANGES_KEYBOARD_STEP
          : null;
    if (step === null && event.key !== "Home") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onResize(
      step === null
        ? defaultChangesWidth(window.innerWidth)
        : clamp(width + Math.sign(gain) * step),
      true
    );
  };

  return (
    <div
      id={`changes-edge-${side}`}
      ref={edge}
      className={classes(
        "absolute inset-y-0 w-1.75 cursor-col-resize",
        // No colour until the pointer or focus arrives: the overlay's own border is already
        // drawn right beside this, and a second line beside it would read as a fault.
        "before:absolute before:inset-y-3 before:w-0.5 before:content-['']",
        "hover:before:bg-accent [&.dragging]:before:bg-accent",
        "focus-visible:outline focus-visible:outline-accent",
        side === "left"
          ? "-left-1.75 before:right-0"
          : "-right-1.75 before:left-0"
      )}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label={`Resize the changes view from its ${side} edge`}
      aria-valuenow={width}
      aria-valuemin={CHANGES_MIN_WIDTH}
      aria-valuemax={maxWidth}
      title="Drag to resize. Focused: ← → nudge, Home restores the default width."
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

export function ChangesOverlay({
  changes,
  choosing,
  onClose,
}: {
  changes: ChangesState;
  choosing: WorkingChoosing;
  onClose: () => void;
}) {
  // Remembered across loads, and shared by every diff: the width is how wide the reader wants
  // code, not something about the commit they happen to be reading.
  const { width, viewportWidth, onResize } = useStoredWidth({
    initial: () =>
      readStoredChangesWidth() ?? defaultChangesWidth(window.innerWidth),
    clamp: clampChangesWidth,
    store: storeChangesWidth,
  });
  const working =
    changes?.state === "ready" && changes.sha === null ? changes.files : null;
  const count = useMemo(
    () => (working ? countChosen(working, choosing) : null),
    [choosing, working]
  );

  return (
    <Modal id="changes" hidden={!changes} width={width}>
      <ResizeEdge
        side="left"
        width={width}
        maxWidth={maxChangesWidth(viewportWidth)}
        onResize={onResize}
      />
      <ResizeEdge
        side="right"
        width={width}
        maxWidth={maxChangesWidth(viewportWidth)}
        onResize={onResize}
      />
      <div className="flex flex-none items-center gap-2 border-b border-b-edge px-3 py-2 font-[monospace] text-body">
        <span id="changes-title">{changes?.title ?? ""}</span>
        <span className="flex-1" />
        <Button id="btn-changes-close" onClick={onClose}>
          Close
        </Button>
      </div>
      <div id="changes-body" className="flex-1 overflow-y-auto px-3 py-2">
        {changes?.state === "loading" ? (
          <div className="text-muted">Loading…</div>
        ) : null}
        {changes?.state === "error" ? (
          <div className="text-muted">{changes.error}</div>
        ) : null}
        {changes?.state === "ready" ? (
          changes.files.length ? (
            changes.files.map(file => {
              const rowPath = working
                ? rowPathFor(file.path, choosing.rowPaths)
                : null;
              return (
                <FileDiffView
                  key={file.path}
                  sha={changes.sha}
                  file={file}
                  chooser={working ? choosing.chooser : null}
                  rowPath={rowPath}
                  picked={rowPath !== null && choosing.pickedPaths.has(rowPath)}
                  choice={working ? choosing.choices.get(file.path) : undefined}
                />
              );
            })
          ) : (
            <div className="text-muted">
              {changes.sha
                ? "No changes in this commit."
                : "No uncommitted changes."}
            </div>
          )
        ) : null}
      </div>
      {count && count.files ? (
        <ChangesFooter
          count={count}
          targets={choosing.targets}
          selectedSha={choosing.selectedSha}
          canAct={choosing.canAct}
          amending={choosing.amending}
          onCommit={choosing.onCommit}
          onAmend={choosing.onAmend}
        />
      ) : null}
    </Modal>
  );
}

export type { CommitDiff };
