/**
 * The date a row prints, at every boundary between its four forms.
 *
 * `now` is a parameter of the function under test, so each case below sits on an exact
 * millisecond rather than near one. The boundaries are the whole behaviour: "60 minutes ago"
 * where an hour was meant, or a date where an age was, means an off-by-one in one of these
 * comparisons.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitDateLabel,
  RELATIVE_LIMIT_MS,
} from "../src/webview/model/commitDate.mts";

/** A fixed instant to measure against, and the commit times are offsets from it. */
const NOW = Date.parse("2026-10-04T12:00:00Z");

/**
 * The label for a commit made `ago` milliseconds before `NOW`.
 *
 * @param {number} ago
 */
function labelFor(ago) {
  return commitDateLabel(new Date(NOW - ago).toISOString(), NOW);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

test("a commit from the last few seconds reads as just now", () => {
  // Not "0 seconds ago": a commit made during the last render is not zero seconds old, it is
  // too recent for the number to mean anything.
  assert.equal(labelFor(0), "just now");
  assert.equal(labelFor(4999), "just now");
  assert.equal(labelFor(5 * SECOND), "5 seconds ago");
});

test("seconds, minutes, and hours each count whole units", () => {
  assert.equal(labelFor(20 * SECOND), "20 seconds ago");
  assert.equal(labelFor(59 * SECOND), "59 seconds ago");
  assert.equal(labelFor(5 * MINUTE), "5 minutes ago");
  assert.equal(labelFor(2 * HOUR), "2 hours ago");
  // Floored, not rounded: an hour and fifty minutes is still "1 hour ago", the same way a
  // person reports their own age.
  assert.equal(labelFor(HOUR + 50 * MINUTE), "1 hour ago");
});

test("one of anything drops the plural", () => {
  assert.equal(labelFor(MINUTE), "1 minute ago");
  assert.equal(labelFor(HOUR), "1 hour ago");
  // "1 second ago" is unreachable, and deliberately: anything that recent is inside the
  // just-now floor. The singular is still needed for the two units above.
  assert.equal(labelFor(SECOND), "just now");
});

test("each unit hands over exactly at its boundary", () => {
  assert.equal(labelFor(MINUTE - 1), "59 seconds ago");
  assert.equal(labelFor(MINUTE), "1 minute ago");
  assert.equal(labelFor(HOUR - 1), "59 minutes ago");
  assert.equal(labelFor(HOUR), "1 hour ago");
  assert.equal(labelFor(RELATIVE_LIMIT_MS - 1), "23 hours ago");
});

test("past a day the age gives way to the date", () => {
  // The handover is the point of the cap: "4 months ago" is a number nobody can turn back
  // into a day, and it would also put a wall clock in every recorded screenshot.
  assert.equal(labelFor(RELATIVE_LIMIT_MS), "2026-10-03");
  assert.equal(labelFor(400 * 24 * HOUR), "2025-08-30");
});

test("the date is written in the reader's own zone, not UTC", () => {
  // `toISOString` would answer in UTC and name the wrong day for anyone far enough east or
  // west of it. A commit at 01:00 in a zone two hours ahead was made on the 3rd locally and
  // on the 2nd in UTC, and the row belongs to the reader's calendar.
  const label = commitDateLabel(
    "2026-10-02T23:00:00Z",
    Date.parse("2026-10-30T12:00:00Z")
  );
  const local = new Date("2026-10-02T23:00:00Z");
  const expected = `${local.getFullYear()}-${`${local.getMonth() + 1}`.padStart(2, "0")}-${`${local.getDate()}`.padStart(2, "0")}`;
  assert.equal(label, expected);
});

test("a commit dated in the future reads as just now rather than counting forwards", () => {
  // Two machines disagreeing about the time, which is what an author date ahead of the clock
  // means. "In 3 hours" would send a reader looking for a cause that is not in the history.
  assert.equal(labelFor(-3 * HOUR), "just now");
  assert.equal(labelFor(-400 * 24 * HOUR), "just now");
});

test("an unparseable date prints nothing at all", () => {
  // The column is optional, so a row with no answer leaves it empty rather than carrying
  // `Invalid Date` across the tree.
  assert.equal(commitDateLabel("", NOW), "");
  assert.equal(commitDateLabel("not a date", NOW), "");
});
