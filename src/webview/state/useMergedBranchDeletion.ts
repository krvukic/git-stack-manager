/**
 * Delete merged branches as they appear, while the Config drawer says to.
 *
 * The host decides which branches qualify and lists them on the model; this hook only asks,
 * and only for the ones the host reports as deletable. Each branch is asked for once at each
 * commit, and that memory is stored, so it holds across reloads: a branch the host then keeps
 * is not asked for again on every poll, and a branch Undo brought back stays, because the
 * reader who pressed Undo wanted it. Turning the setting off clears that memory; the top bar's
 * *Clear merged* ignores it outright, which is the other way to ask a second time.
 *
 * The memory is written when the request answers, not before it. Written first, a request that
 * failed left every branch in it remembered and therefore never retried — the branch stayed in
 * the tree, and turning the setting off and on again was the only way back.
 *
 * "As they appear" runs only as fast as the host learns: two reads bring pull request status in,
 * one per load and one on *Refresh*, so a merge that lands while this view stands open reaches
 * the model at the next of those rather than within seconds.
 *
 * An effect, because the trigger is a model arriving from the host rather than a click.
 */
import type { MergedBranch } from "#history/pruneMerged";
import type { RenderModel } from "#ui/renderModel";
import { useEffect, useRef } from "react";
import {
  deletableMerged,
  describeMergedDeletion,
} from "../model/mergedBranches.mjs";
import {
  readStoredAskedMergedBranches,
  storeAskedMergedBranches,
} from "../storage";
import type { Smartlog } from "./useSmartlog";

/** A branch is new again once it moves, which is what makes the sha part of the key. */
function askedKey(branch: MergedBranch): string {
  return `${branch.name}@${branch.sha}`;
}

export function useMergedBranchDeletion(smartlog: Smartlog, enabled: boolean) {
  const { model, runAction, showToast } = smartlog;
  const asked = useRef<Set<string> | null>(null);
  const requesting = useRef(false);
  const merged = model?.mergedBranches;

  useEffect(() => {
    if (!enabled) {
      // Only on a change from on to off: a reader who never turned it on has nothing stored.
      if (asked.current?.size) {
        asked.current.clear();
        storeAskedMergedBranches(asked.current);
      }
      return;
    }
    asked.current ??= readStoredAskedMergedBranches();
    const memory = asked.current;
    const branches = deletableMerged(merged ?? []).filter(
      branch => !memory.has(askedKey(branch))
    );
    // One request at a time. Nothing is remembered until the answer arrives, so a poll landing
    // meanwhile would ask for the same branches a second time.
    if (!branches.length || requesting.current) {
      return;
    }
    requesting.current = true;
    void runAction<{ deleted: string[]; model: RenderModel }>(
      "deleteMergedBranches",
      { branches: branches.map(branch => branch.name) },
      {
        modelFrom: data => data.model,
        reloadOnError: true,
        onSuccess: data => {
          // Every branch asked for, not only the deleted ones: the host skips a branch whose
          // tip no longer matches, and asking again at that same tip would be skipped again.
          for (const branch of branches) {
            memory.add(askedKey(branch));
          }
          storeAskedMergedBranches(memory);
          // No kept branches passed, so this reports only what went. Automatic removal is
          // not the place to name a branch the reader did not ask about; *Clear merged*,
          // which they pressed, is.
          if (data.deleted.length) {
            showToast(describeMergedDeletion(data.deleted, []), false);
          }
        },
      }
    ).finally(() => {
      requesting.current = false;
    });
  }, [enabled, merged, runAction, showToast]);
}
