/**
 * renderModel — turns a repository snapshot into the rows the smartlog draws.
 * Pure functions only (no git, no vscode) => easy to unit test.
 */
import {
  BaseInfo,
  BranchSync,
  ConflictState,
  FileChange,
  RawData,
} from "#git/snapshot";
import {
  BranchTip,
  PullRequestRefreshState,
  PullRequestStatus,
} from "#github/pullRequests";
import { mergedBranches } from "#history/pruneMerged";

/** A branch pill: its name, how it compares to its remote, and its PR if any. */
export type UIBranch = {
  name: string;
  sync: BranchSync | null;
  pullRequest: PullRequestStatus | null;
  /** Position in a `gh stack`, when the branch belongs to one. */
  stack: { position: number; size: number; needsRebase: boolean } | null;
  /**
   * The upstream is trunk itself rather than a pushed copy of this branch, so the sync
   * counts measure it against trunk. Excludes the branch trunk resolves to, whose counts
   * mean what they say. See the computation in `toUI` for how this arises.
   */
  tracksTrunk: boolean;
  /**
   * Another worktree holds this branch, so no checkout can reach it from here. Null when
   * it is free. `gotoTarget` turns this into a disabled button naming the directory.
   */
  worktree: string | null;
};

export type UICommit = {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  branches: string[];
  /** Same branches, with sync and pull request detail attached. */
  branchDetails: UIBranch[];
  parents: string[];
  isHead: boolean;
  isMine: boolean;
  authorName: string;
  authorEmail: string;
  date: string;
};

/** One row of the tree, already ordered top-to-bottom for rendering. */
export type Row =
  | {
      type: "trunk-tip";
      sha: string;
      shortSha: string;
      subject: string;
      trunkRef: string;
      /** Local branch to check out to reach trunk, or null when there is none. */
      trunkBranch: string | null;
      /** Where that branch is already checked out, when another worktree holds it. */
      trunkBranchWorktree: string | null;
      /**
       * Commits `trunkBranch` is missing, when it trails the ref this row draws and has
       * none of its own. Zero when it is current, or when it has local commits — those
       * put it on the graph as a commit row, which carries the counts itself.
       */
      trunkBranchBehind: number;
      /**
       * `trunkBranch` points at this row's commit, so the row draws its pill beside the ref.
       * False when trunk is that branch itself, where a second pill would repeat the first.
       */
      trunkBranchAtTip: boolean;
      isHead: boolean;
    }
  | { type: "ellipsis"; count: number }
  | {
      type: "base";
      sha: string;
      shortSha: string;
      subject: string;
      isHead: boolean;
      /** A stack forked here. False on a row drawn only because the trunk branch points here. */
      isForkPoint: boolean;
      /** The local trunk branch, when it points here: a `main` a fetch left behind. */
      trunkBranch: string | null;
      /** Where that branch is already checked out, when another worktree holds it. */
      trunkBranchWorktree: string | null;
    }
  | { type: "commit"; commit: UICommit };

export type RenderModel = {
  repoName: string;
  /** Label of the action Undo would reverse, or null when the stack is empty. */
  undoLabel?: string | null;
  /**
   * Branches whose pull request merged at their current tip, which the webview deletes when
   * its setting says to. Computed here so the host's rule is the only one: the webview
   * decides whether to ask, never which branches qualify.
   */
  mergedBranches: BranchTip[];
  /** True when `gh stack` tracks at least one branch here. */
  hasGhStack: boolean;
  /** Why PR badges are absent, when they are. Null when PR status works. */
  pullRequestNotice?: string | null;
  /** How the last PR fetch went, for the header's freshness indicator. */
  pullRequestRefresh?: PullRequestRefreshState | null;
  trunkRef: string | null;
  headSha: string;
  headBranch: string | null;
  userEmail: string;
  uncommitted: FileChange[];
  conflict: ConflictState | null;
  rows: Row[];
  error?: string;
};

