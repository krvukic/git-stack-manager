/**
 * One file of the changes overlay: its heading, its counts, and its hunks, or the pictures when
 * it is an image.
 *
 * For the uncommitted changes the same view is where lines are chosen. Each changed line gets a
 * box in a gutter of its own, each hunk and the file one that covers all of theirs, and
 * shift-clicking a line's box sets every line between it and the last one clicked. Nothing is
 * committed from here. The choice is recorded against the working-copy row, so the sidebar's
 * buttons and the overlay's footer take the same lines.
 */
import type { ImagePreview, ImageSide } from "#core/media";
import type { DiffHunk, FileDiff } from "#git/diff";
import type { WorkingFileDiff } from "#history/partialSelection";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { classes } from "../classes";
import {
  changedLineKeys,
  checkState,
  lineKey,
  rangeBetween,
  withLines,
  type CheckState,
  type LineChoice,
} from "../model/lineChoice.mjs";
import { rpc } from "../rpc";
import { Checkbox } from "./Checkbox";

/** What choosing needs from `useLineChoices`, stable across renders so each file can memoize. */
export type Chooser = {
  pickFile: (path: string, picked: boolean) => void;
  setFileChoice: (
    path: string,
    fingerprint: string,
    excluded: ReadonlySet<string>,
    total: number
  ) => void;
};

const NO_LINES: ReadonlySet<string> = new Set();

/**
 * Both versions of an image, fetched when the reader scrolls to them.
 *
 * On sight rather than with the diff, because the blobs travel as base64 and a commit that
 * adds a folder of icons would otherwise hold the whole overlay behind a megabyte of them.
 * Once fetched, the observer is dropped: for a commit the reference is a sha and a path, so the
 * answer cannot change, and for the working copy a picture edited while the overlay is open is
 * worth less than re-fetching every image on every scroll.
 */
type PreviewState =
  | { state: "waiting" }
  | { state: "error"; error: string }
  | { state: "ready"; preview: ImagePreview };

function ImageDiffView({ sha, file }: { sha: string | null; file: FileDiff }) {
  const [state, setState] = useState<PreviewState>({ state: "waiting" });
  const anchor = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = anchor.current;
    if (!element) {
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) {
        return;
      }
      // Before the request, not after: a second intersection while it is in flight would
      // otherwise fetch the same blobs again.
      observer.disconnect();
      void rpc<ImagePreview>("imagePreview", {
        // Left off for the working copy, where the after side is the file on disk rather than
        // any commit's blob.
        sha: sha ?? undefined,
        path: file.path,
        oldPath: file.oldPath,
      }).then(response => {
        setState(
          response.ok && response.data
            ? { state: "ready", preview: response.data }
            : {
                state: "error",
                error: response.ok
                  ? "The host sent no preview."
                  : response.error,
              }
        );
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sha, file.path, file.oldPath]);

  return (
    // `min-h-8` so the block has a box to be seen in before anything is drawn in it; a
    // zero-height element never intersects, and the fetch would never start.
    <div className="dfimage min-h-8 p-2" ref={anchor}>
      {state.state === "ready" ? (
        <div className="flex flex-wrap items-start justify-center gap-4">
          {/* Absent sides are dropped rather than drawn empty: an addition has no parent
              version, and a lone picture under "After" says that better than a placeholder
              beside it. */}
          {state.preview.before ? (
            <ImageSideView label="Before" side={state.preview.before} />
          ) : null}
          {state.preview.after ? (
            <ImageSideView label="After" side={state.preview.after} />
          ) : null}
        </div>
      ) : (
        <div className="text-body text-muted">
          {state.state === "error" ? state.error : "Loading…"}
        </div>
      )}
    </div>
  );
}

/** One version of the image, captioned with which side it is and how large. */
function ImageSideView({ label, side }: { label: string; side: ImageSide }) {
  return (
    <figure className="flex min-w-0 flex-col items-center gap-1">
      {/*
        `bg-card` behind the picture, so a transparent PNG reads as a picture rather than as a
        hole in the panel. `object-contain` with both caps set keeps a screenshot inside the
        overlay without distorting it.
      */}
      <img
        className="max-h-96 max-w-full rounded-sm border border-edge bg-card object-contain"
        src={side.dataUri}
        alt={`${label} version of the image`}
      />
      <figcaption className="text-meta text-muted">
        {`${label} — ${describeSize(side.bytes)}`}
      </figcaption>
    </figure>
  );
}

/** Bytes as the caption prints them: kilobytes, since an icon in bytes reads as noise. */
function describeSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A wash of the line's own colour behind it, and that colour on the text. The line numbers stay
 * muted either way: they are a coordinate, not part of the change. `.ln` carries `text-muted`
 * to say so, so nothing here needs to leave them out.
 */
