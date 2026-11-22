/**
 * rebase — move a commit and everything above it onto a new destination.
 *
 * Sapling's "rebase" moves a commit together with its descendants; the branch
 * pointers scattered through a branch-per-commit stack have to follow. Git's
 * own `rebase --update-refs` does exactly that bookkeeping, so each
 * chain is one `git rebase` rather than a per-branch loop that re-resolves
 * every ref by hand.
 *
 * A stack that forks needs one rebase per leaf, because `--update-refs` only
 * tracks refs along the single linear chain it replays. Later leaves must be
 * told where their fork point landed, and a fork point often carries no branch
 * name to look it up by — so a temporary marker ref is planted there first. It
 * rides along on `--update-refs` like any other ref and reveals the new sha.
 *
 * Conflicts stop the rebase in place. Git's own state is left untouched so the
 * user resolves with their configured mergetool and continues, exactly as they
 * would from the terminal. Because a multi-chain rebase can stop partway, the
 * remaining steps are journalled next to git's rebase state and replayed after
 * `--continue`; without that, resolving a conflict would silently abandon every
 * chain that had not run yet.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { uniqueSorted } from "#core/values";
import { GitError, GitRunner } from "#git/runner";
import { RawCommit, RawData } from "#git/snapshot";
import { requireSupportedGit } from "#git/version";

/** Where a rebase should land. Mirrors Sapling's two menu entries. */
export type RebaseDestination =
  { kind: "trunk" } | { kind: "base" } | { kind: "commit"; sha: string };

export type RebaseStep = {
  /** Ref or sha to replay: the leaf of one linear chain. */
  leaf: string;
  /** Exclusive lower bound — the old parent of the chain's bottom commit. */
  upstream: string;
  /**
   * Marker ref naming the fork point this chain hangs off, when it has one.
   *
   * `| undefined` as well as optional, because a chain off trunk sets the key to
   * `undefined` rather than omitting it, and the one reader treats the two the same:
   * `step.ontoMarker ?? plan.destinationSha`.
   */
  ontoMarker?: string | undefined;
};

export type RebasePlan = {
  steps: RebaseStep[];
  destinationSha: string;
  /** Marker ref -> the sha it was planted on. */
  markers: Record<string, string>;
  /** Branch names that will move, for the result message. */
  branches: string[];
  /** Ref to return HEAD to when the whole plan finishes. */
  originalRef: string;
  /**
   * Marker tracking a detached HEAD that is itself being rebased. Restoring by
   * the original sha would strand the user on the abandoned copy, so the marker
   * reports where that commit landed.
   *
   * `| undefined` for the same reason as `ontoMarker`: an attached HEAD sets the key
   * rather than omitting it.
   */
  headMarker?: string | undefined;
};

export type RebaseOutcome = {
  moved: string[];
  conflict: boolean;
};

// Markers must live under refs/heads: `rebase --update-refs` only rewrites refs
// in that namespace, so a marker anywhere else is silently left on the old
// commit and every chain above a fork lands back on abandoned history. The
// "gsm-rebase/" prefix keeps them out of the way of real branch names, and each
// one is deleted as soon as the plan finishes.
const MARKER_PREFIX = "refs/heads/gsm-rebase";
const PLAN_FILE = "gsm-rebase-plan.json";

/**
 * Collect `rootSha` and every local descendant — the set Sapling moves when you
 * rebase a commit "and its descendants".
 */
function collectDescendants(
  commits: RawCommit[],
  rootSha: string
): RawCommit[] {
  const childrenOf = buildChildIndex(commits);
  const bySha = new Map(commits.map(commit => [commit.sha, commit]));
  const collected: RawCommit[] = [];
  const seen = new Set<string>();
  const queue = [rootSha];
  while (queue.length) {
    const sha = queue.pop()!;
    if (seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    const commit = bySha.get(sha);
    if (!commit) {
      continue;
    } // a base or trunk commit — outside the local set
    collected.push(commit);
    queue.push(...(childrenOf.get(sha) ?? []));
  }
  return collected;
}

function buildChildIndex(
  commits: RawCommit[],
  within?: Set<string>
): Map<string, string[]> {
  const childrenOf = new Map<string, string[]>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (within && !within.has(parent)) {
        continue;
      }
      const list = childrenOf.get(parent);
      if (list) {
        list.push(commit.sha);
      } else {
        childrenOf.set(parent, [commit.sha]);
      }
    }
  }
  return childrenOf;
}

