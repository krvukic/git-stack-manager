/**
 * amendPlacement — decide whether a change can be amended into a commit below the ones that
 * followed it, and where it lands in each of them.
 *
 * Pure functions over the owner map `absorbPlacement` builds, with the target as owner 0. Absorb
 * asks which commit owns each changed line and sends the change there. An amend has already been
 * told the commit, so the question inverts: can the change be made in the target without
 * rewriting anything a later commit wrote? It can when it replaces only the target's own lines,
 * and no later commit inserted or deleted a line inside it. Anything else is refused, naming the
 * later commit, because amending into that one is usually what was meant.
 *
 * The refusal is the fix. Amend used to graft the whole working file into the target and skip any
 * descendant that had changed it. Given a target holding `feature` and a later commit adding
 * `later edit`, rewording that second line to `amended` put `feature amended` in the target, left
 * `feature later edit` in the later commit, and then checked HEAD out over the working file. The
 * edit ended up in the one commit where it did not belong, reverted by the next, and gone from
 * the working copy.
 */
import { Cell, Fixup, Hunk, OwnerMap } from "#history/absorbPlacement";

/**
 * Every hunk as a fixup the target owns, or the stack index of the later commit in the way.
 * Fixups carry owner 0, so `applyFixups` writes them into the target and every commit above it.
 */
export type Placement = { fixups: Fixup[] } | { blockedBy: number };

/**
 * Place hunks against the tip of `map` in its base commit, the target.
 *
 * A new line may sit next to a later commit's line, provided the target's own line is on its other
 * side: the target line anchors it, and the later line keeps its place above. With a later line on
 * both sides, the new line would land in the target between lines the target does not have.
 */
export function placeInTarget(map: OwnerMap, hunks: Hunk[]): Placement {
  const fixups: Fixup[] = [];
  for (const hunk of hunks) {
    const blockedBy =
      hunk.oldStart === hunk.oldEnd
        ? insertionBlocker(
            map,
            map.visible[hunk.oldStart - 1],
            map.visible[hunk.oldStart],
            true
          )
        : replacementBlocker(
            map,
            map.visible.slice(hunk.oldStart, hunk.oldEnd)
          );
    if (blockedBy !== null) {
      return { blockedBy };
    }
    fixups.push({ owner: 0, ...hunk });
  }
  return { fixups };
}

/**
 * Carry hunks against the base of `map` up to its tip, for a commit on another branch above the
 * target, whose parent was rewritten.
 *
 * Stricter than `placeInTarget` about new lines, since nothing says which side of the child's own
 * lines they belong on: the two base lines around one must still be neighbours in the child.
 */
export function carryOnto(map: OwnerMap, hunks: Hunk[]): Placement {
  const baseCells: number[] = [];
  const tipPosition = new Map<number, number>();
  map.cells.forEach((cell, index) => {
    if (cell.owner === 0) {
      baseCells.push(index);
    }
  });
  map.visible.forEach((cellIndex, position) =>
    tipPosition.set(cellIndex, position)
  );

  const fixups: Fixup[] = [];
  for (const { oldStart, oldEnd, newLines } of hunks) {
    const covered = baseCells.slice(oldStart, oldEnd);
    const right = baseCells[oldStart];
    const blockedBy = covered.length
      ? replacementBlocker(map, covered)
      : insertionBlocker(map, baseCells[oldStart - 1], right, false);
    if (blockedBy !== null) {
      return { blockedBy };
    }
    const tipStart =
      right === undefined ? map.visible.length : (tipPosition.get(right) ?? 0);
    fixups.push({
      owner: 0,
      oldStart: tipStart,
      oldEnd: tipStart + covered.length,
      newLines,
    });
  }
  return { fixups };
}

/**
 * The later commit keeping `cells` from being replaced in the target: the owner of a line it did
 * not write, whoever deleted one, or whoever put a line between two of them.
 */
function replacementBlocker(map: OwnerMap, cells: number[]): number | null {
  for (const [offset, index] of cells.entries()) {
    const cell = map.cells[index];
    if (cell && (cell.owner > 0 || cell.deletedBy !== null)) {
      return blockerOf(cell);
    }
    const previous = cells[offset - 1];
    if (previous !== undefined && index !== previous + 1) {
      return blockerAfter(map, previous);
    }
  }
  return null;
}

/**
 * The later commit keeping a new line from going between the cells `left` and `right`, either of
 * which is absent at an end of the file.
 *
 * Any line between them, even a deleted one, leaves the new line's place in the target ambiguous.
 * `laterNeighbour` allows one neighbour to be a later commit's line, which `placeInTarget` can
 * afford because it places against the tip, where the order is known.
 */
function insertionBlocker(
  map: OwnerMap,
  left: number | undefined,
  right: number | undefined,
  laterNeighbour: boolean
): number | null {
  const low = left ?? -1;
  if ((right ?? map.cells.length) - low > 1) {
    return blockerAfter(map, low);
  }
  const neighbours = [left, right].flatMap(index =>
    index === undefined ? [] : (map.cells[index] ?? [])
  );
  const later = neighbours.filter(
    cell => cell.owner > 0 || cell.deletedBy !== null
  );
  const [first] = later;
  if (!first) {
    return null;
  }
  return laterNeighbour && later.length < neighbours.length
    ? null
    : blockerOf(first);
}

function blockerAfter(map: OwnerMap, index: number): number {
  const cell = map.cells[index + 1];
  return cell ? blockerOf(cell) : 1;
}

/** The commit that wrote a later line, or deleted one of the target's. */
function blockerOf(cell: Cell): number {
  return cell.owner > 0 ? cell.owner : (cell.deletedBy ?? 1);
}
