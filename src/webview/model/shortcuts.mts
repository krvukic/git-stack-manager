/**
 * Every key this view responds to, in one table.
 *
 * The keydown handler dispatches from this list rather than from a parallel `switch`, so
 * a key that works but goes unlisted — or a listed key that stopped working — cannot
 * happen. The inline version claimed that and did not do it: `SHORTCUTS` fed only the
 * drawer, and the handler was hand-written beside it. `action` is what closes the gap.
 *
 * Grouped the way a reader looks for them: moving about, then acting, then what is on
 * screen. `keys` holds every key that runs the action, including the display forms —
 * `↑` is what the drawer shows and `ArrowUp` is what the browser reports, so both are
 * listed and `keyEvents` filters to the ones a keyboard can actually produce.
 */

/** Named actions the handler implements. Adding one here forces a case there. */
export type ShortcutAction =
  | "selectAbove"
  | "selectBelow"
  | "gotoSelected"
  | "closeTopmost"
  | "absorb"
  | "undo"
  | "refresh"
  | "toggleLog"
  | "toggleShortcuts";

export type Shortcut = {
  /** Keys that trigger it. A display-only glyph is paired with its `event.key`. */
  keys: string[];
  /** Keys the browser reports, when they differ from what the drawer shows. */
  eventKeys?: string[];
  what: string;
  action: ShortcutAction;
};

export type ShortcutGroup = {
  heading: string;
  keys: Shortcut[];
};

export const SHORTCUTS: ShortcutGroup[] = [
  {
    heading: "Moving around the tree",
    keys: [
      {
        keys: ["↑", "k"],
        eventKeys: ["ArrowUp", "k"],
        what: "Select the commit above",
        action: "selectAbove",
      },
      {
        keys: ["↓", "j"],
        eventKeys: ["ArrowDown", "j"],
        what: "Select the commit below",
        action: "selectBelow",
      },
      {
        keys: ["Enter"],
        what: "Goto the selected commit — checks out its branch",
        action: "gotoSelected",
      },
      {
        keys: ["Escape"],
        what: "Close whatever is open: a diff, a panel, then the selection",
        action: "closeTopmost",
      },
    ],
  },
  {
    heading: "Acting on the repository",
    keys: [
      {
        keys: ["a"],
        what: "Absorb the working-copy changes into the commits owning those lines",
        action: "absorb",
      },
      {
        keys: ["u"],
        what: "Undo the last history edit, restoring the refs it moved",
        action: "undo",
      },
      {
        keys: ["r"],
        what: "Refresh the repository — re-read branches, commits, working copy",
        action: "refresh",
      },
    ],
  },
  {
    heading: "Changing the view",
    keys: [
      {
        keys: ["l"],
        what: "Show or hide the command log",
        action: "toggleLog",
      },
      {
        keys: ["?"],
        what: "Show or hide this list",
        action: "toggleShortcuts",
      },
    ],
  },
  {
    /**
     * Listed but not dispatched here: the separator owns these while it holds focus, so
     * they never reach the document handler. They are in the table because a reader
     * looking for "how do I resize the panel" looks in the shortcuts drawer.
     */
    heading: "Resizing the commit panel",
    keys: [],
  },
];

/** Rows the drawer shows for the panel-resize group, which has no dispatched action. */
export const SPLITTER_KEYS: { keys: string[]; what: string }[] = [
  { keys: ["Tab"], what: "Focus the divider between the tree and the panel" },
  {
    keys: ["←", "→"],
    what: "Nudge the divider 16 pixels, while it holds focus",
  },
  {
    keys: ["Home"],
    what: "Restore the panel's default width, while the divider holds focus",
  },
];

/**
 * `event.key` to action, built from the table above.
 *
 * One map rather than a `switch`, so the handler cannot answer a key the drawer does not
 * list. `eventKeys` wins where a row has one, since a display glyph like `↑` is never
 * what the browser reports.
 */
export function shortcutActionsByKey(): Map<string, ShortcutAction> {
  const byKey = new Map<string, ShortcutAction>();
  for (const group of SHORTCUTS) {
    for (const shortcut of group.keys) {
      for (const key of shortcut.eventKeys ?? shortcut.keys) {
        byKey.set(key, shortcut.action);
      }
    }
  }
  return byKey;
}
