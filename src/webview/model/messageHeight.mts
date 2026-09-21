/**
 * How tall a message box may be, and which stored height belongs to which box.
 *
 * Two boxes take a height, and each gets its own key: the commit panel's **Description**,
 * where a message is read and amended, and the working copy's **Description**, where the next
 * commit's message is written. They hold different text at different moments, so one shared
 * height would mean sizing the reading box resized the writing box.
 *
 * Neither key mentions a commit. The height is the reader's choice of how much message to
 * see, not a property of what they are looking at, so selecting another commit keeps it —
 * which takes re-applying the stored height on mount, the commit panel being keyed on the
 * sha and so remounted per selection.
 *
 * The floors match each box's `min-height` in its own markup, because the grip cannot drag a
 * box below that and a stored value has to obey the same bound. The ceiling leaves 120px of
 * window, enough for the panel's heading above the box and its buttons below, so a height
 * stored on a tall monitor cannot hide the controls on a short one.
 */

export const DESCRIPTION_HEIGHT_KEY = "gsm.descriptionHeight";
export const COMMIT_BODY_HEIGHT_KEY = "gsm.commitBodyHeight";

/** The commit panel's description box: its starting height, and the floor a fit stops at. */
export const DESCRIPTION_MIN_HEIGHT = 110;
/** The working copy's description box, which starts smaller: a draft body is often empty. */
export const COMMIT_BODY_MIN_HEIGHT = 64;
/** Window kept for whatever sits above and below the box. */
export const MESSAGE_BOX_MARGIN = 120;

export function clampMessageHeight(
  height: number,
  minHeight: number,
  viewportHeight: number
): number {
  const ceiling = Math.max(minHeight, viewportHeight - MESSAGE_BOX_MARGIN);
  return Math.round(Math.max(minHeight, Math.min(ceiling, height)));
}
