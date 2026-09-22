/**
 * partialSelection — commit some of a file's changed lines and leave the rest uncommitted.
 *
 * Sapling's model: every changed line starts chosen, and the reader unticks what stays behind. A
 * selection therefore records the lines left out, which keeps the common case — a file taken
 * whole — empty.
 *
 * Pure: no git and no I/O. The rebuilt content comes from the two blobs, not from the diff's
 * text, because the diff has lost bytes on the way: it was decoded as UTF-8, and its lines have
 * no endings. The diff only says which line goes where. Its text is compared with the blobs so a
 * diff that no longer describes them is refused instead of applied.
 *
 * Blobs arrive as latin1 strings, one character per byte, so a file that is not UTF-8 comes out
 * with the bytes it went in with.
 */
import { createHash } from "crypto";
import type { DiffLine, FileDiff } from "#git/diff";

/** The lines left out of one file, as the webview sends them. */
export type LineSelection = {
  path: string;
  /** `fingerprintOf` the diff the lines were chosen from. */
  fingerprint: string;
  /** Old-side numbers of removed lines left out, which the file keeps. */
  excludedRemovals: number[];
  /** New-side numbers of added lines left out, which stay uncommitted. */
  excludedAdditions: number[];
};

/** A working-copy file's diff, with what the webview needs to choose its lines. */
export type WorkingFileDiff = FileDiff & {
  fingerprint: string;
  /** Why the file goes in whole, or null when its lines can be chosen. */
  wholeFileReason: string | null;
};

/**
 * A digest of everything a selection depends on, so a file edited after its lines were chosen
 * is noticed instead of committed.
 *
 * The parsed diff rather than the file's bytes, because the diff is what the reader chose from.
 * It covers the line numbers, the texts, and the end-of-file markers, which is everything
 * `buildSelectedContent` reads.
 */
export function fingerprintOf(file: FileDiff): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        file.status,
        file.oldPath ?? null,
        file.mode,
        file.note,
        file.hunks,
      ])
    )
    .digest("hex");
}

/**
 * Attach the fingerprint and the whole-file reason to each file.
 *
 * A path listed twice is a type change — git diffs a file that became a symbolic link as a
 * deletion and an addition — and neither half alone describes it, so it goes in whole.
 */
export function describeWorkingFiles(files: FileDiff[]): WorkingFileDiff[] {
  const listings = new Map<string, number>();
  for (const file of files) {
    listings.set(file.path, (listings.get(file.path) ?? 0) + 1);
  }
  return files.map(file => ({
    ...file,
    fingerprint: fingerprintOf(file),
    wholeFileReason:
      (listings.get(file.path) ?? 0) > 1
        ? "Changed type, so it goes in whole."
        : wholeFileReason(file),
  }));
}

/**
 * Why a file's lines cannot be chosen, or null when they can.
 *
 * Each refusal is a file whose change is not a list of lines. A deletion or a rename is one
 * event, a symbolic link and a submodule diff as text that is not their content, and a file
 * with no hunks has nothing to choose from.
 */
export function wholeFileReason(file: FileDiff): string | null {
  if (file.status === "D") {
    return "Deleted, so it goes in whole.";
  }
  if (file.status === "R") {
    return "Renamed, so it goes in whole.";
  }
  if (file.status === "C") {
    return "Copied, so it goes in whole.";
  }
  if (file.mode === "120000") {
    return "A symbolic link, so it goes in whole.";
  }
  if (file.mode === "160000") {
    return "A submodule, so it goes in whole.";
  }
  if (!file.hunks.length) {
    return "No lines to choose, so it goes in whole.";
  }
  return null;
}

/**
 * The file as it would read with only the chosen lines applied to HEAD's version.
 *
 * Git's hunks decide every line: a chosen addition comes from the working file, an unchosen
 * removal stays from HEAD's, and everything outside the hunks is HEAD's. `head` and `working` are
 * the two blobs as latin1, `working` after git's clean filters, since those are the bytes the diff
 * numbered.
 */