const LINE_KINDS: Record<string, string> = {
  add: "add bg-add/12 [&>.mark]:text-add [&>.code]:text-add",
  del: "del bg-del/12 [&>.mark]:text-del [&>.code]:text-del",
  context: "context",
};

/**
 * A line left out: no wash, and its colour at half strength, so the reader still sees what the
 * line is and that it stays behind. Its own table rather than classes on top of `LINE_KINDS`,
 * since two background utilities on one element leave the winner to stylesheet order.
 */
const EXCLUDED_LINE_KINDS: Record<string, string> = {
  add: "add excluded [&>.mark]:text-add/50 [&>.code]:text-add/50",
  del: "del excluded [&>.mark]:text-del/50 [&>.code]:text-del/50",
};

/** How a hunk's lines are chosen, when they can be. */
type HunkChoosing = {
  excluded: ReadonlySet<string>;
  onToggleHunk: (keys: string[], chosen: boolean) => void;
  onToggleLine: (key: string, shiftKey: boolean) => void;
};

/**
 * One hunk: its `@@` header, then a line per change with both gutters.
 *
 * Two gutters rather than one, because a diff read without them cannot answer "which line
 * is this in the file now?" — the question a reader has when they are about to go and edit
 * it. A blank cell marks a line as existing on only one side.
 */
