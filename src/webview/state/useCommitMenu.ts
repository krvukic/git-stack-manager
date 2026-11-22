/**
 * The right-click menu's contents for a commit.
 *
 * Built from the model rather than fixed, because which entries apply depends on where the
 * commit sits: a commit with a branch gets Submit, one whose branch has an open pull request
 * gets the `gh stack` section, and a stopped rebase replaces the rebase entries with an
 * explanation instead of hiding them.
 */
import type { RebaseDestination } from "#history/rebase";
import type { RenderModel, UIBranch, UICommit } from "#ui/renderModel";
import type { MenuItem } from "../components/ContextMenu";
import {
  countDescendants,
  findCommit,
  rebaseRefusal,
  stackBaseSha,
  stackBranchesUpTo,
  submitTarget,
  truncate,
  type RebaseRefusal,
} from "../model/commits.mjs";

export type CommitMenuActions = {
  onGoto: (commit: UICommit) => void;
  onCopySha: (commit: UICommit) => void;
  onCopyBranchName: (branch: string) => void;
  onAdoptRemote: (branch: string) => void;
  onDeleteBranch: (branch: string) => void;
  onSubmit: (commit: UICommit) => void;
  onSubmitStack: (commit: UICommit) => void;
  onSplit: (commit: UICommit) => void;
  onFold: (commit: UICommit) => void;
  /** Rebase the commit `rootSha` names, and its descendants, onto `destination`. */
  onRebase: (rootSha: string, destination: RebaseDestination) => void;
};

/**
 * One **Copy branch name** entry per branch on the commit, or none when it carries no branch.
 *
 * Absent rather than dimmed when the commit carries no branch, as Submit is. The refused
 * **Delete branch** entries below are the other case, and `deleteItems` says why they stay.
 *
 * `copyBranchItems` appends the name only when the commit carries more than one branch, where
 * the entries would otherwise be identical. With one branch the label stays bare and the
 * description carries the name, as Copy commit hash does with its sha.
 */
function copyBranchItems(
  commit: UICommit,
  actions: CommitMenuActions
): MenuItem[] {
  const branches = (commit.branchDetails ?? []).map(branch => branch.name);
  return branches.map(name => ({
    label:
      branches.length > 1 ? `Copy branch name ${name}` : "Copy branch name",
    description: `Copy ${name} to the clipboard`,
    run: () => actions.onCopyBranchName(name),
  }));
}

/**
 * One **Delete branch** entry per branch on the commit, each carrying its own refusal.
 *
 * Each refused branch keeps its entry, which names the reason, as the rebase entries do: a
 * branch with no entry at all reads as a bug in the menu. The host always refuses trunk, so
 * `main` never gets a runnable entry.
 */
function deleteItems(commit: UICommit, actions: CommitMenuActions): MenuItem[] {
  return (commit.branchDetails ?? []).map(branch =>
    branch.deletionRefusal
      ? {
          label: `Delete branch ${branch.name} — ${branch.deletionRefusal}`,
        }
      : {
          label: `Delete branch ${branch.name}`,
          description:
            "Remove the local branch. Its commits stay in the reflog, and Undo puts the branch back",
          run: () => actions.onDeleteBranch(branch.name),
        }
  );
}

/**
 * The remote that a layer tracks, so the label can name it instead of falling back on "the remote".
 * Null on a layer that tracks nothing, where the entry still applies, because the layers above it
 * may track theirs.
 */
function remoteOf(branch: UIBranch): string | null {
  return branch.sync?.upstream?.split("/")[0] ?? null;
}

/** "this commit", or "this commit + 2 above": what a rebase rooted at `sha` moves. */
function movingSet(model: RenderModel, sha: string, root: string): string {
  const above = countDescendants(model, sha) - 1;
  return above ? `${root} + ${above} above` : root;
}

/**
 * A rebase entry, dimmed with its reason when the model already shows that the host would
 * refuse it. `stays` names the destination in the two reasons.
 */
function rebaseItem(
  label: string,
  description: string,
  refusal: RebaseRefusal | null,
  stays: string,
  run: () => void
): MenuItem {
  if (refusal === "moves-destination") {
    return { label: `${label} — ${stays} is one of its descendants` };
  }
  if (refusal === "already-there") {
    return { label: `${label} — already on ${stays}` };
  }
  return { label, description, run };
}

/**
 * The four rebases: onto and from the checked-out commit, onto trunk, and onto the stack base.
 *
 * All four walk the graph, so each carries a fork above its root, with every branch on it.
 *
 * The first two need a second commit, so the checked-out commit's own menu leaves them out.
 */