/** Resolve a destination choice to a concrete sha. */
export function resolveDestination(
  snapshot: RawData,
  rootSha: string,
  destination: RebaseDestination
): string {
  if (destination.kind === "commit") {
    return destination.sha;
  }
  if (destination.kind === "trunk") {
    if (!snapshot.trunkTip) {
      throw new GitError(
        "No trunk detected — cannot rebase onto trunk.",
        "rebase"
      );
    }
    return snapshot.trunkTip.sha;
  }
  // "base": the fork point of the stack this commit sits in — its first
  // non-local ancestor. Landing here re-parents a side branch onto its stack's
  // footing without pulling in newer trunk commits.
  const bySha = new Map(snapshot.commits.map(commit => [commit.sha, commit]));
  let current = bySha.get(rootSha);
  while (current) {
    const parent: string | undefined = current.parents[0];
    if (!parent) {
      break;
    }
    const parentCommit = bySha.get(parent);
    if (!parentCommit) {
      return parent;
    }
    current = parentCommit;
  }
  throw new GitError(
    "Could not determine the stack base for this commit.",
    "rebase"
  );
}

/**
 * Split the moving set into linear chains, one per leaf, ordered so a chain runs
 * only after the chain holding its fork point.
 */
export function planRebase(
  snapshot: RawData,
  rootSha: string,
  destinationSha: string
): RebasePlan {
  const moving = collectDescendants(snapshot.commits, rootSha);
  if (!moving.length) {
    throw new GitError(
      "Commit is not a local commit — nothing to rebase.",
      "rebase"
    );
  }

  const movingShas = new Set(moving.map(commit => commit.sha));
  const root = moving.find(commit => commit.sha === rootSha)!;
  const rootParent: string | undefined = root.parents[0];

  if (movingShas.has(destinationSha)) {
    throw new GitError(
      "Cannot rebase a commit onto one of its own descendants.",
      "rebase"
    );
  }
  if (destinationSha === rootParent) {
    throw new GitError(
      "These commits already sit on that destination.",
      "rebase"
    );
  }

  const childrenOf = buildChildIndex(moving, movingShas);
  const bySha = new Map(moving.map(commit => [commit.sha, commit]));

  // Newest-first input reversed is oldest-first, so a fork point is always seen
  // before the chains branching off it.
  const oldestFirst = [...moving].reverse();
  const chainStarts: Array<{
    startSha: string;
    upstream: string;
    forkSha?: string;
  }> = [{ startSha: rootSha, upstream: rootParent ?? destinationSha }];
  for (const commit of oldestFirst) {
    // The first child continues this chain; the rest each begin their own.
    for (const child of (childrenOf.get(commit.sha) ?? []).slice(1)) {
      chainStarts.push({
        startSha: child,
        upstream: commit.sha,
        forkSha: commit.sha,
      });
    }
  }

  const markers: Record<string, string> = {};
  const markerOf = new Map<string, string>();
  const addMarker = (sha: string): string => {
    const existing = markerOf.get(sha);
    if (existing) {
      return existing;
    }
    const ref = `${MARKER_PREFIX}/${markerOf.size}`;
    markerOf.set(sha, ref);
    markers[ref] = sha;
    return ref;
  };
  for (const start of chainStarts) {
    if (start.forkSha) {
      addMarker(start.forkSha);
    }
  }
  // A detached HEAD sitting on a commit that is about to be rewritten needs a
  // marker of its own, or the restore below would check out the old commit.
  const headMarker =
    !snapshot.headBranch && movingShas.has(snapshot.headSha)
      ? addMarker(snapshot.headSha)
      : undefined;

  const claimed = new Set<string>();
  const steps: RebaseStep[] = chainStarts.map(start => {
    let leafSha = start.startSha;
    while (!claimed.has(leafSha)) {
      claimed.add(leafSha);
      // The first child continues the chain; anything already claimed belongs to a
      // chain walked earlier, which ends this one.
      const next = childrenOf.get(leafSha)?.[0];
      if (next === undefined || claimed.has(next)) {
        break;
      }
      leafSha = next;
    }
    const leafCommit = bySha.get(leafSha)!;
    return {
      // A branch name makes the rebase update it directly and keeps the logged
      // command readable.
      leaf: leafCommit.branches[0] ?? leafSha,
      upstream: start.upstream,
      ontoMarker: start.forkSha ? markerOf.get(start.forkSha) : undefined,
    };
  });

  return {
    steps,
    destinationSha,
    markers,
    branches: moving.flatMap(commit => commit.branches),
    originalRef: snapshot.headBranch ?? snapshot.headSha,
    headMarker,
  };
}

