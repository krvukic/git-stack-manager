/**
 * A horizontal rule between two sections.
 *
 * One component, so the right-click menu, the commit panel, and the working copy divide their
 * sections with the same line. It has no margin of its own, for the reason `ButtonRow`
 * gives: spacing belongs to whatever stacks the sections.
 */
import { classes } from "../classes";

export function Hairline({ className }: { className?: string }) {
  return <hr className={classes("h-px border-0 bg-edge", className)} />;
}
