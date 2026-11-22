/**
 * Explain every pill and badge the tree can draw.
 *
 * Each sample is a real `UIBranch`, rendered by the same component the rows use, rather
 * than hand-written markup. That is the point: a badge whose colour, glyph, or wording
 * changes cannot go on being explained the old way here, because the legend renders
 * whatever the real code now produces. Hand-copied samples would rot silently, and a
 * wrong legend is worse than none.
 */
import type { PullRequestStatus } from "#github/pullRequests";
import type { UIBranch, UIStackStatus } from "#ui/renderModel";

export type LegendRow = {
  /** A branch to render through the real pill component, for most rows. */
  branch?: UIBranch;
  /** The two pills that are not part of a branch detail get a literal instead. */
  pill?: { label: string; variant: "plain" | "trunk" };
  /**
   * Arguments for `trunkBehindBadge`, the one badge that belongs to a row rather than to
   * a branch. Arguments rather than a finished badge, for the same reason the rows above
   * carry a `UIBranch`: the drawer builds it with the function the trunk row uses, so the
   * sample cannot drift from what that row draws.
   */
  trunkBehind?: {
    branch: string;
    behind: number;
    trunkRef: string;
    isCheckedOut: boolean;
  };
  what: string;
  why: string;
};

export type LegendGroup = {
  heading: string;
  rows: LegendRow[];
};

const SYNCED = {
  name: "my-branch",
  upstream: "origin/my-branch",
  ahead: 0,
  behind: 0,
  gone: false,
};

function branch(
  sync: UIBranch["sync"],
  pullRequest: PullRequestStatus | null = null,
  tracksTrunk = false
): UIBranch {
  return {
    name: "my-branch",
    sync,
    pullRequest,
    tracksTrunk,
    worktree: null,
    stackLink: null,
    stackStatus: null,
    mergedKeptReason: null,
    draft: null,
    deletionRefusal: null,
  };
}

function pullRequest(fields: Partial<PullRequestStatus>): PullRequestStatus {
  return {
    number: 42,
    url: "",
    title: "Example pull request",
    state: "OPEN",
    isDraft: false,
    checks: null,
    headSha: "",
    reviewDecision: null,
    stack: null,
    ...fields,
  };
}

/**
 * Rows about a pull request pass no sync at all, so `syncBadge` returns null and the
 * sample carries only the badge under discussion. Leaving "submitted" beside a merged
 * badge just draws the eye to the wrong pill.
 */
function pullRequestOnly(fields: Partial<PullRequestStatus>): UIBranch {
  return branch(null, pullRequest(fields));
}

/**
 * A stack's top branch, carrying the status drawn for the whole stack. The legend draws these
 * with the wording `#github/stackStatus` would produce, since the status reaches the webview
 * finished.
 */
function stackTop(
  state: UIStackStatus["state"],
  label: string,
  sentence: string
): UIBranch {
  return {
    ...branch(null),
    stackStatus: { state, label, sentence, top: true },
  };
}

