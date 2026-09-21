/**
 * The git floor, checked once per runner.
 *
 * Two commands set the floor at 2.45. `for-each-ref --include-root-refs` is how
 * the batched read sees HEAD, and `rebase --update-refs` is how one rebase carries
 * a whole stack. Older git rejects the first outright and strands every
 * intermediate branch without the second, and both failures read as a broken
 * extension rather than an old git — a graph with no branch pills, or a stack left
 * pointing at abandoned commits. This check turns them into one sentence.
 */
import { GitError, GitRunner } from "#git/runner";

const MINIMUM_MAJOR = 2;
const MINIMUM_MINOR = 45;
export const MINIMUM_GIT = `${MINIMUM_MAJOR}.${MINIMUM_MINOR}`;

/**
 * The in-flight or settled check per runner, so a session spawns `git version` at
 * most once. Caching the promise rather than a boolean covers the concurrent case:
 * the UI polls while the user acts, so two reads are routinely in flight together
 * and a boolean set on resolution would let both spawn the probe.
 */
const checks = new WeakMap<GitRunner, Promise<void>>();

export function requireSupportedGit(git: GitRunner): Promise<void> {
  const existing = checks.get(git);
  if (existing) {
    return existing;
  }
  const check = checkVersion(git);
  checks.set(git, check);
  // A failed check must not be cached: the failure may be a spawn error rather than
  // an old git, and a refresh should retry rather than repeat a stale verdict.
  check.catch(() => checks.delete(git));
  return check;
}

async function checkVersion(git: GitRunner): Promise<void> {
  const output = await git.run(["version"], { silent: true });
  const [, major, minor] = /(\d+)\.(\d+)/.exec(output) ?? [];
  // Unparseable — assume a modern git rather than block on an unfamiliar build.
  if (
    !major ||
    !minor ||
    isAtLeastFloor(parseInt(major, 10), parseInt(minor, 10))
  ) {
    return;
  }
  throw new GitError(
    `Git Stack Manager needs git ${MINIMUM_GIT} or newer (found "${output.trim()}").`,
    "version"
  );
}

function isAtLeastFloor(major: number, minor: number): boolean {
  return (
    major > MINIMUM_MAJOR || (major === MINIMUM_MAJOR && minor >= MINIMUM_MINOR)
  );
}
