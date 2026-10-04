/**
 * The Legend drawer: every pill and badge the tree can draw, and what each one means.
 *
 * The components that draw the tree build each sample, from a real branch detail, so a badge
 * whose colour, glyph, or wording changes cannot go on being explained the old way here. The
 * character cap clips nothing here either: `graph.css` scopes it to `.row`, and a legend that
 * abbreviated its own examples would explain less than it shows.
 */
import type { UIBranch } from "#ui/renderModel";
import { trunkBehindBadge } from "../model/badges.mjs";
import { legendGroups, type LegendRow } from "../model/legend.mjs";
import { Drawer } from "./Drawer";
import { Badge, BranchPills, Pill } from "./Pills";
import { TableSection } from "./TableSection";

/**
 * One row's sample, drawn by whichever component owns it in the tree.
 *
 * Trunk's behind badge is built here rather than in `legend.mts`, which the unit suite
 * loads as source: node strips its types instead of compiling it, and a value import of a
 * sibling `.mts` module does not resolve under that. The legend carries the arguments; the
 * badge itself comes from the same function the trunk row calls.
 */
function LegendSample({
  row,
  onOpenUrl,
}: {
  row: LegendRow;
  onOpenUrl: (url: string) => void;
}) {
  if (row.pill) {
    return <Pill label={row.pill.label} variant={row.pill.variant} />;
  }
  if (row.trunkBehind) {
    const { branch, behind, trunkRef, isCheckedOut } = row.trunkBehind;
    const badge = trunkBehindBadge(branch, behind, trunkRef, isCheckedOut);
    return badge ? <Badge {...badge} /> : null;
  }
  return <BranchPills branch={row.branch as UIBranch} onOpenUrl={onOpenUrl} />;
}

/**
 * The samples carry real pull request badges, which are clickable in the tree. Here they
 * have no URL, so `onOpenUrl` is a no-op — left unwired on purpose rather than opening
 * nothing.
 */
export function LegendDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const noop = () => {};
  return (
    <Drawer name="legend" title="Legend" isOpen={isOpen} onClose={onClose}>
      <div id="legend-body">
        {legendGroups().map(group => (
          <TableSection
            heading={group.heading}
            cellGap="[&_td]:pr-2"
            key={group.heading}
          >
            {group.rows.map(row => (
              <tr key={row.what}>
                <td className="whitespace-nowrap">
                  <LegendSample row={row} onOpenUrl={noop} />
                </td>
                <td className="text-body">{row.what}</td>
                <td className="text-meta text-muted">{row.why}</td>
              </tr>
            ))}
          </TableSection>
        ))}
      </div>
    </Drawer>
  );
}
