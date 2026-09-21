/**
 * A short message about what just happened, at the bottom of the window.
 *
 * `display` is set inline rather than through a class because the end-to-end suite hides
 * the toast the same way before a screenshot — it is the one element whose presence in a
 * frame depends on how long the git work before it took, and the page's Content Security
 * Policy refuses an injected stylesheet, so setting the property the app itself sets is
 * what survives that.
 */
import { classes } from "../classes";
import type { Toast as ToastValue } from "../state/useSmartlog";

export function Toast({ toast }: { toast: ToastValue }) {
  return (
    <div
      id="toast"
      // Centred on the bottom edge, over everything but the tooltip. An error keeps the error
      // border and colour; a success takes the accent and the ordinary text colour, so the two
      // are told apart at a glance rather than by reading.
      className={classes(
        "fixed bottom-3.5 left-1/2 z-10 max-w-[80%] -translate-x-1/2 rounded-card border px-4 py-2",
        "bg-card",
        toast && !toast.isError
          ? "info border-accent text-fg"
          : "border-err text-err"
      )}
      style={{ display: toast ? "block" : "none" }}
    >
      {toast?.text}
    </div>
  );
}
