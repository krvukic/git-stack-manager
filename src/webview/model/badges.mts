/**
 * What a branch pill's badges say.
 *
 * Two independent facts ride next to a branch pill: how it compares to its remote
 * (local-only, ahead, diverged, tracking trunk) and what its pull request is doing. Sync
 * state is free from the ref read; pull request state arrives later, so a row can render
 * with the sync badge and gain the pull request badge on the next paint.
 *
 * These return descriptions rather than markup, so the legend and the tree can render
 * the same badge two different ways without either duplicating the wording.
 */
import type { BranchSync } from "#git/snapshot";
import type { PullRequestStatus } from "#github/pullRequests";
import type { UIStackStatus } from "#ui/renderModel";

export type SyncBadge = {
  /** Suffix of the stylesheet class that paints it: `.badge.ahead` and so on. */
  variant:
    "unpushed" | "ahead" | "diverged" | "trackstrunk" | "gone" | "synced";
  label: string;
  description: string;
};

/**
 * Describe how a branch compares to its remote, or null when there is nothing worth
 * saying — so the common case adds no visual noise.
 *
 * Every label carrying a count also names the ref it was counted against. The counts are
 * meaningless without it: `1↑32↓` on an unpushed branch looks like lost work until you
 * see that the other side is origin/main. Only the countless badges stay bare, since
 * their descriptions already name the upstream and the pill has no room to spare.
 *
 * `tracksTrunk` comes from the render model rather than being derived here, because it
 * needs the trunk ref and the branch trunk resolves to; see `UIBranch`.
 */
export function syncBadge(
  sync: BranchSync | null,
  pullRequest: PullRequestStatus | null,
  tracksTrunk = false
): SyncBadge | null {
  if (!sync) {
    return null;
  }
  if (!sync.upstream) {
    // A missing upstream only means no local tracking ref. Sapling and `gh stack` push
    // under a server-side branch of their own, so a pull request is the stronger
    // evidence — "not submitted" beside a merged #26403 is simply wrong.
    if (pullRequest) {
      return {
        variant: "unpushed",
        label: "no local upstream",
        description:
          `This branch tracks nothing locally, but pull request #${pullRequest.number} ` +
          "carries its commit. Sapling and gh stack push under their own branch name.",
      };
    }
    return {
      variant: "unpushed",
      label: "not submitted",
      description: "This branch has never been pushed.",
    };
  }
  if (sync.gone) {
    return {
      variant: "gone",
      label: "upstream gone",
      description:
        `The remote branch ${sync.upstream} no longer exists — it was probably ` +
        "merged and deleted.",
    };
  }
  /*
   * Tracking trunk outranks every count below, and is not an error state despite moving
   * both ways: nothing was rewritten, and usually nothing was even pushed. Reported
   * before `diverged` because that is the shape it takes — one local commit against a
   * trunk that has gained thirty — and "diverged", in red, reads as work about to be
   * lost. Ranked after `gone`, since a vanished origin/main is the larger news.
   */
  if (tracksTrunk && (sync.ahead || sync.behind)) {
    return {
      variant: "trackstrunk",
      label: `${sync.ahead}↑${sync.behind}↓ vs ${sync.upstream}`,
      description:
        `This branch tracks ${sync.upstream} rather than a pushed copy of itself, so ` +
        `the counts compare it to trunk: ${sync.ahead} local commit(s), and ` +
        `${sync.behind} that trunk gained since the branch was cut. Rebase to clear ` +
        "the trunk side, or unset the upstream to stop measuring against it.",
    };
  }
  if (sync.ahead && sync.behind) {
    return {
      variant: "diverged",
      label: `diverged ${sync.ahead}↑${sync.behind}↓ vs ${sync.upstream}`,
      description:
        `${sync.ahead} local commit(s) not on ${sync.upstream}, and ${sync.behind} ` +
        "remote commit(s) not local. Amending after a push causes this.",
    };
  }
  if (sync.ahead) {
    return {
      variant: "ahead",
      label: `${sync.ahead} unsubmitted to ${sync.upstream}`,
      description: `${sync.ahead} commit(s) not yet pushed to ${sync.upstream}.`,
    };
  }
  if (sync.behind) {
    return {
      variant: "diverged",
      label: `${sync.behind} behind ${sync.upstream}`,
      description: `${sync.upstream} has ${sync.behind} commit(s) this branch does not.`,
    };
  }
  return {
    variant: "synced",
    label: "submitted",
    description: `In sync with ${sync.upstream}.`,
  };
}

export type TrunkBehindBadge = {
  variant: "trunkbehind";
  label: string;
  description: string;
};

/**
 * How far the local trunk branch trails the ref the trunk row draws.
 *
 * It sits on the trunk row, whose Goto is the fix. The branch's own row further down shows
 * where the branch is, and a gap of forty commits between the two reads as spacing, not as
 * something to pull.
 *
 * Amber rather than red: falling behind trunk is the ordinary state of a repository that
 * fetches on a timer, not work about to be lost. The description names the fix, and which
 * fix depends on where HEAD is: Pull only moves the branch you are on, and from anywhere
 * else this row's own Goto fast-forwards the branch as it checks it out.
 */
