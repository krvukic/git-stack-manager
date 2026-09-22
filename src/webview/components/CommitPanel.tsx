/**
 * The commit panel: identity, the message editor, the actions, and the files changed.
 *
 * Keyed by its parent on the commit's sha, so a history edit — which replaces the commit it
 * touched — remounts this with the new one, and the editor starts from what that commit now
 * says. That is what the previous version's `reselect` did by hand, and what its bug was: the
 * open panel went on describing a sha that no longer existed, and its Amend button acted on
 * that dead sha.
 *
 * The sha is enough on its own, because a sha covers the message: no rewrite can change what
 * a commit says and keep its identity. Every action that rewrites the selected commit selects
 * the replacement, which is the part that makes the key fire.
 *
 * Every mutating button is disabled while a rebase is stopped. That guard used to be
 * applied twice — once when a commit was selected and again after each render — because a
 * conflict can begin while the panel already stands open, and the second pass was missing
 * at first: Submit stayed live mid-conflict and really pushed a branch while `git status`
 * still reported an unmerged path. Derived from `model.conflict` here, so there is nothing
 * to keep in step.
 */
import type { FileChange } from "#git/snapshot";
import type { RenderModel, UICommit } from "#ui/renderModel";
import { useRef, useState } from "react";
import { gotoTarget, splitMessage, submitTarget } from "../model/commits.mjs";
import type { FileClick } from "../model/config.mjs";
import {
  DESCRIPTION_HEIGHT_KEY,
  DESCRIPTION_MIN_HEIGHT,
} from "../model/messageHeight.mjs";
import { useStoredHeight } from "../state/useStoredHeight";
import { Button, ButtonRow } from "./Button";
import { FieldLabel, TextArea, TextInput } from "./Field";
import { CommitFileRow } from "./FileRow";
import { BranchPills } from "./Pills";

/** How near the bottom-right corner a double-click counts as hitting the grip. */
const GRIP_SIZE = 18;

/**
 * Double-click the resize grip to fit the box to its text.
 *
 * A long commit body otherwise means dragging the grip, and dragging in a panel that
 * scrolls is fiddly. `scrollHeight` is the height the content wants; the floor keeps a
 * one-line message from collapsing the box to a sliver, and a second double-click returns
 * it there, so the gesture toggles rather than only ever growing.
 *
 * Scoped to the corner, not the whole box: a double-click anywhere in a textarea selects a
 * word, and stealing that everywhere would be worse than the problem. The native grip is
 * the bottom-right ~18px, which is what this matches.
 */
function fitDescriptionToText(
  textarea: HTMLTextAreaElement,
  event: React.MouseEvent
) {
  const box = textarea.getBoundingClientRect();
  const onGrip =
    event.clientX >= box.right - GRIP_SIZE &&
    event.clientY >= box.bottom - GRIP_SIZE;
  if (!onGrip) {
    return;
  }
  // Word selection is the default here, and it fires before this runs.
  event.preventDefault();
  // `scrollHeight` counts padding but not the border, and the box is `border-box`, so
  // setting height to it exactly leaves the last line a border's width short —
  // measurably still scrollable. Adding the two borders back is what makes the fit fit.
  const style = getComputedStyle(textarea);
  const borders =
    parseFloat(style.borderTopWidth || "0") +
    parseFloat(style.borderBottomWidth || "0");
  const fitted = Math.max(
    DESCRIPTION_MIN_HEIGHT,
    Math.ceil(textarea.scrollHeight + borders)
  );
  const current = Math.round(box.height);
  // Already fitted — collapse back to the floor, so the gesture is reversible.
  textarea.style.height =
    current >= fitted - 2 && current > DESCRIPTION_MIN_HEIGHT
      ? `${DESCRIPTION_MIN_HEIGHT}px`
      : `${fitted}px`;
}

/** The file list for one commit, from the request to the answer. */
export type FilesState =
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ready"; files: FileChange[] };

/**
 * What *Open all files* promises, which every state of the list answers differently.
 *
 * A disabled button still shows its description, so one sentence per state beats a single
 * count that reads as "this commit has no files" while the read is merely in flight.
 */
