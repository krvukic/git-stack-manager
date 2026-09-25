/**
 * Everything the tree's context menu and the commit panel can do to one commit: check it out,
 * rebase it, fold it, split it, reword it, submit it, or hand its stack to `gh stack`.
 *
 * The split panel's state lives here rather than in the component that draws it, because the
 * two halves of a split belong together: the preview is a read that only exists to be applied,
 * and applying it closes the panel. That also keeps the sha out of the render — `applySplit`
 * takes what the panel collected and reads the commit from the state it opened with.
 */
import type { RenderModel, UICommit } from "#ui/renderModel";
import { useCallback, useState } from "react";
import type { SplitHunk, SplitState } from "../components/SplitPanel";
import { gotoTarget, submitTarget } from "../model/commits.mjs";
import { rpc } from "../rpc";
import { useBusy } from "./useBusy";
import type { Smartlog } from "./useSmartlog";

export function useCommitActions(smartlog: Smartlog) {
  const { loadPullRequests, runAction, showToast } = smartlog;
  const { busy, whileBusy } = useBusy<"submit" | "amend" | "split">();
  const [split, setSplit] = useState<SplitState>(null);

  /**
   * `gotoTarget` decides both the destination and the refusal, so the button the reader
   * clicked and this call cannot disagree. The refusal still has to be reported here: the
   * row disables its button, but the keyboard shortcut has no button to disable.
   *
   * A detached HEAD is named rather than reported as a plain checkout. Nothing else on
   * screen says so, and a reader who commits from there has put the work where no branch
   * reaches it.
   */
  const gotoCommit = useCallback(
    async (commit: UICommit) => {
      const { ref, detach, heldBy } = gotoTarget(commit);
      if (heldBy) {
        showToast(`${ref} is checked out in ${heldBy}.`);
        return;
      }
      await runAction<RenderModel>(
        "checkout",
        { ref, detach },
        {
          modelFrom: data => data,
          onSuccess: () =>
            showToast(
              detach
                ? `Checked out ${commit.shortSha} — HEAD is detached ✓`
                : `Checked out ${ref} ✓`,
              false
            ),
        }
      );
    },
    [runAction, showToast]
  );

  const runRebase = useCallback(
    async (commit: UICommit, destination: "trunk" | "base") => {
      showToast("Rebasing…", false);
      await runAction<{
        model: RenderModel;
        conflict: unknown;
        moved: string[];
      }>(
        "rebase",
        { sha: commit.sha, destination },
        {
          modelFrom: data => data.model,
          reloadOnError: true,
          onSuccess: data => {
            if (data.conflict) {
              showToast(
                "Rebase stopped on a conflict — resolve it below.",
                true
              );
              return;
            }
            showToast(
              data.moved.length
                ? `Rebased ${data.moved.join(", ")} ✓`
                : "Rebased ✓",
              false
            );
          },
        }
      );
    },
    [runAction, showToast]
  );

  /**
   * `gh stack` commands push and talk to GitHub, so they take seconds; the toast reports
   * progress and pull request status is re-read afterwards because the stack's state on
   * GitHub has changed.
   */
  const runGhStack = useCallback(
    async (payload: Record<string, unknown>, label: string) => {
      showToast(`${label}…`, false);
      const response = await runAction<{ model: RenderModel }>(
        "ghStack",
        payload,
        {
          modelFrom: data => data.model,
          reloadOnError: true,
          onSuccess: () => showToast(`${label} ✓`, false),
        }
      );
      if (response.ok) {
        void loadPullRequests(true);
      }
    },
    [loadPullRequests, runAction, showToast]
  );

  const foldCommit = useCallback(
    (commit: UICommit) =>
      runAction<{ model: RenderModel; newSha: string }>(
        "fold",
        { sha: commit.sha },
        {
          modelFrom: data => data.model,
          selectSha: data => data.newSha,
          onSuccess: () => showToast("Folded into the commit below ✓", false),
        }
      ),
    [runAction, showToast]
  );

  /**
   * Push the commit's branch and open or update its pull request.
   *
   * The branch is picked here rather than passed in, so the menu entry and the panel button
   * cannot disagree about which pill Submit acts on. A commit with no branch is not
   * submittable and neither of them offers it, so there is nothing to report.
   */
  const submitCommit = useCallback(
    async (commit: UICommit) => {
      const branch = submitTarget(commit)?.name;
      if (!branch) {
        return;
      }
      showToast(`Submitting ${branch}…`, false);
      const response = await whileBusy("submit", () =>
        runAction<{
          created: boolean;
          number: number | null;
          base: string;
          staleBase: { branch: string; reason: string } | null;
          model: RenderModel;
        }>(
          "submit",
          { branch },
          {
            modelFrom: data => data.model,
            onSuccess: data => {
              const named = data.number ? `#${data.number}` : branch;
              const done = data.created
                ? `Opened ${named} onto ${data.base}`
                : `Updated ${named} — code and message in sync`;
              // A stale base is a warning, not a failure: the submit landed. GitHub diffs
              // against the base as pushed, so the pull request also shows the layer below's
              // changes. The two causes need opposite fixes, so name the right one rather
              // than acting on a branch the user did not pick.
              if (data.staleBase) {
                const fix =
                  data.staleBase.reason === "unsubmitted"
                    ? `submit ${data.staleBase.branch} too`
                    : `rebase this commit onto ${data.staleBase.branch}`;
                showToast(
                  `${done} ✓ — but the diff also shows ${data.staleBase.branch}'s changes: ${fix}.`,
                  true
                );
              } else {
                showToast(`${done} ✓`, false);
              }
            },
          }
        )
      );
      // The badge's number and checks come from the cached `gh pr list`, which this submit
      // just invalidated.
      if (response.ok) {
        void loadPullRequests(true);
      }
    },
    [loadPullRequests, runAction, showToast, whileBusy]
  );

  /**
   * Submit every branch from the bottom of the commit's stack up to its own, bottom first.
   * Shares the busy flag with Submit: both push the same branches.
   */
  const submitStack = useCallback(
    async (commit: UICommit) => {
      const branch = submitTarget(commit)?.name;
      if (!branch) {
        return;
      }
      showToast(`Submitting the stack up to ${branch}…`, false);
      const response = await whileBusy("submit", () =>
        runAction<{
          outcomes: Array<{
            created: boolean;
            staleBase: { branch: string; reason: string } | null;
          }>;
          model: RenderModel;
        }>(
          "submitStack",
          { branch },
          {
            modelFrom: data => data.model,
            reloadOnError: true,
            onSuccess: ({ outcomes }) => {
              const opened = outcomes.filter(outcome => outcome.created).length;
              const done = `Submitted ${outcomes.length} branches — ${opened} opened, ${outcomes.length - opened} updated`;
              // Bottom-up submission pushes every base first, so only a base rewritten out
              // from under a layer is left to report.
              const stale = outcomes.find(
                outcome => outcome.staleBase
              )?.staleBase;
              if (stale) {
                showToast(
                  `${done} ✓ — but a diff also shows ${stale.branch}'s changes: rebase onto ${stale.branch}.`,
                  true
                );
              } else {
                showToast(`${done} ✓`, false);
              }
            },
          }
        )
      );
      // A failure part-way leaves the layers below it submitted, so re-read either way.
      void loadPullRequests(true);
      return response;
    },
    [loadPullRequests, runAction, showToast, whileBusy]
  );

  const amendMessage = useCallback(
    (sha: string, message: string) =>
      whileBusy("amend", () =>
        runAction<{ newSha: string; model: RenderModel }>(
          "amendMessage",
          { sha, message },
          {
            modelFrom: data => data.model,
            selectSha: data => data.newSha,
            onSuccess: () => showToast("Message amended ✓", false),
          }
        )
      ),
    [runAction, showToast, whileBusy]
  );

  const closeSplit = useCallback(() => setSplit(null), []);

  const openSplit = useCallback(
    async (commit: UICommit) => {
      setSplit({ state: "loading", shortSha: commit.shortSha });
      const response = await rpc<{ hunks: SplitHunk[] }>("splitPreview", {
        sha: commit.sha,
      });
      if (!response.ok) {
        setSplit(null);
        showToast(response.error);
        return;
      }
      setSplit({
        state: "ready",
        shortSha: commit.shortSha,
        subject: commit.subject,
        sha: commit.sha,
        hunks: response.data?.hunks ?? [],
      });
    },
    [showToast]
  );

  const applySplit = useCallback(
    async (selected: string[], firstMessage: string, secondMessage: string) => {
      if (split?.state !== "ready") {
        return;
      }
      await whileBusy("split", () =>
        runAction<{ secondSha: string; model: RenderModel }>(
          "split",
          { sha: split.sha, selected, firstMessage, secondMessage },
          {
            modelFrom: data => data.model,
            selectSha: data => data.secondSha,
            onSuccess: () => {
              setSplit(null);
              showToast("Split into two commits ✓", false);
            },
          }
        )
      );
    },
    [runAction, showToast, split, whileBusy]
  );

  return {
    submitting: busy.has("submit"),
    amending: busy.has("amend"),
    splitting: busy.has("split"),
    split,
    gotoCommit,
    runRebase,
    runGhStack,
    submitStack,
    foldCommit,
    submitCommit,
    amendMessage,
    openSplit,
    applySplit,
    closeSplit,
  };
}
