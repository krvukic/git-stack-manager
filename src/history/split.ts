/**
 * split — separate one commit into two.
 *
 * The commit's own diff is broken into hunks; the user picks which belong in the
 * first (lower) commit and the rest go to the second. Both are built with
 * `commit-tree`, so — as with reword, absorb, and fold — nothing is checked out
 * and nothing can conflict.
 *
 * The first commit's tree is the parent's tree with the chosen hunks applied. The
 * second commit's tree is the original commit's tree, unchanged: whatever the
 * first commit did not take is by definition what is left. That asymmetry is what
 * keeps split conflict-free — only one tree has to be constructed, and the end
 * state of the pair is identical to the commit that was split.
 */
import { diffLines } from "#git/lineDiff";
import { GitError, GitRunner } from "#git/runner";
import { RawData } from "#git/snapshot";
import { Hunk } from "#history/absorbPlacement";
import {
  authorEnvironment,
  fileMode,
  stageBlob,
  withNewline,
  withScratchIndex,
  writeBlob,
} from "#history/objects";
import { rebuildStack } from "#history/rewrite";

/** One selectable change within the commit being split. */
export type SplitHunk = {
  /** Stable identifier the UI sends back: "<path>:<index>". */
  id: string;
  path: string;
  /** Line number in the parent's version of the file, for display. */
  startLine: number;
  removed: string[];
  added: string[];
};

export type SplitPreview = {
  sha: string;
  subject: string;
  hunks: SplitHunk[];
};

export type SplitResult = {
  /** The lower commit, holding the selected hunks. */
  firstSha: string;
  /** The upper commit, holding the remainder. */
  secondSha: string;
};

type FileHunks = {
  path: string;
  mode: string;
  parentLines: string[];
  commitLines: string[];
  hunks: Hunk[];
};

/**
 * List the commit's changes as selectable hunks, without modifying anything.
 *
 * Only text files whose content changed are splittable. A file added, deleted, or
 * renamed by the commit is an all-or-nothing change with no meaningful hunks, so
 * it stays with the second commit.
 */
export async function previewSplit(
  git: GitRunner,
  snapshot: RawData,
  sha: string
): Promise<SplitPreview> {
  const commit = snapshot.commits.find(candidate => candidate.sha === sha);
  if (!commit) {
    throw new GitError(
      "Commit is not a local commit — nothing to split.",
      "split"
    );
  }
  const parentSha = commit.parents[0];
  if (!parentSha) {
    throw new GitError("Cannot split the root commit.", "split");
  }
  const files = await readChangedFiles(git, parentSha, sha);
  const hunks = files.flatMap(file =>
    file.hunks.map((hunk, index) => ({
      id: `${file.path}:${index}`,
      path: file.path,
      startLine: hunk.oldStart + 1,
      removed: file.parentLines.slice(hunk.oldStart, hunk.oldEnd),
      added: hunk.newLines,
    }))
  );
  if (hunks.length < 2) {
    throw new GitError(
      "This commit has only one change, so there is nothing to split apart.",
      "split"
    );
  }
  return { sha, subject: commit.subject, hunks };
}

/**
 * Split `sha` into two commits, with `selectedIds` going to the first.
 *
 * `firstMessage` and `secondMessage` default to the original subject with a
 * marker, since two commits sharing one message is rarely what anyone wants.
 */
