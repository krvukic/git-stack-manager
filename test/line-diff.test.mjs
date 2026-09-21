/**
 * The line diff absorb and split are built on.
 *
 * Absorb attributes hunks and split selects them, so a wrong hunk boundary here
 * becomes a change folded into the wrong commit — a failure that is hard to trace
 * back. The invariant worth pinning is round-tripping: applying the hunks to
 * `before` must reproduce `after` exactly, whatever shape the edit takes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "#git/lineDiff";

/**
 * Apply hunks to `before`, back to front so earlier indices stay valid.
 *
 * @param {string[]} before
 * @param {import("#history/absorbPlacement").Hunk[]} hunks
 */
function applyHunks(before, hunks) {
  let lines = [...before];
  for (const hunk of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    lines = [
      ...lines.slice(0, hunk.oldStart),
      ...hunk.newLines,
      ...lines.slice(hunk.oldEnd),
    ];
  }
  return lines;
}

/**
 * Assert the hunks turn `before` into `after`, and report how many there were.
 *
 * @param {string[]} before
 * @param {string[]} after
 */
function roundTrip(before, after) {
  const hunks = diffLines(before, after);
  assert.deepEqual(
    applyHunks(before, hunks),
    after,
    `round trip failed for ${JSON.stringify(before)} -> ${JSON.stringify(after)}`
  );
  return hunks;
}

test("hunks always reproduce the target when applied", () => {
  const cases = [
    [[], []],
    [[], ["a"]],
    [["a"], []],
    [["a"], ["a"]],
    [["a"], ["b"]],
    [
      ["a", "b", "c"],
      ["a", "x", "c"],
    ],
    [
      ["a", "b", "c"],
      ["a", "c"],
    ],
    [
      ["a", "c"],
      ["a", "b", "c"],
    ],
    [
      ["a", "b", "c"],
      ["c", "b", "a"],
    ],
    [
      ["a", "b", "c", "d", "e"],
      ["a", "x", "y", "e"],
    ],
    // A repeated line is where a naive matcher picks the wrong pairing.
    [
      ["x", "x", "x"],
      ["x", "x"],
    ],
    [
      ["a", "a", "b", "a", "a"],
      ["a", "b", "a"],
    ],
  ];
  for (const [before, after] of cases) {
    roundTrip(before, after);
  }
});

test("an edit in the middle produces one hunk, not a whole-file replacement", () => {
  // The prefix/suffix trim is what keeps absorb attributing a small edit to one
  // commit; without it every change would span the file and be declined.
  const before = ["one", "two", "three", "four", "five"];
  const hunks = roundTrip(before, ["one", "two", "CHANGED", "four", "five"]);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldStart, 2);
  assert.equal(hunks[0].oldEnd, 3);
  assert.deepEqual(hunks[0].newLines, ["CHANGED"]);
});

test("edits at opposite ends stay separate hunks", () => {
  // Absorb relies on this: two unrelated edits must be attributable to two
  // different commits rather than merged into one span.
  const before = ["first", "middle", "last"];
  const hunks = roundTrip(before, ["FIRST", "middle", "LAST"]);
  assert.equal(hunks.length, 2);
  assert.ok(
    hunks[0].oldStart < hunks[1].oldStart,
    "hunks come out in ascending order"
  );
});

test("a pure insertion reports an empty range at the insertion point", () => {
  const hunks = roundTrip(["a", "b"], ["a", "new", "b"]);
  assert.equal(hunks.length, 1);
  // An empty range is how absorb recognises an insertion, which it attributes by
  // looking at the neighbouring lines rather than the covered ones.
  assert.equal(hunks[0].oldStart, hunks[0].oldEnd);
  assert.deepEqual(hunks[0].newLines, ["new"]);
});

test("a pure deletion reports no replacement lines", () => {
  const hunks = roundTrip(["a", "gone", "b"], ["a", "b"]);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].newLines, []);
  assert.equal(hunks[0].oldEnd - hunks[0].oldStart, 1);
});

test("identical input yields no hunks at all", () => {
  assert.deepEqual(diffLines(["a", "b", "c"], ["a", "b", "c"]), []);
  assert.deepEqual(diffLines([], []), []);
});

test("a large unmatched region degrades to one replacement instead of hanging", () => {
  // Beyond the cell budget the quadratic match is skipped. Reporting one big
  // replacement is the conservative outcome: absorb then treats it as a single
  // chunk and, spanning several owners, declines it.
  const before = Array.from({ length: 3000 }, (_, index) => `old-${index}`);
  const after = Array.from({ length: 3000 }, (_, index) => `new-${index}`);
  const hunks = roundTrip(before, after);
  assert.equal(hunks.length, 1);
});
