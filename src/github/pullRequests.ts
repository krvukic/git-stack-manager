/**
 * pullRequests — per-branch pull request status, read through the `gh` CLI.
 *
 * This is the one data source that cannot ride along with the git reads: the round trip
 * costs real network time, while the whole smartlog read costs a handful of local
 * processes. Blocking the render on it would make every refresh feel broken, and the file
 * watcher fires often enough that a per-refresh network call would also invite rate
 * limiting.
 *
 * So the status is fetched out of band and cached. The model always renders immediately
 * from whatever the cache holds — possibly nothing on first paint — and the UI asks for a
 * refreshed copy separately.
 *
 * Each branch is found two ways at once, because neither alone covers every branch. By
 * name — `Repository.pullRequests(headRefName: …)` — for the ordinary case, and it is
 * also what survives a local amend or rebase after pushing: the pull request's head moves
 * away from what the branch now points at, but its name does not. By tip commit —
 * `Commit.associatedPullRequests` — for the opposite case, where Sapling or `gh stack`
 * push under a server-side branch of their own choosing (a local `dev/playwright_readme`
 * lands as `pr26403`), so the name a lookup would ask about was never the pull request's.
 * Both are exact, structured GraphQL lookups rather than a text match, so their cost is
 * bounded by the branch count rather than by how many pull requests happen to mention a
 * similar string anywhere in the repository's history.
 *
 * One alias per lookup per branch batches all of it into one query per batch;
 * `BRANCHES_PER_BATCH` keeps each batch small so one slow round trip delays only its own
 * branches rather than the whole stack, and so a failure — GitHub still has bad days —
 * costs a page, not the whole fetch.
 *
 * GitHub can take a moment to associate a just-opened pull request with its commit, same
 * as it can take a moment to process a push at all. Submitting hands its own answer to
 * `remember`, whose records fill in for branches a fetch found nothing for; see `cached`.
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
 * Branches per GraphQL call. Each branch costs two exact, structured lookups rather than
 * a free-text search, so this is not about staying under a resource limit — it is about
 * keeping one slow or failed round trip from costing the whole stack's worth of branches
 * rather than one page of it, and about giving progress something to report between pages.
 */
const BRANCHES_PER_BATCH = 20;
/** Pull requests read per lookup, per branch. A branch can carry more than one over its
 * life — reopened, or closed then replaced — and `preferPullRequest` picks the one that
 * matters, but the API has to be asked for more than the one most callers will ever want. */
const PULL_REQUESTS_PER_BRANCH = 3;

/**
 * How long a directly-read pull request outlives the fetch that failed to find it.
 *
 * It covers GitHub associating a just-opened pull request with its branch and commit,
 * which takes seconds — three against a quiet repository, longer under load — so a few
 * minutes is already generous. Bounded rather than permanent because nothing refreshes
 * such a record: a branch a fetch never finds a match for would otherwise keep reporting
 * `OPEN` long past a merge.
 */
const REMEMBERED_TIME_TO_LIVE_MILLISECONDS = 300_000;

export class PullRequestService {
  private cache: CacheEntry | null = null;
  /** In-flight fetch, so concurrent callers share one `gh` invocation. */
  private inFlight: Promise<Map<string, PullRequestStatus>> | null = null;
  /** The single follow-up a forced caller waits for while a fetch is already running. */
  private queuedForce: Promise<Map<string, PullRequestStatus>> | null = null;
  /**
   * Pull requests read outside a fetch, by branch.
   *
   * GitHub's GraphQL API answers `associatedPullRequests` for a commit it has not
   * finished processing yet with an empty list rather than an error. So the refresh that
   * follows a submit still asks about a pull request the API does not know about yet,
   * finds nothing, and caches that nothing for a minute — leaving the button offering to
   * open the pull
   * request it just opened. Submit learns the number from `pr create` directly, which
   * does not depend on GitHub having caught up, so what it learned is merged over the
   * fetched map until the next fetch does too.
   */
  private remembered = new Map<string, RememberedEntry>();
  private availability: PullRequestAvailability | null = null;
  private lastAttemptSucceeded: boolean | null = null;
  private lastError: string | null = null;
  /** `gh repo view` resolved once and kept: the owner and name do not change mid-session,
   * and every batch otherwise asked GitHub the same question again. Cached only on
   * success — a transient failure here should not permanently disable every later fetch
   * the way a cached rejection would. */
  private repoIdentity: { owner: string; repo: string } | null = null;