/**
 * A rebase checks out commits as it replays them, so any uncommitted change
 * would be caught in the middle. Refuse before touching anything.
 */
export function requireCleanWorkingCopy(
  snapshot: RawData,
  command: string
): void {
  if (!snapshot.uncommitted.length) {
    return;
  }
  throw new GitError(
    "Working copy has uncommitted changes — commit, amend, or stash them before rebasing.",
    command
  );
}

/**
 * Never let a rebase open an editor: it would block on a process the user
 * cannot see. The todo list is already fully decided here.
 */
const NON_INTERACTIVE: NodeJS.ProcessEnv = {
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
};

/** Start a planned rebase, stopping on the first conflict. */
export async function runRebase(
  git: GitRunner,
  snapshot: RawData,
  plan: RebasePlan
): Promise<RebaseOutcome> {
  requireCleanWorkingCopy(snapshot, "rebase");
  await requireSupportedGit(git);
  // `--update-refs` refuses to move the branch HEAD is on, silently leaving it
  // on the abandoned commits while every other ref advances. Detaching first
  // makes every branch in the stack equally movable; `plan.originalRef` is what
  // restores the checkout at the end.
  await git.run(["switch", "--detach", "HEAD"]);
  const markerLines = Object.entries(plan.markers).map(
    ([ref, sha]) => `create ${ref}\0${sha}\0`
  );
  if (markerLines.length) {
    await git.run(["update-ref", "--stdin", "-z"], {
      input: markerLines.join(""),
    });
  }
  return executeSteps(git, plan, plan.steps);
}

/**
 * Replay steps in order. On a conflict the remaining steps are journalled and
 * control returns to the user; on success the journal and markers are cleared.
 */
async function executeSteps(
  git: GitRunner,
  plan: RebasePlan,
  steps: RebaseStep[]
): Promise<RebaseOutcome> {
  for (const [index, step] of steps.entries()) {
    const onto = step.ontoMarker ?? plan.destinationSha;
    try {
      await git.run(
        ["rebase", "--onto", onto, step.upstream, step.leaf, "--update-refs"],
        {
          env: NON_INTERACTIVE,
        }
      );
    } catch (error) {
      if (!(await isRebaseInProgress(git))) {
        await cleanUp(git, plan);
        throw error;
      }
      // Journal what is left so `--continue` finishes the job. HEAD stays where
      // git left it: switching away now would wreck the rebase.
      await writePlan(git, { ...plan, steps: steps.slice(index + 1) });
      return { moved: [], conflict: true };
    }
  }
  // Resolve the marker BEFORE cleanUp deletes it.
  const restoreTarget = plan.headMarker
    ? ((await git.tryRun(["rev-parse", plan.headMarker])) ?? plan.originalRef)
    : plan.originalRef;
  await cleanUp(git, plan);
  await restoreHead(git, restoreTarget);
  return { moved: uniqueSorted(plan.branches), conflict: false };
}

/**
 * Finish a rebase the user has resolved, then run whatever chains remain.
 */
export async function continueRebase(git: GitRunner): Promise<RebaseOutcome> {
  if (!(await isRebaseInProgress(git))) {
    throw new GitError("No rebase in progress.", "rebase --continue");
  }
  // Refuse only on leftover conflict markers, not on unstaged-ness: an external
  // mergetool writes the merged file but leaves staging to us, so a file that
  // still shows as unmerged here may already be correct on disk.
  const markered = await filesWithConflictMarkers(git);
  if (markered.length) {
    throw new GitError(
      `Conflict markers still in ${markered.join(", ")}. Resolve those files, then continue.`,
      "rebase --continue"
    );
  }
  // Staging is what marks a conflict resolved.
  await git.run(["add", "-A"]);
  const plan = await readPlan(git);
  try {
    await git.run(["rebase", "--continue"], { env: NON_INTERACTIVE });
  } catch (error) {
    if (await isRebaseInProgress(git)) {
      return { moved: [], conflict: true };
    }
    if (plan) {
      await cleanUp(git, plan);
    }
    throw error;
  }
  if (!plan) {
    return { moved: [], conflict: false };
  }
  return executeSteps(git, plan, plan.steps);
}

