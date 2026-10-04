/**
 * The form the ticked changes become a commit through: a summary, a description, and the
 * branch to put it on.
 *
 * It renders under the working copy's file list rather than in the commit panel, because the
 * changes being committed are listed directly above it. A panel would put the message a
 * selection away from the files it describes.
 *
 * The inputs are controlled from `useSmartlog`, which is what makes the browser host's
 * five-second poll invisible: React reconciles the existing input rather than replacing it,
 * so the value survives and the caret stays put.
 */
import { useRef } from "react";
import { classes } from "../classes";
import { suggestBranchName } from "../model/branchName.mjs";
import {
  COMMIT_BODY_HEIGHT_KEY,
  COMMIT_BODY_MIN_HEIGHT,
} from "../model/messageHeight.mjs";
import type { CommitDraft } from "../state/useSmartlog";
import { useStoredHeight } from "../state/useStoredHeight";
import { Button, ButtonRow } from "./Button";
import { FieldLabel, TextArea, TextInput } from "./Field";

/**
 * What the Commit button promises, which is a different sentence in each of three states.
 *
 * A function rather than a ternary in the attribute: the three answers are a dead button, a
 * commit that forks, and a commit that extends, and a reader picks the row apart more slowly
 * than they read three early returns.
 */
function commitDescription(
  draft: CommitDraft,
  refusal: string,
  missingBranch: boolean
): string {
  if (missingBranch) {
    return refusal;
  }
  const branch = draft.branch.trim();
  if (branch) {
    return `Start ${branch} here and commit the ticked changes onto it`;
  }
  return "Commit the ticked changes onto the branch you are on";
}

export type CommitFormProps = {
  /**
   * Hidden rather than unmounted while closed. The box's remembered height is read on mount,
   * and `useStoredHeight` guards against storing the zero a hidden box measures — a contract
   * worth leaving alone.
   */
  isOpen: boolean;
  draft: CommitDraft;
  /**
   * Why this commit needs a branch of its own, or null when HEAD's branch can take it. The
   * host computes it; see `RenderModel.commitNeedsBranch`.
   */
  needsBranch: string | null;
  /** Branch HEAD is on, which an empty field adds the commit to. Null when detached. */
  headBranch: string | null;
  /** Nothing is ticked, or a rebase is stopped — either way the commit cannot run. */
  blocked: boolean;
  committing: boolean;
  onDraftChange: (draft: CommitDraft) => void;
  onCommit: () => void;
  onCancel: () => void;
};

export function CommitForm({
  isOpen,
  draft,
  needsBranch,
  headBranch,
  blocked,
  committing,
  onDraftChange,
  onCommit,
  onCancel,
}: CommitFormProps) {
  const draftBody = useRef<HTMLTextAreaElement>(null);
  const draftBodyHeight = useStoredHeight(
    draftBody,
    COMMIT_BODY_HEIGHT_KEY,
    COMMIT_BODY_MIN_HEIGHT
  );
  const suggestion = suggestBranchName(draft.subject);
  // Only where the host would refuse the commit outright. On a feature branch an empty field
  // is the ordinary answer — it adds the commit to the branch, which is what a stack does —
  // so insisting there would mean naming a branch per commit.
  const missingBranch = Boolean(needsBranch) && !draft.branch.trim();
  // The host's own wording, which `RenderModel.commitNeedsBranch` carries here. The hint and
  // the dead button's description are the same sentence, said once.
  const refusal = `Name a branch for this commit: ${needsBranch}.`;

  return (
    <div
      id="commit-form"
      className={classes(
        "mt-2 mb-1 ml-2 max-w-155",
        isOpen ? "block" : "hidden"
      )}
    >
      <FieldLabel>Summary</FieldLabel>
      <TextInput
        className="my-0.5 mb-1.5 py-1.25 text-body"
        id="commit-subject"
        placeholder="What this change does"
        value={draft.subject}
        onChange={event =>
          onDraftChange({ ...draft, subject: event.target.value })
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
        value={draft.body}
        onChange={event =>
          onDraftChange({ ...draft, body: event.target.value })
        }
      />
      <FieldLabel>Branch</FieldLabel>
      {/*
        A suggestion in the placeholder rather than typed into the field. Pre-filling it would
        mean clearing the box every time a commit belongs on the branch already checked out,
        which is most of them; the button beside it fills the field in one click for the
        times it does not.
      */}
      <TextInput
        className="my-0.5 py-1.25 font-[monospace] text-body"
        id="commit-branch"
        placeholder={
          suggestion
            ? `${suggestion} — new branch for this commit`
            : "New branch for this commit"
        }
        value={draft.branch}
        onChange={event =>
          onDraftChange({ ...draft, branch: event.target.value })
        }
      />
      <div className="mt-1 text-meta text-muted" id="commit-branch-hint">
        {needsBranch ? (
          refusal
        ) : (
          <>
            {headBranch
              ? `Empty adds the commit to ${headBranch}.`
              : "Empty adds the commit to the branch you are on."}{" "}
            A name starts a branch here and commits onto it.
          </>
        )}
      </div>
      <ButtonRow className="mt-2">
        {/*
          An empty summary disables the button rather than being reported after the click.
          `commitPicked` still refuses one, because a paste of whitespace can arrive
          between paint and click, but a dead button is the cheaper answer to a form the
          reader has not filled in yet. A missing branch is the same case: the host refuses
          it, and the button says so first.
        */}
        <Button
          id="btn-commit-do"
          variant="primary"
          disabled={
            blocked || !draft.subject.trim() || missingBranch || committing
          }
          title={commitDescription(draft, refusal, missingBranch)}
          onClick={event => {
            event.stopPropagation();
            onCommit();
          }}
        >
          {committing ? "Committing…" : "Commit"}
        </Button>
        {suggestion && !draft.branch ? (
          <Button
            id="btn-commit-suggest-branch"
            title={`Put this commit on a new branch called ${suggestion}`}
            onClick={event => {
              event.stopPropagation();
              onDraftChange({ ...draft, branch: suggestion });
            }}
          >
            {`Use ${suggestion}`}
          </Button>
        ) : null}
        <Button
          id="btn-commit-cancel"
          onClick={event => {
            event.stopPropagation();
            onCancel();
          }}
        >
          Cancel
        </Button>
      </ButtonRow>
    </div>
  );
}
