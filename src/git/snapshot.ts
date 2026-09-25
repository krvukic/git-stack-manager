/**
 * snapshot — the shape of a repository read.
 *
 * These types are the contract between reading (`#git/reader`) and everything that
 * consumes a read: the render model, every history edit, and the tests. They live
 * apart from the reader so importing the shape does not pull in the reading logic,
 * and so the contract is visible in one screen.
 */
import { StackMembership } from "#github/ghStack";

/**
 * How a local branch compares to the remote branch it tracks. Every field comes from the ref
 * read, so knowing whether work is unsubmitted costs no extra git command —
 * `%(upstream:track)` already computes the ahead and behind counts.
 */
export type BranchSync = {
  name: string;
  /** Remote-tracking ref, e.g. "origin/feature-a"; null when never pushed. */
  upstream: string | null;
  /** Commits on the local branch that the remote does not have. */
  ahead: number;
  /** Commits on the remote that the local branch does not have. */
  behind: number;
  /** The upstream ref is configured but no longer exists (branch deleted). */
  gone: boolean;
};

export type RawCommit = {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string; // ISO 8601
  subject: string;
  body: string; // full message
  branches: string[]; // local branch tips pointing here
  /** Sync state for each entry in `branches`, same order. */
  branchSyncs: BranchSync[];
};

export type BaseInfo = {
  sha: string;
  subject: string;
  authorDate: string;
  onTrunk: boolean;
  /** Commits reachable from the trunk tip but not from this base. 0 => base IS the tip. */
  distanceToTrunkTip: number;
};

export type FileChange = {
  status: string; // M A D R C ?
  path: string;
  oldPath?: string;
};

export type CommitRef = {
  sha: string;
  subject: string;
  authorDate: string;
};

/** An interrupted rebase the user has to finish or abort before anything else. */
export type ConflictState = {
  /** Branch being rebased, short form, or null when rebasing a detached HEAD. */
  branch: string | null;
  unmergedFiles: string[];
  /** Progress through the todo list, e.g. step 2 of 5. */
  step: number;
  totalSteps: number;
};

export type RawData = {
  repoRoot: string;
  /** `gh stack` placement per branch name; empty when the extension is unused. */
  stackMembership: Map<string, StackMembership>;
  repoName: string;
  userEmail: string;
  trunkRef: string | null;
  trunkTip: CommitRef | null;
  /**
   * The local branch to check out to reach trunk, when one exists.
   *
   * `trunkRef` is usually a remote ref (`origin/main`), and checking that out detaches
   * HEAD — which is not what "go to main" means. This is the local branch tracking it,
   * so the trunk row can offer Goto like any other. Null when trunk is a remote with no
   * local counterpart; the row then offers nothing rather than silently detaching.
   */
  trunkBranch: string | null;
  /**
   * Branch name to the worktree holding it, for every branch some *other* worktree has
   * checked out. Empty in the common single-worktree repository.
   *
   * Git binds a branch to one worktree, so switching to a branch another worktree has
   * checked out fails outright. Every Goto reads this to report the path instead of
   * offering a button whose only outcome is a git error.
   */
  heldBranches: Map<string, string>;
  /**
   * How `trunkBranch` compares to the remote it tracks. Null when there is no local
   * trunk branch at all.
   *
   * The trunk row is the only place this can be reported. A trunk branch that has merely
   * fallen behind its remote carries no local commits, so the history walk never sees it
   * and it gets no row, no pill, and no badge — leaving "42 commits behind" visible in
   * VS Code's status bar and nowhere in the graph.
   */
  trunkBranchSync: BranchSync | null;
  /**
   * The commit `trunkBranch` points at, located against trunk the way a fork base is. Null
   * when there is no local trunk branch.
   *
   * A `main` that trails `origin/main` sits on a trunk commit that is neither local nor a
   * fork base, so without this the graph drew no row for it. Goto on the trunk row, then a
   * background fetch, left HEAD on that commit and "You are here" nowhere on screen.
   */
  trunkBranchCommit: BaseInfo | null;
  headSha: string;
  headBranch: string | null;
  commits: RawCommit[]; // local-only commits, topo order (newest first)
  bases: BaseInfo[];
  uncommitted: FileChange[];
  conflict: ConflictState | null;
};
