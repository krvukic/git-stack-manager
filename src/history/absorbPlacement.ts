/**
 * absorbPlacement — decide which commit each working-copy hunk belongs to.
 *
 * Pure functions over arrays: no git, no I/O, so the whole decision table is unit
 * testable.
 *
 * ## Upstream
 *
 * The four-case decision this module implements is Sapling's `_analysediffchunk`,
 * which Mercurial ships as `hgext/absorb.py`. No code was copied — Sapling is
 * GPL-2.0 and this project is MIT, so the behaviour was reimplemented from the
 * published algorithm in a different language over a different data structure.
 * The upstream sources, for anyone comparing:
 *
 * - Decision logic (`_analysediffchunk`, `_iscontinuous`, `_optimizefixups`):
 *   https://github.com/facebook/sapling/blob/main/eden/scm/sapling/ext/absorb/__init__.py
 * - The same algorithm in TypeScript, closest to this file:
 *   https://github.com/facebook/sapling/blob/main/addons/isl/src/stackEdit/absorb.ts
 * - The behavioural specification, ported as `test/absorb-placement.test.mjs`:
 *   https://github.com/facebook/sapling/blob/main/eden/scm/tests/test-absorb-filefixupstate.py
 * - Why the linelog structure exists, if the gap check needs revisiting:
 *   https://www.mercurial-scm.org/repo/hg/raw-file/tip/mercurial/helptext/internals/linelog.txt
 *
 * **Keeping in sync:** upstream is stable — the decision cases have not changed
 * since the extension landed in Mercurial 4.8 (2018) — so there is no need to
 * track it routinely. Re-read it when a placement looks wrong, or when adding a
 * capability upstream already has (rename following is the notable gap; see
 * `getfilestack`). If the ported test table still passes after such a change, the
 * behaviour still matches.
 *
 * ## The owner array, and why not `git blame`
 *
 * Absorb proper builds a *linelog* — an interleaved delta — from one file's
 * revisions across the stack, then edits that same structure to produce the
 * rewritten contents. This port keeps the part that matters and drops the
 * bytecode: replay the stack into an array of cells, one per line, each recording
 * the commit that introduced it and the commit that deleted it. Lines deleted
 * mid-stack are NOT dropped — they stay in the array, marked dead from that
 * commit on.
 *
 * Keeping them is the whole reason this is not `git blame`. Given a base of
 * `x 1 1 2 2 3 3` and a later commit deleting the two `2` lines, blame reports
 * the surviving `1` and `3` lines as adjacent with a single owner — the deletion
 * between them is invisible. A blame-based tool will happily absorb a hunk
 * spanning that seam, which resurrects or misplaces the deleted lines on the way
 * back through the stack. Absorb refuses, via `_iscontinuous`; here that check is
 * `hasGapBetween`, answered from the dead cells. Retaining them also lets an
 * ancestor be rebuilt with the lines it originally had.
 *
 * ## Owner numbering
 *
 * Owner 0 is the immutable base — the commit below the stack. Absorb encodes
 * this as "linelog rev 1" and guards every case with `rev > 1`; the equivalent
 * here is `owner > 0`. A hunk that resolves to owner 0 is dropped, because
 * rewriting a commit that is already published is not this tool's business.
 *
 * ## What happens to a hunk that cannot be placed
 *
 * Nothing. It stays in the working copy and is reported in the tally. That is
 * absorb's contract, and it is what makes the command safely re-runnable.
 */

/**
 * One line of the file, with the span of stack commits that contained it.
 *
 * A line lives from the commit that introduced it (`owner`) until the commit that
 * deleted it (`deletedBy`, exclusive). Keeping deleted lines instead of dropping
 * them is what lets a rewritten ancestor get its original content back, and what
 * makes mid-stack deletions visible to `hasGapBetween`.
 */
export type Cell = {
  owner: number;
  /** Stack index of the commit that removed this line; null if it survives. */
  deletedBy: number | null;
  text: string;
};

