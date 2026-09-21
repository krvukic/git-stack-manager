/**
 * The inset panel a flow steps into: the split chooser and the changes viewer.
 *
 * Inset from every edge rather than full-screen, so the tree behind it stays partly visible —
 * which is what says this is a step in a flow and not a new place. The drawers are the
 * contrast: they are consulted *beside* the tree, so they dock instead of covering it.
 */
import { classes } from "../classes";

export function Modal({
  id,
  hidden = false,
  className,
  children,
}: {
  id: string;
  /**
   * Rendered but hidden, for a panel the end-to-end suite waits on by class. `#changes.open`
   * is that assertion: the element has to exist before it opens, so the changes viewer stays
   * mounted and toggles instead of unmounting.
   */
  hidden?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={classes(
        "fixed inset-x-[12%] inset-y-[8%] z-30 flex-col rounded-shell border border-edge bg-bg shadow-[0_8px_32px_rgba(0,0,0,0.5)]",
        hidden ? "hidden" : "open flex",
        className
      )}
    >
      {children}
    </div>
  );
}