  constructor(
    private readonly cwd: string,
    /**
     * Where a fetch attempt's duration and outcome go. Defaulted to a no-op rather than
     * made optional at each call site, since every caller but the diagnostic log itself
     * wants the same nothing.
     *
     * This runs on a timer with no user action to blame it on, so the per-action command
     * log a submit or a rebase populates never sees it — see `runGh` below for why that
     * log stays scoped to actions. A timeout that only ever says "GitHub did not answer
     * in time" cannot be told apart from a slow query, a dropped connection, or GitHub
     * genuinely rate-limiting this token, and the difference matters for what to do next.
     */
    private readonly log: (line: string) => void = () => {},
    /**
     * How many of a fetch's branches have been answered, and the total — called once per
     * batch rather than once per branch, since a batch is the unit that actually returns.
     * A fetch that covers one branch never calls this at all, matching the header's own
     * choice to show nothing for a fetch too quick to watch.
     */
    private readonly onProgress: (
      done: number,
      total: number
    ) => void = () => {}
  ) {}

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
    // A branch with no tip commit — never actually seen, `BranchTip.sha` is not
    // optional, but the type does not forbid an empty string — has nothing to look up.
    const findable = branches.filter(branch => branch.sha);
    const { owner, repo } = await this.resolveRepo();
    const byBranch = new Map<string, PullRequestStatus>();
    let done = 0;
    for (const batch of chunk(findable, BRANCHES_PER_BATCH)) {
      const output = await this.runGh(
        [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `repo=${repo}`,
          "-F",
          "query=@-",
        ],
        lookupQuery(batch)
      );
      applyBatch(batch, output, byBranch);
      done += batch.length;
      this.onProgress(done, findable.length);
    }
    this.availability = { usable: true, reason: null };
    return byBranch;
  }

  /**
   * The owner and repository name `object(oid: …)` needs but `--search` never did: a
   * structured GraphQL query has no equivalent of `gh pr list` inferring the repository
   * from `cwd`'s remote, so this asks once and the fetch above trusts the cache.
   */
  private async resolveRepo(): Promise<{ owner: string; repo: string }> {
    if (this.repoIdentity) {
      return this.repoIdentity;
    }
    const output = await this.runGh(["repo", "view", "--json", "owner,name"]);
    const parsed = asRecord(JSON.parse(output));
    const owner = asRecord(parsed?.owner)?.login;
    const name = parsed?.name;
    if (typeof owner !== "string" || typeof name !== "string") {
      throw new Error("gh repo view did not report an owner and a name.");
    }
    this.repoIdentity = { owner, repo: name };
    return this.repoIdentity;
  }

  /**
   * Read through `gh`, recording why the badges are missing when it fails.
   *
   * The failure is described here and rethrown: the caller keeps the previous snapshot on
   * screen, so the panel needs a sentence explaining the gap even though nothing is thrown
   * at the user. Every attempt also goes to `this.log`, since the badge's own sentence
   * — "GitHub did not answer in time" — cannot tell a slow query apart from a killed one
   * or a short one that still 504'd, and the log line below can.
   */
  private async runGh(args: string[], input?: string): Promise<string> {
    // A query can run past a thousand characters; the log wants to know one ran, not to
    // reproduce it.
    const summary = args
      .map(arg => (arg.length > 200 ? `<${arg.length} chars omitted>` : arg))
      .join(" ");
    const startedAt = Date.now();
    this.log(`gh ${summary}`);
    try {
      const output = await spawnGh(args, {
        cwd: this.cwd,
        timeoutMilliseconds: FETCH_TIMEOUT_MILLISECONDS,
        ...(input === undefined ? {} : { input }),
      });
      this.log(`  → ok in ${Date.now() - startedAt}ms`);
      return output;
    } catch (error: unknown) {
      const kind = classifyGhFailure(error);
      const detail = ghFailureDetail(error) || errorMessage(error);
      this.log(
        `  → failed after ${Date.now() - startedAt}ms (${kind}): ${detail}`
      );
      this.availability = { usable: false, reason: describeFailure(error) };
      throw error;
    }
  }
}

