/**
 * Uncommitted changes: what is dirty, which of it goes in, and the commit form.
 *
 * The commit form lives here rather than in the commit panel because the changes being
 * committed are listed directly above it — a panel would put the message a selection away
 * from the files it describes.
 *
 * The message inputs are controlled, which is what makes the browser host's five-second
 * poll invisible: React reconciles the existing input rather than replacing it, so the
 * value survives and the caret stays put. The previous version had to mirror every
 * keystroke into module state and restore `selectionStart` after each render, because a
 * poll landing mid-sentence destroyed the draft and the commit was then refused for having
 * no summary.
 */
import type { FileChange } from "#git/snapshot";
import type { RenderModel, UICommit } from "#ui/renderModel";
import { useRef } from "react";
import { classes } from "../classes";
import { canAbsorb } from "../model/actionGuards.mjs";
import { truncate } from "../model/commits.mjs";
import {
  chosenLineCount,
  goesInWhole,
  type LineChoice,
} from "../model/lineChoice.mjs";
import {
  COMMIT_BODY_HEIGHT_KEY,
  COMMIT_BODY_MIN_HEIGHT,
} from "../model/messageHeight.mjs";
import { useStoredHeight } from "../state/useStoredHeight";
import { AbsorbPreview, type AbsorbPlan } from "./AbsorbPreview";
import { Button, ButtonRow } from "./Button";
import { DiscardConfirm } from "./DiscardConfirm";
import { FieldLabel, TextArea, TextInput } from "./Field";
import { PickableFileRow } from "./FileRow";

export type WorkingCopyProps = {
  model: RenderModel;
  pickedPaths: Set<string>;
  /** The lines left out of each partly chosen path. */
  choices: ReadonlyMap<string, LineChoice>;
  /** The commit *Amend into…* would write to, defaulting to HEAD. */
  amendTarget: UICommit | null;
  commitDraft: { subject: string; body: string };
  commitFormOpen: boolean;
  committing: boolean;
  absorbPlan: AbsorbPlan | null;
  absorbing: boolean;
  /** The change a discard is waiting to be confirmed for, or null when none is. */
  discardTarget: FileChange | null;
  discarding: boolean;
  onPick: (path: string, picked: boolean) => void;
  onToggleAll: () => void;
  /** Every uncommitted change at once, in the overlay the commit rows open. */
  onViewChanges: () => void;
  /** One change in that overlay, where its lines are chosen. */
  onChooseLines: (path: string) => void;
  /** One change in the diff editor, or the overlay when the host has none. */
  onOpenDiff: (file: FileChange, background: boolean) => void;
  onRequestDiscard: (file: FileChange) => void;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
  onDraftChange: (draft: { subject: string; body: string }) => void;
  onOpenCommitForm: () => void;
  onCancelCommitForm: () => void;
  onCommit: () => void;
  onAmendInto: () => void;
  onPreviewAbsorb: () => void;
  onApplyAbsorb: () => void;
  onCancelAbsorb: () => void;
};

