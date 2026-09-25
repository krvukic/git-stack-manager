/**
 * The actions that move the whole repository: the top bar's Pull, Restack, and Undo, the Goto
 * on the trunk row and on the row the trunk branch was left on, and the controls the banner
 * shows while a rebase is stopped on a conflict.
 *
 * Grouped by what they act on rather than by which button runs them, which is what separates
 * them from `useCommitActions` — nothing here needs a commit to be selected. Both Gotos belong
 * here for that reason: trunk is the repository's own branch, and neither row names a commit
 * the reader picked.
 *
 * Every one that can leave a conflict behind re-reads on failure (`reloadOnError`): a rebase
 * that stopped has already moved refs, so the model on screen is stale whether it succeeded
 * or not.
 */
import type { RenderModel } from "#ui/renderModel";
import { useCallback } from "react";
import { rpc } from "../rpc";
import { useBusy } from "./useBusy";
import type { Smartlog } from "./useSmartlog";

export function useRepositoryActions(smartlog: Smartlog) {
  const { appendLog, loadModel, runAction, showToast } = smartlog;
  const { busy, whileBusy } = useBusy<"pull" | "restack" | "continue">();

  const pull = useCallback(
    () =>
      whileBusy("pull", () =>
        runAction<{
          branch: string;
          upstream: string;
          commits: number;
          model: RenderModel;
        }>(
          "pull",
          {},
          {
            modelFrom: data => data.model,
            onSuccess: data =>
              // "Already up to date" is worth saying: the button ran a fetch, so silence
              // would leave it unclear whether anything happened.
              showToast(
                data.commits
                  ? `Pulled ${data.commits} commit${data.commits > 1 ? "s" : ""} into ${data.branch} ✓`
                  : `${data.branch} is already up to date with ${data.upstream}`,
                false
              ),
          }
        )
      ),
    [runAction, showToast, whileBusy]
  );

  const restack = useCallback(
    () =>
      whileBusy("restack", () =>
        runAction<{ model: RenderModel; conflict: unknown; moved: string[] }>(
          "restack",
          {},
          {
            modelFrom: data => data.model,
            reloadOnError: true,
            onSuccess: data => {
              if (data.conflict) {
                showToast(
                  "Restack stopped on a conflict — resolve it below.",
                  true
                );
                return;
              }
              showToast(
                `Restacked: ${data.moved.join(", ") || "nothing to do"} ✓`,
                false
              );
            },
          }
        )
      ),
    [runAction, showToast, whileBusy]
  );

  /**
   * The trunk row's Goto. It reports the fast-forward when there was one, because the row
   * carried a badge saying the branch was behind and silence would leave that badge's
   * disappearance unexplained.
   */
  const gotoTrunk = useCallback(
    () =>
      runAction<{
        branch: string;
        trunkRef: string;
        advanced: number;
        model: RenderModel;
      }>(
        "gotoTrunk",
        {},
        {
          modelFrom: data => data.model,
          reloadOnError: true,
          onSuccess: data =>
            showToast(
              data.advanced
                ? `Checked out ${data.branch}, ${data.advanced} commit${data.advanced > 1 ? "s" : ""} forward to ${data.trunkRef} ✓`
                : `Checked out ${data.branch} ✓`,
              false
            ),
        }
      ),
    [runAction, showToast]
  );

  /** Goto on the row a fetch left the trunk branch on: a plain checkout, no fast-forward. */
  const gotoBranch = useCallback(
    (branch: string) =>
      runAction<RenderModel>(
        "checkout",
        { ref: branch, detach: false },
        {
          modelFrom: data => data,
          onSuccess: () => showToast(`Checked out ${branch} ✓`, false),
        }
      ),
    [runAction, showToast]
  );

  const undoLast = useCallback(
    () =>
      runAction<{ undone: string; model: RenderModel }>(
        "undo",
        {},
        {
          modelFrom: data => data.model,
          reloadOnError: true,
          onSuccess: data => showToast(`Undid ${data.undone} ✓`, false),
        }
      ),
    [runAction, showToast]
  );

  /**
   * The merge tool is interactive and can outlive this call, so refresh afterwards rather
   * than trusting the returned model.
   */
  const openMergeTool = useCallback(async () => {
    const response = await rpc("mergetool", {});
    appendLog(response.log);
    if (!response.ok) {
      showToast(response.error);
    }
    void loadModel(true);
  }, [appendLog, loadModel, showToast]);

  /**
   * `whileBusy` rather than a flag in the banner: continuing is the one conflict action that
   * routinely fails and leaves the banner up. Git refuses while a resolved file still carries
   * conflict markers, so the button has to come back for a second attempt.
   */
  const continueRebase = useCallback(
    () =>
      whileBusy("continue", () =>
        runAction<{ model: RenderModel; conflict: unknown }>(
          "rebaseContinue",
          {},
          {
            modelFrom: data => data.model,
            reloadOnError: true,
            onSuccess: data =>
              showToast(
                data.conflict
                  ? "Another conflict — resolve it below."
                  : "Rebase finished ✓",
                Boolean(data.conflict)
              ),
          }
        )
      ),
    [runAction, showToast, whileBusy]
  );

  const abortRebase = useCallback(
    () =>
      runAction<RenderModel>(
        "rebaseAbort",
        {},
        {
          modelFrom: data => data,
          onSuccess: () =>
            showToast("Rebase aborted — original commits restored.", false),
        }
      ),
    [runAction, showToast]
  );

  return {
    pulling: busy.has("pull"),
    restacking: busy.has("restack"),
    continuing: busy.has("continue"),
    pull,
    restack,
    gotoTrunk,
    gotoBranch,
    undoLast,
    openMergeTool,
    continueRebase,
    abortRebase,
  };
}
