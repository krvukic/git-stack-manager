/**
 * The right-click menu's contents for a commit.
 *
 * Built from the model rather than fixed, because which entries apply depends on where the
 * commit sits: a `gh stack` member gets the stack commands, a commit with a branch gets
 * Submit, and a stopped rebase replaces the rebase entries with an explanation instead of
 * hiding them.
 */
import type { RenderModel, UIBranch, UICommit } from "#ui/renderModel";
import type { MenuItem } from "../components/ContextMenu";
import {
  countDescendants,
  stackBranchesUpTo,
  submitTarget,
  truncate,
} from "../model/commits.mjs";

export type CommitMenuActions = {
  onGoto: (commit: UICommit) => void;
  onCopySha: (commit: UICommit) => void;
  onCheckoutBranch: (branch: string) => void;
  onGhStack: (payload: Record<string, unknown>, label: string) => void;
  onAdoptRemote: (branch: string) => void;
  onDeleteBranch: (branch: string) => void;
  onOpenTerminal: (command: string) => void;
  onSubmit: (commit: UICommit) => void;
  onSubmitStack: (commit: UICommit) => void;
  onSplit: (commit: UICommit) => void;
  onFold: (commit: UICommit) => void;
  onRebase: (commit: UICommit, destination: "trunk" | "base") => void;
};

/**
 * The three `gh stack` commands that read the stack from HEAD, plus the checkout that lets them.
 *
 * `submit`, `push`, and `sync` take no branch argument, so each one finds its stack through the
 * checked-out branch. Offered from trunk they refuse after the click with `branch "main" belongs to
 * multiple stacks; checkout a non-trunk branch first` — a refusal from a CLI the reader never
 * invoked. Omitting `run` states that before the click instead, as the conflict case does for
 * rebase.
 */
function fromHeadItems(
  model: RenderModel,
  layers: string[],
  actions: CommitMenuActions
): MenuItem[] {
  const headInStack = !!model.headBranch && layers.includes(model.headBranch);
  const topLayer = layers[layers.length - 1];
  const reason = `\`gh stack\` reads the stack from the checked-out branch, and HEAD is ${
    model.headBranch ? `on ${model.headBranch}` : "detached"
  }.`;
  const entry = (
    label: string,
    description: string,
    payload: Record<string, unknown>,
    toast: string
  ): MenuItem =>
    headInStack
      ? { label, description, run: () => actions.onGhStack(payload, toast) }
      : {
          label: `${label} — check out a layer first`,
          description: `${description}. ${reason}`,
        };

  return [
    // Any layer inside the stack lets all three run, since each reads the whole stack from its
    // record. The top is offered because a later `--upstack` from there covers every layer too.
    ...(headInStack || !topLayer
      ? []
      : [
          {
            label: `Checkout ${topLayer} (top layer)`,
            description: "What the three entries below need, in one click",
            run: () => actions.onCheckoutBranch(topLayer),
          },
        ]),
    entry(
      "Push stack",
      "gh stack push — force-with-lease every branch in the stack",
      { command: "push" },
      "Pushing stack"
    ),
    entry(
      "Submit stack (create/update PRs)",
      "gh stack submit",
      { command: "submit" },
      "Submitting stack"
    ),
    entry(
      "Sync stack with remote (prune merged)",
      "gh stack sync --prune",
      { command: "sync", prune: true },
      "Syncing stack"
    ),
  ];
}

/**
 * One **Delete branch** entry per branch on the commit, each carrying its own refusal.
 *
 * Each refused branch keeps its entry, which names the reason, as the rebase and `gh stack` entries
 * do: a branch with no entry at all reads as a bug in the menu. The host always refuses trunk, so
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
    // The separator closes Goto's section rather than opening Copy's, so the HEAD row — which
    // has no Goto — does not get a hairline directly under the heading.
    items.push(
      { label: "Goto", run: () => actions.onGoto(commit) },
      { separator: true }
    );
  }
  // Above the conflict return, because reading a sha off a stopped rebase is as safe as
  // reading one off any other commit, and it is the state a reader most wants to quote.
  items.push({
    label: "Copy commit hash",
    description: `Copy the full sha, ${commit.sha}, to the clipboard`,
    run: () => actions.onCopySha(commit),
  });

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
        description:
          "gh stack rebase — fetches trunk, then replays every recorded layer onto it, bottom-to-top",
        run: () =>
          actions.onGhStack(
            { command: "rebase", scope: "all", branch: stacked.name },
            "Rebasing stack"
          ),
      },
      {
        label: "Rebase this layer and above",
        description:
          "gh stack rebase --upstack — the same, from this layer up, leaving those below alone. Checks this layer out first, since gh stack starts from HEAD",
        run: () =>
          actions.onGhStack(
            { command: "rebase", scope: "upstack", branch: stacked.name },
            "Rebasing upstack"
          ),
      },
      {
        // The opposite direction to the two rebases above. Those two replay local commits; this
        // entry takes the commits that the remote already holds. Once GitHub restacks a stack, the
        // remote holds the correct copy, and a local replay reaches the same trees under new
        // shas and force-pushes every branch.
        label: `Move stack onto ${remoteOf(stacked) ?? "the remote"}`,
        description:
          "Point every layer at the commit that its remote branch holds, where GitHub's restack left it once a lower pull request merged. This pushes nothing, Undo puts the branches back, and the move refuses when a layer holds work that the remote does not have",
        run: () => actions.onAdoptRemote(stacked.name),
      },
      ...fromHeadItems(model, stacked.stack?.branches ?? [], actions),
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
    // These two move commits; the `gh stack` pair above moves layers. Git walks the graph, so
    // these carry a fork above the commit and branches no stack record names — which is why both
    // families stay rather than collapsing into one entry.
    {
      label: `Rebase ${moving} onto ${model.trunkRef || "trunk"}`,
      description:
        "Fetch trunk, then replay these commits on its tip — every commit above this one, stacked or not. Re-records the bases of any gh stack layer it moves",
      run: () => actions.onRebase(commit, "trunk"),
    },
    {
      label: `Rebase ${moving} onto stack base`,
      description:
        "Re-parent these commits on the one this stack forked from, without pulling in newer trunk commits. Re-records the bases of any gh stack layer it moves",
      run: () => actions.onRebase(commit, "base"),
    }
  );

  const deletions = deleteItems(commit, actions);
  if (deletions.length) {
    // Last, and behind a separator: these are the only entries here that remove a ref rather than
    // moving one, so they sit below the entries a reader clicks most.
    items.push({ separator: true }, ...deletions);
  }
  return items;
}
