/**
 * What the webview remembers between loads, and the one guard every access needs.
 *
 * `localStorage` is the only store both hosts share. Reading it throws rather than answering
 * null when a sandbox forbids it — a webview can run with a null origin, and a browser in
 * private mode refuses outright — so nothing here touches it unguarded. Every value is a
 * convenience, so a refusal costs only persistence: the session honours the choice and the next
 * one starts from the default.
 *
 * The accessors sit together rather than beside the state each one feeds, because the guard is
 * the whole substance of all six. What each value *means* stays with its own module:
 * `model/design.mts` validates a stored design, `model/sidebarWidth.mts` owns the bounds.
 */
import {
  DESIGN_DEFAULTS,
  DESIGN_KEY,
  parseDesign,
  type Design,
} from "./model/design.mjs";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_KEY,
} from "./model/sidebarWidth.mjs";

export const LOG_HIDDEN_KEY = "gsm.commandLogHidden";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the value still applies for this session.
  }
}

export function loadDesign(): Design {
  try {
    return parseDesign(JSON.parse(readStored(DESIGN_KEY) || "{}"));
  } catch {
    // Malformed JSON, which a hand-edited value can be: the defaults apply.
    return { ...DESIGN_DEFAULTS };
  }
}

export function saveDesign(design: Design): void {
  writeStored(DESIGN_KEY, JSON.stringify(design));
}

/** The stored width, or the default when storage holds nothing usable. */
export function readStoredSidebarWidth(): number {
  const stored = Number(readStored(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : SIDEBAR_DEFAULT_WIDTH;
}

export function storeSidebarWidth(width: number): void {
  writeStored(SIDEBAR_WIDTH_KEY, String(width));
}

export function readStoredLogHidden(): boolean {
  return readStored(LOG_HIDDEN_KEY) === "true";
}

export function storeLogHidden(hidden: boolean): void {
  writeStored(LOG_HIDDEN_KEY, String(hidden));
}
