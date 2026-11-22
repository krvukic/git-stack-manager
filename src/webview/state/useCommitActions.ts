/**
 * Everything the tree's context menu and the commit panel can do to one commit: check it out,
 * copy its sha or a branch name off it, rebase it, fold it, split it, reword it, submit it, or
 * hand its stack to `gh stack`.
 *
 * The split panel's state lives here rather than in the component that draws it, because the
 * two halves of a split belong together: the preview is a read that only exists to be applied,
 * and applying it closes the panel. That also keeps the sha out of the render — `applySplit`
 * takes what the panel collected and reads the commit from the state it opened with.
 */
import type { RebaseDestination } from "#history/rebase";
import type { RenderModel, UICommit } from "#ui/renderModel";
import { useCallback, useState } from "react";
import type { SplitHunk, SplitState } from "../components/SplitPanel";
import { adoptReport, type AdoptReportInput } from "../model/adoptReport.mjs";
import { gotoTarget, submitTarget } from "../model/commits.mjs";
import {
  linkReport,
  submittedLinkNote,
  type StackLinkOutcome,
} from "../model/stackLink.mjs";
import { rpc } from "../rpc";
import { useBusy } from "./useBusy";
import type { Smartlog } from "./useSmartlog";

export function useCommitActions(
  smartlog: Smartlog,
  /** The Config drawer's *New pull requests*, which both submits send to the host. */
  draftByDefault: boolean
) {
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

  /**
   * Put `value` on the clipboard and report either outcome.
   *
   * Written from the webview rather than through a host action, unlike *Open file* and its
   * neighbours. Only one side can do this in both hosts: the extension has
   * `vscode.env.clipboard`, but the web host is a Node server with no clipboard of its own, so
   * routing it would mean the browser doing it anyway — through two code paths instead of one.
   *
   * A clipboard write needs a focused document and the browser's permission, and neither is
   * this code's to guarantee. So a failure raises a toast carrying the value, rather than
   * returning silently and leaving the reader to paste whatever was there before. `noun` names
   * the value in that sentence; `shown` is what the success toast echoes, for a value too long
   * to read back.
   *
   * The parameters are named, because three strings in a row read as interchangeable.
   */
  const copyToClipboard = useCallback(
    async ({
      value,
      noun,
      shown = value,
    }: {
      value: string;
      noun: string;
      shown?: string;
    }) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        showToast(`Could not reach the clipboard. The ${noun} is ${value}.`);
        return;
      }
      showToast(`Copied ${shown} ✓`, false);
    },
    [showToast]
  );

  /**
   * The full sha, where the row prints eight characters. Eight is enough to read and to type
   * at a prompt; the rest is what a reader cannot get off the screen and has to paste into a
   * pull request body or a `git` command elsewhere.
   */
  const copySha = useCallback(
    (commit: UICommit) =>
      copyToClipboard({
        value: commit.sha,
        noun: "full sha",
        shown: commit.shortSha,
      }),
    [copyToClipboard]
  );

  /**
   * A branch name, which is short enough to read on the row and still worth copying: every
   * `git` command and every pull request URL has to spell it exactly.
   */
  const copyBranchName = useCallback(
    (branch: string) => copyToClipboard({ value: branch, noun: "branch name" }),
    [copyToClipboard]
  );

  const runRebase = useCallback(
    async (rootSha: string, destination: RebaseDestination) => {
      showToast("Rebasing…", false);
      await runAction<{
        model: RenderModel;
        conflict: unknown;
        moved: string[];
      }>(
        "rebase",
        {
          sha: rootSha,
          destination: destination.kind,
          ...(destination.kind === "commit"
            ? { destinationSha: destination.sha }
            : {}),
        },
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
   * Link the stack's pull requests on GitHub, in the tree's order. The host re-reads pull
   * request status before it answers, so the model that comes back draws each one's new place.
   */
  const linkStack = useCallback(
    async (branch: string) => {
      showToast("Linking the stack on GitHub…", false);
      await runAction<{ link: StackLinkOutcome; model: RenderModel }>(
        "linkStack",
        { branch },
        {
          modelFrom: data => data.model,
          onSuccess: data => showToast(linkReport(data.link), false),
        }
      );
    },
    [runAction, showToast]
  );

  /** Dissolve the stack on GitHub that the branch's pull request is in. */
  const unstack = useCallback(
    async (branch: string) => {
      showToast("Unstacking on GitHub…", false);
      await runAction<{ stack: number; model: RenderModel }>(
        "unstack",
        { branch },
        {
          modelFrom: data => data.model,
          onSuccess: data =>
            showToast(`Unstacked #${data.stack} on GitHub ✓`, false),
        }
      );
    },
    [runAction, showToast]
  );

  /**
   * Point every layer of a stack at the commit that its remote holds, where GitHub's own restack
   * left it once a lower pull request merged. The reload of pull request status follows the move,
   * because the badges drew the divergence that the move clears.
   */
  const adoptRemote = useCallback(
    async (branch: string) => {
      showToast("Taking GitHub's version of the stack…", false);
      const response = await runAction<
        AdoptReportInput & { model: RenderModel }
      >(
        "adoptRemoteStack",
        { branch },
        {
          modelFrom: data => data.model,
          reloadOnError: true,
          onSuccess: data => {
            const report = adoptReport(data);
            showToast(report.text, report.warn);
          },
        }
      );
      if (response.ok) {
        void loadPullRequests(true);
      }
    },
    [loadPullRequests, runAction, showToast]
  );

  /**
   * Remove one local branch. The toast names the reflog when no other ref reaches the commit,
   * because the undo checkpoints go when the window closes, and the reflog is what remains.
   */
  const deleteBranch = useCallback(
    (branch: string) =>
      runAction<{
        model: RenderModel;
        sha: string;
        onlyInReflog: boolean;
      }>(
        "deleteBranch",
        { branch },
        {
          modelFrom: data => data.model,
          onSuccess: data =>
            showToast(
              data.onlyInReflog
                ? `Deleted ${branch} ✓ — ${data.sha.slice(0, 8)} is now reachable only from the reflog, so Undo is the way back`
                : `Deleted ${branch} ✓`,
              data.onlyInReflog
            ),
        }
      ),
    [runAction, showToast]
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
          { branch, draftByDefault },
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
      // The badge's number and checks come from the cached pull request fetch, which this
      // submit just invalidated.
      if (response.ok) {
        void loadPullRequests(true);
      }
    },
    [draftByDefault, loadPullRequests, runAction, showToast, whileBusy]
  );

  /**
   * Store the Draft toggle's choice for `branch`, which Submit reads when it opens the branch's
   * pull request. Nothing reaches GitHub until then, which is why the toast names Submit.
   */
  const setDraft = useCallback(
    (branch: string, draft: boolean) =>
      runAction<RenderModel>(
        "setDraft",
        { branch, draft },
        {
          modelFrom: data => data,
          onSuccess: () =>
            showToast(
              draft
                ? `Submit will open ${branch}'s pull request as a draft ✓`
                : `Submit will open ${branch}'s pull request ready for review ✓`,
              false
            ),
        }
      ),
    [runAction, showToast]
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
          link: StackLinkOutcome | { error: string } | null;
          model: RenderModel;
        }>(
          "submitStack",
          { branch, draftByDefault },
          {
            modelFrom: data => data.model,
            reloadOnError: true,
            onSuccess: ({ outcomes, link }) => {
              const opened = outcomes.filter(outcome => outcome.created).length;
              const linked = submittedLinkNote(link);
              const done = `Submitted ${outcomes.length} branches — ${opened} opened, ${outcomes.length - opened} updated${linked.text}`;
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
                showToast(`${done}${linked.warn ? "" : " ✓"}`, linked.warn);
              }
            },
          }
        )
      );
      // A failure part-way leaves the layers below it submitted, so re-read either way.
      void loadPullRequests(true);
      return response;
    },
    [draftByDefault, loadPullRequests, runAction, showToast, whileBusy]
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
    copySha,
    copyBranchName,
    runRebase,
    linkStack,
    unstack,
    adoptRemote,
    deleteBranch,
    submitStack,
    setDraft,
    foldCommit,
    submitCommit,
    amendMessage,
    openSplit,
    applySplit,
    closeSplit,
  };
}
