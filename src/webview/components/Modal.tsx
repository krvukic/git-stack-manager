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
  width,
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
  /**
   * A width the reader set, for a panel whose edges can be dragged. Centred on the window
   * instead of inset from both sides, since a width and two insets cannot all three hold.
   * Left off, the symmetric inset applies — which is what the split chooser wants, having no
   * edges to drag.
   */
  width?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={classes(
        "fixed inset-y-[8%] z-30 flex-col rounded-shell border border-edge bg-bg shadow-[0_8px_32px_rgba(0,0,0,0.5)]",
        width === undefined ? "inset-x-[12%]" : "left-1/2 -translate-x-1/2",
        hidden ? "hidden" : "open flex",
        className
      )}
      style={width === undefined ? undefined : { width }}
    >
      {children}
    </div>
  );
}
