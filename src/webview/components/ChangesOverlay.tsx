/**
 * Every change in a commit, as one scrollable read-only view — Sapling's "View Changes in
 * <hash>".
 *
 * Shared with the per-file diff rather than written twice: `onlyPath` narrows it to one
 * file, which is what the web host falls back to when asked for a diff editor it does not
 * have. The rendering is the same either way, so a change to how a hunk looks lands in both.
 *
 * Modal and near-full-screen: a diff is the thing being read, so it gets the room, unlike
 * the design and legend drawers which are consulted beside the tree.
 */
import type { ImagePreview, ImageSide } from "#core/media";
import type { CommitDiff, DiffHunk, FileDiff } from "#git/diff";
import { useEffect, useRef, useState } from "react";
import { classes } from "../classes";
import { rpc } from "../rpc";
import { Button } from "./Button";
import { Modal } from "./Modal";

export type ChangesState =
  | { state: "loading"; title: string }
  | { state: "error"; title: string; error: string }
  | { state: "ready"; title: string; sha: string; files: FileDiff[] }
  | null;

/** One file's heading, its counts, and its hunks. */
function FileDiffView({ sha, file }: { sha: string; file: FileDiff }) {
  return (
    <div className="dffile mb-3 rounded-card border border-edge">
      <div className="flex items-center gap-2 border-b border-b-edge bg-card px-2 py-1.25 font-[monospace] text-body">
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
      {file.previewMediaType ? (
        <ImageDiffView sha={sha} file={file} />
      ) : file.note ? (
        // Why there are no hunks, when there are none: a binary git cannot draw, or a rename
        // with no content change. A viewer needs this to say something other than "no changes".
        <div className="p-2 text-body text-muted">{file.note}</div>
      ) : (
        file.hunks.map((hunk, index) => <HunkView key={index} hunk={hunk} />)
      )}
    </div>
  );
}

/**
 * Both versions of an image, fetched when the reader scrolls to them.
 *
 * On sight rather than with the diff, because the blobs travel as base64 and a commit that
 * adds a folder of icons would otherwise hold the whole overlay behind a megabyte of them.
 * Once fetched, the observer is dropped — the reference is a sha and a path, so the answer
 * cannot change while the overlay is open.
 */
type PreviewState =
  | { state: "waiting" }
  | { state: "error"; error: string }
  | { state: "ready"; preview: ImagePreview };

function ImageDiffView({ sha, file }: { sha: string; file: FileDiff }) {
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
        sha,
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
 * One hunk: its `@@` header, then a line per change with both gutters.
 *
 * Two gutters rather than one, because a diff read without them cannot answer "which line
 * is this in the file now?" — the question a reader has when they are about to go and edit
 * it. A blank cell marks a line as existing on only one side.
 */
function HunkView({ hunk }: { hunk: DiffHunk }) {
  return (
    // `[&+&]:border-t` draws a line only *between* hunks, so the first sits flush against the
    // file's own heading.
    <div className="dfhunk [&+&]:border-t [&+&]:border-t-edge">
      <div className="bg-accent/8 px-2 py-0.75 font-[monospace] text-meta text-muted">
        {hunk.header}
      </div>
      {hunk.lines.map((line, index) => (
        // A grid, so the two gutters stay aligned however long the code is; `whitespace-pre-wrap`
        // on the code alone lets a long line wrap without breaking that alignment.
        <div
          className={classes(
            "dfline grid grid-cols-[42px_42px_14px_1fr] font-[monospace] text-body/diff",
            LINE_KINDS[line.kind]
          )}
          key={index}
        >
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
      ))}
    </div>
  );
}

export function ChangesOverlay({
  changes,
  onClose,
}: {
  changes: ChangesState;
  onClose: () => void;
}) {
  return (
    <Modal id="changes" hidden={!changes}>
      <div className="flex flex-none items-center gap-2 border-b border-b-edge px-3 py-2 font-[monospace] text-body">
        <span id="changes-title">{changes?.title ?? ""}</span>
        <span className="flex-1" />
        <Button id="btn-changes-close" onClick={onClose}>
          Close
        </Button>
      </div>
      <div id="changes-body" className="flex-1 overflow-y-auto px-3 py-2">
        {changes?.state === "loading" ? (
          <div className="text-muted">Loading…</div>
        ) : null}
        {changes?.state === "error" ? (
          <div className="text-muted">{changes.error}</div>
        ) : null}
        {changes?.state === "ready" ? (
          changes.files.length ? (
            changes.files.map(file => (
              <FileDiffView key={file.path} sha={changes.sha} file={file} />
            ))
          ) : (
            <div className="text-muted">No changes in this commit.</div>
          )
        ) : null}
      </div>
    </Modal>
  );
}

export type { CommitDiff };
