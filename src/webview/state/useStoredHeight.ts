/**
 * A message box's height, kept across loads without taking the resize grip away from it.
 *
 * The browser's own grip already resizes a textarea, and it does it better than a custom handle
 * would — it is the gesture readers already know, and the commit panel's double-click-to-fit
 * works through the same inline height. So nothing here replaces it: the stored height is
 * handed back for React to render, and whatever the grip leaves behind is read out again.
 *
 * `ResizeObserver` rather than a drag handler, because the grip raises no event a listener can
 * subscribe to. It also catches the double-click fit for free, which a handler on the grip
 * would have missed.
 *
 * The stored height is read once per mount and never re-rendered from. After a drag the
 * element's own inline height is already what the reader sees, so pushing the same number back
 * through state would cost a render and change nothing.
 *
 * The write is debounced. A grip drag resizes the box on every frame, and `localStorage` is
 * synchronous — persisting per frame would put a disk-backed write inside the drag.
 */
import { useEffect, useMemo, type RefObject } from "react";
import { clampMessageHeight } from "../model/messageHeight.mjs";
import { readStoredMessageHeight, storeMessageHeight } from "../storage";

/** Long enough to outlast a drag's frames, short enough to survive a quick reload after one. */
const PERSIST_DELAY = 200;

/**
 * The last height each box was observed at, which a remount reads before storage.
 *
 * The debounce alone loses a drag the reader immediately follows with a click. React renders the
 * replacement panel before it runs the old one's cleanup, so a commit selected within the delay
 * reads the key while the write is still pending and restores the old value — the box snapping
 * back to 110px, which is the whole bug this hook exists to fix. Updating this map is free, so
 * it happens per observation and the debounce is left to guard `localStorage` alone.
 */
const latestHeights = new Map<string, number>();

/** The height to render the box at, or undefined where the reader has never resized it. */
export function useStoredHeight(
  box: RefObject<HTMLTextAreaElement | null>,
  key: string,
  minHeight: number
): number | undefined {
  const stored = useMemo(() => {
    const height = latestHeights.get(key) ?? readStoredMessageHeight(key);
    return height === null
      ? undefined
      : clampMessageHeight(height, minHeight, window.innerHeight);
  }, [key, minHeight]);

  useEffect(() => {
    const element = box.current;
    if (!element) {
      return;
    }
    // What storage holds, so an observation that changes nothing writes nothing — including
    // the observation the browser delivers the moment the box is observed.
    let written = stored;

    let pending: number | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (pending !== undefined && pending !== written) {
        written = pending;
        storeMessageHeight(key, pending);
      }
      pending = undefined;
    };

    const observer = new ResizeObserver(() => {
      const height = element.offsetHeight;
      // Zero means the box is hidden, which the working copy's commit form is until someone
      // opens it: it stays mounted so a half-typed draft survives being closed. Storing that
      // zero would restore a collapsed box.
      if (!height) {
        return;
      }
      const next = clampMessageHeight(height, minHeight, window.innerHeight);
      // The floor is also the starting height, so a box nobody has dragged stores nothing.
      // Writing it would pin today's default into storage and override tomorrow's.
      if (next === written || (written === undefined && next === minHeight)) {
        return;
      }
      latestHeights.set(key, next);
      pending = next;
      timer ??= setTimeout(flush, PERSIST_DELAY);
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      if (timer !== null) {
        clearTimeout(timer);
      }
      // A drag can end with the panel closing — Escape releases the pointer and dismisses the
      // selection — so the last size is written here rather than dropped with the timer.
      flush();
    };
  }, [box, key, minHeight, stored]);

  return stored;
}