export function buildSelectedContent(options: {
  file: FileDiff;
  head: string;
  working: string;
  selection: LineSelection;
}): string {
  const { file, selection } = options;
  const headLines = splitKeepingEnds(options.head);
  const workingLines = splitKeepingEnds(options.working);
  const excludedRemovals = new Set(selection.excludedRemovals);
  const excludedAdditions = new Set(selection.excludedAdditions);
  requireListed(file, excludedRemovals, excludedAdditions);

  const kept: string[] = [];
  // The next HEAD line to copy, numbered from one as git numbers them.
  let next = 1;
  const copyThrough = (last: number) => {
    if (last < next - 1 || last > headLines.length) {
      throw staleSelection(file.path);
    }
    kept.push(...headLines.slice(next - 1, last));
    next = last + 1;
  };

  for (const hunk of file.hunks) {
    // A hunk with no old lines names the line it follows; any other names its first line.
    const touchesOld = hunk.lines.some(line => line.kind !== "add");
    copyThrough(touchesOld ? hunk.oldStart - 1 : hunk.oldStart);
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        const text = lineAt(workingLines, line.newNumber, line, file.path);
        if (line.newNumber !== null && !excludedAdditions.has(line.newNumber)) {
          kept.push(text);
        }
        continue;
      }
      if (line.oldNumber !== next) {
        throw staleSelection(file.path);
      }
      const text = lineAt(headLines, line.oldNumber, line, file.path);
      next++;
      if (line.kind === "context" || excludedRemovals.has(line.oldNumber)) {
        kept.push(text);
      }
    }
  }
  copyThrough(headLines.length);
  return joinLines(kept);
}

/** Split into lines that keep their endings, so joining them restores the bytes exactly. */
export function splitKeepingEnds(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Join kept lines, giving a line without an ending one when another follows it.
 *
 * Only a file's last line can lack an ending. Keeping HEAD's unterminated last line and then a
 * line added after it would otherwise fuse the two into one.
 */
function joinLines(lines: string[]): string {
  const last = lines.length - 1;
  return lines
    .map((line, index) =>
      index < last && !line.endsWith("\n") ? `${line}\n` : line
    )
    .join("");
}

/** Every excluded number names a line the diff changed, or the selection is for another diff. */
function requireListed(
  file: FileDiff,
  excludedRemovals: Set<number>,
  excludedAdditions: Set<number>
): void {
  const removals = new Set<number>();
  const additions = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "del" && line.oldNumber !== null) {
        removals.add(line.oldNumber);
      } else if (line.kind === "add" && line.newNumber !== null) {
        additions.add(line.newNumber);
      }
    }
  }
  const unlisted =
    [...excludedRemovals].some(number => !removals.has(number)) ||
    [...excludedAdditions].some(number => !additions.has(number));
  if (unlisted) {
    throw staleSelection(file.path);
  }
}

/** The blob line a diff line names, refused when its text is not the one the diff shows. */
function lineAt(
  lines: string[],
  number: number | null,
  line: DiffLine,
  path: string
): string {
  const raw = number === null ? undefined : lines[number - 1];
  if (raw === undefined || !sameText(raw, line.text)) {
    throw staleSelection(path);
  }
  return raw;
}

/**
 * Whether a latin1 blob line holds the text a diff line shows.
 *
 * The blob line is decoded the way the diff was, so an invalid UTF-8 byte turns into the same
 * replacement character on both sides. A trailing carriage return is ignored, because a clean
 * filter that converts line endings leaves the blob without one that an untracked file's diff,
 * read from disk, still has.
 */
function sameText(raw: string, text: string): boolean {
  const content = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const decoded = Buffer.from(content, "latin1").toString("utf8");
  return withoutCarriageReturn(decoded) === withoutCarriageReturn(text);
}

function withoutCarriageReturn(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/** The refusal for a selection made against a diff that no longer describes the file. */
export function staleSelection(path: string): Error {
  return new Error(
    `${path} changed after its lines were chosen. Choose them again.`
  );
}
