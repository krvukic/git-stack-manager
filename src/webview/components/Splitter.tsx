/**
 * The divider between the tree and the commit panel.
 *
 * Drag with pointer capture, so the pointer may leave the 7px strip — which it does within
 * the first frame — without the drag ending or needing document-level listeners that
 * outlive it. Capture also delivers the release wherever it happens, including outside the
 * window, so there is no stuck drag to clean up.
 *
 * The move handler reads nothing from layout. The width is (drag origin − current x) added
 * to the width at press, both captured up front, so a move at refresh rate costs one
 * subtraction, one clamp, and one state write; measuring the element per move would force a
 * synchronous layout on every frame.
 */
import { useRef } from "react";
import { classes } from "../classes";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_KEYBOARD_STEP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../model/sidebarWidth.mjs";

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
  const dragging = useRef(false);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Ignore the middle and right buttons: only a primary press is a drag.
    if (event.button !== 0 || !splitter.current) {
      return;
    }
    const startX = event.clientX;
    const startWidth = width;
    const element = splitter.current;
    element.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
    document.body.classList.add("resizing");
    dragging.current = true;
    // Suppress the browser's own text-selection drag, which `user-select: none` only
    // prevents from extending — a press still collapses the caret. That also suppresses the
    // focus the press would have given, so take it explicitly: arrow-key nudging should
    // work straight after a drag.
    event.preventDefault();
    element.focus();

    // Where the drag has got to, so the release can persist it. Read back from state
    // instead would give the width from before this drag, since these handlers close over
    // the render that started it.
    let reached = startWidth;

    // The panel is on the right, so leftward travel — a smaller clientX — grows it.
    // Getting this sign backwards is the classic bug, so the suite asserts a measured
    // width in both directions rather than only that it moved.
    const onMove = (moveEvent: PointerEvent) => {
      reached = startWidth + (startX - moveEvent.clientX);
      onResize(reached, false);
    };
    const onEnd = () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onEnd);
      element.removeEventListener("pointercancel", onEnd);
      element.classList.remove("dragging");
      document.body.classList.remove("resizing");
      dragging.current = false;
      // Store what the drag reached, not what the pointer travelled past: dragging 400px
      // beyond the ceiling should not restore as an impossible width later.
      onResize(clampSidebarWidth(reached, window.innerWidth), true);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onEnd);
    element.addEventListener("pointercancel", onEnd);
  };

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