export function legendGroups(): LegendGroup[] {
  return [
    {
      heading: "Branch and trunk",
      rows: [
        {
          pill: { label: "my-branch", variant: "plain" },
          what: "Branch pill",
          why: "A local branch pointing at this commit. A commit can carry several.",
        },
        {
          pill: { label: "origin/main", variant: "trunk" },
          what: "Trunk pill",
          why: "The trunk tip every stack is measured against. Set it with gsm.trunk.",
        },
        {
          trunkBehind: {
            branch: "main",
            behind: 42,
            trunkRef: "origin/main",
            isCheckedOut: true,
          },
          what: "Local trunk behind",
          why: "Your own main has not been pulled, so it sits below the tip drawn here. It has no commits of its own, so this row is the only place it can be said.",
        },
      ],
    },
    {
      heading: "How the branch compares to its remote",
      rows: [
        {
          branch: branch({ ...SYNCED, upstream: null }),
          what: "Never pushed",
          why: "No remote branch exists for it yet.",
        },
        {
          branch: branch({ ...SYNCED, ahead: 2 }),
          what: "Has unpushed commits",
          why: "Local commits the remote branch does not have.",
        },
        {
          branch: branch({ ...SYNCED, behind: 1 }),
          what: "Behind its remote",
          why: "The remote has commits this branch does not.",
        },
        {
          branch: branch({ ...SYNCED, ahead: 3, behind: 1 }),
          what: "Diverged",
          why: "Both sides moved. Amending after a push causes this; the arrows count local ↑ and remote ↓.",
        },
        {
          branch: branch(
            { ...SYNCED, upstream: "origin/main", ahead: 1, behind: 32 },
            null,
            true
          ),
          what: "Tracking trunk",
          why: "Grey, not red: the upstream is trunk, not a copy of this branch, so the counts follow trunk rather than a push. Branching off origin/main causes it — set branch.autoSetupMerge to simple to stop it.",
        },
        {
          branch: branch({ ...SYNCED, gone: true }),
          what: "Remote branch deleted",
          why: "Usually means the pull request merged and GitHub removed the branch.",
        },
        {
          branch: branch(SYNCED),
          what: "In sync",
          why: "Nothing to push.",
        },
      ],
    },
    {
      heading: "Pull request state",
      rows: [
        {
          branch: pullRequestOnly({}),
          what: "Open",
          why: "Green. Click any pull request badge to open it on GitHub.",
        },
        {
          branch: pullRequestOnly({ isDraft: true }),
          what: "Draft",
          why: "Grey. Open but not ready for review.",
        },
        {
          branch: pullRequestOnly({ state: "MERGED" }),
          what: "Merged",
          why: "Purple. The commit is on trunk now.",
        },
        {
          branch: pullRequestOnly({ state: "CLOSED" }),
          what: "Closed",
          why: "Red. Closed without merging.",
        },
      ],
    },
    {
      heading: "Continuous integration, the first glyph",
      rows: [
        {
          branch: pullRequestOnly({ checks: "success" }),
          what: "Checks passed",
          why: "A tick: every required check succeeded.",
        },
        {
          branch: pullRequestOnly({ checks: "failure" }),
          what: "Checks failed",
          why: "A cross: at least one required check failed.",
        },
        {
          branch: pullRequestOnly({ checks: "pending" }),
          what: "Checks running",
          why: "A filled dot: still in progress.",
        },
      ],
    },
    {
      heading: "Review decision, the second glyph",
      rows: [
        {
          branch: pullRequestOnly({ reviewDecision: "APPROVED" }),
          what: "Approved",
          why: "A tick, in the second glyph position.",
        },
        {
          branch: pullRequestOnly({ reviewDecision: "CHANGES_REQUESTED" }),
          what: "Changes requested",
          why: "A circular arrow — go round again.",
        },
        {
          branch: pullRequestOnly({ reviewDecision: "REVIEW_REQUIRED" }),
          what: "Review required",
          why: "A hollow circle: nobody has reviewed it yet.",
        },
        {
          branch: pullRequestOnly({
            checks: "success",
            reviewDecision: "APPROVED",
          }),
          what: "Both glyphs together",
          why: "Checks first, then review — so two ticks mean tests green and approved.",
        },
      ],
    },
    {
      heading: "How a stack compares to GitHub",
      rows: [
        {
          branch: stackTop("in-sync", "in sync", "In sync with GitHub."),
          what: "Stack in sync",
          why: "On a stack's top branch, and it speaks for every branch in the stack. Their own sync badges give way to it.",
        },
        {
          branch: stackTop(
            "local",
            "to submit",
            "my-branch has changes that GitHub does not have. Submit stack pushes them."
          ),
          what: "Changes to submit",
          why: "A branch moved here and GitHub did not: a new commit, an amend, or a rebase. The tooltip and the commit panel name the branches.",
        },
        {
          branch: stackTop(
            "remote",
            "GitHub is newer",
            "GitHub has a newer version of my-branch. Take GitHub's version."
          ),
          what: "GitHub is newer",
          why: "GitHub moved and this checkout did not, which is what a restack after a merge leaves. Known without a fetch, from the pull request's head.",
        },
        {
          branch: stackTop(
            "unlinked",
            "not linked",
            "These pull requests are not linked as a stack. Link stack links them."
          ),
          what: "Not linked",
          why: "Every branch is in sync, and GitHub does not link the pull requests as a stack in this order.",
        },
      ],
    },
    {
      heading: "Position in a stack on GitHub",
      rows: [
        {
          branch: pullRequestOnly({
            stack: { number: 57, position: 2, size: 3 },
          }),
          what: "Pull request 2 of 3",
          why: "Where this pull request is in a stack that GitHub links. Link stack in a commit's right-click menu creates one.",
        },
      ],
    },
  ];
}
