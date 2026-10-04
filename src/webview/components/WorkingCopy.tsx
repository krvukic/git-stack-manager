/**
 * Uncommitted changes: what is dirty, which of it goes in, and the actions it can become.
 *
 * `CommitForm` renders the form below the file list, and says why it belongs here.
 */
import type { FileChange } from "#git/snapshot";
import type { RenderModel, UICommit } from "#ui/renderModel";
import { canAbsorb } from "../model/actionGuards.mjs";
import { truncate } from "../model/commits.mjs";
import {
  chosenLineCount,
  goesInWhole,
  type LineChoice,
} from "../model/lineChoice.mjs";
import type { CommitDraft } from "../state/useSmartlog";
import { AbsorbPreview, type AbsorbPlan } from "./AbsorbPreview";
import { Button } from "./Button";
import { CommitForm } from "./CommitForm";
import { DiscardConfirm } from "./DiscardConfirm";
import { PickableFileRow } from "./FileRow";

export type WorkingCopyProps = {
  model: RenderModel;
  pickedPaths: Set<string>;
  /** The lines left out of each partly chosen path. */
  choices: ReadonlyMap<string, LineChoice>;
  /** The commit *Amend into…* would write to, defaulting to HEAD. */
  amendTarget: UICommit | null;
  commitDraft: CommitDraft;
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
  onDraftChange: (draft: CommitDraft) => void;
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
      <CommitForm
        isOpen={commitFormOpen}
        draft={commitDraft}
        needsBranch={model.commitNeedsBranch}
        headBranch={model.headBranch}
        blocked={nothingPicked || conflicted}
        committing={committing}
        onDraftChange={onDraftChange}
        onCommit={onCommit}
        onCancel={onCancelCommitForm}
      />
    </div>
  );
}
