/**
 * One file in a list: its status letter, its path, and what you can do with it.
 *
 * Two shapes. A `pickable` row carries the checkbox that decides whether the change goes into
 * the next commit or amend; a plain row is a link to the file, which is what every commit's
 * file list wants.
 */
import type { FileChange } from "#git/snapshot";
import { classes } from "../classes";
import { backgroundModifierName, opensInBackground } from "../model/clicks.mjs";
import type { FileClick } from "../model/design.mjs";
import { IconButton } from "./Button";

/**
 * The key that opens a file in a background tab, named once per load.
 *
 * `navigator` cannot change while the page lives, so the tooltips below hold the name rather
 * than recomputing it per row — a commit touching two hundred files renders two hundred of them.
 */
const BACKGROUND_KEY = backgroundModifierName(navigator.userAgent);

/** The shell every file row shares. `group/file` is what the hover actions watch. */
const FILE_ROW =
  "file group/file flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-0.75 hover:bg-card";

/**
 * The status letter, coloured by what happened to the file.
 *
 * git's own vocabulary, in the colours the editor uses for it in its own Source Control view,
 * so a reader who knows one knows the other. `?` is an untracked file, which git reports
 * separately but which reads as an addition here.
 */
const STATUS_COLOURS: Record<string, string> = {
  M: "text-mod",
  A: "text-add",
  "?": "text-add",
  D: "text-del",
  R: "text-accent",
  C: "text-accent",
  /** Git's letter for an unmerged path, which is always an error here. */
  U: "text-err",
};

function StatusLetter({
  status,
  onClick,
}: {
  status: string;
  onClick?: (event: React.MouseEvent) => void;
}) {
  return (
    <span
      className={classes(
        // `st` and the letter itself are how the end-to-end suite reads a row's state.
        "st",
        status,
        "w-3.5 flex-none text-center font-[monospace] font-bold",
        STATUS_COLOURS[status] ?? "text-fg"
      )}
      onClick={onClick}
    >
      {status}
    </span>
  );
}

/**
 * The path, truncated from the *left*.
 *
 * `direction: rtl` is what does that: a path that will not fit loses its leading directories
 * rather than its filename, which is the part a reader is looking for. `text-left` puts it back
 * against the left edge, which `rtl` would otherwise give up.
 */
function FilePath({ path, className }: { path: string; className?: string }) {
  return (
    <span
      className={classes("fp truncate text-left [direction:rtl]", className)}
      title={path}
    >
      {path}
    </span>
  );
}

export function PickableFileRow({
  file,
  picked,
  onPick,
  onDiscard,
}: {
  file: FileChange;
  picked: boolean;
  onPick: (picked: boolean) => void;
  onDiscard: () => void;
}) {
  return (
    // `pl-0`: this row starts at its checkbox, unlike a commit's file row, which is indented to
    // line up under the panel's heading.
    <div className={classes(FILE_ROW, "pl-0")}>
      {/*
        The row's own click opens the file, so the box stops the event — ticking a change must
        not also open an editor tab for it.
      */}
      <input
        type="checkbox"
        className="pick mr-0.5 flex-none cursor-pointer"
        checked={picked}
        onClick={event => event.stopPropagation()}
        onChange={event => onPick(event.target.checked)}
      />
      <StatusLetter
        status={file.status}
        onClick={event => {
          event.stopPropagation();
          onPick(!picked);
        }}
      />
      {/* The path opens the file, so the label must not swallow the click; only the box and the
          status letter toggle the selection. */}
      <FilePath path={file.path} className="flex-1 cursor-pointer" />
      <DiscardAction onDiscard={onDiscard} />
    </div>
  );
}

/**
 * Throw one change away — the icon Source Control puts in the same place, for the same reason: a
 * change you did not mean to make is per-file, and the alternative was a terminal.
 *
 * Its own component rather than a third `kind` on `FileAction`, because the two openers read the
 * modifier and this must not. There is no quieter variant of deleting someone's work, so the
 * click always goes through the confirmation the caller opens.
 */
function DiscardAction({ onDiscard }: { onDiscard: () => void }) {
  const description = "Discard this change, restoring the file";
  return (
    <IconButton
      className="discard"
      aria-label={description}
      data-tip={description}
      onClick={(event: React.MouseEvent) => {
        event.stopPropagation();
        onDiscard();
      }}
    >
      {/* A turning arrow, which is what every editor's revert control draws. */}
      ⟲
    </IconButton>
  );
}

/**
 * Per-file actions live on the row, revealed on hover — the way Sapling puts "open diff" beside
 * each file and Source Control puts its icons in the row's gutter. A header button acting on a
 * "selected" file meant clicking one thing to aim and another to fire, and the aiming click
 * already opened a tab.
 *
 * All three openings — the row, the diff icon, the file icon — read the modifier, so holding it
 * leaves the new tab behind this panel: reading three files means three clicks, and an editor that
 * takes focus on each one sends the reader back here between them.
 */
export function CommitFileRow({
  file,
  fileClick,
  onOpenDiff,
  onOpenFile,
}: {
  file: FileChange;
  fileClick: FileClick;
  onOpenDiff: (background: boolean) => void;
  onOpenFile: (background: boolean) => void;
}) {
  return (
    <div
      className={classes(FILE_ROW, "relative")}
      data-path={file.path}
      // The row itself runs whichever shortcut the design chose, so a plain click keeps working
      // for anyone who does not go looking for the icons.
      onClick={event => {
        const background = opensInBackground(event, navigator.userAgent);
        if (fileClick === "diff") {
          onOpenDiff(background);
          return;
        }
        onOpenFile(background);
      }}
    >
      <StatusLetter status={file.status} />
      <FilePath path={file.path} className="flex-1" />
      <FileAction
        kind="diff"
        description={`Open diff view — this commit against its parent. Hold ${BACKGROUND_KEY} to open it in a background tab.`}
        onRun={onOpenDiff}
      />
      <FileAction
        kind="file"
        description={`Open the current file in an editor. Hold ${BACKGROUND_KEY} to open it in a background tab.`}
        onRun={onOpenFile}
      />
    </div>
  );
}

/**
 * One of a row's hover actions.
 *
 * Glyphs rather than words because the row is a file path first: a pair of labelled buttons per
 * row would take more width than the paths they belong to. Each still carries its own
 * description, which the tooltip layer shows on hover.
 */
function FileAction({
  kind,
  description,
  onRun,
}: {
  kind: "diff" | "file";
  description: string;
  onRun: (background: boolean) => void;
}) {
  return (
    <IconButton
      className={kind}
      aria-label={description}
      data-tip={description}
      onClick={(event: React.MouseEvent) => {
        // The row has its own click, and it would fire straight after this one.
        event.stopPropagation();
        onRun(opensInBackground(event, navigator.userAgent));
      }}
    >
      {/* ⇄ for a diff — two sides compared — and a document glyph for the file itself. */}
      {kind === "diff" ? "⇄" : "🗎"}
    </IconButton>
  );
}

/** A conflicted path in the rebase banner. Read-only: the banner's buttons act on it. */
export function ConflictFileRow({ path }: { path: string }) {
  return (
    <div className={FILE_ROW}>
      <StatusLetter status="U" />
      <FilePath path={path} />
    </div>
  );
}
