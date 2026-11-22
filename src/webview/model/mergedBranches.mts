/**
 * Which merged branches the automatic removal may take, and what it says after taking them.
 *
 * The host decides which branches can go and gives each of the rest a reason to stay
 * (`keptReason` in `pruneMerged.ts`); these functions only read that.
 *
 * Separate from the hook so the wording is assertable without rendering a tree.
 */
import type { MergedBranch } from "#history/pruneMerged";

export function deletableMerged(merged: MergedBranch[]): MergedBranch[] {
  return merged.filter(branch => !branch.keptReason);
}

/** The toast after a removal, naming each branch that went. */
export function describeMergedDeletion(deleted: string[]): string {
  const noun = deleted.length === 1 ? "branch" : "branches";
  return `Deleted merged ${noun} ${deleted.join(", ")} ✓`;
}
