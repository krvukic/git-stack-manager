/**
 * The Help drawer: the legend and the keyboard shortcuts.
 *
 * One drawer for both, because both are references a reader consults and dismisses, and one
 * button for them keeps the top bar short. The two are side by side where the drawer is wide
 * enough, so neither is below the other's fold, and stacked where it is not.
 */
import { classes } from "../classes";
import { Drawer } from "./Drawer";
import { Legend } from "./Legend";
import { Shortcuts } from "./Shortcuts";

/**
 * One of the drawer's two halves, under its own heading.
 *
 * `share` sets how the halves divide the width. Without a basis to shrink from, the legend's
 * longest sentence claims the whole row and the shortcuts wrap below it.
 */
function HelpSection({
  heading,
  share,
  children,
}: {
  heading: string;
  share: "wide" | "narrow";
  children: React.ReactNode;
}) {
  return (
    <section
      className={classes(
        "min-w-0",
        share === "wide" ? "flex-[2_1_32rem]" : "flex-[1_1_22rem]"
      )}
    >
      <h3 className="mb-2 text-title font-semibold">{heading}</h3>
      {children}
    </section>
  );
}

export function HelpDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer name="help" title="Help" isOpen={isOpen} onClose={onClose}>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-2">
        <HelpSection heading="Legend" share="wide">
          <Legend />
        </HelpSection>
        <HelpSection heading="Keyboard shortcuts" share="narrow">
          <Shortcuts />
        </HelpSection>
      </div>
    </Drawer>
  );
}
