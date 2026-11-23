/**
 * stackStatus — one sentence on whether a stack matches GitHub, and what to do when it does not.
 *
 * A per-branch sync badge counts commits, and a count cannot tell a rebase from a teammate's
 * push: both leave a branch ahead and behind. Three commits can. For each branch this compares
 * its local tip, the commit its remote-tracking ref was left on by the last fetch or push, and
 * the head of its open pull request, which is the newest thing known about GitHub:
 *
 *   - The tip is what GitHub has: in sync.
 *   - GitHub has not moved since the last fetch, and the tip has: only the local branch moved,
 *     which is what a rebase or an amend leaves.
 *   - GitHub moved and the tip did not: GitHub is newer.
 *   - Both moved: both changed.
 *
 * None of this fetches. The remote-tracking commit comes from the repository read, and the
 * pull request head from the query that already draws the badges.
 */
import { BranchSync } from "#git/snapshot";
import { PullRequestStatus } from "#github/pullRequests";

/** One branch of a stack, bottom first, with the three commits the comparison needs. */
export type StackStatusLayer = {
  branch: string;
  /** The local tip. */
  sha: string;
  sync: BranchSync | null;
  /** The commit the branch's own remote-tracking ref is on, or null when it has none. */
  upstreamSha: string | null;
  pullRequest: PullRequestStatus | null;
};

export type StackState =
  "in-sync" | "unpushed" | "local" | "remote" | "both" | "unlinked" | "closed";

export type StackStatus = {
  state: StackState;
  /** A few words for the badge on the stack's top row. */
  label: string;
  /** The whole sentence, with the action that resolves it. */
  sentence: string;
};

type LayerState = Exclude<StackState, "unlinked" | "closed">;

function layerState(layer: StackStatusLayer): LayerState {
  const head =
    layer.pullRequest?.state === "OPEN" && layer.pullRequest.headSha
      ? layer.pullRequest.headSha
      : null;
  const pushed = layer.upstreamSha;
  if (!head && !pushed) {
    return "unpushed";
  }
  if ((head ?? pushed) === layer.sha) {
    return "in-sync";
  }
  const ahead = layer.sync?.ahead ?? 0;
  const behind = layer.sync?.behind ?? 0;
  if (!head) {
    // No pull request to say what GitHub has now, so the last fetch is all there is.
    if (ahead && behind) {
      return "both";
    }
    return behind ? "remote" : "local";
  }
  if (!pushed) {
    // Pushed under another name, which leaves nothing to compare the pull request head with.
    return "local";
  }
  if (head !== pushed) {
    // GitHub moved since the last fetch.
    return layer.sha === pushed ? "remote" : "both";
  }
  // GitHub is where the last fetch left it. A tip that is only behind was never moved here:
  // the fetch brought in commits that the branch has not taken yet.
  return behind && !ahead ? "remote" : "local";
}

/** "a", "a and b", or "a, b and 2 more": two names at most, so the sentence stays one line. */
function nameList(branches: string[]): string {
  const [first = "", second, ...rest] = branches;
  if (second === undefined) {
    return first;
  }
  return rest.length
    ? `${first}, ${second} and ${rest.length} more`
    : `${first} and ${second}`;
}

/**
 * The status of the stack `layers` make up.
 *
 * `linked` says whether GitHub links the stack's pull requests in this order, which only
 * matters once every branch is in sync: a stack with changes to push gets linked by the
 * Submit stack that pushes them.
 *
 * When several states apply, the first of these is reported: a closed pull request, nothing
 * pushed, local changes, GitHub newer, both changed. A closed pull request comes first because
 * Submit stack stops at it, which makes every later sentence's advice wrong for the branches
 * above it. Local changes come next because Submit stack resolves the most.
 */
export function stackStatus(
  layers: StackStatusLayer[],
  linked: boolean
): StackStatus {
  const closed = layers.find(layer => layer.pullRequest?.state === "CLOSED");
  if (closed?.pullRequest) {
    return {
      state: "closed",
      label: "pull request closed",
      sentence: `${closed.branch}'s pull request #${closed.pullRequest.number} is closed, so Submit stack stops there. Reopen it on GitHub, or right-click ${closed.branch}'s commit and choose Submit as new pull request.`,
    };
  }
  const states = layers.map(layer => ({
    branch: layer.branch,
    state: layerState(layer),
  }));
  const named = (state: LayerState) =>
    states.filter(layer => layer.state === state).map(layer => layer.branch);

  if (states.every(layer => layer.state === "unpushed")) {
    return {
      state: "unpushed",
      label: "not on GitHub",
      sentence: "Not on GitHub yet. Submit stack pushes it.",
    };
  }
  const local = [...named("unpushed"), ...named("local")];
  if (local.length) {
    return {
      state: "local",
      label: "to submit",
      sentence: `${nameList(local)} ${local.length === 1 ? "has" : "have"} changes that GitHub does not have. Submit stack pushes them.`,
    };
  }
  const remote = named("remote");
  if (remote.length) {
    return {
      state: "remote",
      label: "GitHub is newer",
      sentence: `GitHub has ${remote.length === 1 ? "a newer version" : "newer versions"} of ${nameList(remote)}. Take GitHub's version.`,
    };
  }
  const both = named("both");
  if (both.length) {
    return {
      state: "both",
      label: "both changed",
      sentence: `You and GitHub both changed ${nameList(both)}. Submit stack overwrites GitHub's version.`,
    };
  }
  if (!linked) {
    return {
      state: "unlinked",
      label: "not linked",
      sentence:
        "These pull requests are not linked as a stack. Link stack links them.",
    };
  }
  return {
    state: "in-sync",
    label: "in sync",
    sentence: "In sync with GitHub.",
  };
}
