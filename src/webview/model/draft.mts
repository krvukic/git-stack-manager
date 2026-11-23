/**
 * What the commit panel's Draft toggle shows for a branch.
 *
 * The toggle sets the state a pull request opens in, and nothing else: Submit never changes the
 * state of a pull request that is already open. So the toggle applies only while Submit would
 * open one, which is while the branch has no open pull request. Submit opens a new pull request
 * beside a merged one, and Submit as new pull request beside a closed one, so both count as none.
 */
import type { UIBranch } from "#ui/renderModel";

/**
 * Whether the toggle is on, or null while `branch` has an open pull request and the toggle
 * does not apply.
 *
 * The branch's stored choice comes first. A branch without one takes `draftByDefault`, the
 * Config drawer's *New pull requests*.
 */
export function draftToggle(
  branch: UIBranch,
  draftByDefault: boolean
): boolean | null {
  if (branch.pullRequest?.state === "OPEN") {
    return null;
  }
  return branch.draft ?? draftByDefault;
}
