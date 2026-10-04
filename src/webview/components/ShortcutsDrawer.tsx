/**
 * The Keyboard shortcuts drawer. `model/shortcuts.mjs` carries the table, and
 * `ShortcutsDrawer` draws it.
 */
import { SHORTCUTS } from "../model/shortcuts.mjs";
import { Drawer } from "./Drawer";
import { TableSection } from "./TableSection";

export function ShortcutsDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      name="keys"
      title="Keyboard shortcuts"
      isOpen={isOpen}
      onClose={onClose}
    >
      <div id="keys-body">
        {SHORTCUTS.map(group => (
          // Wider cells than the legend's: a row of key caps needs more air between the caps
          // and the sentence than a single badge does.
          <TableSection
            heading={group.heading}
            cellGap="[&_td]:pr-3"
            key={group.heading}
          >
            {(group.rows ?? group.keys).map(shortcut => (
              <tr key={shortcut.what}>
                <td className="whitespace-nowrap">
                  {/*
                    Joined by a space, because two key caps with nothing between them touch:
                    `↑ k` reads as alternatives, `↑k` as a chord.
                  */}
                  {shortcut.keys.map((key, index) => (
                    <span key={key}>
                      {index > 0 ? " " : null}
                      <kbd className="inline-block min-w-5 rounded-sm border border-b-2 border-edge bg-input px-1.5 py-px text-center font-[monospace] text-meta/key text-fg">
                        {key}
                      </kbd>
                    </span>
                  ))}
                </td>
                <td className="text-body">{shortcut.what}</td>
              </tr>
            ))}
          </TableSection>
        ))}
        {/*
          Typing into the message editor must never trigger these, which is the one rule that is
          easier to state than to see in the table. A max width because this is a paragraph: a
          line running the drawer's full width is hard to track back to its start.
        */}
        <div className="max-w-160 text-meta text-muted">
          Keys are ignored while a text field has focus, so the message editor
          and the commit form work normally. Navigation skips the trunk tip,
          bases, and hidden-commit rows, since only commits have actions.
        </div>
      </div>
    </Drawer>
  );
}
