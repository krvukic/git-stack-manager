/**
 * Absorb placement tests, ported from Sapling's behavioural specification:
 * https://github.com/facebook/sapling/blob/main/eden/scm/tests/test-absorb-filefixupstate.py
 *
 * The cases are reconstructed from that table rather than copied — Sapling is
 * GPL-2.0 and this project is MIT. Each line is encoded as a single character, so
 * a whole stack fits in a string like `"1"`/`"12"`/`"123"` and every edge case is
 * one short assertion. Passing this table is what makes an implementation
 * *behaviourally* absorb rather than merely absorb-shaped.
 *
 * The cases that must be no-ops matter as much as the ones that absorb. A tool
 * that folds an ambiguous hunk into the newest commit — which is what most git
 * ports do — passes the positive cases and fails these.
 *
 * If a case here starts failing after a change to `absorbPlacement`, the
 * behaviour has diverged from upstream; that module's header explains when
 * re-reading upstream is worthwhile.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "#git/lineDiff";
import { analyse, applyFixups, buildOwnerMap } from "#history/absorbPlacement";
import { present } from "./present.mjs";

/** "abc" -> ["a","b","c"]: one character per line, as the Python table does. */
const lines = (/** @type {string} */ text) => [...text];
const text = (/** @type {string[]} */ list) => list.join("");

/**
 * Build stack contents from per-line revision membership, mirroring the Python
 * `buildcontents`: `[["1",[1,2,3]], ["2",[2,3]]]` means line "1" exists in revs
 * 1-3 and "2" in revs 2-3. Returns one content string per revision, revision 0
 * being the empty immutable base.
 *
 * @param {Array<[string, number[]]>} spec
 * @returns {string[]}
 */
function buildContents(spec) {
  const allRevisions = [
    ...new Set(spec.flatMap(([, revisions]) => revisions)),
  ].sort();
  return [
    "",
    ...allRevisions.map(revision =>
      spec
        .filter(([, revisions]) => revisions.includes(revision))
        .map(([content]) => content)
        .join("")
    ),
  ];
}

/**
 * Run absorb over `stack` with `workingCopy` as the edited tip, and assert the
 * resulting per-commit contents. `stack[0]` is the immutable base.
 *
 * @param {string[]} stack
 * @param {string} workingCopy
 * @param {string[]} expected
 * @param {string} [message]
 */
function assertAbsorb(stack, workingCopy, expected, message = "") {
  const revisions = stack.map(lines);
  const map = buildOwnerMap(revisions, diffLines);
  const tip = present(revisions.at(-1), "the stack tip revision");
  const hunks = diffLines(tip, lines(workingCopy));
  const { fixups } = analyse(map, hunks);
  const applied = applyFixups(map, fixups, revisions.length - 1).map(text);
  assert.deepEqual(applied, expected, message);
}

/**
 * The stack is unchanged: every hunk was declined.
 *
 * @param {string[]} stack
 * @param {string} workingCopy
 * @param {string} [message]
 */
const assertNoOp = (stack, workingCopy, message) =>
  assertAbsorb(stack, workingCopy, stack, message);

/** Upstream case 0: a single commit, so every line has the same owner. */
test("a lone commit absorbs any replacement, whatever the line count", () => {
  const case0 = ["", "11"];
  for (const workingCopy of ["", "2", "22", "222"]) {
    assertAbsorb(
      case0,
      workingCopy,
      ["", workingCopy],
      `working copy ${JSON.stringify(workingCopy)}`
    );
  }
});

/** Upstream case 1: one line added per commit, so the tip holds one line per owner. */
const case1 = buildContents([
  ["1", [1, 2, 3]],
  ["2", [2, 3]],
  ["3", [3]],
]);

test("a 1:1 replacement sends each line to the commit that introduced it", () => {
  assert.deepEqual(case1, ["", "1", "12", "123"]);
  assertAbsorb(case1, "abc", ["", "a", "ab", "abc"]);
  assertAbsorb(case1, "a2c", ["", "a", "a2", "a2c"], "middle line left alone");
  assertAbsorb(case1, "1b3", ["", "1", "1b", "1b3"]);
});

test("a replacement of a different size is declined", () => {
  // Neither 1:1 nor a pure deletion, and it spans three owners.
  assertNoOp(case1, "abcd");
  assertNoOp(case1, "ab");
});

test("deletions split across the commits that own each line", () => {
  assertAbsorb(case1, "", ["", "", "", ""], "everything deleted");
  assertAbsorb(case1, "1", ["", "1", "1", "1"]);
  assertAbsorb(case1, "13", ["", "1", "1", "13"]);
});

test("an insertion at either boundary absorbs into its single neighbour", () => {
  assertAbsorb(
    case1,
    "123c",
    ["", "1", "12", "123c"],
    "appended after the newest line"
  );
  assertAbsorb(
    case1,
    "a123",
    ["", "a1", "a12", "a123"],
    "prepended before the oldest line"
  );
});

/** Upstream case 2: revision 2 removes the middle lines, leaving a seam at the tip. */
const case2 = buildContents([
  ["11", [1, 2]],
  ["22", [1]],
  ["33", [1, 2]],
]);

test("a hunk spanning a mid-stack deletion is declined", () => {
  assert.deepEqual(case2, ["", "112233", "1133"]);
  // This is the case `git blame` cannot see: the two "1" lines and the two "3"
  // lines look adjacent at the tip, but rev 2 deleted the "2"s between them.
  // Absorbing across that seam would resurrect them.
  assertNoOp(case2, "aaa");
});

test("a 1:1 replacement across the deletion seam is still allowed", () => {
  // Equal line counts means each line goes to its own owner, so no line crosses
  // the seam and the gap check does not apply.
  assertAbsorb(case2, "aaaa", ["", "aa22aa", "aaaa"]);
});

/**
 * Upstream case 3: revision 3 puts back the line revision 2 removed, so a line's owner is
 * not simply the newest commit that mentions it.
 */
const case3 = buildContents([
  ["1", [1, 2, 3]],
  ["2", [2]],
  ["3", [1, 2, 3]],
]);

test("a reverted line stays reverted in the commit that owned it", () => {
  assert.deepEqual(case3, ["", "13", "123", "13"]);
  assertAbsorb(case3, "ab", ["", "ab", "a2b", "ab"]);
});

test("edits that do not map onto the reverted stack are declined", () => {
  assertNoOp(case3, "a");
  assertNoOp(case3, "abc");
});

test("lines owned by the base survive a delete-everything edit", () => {
  // Upstream case 4, the immutable base: element 0 is a real base commit rather than the
  // empty file every case above starts from. Deleting the whole file can only remove what
  // the stack added, so the base's own lines stay and the base is never rewritten.
  const case4 = ["1357", "0125678"];
  assertAbsorb(case4, "", ["1357", "157"]);
});

/** Upstream case 5: an empty file, where there is no line to own. */
test("an empty stack absorbs nothing", () => {
  assertNoOp([""], "1");
});

test("declined hunks are reported with a reason rather than applied silently", () => {
  const revisions = case2.map(lines);
  const map = buildOwnerMap(revisions, diffLines);
  const hunks = diffLines(
    present(revisions.at(-1), "the stack tip revision"),
    lines("aaa")
  );
  const { fixups, rejected } = analyse(map, hunks);
  assert.equal(fixups.length, 0);
  assert.equal(rejected.length, 1);
  // The message has to name the cause, since the fix is manual.
  assert.match(
    present(rejected[0], "the rejected hunk").reason,
    /deleted lines inside this range/
  );
});
