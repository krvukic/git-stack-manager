/**
 * Delete merged branches as they appear, while the Config drawer says to.
 *
 * The host decides which branches qualify and lists them on the model; this hook only asks.
 * Each branch is asked for once at each commit, and that memory is stored, so it holds across
 * reloads. A failed request is therefore not retried on every poll, and a branch that Undo
 * brought back stays, because the reader who pressed Undo wanted it. Turning the setting off
 * clears that memory, so turning it on again is the explicit way to ask a second time.
 *
 * An effect, because the trigger is a model arriving from the host rather than a click.
 */
import type { RenderModel } from "#ui/renderModel";
import { useEffect, useRef } from "react";
import {
  readStoredAskedMergedBranches,
  storeAskedMergedBranches,
} from "../storage";
import type { Smartlog } from "./useSmartlog";

export function useMergedBranchDeletion(smartlog: Smartlog, enabled: boolean) {
  const { model, runAction, showToast } = smartlog;
  const asked = useRef<Set<string> | null>(null);
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
    const branches = (merged ?? []).filter(
      branch => !memory.has(`${branch.name}@${branch.sha}`)
    );
    if (!branches.length) {
      return;
    }
    for (const branch of branches) {
      memory.add(`${branch.name}@${branch.sha}`);
    }
    storeAskedMergedBranches(memory);
    void runAction<{ deleted: string[]; model: RenderModel }>(
      "deleteMergedBranches",
      { branches: branches.map(branch => branch.name) },
      {
        modelFrom: data => data.model,
        reloadOnError: true,
        onSuccess: data => {
          if (data.deleted.length) {
            showToast(
              `Deleted merged ${data.deleted.length > 1 ? "branches" : "branch"} ${data.deleted.join(", ")} ✓`,
              false
            );
          }
        },
      }
    );
  }, [enabled, merged, runAction, showToast]);
}
