/**
 * diff — read changes as parsed hunks, for anything that displays them. A commit's, or the
 * working copy's.
 *
 * One reader serves three callers with different needs, which is why it lives here
 * rather than inside any of them: the sidebar's per-file diff, the whole-commit changes
 * overlay, and the VS Code host's diff editor. `history/split.ts` keeps its own reader
 * because it needs something narrower — it deliberately skips renames, adds, and
 * deletes, since a hunk you cannot choose between is not a splittable change. This one
 * reports every file, because a viewer that silently omitted a deletion would be lying.
 *
 * The parse is of `git diff`'s unified output rather than a reconstruction from file
 * contents. Reading both blobs and diffing them again would duplicate what git already
 * did, and would disagree with it on the cases that matter: whitespace rules, rename
 * detection, and the "\ No newline at end of file" marker.
 */
import { imageMediaType } from "#core/media";
import { GitRunner } from "#git/runner";

/** One contiguous run of changed lines within a file. */
export type DiffHunk = {
  /** `@@` header as git wrote it, which carries the enclosing function when known. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type DiffLine = {
  kind: "context" | "add" | "del";
  text: string;
  /** Line number in the parent, for context and removed lines. */
  oldNumber: number | null;
  /** Line number in this commit, for context and added lines. */
  newNumber: number | null;
};

export type FileDiff = {
  path: string;
  /** Previous path when git detected a rename or copy. */
  oldPath?: string;
  /** M A D R C, matching `FileChange.status`. */
  status: string;
  hunks: DiffHunk[];
  /**
   * The type a viewer can draw this file's blobs as, set when git refused to diff them and
   * the format is one the viewer knows — an image. Null when the hunks are the whole story,
   * or when nothing can draw the format, and then the note is all there is to show.
   *
   * Derived here because it takes both halves of the answer: only git knows the file is
   * binary, and only the path says which format. A viewer holding just the note could not
   * tell a `.png` apart from a rename that changed nothing.
   */
  previewMediaType: string | null;
  /**
   * Why there are no hunks, when there are none: a binary file, or a rename with no
   * content change. Null when the hunks are the whole story. A viewer needs this to say
   * something other than "no changes" about a file git listed as changed.
   */
  note: string | null;
  added: number;
  removed: number;
};

export type CommitDiff = {
  sha: string;
  files: FileDiff[];
};

/**
 * The same file list for changes no commit holds yet. No sha, which is the only difference
 * the viewer sees: an image here has to be read from disk rather than from a blob.
 */
export type WorkingCopyDiff = {
  files: FileDiff[];
};

/**
 * Read the diff between `sha` and its first parent.
 *
 * `--find-renames` so a moved file reads as a rename rather than a delete plus an add,
 * which is how both Source Control and Sapling present it. The root commit has no parent
 * to diff against, so it is compared with the empty tree — otherwise the first commit in
 * a repository would show no changes at all.
 */
export async function readCommitDiff(
  git: GitRunner,
  sha: string
): Promise<CommitDiff> {
  // Ask whether a parent exists rather than diffing and treating failure as "root": a
  // permissions error or a bad sha would otherwise be silently reported as the whole
  // commit being added.
  const hasParent = await git.succeeds([
    "rev-parse",
    "--verify",
    "--quiet",
    `${sha}^`,
  ]);
  const base = hasParent ? `${sha}^` : EMPTY_TREE;
  const output = await git.run([
    "diff",
    "--find-renames",
    "--unified=3",
    // `--no-color` and `--no-ext-diff` keep a user's own config out of the parse: a
    // configured external differ or colour codes would make this unparseable.
    "--no-color",
    "--no-ext-diff",
    base,
    sha,
  ]);
  return { sha, files: parseUnifiedDiff(output) };
}

/**
 * Git's canonical empty tree — the same hash in every repository, so the root commit can be
 * diffed against it without writing an object first.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Read every uncommitted change: the working copy against HEAD, staged changes included.
 *
 * Two reads, because no single `git diff` covers what the working-copy list shows. `diff HEAD`
 * reports tracked files — the same set the commit form ticks — and says nothing about a file git
 * has never seen, so an untracked file's diff is built here from its bytes. That is what
 * `git diff --no-index` against `/dev/null` would print: with no old side there is nothing to
 * compare, every line is an addition, and the line walk below is the whole of it. A process per
 * untracked file would buy nothing and cost forty of them the first time a build directory
 * escapes the ignore rules.
 *
 * `pathspec` scopes both reads to one row of that list. A row can name a directory — `git status`
 * collapses a folder of new files into `dir/` — which a pathspec handles and a filename would not.
 */
export async function readWorkingCopyDiff(
  git: GitRunner,
  pathspec?: string
): Promise<WorkingCopyDiff> {
  const scope = pathspec ? ["--", pathspec] : [];
  // A repository with no commit yet has no HEAD to name, and the empty tree stands in for it:
  // every tracked file then reads as an addition, which is what it is.
  const hasHead = await git.succeeds([
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]);
  const tracked = await git.run([
    "diff",
    "--find-renames",
    "--unified=3",
    "--no-color",
    "--no-ext-diff",
    hasHead ? "HEAD" : EMPTY_TREE,
    ...scope,
  ]);
  // Tracked first, then untracked, which is the order the working-copy list draws its own rows in.
  return {
    files: [
      ...parseUnifiedDiff(tracked),
      ...(await untrackedDiffs(git, scope)),
    ],
  };
}

/** Git's own rule for calling a blob binary: a NUL byte in the first 8000 of them. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * How much of a new file the viewer is given.
 *
 * Untracked is where the large files are — a log, a core dump, a bundle an ignore rule has not
 * caught — and every line drawn costs the webview a row of its own. A tracked file has no such
 * limit, because git's own diff of one reports the lines that changed rather than all of them.
 */
