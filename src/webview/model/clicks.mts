/**
 * Which click asks for a tab that does not steal focus, and what to call that key.
 *
 * The accelerator differs by platform for a reason the key names hide: macOS defines
 * Control-click as the secondary click, so a rule accepting both modifiers everywhere would
 * turn a right-click into an open. Command carries the accelerator there, Control carries it
 * on Linux and Windows, and that is the same split VS Code's own keybindings use.
 *
 * The user agent arrives as an argument rather than being read here, so the rule is testable
 * without a browser and the webview keeps the one `navigator` read at its edge.
 */

/** A mouse event's modifier flags, which is all these need from the event. */
export type ClickModifiers = {
  metaKey: boolean;
  ctrlKey: boolean;
};

function onMac(userAgent: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(userAgent);
}

/** True when the click asked for a background tab: Command on a Mac, Control elsewhere. */
export function opensInBackground(
  event: ClickModifiers,
  userAgent: string
): boolean {
  return onMac(userAgent) ? event.metaKey : event.ctrlKey;
}

/** The modifier's name for a tooltip, in the form the reader's own keyboard prints. */
export function backgroundModifierName(userAgent: string): string {
  return onMac(userAgent) ? "⌘" : "Ctrl";
}
