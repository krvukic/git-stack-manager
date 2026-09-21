/**
 * `present` — assert a lookup found something, and narrow it for everything after.
 *
 * `strictNullChecks` reports roughly two hundred property reads across the suite that
 * follow a `find`, a `get`, or an index — each one a value the fixture guarantees and the
 * compiler cannot see. Silencing them with `?.` would weaken the assertions, and a
 * non-null assertion would keep the failure a `Cannot read properties of undefined`
 * naming no value.
 *
 * This is the third option, and the reason turning the flag on was worth it: the check
 * runs where the lookup happens, so a fixture that stops producing `feature-a` fails
 * with "no commit on feature-a" instead of a dereference twelve lines later.
 *
 * @template T
 * @param {T | null | undefined} value
 * @param {string} what What was being looked up, phrased for a failure message.
 * @returns {T}
 */
export function present(value, what) {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be present, got ${String(value)}`);
  }
  return value;
}

/**
 * The commit carrying a branch pill, which is how the fixture tests name one.
 *
 * One branch per commit is the model this extension draws, so the branch name is the
 * stable handle — a sha changes on every rewrite, and these tests rewrite history.
 *
 * @param {import("#git/snapshot").RawData} snapshot
 * @param {string} branch
 * @returns {import("#git/snapshot").RawCommit}
 */
export function commitOn(snapshot, branch) {
  return present(
    snapshot.commits.find(commit => commit.branches.includes(branch)),
    `a commit on ${branch}`
  );
}
