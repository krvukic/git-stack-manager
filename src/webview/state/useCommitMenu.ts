/**
 * The right-click menu's contents for a commit.
 *
 * Built from the model rather than fixed, because which entries apply depends on where the
 * commit sits: a `gh stack` member gets the stack commands, a commit with a branch gets
 * Submit, and a stopped rebase replaces the rebase entries with an explanation instead of
 * hiding them.
 */
import type { RenderModel, UICommit } from "#ui/renderModel";
import type { MenuItem } from "../components/ContextMenu";
import {
  countDescendants,
  stackBranchesUpTo,
  submitTarget,
  truncate,
} from "../model/commits.mjs";

export type CommitMenuActions = {
  onGoto: (commit: UICommit) => void;
  onGhStack: (payload: Record<string, unknown>, label: string) => void;
  onOpenTerminal: (command: string) => void;
  onSubmit: (commit: UICommit) => void;
  onSubmitStack: (commit: UICommit) => void;
  onSplit: (commit: UICommit) => void;
  onFold: (commit: UICommit) => void;
  onRebase: (commit: UICommit, destination: "trunk" | "base") => void;
};

export function commitMenuItems(
  model: RenderModel,
  commit: UICommit,
  actions: CommitMenuActions
): MenuItem[] {
  const descendantCount = countDescendants(model, commit.sha);
  const moving =
    descendantCount === 1
      ? "this commit"
      : `this commit + ${descendantCount - 1} above`;
  const items: MenuItem[] = [
    { head: `${commit.shortSha} ${truncate(commit.subject, 34)}` },
  ];

  if (!commit.isHead) {
    items.push({ label: "Goto", run: () => actions.onGoto(commit) });
  }

  if (model.conflict) {
    // A rebase already holds the working copy; starting another would fail deep inside git
    // with a confusing message.
    items.push(
      { separator: true },
      { label: "Rebase — finish the conflict first" }
    );
    return items;
  }

  const stacked = (commit.branchDetails ?? []).find(detail => detail.stack);
  if (stacked) {
    // `gh stack` owns the server-side stack object and pushes with --force-with-lease, so
    // delegate rather than reimplement these.
    items.push(
      { separator: true },
      { head: "gh stack" },
      {
        label: "Rebase stack (all layers)",
        description: "gh stack rebase — realign every layer bottom-to-top",
        run: () =>
          actions.onGhStack(
            { command: "rebase", scope: "all" },
            "Rebasing stack"
          ),
      },
      {
        label: "Rebase this layer and above",
        description: "gh stack rebase --upstack",
        run: () =>
          actions.onGhStack(
            { command: "rebase", scope: "upstack" },
            "Rebasing upstack"
          ),
      },
      {
        label: "Push stack",
        description:
          "gh stack push — force-with-lease every branch in the stack",
        run: () => actions.onGhStack({ command: "push" }, "Pushing stack"),
      },
      {
        label: "Submit stack (create/update PRs)",
        description: "gh stack submit",
        run: () => actions.onGhStack({ command: "submit" }, "Submitting stack"),
      },
      {
        label: "Sync stack with remote (prune merged)",
        description: "gh stack sync --prune",
        run: () =>
          actions.onGhStack({ command: "sync", prune: true }, "Syncing stack"),
      },
      {
        // Drop, insert, rename, and reorder all live in gh stack's own TUI, so point at it
        // rather than building a second one.
        label: "Restructure stack (drop, reorder, insert)…",
        description:
          "Runs `gh stack modify` in a terminal — it needs an interactive TUI",
        run: () => actions.onOpenTerminal("gh stack modify"),
      }
    );
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
    {
      label: `Rebase ${moving} onto ${model.trunkRef || "trunk"}`,
      description: "Fetch trunk, then replay these commits on its tip",
      run: () => actions.onRebase(commit, "trunk"),
    },
    {
      label: `Rebase ${moving} onto stack base`,
      description:
        "Re-parent onto the commit this stack forked from, without pulling in newer trunk commits",
      run: () => actions.onRebase(commit, "base"),
    }
  );
  return items;
}
