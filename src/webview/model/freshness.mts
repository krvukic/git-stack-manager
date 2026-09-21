/**
 * The header's pull request freshness note.
 *
 * A failure keeps its age rather than replacing it, because the badges below are still on
 * screen: "the refresh failed, and what you are reading is twenty minutes old" is the
 * sentence a reader needs to judge them.
 *
 * `now` is a parameter rather than a call to `Date.now`, which is what makes this
 * testable: the age is the whole point of the element, so freezing the clock inside would
 * assert a constant that can never be wrong.
 */
import type { PullRequestRefreshState } from "#github/pullRequests";

/** Round a millisecond age down to whole units, coarsening as it grows. */
export function describeAge(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export type Freshness = {
  text: string;
  /** True when the last attempt failed, which paints the note as an error. */
  failed: boolean;
  description: string;
};

export function describeFreshness(
  state: PullRequestRefreshState | null | undefined,
  now: number
): Freshness {
  if (!state || state.lastAttemptSucceeded === null) {
    return {
      text: state?.fetching ? "PRs: loading…" : "",
      failed: false,
      description: "",
    };
  }
  const age =
    state.lastSuccessAt === null
      ? null
      : describeAge(now - state.lastSuccessAt);
  if (state.lastAttemptSucceeded) {
    return {
      text: `PRs ${age || "up to date"}`,
      failed: false,
      description: "The last Refresh PRs succeeded.",
    };
  }
  return {
    text: `PRs stale${age ? ` — last ok ${age}` : " — never loaded"}`,
    failed: true,
    description:
      (state.lastError || "The last pull request refresh failed.") +
      (age ? " Badges shown are from the last successful refresh." : ""),
  };
}
