/**
 * objects — the object-database primitives the computed rewrites share.
 *
 * Reword, absorb, amend, fold, and split all build commits without checking anything out: they
 * write blobs and trees, then hand a tree to `commit-tree`. Both shared pieces fail quietly when
 * an edit gets them wrong — a borrowed index discards whatever the user staged, and a missing
 * author environment restamps the commit with the committer's name and the current time.
 */
import { rmSync } from "fs";
import { GitRunner } from "#git/runner";

/** The author fields `commit-tree` needs, so a rewritten commit keeps its authorship. */
export function authorEnvironment(commit: {
  authorName: string;
  authorEmail: string;
  authorDate: string;
}): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: commit.authorName,
    GIT_AUTHOR_EMAIL: commit.authorEmail,
    GIT_AUTHOR_DATE: commit.authorDate,
  };
}

/** End a message with a newline, the form git stores commit messages in. */
export function withNewline(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

/**
 * Run `build` against a scratch index, then delete that index however `build` ends.
 *
 * The real index holds whatever the user staged, and `read-tree` overwrites it, so a rewrite
 * borrowing it would silently discard their staged work. `name` separates the edits — absorb,
 * amend, and split each get their own file — so two of them running at once cannot read each
 * other's entries.
 */
export async function withScratchIndex<T>(
  git: GitRunner,
  name: string,
  build: (environment: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const indexFile = `${await gitDirectory(git)}/${name}`;
  try {
    return await build({ GIT_INDEX_FILE: indexFile });
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Write `content` into the object database and return the blob it became. */
export function writeBlob(git: GitRunner, content: string): Promise<string> {
  return git.run(["hash-object", "-w", "--stdin"], { input: content });
}

/**
 * Record a blob in the scratch index at `path`, under the mode it should keep.
 *
 * Separate from `writeBlob` because the mode is not always known by then: absorb reads it out
 * of the commit being rewritten, between writing the blob and staging it.
 */
export async function stageBlob(
  git: GitRunner,
  environment: NodeJS.ProcessEnv,
  entry: { path: string; mode: string; blob: string }
): Promise<void> {
  await git.run(
    [
      "update-index",
      "--add",
      "--cacheinfo",
      `${entry.mode},${entry.blob},${entry.path}`,
    ],
    { env: environment }
  );
}

/** The mode `path` carries in `sha`'s tree, so a rewrite preserves an executable bit. */
export async function fileMode(
  git: GitRunner,
  sha: string,
  path: string
): Promise<string> {
  const entry = await git.tryRun(["ls-tree", sha, "--", path]);
  return entry?.split(/\s/)[0] || "100644";
}

/** Where a scratch index can live: per-worktree, and cleaned up with the repository. */
async function gitDirectory(git: GitRunner): Promise<string> {
  return (
    await git.run(["rev-parse", "--path-format=absolute", "--git-dir"])
  ).trim();
}
