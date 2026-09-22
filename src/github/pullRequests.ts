/**
 * pullRequests — per-branch pull request status, read through the `gh` CLI.
 *
 * This is the one data source that cannot ride along with the git reads: a
 * `gh pr list` round trip takes roughly a second, while the whole smartlog read
 * costs a handful of local processes. Blocking the render on it would make every
 * refresh feel broken, and the file watcher fires often enough that a
 * per-refresh network call would also invite rate limiting.
 *
 * So the status is fetched out of band and cached. The model always renders
 * immediately from whatever the cache holds — possibly nothing on first paint —
 * and the UI asks for a refreshed copy separately. One `gh pr list` still covers
 * every branch, so the round trip count does not grow with the stack.
 *
 * That call names the branches the smartlog draws. An unscoped `pr list --limit 200`
 * asks GitHub for the repository's newest 200 pull requests with every check
 * attached, which on a monorepo exceeds the GraphQL time budget and answers HTTP
 * 504 — the badges then never arrive, however long the caller waits. Scoping also
 * fixes a quieter failure: a repository merging 200 pull requests within the window
 * pushes older ones out of it, and a branch whose pull request had dropped off
 * looked identical to one never submitted.
 *
 * Each branch contributes two search terms, its name and its tip commit, because a
 * name alone cannot find every pull request. Sapling and `gh stack` push under a
 * server-side branch of their own choosing — a local `dev/playwright_readme` lands as
 * `pr26403` — so `head:` matches nothing and the commit reads unsubmitted long after
 * its pull request merged. The tip sha finds that pull request whatever the remote
 * branch was called, so the response is keyed back to the local branch by sha as well
 * as by name.
 *
 * `--search` reads GitHub's search index, which trails a pull request opened seconds ago.
 * Submitting therefore hands its own answer to `remember`, whose records fill in for
 * branches a fetch found nothing for; see `cached`.
 *
 * A missing `gh`, a repository with no GitHub remote, or a failed auth check are
 * all normal: this extension works fine on a plain git repo. Those cases
 * degrade to "no PR information" and are reported once, not per refresh.
 */
import { asArray, asRecord, errorMessage } from "#core/values";
import { classifyGhFailure, ghFailureDetail, spawnGh } from "#github/ghRunner";

export type PullRequestStatus = {
  number: number;
  /** OPEN | CLOSED | MERGED */
  state: string;
  isDraft: boolean;
  title: string;
  url: string;
  /**
   * The commit the pull request's head pointed at when GitHub last answered. For a merged
   * pull request that is the commit that merged, which is how a local branch is proven not
   * to have moved since. Empty when unknown.
   */
  headSha: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED, or null when none applies. */
  reviewDecision: string | null;
  /** Rolled-up CI result: success | failure | pending, or null when no checks ran. */
  checks: "success" | "failure" | "pending" | null;
};

/** What the UI needs to explain an empty PR panel. */
export type PullRequestAvailability = {
  usable: boolean;
  /** Why PR status is unavailable, for a one-time notice. Null when usable. */
  reason: string | null;
};

/**
 * How the last pull request fetch went, for the header indicator.
 *
 * Outcome and age are tracked separately because a failed refresh keeps the previous
 * snapshot on screen: the badges are then stale but still correct. Reporting only the
 * failure would leave how stale unknown, and reporting only the age would imply it is
 * still advancing.
 */
export type PullRequestRefreshState = {
  /** Whether the most recent attempt succeeded. Null before the first attempt. */
  lastAttemptSucceeded: boolean | null;
  /** Epoch milliseconds of the last successful fetch, or null if none has landed. */
  lastSuccessAt: number | null;
  /** Why the last attempt failed, or null when it succeeded or none has run. */
  lastError: string | null;
  /** True while a fetch is in flight. */
  fetching: boolean;
};

type CacheEntry = {
  byBranch: Map<string, PullRequestStatus>;
  fetchedAt: number;
};

/** A pull request read outside the search index, and when that read happened. */
type RememberedEntry = {
  status: PullRequestStatus;
  at: number;
};

/** A local branch and the commit it points at, the two ways to find its PR. */
export type BranchTip = {
  name: string;
  sha: string;
};

/** How long a fetched snapshot is served before a refresh is worthwhile. */
const CACHE_TIME_TO_LIVE_MILLISECONDS = 60_000;
const FETCH_TIMEOUT_MILLISECONDS = 20_000;
/**
 * Headroom over the branch count, not a page size. Prefix matching means one
 * `head:` term can return several pull requests, and a branch's own history can
 * hold more than one, so the ceiling has to exceed the number of terms asked for.
 */
