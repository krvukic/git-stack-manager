/**
 * actionPayload — read fields out of the untyped payloads the UI sends.
 *
 * Action payloads arrive as JSON from a webview or an HTTP request, so their
 * shape is genuinely unknown at the type level. Typing them `any` would hide
 * that and let a missing field propagate silently into git arguments; these
 * readers narrow instead, and say what was wrong when a required field is absent.
 *
 * Only the payload readers live here. The generic narrowers sit in `#core/values`, because
 * `#github` and `#history` want them too and neither should import from the UI layer.
 * `errorMessage` is re-exported for the controller suite, which reads it through this module.
 */
import { asRecord } from "#core/values";
import { LineSelection } from "#history/partialSelection";

export { errorMessage } from "#core/values";

/** A decoded JSON object, before any field has been checked. */
export type ActionPayload = Record<string, unknown>;

/**
 * One action request, as the webview posts it.
 *
 * This is what keeps the two ends of an untyped bridge agreeing on the envelope:
 * `webview/rpc.ts` builds it, and the extension host reads it. The reply travels
 * back as an `ActionResult` carrying the same `id`. The web host needs no envelope —
 * there the action is in the URL and the body is the payload alone.
 */
export type UIRequest = {
  /** Correlates a reply with the call still waiting for it. */
  id: number;
  action: string;
  payload: ActionPayload;
};

/** Coerce an unknown JSON value into a payload object, defaulting to empty. */
export function toActionPayload(value: unknown): ActionPayload {
  return asRecord(value) ?? {};
}

/** Read a required string field. */
export function requireString(payload: ActionPayload, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value) {
    // A plain Error: nothing distinguishes this from any other action failure at
    // the boundary, where every error becomes `{ok: false, error}` regardless.
    throw new Error(`Action is missing the "${field}" value.`);
  }
  return value;
}

/** Read an optional string field, treating an empty string as absent. */
export function optionalString(
  payload: ActionPayload,
  field: string
): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value ? value : undefined;
}

/** Read a boolean field, defaulting to false so an absent flag means "off". */
export function readFlag(payload: ActionPayload, field: string): boolean {
  return payload[field] === true;
}

/**
 * Read the lines left out of partly chosen files, defaulting to none.
 *
 * Strict where `readStringList` is lenient: skipping a malformed entry would commit that file
 * whole, so a lost exclusion reaches the commit instead of an error.
 */
export function readLineSelections(
  payload: ActionPayload,
  field: string
): LineSelection[] {
  const value = payload[field];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Action has a malformed "${field}" value.`);
  }
  return value.map(entry => {
    const record = asRecord(entry);
    const path = record?.["path"];
    const fingerprint = record?.["fingerprint"];
    const excludedRemovals = record?.["excludedRemovals"];
    const excludedAdditions = record?.["excludedAdditions"];
    if (
      typeof path !== "string" ||
      !path ||
      typeof fingerprint !== "string" ||
      !isLineNumberList(excludedRemovals) ||
      !isLineNumberList(excludedAdditions)
    ) {
      throw new Error(`Action has a malformed "${field}" entry.`);
    }
    return { path, fingerprint, excludedRemovals, excludedAdditions };
  });
}

function isLineNumberList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(number => Number.isInteger(number) && number > 0)
  );
}

/** Read an array-of-strings field, ignoring any non-string entries. */
export function readStringList(
  payload: ActionPayload,
  field: string
): string[] {
  const value = payload[field];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