export function trunkBehindBadge(
  branch: string | null,
  behind: number,
  trunkRef: string,
  isCheckedOut: boolean
): TrunkBehindBadge | null {
  if (!branch || behind <= 0) {
    return null;
  }
  const commits = `${behind} commit${behind === 1 ? "" : "s"}`;
  return {
    variant: "trunkbehind",
    label: `${branch} is ${behind} behind`,
    description:
      `Your local ${branch} is ${commits} behind ${trunkRef}. ` +
      (isCheckedOut
        ? "Pull fast-forwards it."
        : "Goto this row fast-forwards it and checks it out."),
  };
}

export const CI_GLYPH: Record<string, string> = {
  success: "✓",
  failure: "✗",
  pending: "●",
};

export const REVIEW_GLYPH: Record<string, string> = {
  APPROVED: "✓",
  CHANGES_REQUESTED: "↻",
  REVIEW_REQUIRED: "○",
};

export type PullRequestBadge = {
  /** Class that paints it. GitHub calls a draft OPEN, so `draft` is derived here. */
  variant: "open" | "draft" | "merged" | "closed";
  number: number;
  /** Continuous integration rollup, and the glyph for it. Null when there is none. */
  checks: { state: string; glyph: string } | null;
  /** Review decision glyph, or null when nobody has decided. */
  reviewGlyph: string | null;
  description: string;
  url: string;
};

/**
 * The clickable pull request badge for a branch, or null when it has none.
 *
 * `mergedKeptReason` adds a line to a merged badge's description. A merged badge beside a
 * branch that stays otherwise reads as a setting that did not work, and the tooltip is where a
 * reader looks for why.
 */
export function pullRequestBadge(
  pullRequest: PullRequestStatus | null,
  mergedKeptReason: string | null = null
): PullRequestBadge | null {
  if (!pullRequest) {
    return null;
  }
  const variant =
    pullRequest.state === "OPEN" && pullRequest.isDraft
      ? "draft"
      : (pullRequest.state.toLowerCase() as PullRequestBadge["variant"]);
  const parts = [
    pullRequest.state.toLowerCase() + (pullRequest.isDraft ? " (draft)" : ""),
  ];
  if (pullRequest.reviewDecision) {
    parts.push(
      `review: ${pullRequest.reviewDecision.toLowerCase().replace(/_/g, " ")}`
    );
  }
  if (pullRequest.checks) {
    parts.push(`checks: ${pullRequest.checks}`);
  }
  const checksGlyph = pullRequest.checks
    ? CI_GLYPH[pullRequest.checks]
    : undefined;
  return {
    variant,
    number: pullRequest.number,
    checks:
      pullRequest.checks && checksGlyph
        ? { state: pullRequest.checks, glyph: checksGlyph }
        : null,
    reviewGlyph: pullRequest.reviewDecision
      ? (REVIEW_GLYPH[pullRequest.reviewDecision] ?? null)
      : null,
    description: [
      pullRequest.title,
      parts.join(" · "),
      ...(mergedKeptReason
        ? [`The branch stays because ${mergedKeptReason}.`]
        : []),
      "Click to open on GitHub.",
    ].join("\n"),
    url: pullRequest.url,
  };
}

/**
 * The badge on a stack's top row: how the whole stack compares with GitHub.
 *
 * Painted with the sync badges' own colours, since it stands where one of them would: green
 * for in sync, amber for something to push, blue for a pending link, red where GitHub has
 * commits that this checkout does not. A closed pull request is red too, as its own badge is.
 */
export function stackStatusBadge(
  status: UIStackStatus | null
): SyncBadge | null {
  if (!status?.top) {
    return null;
  }
  const variants: Record<UIStackStatus["state"], SyncBadge["variant"]> = {
    "in-sync": "synced",
    unpushed: "unpushed",
    local: "unpushed",
    unlinked: "ahead",
    remote: "diverged",
    both: "diverged",
    closed: "diverged",
  };
  return {
    variant: variants[status.state],
    label: status.label,
    description: status.sentence,
  };
}

export type StackBadge = {
  variant: "stackpos";
  label: string;
  description: string;
};

/**
 * Where an open pull request is in its stack on GitHub, such as `2/3`, or null when it is in
 * none.
 *
 * Only an open pull request counts. A merged one keeps its entry on GitHub, and the branch
 * that carried it is no longer part of what the reader is stacking.
 */
export function stackBadge(
  pullRequest: PullRequestStatus | null
): StackBadge | null {
  const stack = pullRequest?.state === "OPEN" ? pullRequest.stack : null;
  if (!stack) {
    return null;
  }
  return {
    variant: "stackpos",
    label: `${stack.position}/${stack.size}`,
    description: `Pull request ${stack.position} of ${stack.size} in stack #${stack.number} on GitHub.`,
  };
}