export async function splitCommit(
  git: GitRunner,
  snapshot: RawData,
  sha: string,
  selectedIds: string[],
  firstMessage?: string,
  secondMessage?: string
): Promise<SplitResult> {
  const commit = snapshot.commits.find(candidate => candidate.sha === sha);
  if (!commit) {
    throw new GitError(
      "Commit is not a local commit — nothing to split.",
      "split"
    );
  }
  const parentSha = commit.parents[0];
  if (!parentSha) {
    throw new GitError("Cannot split the root commit.", "split");
  }

  const selected = new Set(selectedIds);
  if (!selected.size) {
    throw new GitError(
      "Select at least one change for the first commit.",
      "split"
    );
  }

  const files = await readChangedFiles(git, parentSha, sha);
  const totalHunks = files.reduce(
    (total, file) => total + file.hunks.length,
    0
  );
  if (selected.size >= totalHunks) {
    throw new GitError(
      "Every change was selected, which would leave the second commit empty.",
      "split"
    );
  }

  // Build the first commit's tree: the parent's content with only the chosen
  // hunks applied.
  const firstTree = await withScratchIndex(
    git,
    "gsm-split-index",
    environment =>
      writeSelectedTree(git, environment, parentSha, files, selected)
  );

  const author = authorEnvironment(commit);
  const first = await git.run(["commit-tree", firstTree, "-p", parentSha], {
    input: withNewline(firstMessage || `${commit.subject} (part 1)`),
    env: author,
  });
  // The second commit reuses the original tree, so the pair ends exactly where
  // the single commit did.
  const second = await git.run(["commit-tree", `${sha}^{tree}`, "-p", first], {
    input: withNewline(secondMessage || `${commit.subject} (part 2)`),
    env: author,
  });

  // Anything above re-parents onto the second commit, and the split commit's
  // branches follow it there.
  await rebuildStack(git, snapshot, {
    presetRewrites: new Map([[sha, second]]),
  });
  return { firstSha: first, secondSha: second };
}

/** Diff a commit against its parent, per file, as line hunks. */
async function readChangedFiles(
  git: GitRunner,
  parentSha: string,
  sha: string
): Promise<FileHunks[]> {
  // -z keeps paths with odd characters intact; the status letter comes first.
  const raw = await git.run(["diff", "--name-status", "-z", parentSha, sha]);
  const parts = raw.split("\0").filter(Boolean);
  const files: FileHunks[] = [];

  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index] ?? "";
    const path = parts[index + 1];
    // Renames carry two paths; skip them along with adds and deletes, which have
    // no hunks to choose between.
    if (/^[RC]/.test(status)) {
      index++;
      continue;
    }
    if (status !== "M" || path === undefined) {
      continue;
    }

    const parentContent = await git.tryRun(["show", `${parentSha}:${path}`]);
    const commitContent = await git.tryRun(["show", `${sha}:${path}`]);
    if (parentContent === null || commitContent === null) {
      continue;
    }
    if (parentContent.includes("\0") || commitContent.includes("\0")) {
      continue;
    } // binary

    const parentLines = parentContent.split("\n");
    const commitLines = commitContent.split("\n");
    files.push({
      path,
      mode: await fileMode(git, sha, path),
      parentLines,
      commitLines,
      hunks: diffLines(parentLines, commitLines),
    });
  }
  return files;
}

/** Write a tree holding the parent's content plus the selected hunks. */
async function writeSelectedTree(
  git: GitRunner,
  environment: NodeJS.ProcessEnv,
  parentSha: string,
  files: FileHunks[],
  selected: Set<string>
): Promise<string> {
  await git.run(["read-tree", parentSha], { env: environment });

  for (const file of files) {
    const chosen = file.hunks
      .map((hunk, index) => ({ hunk, id: `${file.path}:${index}` }))
      .filter(entry => selected.has(entry.id))
      .map(entry => entry.hunk);
    if (!chosen.length) {
      continue;
    }

    // Apply back-to-front so earlier line numbers stay valid.
    let lines = [...file.parentLines];
    for (const hunk of [...chosen].sort((a, b) => b.oldStart - a.oldStart)) {
      lines = [
        ...lines.slice(0, hunk.oldStart),
        ...hunk.newLines,
        ...lines.slice(hunk.oldEnd),
      ];
    }
    const blob = await writeBlob(git, lines.join("\n"));
    await stageBlob(git, environment, {
      path: file.path,
      mode: file.mode,
      blob,
    });
  }
  return git.run(["write-tree"], { env: environment });
}