export type OwnerMap = {
  /** Every line the stack ever held, in tip order, including deleted ones. */
  cells: Cell[];
  /** Indices into `cells` that are present at the tip, ascending. */
  visible: number[];
};

/** Whether a cell is part of `commit`'s content. */
function livesAt(cell: Cell, commit: number): boolean {
  return (
    cell.owner <= commit && (cell.deletedBy === null || commit < cell.deletedBy)
  );
}

/** A unified-diff hunk: replace visible lines [oldStart, oldEnd) with newLines. */
export type Hunk = {
  oldStart: number;
  oldEnd: number;
  newLines: string[];
};

/** One resolved placement: replace [oldStart, oldEnd) in `owner` with `newLines`. */
export type Fixup = {
  owner: number;
  oldStart: number;
  oldEnd: number;
  newLines: string[];
};

export type AnalysisResult = {
  fixups: Fixup[];
  /** Hunks that could not be attributed, with the reason, for the tally. */
  rejected: Array<{ hunk: Hunk; reason: string }>;
};

/**
 * Replay a file's stack revisions into cells plus tombstones.
 *
 * `revisions[0]` is the base content (owner 0); each later entry is the file at
 * that stack commit, and its owner is its 1-based index. `diffLines` supplies the
 * hunks between consecutive revisions.
 */
export function buildOwnerMap(
  revisions: string[][],
  diffLines: (before: string[], after: string[]) => Hunk[]
): OwnerMap {
  const cells: Cell[] = (revisions[0] ?? []).map(text => ({
    owner: 0,
    deletedBy: null,
    text,
  }));

  for (let commit = 1; commit < revisions.length; commit++) {
    // Diff against what this commit's parent actually showed, so hunk indices are
    // positions in the visible file rather than in the full history.
    const visible = cells.filter(cell => livesAt(cell, commit - 1));
    const hunks = [
      ...diffLines(
        visible.map(cell => cell.text),
        revisions[commit] ?? []
      ),
    ].sort((a, b) => b.oldStart - a.oldStart);
    for (const hunk of hunks) {
      // Mark the covered lines dead from this commit on; they stay in the array
      // so earlier commits can still be rebuilt with them.
      for (const cell of visible.slice(hunk.oldStart, hunk.oldEnd)) {
        cell.deletedBy = commit;
      }
      // Insert the new lines just before the first surviving line after the hunk,
      // keeping the array in tip order.
      const anchor = visible[hunk.oldEnd];
      const insertAt = anchor ? cells.indexOf(anchor) : cells.length;
      cells.splice(
        insertAt,
        0,
        ...hunk.newLines.map(text => ({ owner: commit, deletedBy: null, text }))
      );
    }
  }
  const tip = revisions.length - 1;
  const visible: number[] = [];
  cells.forEach((cell, index) => {
    if (livesAt(cell, tip)) {
      visible.push(index);
    }
  });
  return { cells, visible };
}

/**
 * Whether a line was deleted somewhere strictly inside `[start, end)`.
 *
 * This is `_iscontinuous` inverted. Absorbing across a seam where the stack
 * deleted something can resurrect it, so case 1 declines when this is true.
 */
export function hasGapBetween(
  map: OwnerMap,
  start: number,
  end: number
): boolean {
  if (end <= start) {
    return false;
  }
  const from = map.visible[start];
  const to = map.visible[end];
  if (from === undefined || to === undefined) {
    return false;
  }
  // Counting rather than walking the cells between the two. `visible` is ascending, so it
  // advances by one position per visible line and the cell indices advance by one per line
  // the stack ever held: they can only disagree by a line that is no longer visible, which
  // is a mid-stack deletion. Every caller asks this per hunk or per merge candidate, so the
  // walk it replaces made placement quadratic in the file's length.
  return to - from > end - start;
}

/**
 * Attribute one hunk, following absorb's four cases in priority order.
 *
 * Returns an empty list when the hunk cannot be placed; the caller reports it and
 * leaves the change in the working copy.
 */
