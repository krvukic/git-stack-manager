/**
 * The banner shown while a rebase is stopped on a conflict.
 *
 * Everything else stays interactive on purpose: inspecting other commits is useful
 * mid-conflict, and the actions that would corrupt the rebase are disabled individually
 * rather than behind a modal.
 */
import type { ConflictState } from "#git/snapshot";
import { Button, ButtonRow } from "./Button";
import { ConflictFileRow } from "./FileRow";

/**
 * `continuing` comes from the caller rather than from local state, because a continue that
 * fails has to re-arm the button. `git rebase --continue` refuses while conflict markers
 * remain, and a flag this component set itself would stay set: one bad resolve left Continue
 * reading "Continuing…" forever, with the only way out a reload.
 */
export function ConflictBanner({
  conflict,
  continuing,
  onMergeTool,
  onContinue,
  onAbort,
}: {
  conflict: ConflictState | null;
  continuing: boolean;
  onMergeTool: () => void;
  onContinue: () => void;
  onAbort: () => void;
}) {
  if (!conflict) {
    return <div id="conflict" />;
  }

  const progress = conflict.totalSteps
    ? ` (step ${conflict.step} of ${conflict.totalSteps})`
    : "";
  return (
    /*
      Sits above the tree while a rebase is stopped. A wash of the error colour rather than a
      solid fill: it has to read as urgent without making the tree behind it unreadable, since
      inspecting other commits mid-conflict is useful and stays possible.
    */
    <div
      id="conflict"
      // `open` carries no styling; the end-to-end suite waits on `#conflict.open` to know
      // the banner is up, so it is part of the contract.
      className="open mx-3.5 mt-2 flex-none rounded-card border border-err bg-err/12 px-3 py-2"
    >
      <div className="mb-1 font-semibold text-err">{`Rebase stopped on a conflict${progress}`}</div>
      <div className="mb-2 text-body text-muted">
        {`Conflicting changes${conflict.branch ? ` while rebasing ${conflict.branch}` : ""}. `}
        Resolve each file, then continue — or abort to restore the original
        commits.
      </div>
      <div className="mt-1.5 mb-2" id="conflict-files">
        {conflict.unmergedFiles.map(path => (
          <ConflictFileRow key={path} path={path} />
        ))}
      </div>
      <ButtonRow className="mt-2">
        <Button
          id="btn-mergetool"
          variant="primary"
          title="git mergetool — opens your configured merge tool"
          onClick={onMergeTool}
        >
          Open merge tool
        </Button>
        <Button
          id="btn-continue"
          title="git rebase --continue"
          disabled={continuing}
          onClick={onContinue}
        >
          {continuing ? "Continuing…" : "Continue rebase"}
        </Button>
        <Button id="btn-abort" title="git rebase --abort" onClick={onAbort}>
          Abort
        </Button>
      </ButtonRow>
    </div>
  );
}