/** Abbreviate a sha for display. Eight characters stay unambiguous in practice. */
function shorten(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * How far the local trunk branch trails the trunk ref, for the trunk row to report.
 *
 * Reported only while the branch is purely behind. A branch that is also ahead has
 * commits of its own, so it appears as a commit row with a pill and a `diverged` badge
 * that already carries both counts — saying it twice would read as two separate facts.
 */
function behindOnTrunkBranch(rawData: RawData): number {
  const sync = rawData.trunkBranchSync;
  if (!sync || sync.gone || sync.ahead) {
    return 0;
  }
  return sync.behind;
}

export function buildModel(
  rawData: RawData,
  pullRequests: Map<string, PullRequestStatus> = new Map(),
  pullRequestNotice: string | null = null,
  undoLabel: string | null = null,
  pullRequestRefresh: PullRequestRefreshState | null = null
): RenderModel {
  const rows: Row[] = [];
  const model: RenderModel = {
    repoName: rawData.repoName,
    trunkRef: rawData.trunkRef,
    headSha: rawData.headSha,
    headBranch: rawData.headBranch,
    userEmail: rawData.userEmail,
    uncommitted: rawData.uncommitted,
    conflict: rawData.conflict,
    pullRequestNotice,
    pullRequestRefresh,
    undoLabel,
    hasGhStack: rawData.stackMembership.size > 0,
    mergedBranches: mergedBranches(rawData, pullRequests),
    rows,
  };

  if (!rawData.headSha) {
    model.error = "Empty repository (no commits yet).";
    return model;
  }

  const localShas = new Set(rawData.commits.map(commit => commit.sha));
  const childrenOf = new Map<string, string[]>(); // parent sha -> child shas (local only)
  for (const commit of rawData.commits) {
    for (const parent of commit.parents) {
      if (!childrenOf.has(parent)) {
        childrenOf.set(parent, []);
      }
      childrenOf.get(parent)!.push(commit.sha);
    }
  }
  const commitBySha = new Map(
    rawData.commits.map(commit => [commit.sha, commit])
  );

  const toUI = (sha: string): UICommit => {
    const commit = commitBySha.get(sha)!;
    return {
      sha: commit.sha,
      shortSha: shorten(commit.sha),
      subject: commit.subject,
      body: commit.body,
      branches: commit.branches,
      branchDetails: commit.branches.map((name, index) => {
        const sync = commit.branchSyncs[index] ?? null;
        return {
          name,
          sync,
          pullRequest: pullRequests.get(name) ?? null,
          stack: rawData.stackMembership.get(name) ?? null,
          /*
           * `git switch -c` off a remote ref adopts it as upstream under git's default
           * `branch.autoSetupMerge=true`, so a branch cut from origin/main tracks trunk.
           * Its counts then report trunk's movement — "32 behind", on a branch that was
           * never pushed. Trunk's own local branch tracks trunk on purpose and is left
           * alone; `branch.autoSetupMerge=simple` prevents the rest from arising at all.
           */
          tracksTrunk:
            !!sync?.upstream &&
            sync.upstream === rawData.trunkRef &&
            name !== rawData.trunkBranch,
          worktree: rawData.heldBranches.get(name) ?? null,
        };
      }),
      parents: commit.parents,
      isHead: commit.sha === rawData.headSha,
      isMine: !rawData.userEmail || commit.authorEmail === rawData.userEmail,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      date: commit.authorDate,
    };
  };

  /**
   * Emit the subtree rooted at `sha`, newest row first, so it renders ABOVE the
   * commit it descends from. Extra siblings are emitted before the first child,
   * which puts each side branch above the chain it forked from. Horizontal
   * placement is not decided here — the UI assigns lanes from parent SHAs, since
   * a per-row depth cannot express two independent stacks sharing a column.
   */
  const emit = (sha: string, output: Row[]): void => {
    const children = (childrenOf.get(sha) ?? []).filter(child =>
      localShas.has(child)
    );
    // Siblings above the chain, then the first child last so it lands nearest.
    for (const child of children.slice(1).reverse()) {
      emit(child, output);
    }
    const first = children[0];
    if (first !== undefined) {
      emit(first, output);
    }
    // Fork bases and the trunk tip are not local commits; they get their own rows.
    if (commitBySha.has(sha)) {
      output.push({ type: "commit", commit: toUI(sha) });
    }
  };

  /** The subtree above an anchor, as its own block, ready to splice or append. */
  const subtreeOf = (sha: string): Row[] => {
    const output: Row[] = [];
    emit(sha, output);
    return output;
  };

  /*
   * The local trunk branch on trunk below the tip gets an anchor row, as a fork base does.
   * On the tip it rides on the trunk row, and ahead of trunk it is a commit row already.
   */
  const trunkBranchCommit = rawData.trunkBranchCommit?.onTrunk
    ? rawData.trunkBranchCommit
    : null;
  const trunkBranchBelowTip =
    trunkBranchCommit && trunkBranchCommit.distanceToTrunkTip > 0
      ? trunkBranchCommit
      : null;
  const trunkBranchWorktree = rawData.trunkBranch
    ? (rawData.heldBranches.get(rawData.trunkBranch) ?? null)
    : null;
  const forkPoints = new Set(rawData.bases.map(base => base.sha));

  const baseRow = (base: BaseInfo): Row => {
    const holdsTrunkBranch = base.sha === trunkBranchBelowTip?.sha;
    return {
      type: "base",
      sha: base.sha,
      shortSha: shorten(base.sha),
      subject: base.subject,
      isHead: rawData.headSha === base.sha,
      isForkPoint: forkPoints.has(base.sha),
      trunkBranch: holdsTrunkBranch ? rawData.trunkBranch : null,
      trunkBranchWorktree: holdsTrunkBranch ? trunkBranchWorktree : null,
    };
  };

  // Order bases: on-trunk bases sorted newest-first (smallest distance to tip),
  // then any off-trunk bases.
  const onTrunkBases = [
    ...rawData.bases.filter(base => base.onTrunk),
    ...(trunkBranchBelowTip && !forkPoints.has(trunkBranchBelowTip.sha)
      ? [trunkBranchBelowTip]
      : []),
  ].sort((a, b) => a.distanceToTrunkTip - b.distanceToTrunkTip);
  const offTrunkBases = rawData.bases.filter(base => !base.onTrunk);

  if (rawData.trunkTip) {
    rows.push({
      type: "trunk-tip",
      sha: rawData.trunkTip.sha,
      shortSha: shorten(rawData.trunkTip.sha),
      subject: rawData.trunkTip.subject,
      trunkRef: rawData.trunkRef ?? "trunk",
      trunkBranch: rawData.trunkBranch,
      trunkBranchWorktree,
      trunkBranchBehind: behindOnTrunkBranch(rawData),
      trunkBranchAtTip:
        trunkBranchCommit?.distanceToTrunkTip === 0 &&
        rawData.trunkBranch !== rawData.trunkRef,
      isHead: rawData.headSha === rawData.trunkTip.sha,
    });
    // A stack forked directly off the tip sits above it, so it splices in before the tip row.
    if (onTrunkBases.some(base => base.sha === rawData.trunkTip?.sha)) {
      rows.splice(rows.length - 1, 0, ...subtreeOf(rawData.trunkTip.sha));
    }
  }

  let previousDistance = 0; // distance (from trunk tip) of the previous rendered anchor
  for (const base of onTrunkBases) {
    if (base.sha === rawData.trunkTip?.sha) {
      continue;
    } // handled above
    const between = base.distanceToTrunkTip - previousDistance - 1;
    if (between > 0) {
      rows.push({ type: "ellipsis", count: between });
    }
    rows.push(...subtreeOf(base.sha), baseRow(base));
    previousDistance = base.distanceToTrunkTip;
  }

  for (const base of offTrunkBases) {
    rows.push({ type: "ellipsis", count: -1 }); // "not on trunk" separator
    rows.push(...subtreeOf(base.sha), baseRow(base));
  }

  return model;
}
