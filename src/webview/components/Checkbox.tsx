/**
 * A checkbox that can also show "some": a file with a few of its lines left out, or a hunk with a
 * few of them. HTML has no attribute for that state, only the `indeterminate` property, so it is
 * set on the element after each render.
 *
 * `onToggle` carries the shift key, which is how a line's box extends a range. A checkbox's change
 * event does not report it, so the click is handled instead. React still owns `checked`, and
 * `readOnly` tells it the click is handled elsewhere.
 */
import { useLayoutEffect, useRef } from "react";
import { classes } from "../classes";
import type { CheckState } from "../model/lineChoice.mjs";

export function Checkbox({
  state,
  label,
  className,
  disabled = false,
  onToggle,
}: {
  state: CheckState;
  label: string;
  className?: string;
  disabled?: boolean;
  /** Runs with whether the box becomes checked; "some" becomes checked. */
  onToggle: (checked: boolean, shiftKey: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (box.current) {
      box.current.indeterminate = state === "some";
    }
  }, [state]);

  return (
    <input
      ref={box}
      type="checkbox"
      className={classes("flex-none cursor-pointer", className)}
      aria-label={label}
      checked={state === "all"}
      disabled={disabled}
      readOnly
      onClick={event => {
        event.stopPropagation();
        onToggle(state !== "all", event.shiftKey);
      }}
    />
  );
}