export function WorkingCopy({
  model,
  pickedPaths,
  choices,
  amendTarget,
  commitDraft,
  commitFormOpen,
  committing,
  absorbPlan,
  absorbing,
  discardTarget,
  discarding,
  onPick,
  onToggleAll,
  onViewChanges,
  onChooseLines,
  onOpenDiff,
  onRequestDiscard,
  onConfirmDiscard,
  onCancelDiscard,
  onDraftChange,
  onOpenCommitForm,
  onCancelCommitForm,
  onCommit,
  onAmendInto,
  onPreviewAbsorb,
  onApplyAbsorb,
  onCancelAbsorb,
}: WorkingCopyProps) {
  const draftBody = useRef<HTMLTextAreaElement>(null);
  const draftBodyHeight = useStoredHeight(
    draftBody,
    COMMIT_BODY_HEIGHT_KEY,
    COMMIT_BODY_MIN_HEIGHT
  );

  const uncommitted: FileChange[] = model.uncommitted;
  const count = uncommitted.length;
  const picked = uncommitted.filter(file => pickedPaths.has(file.path)).length;
  const allPicked = picked === count;
  const partly = choices.size;
  const conflicted = Boolean(model.conflict);
  // Nothing selected means nothing to commit or amend, whatever else is true.
  const nothingPicked = picked === 0;

  return (
    <div id="wc" className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        {/*
          Dashed rather than solid: these changes are not committed to anything yet, and the
          border says so before the label is read.

          A button, because it opens every uncommitted change in the overlay — the same reading
          a commit's *View changes* gives, for the changes no commit holds. It kept `cursor-pointer`
          through several versions without a click behind it, so the pointer was already promising
          this.
        */}
        <button
          type="button"
          id="btn-wc-changes"
          className="chip inline-flex cursor-pointer items-center gap-1.5 rounded-shell border border-dashed border-edge bg-transparent px-2 py-0.75 font-[inherit] text-body/auto text-mod"
          title="Read every uncommitted change against HEAD"
          onClick={event => {
            event.stopPropagation();
            onViewChanges();
          }}
        >
          {`✎ ${count} uncommitted change${count > 1 ? "s" : ""}`}
        </button>
        <span className="text-meta text-muted" id="wc-selcount">
          {allPicked && !partly
            ? ""
            : `${picked} of ${count} selected${partly ? `, ${partly} in part` : ""}`}
        </span>
        <Button
          size="small"
          id="btn-commit"
          disabled={nothingPicked || conflicted}
          title="Commit the ticked changes as a new commit on top"
          onClick={event => {
            event.stopPropagation();
            onOpenCommitForm();
          }}
        >
          Commit…
        </Button>
        {/*
          Naming the destination matters: without it the target is invisible until the
          toast reports it, and the one invalid case — a commit on a branch the working
          copy does not descend from — is only discoverable by clicking and reading an
          error.
        */}
        <Button
          size="small"
          id="btn-amend-into"
          disabled={nothingPicked || conflicted}
          title={
            amendTarget && !amendTarget.isHead
              ? `Fold the ticked changes into “${amendTarget.subject}”, keeping its message`
              : "Fold the ticked changes into the commit you are on, keeping its message"
          }
          onClick={event => {
            event.stopPropagation();
            onAmendInto();
          }}
        >
          {amendTarget && !amendTarget.isHead
            ? `Amend into ${truncate(amendTarget.subject, 24)}…`
            : "Amend into HEAD…"}
        </Button>
        {/*
          Absorb ignores the checkboxes — it attributes every change by the lines it touches —
          so `nothingPicked` is not part of its guard, unlike its two neighbours. `canAbsorb`
          is shared with the `a` shortcut.
        */}
        <Button
          size="small"
          id="btn-absorb"
          disabled={!canAbsorb(model)}
          title="Fold each change into the commit whose lines it touches"
          onClick={event => {
            event.stopPropagation();
            onPreviewAbsorb();
          }}
        >
          Absorb…
        </Button>
        {count > 1 ? (
          <Button
            size="small"
            id="btn-pick-all"
            onClick={event => {
              event.stopPropagation();
              onToggleAll();
            }}
          >
            {allPicked ? "Select none" : "Select all"}
          </Button>
        ) : null}
      </div>
      <AbsorbPreview
        plan={absorbPlan}
        applying={absorbing}
        onApply={onApplyAbsorb}
        onCancel={onCancelAbsorb}
      />
      <DiscardConfirm
        file={discardTarget}
        discarding={discarding}
        onConfirm={onConfirmDiscard}
        onCancel={onCancelDiscard}
      />
      {/* Always visible once there is a selection to make: hiding the checkboxes behind the
          chip would mean clicking twice to answer "what goes in?", which is the question this
          row exists to ask. */}
      <div className="files mt-1.5 ml-2">
        {uncommitted.map(file => {
          const choice = choices.get(file.path);
          return (
            <PickableFileRow
              key={file.path}
              file={file}
              state={
                !pickedPaths.has(file.path) ? "none" : choice ? "some" : "all"
              }
              chosenLines={
                choice
                  ? { chosen: chosenLineCount(choice), total: choice.total }
                  : null
              }
              onPick={isPicked => onPick(file.path, isPicked)}
              onChooseLines={
                goesInWhole(file) ? null : () => onChooseLines(file.path)
              }
              onOpenDiff={background => onOpenDiff(file, background)}
              onDiscard={() => onRequestDiscard(file)}
            />
          );
        })}
      </div>
      <div
        id="commit-form"
        className={classes(
          "mt-2 mb-1 ml-2 max-w-155",
          commitFormOpen ? "block" : "hidden"
        )}
      >
        <FieldLabel>Summary</FieldLabel>
        <TextInput
          className="my-0.5 mb-1.5 py-1.25 text-body"
          id="commit-subject"
          placeholder="What this change does"
          value={commitDraft.subject}
          onChange={event =>
            onDraftChange({ ...commitDraft, subject: event.target.value })
          }
        />
        <FieldLabel>Description</FieldLabel>
        {/* `min-h-16` has to stay in step with `COMMIT_BODY_MIN_HEIGHT`: the grip cannot drag
            the box below it, and a stored height is clamped to the same floor. */}
        <TextArea
          className="my-0.5 mb-1.5 min-h-16 py-1.25 text-body"
          id="commit-body"
          ref={draftBody}
          style={{ height: draftBodyHeight }}
          title="Drag the bottom-right corner to resize. The height is remembered."
          placeholder="Why it is needed (optional)"
          value={commitDraft.body}
          onChange={event =>
            onDraftChange({ ...commitDraft, body: event.target.value })
          }
        />
        <ButtonRow className="mt-0.5">
          {/*
            An empty summary disables the button rather than being reported after the click.
            `commitPicked` still refuses one, because a paste of whitespace can arrive
            between paint and click, but a dead button is the cheaper answer to a form the
            reader has not filled in yet.
          */}
          <Button
            id="btn-commit-do"
            variant="primary"
            disabled={
              nothingPicked ||
              conflicted ||
              !commitDraft.subject.trim() ||
              committing
            }
            onClick={event => {
              event.stopPropagation();
              onCommit();
            }}
          >
            {committing ? "Committing…" : "Commit"}
          </Button>
          <Button
            id="btn-commit-cancel"
            onClick={event => {
              event.stopPropagation();
              onCancelCommitForm();
            }}
          >
            Cancel
          </Button>
        </ButtonRow>
      </div>
    </div>
  );
}