export function analyseHunk(map: OwnerMap, hunk: Hunk): Fixup[] {
  const { oldStart, oldEnd, newLines } = hunk;
  // Hunk coordinates index the tip file, so resolve them through `visible` to
  // reach the cells (which also hold lines the tip no longer shows).
  // `visible` holds in-bounds indices into `cells` by construction, so the absent
  // cases below are unreachable. Owner 0 is the base, whose lines abstain from every
  // vote and are declined outright, so it doubles as the "no cell" answer.
  const ownerAtTip = (tipIndex: number): number => {
    const index = map.visible[tipIndex];
    return index === undefined ? 0 : (map.cells[index]?.owner ?? 0);
  };
  const covered = map.visible
    .slice(oldStart, oldEnd)
    .flatMap(index => map.cells[index] ?? []);

  // Case 2 — pure insertion. Only the immediately neighbouring lines vote, and
  // base-owned lines abstain. Absorb looks at exactly one line each side.
  if (oldStart === oldEnd) {
    const neighbours = [oldStart - 1, oldEnd]
      .filter(index => index >= 0 && index < map.visible.length)
      .map(ownerAtTip)
      .filter(owner => owner > 0);
    const [only, ...rest] = new Set(neighbours);
    // Ambiguous (the two sides disagree) or entirely against base lines: decline.
    if (only === undefined || rest.length) {
      return [];
    }
    return [{ owner: only, oldStart, oldEnd, newLines }];
  }

  const [soleOwner, ...otherOwners] = new Set(covered.map(cell => cell.owner));
  const oneOwner = soleOwner !== undefined && !otherOwners.length;
  const sameSize = oldEnd - oldStart === newLines.length;
  // A deletion inside the range means the covered lines are not contiguous in the
  // stack's history, even though they look adjacent at the tip.
  const spansGap = hasGapBetween(map, oldStart, oldEnd - 1);

  // Base-owned lines are off limits: rewriting a published commit is not this
  // tool's business.
  if (oneOwner && soleOwner === 0) {
    return [];
  }

  if (oneOwner) {
    // Case 1 — one owner and no gap: the hunk moves as a single run.
    if (!spansGap) {
      return [{ owner: soleOwner, oldStart, oldEnd, newLines }];
    }
    // With a gap, a multi-line run would be emitted before lines the earlier
    // commits still hold, reordering their content. An equal-size hunk instead
    // falls through to the per-line split below, which keeps each replacement
    // beside the line it replaces; anything else is declined.
    if (!sameSize) {
      return [];
    }
  }

  // Case 4 — pure deletion. Split per line so each owner loses its own lines;
  // unlike case 3 there is no line-count constraint.
  if (newLines.length === 0) {
    return coalesce(
      map,
      covered
        .map((cell, offset) => ({ cell, index: oldStart + offset }))
        .filter(({ cell }) => cell.owner > 0)
        .map(({ cell, index }) => ({
          owner: cell.owner,
          oldStart: index,
          oldEnd: index + 1,
          newLines: [] as string[],
        }))
    );
  }

  // Case 3 — equal line counts, so assume a 1:1 mapping and send each line to
  // its own owner. Absorb's own comment concedes this "could be wrong"; it is
  // the pragmatic choice that makes same-size edits across a stack work.
  if (oldEnd - oldStart === newLines.length) {
    return coalesce(
      map,
      covered
        .map((cell, offset) => ({ cell, offset }))
        .filter(({ cell }) => cell.owner > 0)
        .map(({ cell, offset }) => ({
          owner: cell.owner,
          oldStart: oldStart + offset,
          oldEnd: oldStart + offset + 1,
          // `covered` and `newLines` are the same length in this branch, which is
          // what case 3 tests for, so the offset is always in range.
          newLines: [newLines[offset] ?? ""],
        }))
    );
  }

  return [];
}

/**
 * Merge per-line fixups into runs that share an owner and sit next to each other,
 * so the applied result and the reported count match what a person would call one
 * change. Mirrors absorb's `_optimizefixups`.
 *
 * Merging is refused across a gap. Two per-line fixups either side of a mid-stack
 * deletion look adjacent, but joining them recreates exactly the block that the
 * split was there to avoid, and the deleted line would end up on the wrong side of
 * the replacement.
 */
