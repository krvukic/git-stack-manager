/**
 * The divider between the tree and the commit panel.
 *
 * The drag itself lives in `useWidthDrag`, shared with the changes overlay's edges. The
 * panel is on the right, so leftward travel widens it one pixel per pixel — a gain of 1,
 * against the overlay's 2.
 */
import { useCallback, useRef } from "react";
import { classes } from "../classes";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_KEYBOARD_STEP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../model/sidebarWidth.mjs";
import { useWidthDrag } from "../state/useWidthDrag";

export function Splitter({
  isOpen,
  width,
  requestedWidth,
  onResize,
}: {
  isOpen: boolean;
  /** The width actually applied, which a narrow window can hold below the request. */
  width: number;
  /** What was asked for, so a nudge starts from the request rather than the clamp. */
  requestedWidth: number;
  onResize: (width: number, persist: boolean) => void;
}) {
  const splitter = useRef<HTMLDivElement>(null);
  const clamp = useCallback(
    (reached: number) => clampSidebarWidth(reached, window.innerWidth),
    []
  );

  const onPointerDown = useWidthDrag({
    handle: splitter,
    gain: 1,
    widthAtPress: () => width,
    clamp,
    onResize,
  });

  /**
   * Arrows and Home on the focused separator, the WAI-ARIA window splitter pattern and the
   * only way to resize without a pointer. Handled here rather than in the global keydown so
   * the tree's own arrow navigation is untouched: this stops the event before that one sees
   * it, and only while the separator itself holds focus.
   *
   * Page Up/Down and Enter-to-collapse are left out — Escape already closes the panel, and
   * a second collapse gesture would need a restore gesture to match.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step =
      event.key === "ArrowLeft"
        ? SIDEBAR_KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? -SIDEBAR_KEYBOARD_STEP
          : null;
    if (step === null && event.key !== "Home") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Nudge from the applied width rather than the requested one, so a key press in a
    // narrow window moves by one step instead of first jumping back to a width this window
    // already refused.
    onResize(
      step === null
        ? SIDEBAR_DEFAULT_WIDTH
        : clampSidebarWidth(requestedWidth, window.innerWidth) + step,
      true
    );
  };

  return (
    <div
      id="splitter"
      ref={splitter}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label="Resize the commit panel"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      title="Drag to resize. Focused: ← → nudge, Home restores the default width."
      /*
       * The divider IS the drag target, so it owns the hairline the panel's own border used to
       * draw — keeping both would paint two lines 7px apart and read as a rendering fault. A
       * 7px strip is what makes the target findable; the line inside it, drawn by `before`,
       * stays 1px until the pointer arrives.
       *
       * Hover takes the focus colour and thickens the line rather than following the
       * button/row precedent, because neither carries here: `brightness(1.15)` turns #3c3f45
       * into #454951, which nobody can see on one pixel, and a card-coloured background on a
       * 7px sliver is equally invisible against the editor's own.
       */
      className={classes(
        "relative w-1.75 flex-none cursor-col-resize",
        "before:absolute before:inset-x-0.75 before:inset-y-0 before:bg-edge before:content-['']",
        "hover:before:inset-x-0.5 hover:before:bg-accent",
        "[&.dragging]:before:inset-x-0.5 [&.dragging]:before:bg-accent",
        "focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-accent",
        isOpen ? "block" : "hidden"
      )}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
