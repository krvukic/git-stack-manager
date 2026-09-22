/**
 * Which changed lines of an uncommitted file go into the next commit or amend.
 *
 * Sapling's model, as the host's `partialSelection` takes it: every line starts chosen, and a
 * choice records the lines left out. A file taken whole therefore has no choice at all, and a
 * choice that leaves out every line is the same as unticking the file. `useLineChoices` keeps
 * both of those collapsed, so a choice here always means "some lines".
 *
 * A line is named by its side and number — `-3` for old line 3 removed, `+5` for new line 5
 * added — because that is what the host checks against its own diff, and the text alone would
 * not tell two identical lines apart.
 */
import type { DiffHunk, DiffLine } from "#git/diff";
import type { FileChange } from "#git/snapshot";
import type { LineSelection } from "#history/partialSelection";

/** The lines left out of one partly chosen file. */
export type LineChoice = {
  /** The fingerprint of the diff the lines were chosen from. */
  fingerprint: string;
  excluded: ReadonlySet<string>;
  /** How many changed lines the file has, for a row that shows "12 of 20 lines". */
  total: number;
};

export type CheckState = "all" | "some" | "none";

/** A changed line's key, or null for a context line, which is never chosen. */
export function lineKey(line: DiffLine): string | null {
  if (line.kind === "del" && line.oldNumber !== null) {
    return `-${line.oldNumber}`;
  }
  if (line.kind === "add" && line.newNumber !== null) {
    return `+${line.newNumber}`;
  }
  return null;
}

/** Every changed line's key, in the order the diff draws them. */
export function changedLineKeys(hunks: DiffHunk[]): string[] {
  const keys: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const key = lineKey(line);
      if (key !== null) {
        keys.push(key);
      }
    }
  }
  return keys;
}

/** Whether all, some, or none of `keys` are chosen, given the lines left out. */
export function checkState(
  keys: string[],
  excluded: ReadonlySet<string>
): CheckState {
  let left = 0;
  for (const key of keys) {
    if (excluded.has(key)) {
      left++;
    }
  }
  return left === 0 ? "all" : left === keys.length ? "none" : "some";
}

/** The lines left out after choosing, or leaving out, every one of `keys`. */
export function withLines(
  excluded: ReadonlySet<string>,
  keys: string[],
  chosen: boolean
): Set<string> {
  const next = new Set(excluded);
  for (const key of keys) {
    if (chosen) {
      next.delete(key);
    } else {
      next.add(key);
    }
  }
  return next;
}

/**
 * The keys from `anchor` to `target` inclusive, in either direction, for a shift-click. Just
 * `target` when the anchor is not a line of this file, as after the diff was re-read.
 */
export function rangeBetween(
  keys: string[],
  anchor: string | null,
  target: string
): string[] {
  const end = keys.indexOf(target);
  const start = anchor === null ? -1 : keys.indexOf(anchor);
  if (end < 0) {
    return [];
  }
  if (start < 0) {
    return [target];
  }
  return keys.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** A choice as the host's `lines` payload names it. */
export function toLineSelection(
  path: string,
  choice: LineChoice
): LineSelection {
  const excludedRemovals: number[] = [];
  const excludedAdditions: number[] = [];
  for (const key of choice.excluded) {
    const number = Number(key.slice(1));
    if (key.startsWith("-")) {
      excludedRemovals.push(number);
    } else {
      excludedAdditions.push(number);
    }
  }
  return {
    path,
    fingerprint: choice.fingerprint,
    excludedRemovals,
    excludedAdditions,
  };
}

/**
 * The working-copy row a diff file belongs to. `git status` folds a directory of new files into
 * one `dir/` row, and the diff lists each file inside it, so a file can belong to a row with
 * another path. Null when no row covers it, which a list read before the diff can produce.
 */
export function rowPathFor(
  path: string,
  rowPaths: ReadonlySet<string>
): string | null {
  if (rowPaths.has(path)) {
    return path;
  }
  for (const row of rowPaths) {
    if (row.endsWith("/") && path.startsWith(row)) {
      return row;
    }
  }
  return null;
}

/**
 * Whether a row can never have its lines chosen, so it offers no way in. The overlay explains
 * every other refusal from the diff, which only it has read.
 */
export function goesInWhole(file: FileChange): boolean {
  return (
    file.path.endsWith("/") ||
    file.status === "D" ||
    file.status === "R" ||
    file.status === "C"
  );
}

/** How many of a file's changed lines are chosen, for the row that shows it. */
export function chosenLineCount(choice: LineChoice): number {
  return choice.total - choice.excluded.size;
}
