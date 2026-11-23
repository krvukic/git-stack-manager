/**
 * The shell the config and help drawers share.
 *
 * Both drop from the top bar over the tree rather than taking a column: each is
 * consulted briefly and dismissed, and stealing width would reflow the graph the reader is
 * trying to compare against. Only one is open at a time — they share the same strip of
 * screen, so opening the second on top of the first would bury it, which is what
 * `DrawerName` is for.
 */
import { classes } from "../classes";
import { Button } from "./Button";
import { FieldLabel } from "./Field";

export const DRAWERS = ["config", "help"] as const;
export type DrawerName = (typeof DRAWERS)[number];

export function Drawer({
  name,
  title,
  isOpen,
  onClose,
  children,
}: {
  name: DrawerName;
  title: string;
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    /*
      Two thirds of the height rather than a half: the legend covers six groups, and a shorter
      drawer hid the review glyphs below its own fold — the rows a reader opened it for. It
      scrolls internally, so the tree always keeps the remaining third.
    */
    <div
      id={name}
      className={classes(
        "max-h-[66%] flex-none overflow-y-auto border-b border-b-edge bg-card px-4 py-3",
        isOpen ? "open block" : "hidden"
      )}
    >
      {/* Floated rather than positioned, so the heading beside it keeps the full width and a
          long one wraps under the button instead of behind it. */}
      <Button
        size="small"
        className="float-right"
        id={`btn-${name}-close`}
        onClick={onClose}
      >
        Close
      </Button>
      <FieldLabel as="h3" heading className="mb-2 font-semibold">
        {title}
      </FieldLabel>
      {children}
    </div>
  );
}
