/**
 * The selection arithmetic behind the overlay's checkboxes: which lines a click leaves out, what a
 * hunk's box shows, and the payload the host checks the choice against.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedLineKeys,
  checkState,
  chosenLineCount,
  goesInWhole,
  rangeBetween,
  rowPathFor,
  toLineSelection,
  withLines,
} from "../src/webview/model/lineChoice.mts";

/** @typedef {import("#git/diff").DiffHunk} DiffHunk */
/** @typedef {import("#git/snapshot").FileChange} FileChange */

/** One hunk that replaces old line 2 with new lines 2 and 3, between two context lines. */
const HUNK = /** @type {DiffHunk} */ ({
  header: "@@ -1,3 +1,4 @@",
  lines: [
    { kind: "context", text: "a", oldNumber: 1, newNumber: 1 },
    { kind: "del", text: "b", oldNumber: 2, newNumber: null },
    { kind: "add", text: "B", oldNumber: null, newNumber: 2 },
    { kind: "add", text: "B2", oldNumber: null, newNumber: 3 },
    { kind: "context", text: "c", oldNumber: 3, newNumber: 4 },
  ],
});

test("only changed lines get keys, named by their side and number", () => {
  const keys = changedLineKeys([HUNK]);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, ["-2", "+2", "+3"]);
});

test("a box reads all, some, or none of the lines it covers", () => {
  const keys = ["-2", "+2", "+3"];
  assert.equal(checkState(keys, new Set()), "all");
  assert.equal(checkState(keys, new Set(["+2"])), "some");
  assert.equal(checkState(keys, new Set(keys)), "none");
});

test("choosing lines removes them from the left-out set, and leaving them out adds them", () => {
  const leftOut = withLines(new Set(["-2"]), ["+2", "+3"], false);
  assert.equal(leftOut.size, 3);
  const chosen = withLines(leftOut, ["-2", "+3"], true);
  assert.equal(chosen.size, 1);
  assert.deepEqual([...chosen], ["+2"]);
});

test("a shift-click range runs either way and includes both ends", () => {
  const keys = ["-2", "+2", "+3", "+7"];
  assert.deepEqual(rangeBetween(keys, "+2", "+7"), ["+2", "+3", "+7"]);
  assert.deepEqual(rangeBetween(keys, "+7", "-2"), keys);
});

/**
 * A re-read diff can drop the line the last click landed on, and a range from a line that no
 * longer exists would guess where it started.
 */
test("a range without a known anchor is just the clicked line", () => {
  assert.deepEqual(rangeBetween(["-2", "+2"], null, "+2"), ["+2"]);
  assert.deepEqual(rangeBetween(["-2", "+2"], "+9", "+2"), ["+2"]);
  assert.equal(rangeBetween(["-2"], "-2", "+9").length, 0);
});

test("the payload splits left-out lines into removals and additions", () => {
  const selection = toLineSelection("src/a.ts", {
    fingerprint: "f1",
    excluded: new Set(["-2", "+3", "+12"]),
    total: 5,
  });
  assert.deepEqual(selection, {
    path: "src/a.ts",
    fingerprint: "f1",
    excludedRemovals: [2],
    excludedAdditions: [3, 12],
  });
});

test("the chosen count is what the choice did not leave out", () => {
  assert.equal(
    chosenLineCount({ fingerprint: "f", excluded: new Set(["+1"]), total: 4 }),
    3
  );
});

test("a file inside a folded directory row belongs to that row", () => {
  const rows = new Set(["src/a.ts", "assets/"]);
  assert.equal(rowPathFor("src/a.ts", rows), "src/a.ts");
  assert.equal(rowPathFor("assets/logo.svg", rows), "assets/");
  assert.equal(rowPathFor("docs/new.md", rows), null);
});

test("folded directories, deletions, renames, and copies go in whole", () => {
  /** @param {Partial<FileChange>} change */
  const row = change =>
    /** @type {FileChange} */ ({ path: "a.ts", status: "M", ...change });
  const whole = [
    row({ path: "assets/", status: "?" }),
    row({ status: "D" }),
    row({ status: "R" }),
    row({ status: "C" }),
  ].filter(goesInWhole);
  assert.equal(whole.length, 4);
  assert.equal(goesInWhole(row({ status: "M" })), false);
  assert.equal(goesInWhole(row({ status: "?" })), false);
});