/** `branches`, `size` at a time, in order — the pages a fetch is asked to report between. */
function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/** The fields read off every pull request node, by either lookup below. */
const PULL_REQUEST_NODE_FIELDS =
  "number state isDraft title url headRefName headRefOid reviewDecision";

/**
 * One GraphQL query answering every branch in `batch` at once, two ways: `n{index}` by
 * name, `c{index}` by tip commit. Both are exact, structured lookups, so a branch with no
 * match on either resolves to an empty list or `null` rather than an error — read
 * defensively in `applyBatch` rather than assumed present.
 */
function lookupQuery(batch: BranchTip[]): string {
  const aliases = batch
    .map(
      (branch, index) => `
  n${index}: pullRequests(headRefName: ${JSON.stringify(branch.name)}, states: [OPEN, CLOSED, MERGED], first: ${PULL_REQUESTS_PER_BRANCH}) {
    nodes { ${PULL_REQUEST_NODE_FIELDS} }
  }
  c${index}: object(oid: ${JSON.stringify(branch.sha)}) {
    ... on Commit {
      statusCheckRollup { state }
      associatedPullRequests(first: ${PULL_REQUESTS_PER_BRANCH}) {
        nodes { ${PULL_REQUEST_NODE_FIELDS} }
      }
    }
  }`
    )
    .join("");
  return `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {${aliases}\n} }`;
}

/** Read `lookupQuery(batch)`'s answer into `byBranch`, keyed by `batch`'s own branches. */
function applyBatch(
  batch: BranchTip[],
  output: string,
  byBranch: Map<string, PullRequestStatus>
): void {
  const repository = asRecord(
    asRecord(asRecord(JSON.parse(output))?.data)?.repository
  );
  batch.forEach((branch, index) => {
    const commit = asRecord(repository?.[`c${index}`]);
    // Only the commit lookup has a check run to report; a name match with no matching
    // commit — the branch moved since the pull request's head was read — has none to give.
    const checks = rollupState(commit?.statusCheckRollup);
    const byName = asArray(asRecord(repository?.[`n${index}`])?.nodes);
    const byCommit = asArray(asRecord(commit?.associatedPullRequests)?.nodes);
    for (const value of [...byName, ...byCommit]) {
      const entry = asRecord(value);
      if (!entry) {
        continue;
      }
      const status: PullRequestStatus = {
        number: typeof entry.number === "number" ? entry.number : 0,
        state: typeof entry.state === "string" ? entry.state : "",
        isDraft: entry.isDraft === true,
        title: typeof entry.title === "string" ? entry.title : "",
        url: typeof entry.url === "string" ? entry.url : "",
        headSha: typeof entry.headRefOid === "string" ? entry.headRefOid : "",
        reviewDecision:
          typeof entry.reviewDecision === "string"
            ? entry.reviewDecision
            : null,
        checks,
      };
      // A branch can carry several PRs over time (reopened, or closed then
      // replaced). Prefer an open one, else the highest number — the newest.
      const existing = byBranch.get(branch.name);
      if (!existing || preferPullRequest(status, existing)) {
        byBranch.set(branch.name, status);
      }
    }
  });
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
 * `Commit.statusCheckRollup.state` into the badge's own three-way verdict.
 *
 * This is GitHub's own rollup of every check and status on the commit, already collapsed
 * to one enum — unlike `gh pr list --json statusCheckRollup`, which synthesizes an array of
 * every individual check run and status context per result. That synthesis is what made
 * the old `--search`-based fetch expensive per match rather than merely broad; asking for
 * the rollup GitHub already computes, on the one commit each batch names directly, costs
 * one enum comparison instead.
 *
 * Exported for the tests. `EXPECTED` is a check that has not started, which reads the same
 * as one still running.
 */
export function rollupState(rollup: unknown): PullRequestStatus["checks"] {
  const state = upperCaseField(asRecord(rollup)?.state);
  if (state === "SUCCESS") {
    return "success";
  }
  if (state === "FAILURE" || state === "ERROR") {
    return "failure";
  }
  if (state === "PENDING" || state === "EXPECTED") {
    return "pending";
  }
  return null;
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