function rebaseItems(
  model: RenderModel,
  commit: UICommit,
  actions: CommitMenuActions
): MenuItem[] {
  const moving = movingSet(model, commit.sha, "this commit");
  const items: MenuItem[] = [];

  if (!commit.isHead && model.headSha) {
    const head = findCommit(model, model.headSha);
    items.push(
      rebaseItem(
        "Rebase this commit and its descendants onto current commit",
        `Re-parent ${moving} on the commit you are on, without a fetch.`,
        rebaseRefusal(model, commit, model.headSha),
        "the current commit",
        () =>
          actions.onRebase(commit.sha, { kind: "commit", sha: model.headSha })
      ),
      head
        ? rebaseItem(
            "Rebase current commit and its descendants onto this commit",
            `Re-parent ${movingSet(model, head.sha, "the commit you are on")} on this one, without a fetch.`,
            rebaseRefusal(model, head, commit.sha),
            "this commit",
            () =>
              actions.onRebase(head.sha, { kind: "commit", sha: commit.sha })
          )
        : {
            // A trunk commit is not this checkout's to move.
            label:
              "Rebase current commit and its descendants onto this commit — the current commit is on trunk",
          }
    );
  }

  const base = stackBaseSha(model, commit);
  items.push(
    {
      label: "Rebase this commit and its descendants onto latest trunk",
      description: `Fetch ${model.trunkRef || "trunk"}, then replay ${moving} on its tip — every commit above this one, stacked or not.`,
      run: () => actions.onRebase(commit.sha, { kind: "trunk" }),
    },
    rebaseItem(
      "Rebase this commit and its descendants onto stack base",
      `Re-parent ${moving} on the commit this stack forked from, without pulling in newer trunk commits.`,
      base ? rebaseRefusal(model, commit, base) : null,
      "the stack base",
      () => actions.onRebase(commit.sha, { kind: "base" })
    )
  );
  return items;
}

export function commitMenuItems(
  model: RenderModel,
  commit: UICommit,
  actions: CommitMenuActions
): MenuItem[] {
  const items: MenuItem[] = [
    { head: `${commit.shortSha} ${truncate(commit.subject, 34)}` },
  ];

  if (!commit.isHead) {
    // The separator closes Goto's section rather than opening Copy's, so the HEAD row — which
    // has no Goto — does not get a hairline directly under the heading.
    items.push(
      { label: "Goto", run: () => actions.onGoto(commit) },
      { separator: true }
    );
  }
  // Above the conflict return, because reading a sha off a stopped rebase is as safe as
  // reading one off any other commit, and it is the state a reader most wants to quote.
  items.push(
    {
      label: "Copy commit hash",
      description: `Copy the full sha, ${commit.sha}, to the clipboard`,
      run: () => actions.onCopySha(commit),
    },
    ...copyBranchItems(commit, actions)
  );

  if (model.conflict) {
    // A rebase already holds the working copy; starting another would fail deep inside git
    // with a confusing message.
    items.push(
      { separator: true },
      { label: "Rebase — finish the conflict first" }
    );
    return items;
  }

  const submittable = submitTarget(commit);
  if (submittable) {
    const existing = submittable.pullRequest;
    items.push(
      { separator: true },
      {
        label: existing
          ? `Submit ${submittable.name} → #${existing.number}`
          : `Submit ${submittable.name} as pull request`,
        description:
          "Push the branch and set the pull request title and body from this commit message",
        run: () => actions.onSubmit(commit),
      }
    );
    const layers = stackBranchesUpTo(model, commit);
    if (layers.length > 1) {
      items.push({
        label: `Submit stack — ${layers.length} branches up to ${submittable.name}`,
        description:
          "Submit each branch from the bottom up, so every pull request has its base on GitHub",
        run: () => actions.onSubmitStack(commit),
      });
    }
  }

  items.push(
    { separator: true },
    {
      label: "Split into two commits…",
      description: "Choose which changes go in the first commit",
      run: () => actions.onSplit(commit),
    },
    {
      label: "Fold into the commit below",
      description: "Combine this commit with its parent, keeping both messages",
      run: () => actions.onFold(commit),
    },
    { separator: true },
    ...rebaseItems(model, commit, actions)
  );

  // The section is about the stack's pull requests, so it needs one to act on.
  const published = (commit.branchDetails ?? []).find(
    detail => detail.pullRequest?.state === "OPEN"
  );
  if (published) {
    items.push(
      { separator: true },
      { head: "gh stack" },
      {
        // The opposite direction to the rebases above. Those replay local commits; this entry
        // takes the commits that the remote already has. Once GitHub restacks a stack, the
        // remote has the correct copy, and a local replay reaches the same trees under new
        // shas, which the next submit then force-pushes over every branch.
        label: "Take GitHub's version",
        description: `Fetch ${remoteOf(published) ?? "the remote"}, then point every branch of this stack at the commit that its remote branch has, where GitHub's restack left it once a lower pull request merged. This pushes nothing, Undo puts the branches back, and a branch with work that the remote does not have stays where it is`,
        run: () => actions.onAdoptRemote(published.name),
      }
    );
  }

  const deletions = deleteItems(commit, actions);
  if (deletions.length) {
    // Last, and behind a separator: these are the only entries here that remove a ref rather than
    // moving one, so they sit below the entries a reader clicks most.
    items.push({ separator: true }, ...deletions);
  }
  return items;
}
