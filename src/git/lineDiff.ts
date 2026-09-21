/**
 * lineDiff — minimal line diff, used to replay a file's stack revisions.
 *
 * Absorb needs a diff per consecutive pair of revisions per changed file. Shelling
 * out to `git diff` for each pair is the dominant cost once a stack is more than a
 * few commits deep, so the diff happens here instead and blobs arrive in one
 * `cat-file --batch`.
 *
 * The algorithm is a longest-common-subsequence over lines, with two cheap
 * pre-passes that strip the common prefix and suffix. Real edits touch a small
 * part of a file, so the pre-passes usually reduce the quadratic core to almost
 * nothing. A histogram diff would produce prettier hunks on pathological input,
 * but absorb only cares which lines changed, not how elegantly they are grouped.
 */
import { Hunk } from "#history/absorbPlacement";

/** Guard against the quadratic core on very large unmatched regions. */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Hunks turning `before` into `after`, in ascending order of position, with
 * indices into `before`.
 */
export function diffLines(before: string[], after: string[]): Hunk[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  if (!oldMiddle.length && !newMiddle.length) {
    return [];
  }
  // Two reasons to report the whole middle as one replacement. One side empty is a pure
  // insertion or deletion, where there is nothing to match. Too many cells to match line by
  // line is the conservative answer instead — absorb then treats the middle as one chunk.
  if (
    !oldMiddle.length ||
    !newMiddle.length ||
    oldMiddle.length * newMiddle.length > MAX_LCS_CELLS
  ) {
    return [
      {
        oldStart: prefix,
        oldEnd: prefix + oldMiddle.length,
        newLines: newMiddle,
      },
    ];
  }

  return toHunks(
    matchLines(oldMiddle, newMiddle),
    prefix,
    oldMiddle,
    newMiddle
  );
}

/** Pairs of matching indices (into the trimmed middles), ascending. */
function matchLines(
  oldLines: string[],
  newLines: string[]
): Array<[number, number]> {
  const rows = oldLines.length;
  const columns = newLines.length;
  /**
   * `lengths[i * stride + j]` is the LCS length of `oldLines[i:]` and `newLines[j:]`.
   *
   * One flat `Int32Array` rather than an array of arrays: the core is quadratic and
   * bounded at `MAX_LCS_CELLS`, so it runs up to four million cells, and a nested array
   * costs a dereference per read and holds boxed numbers.
   *
   * The inner loop carries the neighbouring cells in locals, so it reads the array once
   * per cell instead of three times. Sweeping `j` downward makes the cell to the right
   * the value just computed, and the cell diagonally below it the previous iteration's
   * read — which is also why every `?? 0` here is unreachable: the indices are in bounds
   * by construction, and `noUncheckedIndexedAccess` cannot know that.
   */
  const stride = columns + 1;
  const lengths = new Int32Array((rows + 1) * stride);
  for (let i = rows - 1; i >= 0; i--) {
    const row = i * stride;
    const nextRow = row + stride;
    const oldLine = oldLines[i];
    let right = 0;
    let belowRight = 0;
    for (let j = columns - 1; j >= 0; j--) {
      const below = lengths[nextRow + j] ?? 0;
      const value =
        oldLine === newLines[j] ? belowRight + 1 : Math.max(below, right);
      lengths[row + j] = value;
      right = value;
      belowRight = below;
    }
  }
  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (oldLines[i] === newLines[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (
      (lengths[(i + 1) * stride + j] ?? 0) >= (lengths[i * stride + j + 1] ?? 0)
    ) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

/** Turn the gaps between matched lines into hunks. */
function toHunks(
  matches: Array<[number, number]>,
  offset: number,
  oldLines: string[],
  newLines: string[]
): Hunk[] {
  const hunks: Hunk[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  const flush = (oldUntil: number, newUntil: number) => {
    if (oldUntil === oldIndex && newUntil === newIndex) {
      return;
    }
    hunks.push({
      oldStart: offset + oldIndex,
      oldEnd: offset + oldUntil,
      newLines: newLines.slice(newIndex, newUntil),
    });
  };
  for (const [oldMatch, newMatch] of matches) {
    flush(oldMatch, newMatch);
    oldIndex = oldMatch + 1;
    newIndex = newMatch + 1;
  }
  flush(oldLines.length, newLines.length);
  return hunks;
}
