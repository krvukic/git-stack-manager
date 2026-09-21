/**
 * The step between clicking discard and losing the change.
 *
 * A confirmation exists here and nowhere else in the app for one reason: every other action
 * lands in a commit, and Undo puts the refs back. A discard writes over the working copy, which
 * no checkpoint holds — so this card is the only chance the reader gets, and it says which of
 * the two things is about to happen to the file rather than a generic warning.
 *
 * Shaped like `AbsorbPreview` deliberately: both sit under the uncommitted header and both are
 * "read this, then commit to it", so one shape covers them.
 */
import type { FileChange } from "#git/snapshot";
import { discardConsequence } from "../model/discard.mjs";
import { Button, ButtonRow } from "./Button";
import { FieldLabel } from "./Field";

export function DiscardConfirm({
  file,
  discarding,
  onConfirm,
  onCancel,
}: {
  /** The change under the pointer when discard was clicked, or null while closed. */
  file: FileChange | null;
  discarding: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // An empty div rather than nothing, so the end-to-end suite can wait on the element and read
  // it appearing — the same contract `AbsorbPreview` keeps.
  if (!file) {
    return <div id="discard-confirm" />;
  }
  return (
    <div
      id="discard-confirm"
      className="mt-2 ml-2 rounded-card border border-edge bg-card p-2"
    >
      <FieldLabel as="div" heading>
        Discard changes
      </FieldLabel>
      <div className="py-0.5 text-ui/none">
        <span className="font-[monospace]">{file.path}</span>
      </div>
      <div className="text-meta text-muted">
        {discardConsequence(file.status)}
      </div>
      {/* Red, and stated as a limit rather than a scare: Undo is right there in the top bar,
          and a reader who has leaned on it needs to know it does not reach this. */}
      <div className="text-meta text-err">
        Undo cannot bring it back — the change is in no commit.
      </div>
      <ButtonRow className="mt-2">
        <Button
          id="btn-discard-do"
          variant="primary"
          disabled={discarding}
          onClick={onConfirm}
        >
          {discarding ? "Discarding…" : "Discard"}
        </Button>
        <Button id="btn-discard-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </ButtonRow>
    </div>
  );
}