/**
 * Unmerged files that still contain conflict markers. Continuing with these
 * would commit the markers as content, which is the one mistake worth blocking;
 * a deliberate resolution that keeps the marker text is vanishingly rare next to
 * a forgotten conflict.
 */
async function filesWithConflictMarkers(git: GitRunner): Promise<string[]> {
  const unmerged = await git.tryRun([
    "diff",
    "--name-only",
    "--diff-filter=U",
    "-z",
  ]);
  if (!unmerged) {
    return [];
  }
  const paths = unmerged.split("\0").filter(Boolean);
  // `-S` counts occurrences, so this asks git rather than reading files here,
  // and it respects the repo's own encoding handling.
  const markered = await Promise.all(
    paths.map(async path => {
      const grep = await git.tryRun([
        "grep",
        "-l",
        "-e",
        "^<<<<<<< ",
        "--",
        path,
      ]);
      return grep ? path : null;
    })
  );
  return markered.filter((path): path is string => path !== null);
}

/** Abandon the rebase and every chain still queued behind it. */
export async function abortRebase(git: GitRunner): Promise<void> {
  const plan = await readPlan(git);
  await git.run(["rebase", "--abort"]);
  if (plan) {
    // An abort restores the original commits, so the recorded ref is correct
    // here — no marker lookup needed.
    await cleanUp(git, plan);
    await restoreHead(git, plan.originalRef);
  }
}

/** Hand the conflict to the user's configured merge tool. */
export async function launchMergeTool(
  git: GitRunner,
  file?: string
): Promise<void> {
  await git.run(["mergetool", ...(file ? ["--", file] : [])], {
    env: NON_INTERACTIVE,
  });
}

async function cleanUp(git: GitRunner, plan: RebasePlan): Promise<void> {
  const refs = Object.keys(plan.markers);
  if (refs.length) {
    // A marker the rebase already consumed may be gone; deletion must not fail
    // the action.
    // A -z delete still needs the (empty) old-value field, or git rejects the
    // whole batch with "unexpected end of input".
    const lines = refs.map(ref => `delete ${ref}\0\0`);
    await git.tryRun(["update-ref", "--stdin", "-z"], {
      input: lines.join(""),
    });
  }
  const path = await planPath(git);
  if (path) {
    rmSync(path, { force: true });
  }
}

/**
 * Put HEAD back on `ref`, detaching when no branch of that name is left to hold it.
 *
 * `--` separates the ref from the options for the same reason every pathspec here does.
 * Git rejects a refname beginning with `-`, so this cannot be reached today; the separator
 * costs nothing and removes the need for a reader to go and confirm that.
 */
async function restoreHead(git: GitRunner, ref: string): Promise<void> {
  if (await git.succeeds(["switch", "--", ref])) {
    return;
  }
  await git.tryRun(["switch", "--detach", ref]);
}

export async function isRebaseInProgress(git: GitRunner): Promise<boolean> {
  const path = await git.tryRun([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "rebase-merge",
  ]);
  return Boolean(path && existsSync(path));
}

/**
 * The journal lives in the git directory so it shares the repository's lifetime
 * and stays per-worktree, which matters when two worktrees rebase at once.
 * `--git-path` resolves that directory correctly inside a linked worktree.
 */
async function planPath(git: GitRunner): Promise<string | null> {
  const path = await git.tryRun([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    PLAN_FILE,
  ]);
  return path || null;
}

async function writePlan(git: GitRunner, plan: RebasePlan): Promise<void> {
  const path = await planPath(git);
  if (path) {
    writeFileSync(path, JSON.stringify(plan), "utf8");
  }
}

/**
 * Read the journal a previous conflict left behind. Resolves the path fresh
 * each time so a rebase begun before an extension restart still continues.
 */
async function readPlan(git: GitRunner): Promise<RebasePlan | null> {
  const path = await planPath(git);
  if (!path || !existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RebasePlan;
  } catch {
    return null; // truncated or hand-edited — treat as no journal
  }
}