const SEARCH_RESULT_LIMIT = 200;

/**
 * How long a directly-read pull request outlives the fetch that failed to find it.
 *
 * It covers GitHub's search index catching up, which takes seconds — three against a
 * quiet repository, longer under load — so a few minutes is already generous. Bounded
 * rather than permanent because nothing refreshes such a record: a branch the search
 * never returns at all would otherwise keep reporting `OPEN` long past a merge.
 */
const REMEMBERED_TIME_TO_LIVE_MILLISECONDS = 300_000;

export class PullRequestService {
  private cache: CacheEntry | null = null;
  /** In-flight fetch, so concurrent callers share one `gh` invocation. */
  private inFlight: Promise<Map<string, PullRequestStatus>> | null = null;
  /** The single follow-up a forced caller waits for while a fetch is already running. */
  private queuedForce: Promise<Map<string, PullRequestStatus>> | null = null;
  /**
   * Pull requests read outside the search index, by branch.
   *
   * `pr list --search` is what makes one call cover every branch, and GitHub indexes a new
   * pull request asynchronously. So the refresh that follows a submit asks for a pull
   * request the index does not hold yet, finds nothing, and caches that nothing for a
   * minute — leaving the button offering to open the pull request it just opened. Submit
   * learns the number from `pr create` and `pr list --head`, neither of which reads the
   * index, so what it learned is merged over the fetched map until the search catches up.
   */
  private remembered = new Map<string, RememberedEntry>();
  private availability: PullRequestAvailability | null = null;
  private lastAttemptSucceeded: boolean | null = null;
  private lastError: string | null = null;

  constructor(private readonly cwd: string) {}

  /** How the last fetch went, for the header's freshness indicator. */
  refreshState(): PullRequestRefreshState {
    return {
      lastAttemptSucceeded: this.lastAttemptSucceeded,
      lastSuccessAt: this.cache?.fetchedAt ?? null,
      lastError: this.lastError,
      fetching: this.inFlight !== null,
    };
  }

  /**
   * Cached statuses, or an empty map when nothing has been fetched yet. A directly-read
   * pull request fills a branch the last fetch had nothing for; where the fetch does
   * carry the branch, it wins, since it also carries checks and review decision.
   */
  cached(): Map<string, PullRequestStatus> {
    const byBranch = new Map(this.cache?.byBranch);
    for (const [branch, entry] of this.liveRemembered()) {
      if (!byBranch.has(branch)) {
        byBranch.set(branch, entry.status);
      }
    }
    return byBranch;
  }

  /**
   * Record a pull request read outside the search index, so its badge appears now rather
   * than whenever GitHub finishes indexing it. Dropped as soon as a fetch reports the
   * same branch.
   */
  remember(branch: string, status: PullRequestStatus): void {
    this.remembered.set(branch, { status, at: Date.now() });
  }

  /** The records still young enough to trust, expiring the rest on the way past. */
  private liveRemembered(): Map<string, RememberedEntry> {
    const cutoff = Date.now() - REMEMBERED_TIME_TO_LIVE_MILLISECONDS;
    for (const [branch, entry] of this.remembered) {
      if (entry.at < cutoff) {
        this.remembered.delete(branch);
      }
    }
    return this.remembered;
  }

  isFresh(): boolean {
    return Boolean(
      this.cache &&
      Date.now() - this.cache.fetchedAt < CACHE_TIME_TO_LIVE_MILLISECONDS
    );
  }

  /** Why PR status is missing, if it is. Null until a fetch has been tried. */
  availabilityReason(): string | null {
    return this.availability?.usable === false
      ? this.availability.reason
      : null;
  }

