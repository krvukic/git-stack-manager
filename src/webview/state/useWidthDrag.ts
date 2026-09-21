/**
 * Dragging a vertical edge to set a width, shared by the commit panel's divider and the
 * changes overlay's own edges.
 *
 * Pointer capture, so the pointer may leave the few pixels of the handle — which it does
 * within the first frame — without the drag ending or needing document-level listeners that
 * outlive it. Capture also delivers the release wherever it happens, including outside the
 * window, so there is no stuck drag to clean up.
 *
 * The move handler reads nothing from layout. The width is the travel since the press added
 * to the width at press, both captured up front, so a move at refresh rate costs one
 * multiply, one clamp, and one state write; measuring the element per move would force a
 * synchronous layout on every frame.
 *
 * `gain` is width pixels per pixel of *leftward* travel, which is what makes one handler
 * serve three edges. The divider sits left of a panel that grows as the pointer goes left, so
 * 1. The overlay grows from its centre, so each of its edges moves the near edge and the far
 * edge at once: 2 for its left edge, −2 for its right, where rightward travel grows it.
 */
import { useCallback, type RefObject } from "react";

export function useWidthDrag({
  handle,
  gain,
  widthAtPress,
  clamp,
  onResize,
}: {
  handle: RefObject<HTMLElement | null>;
  gain: number;
  /** Read at the press rather than closed over, so two drags in a row both start correctly. */
  widthAtPress: () => number;
  clamp: (width: number) => number;
  onResize: (width: number, persist: boolean) => void;
}) {
  return useCallback(
    (event: React.PointerEvent) => {
      // Ignore the middle and right buttons: only a primary press is a drag.
      if (event.button !== 0 || !handle.current) {
        return;
      }
      const startX = event.clientX;
      const startWidth = widthAtPress();
      const element = handle.current;
      element.setPointerCapture(event.pointerId);
      element.classList.add("dragging");
      document.body.classList.add("resizing");
      // Suppress the browser's own text-selection drag, which `user-select: none` only
      // prevents from extending — a press still collapses the caret. That also suppresses the
      // focus the press would have given, so take it explicitly: arrow-key nudging should
      // work straight after a drag.
      event.preventDefault();
      element.focus();

      // Where the drag has got to, so the release can persist it. Reading it back from state
      // instead would give the width from before this drag, since these handlers close over
      // the render that started it.
      let reached = startWidth;

      // Getting this sign backwards is the classic bug, so the suite asserts a measured width
      // in both directions rather than only that it moved.
      const onMove = (moveEvent: PointerEvent) => {
        reached = startWidth + gain * (startX - moveEvent.clientX);
        onResize(reached, false);
      };
      const onEnd = () => {
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerup", onEnd);
        element.removeEventListener("pointercancel", onEnd);
        element.classList.remove("dragging");
        document.body.classList.remove("resizing");
        // Store what the drag reached, not what the pointer travelled past: dragging 400px
        // beyond the ceiling should not restore as an impossible width later.
        onResize(clamp(reached), true);
      };
      element.addEventListener("pointermove", onMove);
      element.addEventListener("pointerup", onEnd);
      element.addEventListener("pointercancel", onEnd);
    },
    [clamp, gain, handle, onResize, widthAtPress]
  );
}
