/**
 * What the uncommitted changes can become: a new commit, an amend into a commit already in the
 * stack, or an absorb that spreads each change into whichever commit its lines came from.
 *
 * Which paths are ticked and what the message says live in `useSmartlog`, because the browser
 * host's five-second poll must not disturb either. What lives here is everything transient: the
 * commit form's visibility and the absorb preview, both of which an action closes when it lands.
 *
 * Every action takes the ticked paths as they are at the click rather than as a rendered value,
 * so an untouched working copy costs nothing.
 */
import type { FileChange } from "#git/snapshot";
import type { RenderModel, UICommit } from "#ui/renderModel";
import { useCallback, useState } from "react";
import type { AbsorbPlan } from "../components/AbsorbPreview";
import { rpc } from "../rpc";
import { useBusy } from "./useBusy";
import type { LineChoices } from "./useLineChoices";
import type { Smartlog } from "./useSmartlog";

export function useWorkingCopy(
  smartlog: Smartlog,
  /** The commit *Amend into…* writes to, or null for HEAD. */
  amendTarget: UICommit | null,
  lineChoices: LineChoices
) {
  const {
    commitDraft,
    model,
    pickedPaths,
    runAction,
    setCommitDraft,
    showToast,
  } = smartlog;
  const { lineSelections, forget } = lineChoices;
  const { busy, whileBusy } = useBusy<
    "commit" | "amend" | "absorb" | "discard"
  >();
  const [commitFormOpen, setCommitFormOpen] = useState(false);
  const [absorbPlan, setAbsorbPlan] = useState<AbsorbPlan | null>(null);
  const [discardTarget, setDiscardTarget] = useState<FileChange | null>(null);

  const pickedFilePaths = useCallback(
    () =>
      (model?.uncommitted ?? [])
        .filter(file => pickedPaths.has(file.path))
        .map(file => file.path),
    [model, pickedPaths]
  );

  const openCommitForm = useCallback(() => setCommitFormOpen(true), []);
  const closeCommitForm = useCallback(() => setCommitFormOpen(false), []);
  const closeAbsorbPlan = useCallback(() => setAbsorbPlan(null), []);

  const commitPicked = useCallback(async () => {
    const subject = commitDraft.subject.trim();
    if (!subject) {
      showToast("A commit needs a summary.");
      return;
    }
    const body = commitDraft.body.trim();
    const paths = pickedFilePaths();
    await whileBusy("commit", () =>
      runAction<{ committed: string[]; newSha: string; model: RenderModel }>(
        "commit",
        {
          paths,
          message: subject + (body ? `\n\n${body}` : ""),
          lines: lineSelections(paths),
        },
        {
          modelFrom: data => data.model,
          selectSha: data => data.newSha,
          // A refusal for a file that changed after its lines were chosen is only fixed by a
          // re-read, which is also what resets that file's choice.
          reloadOnError: true,
          onSuccess: data => {
            forget(paths);
            showToast(
              `Committed ${data.committed.length} change${data.committed.length > 1 ? "s" : ""} ✓`,
              false
            );
            setCommitFormOpen(false);
            // The message belongs to the commit that now exists; leaving it would
            // pre-fill the next commit with the previous one's summary.
            setCommitDraft({ subject: "", body: "" });
          },
        }
      )
    );
  }, [
    commitDraft,
    forget,
    lineSelections,
    pickedFilePaths,
    runAction,
    setCommitDraft,
    showToast,
    whileBusy,
  ]);

  /** `target` overrides the selected commit, for the overlay's own picker. */
  const amendInto = useCallback(
    (target: UICommit | null = amendTarget) => {
      const paths = pickedFilePaths();
      return whileBusy("amend", () =>
        runAction<{ newSha: string; model: RenderModel }>(
          "amendIntoCommit",
          {
            paths,
            sha: target?.sha ?? null,
            lines: lineSelections(paths),
          },
          {
            modelFrom: data => data.model,
            selectSha: data => data.newSha,
            reloadOnError: true,
            onSuccess: () => {
              forget(paths);
              showToast(
                `Amended into ${target && !target.isHead ? `"${target.subject}"` : "HEAD"} ✓`,
                false
              );
            },
          }
        )
      );
    },
    [
      amendTarget,
      forget,
      lineSelections,
      pickedFilePaths,
      runAction,
      showToast,
      whileBusy,
    ]
  );

  const amendWorkingChanges = useCallback(
    () =>
      runAction<RenderModel>(
        "amendChanges",
        {},
        {
          modelFrom: data => data,
          selectSha: data => data.headSha,
          onSuccess: () =>
            showToast("Working changes amended into HEAD ✓", false),
        }
      ),
    [runAction, showToast]
  );

  /**
   * Discard one change, in two steps.
   *
   * The confirmation is not politeness: no other action here destroys anything Undo cannot
   * restore, so this is the one place the reader gets a second look. The target is held as the
   * whole `FileChange` rather than a path, because the card's wording turns on the status
   * letter — a discard deletes an untracked file and restores a modified one.
   */
  const requestDiscard = useCallback(
    (file: FileChange) => setDiscardTarget(file),
    []
  );
  const cancelDiscard = useCallback(() => setDiscardTarget(null), []);

  const confirmDiscard = useCallback(async () => {
    if (!discardTarget) {
      return;
    }
    const { path } = discardTarget;
    await whileBusy("discard", () =>
      runAction<{ restored: string[]; removed: string[]; model: RenderModel }>(
        "discard",
        { paths: [path] },
        {
          modelFrom: data => data.model,
          // A discard is exactly what a stale list gets refused for, and the refusal names a
          // path the reader can no longer see. Re-reading turns that into a list they can act
          // on again.
          reloadOnError: true,
          onSuccess: data => {
            showToast(
              data.removed.length ? `Deleted ${path} ✓` : `Discarded ${path} ✓`,
              false
            );
            setDiscardTarget(null);
          },
        }
      )
    );
  }, [discardTarget, runAction, showToast, whileBusy]);

  const previewAbsorb = useCallback(async () => {
    setAbsorbPlan({ state: "loading" });
    const response = await rpc<{
      affected: { sha: string; subject: string; hunks: number }[];
      outcomes: { path: string; skipped: { reason: string }[] }[];
    }>("absorbPlan", {});
    if (!response.ok) {
      setAbsorbPlan({ state: "error", error: response.error });
      return;
    }
    const { affected = [], outcomes = [] } = response.data ?? {};
    setAbsorbPlan({
      state: "ready",
      targets: affected,
      skipped: outcomes.flatMap(outcome =>
        outcome.skipped.map(entry => ({
          path: outcome.path,
          reason: entry.reason,
        }))
      ),
    });
  }, []);

  const applyAbsorb = useCallback(
    () =>
      whileBusy("absorb", () =>
        runAction<{
          appliedHunks: number;
          skippedHunks: number;
          model: RenderModel;
        }>(
          "absorb",
          {},
          {
            modelFrom: data => data.model,
            reloadOnError: true,
            onSuccess: data => {
              showToast(
                data.skippedHunks
                  ? `${data.appliedHunks} of ${data.appliedHunks + data.skippedHunks} changes absorbed; the rest stayed in the working copy.`
                  : `Absorbed ${data.appliedHunks} change${data.appliedHunks === 1 ? "" : "s"} ✓`,
                false
              );
              setAbsorbPlan(null);
            },
          }
        )
      ),
    [runAction, showToast, whileBusy]
  );

  return {
    committing: busy.has("commit"),
    amending: busy.has("amend"),
    absorbing: busy.has("absorb"),
    discarding: busy.has("discard"),
    commitFormOpen,
    openCommitForm,
    closeCommitForm,
    absorbPlan,
    closeAbsorbPlan,
    discardTarget,
    requestDiscard,
    confirmDiscard,
    cancelDiscard,
    commitPicked,
    amendInto,
    amendWorkingChanges,
    previewAbsorb,
    applyAbsorb,
  };
}