  /**
   * Fetch unless the cache is still fresh. Concurrent calls join the in-flight
   * request rather than starting a second `gh` process.
   *
   * `branches` scopes the query. Passing none skips the fetch outright rather than
   * asking GitHub for every pull request in the repository.
   */
  async refresh(
    branches: BranchTip[],
    force = false
  ): Promise<Map<string, PullRequestStatus>> {
    if (!force && this.isFresh()) {
      return this.cached();
    }
    if (this.inFlight && !force) {
      return this.inFlight;
    }
    if (this.inFlight) {
      // A forced refresh must not adopt an answer that predates what the caller just did
      // on GitHub — replacing that answer is the whole point of `force`. So it waits for
      // the fetch in flight and then runs its own, and every forced caller arriving
      // meanwhile shares that one follow-up instead of spawning a `gh` process each.
      this.queuedForce ??= this.inFlight
        .catch(() => undefined)
        .then(() => {
          this.queuedForce = null;
          return this.refresh(branches, true);
        });
      return this.queuedForce;
    }
    const byName = new Map(
      branches
        .filter(branch => branch.name)
        .map(branch => [branch.name, branch])
    );
    const wanted = [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    if (!wanted.length) {
      this.cache = { byBranch: new Map(), fetchedAt: Date.now() };
      this.availability = { usable: true, reason: null };
      this.lastAttemptSucceeded = true;
      this.lastError = null;
      return this.cached();
    }

    this.inFlight = this.fetch(wanted)
      .then(byBranch => {
        this.cache = { byBranch, fetchedAt: Date.now() };
        // The search index has caught up on these branches, so a direct record adds
        // nothing — and the fetched copy carries the checks and review decision that a
        // record taken at submit time cannot.
        for (const branch of byBranch.keys()) {
          this.remembered.delete(branch);
        }
        this.lastAttemptSucceeded = true;
        this.lastError = null;
        return this.cached();
      })
      .catch((error: unknown) => {
        this.lastAttemptSucceeded = false;
        this.lastError = this.availabilityReason() ?? errorMessage(error);
        // Keep serving the previous snapshot: a transient network failure should
        // not blank out badges that were correct a moment ago.
        return this.cached();
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetch(
    branches: BranchTip[]
  ): Promise<Map<string, PullRequestStatus>> {
    const fields = [
      "number",
      "state",
      "isDraft",
      "title",
      "url",
      "headRefName",
      "headRefOid",
      "reviewDecision",
      "statusCheckRollup",
    ];
    const localNames = new Set(branches.map(branch => branch.name));
    // Several branches can sit on one commit, and each deserves the badge.
    const namesAtSha = new Map<string, string[]>();
    for (const branch of branches) {
      if (!branch.sha) {
        continue;
      }
      const names = namesAtSha.get(branch.sha);
      if (names) {
        names.push(branch.name);
      } else {
        namesAtSha.set(branch.sha, [branch.name]);
      }
    }

    // `--state all` so a merged or closed PR still annotates its branch; a stale
    // local branch whose PR merged is exactly what the user wants to notice.
    const output = await this.runGh([
      "pr",
      "list",
      "--state",
      "all",
      "--search",
      searchQuery(branches),
      "--limit",
      String(SEARCH_RESULT_LIMIT),
      "--json",
      fields.join(","),
    ]);

    const byBranch = new Map<string, PullRequestStatus>();
    for (const value of asArray(JSON.parse(output))) {
      const entry = asRecord(value);
      if (!entry) {
        continue;
      }
      const headRef =
        typeof entry.headRefName === "string" ? entry.headRefName : "";
      const headSha =
        typeof entry.headRefOid === "string" ? entry.headRefOid : "";
      // Two ways to claim a pull request, and the sha is what covers the Sapling and
      // `gh stack` case where the remote branch is named nothing like the local one.
      // `head:` also matches by prefix, so `head:main` returns `main-refactor` too —
      // hence an exact name check rather than trusting the response.
      const owners = localNames.has(headRef)
        ? [headRef]
        : (namesAtSha.get(headSha) ?? []);
      if (!owners.length) {
        continue;
      }
      const status: PullRequestStatus = {
        number: typeof entry.number === "number" ? entry.number : 0,
        state: typeof entry.state === "string" ? entry.state : "",
        isDraft: entry.isDraft === true,
        title: typeof entry.title === "string" ? entry.title : "",
        url: typeof entry.url === "string" ? entry.url : "",
        headSha,
        reviewDecision:
          typeof entry.reviewDecision === "string"
            ? entry.reviewDecision
            : null,
        checks: rollUpChecks(entry.statusCheckRollup),
      };
      for (const owner of owners) {
        // A branch can carry several PRs over time (reopened, or closed then
        // replaced). Prefer an open one, else the highest number — the newest.
        const existing = byBranch.get(owner);
        if (!existing || preferPullRequest(status, existing)) {
          byBranch.set(owner, status);
        }
      }
    }
    this.availability = { usable: true, reason: null };
    return byBranch;
  }

  /**
   * Read through `gh`, recording why the badges are missing when it fails.
   *
   * The failure is described here and rethrown: the caller keeps the previous snapshot on
   * screen, so the panel needs a sentence explaining the gap even though nothing is thrown
   * at the user.
   */
  private async runGh(args: string[]): Promise<string> {
    try {
      return await spawnGh(args, {
        cwd: this.cwd,
        timeoutMilliseconds: FETCH_TIMEOUT_MILLISECONDS,
      });
    } catch (error: unknown) {
      this.availability = { usable: false, reason: describeFailure(error) };
      throw error;
    }
  }
}

/**
 * One search covering every branch, by name and by tip commit.
 *
 * The terms are joined with explicit `OR` because GitHub treats bare
 * space-separated terms as `AND` once a free-text sha is among them, which would
 * ask for a single pull request matching every branch at once and return nothing.
 */
function searchQuery(branches: BranchTip[]): string {
  const terms: string[] = [];
  for (const branch of branches) {
    terms.push(`head:${branch.name}`);
    if (branch.sha) {
      terms.push(branch.sha);
    }
  }
  return terms.join(" OR ");
}

/** Turn a `gh` failure into a sentence that says what to do about it. */
function describeFailure(error: unknown): string {
  switch (classifyGhFailure(error)) {
    case "missing":
      return "The gh CLI is not installed, so pull request status is unavailable.";
    case "no-github-remote":
      return "No GitHub remote — pull request status does not apply to this repository.";
    case "unauthenticated":
      return "The gh CLI is not authenticated. Run `gh auth login` to see pull request status.";
    case "unreachable":
      return "GitHub did not answer the pull request query in time. Try again in a moment.";
    default: {
      const detail = ghFailureDetail(error).split("\n")[0];
      return detail
        ? `Could not read pull request status: ${detail}`
        : "Could not read pull request status.";
    }
  }
}

/**
 * One enum field of a rollup entry, upper-cased for comparison.
 *
 * Non-strings collapse to the empty string rather than through `String()`, which is
 * what an absent field already yields — and every comparison below is against a
 * GitHub enum name, so a value that is not a string names no outcome. `String()` here
 * turned an object into `"[object Object]"`, a truthy value matching no case, which
 * made a check with an unreadable conclusion read as decided instead of running.
 */
function upperCaseField(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase() : "";
}

/**
 * Collapse GitHub's per-check rollup into one verdict. Anything still running
 * outweighs successes, and a single failure outweighs everything: the badge
 * should not read green while a required check is red.
 *
 * Exported for the tests. Every branch below shadows the ones under it, so the
 * precedence is the behaviour, and reaching it through a `gh` shim tests the
 * transport instead.
 */
export function rollUpChecks(rollup: unknown): PullRequestStatus["checks"] {
  const checks = asArray(rollup);
  if (!checks.length) {
    return null;
  }
  let sawPending = false;
  let sawSuccess = false;
  for (const value of checks) {
    const check = asRecord(value);
    // Check runs report `conclusion` + `status`; legacy commit statuses use `state`.
    const conclusion = upperCaseField(check?.conclusion);
    const state = upperCaseField(check?.status ?? check?.state);
    if (
      conclusion === "FAILURE" ||
      conclusion === "TIMED_OUT" ||
      state === "FAILURE" ||
      state === "ERROR"
    ) {
      return "failure";
    }
    if (conclusion === "SUCCESS" || state === "SUCCESS") {
      sawSuccess = true;
      continue;
    }
    // Skipped and cancelled checks are neither a pass nor a failure; ignore them
    // so a mostly-skipped workflow does not read as perpetually pending.
    if (
      conclusion === "SKIPPED" ||
      conclusion === "NEUTRAL" ||
      conclusion === "CANCELLED"
    ) {
      continue;
    }
    if (
      !conclusion ||
      state === "IN_PROGRESS" ||
      state === "QUEUED" ||
      state === "PENDING"
    ) {
      sawPending = true;
    }
  }
  if (sawPending) {
    return "pending";
  }
  return sawSuccess ? "success" : null;
}

/** Prefer an open PR, then a draft over nothing, then the newest number. */
function preferPullRequest(
  candidate: PullRequestStatus,
  existing: PullRequestStatus
): boolean {
  const openness = (status: PullRequestStatus) =>
    status.state === "OPEN" ? 1 : 0;
  if (openness(candidate) !== openness(existing)) {
    return openness(candidate) > openness(existing);
  }
  return candidate.number > existing.number;
}
