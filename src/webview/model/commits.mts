/**
 * Reading the render model: finding commits, counting what a rebase would move.
 *
 * All pure walks over `RenderModel.rows`, kept out of the components so the rules a
 * menu label states — "this commit + 3 above" — can be asserted directly.
 */
import type { RenderModel, UIBranch, UICommit } from "#ui/renderModel";

/**
 * A label clipped to `limit`, ellipsis included in the count.
 *
 * Accepts a missing value because the labels it builds come from optional model fields —
 * `undoLabel` is null until something is undoable. The guard was always in the body; the
 * signature said `string` and only the tests passed null, which `strictNullChecks` on the
 * suite is what surfaced.
 */
export function truncate(
  text: string | null | undefined,
  limit: number
): string {
  const value = text ?? "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function findCommit(model: RenderModel, sha: string): UICommit | null {
  for (const row of model.rows) {
    if (row.type === "commit" && row.commit.sha === sha) {
      return row.commit;
    }
  }
  return null;
}

/** Every commit row, top to bottom — what keyboard navigation moves through. */
export function commitsInOrder(model: RenderModel): UICommit[] {
  return model.rows.flatMap(row => (row.type === "commit" ? [row.commit] : []));
}

/**
 * The commits an amend can write to: HEAD, then each first parent below it, down to where the
 * local commits end. The host refuses anything else — a commit on another branch, or one on
 * trunk — so a picker listing only these has no choice that fails for a reason it could know.
 * Empty when HEAD is not a local commit.
 */
export function amendTargets(model: RenderModel): UICommit[] {
  const commits = new Map<string, UICommit>();
  let current: UICommit | undefined;
  for (const commit of commitsInOrder(model)) {
    commits.set(commit.sha, commit);
    if (commit.isHead) {
      current = commit;
    }
  }
  const targets: UICommit[] = [];
  while (current) {
    targets.push(current);
    const [parent] = current.parents;
    current = parent === undefined ? undefined : commits.get(parent);
  }
  return targets;
}

/** Local commits at or above `sha`, matching what a rebase would move. */
export function countDescendants(model: RenderModel, sha: string): number {
  const childrenOf = new Map<string, string[]>();
  for (const row of model.rows) {
    if (row.type !== "commit") {
      continue;
    }
    for (const parent of row.commit.parents) {
      const children = childrenOf.get(parent);
      if (children) {
        children.push(row.commit.sha);
      } else {
        childrenOf.set(parent, [row.commit.sha]);
      }
    }
  }
  const seen = new Set<string>();
  const queue = [sha];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    queue.push(...(childrenOf.get(current) ?? []));
  }
  return seen.size;
}

/**
 * The branch pill Submit acts on, with its pull request attached, or null when the commit
 * has no branch.
 *
 * A commit can carry several pills; prefer one that already has a pull request, so
 * re-submitting updates that pull request rather than opening a second one from a sibling
 * name.
 */
export function submitTarget(commit: UICommit): UIBranch | null {
  const details = commit.branchDetails ?? [];
  if (!details.length) {
    return null;
  }
  return details.find(detail => detail.pullRequest) ?? details[0] ?? null;
}

export type GotoTarget = {
  /** What to check out: a branch name, or the commit's own sha. */
  ref: string;
  /** True when `ref` is a sha, which leaves HEAD detached. */
  detach: boolean;
  /** The worktree already holding `ref`, which makes the checkout impossible. */
  heldBy: string | null;
};

/**
 * Where Goto on a commit lands, and what stops it.
 *
 * One owner for three callers — the row's button, the panel's button, and the keyboard
 * shortcut — because each has to reach the same commit and refuse for the same reason. The
 * row disabled its button on nothing at all, so Goto on a branch another worktree held
 * relayed git's refusal as a red toast.
 *
 * One branch checks that branch out. Anything else — no branch, or several with nothing to
 * choose between them — checks out the sha and detaches HEAD, which no worktree can block:
 * git binds branches to worktrees, not commits.
 */
export function gotoTarget(commit: UICommit): GotoTarget {
  const [only, ...rest] = commit.branchDetails ?? [];
  if (only === undefined || rest.length) {
    return { ref: commit.sha, detach: true, heldBy: null };
  }
  return { ref: only.name, detach: false, heldBy: only.worktree };
}

/**
 * The commit message split the way the editor shows it: subject on one line, the rest
 * below. `body` from git repeats the subject, so the editor would otherwise open with it
 * printed twice.
 */
export function splitMessage(commit: UICommit): {
  subject: string;
  body: string;
} {
  const body = commit.body.startsWith(commit.subject)
    ? commit.body.slice(commit.subject.length).replace(/^\n+/, "")
    : commit.body;
  return { subject: commit.subject, body };
}
