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
 * the whole substance of all of them. What each value *means* stays with its own module:
 * `model/design.mts` validates a stored design, and `model/sidebarWidth.mts`,
 * `model/changesWidth.mts` and `model/messageHeight.mts` own their bounds.
 *
 * Every measurement is stored on its own key rather than inside the design object. The design
 * is edited in a drawer and written once per choice; these are dragged, so a single write
 * would rewrite the whole design blob on the release of every drag. The keys are also what a
 * reader clearing one stuck value can reach without losing the rest.
 */
import { CHANGES_WIDTH_KEY } from "./model/changesWidth.mjs";
import {
  DESIGN_DEFAULTS,
  DESIGN_KEY,
  parseDesign,
  type Design,
} from "./model/design.mjs";
import { SIDEBAR_WIDTH_KEY } from "./model/sidebarWidth.mjs";

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

/**
 * A stored measurement, or null where storage holds nothing usable — which covers an absent
 * key, a hand-edited one, and anything another version wrote.
 *
 * Null rather than a default, because one caller's default needs the window: the changes
 * overlay opens at a share of it. Each caller names its own fallback instead.
 */
function readStoredPixels(key: string): number | null {
  const stored = Number(readStored(key));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

export function readStoredSidebarWidth(): number | null {
  return readStoredPixels(SIDEBAR_WIDTH_KEY);
}

export function storeSidebarWidth(width: number): void {
  writeStored(SIDEBAR_WIDTH_KEY, String(width));
}

export function readStoredChangesWidth(): number | null {
  return readStoredPixels(CHANGES_WIDTH_KEY);
}

export function storeChangesWidth(width: number): void {
  writeStored(CHANGES_WIDTH_KEY, String(width));
}

/** Keyed by the box, since each message box carries its own height. */
export function readStoredMessageHeight(key: string): number | null {
  return readStoredPixels(key);
}

export function storeMessageHeight(key: string, height: number): void {
  writeStored(key, String(height));
}

export function readStoredLogHidden(): boolean {
  return readStored(LOG_HIDDEN_KEY) === "true";
}

export function storeLogHidden(hidden: boolean): void {
  writeStored(LOG_HIDDEN_KEY, String(hidden));
}