export const UNTRACKED_DIFF_BYTE_LIMIT = 256 * 1024;

async function untrackedDiffs(
  git: GitRunner,
  scope: string[]
): Promise<FileDiff[]> {
  const listed = await git.run([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    ...scope,
  ]);
  const files: FileDiff[] = [];
  // In sequence, so a directory of new files is read one at a time rather than all at once: the
  // paths arrive sorted and stay that way, and nothing holds every file open together.
  for (const path of listed.split("\0").filter(Boolean)) {
    files.push(await untrackedDiff(git, path));
  }
  return files;
}

/** One untracked file as a diff against nothing. */
async function untrackedDiff(git: GitRunner, path: string): Promise<FileDiff> {
  const file: FileDiff = {
    path,
    // `?`, the letter git's status gives it and the one the row above shows, rather than the
    // "new file" a `--no-index` diff reports: nothing has added this file to anything yet.
    status: "?",
    hunks: [],
    previewMediaType: null,
    note: null,
    added: 0,
    removed: 0,
  };
  const bytes = await git.readWorktreeFile(path);
  if (!bytes) {
    file.note = "Gone — the file was listed and then could not be read.";
    return file;
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    file.previewMediaType = imageMediaType(path);
    file.note = "Binary file — no text to show.";
    return file;
  }
  if (bytes.length > UNTRACKED_DIFF_BYTE_LIMIT) {
    file.note = `New file, ${Math.round(bytes.length / 1024)} KB — too large to show here. Open it instead.`;
    return file;
  }
  const texts = bytes.toString("utf8").split("\n");
  // A trailing newline ends the last line rather than starting an empty one after it.
  if (texts.at(-1) === "") {
    texts.pop();
  }
  if (!texts.length) {
    file.note = "New and empty — no lines to show.";
    return file;
  }
  const lines: DiffLine[] = texts.map((text, index) => ({
    kind: "add",
    text,
    oldNumber: null,
    newNumber: index + 1,
  }));
  file.added = lines.length;
  file.hunks = [
    {
      // The header git writes for a file with no old side, so the viewer's gutters read the
      // same here as they do for a commit's addition.
      header: `@@ -0,0 +1,${lines.length} @@`,
      oldStart: 0,
      newStart: 1,
      lines,
    },
  ];
  return file;
}

/**
 * Parse unified diff text into per-file hunks.
 *
 * Written as a line walk rather than a regex over the whole text because a diff's body
 * can contain anything — including lines that look like its own headers. Only the
 * `diff --git` boundary starts a new file, so state is carried explicitly.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of text.split("\n")) {
    // `diff --git` is the only line that may start a file, and it is checked first so a
    // body line quoting one cannot. Everything else depends on whether a hunk is open.
    const fileStart = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (fileStart) {
      file = {
        // The pattern matched, so both groups captured; `.*` can capture empty but
        // never absent. Same for the two hunk-header groups below.
        path: fileStart[2] ?? "",
        status: "M",
        hunks: [],
        previewMediaType: null,
        note: null,
        added: 0,
        removed: 0,
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) {
      continue;
    }

    // Inside a hunk every line is content, and only its first character says which side
    // it belongs to. This has to be tested BEFORE the header patterns: a commit that
    // documents diffs contains body lines beginning "+++" and "--- ", and treating those
    // as the file headers they resemble silently dropped them from the additions.
    if (hunk) {
      // "\ No newline at end of file" annotates the line above rather than being one.
      if (line.startsWith("\\")) {
        continue;
      }
      if (line.startsWith("+")) {
        hunk.lines.push({
          kind: "add",
          text: line.slice(1),
          oldNumber: null,
          newNumber,
        });
        newNumber++;
        file.added++;
        continue;
      }
      if (line.startsWith("-")) {
        hunk.lines.push({
          kind: "del",
          text: line.slice(1),
          oldNumber,
          newNumber: null,
        });
        oldNumber++;
        file.removed++;
        continue;
      }
      if (line.startsWith(" ")) {
        hunk.lines.push({
          kind: "context",
          text: line.slice(1),
          oldNumber,
          newNumber,
        });
        oldNumber++;
        newNumber++;
        continue;
      }
      // Anything else ends the hunk: the next `@@`, the next file's headers, or the
      // blank line that terminates the diff.
      hunk = null;
    }

    const hunkStart = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkStart) {
      oldNumber = parseInt(hunkStart[1] ?? "0", 10);
      newNumber = parseInt(hunkStart[2] ?? "0", 10);
      hunk = {
        header: line,
        oldStart: oldNumber,
        newStart: newNumber,
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }

    // Header lines, in the order git emits them. Each sets the status or the note; the
    // rest carry nothing this needs. Reached only outside a hunk, per the block above.
    if (line.startsWith("new file")) {
      file.status = "A";
    } else if (line.startsWith("deleted file")) {
      file.status = "D";
    } else if (line.startsWith("rename from ")) {
      file.status = "R";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("copy from ")) {
      file.status = "C";
      file.oldPath = line.slice("copy from ".length);
    } else if (line.startsWith("Binary files ")) {
      file.previewMediaType = imageMediaType(file.path);
      file.note = "Binary file — no text to show.";
    }
  }

  for (const parsed of files) {
    if (!parsed.hunks.length && !parsed.note) {
      parsed.note =
        parsed.status === "R" || parsed.status === "C"
          ? "Renamed with no change to its contents."
          : "No textual changes.";
    }
  }
  return files;
}
