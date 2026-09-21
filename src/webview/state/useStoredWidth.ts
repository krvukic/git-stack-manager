/**
 * A width someone chose: kept across loads, and re-fitted to the window it is drawn in.
 *
 * Two surfaces take a width — the commit panel and the changes overlay — and both need the
 * same three-part shape, which is the reason this is a hook rather than state in each one.
 *
 * The request and the applied width are separate values. A window too narrow to hold the
 * chosen width clamps what is applied and keeps what was asked for, so widening the window
 * restores the reader's choice rather than leaving the panel at whatever the smallest window
 * allowed. Storing the clamped width instead would make every narrow moment permanent.
 *
 * The clamp runs per render rather than in an effect, so a window resize never paints a width
 * this window cannot hold.
 */
import { useCallback, useEffect, useState } from "react";

export function useStoredWidth({
  initial,
  clamp,
  store,
}: {
  /** The stored width, or a default. Read once, so a later write cannot fight the drag. */
  initial: () => number;
  clamp: (width: number, viewportWidth: number) => number;
  store: (width: number) => void;
}): {
  /** What to draw, which a narrow window can hold below the request. */
  width: number;
  /** What was asked for, so a nudge starts from the request rather than the clamp. */
  requestedWidth: number;
  /** The window, for a handle that reports the bounds it is working within. */
  viewportWidth: number;
  onResize: (width: number, persist: boolean) => void;
} {
  const [requestedWidth, setRequestedWidth] = useState(initial);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onWindowResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const onResize = useCallback(
    (width: number, persist: boolean) => {
      setRequestedWidth(width);
      // Only on release, not per move: a drag would otherwise write to storage on every
      // frame. `window.innerWidth` rather than the state above, because a persist can land
      // in the same tick as a resize and the state is a render behind.
      if (persist) {
        store(clamp(width, window.innerWidth));
      }
    },
    [clamp, store]
  );

  return {
    width: clamp(requestedWidth, viewportWidth),
    requestedWidth,
    viewportWidth,
    onResize,
  };
}
