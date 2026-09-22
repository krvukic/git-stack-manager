/**
 * chosenChanges — put the chosen working-copy changes into a scratch index, some files whole and
 * some line by line.
 *
 * `git commit --only -- <paths>` takes each path's content from the working tree, so it cannot
 * commit part of a file. A scratch index can: it starts as HEAD's tree, `git add` stages the
 * chosen paths into it, and each partly chosen file is then replaced with a blob rebuilt from its
 * chosen lines. Committing that index is a normal `git commit`, hooks and reflog included, and
 * the working tree is never written, so the lines left out stay exactly where they are.
 *
 * `git add` runs first even for a partly chosen file, because it is what applies the clean
 * filters and records the mode. The blob it stages is the working side the diff numbered.
 */
import { readWorkingCopyDiff } from "#git/diff";
import { GitError, GitRunner } from "#git/runner";
import { readObjects, stageBlob, writeBlob } from "#history/objects";
import {
  buildSelectedContent,
  describeWorkingFiles,
  LineSelection,
  staleSelection,
  WorkingFileDiff,
} from "#history/partialSelection";

/**
 * Fill the scratch index behind `environment` with HEAD plus the chosen changes.
 *
 * `lines` holds the partly chosen files, each of which must also be in `paths`. A file whose diff
 * no longer matches the one its lines were chosen from is refused, and nothing is staged for it.
 */
export async function stageChosenChanges(
  git: GitRunner,
  environment: NodeJS.ProcessEnv,
  { paths, lines }: { paths: string[]; lines: LineSelection[] }
): Promise<void> {
  const hasHead = await git.succeeds([
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]);
  await git.run(hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], {
    env: environment,
  });
  // `--all` stages a deletion too, which a plain `add` leaves out of the index.
  await git.run(["add", "--all", "--", ...paths], { env: environment });
  if (!lines.length) {
    return;
  }

  const diffs = await currentDiffs(git, lines);
  const staged = await stagedEntries(git, environment, lines);
  const chosen = lines.map(selection => {
    const entry = staged.get(selection.path);
    const file = diffs.get(selection.path);
    // Staged by the `add` above unless the file went missing since the diff was read.
    if (!entry || !file) {
      throw staleSelection(selection.path);
    }
    return { selection, entry, file };
  });
  // Both sides of every file in one process: the working blobs first, then HEAD's.
  const blobs = await readObjects(git, [
    ...chosen.map(({ entry }) => entry.blob),
    ...chosen.map(({ selection }) => `HEAD:${selection.path}`),
  ]);
  for (const [index, { selection, entry, file }] of chosen.entries()) {
    const content = buildSelectedContent({
      file,
      // Absent from HEAD for a new file, whose old side is empty.
      head: blobs[chosen.length + index]?.toString("latin1") ?? "",
      working: blobs[index]?.toString("latin1") ?? "",
      selection,
    });
    await stageBlob(git, environment, {
      path: selection.path,
      mode: entry.mode,
      blob: await writeBlob(git, Buffer.from(content, "latin1")),
    });
  }
}

/**
 * Each partly chosen file's diff as it reads now, checked against the one its lines were chosen
 * from.
 *
 * One read for every such file rather than one each. The diff is against the real index's HEAD
 * and the working tree, which is what the webview read too, so equal fingerprints mean the
 * reader saw the change this commits.
 */
async function currentDiffs(
  git: GitRunner,
  lines: LineSelection[]
): Promise<Map<string, WorkingFileDiff>> {
  const diff = await readWorkingCopyDiff(
    git,
    lines.map(selection => selection.path)
  );
  const byPath = new Map<string, WorkingFileDiff>();
  for (const file of describeWorkingFiles(diff.files)) {
    byPath.set(file.path, file);
  }
  for (const selection of lines) {
    const file = byPath.get(selection.path);
    if (!file || file.fingerprint !== selection.fingerprint) {
      throw staleSelection(selection.path);
    }
    if (file.wholeFileReason) {
      throw new GitError(
        `${selection.path}: ${file.wholeFileReason}`,
        "partial selection"
      );
    }
  }
  return byPath;
}

/** The mode and blob `git add` staged for each partly chosen file. */
async function stagedEntries(
  git: GitRunner,
  environment: NodeJS.ProcessEnv,
  lines: LineSelection[]
): Promise<Map<string, { mode: string; blob: string }>> {
  const output = await git.run(
    [
      "ls-files",
      "--stage",
      "-z",
      "--",
      ...lines.map(selection => selection.path),
    ],
    { env: environment }
  );
  const entries = new Map<string, { mode: string; blob: string }>();
  for (const record of output.split("\0").filter(Boolean)) {
    // `<mode> <blob> <stage>\t<path>`, so the tab always precedes the path.
    const tab = record.indexOf("\t");
    const [mode, blob] = record.slice(0, tab).split(" ");
    if (mode && blob) {
      entries.set(record.slice(tab + 1), { mode, blob });
    }
  }
  return entries;
}
