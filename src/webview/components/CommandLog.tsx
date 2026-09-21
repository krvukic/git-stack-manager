/**
 * The command log: the exact git commands each action ran, grouped by action.
 *
 * Hiding the panel hands its quarter of the viewport back to the tree, so the choice has
 * to outlive the page — a per-session toggle would spring the log open on every reload.
 */
import { useEffect, useRef } from "react";
import { classes } from "../classes";
import type { LogEntry } from "../state/useSmartlog";
import { Button } from "./Button";
import { FieldLabel } from "./Field";

export function CommandLog({
  entries,
  hidden,
  onClear,
}: {
  entries: LogEntry[];
  hidden: boolean;
  onClear: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);

  /**
   * Keep the newest entry in view.
   *
   * Re-run on `hidden` as well as on the entries: a `display: none` panel measures zero,
   * so a scroll performed while it was hidden moved nothing and the newest entry would sit
   * above the fold when it reopens.
   */
  useEffect(() => {
    if (!hidden && body.current) {
      body.current.scrollTop = body.current.scrollHeight;
    }
  }, [entries, hidden]);

  return (
    <div
      id="log"
      // A quarter of the viewport, and `hidden` takes it out of the layout entirely rather
      // than shrinking it to zero: removing it is what hands the height to the tree, which is
      // the sibling that grows. At zero height the border would still paint and the tree
      // would stay a quarter short.
      className={classes(
        "h-1/4 flex-none flex-col border-t border-t-edge",
        hidden ? "hidden" : "flex"
      )}
    >
      {/*
        `tracking-caps` stays on the bar rather than moving onto the title with the rest of the
        heading style, because Clear inherits it. Chrome's own button rule blocks
        `text-transform`, but nothing blocks `letter-spacing` — Tailwind's preflight asks for it
        explicitly — so dropping it here narrows that button from 51px to 42px.
      */}
      <div
        id="log-bar"
        className="flex flex-none items-center gap-2 border-b border-b-edge px-3 py-1 text-meta/auto tracking-caps"
      >
        <FieldLabel as="span" heading>
          Command log
        </FieldLabel>
        <span className="flex-1" />
        <Button size="small" id="btn-log-clear" onClick={onClear}>
          Clear
        </Button>
      </div>
      <div
        id="log-body"
        ref={body}
        className="flex-1 overflow-y-auto px-3 py-2 font-[monospace] text-body/auto"
      >
        {entries.length === 0 ? (
          <div className="text-muted">
            Actions you take appear here as the git commands they run.
          </div>
        ) : (
          entries.map(entry => (
            // `first:border-t-0` rather than a margin: the rule is "a line between entries",
            // and a border on every entry puts one above the first as well.
            // `log-entry`, `log-title` and `log-cmd` below carry no styling — the utilities
            // do — but the end-to-end suite reads the panel through them, so they stay.
            <div
              className="log-entry border-t border-t-edge py-1.5 first:border-t-0"
              key={entry.id}
            >
              <div className="log-title mb-0.75 text-muted">{entry.title}</div>
              {entry.commands.map((command, index) => (
                // A command wraps rather than scrolling sideways, and `break-all` is what
                // lets it: these are single tokens hundreds of characters long — a
                // `for-each-ref` format string — with no spaces to break at. Not
                // `wrap-anywhere`, which only breaks a word that would overflow on its own
                // and leaves the rest of the line intact.
                <div
                  className="log-cmd break-all whitespace-pre-wrap"
                  key={index}
                >
                  <span className="text-accent select-none">$ </span>
                  {command}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
