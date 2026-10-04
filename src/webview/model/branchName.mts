/**
 * A branch name suggested from the commit summary.
 *
 * Only ever a suggestion: the commit form offers it as a placeholder, and the reader can edit
 * or replace it before committing. That is why `suggestBranchName` emits a plain slug and
 * checks no naming policy.
 *
 * The conventional-commit prefix comes off first. `feat(case): add camelCase` describes the
 * change twice — once as a type and once in words — and `feat-case-add-camelcase` spends a
 * third of the name on the half a branch does not need.
 */

/** `type:` or `type(scope)!:` at the start of a summary, which carries no name. */
const CONVENTIONAL_PREFIX = /^[a-z]+(\([^)]*\))?!?:\s*/i;

/**
 * Length a suggestion is cut to, at a word boundary.
 *
 * Long enough for a sentence's worth of subject, short enough to fit the character cap at its
 * 24-character default. A longer name is still legal, and the reader can type one, so this
 * bounds the suggestion alone.
 */
const SUGGESTION_LIMIT = 32;

/**
 * Slug of `subject`, or an empty string when nothing is left to slug.
 *
 * Empty is a real answer rather than a failure: an unwritten summary has no name in it, and
 * the form shows no placeholder until one is typed.
 */
export function suggestBranchName(subject: string): string {
  const words = subject
    .replace(CONVENTIONAL_PREFIX, "")
    .toLowerCase()
    // Everything git would reject, plus everything a reader would not want in a name. The
    // apostrophe goes rather than becoming a dash, so `prop's` reads `props`.
    .replace(/['"`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    // `+ 1` for the dash this word would need. The first word is always taken, however long,
    // since a name of nothing is worse than a name over the limit.
    if (kept.length && length + word.length + 1 > SUGGESTION_LIMIT) {
      break;
    }
    length += kept.length ? word.length + 1 : word.length;
    kept.push(word);
  }
  return kept.join("-");
}
