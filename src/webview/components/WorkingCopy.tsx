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
import { classes } from "../classes";
import { canAbsorb } from "../model/actionGuards.mjs";
import { truncate } from "../model/commits.mjs";
import { AbsorbPreview, type AbsorbPlan } from "./AbsorbPreview";
import { Button, ButtonRow } from "./Button";
import { DiscardConfirm } from "./DiscardConfirm";
import { FieldLabel, TextArea, TextInput } from "./Field";
import { PickableFileRow } from "./FileRow";

export type WorkingCopyProps = {
  model: RenderModel;
  pickedPaths: Set<string>;
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
  const uncommitted: FileChange[] = model.uncommitted;
  const count = uncommitted.length;
  const picked = uncommitted.filter(file => pickedPaths.has(file.path)).length;
  const allPicked = picked === count;
  const conflicted = Boolean(model.conflict);
  // Nothing selected means nothing to commit or amend, whatever else is true.
  const nothingPicked = picked === 0;

  return (
    <div id="wc" className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Dashed rather than solid: these changes are not committed to anything yet, and the
            border says so before the label is read. */}
        <span className="chip inline-flex cursor-pointer items-center gap-1.5 rounded-shell border border-dashed border-edge px-2 py-0.75 text-body/auto text-mod">
          {`✎ ${count} uncommitted change${count > 1 ? "s" : ""}`}
        </span>
        <span className="text-meta text-muted" id="wc-selcount">
          {allPicked ? "" : `${picked} of ${count} selected`}
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
        {uncommitted.map(file => (
          <PickableFileRow
            key={file.path}
            file={file}
            picked={pickedPaths.has(file.path)}
            onPick={isPicked => onPick(file.path, isPicked)}
            onDiscard={() => onRequestDiscard(file)}
          />
        ))}
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
        <TextArea
          className="my-0.5 mb-1.5 min-h-16 py-1.25 text-body"
          id="commit-body"
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
