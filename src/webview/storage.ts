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
 * `model/config.mts` validates a stored config, and `model/sidebarWidth.mts`,
 * `model/changesWidth.mts` and `model/messageHeight.mts` own their bounds.
 *
 * Every measurement is stored on its own key rather than inside the config object. The config
 * is edited in a drawer and written once per choice; these are dragged, so a single write
 * would rewrite the whole config blob on the release of every drag. The keys are also what a
 * reader clearing one stuck value can reach without losing the rest.
 */
import { CHANGES_WIDTH_KEY } from "./model/changesWidth.mjs";
import {
  CONFIG_DEFAULTS,
  CONFIG_KEY,
  parseConfig,
  type Config,
} from "./model/config.mjs";
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

export function loadConfig(): Config {
  try {
    return parseConfig(JSON.parse(readStored(CONFIG_KEY) || "{}"));
  } catch {
    // Malformed JSON, which a hand-edited value can be: the defaults apply.
    return { ...CONFIG_DEFAULTS };
  }
}

export function saveConfig(config: Config): void {
  writeStored(CONFIG_KEY, JSON.stringify(config));
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

const ASKED_MERGED_BRANCHES_KEY = "gsm.askedMergedBranches";

/**
 * Enough for every branch a reader merges between two visits, and small enough that the list
 * never needs pruning by age.
 */
const ASKED_MERGED_BRANCHES_LIMIT = 200;

/** Each entry is `name@sha`, so a branch that later moves to another merged commit is new. */
export function readStoredAskedMergedBranches(): Set<string> {
  try {
    const stored: unknown = JSON.parse(
      readStored(ASKED_MERGED_BRANCHES_KEY) || "[]"
    );
    return new Set(
      Array.isArray(stored)
        ? stored.filter(entry => typeof entry === "string")
        : []
    );
  } catch {
    return new Set();
  }
}

/** Keeps the newest entries, since a Set iterates in insertion order. */
export function storeAskedMergedBranches(asked: Set<string>): void {
  writeStored(
    ASKED_MERGED_BRANCHES_KEY,
    JSON.stringify([...asked].slice(-ASKED_MERGED_BRANCHES_LIMIT))
  );
}
