/**
 * lineCounts — how many lines each commit added and removed.
 *
 * One `git show --shortstat` answers for every commit asked about, so the cost is one process
 * however many rows the tree draws. Git still diffs each commit to count its lines, which is why
 * nothing here runs as part of the batched read: `Repository.lineCounts` asks only for commits it
 * has not counted yet, and only while a reader has the counts on screen.
 */
import { GitRunner } from "#git/runner";

export type LineCount = {
  added: number;
  removed: number;
};

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The shas among `candidates` that are safe to pass to git as arguments.
 *
 * A value that reached here came from a payload. One that started with a dash would be read
 * as an option, so anything that is not a full sha is dropped.
 */
export function fullShas(candidates: string[]): string[] {
  return candidates.filter(candidate => FULL_SHA.test(candidate));
}

/**
 * Read `git show --shortstat --format=%H` into a count per commit.
 *
 * Each commit prints its sha on a line of its own, then a summary such as
 * ` 2 files changed, 12 insertions(+), 3 deletions(-)`. Git leaves out a clause whose count is
 * zero, and prints no summary at all for a commit that changed nothing, so every sha starts at
 * zero and a clause only raises it.
 */
export function parseShortstat(output: string): Map<string, LineCount> {
  const counts = new Map<string, LineCount>();
  let current: LineCount | undefined;
  for (const line of output.split("\n")) {
    if (FULL_SHA.test(line)) {
      current = { added: 0, removed: 0 };
      counts.set(line, current);
      continue;
    }
    if (!current) {
      continue;
    }
    const added = /(\d+) insertions?\(\+\)/.exec(line)?.[1];
    const removed = /(\d+) deletions?\(-\)/.exec(line)?.[1];
    if (added !== undefined) {
      current.added = Number(added);
    }
    if (removed !== undefined) {
      current.removed = Number(removed);
    }
  }
  return counts;
}

/** Count the lines each of `shas` added and removed, in one git process. */
export async function readLineCounts(
  git: GitRunner,
  shas: string[]
): Promise<Map<string, LineCount>> {
  if (!shas.length) {
    return new Map();
  }
  const output = await git.run([
    "show",
    "--shortstat",
    "--format=%H",
    // A merge counts against its first parent, as a pull request's diff does. `git show`
    // prints a combined diff for a merge otherwise, which has no summary.
    "--diff-merges=first-parent",
    ...shas,
  ]);
  return parseShortstat(output);
}
