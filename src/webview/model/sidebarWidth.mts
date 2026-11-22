/**
 * How wide the commit panel may be.
 *
 * Both bounds come from measuring the panel's own contents at 1px steps rather than from
 * taste. The floor keeps every row of action buttons on one line: "Amend message / Amend
 * working changes" — the widest set, shown for a HEAD commit with a dirty working copy —
 * needs 306px, so 340 fits it whole with room for a longer label. The ceiling is where the
 * tree starts losing its subjects. A
 * subject only ellipses once the tree drops under about 760px, so the 1400px reference
 * viewport tolerates 640 before anything is cut; past 780 the worst row shows barely half
 * its subject. 640 also buys the description editor 81 monospace columns, comfortably past
 * git's 72-column body convention, so nothing above it would help the panel either.
 *
 * The viewport clamp is separate and tighter, because both numbers above assume a wide
 * window. A row's fixed furniture — rail gutter, branch pill, badges, sha, You-are-here —
 * measures 422px in the demo repository, so the tree keeps 440px and the panel takes
 * whatever remains.
 */

export const SIDEBAR_DEFAULT_WIDTH = 380;
export const SIDEBAR_MIN_WIDTH = 340;
export const SIDEBAR_MAX_WIDTH = 640;
export const TREE_MIN_WIDTH = 440;
export const SIDEBAR_WIDTH_KEY = "gsm.sidebarWidth";
export const SIDEBAR_KEYBOARD_STEP = 16;

/**
 * Fit `width` to the bounds, narrowing the ceiling on a window too small to honour it.
 * The viewport term is what stops a restore — or a window someone dragged narrow
 * mid-session — from leaving the tree at zero.
 */
export function clampSidebarWidth(
  width: number,
  viewportWidth: number
): number {
  const ceiling = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - TREE_MIN_WIDTH)
  );
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(ceiling, width)));
}