function coalesce(map: OwnerMap, fixups: Fixup[]): Fixup[] {
  const merged: Fixup[] = [];
  for (const fixup of fixups) {
    const previous = merged.at(-1);
    const adjacent =
      previous &&
      previous.owner === fixup.owner &&
      previous.oldEnd === fixup.oldStart;
    if (adjacent && !hasGapBetween(map, previous.oldEnd - 1, fixup.oldStart)) {
      previous.oldEnd = fixup.oldEnd;
      previous.newLines = [...previous.newLines, ...fixup.newLines];
      continue;
    }
    merged.push({ ...fixup, newLines: [...fixup.newLines] });
  }
  return merged;
}

/** Attribute every hunk, collecting the ones that could not be placed. */
export function analyse(map: OwnerMap, hunks: Hunk[]): AnalysisResult {
  const fixups: Fixup[] = [];
  const rejected: AnalysisResult["rejected"] = [];
  for (const hunk of hunks) {
    const resolved = analyseHunk(map, hunk);
    if (resolved.length) {
      fixups.push(...resolved);
    } else {
      rejected.push({ hunk, reason: describeRejection(map, hunk) });
    }
  }
  return { fixups, rejected };
}

/** Explain a declined hunk in the terms the user can act on. */
function describeRejection(map: OwnerMap, hunk: Hunk): string {
  const covered = map.cells.slice(hunk.oldStart, hunk.oldEnd);
  const owners = [...new Set(covered.map(cell => cell.owner))];
  if (hunk.oldStart === hunk.oldEnd) {
    return "new lines are not adjacent to exactly one commit's lines";
  }
  if (owners.length === 1 && owners[0] === 0) {
    return "the lines belong to a commit that is already on trunk";
  }
  if (owners.length === 1) {
    return "a commit deleted lines inside this range, so absorbing could resurrect them";
  }
  return "the change spans several commits' lines and is not a 1:1 replacement";
}

/**
 * Materialise each stack commit's new content.
 *
 * A commit sees a fixup once its own index is reached, and every line the stack
 * had introduced by then. That reproduces absorb's odd/even linelog revisions —
 * where writing at a fixup revision automatically shows up in all descendants —
 * without implementing the bytecode.
 */
export function applyFixups(
  map: OwnerMap,
  fixups: Fixup[],
  stackSize: number
): string[][] {
  // Attach each fixup to the cells it covers. A cell carries the fixup's target
  // commit and, on the first covered cell, the replacement text. Rebuilding a
  // commit is then a single left-to-right pass with no index arithmetic.
  const replacementAt = new Map<
    number,
    { owner: number; newLines: string[] }
  >();
  const suppressedBy = new Map<number, number>();

  for (const fixup of fixups) {
    const coveredCells = map.visible.slice(fixup.oldStart, fixup.oldEnd);
    // An insertion covers nothing, so it anchors on the cell it precedes; at end
    // of file that is one past the last cell.
    const anchor =
      coveredCells[0] ?? map.visible[fixup.oldStart] ?? map.cells.length;
    replacementAt.set(anchor, { owner: fixup.owner, newLines: fixup.newLines });
    // From the target commit on, the covered lines give way to the replacement.
    for (const cellIndex of coveredCells) {
      suppressedBy.set(cellIndex, fixup.owner);
    }
  }

  const contents: string[][] = [];
  for (let commit = 0; commit <= stackSize; commit++) {
    const lines: string[] = [];
    for (let index = 0; index <= map.cells.length; index++) {
      const replacement = replacementAt.get(index);
      if (replacement && commit >= replacement.owner) {
        lines.push(...replacement.newLines);
      }
      const cell = map.cells[index];
      if (!cell || !livesAt(cell, commit)) {
        continue;
      }
      const suppressed = suppressedBy.get(index);
      if (suppressed !== undefined && commit >= suppressed) {
        continue;
      }
      lines.push(cell.text);
    }
    contents.push(lines);
  }
  return contents;
}
