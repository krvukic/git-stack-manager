/**
 * stackLink — make GitHub link a stack's pull requests in the order the tree draws them.
 *
 * `gh stack link` does the linking, and this module passes it pull request numbers rather
 * than branch names: `gh stack link` pushes a branch that it is given by name, and linking
 * pushes no code here. The rules below come from running the command against a real stack:
 *
 *   - No stack yet: `gh stack link 16 17 18` creates one.
 *   - A stack that the list starts with: the same command appends the rest.
 *   - A list that adds to a stack while leaving out one of its pull requests, or that orders
 *     them differently, is refused. GitHub only appends, so that case takes
 *     `gh stack unstack <stack>` first.
 *
 * `planStackLink` picks between them from the pull request status the caller already has, so
 * the only calls made are the ones that change something.
 */
import { GitRunner } from "#git/runner";
import { runGh } from "#github/ghRunner";
import { PullRequestStatus } from "#github/pullRequests";

/** One branch of a stack, bottom first, with what GitHub reports for its pull request. */
export type StackLayer = {
  branch: string;
  pullRequest: PullRequestStatus | null;
};

export type StackLinkPlan = {
  /** The pull requests to link, bottom first. */
  pullRequests: number[];
  /** Their branches, in the same order. */
  branches: string[];
  /** Stacks to dissolve first, because GitHub cannot reach this order by appending. */
  unstack: number[];
  /**
   * What the link amounts to: a new stack, more pull requests on top of one, a stack rebuilt in
   * another order, or nothing because GitHub already links exactly these.
   */
  kind: "create" | "extend" | "rebuild" | "current";
  /** The stack that `extend` and `current` refer to. */
  stack: number | null;
};

/**
 * Work out the link for `layers`, or the sentence saying why there is nothing to link.
 *
 * `required` counts the layers, from the bottom, that must each have an open pull request: the
 * ones up to the commit the reader clicked. A layer above that joins while it has one, and the
 * first without one ends the list.
 *
 * A merged pull request at the bottom is left out. Its branch stays in the tree until it is
 * removed, and GitHub has already taken its pull request out of what is still to merge.
 */
export function planStackLink(
  layers: StackLayer[],
  required: number
): StackLinkPlan | string {
  const firstUnmerged = layers.findIndex(
    layer => layer.pullRequest?.state !== "MERGED"
  );
  const open = firstUnmerged === -1 ? [] : layers.slice(firstUnmerged);
  const mustHave = Math.max(0, required - Math.max(0, firstUnmerged));
  const linked: StackLayer[] = [];
  for (const [index, layer] of open.entries()) {
    if (layer.pullRequest?.state === "OPEN") {
      linked.push(layer);
      continue;
    }
    if (index < mustHave) {
      // Submit stack stops at a closed pull request, so "Submit the stack first" would not help.
      return layer.pullRequest?.state === "CLOSED"
        ? `${layer.branch}'s pull request #${layer.pullRequest.number} is closed. Reopen it on GitHub, or right-click ${layer.branch}'s commit and choose Submit as new pull request.`
        : `${layer.branch} has no open pull request. Submit the stack first.`;
    }
    break;
  }
  if (linked.length < 2) {
    return "A stack needs at least two open pull requests.";
  }

  const pullRequests = linked.map(layer => layer.pullRequest?.number ?? 0);
  const branches = linked.map(layer => layer.branch);
  const stacks = [
    ...new Set(
      linked.flatMap(layer =>
        layer.pullRequest?.stack ? [layer.pullRequest.stack.number] : []
      )
    ),
  ];
  const [stack] = stacks;
  if (stack === undefined) {
    return { pullRequests, branches, unstack: [], kind: "create", stack: null };
  }
  // The pull requests that GitHub already links have to lead the list, each in its own
  // position of the one stack. Anything else is an order that appending cannot reach.
  const members = linked.filter(layer => layer.pullRequest?.stack).length;
  const leadsInOrder =
    stacks.length === 1 &&
    linked.every((layer, index) => {
      const entry = layer.pullRequest?.stack;
      return index < members
        ? entry?.number === stack && entry.position === index + 1
        : !entry;
    });
  if (!leadsInOrder) {
    return {
      pullRequests,
      branches,
      unstack: stacks,
      kind: "rebuild",
      stack: null,
    };
  }
  if (members === linked.length) {
    // Every pull request here is linked, in this order. GitHub's stack may go on above them,
    // as it does where the tree forks below the top, and that is no reason to touch it.
    return { pullRequests, branches, unstack: [], kind: "current", stack };
  }
  const size = linked[0]?.pullRequest?.stack?.size ?? 0;
  if (size > members) {
    // GitHub's stack holds a pull request that is not in the list, above the ones that are.
    // The rest of the list cannot be appended without leaving that one out.
    return {
      pullRequests,
      branches,
      unstack: stacks,
      kind: "rebuild",
      stack: null,
    };
  }
  return { pullRequests, branches, unstack: [], kind: "extend", stack };
}

/** Run a plan's `gh stack` calls. A `current` plan makes none. */
export async function runStackLink(
  git: GitRunner,
  plan: StackLinkPlan
): Promise<void> {
  if (plan.kind === "current") {
    return;
  }
  for (const stack of plan.unstack) {
    await runGh(git, ["stack", "unstack", String(stack)]);
  }
  await runGh(git, ["stack", "link", ...plan.pullRequests.map(String)]);
}

/** Dissolve a stack on GitHub. Merged and queued pull requests stay linked, as GitHub rules. */
export async function unstack(git: GitRunner, stack: number): Promise<void> {
  await runGh(git, ["stack", "unstack", String(stack)]);
}
