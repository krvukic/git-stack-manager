/**
 * A headed table of rows: the legend's badge explanations and the shortcuts' key caps.
 *
 * A table rather than a flex grid because the columns must line up down the whole group — the
 * reader scans the sentences, not the samples beside them. The gap after each cell is the one
 * thing the two callers disagree on, and each says why where it passes it.
 */
import { classes } from "../classes";
import { FieldLabel } from "./Field";

export function TableSection({
  heading,
  cellGap,
  children,
}: {
  heading: string;
  cellGap: "[&_td]:pr-2" | "[&_td]:pr-3";
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3.5">
      <FieldLabel as="h3" heading className="mb-2 font-semibold">
        {heading}
      </FieldLabel>
      <table
        className={classes(
          "border-collapse [&_td]:py-0.75 [&_td]:align-middle",
          cellGap
        )}
      >
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
