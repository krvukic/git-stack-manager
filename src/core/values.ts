/**
 * values — the helpers with no dependencies of their own, below every other layer.
 *
 * Two kinds live here. Narrowers describe values whose shape the type system cannot see: JSON
 * decoded from `gh` output or from an action payload, and whatever a `catch` binds. One list
 * normaliser puts a set of branch names into a canonical form. Both kinds are wanted at
 * several layers — `#github` parses JSON, `#history` and `#ui` describe thrown values, and
 * `#app` and `#history` both report the branches a rebase moved — so they sit at the bottom
 * rather than being imported sideways or upward.
 */

/** Narrow an unknown JSON value to an object, or null when it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Narrow an unknown JSON value to an array, treating anything else as empty. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The message from a thrown value of unknown type.
 *
 * `catch` binds `unknown` under `useUnknownInCatchVariables`, and the thrown value is not
 * always an `Error` — a rejected `execFile` promise or a stray `throw "string"` both reach
 * here.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Deduplicate and sort, so a report of what moved reads the same however it was gathered. */
export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
