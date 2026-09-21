/**
 * How wide the changes overlay may be.
 *
 * The default is the geometry the overlay had when its width was fixed — 76% of the window,
 * which is what a 12% inset on each side comes to — so a reader who never touches an edge
 * sees no change.
 *
 * The floor is what a diff still reads at. The grid's furniture takes 98px before any code
 * is drawn: two 42px line-number gutters and the 14px `+`/`−` column. With the overlay's own
 * padding that leaves 520px carrying about 50 monospace columns at the default type size,
 * and a diff narrower than its own lines wraps more than it shows.
 *
 * The ceiling keeps 48px of tree visible on each side rather than letting the overlay fill
 * the window. That margin is the whole reason the overlay is inset: the tree behind it is
 * what says this is a step in a flow and not a new place.
 *
 * Widths are stored in pixels rather than as a share of the window, the same as the commit
 * panel's. A share restores as a different reading column on every monitor, and it is the
 * column the reader chose, not the proportion.
 */

export const CHANGES_WIDTH_KEY = "gsm.changesWidth";
export const CHANGES_MIN_WIDTH = 520;
/** Window left visible on each side, so the overlay stays an overlay. */
export const CHANGES_SIDE_MARGIN = 48;
/** The share of the window the overlay takes until an edge is dragged. */
export const CHANGES_DEFAULT_SHARE = 0.76;
/**
 * Pixels one arrow press adds to the width. Twice the splitter's step because the overlay
 * grows from its centre, so each edge still travels the splitter's 16.
 */
export const CHANGES_KEYBOARD_STEP = 32;

/**
 * The widest this window allows, which the floor wins over on a window narrow enough that
 * the two cross: a diff too narrow to read is worse than one that reaches the window's edge.
 */
export function maxChangesWidth(viewportWidth: number): number {
  return Math.max(CHANGES_MIN_WIDTH, viewportWidth - 2 * CHANGES_SIDE_MARGIN);
}

/** Fit `width` to the bounds, narrowing the ceiling on a window too small to honour it. */
export function clampChangesWidth(
  width: number,
  viewportWidth: number
): number {
  return Math.round(
    Math.max(CHANGES_MIN_WIDTH, Math.min(maxChangesWidth(viewportWidth), width))
  );
}

/** The width before anyone resizes it, and what `Home` on a focused edge restores. */
export function defaultChangesWidth(viewportWidth: number): number {
  return clampChangesWidth(
    Math.round(viewportWidth * CHANGES_DEFAULT_SHARE),
    viewportWidth
  );
}