function HunkView({
  hunk,
  choosing,
}: {
  hunk: DiffHunk;
  choosing: HunkChoosing | null;
}) {
  const keys = useMemo(() => changedLineKeys([hunk]), [hunk]);
  return (
    // `[&+&]:border-t` draws a line only *between* hunks, so the first sits flush against the
    // file's own heading.
    <div className="dfhunk [&+&]:border-t [&+&]:border-t-edge">
      <div className="flex items-center gap-2 bg-accent/8 px-2 py-0.75 font-[monospace] text-meta text-muted">
        {choosing ? (
          <Checkbox
            className="pickhunk"
            state={checkState(keys, choosing.excluded)}
            label="Choose every changed line of this hunk"
            onToggle={checked => choosing.onToggleHunk(keys, checked)}
          />
        ) : null}
        <span>{hunk.header}</span>
      </div>
      {hunk.lines.map((line, index) => {
        const key = lineKey(line);
        const leftOut = key !== null && Boolean(choosing?.excluded.has(key));
        return (
          // A grid, so the two gutters stay aligned however long the code is;
          // `whitespace-pre-wrap` on the code alone lets a long line wrap without breaking that
          // alignment.
          <div
            className={classes(
              "dfline grid font-[monospace] text-body/diff",
              choosing
                ? "grid-cols-[20px_42px_42px_14px_1fr]"
                : "grid-cols-[42px_42px_14px_1fr]",
              (leftOut ? EXCLUDED_LINE_KINDS : LINE_KINDS)[line.kind]
            )}
            key={index}
          >
            {choosing ? (
              <span className="flex items-center justify-center">
                {key === null ? null : (
                  <Checkbox
                    className="pickline"
                    state={leftOut ? "none" : "all"}
                    label={`Choose line ${key}`}
                    onToggle={(_, shiftKey) =>
                      choosing.onToggleLine(key, shiftKey)
                    }
                  />
                )}
              </span>
            ) : null}
            <span className="ln pr-2 text-right text-muted select-none">
              {line.oldNumber ?? ""}
            </span>
            <span className="ln pr-2 text-right text-muted select-none">
              {line.newNumber ?? ""}
            </span>
            <span className="mark text-center select-none">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            <span className="code wrap-anywhere whitespace-pre-wrap">
              {line.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Why a working-copy file can only go in whole, or null when its lines can be chosen. */
function wholeReason(
  file: WorkingFileDiff,
  rowPath: string | null
): string | null {
  if (rowPath === null) {
    return "Not in the list of changes yet. Refresh to choose it.";
  }
  if (rowPath !== file.path) {
    return `Part of ${rowPath}, which goes in whole.`;
  }
  return file.wholeFileReason;
}

function FileView({
  sha,
  file,
  heading = null,
  reason = null,
  choosing = null,
}: {
  sha: string | null;
  file: FileDiff;
  heading?: React.ReactNode;
  reason?: string | null;
  choosing?: HunkChoosing | null;
}) {
  return (
    <div className="dffile mb-3 rounded-card border border-edge">
      <div className="flex items-center gap-2 border-b border-b-edge bg-card px-2 py-1.25 font-[monospace] text-body">
        {heading}
        <span className={`st ${file.status}`}>{file.status}</span>
        {/* `wrap-anywhere`, not truncation: a path here is the heading of the block below it,
            and a reader needs all of it. */}
        <span className="flex-1 wrap-anywhere">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="inline-flex flex-none gap-1.5 text-meta">
          {file.added ? (
            <span className="text-add">{`+${file.added}`}</span>
          ) : null}
          {file.removed ? (
            <span className="text-del">{`−${file.removed}`}</span>
          ) : null}
        </span>
      </div>
      {reason ? (
        <div className="whole border-b border-b-edge px-2 py-1 text-meta text-muted">
          {reason}
        </div>
      ) : null}
      {file.previewMediaType ? (
        <ImageDiffView sha={sha} file={file} />
      ) : file.note ? (
        // Why there are no hunks, when there are none: a binary git cannot draw, or a rename
        // with no content change. A viewer needs this to say something other than "no changes".
        <div className="p-2 text-body text-muted">{file.note}</div>
      ) : (
        file.hunks.map((hunk, index) => (
          <HunkView key={index} hunk={hunk} choosing={choosing} />
        ))
      )}
    </div>
  );
}

/** A working-copy file's place in the selection. */
type FileChoosing = {
  chooser: Chooser;
  /** The working-copy row the file belongs to, or null when the list does not show it. */
  rowPath: string | null;
  picked: boolean;
  /** The lines left out, when some are. */
  choice: LineChoice | undefined;
};

/**
 * The checkboxes' state for one working-copy file, and what each click does to it.
 *
 * A choice counts only while it was made on the diff on screen. Once the file has changed, the
 * refresh check drops it, and until then the file reads as whole rather than showing old
 * numbers against new lines.
 */
function useFileChoosing(
  file: WorkingFileDiff,
  { chooser, rowPath, picked, choice }: FileChoosing
): { state: CheckState; reason: string | null; hunks: HunkChoosing | null } {
  const keys = useMemo(() => changedLineKeys(file.hunks), [file]);
  const anchor = useRef<string | null>(null);
  const reason = wholeReason(file, rowPath);
  const current = choice?.fingerprint === file.fingerprint ? choice : undefined;
  const excluded = useMemo(
    () => (picked ? (current?.excluded ?? NO_LINES) : new Set(keys)),
    [current, keys, picked]
  );

  const hunks = useMemo(() => {
    if (reason !== null || !keys.length) {
      return null;
    }
    const setExcluded = (next: ReadonlySet<string>) =>
      chooser.setFileChoice(file.path, file.fingerprint, next, keys.length);
    return {
      excluded,
      onToggleHunk: (hunkKeys: string[], chosen: boolean) =>
        setExcluded(withLines(excluded, hunkKeys, chosen)),
      onToggleLine: (key: string, shiftKey: boolean) => {
        const range = shiftKey
          ? rangeBetween(keys, anchor.current, key)
          : [key];
        anchor.current = key;
        // Every line in the range takes the state the clicked one moves to.
        setExcluded(withLines(excluded, range, excluded.has(key)));
      },
    };
  }, [chooser, excluded, file, keys, reason]);

  return {
    state: !picked ? "none" : current ? "some" : "all",
    reason,
    hunks,
  };
}

function WorkingFileView({
  sha,
  file,
  choosing,
}: {
  sha: string | null;
  file: WorkingFileDiff;
  choosing: FileChoosing;
}) {
  const { state, reason, hunks } = useFileChoosing(file, choosing);
  const { chooser, rowPath } = choosing;
  return (
    <FileView
      sha={sha}
      file={file}
      heading={
        <Checkbox
          className="pickfile"
          state={state}
          disabled={rowPath === null}
          label={`Choose every change to ${file.path}`}
          // The row is what a whole file's box ticks, and ticking it drops any lines left out.
          onToggle={checked => rowPath && chooser.pickFile(rowPath, checked)}
        />
      }
      reason={file.hunks.length ? reason : null}
      choosing={hunks}
    />
  );
}

/**
 * A commit's file is read and never chosen from, and passes no `chooser`. Memoized, since a click
 * re-renders the overlay and only the file clicked in has anything new to draw; the props are
 * flat so the comparison sees that.
 */
export const FileDiffView = memo(function FileDiffView({
  sha,
  file,
  chooser,
  rowPath,
  picked,
  choice,
}: {
  sha: string | null;
  file: FileDiff | WorkingFileDiff;
  chooser: Chooser | null;
  rowPath: string | null;
  picked: boolean;
  choice: LineChoice | undefined;
}) {
  if (!chooser || !("fingerprint" in file)) {
    return <FileView sha={sha} file={file} />;
  }
  return (
    <WorkingFileView
      sha={sha}
      file={file}
      choosing={{ chooser, rowPath, picked, choice }}
    />
  );
});
