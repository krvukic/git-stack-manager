/**
 * When a commit was made, in the few characters a row can spare.
 *
 * Recent work reads as an age and everything older as a date, which is the pattern GitHub's
 * `relative-time` element and Slack both use. The reason is that the two questions are
 * different: for something from the last few hours a reader wants to know how long ago, and
 * for something from last March they want to know *when*, because "4 months ago" is a number
 * nobody can turn back into a date.
 *
 * The cap is what keeps this testable, and the screenshots with it. An age alone would make
 * every row depend on the wall clock — the picture suite masks the one clock it already has
 * for that reason — whereas the demo repository's commits are all years old, so every
 * recorded row shows a fixed date.
 *
 * `now` is a parameter rather than a call to `Date.now()` in here, so each boundary below can
 * be asserted at an exact second instead of near one.
 */

/**
 * Where the age stops and the date starts. A day is the point at which the hour count stops
 * being the useful half of the answer.
 */
export const RELATIVE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** Under this, the age is noise: a commit made during the last render is not "0 seconds" old. */
const JUST_NOW_MS = 5000;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * English, spelled out here rather than taken from `Intl.RelativeTimeFormat`.
 *
 * Every other string this UI draws — "not submitted", "You are here", "commits hidden" — is a
 * literal, because the extension ships no translations. One formatter for one of them would
 * make this row the only part that answers to the reader's locale, and the unit suite would
 * assert whatever locale the machine running it happens to have. The date past the cap is
 * locale-free by construction, which is the other half of why this needs no formatter.
 */
function ago(count: number, unit: "second" | "minute" | "hour"): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** `YYYY-MM-DD` in the reader's own zone, where `toISOString` would answer in UTC. */
function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * How a row prints `date`, or an empty string when git gave something unparseable.
 *
 * Empty rather than a placeholder: the date is an optional column, so a row with no answer
 * leaves it blank instead of printing `Invalid Date` across the tree.
 *
 * A commit dated in the future reads "just now" rather than counting forwards. An author date
 * ahead of the clock means the two machines disagree, not that the commit is from next week,
 * and "in 3 hours" sends a reader hunting for a cause that is not in the history.
 */
export function commitDateLabel(date: string, now: number): string {
  const when = new Date(date);
  const time = when.getTime();
  if (Number.isNaN(time)) {
    return "";
  }
  const elapsed = now - time;
  if (elapsed >= RELATIVE_LIMIT_MS) {
    return isoDate(when);
  }
  if (elapsed < JUST_NOW_MS) {
    return "just now";
  }
  if (elapsed < MINUTE_MS) {
    return ago(Math.floor(elapsed / 1000), "second");
  }
  if (elapsed < HOUR_MS) {
    return ago(Math.floor(elapsed / MINUTE_MS), "minute");
  }
  return ago(Math.floor(elapsed / HOUR_MS), "hour");
}
