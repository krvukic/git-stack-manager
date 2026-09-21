/**
 * The legend drawer, which explains every badge the tree can draw.
 *
 * Its samples are real branch details rendered through the same component the rows use, so a
 * badge whose wording changes cannot go on being explained the old way. What these tests
 * protect is the drawer's own shape: a row with no sample, or a sample whose arguments return
 * no badge, renders an empty cell that reads as a missing glyph rather than a broken row.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { trunkBehindBadge } from "../src/webview/model/badges.mts";
import { legendGroups } from "../src/webview/model/legend.mts";
import { present } from "./present.mjs";

test("every legend row carries exactly one sample, and both columns", () => {
  const groups = legendGroups();
  assert.ok(groups.length >= 6);
  for (const group of groups) {
    assert.ok(group.heading.length > 0);
    assert.ok(group.rows.length > 0, `${group.heading} has no rows`);
    for (const row of group.rows) {
      const samples = [row.branch, row.pill, row.trunkBehind].filter(Boolean);
      assert.equal(
        samples.length,
        1,
        `${row.what} must carry exactly one of a branch, a pill, or trunk-behind arguments`
      );
      assert.ok(row.what.length > 0);
      assert.ok(row.why.length > 0);
    }
  }
});

/**
 * The trunk-behind row passes arguments rather than a finished badge, so nothing checks it
 * against `trunkBehindBadge` at compile time. Arguments that return null would render an
 * empty cell in the drawer, which reads as a missing sample rather than a bad row.
 */
test("the legend's trunk-behind arguments produce a badge", () => {
  const rows = legendGroups().flatMap(group => group.rows);
  const sample = present(
    rows.find(row => row.trunkBehind)?.trunkBehind,
    "a trunk-behind legend row"
  );
  const badge = trunkBehindBadge(
    sample.branch,
    sample.behind,
    sample.trunkRef,
    sample.isCheckedOut
  );
  assert.ok(badge, "the legend's arguments must produce a badge");
  assert.match(badge.label, /\bbehind\b/);
});

/**
 * Rows about a pull request pass no sync at all, so the sample carries only the badge
 * under discussion. Leaving "submitted" beside a merged badge draws the eye to the wrong
 * pill.
 */
test("the pull request rows carry no sync badge to compete with", () => {
  const prGroups = legendGroups().filter(group =>
    /pull request state|integration|review decision/i.test(group.heading)
  );
  assert.ok(prGroups.length >= 3);
  for (const group of prGroups) {
    for (const row of group.rows) {
      assert.equal(
        present(row.branch, `a branch for ${row.what}`).sync,
        null,
        `${row.what} should show no sync badge`
      );
    }
  }
});