function openAllDescription(files: FilesState): string {
  if (files.state === "loading") {
    return "The file list is still loading.";
  }
  if (files.state === "error") {
    return "The file list did not load, so there is nothing to open.";
  }
  const count = files.files.length;
  if (!count) {
    return "This commit has no files to open.";
  }
  return `Open all ${count} ${count === 1 ? "file" : "files"} in tabs, leaving focus here.`;
}

export type CommitPanelProps = {
  commit: UICommit;
  model: RenderModel;
  files: FilesState;
  fileClick: FileClick;
  width: number;
  submitting: boolean;
  amending: boolean;
  onAmendMessage: (message: string) => void;
  onAmendWorkingChanges: () => void;
  onGoto: () => void;
  onRebase: () => void;
  onSubmit: () => void;
  onViewChanges: () => void;
  onOpenAllFiles: () => void;
  onOpenDiff: (file: FileChange, background: boolean) => void;
  onOpenFile: (file: FileChange, background: boolean) => void;
  onOpenUrl: (url: string) => void;
};

export function CommitPanel({
  commit,
  model,
  files,
  fileClick,
  width,
  submitting,
  amending,
  onAmendMessage,
  onAmendWorkingChanges,
  onGoto,
  onRebase,
  onSubmit,
  onViewChanges,
  onOpenAllFiles,
  onOpenDiff,
  onOpenFile,
  onOpenUrl,
}: CommitPanelProps) {
  const original = splitMessage(commit);
  const [subject, setSubject] = useState(original.subject);
  const [body, setBody] = useState(original.body);
  const description = useRef<HTMLTextAreaElement>(null);
  // Re-read on mount, which is once per selected commit: this panel is keyed on the sha, so
  // clicking another commit remounts it, and a height that lived only in the element would go
  // back to the default on every click.
  const storedHeight = useStoredHeight(
    description,
    DESCRIPTION_HEIGHT_KEY,
    DESCRIPTION_MIN_HEIGHT
  );

  const conflicted = Boolean(model.conflict);
  const openable = files.state === "ready" ? files.files.length : 0;
  const unchanged = subject === original.subject && body === original.body;
  const target = submitTarget(commit);
  const existing = target?.pullRequest;
  const goto = gotoTarget(commit);

  return (
    <div
      id="sidebar"
      className="open flex-none overflow-y-auto px-4 py-3.5"
      style={{ width }}
    >
      <h3 className="mb-0.5 text-title font-semibold">{`Commit ${commit.shortSha}`}</h3>
      <div className="mb-3 font-[monospace] text-meta text-muted">
        {`${commit.authorName} <${commit.authorEmail}>`}
        <br />
        {new Date(commit.date).toLocaleString()}
        <br />
        {commit.sha}
      </div>
      {commit.branchDetails?.length ? (
        <div className="branchrow">
          {commit.branchDetails.map(branch => (
            <BranchPills
              key={branch.name}
              branch={branch}
              onOpenUrl={onOpenUrl}
            />
          ))}
        </div>
      ) : null}
      <FieldLabel heading className="mt-2 mb-1">
        Message
      </FieldLabel>
      <TextInput
        className="text-title"
        id="msg-subject"
        value={subject}
        onChange={event => setSubject(event.target.value)}
      />
      <FieldLabel heading className="mt-2 mb-1">
        Description
      </FieldLabel>
      {/* 110px is both the starting height and the floor a fit-to-content shrink stops at, so
          `min-height` carries it rather than a `height` the resize grip would fight — and it
          keeps flooring the inline height a stored measurement sets. It must stay in step with
          `DESCRIPTION_MIN_HEIGHT`, which is what a restore is clamped against. */}
      <TextArea
        className="min-h-27.5 text-body"
        id="msg-body"
        ref={description}
        style={{ height: storedHeight }}
        value={body}
        title="Double-click the bottom-right corner to fit the box to the message, or drag it to resize. The height is remembered."
        onChange={event => setBody(event.target.value)}
        onDoubleClick={event => {
          if (description.current) {
            fitDescriptionToText(description.current, event);
          }
        }}
      />
      {/*
        Each action sits directly above the note explaining it, so the two read as one
        thing. Rebase used to share a row with the amend buttons while its "right-click for
        more destinations" note sat two blocks below, next to Submit's note — which made
        both notes look like they belonged to whatever was nearest.
      */}
      <ButtonRow className="mt-2">
        <Button
          id="btn-amend"
          variant="primary"
          // Amending during a rebase would rewrite the refs git is mid-replay on.
          disabled={conflicted || unchanged || amending}
          onClick={() =>
            onAmendMessage(subject + (body.trim() ? `\n\n${body}` : ""))
          }
        >
          {amending ? "Amending…" : "Amend message"}
        </Button>
        {commit.isHead && model.uncommitted.length ? (
          <Button
            id="btn-amend-wc"
            disabled={conflicted}
            title="git add -A && git commit --amend --no-edit"
            onClick={onAmendWorkingChanges}
          >
            Amend working changes
          </Button>
        ) : null}
        {!commit.isHead ? (
          <Button
            id="btn-goto"
            disabled={Boolean(goto.heldBy)}
            title={
              goto.heldBy
                ? `${goto.ref} is checked out in ${goto.heldBy}`
                : goto.detach
                  ? `Check out ${commit.shortSha}, leaving HEAD detached`
                  : `Check out ${goto.ref}`
            }
            onClick={onGoto}
          >
            Goto
          </Button>
        ) : null}
      </ButtonRow>
      <div className="mt-3.5 [&>div:last-child]:mt-1">
        <ButtonRow>
          <Button
            id="btn-rebase"
            disabled={conflicted}
            title="Replay this commit and everything above it on the trunk tip"
            onClick={onRebase}
          >
            Rebase onto trunk
          </Button>
        </ButtonRow>
        <div className="mt-2 font-[monospace] text-meta text-muted">
          Right-click a commit for more rebase destinations.
        </div>
      </div>
      <div className="mt-3.5 [&>div:last-child]:mt-1">
        {target ? (
          <>
            <ButtonRow>
              <Button
                id="btn-submit"
                variant="primary"
                // Pushing mid-rebase would publish a half-replayed stack.
                disabled={conflicted || submitting}
                title={
                  existing
                    ? `Push ${target.name} and update pull request #${existing.number} so its title and body match this message.`
                    : `Push ${target.name} and open a pull request whose title and body come from this message.`
                }
                onClick={onSubmit}
              >
                {submitting
                  ? "Submitting…"
                  : existing
                    ? `Submit → #${existing.number}`
                    : "Submit as pull request"}
              </Button>
            </ButtonRow>
            <div className="mb-3 font-[monospace] text-meta text-muted">
              Submitting always carries the message across — a force push alone
              leaves the pull request text stale.
            </div>
          </>
        ) : (
          <div className="mt-2 font-[monospace] text-meta text-muted">
            Give this commit a branch to submit it as a pull request.
          </div>
        )}
      </div>
      <FieldLabel heading className="mt-2 mb-1">
        Files changed
      </FieldLabel>
      {/*
        Both header buttons act on the whole commit. The per-file actions live on the rows
        themselves, where the file they act on is the one under the pointer.
      */}
      <ButtonRow className="mt-1.5 mb-0.5">
        <Button
          size="small"
          id="btn-view-changes"
          title="Show every change in this commit as one scrollable diff, editable when the commit is checked out."
          onClick={onViewChanges}
        >
          {`View changes in ${commit.shortSha}`}
        </Button>
        {/*
          Editing a commit's files usually means opening all of them, and the list gives one
          click per file. Every tab opens in the background, however many there are: taking
          focus per file would drag the reader through the whole set and leave them on the last.
        */}
        <Button
          size="small"
          id="btn-open-all-files"
          disabled={!openable}
          title={openAllDescription(files)}
          onClick={onOpenAllFiles}
        >
          Open all files
        </Button>
      </ButtonRow>
      <div className="mt-1" id="filelist">
        {files.state === "loading" ? (
          <span className="text-muted">Loading…</span>
        ) : null}
        {files.state === "error" ? (
          <span className="text-muted">{files.error}</span>
        ) : null}
        {files.state === "ready" && !files.files.length ? (
          <span className="text-muted">No files.</span>
        ) : null}
        {files.state === "ready"
          ? files.files.map(file => (
              <CommitFileRow
                key={file.path}
                file={file}
                fileClick={fileClick}
                onOpenDiff={background => onOpenDiff(file, background)}
                onOpenFile={background => onOpenFile(file, background)}
              />
            ))
          : null}
      </div>
    </div>
  );
}
