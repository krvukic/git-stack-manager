/**
 * Amend placement: which changes can be amended into a commit below HEAD, and what every commit
 * above it holds afterwards.
 *
 * Neighbour to `absorb-placement.test.mjs`, which asks where a change belongs. Here the target is
 * given, so every case is either a clean placement or a refusal naming the later commit in the
 * way. Lines are one character each, so `"ab"` is a two-line file; the first revision is the
 * target and the last is HEAD.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "#git/lineDiff";
import { applyFixups, buildOwnerMap } from "#history/absorbPlacement";
import { carryOnto, placeInTarget } from "#history/amendPlacement";

const lines = (/** @type {string} */ text) => [...text];

/**
 * Amend `wanted` into the first of `revisions`, returning every revision's new content or the
 * index of the commit that refused it.
 *
 * @param {string[]} revisions
 * @param {string} wanted
 */
function amend(revisions, wanted) {
  const map = buildOwnerMap(revisions.map(lines), diffLines);
  const placement = placeInTarget(
    map,
    diffLines(lines(revisions.at(-1) ?? ""), lines(wanted))
  );
  if ("blockedBy" in placement) {
    return placement.blockedBy;
  }
  return applyFixups(map, placement.fixups, revisions.length - 1).map(content =>
    content.join("")
  );
}

/**
 * Carry the change `parent` -> `rewritten` onto `child`, which descends from `parent`.
 *
 * @param {string} parent
 * @param {string} rewritten
 * @param {string} child
 */
function carry(parent, rewritten, child) {
  const map = buildOwnerMap([lines(parent), lines(child)], diffLines);
  const placement = carryOnto(map, diffLines(lines(parent), lines(rewritten)));
  if ("blockedBy" in placement) {
    return placement.blockedBy;
  }
  return applyFixups(map, placement.fixups, 1)[1]?.join("");
}

test("an edit to the target's own lines reaches every commit above it", () => {
  assert.deepEqual(amend(["ab", "abc", "abcd"], "Abcd"), ["Ab", "Abc", "Abcd"]);
  // A deletion and a same-size replacement both stay within the target's lines.
  assert.deepEqual(amend(["abc", "abcd"], "acd"), ["ac", "acd"]);
  assert.deepEqual(amend(["abc", "xabc"], "xaBc"), ["aBc", "xaBc"]);
});

test("an edit to a later commit's line is refused, naming that commit", () => {
  assert.equal(amend(["a", "ab", "abc"], "aBc"), 1);
  assert.equal(amend(["a", "ab", "abc"], "abC"), 2);
  // A run that covers the target's line and a later one is still refused.
  assert.equal(amend(["a", "ab"], "AB"), 1);
});

test("an edit across a line a later commit deleted is refused", () => {
  // `b` is gone at HEAD, but the target still has it between `a` and `c`: replacing `ac` as one
  // run would have to decide where `b` went.
  assert.equal(amend(["abc", "ac"], "AC"), 1);
  assert.equal(amend(["abc", "ac"], "aXc"), 1);
  // Clear of the deletion, the same kind of edit is fine.
  assert.deepEqual(amend(["abcd", "acd"], "acD"), ["abcD", "acD"]);
});

test("a new line beside a later commit's line is anchored by the target's line", () => {
  // `c` was appended later. `X` between `b` and `c` goes at the target's end, with `c` after it.
  assert.deepEqual(amend(["ab", "abc"], "abXc"), ["abX", "abXc"]);
  // The mirror: `c` inserted later between `a` and `b`, `X` after it and before `b`.
  assert.deepEqual(amend(["ab", "acb"], "acXb"), ["aXb", "acXb"]);
  // Between two later lines, the target has nowhere to hold `X`.
  assert.equal(amend(["a", "acd"], "acXd"), 1);
  // After a later line at the end of the file, likewise.
  assert.equal(amend(["a", "ac"], "acX"), 1);
});

test("an empty target file takes new lines", () => {
  assert.deepEqual(amend(["", ""], "ab"), ["ab", "ab"]);
});

test("a rewritten parent's change carries onto a child that kept those lines", () => {
  assert.equal(carry("abc", "aBc", "abcz"), "aBcz");
  assert.equal(carry("abc", "abXc", "zabc"), "zabXc");
  // The child changed the same line, or put its own line where the new one goes.
  assert.equal(carry("abc", "aBc", "aYc"), 1);
  assert.equal(carry("abc", "abcX", "abcz"), 1);
  // The child deleted a neighbour of the new line.
  assert.equal(carry("abc", "abXc", "ac"), 1);
});
