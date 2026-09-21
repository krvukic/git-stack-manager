/**
 * Whether an action can run, for the two surfaces that each offer it.
 *
 * Absorb and Undo are reachable from a button and from a key, and the two were written
 * separately: `WorkingCopy` disabled Absorb on a conflict, while `useKeyboard` also required
 * something dirty to absorb. They agreed only because the working copy block renders when
 * something is dirty, so the button never existed in the case the key rejected — a guarantee
 * a caller can drop without either file changing. One predicate per action removes the
 * question: the button and the key read the same expression.
 */
import type { RenderModel } from "#ui/renderModel";

/**
 * Absorb needs modified files to attribute, and a paused rebase makes it unsafe: it rewrites
 * the commits git is in the middle of replaying.
 */
export function canAbsorb(model: RenderModel): boolean {
  return model.uncommitted.length > 0 && !model.conflict;
}

/**
 * Undo restores refs only, so it stays available mid-conflict — backing out a rebase that
 * stopped is when it is most wanted. The label doubles as the checkpoint's existence.
 */
export function canUndo(model: RenderModel): boolean {
  return Boolean(model.undoLabel);
}
