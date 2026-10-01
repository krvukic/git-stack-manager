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
 * `BRANCHES_PER_BATCH` keeps each batch small so a failure — GitHub still has bad days —
 * costs a page's branches rather than the whole fetch, and so progress has something to
 * report between pages.
 *
 * GitHub can take a moment to associate a just-opened pull request with its commit, same
 * as it can take a moment to process a push at all. Submit hands its own answer to
 * `remember`, whose records fill in for branches a fetch found nothing for; see `cached`.
 *
 * A missing `gh`, a repository with no GitHub remote, or a failed auth check are
 * all normal: this extension works fine on a plain git repo. Those cases
 * degrade to "no pull request information", reported once rather than per refresh.
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

/** What the UI needs to explain an empty pull request panel. */
export type PullRequestAvailability = {
  usable: boolean;
  /** Why pull request status is unavailable, for a one-time notice. Null when usable. */
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

/** A local branch and the commit it points at, the two ways to find its pull request. */
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
/**
 * Batches in flight at once. GitHub's secondary rate limits penalise a burst of concurrent
 * requests from one token more than they do the same requests spread out, so a stack large
 * enough to need several batches still sends them a couple at a time rather than all at once.
 */
const BATCH_CONCURRENCY = 2;
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
   * open the pull request it just opened. Submit learns the number from `pr create`
   * directly, which does not depend on GitHub having caught up, so what it learned is
   * merged over the fetched map until the next fetch does too.
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
     * log a submit or a rebase populates never sees it. A timeout that only ever says
     * "GitHub did not answer in time" cannot be told apart from a slow query, a dropped
     * connection, or GitHub genuinely rate-limiting this token, and the difference matters
     * for what to do next.
     */
    private readonly log: (line: string) => void = () => {},
    /**
     * How many of a fetch's branches have been answered, and the total — called once per
     * batch rather than once per branch, since a batch is the unit that actually returns.
     * Batches run concurrently, so this fires as each one settles rather than in a fixed
     * order; a fetch of one branch in one batch still calls it once, at completion.
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

  /** Why pull request status is missing, if it is. Null until a fetch has been tried. */
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
      .then(({ byBranch, failedBranches, partialFailure }) => {
        this.cache = { byBranch, fetchedAt: Date.now() };
        // The GraphQL lookup now has an answer for these branches, so a direct record
        // adds nothing — and the fetched copy carries the checks and review decision
        // that a record taken at submit time cannot. A branch whose batch failed this
        // time keeps whatever record it had, since `byBranch` itself does too.
        for (const branch of byBranch.keys()) {
          if (!failedBranches.has(branch)) {
            this.remembered.delete(branch);
          }
        }
        this.lastAttemptSucceeded = partialFailure === null;
        this.lastError = partialFailure;
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

  private async fetch(branches: BranchTip[]): Promise<{
    byBranch: Map<string, PullRequestStatus>;
    failedBranches: Set<string>;
    partialFailure: string | null;
  }> {
    // A branch with no tip commit has nothing to look up.
    const findable = branches.filter(branch => branch.sha);
    const { owner, repo } = await this.resolveRepo();
    const byBranch = new Map<string, PullRequestStatus>();
    let done = 0;
    const batches = chunk(findable, BRANCHES_PER_BATCH);
    // `BATCH_CONCURRENCY` batches at a time: a failed round trip still costs only its own
    // page's branches, not the rest, without sending every batch's request at once.
    const outcomes = await mapWithConcurrency(
      batches,
      BATCH_CONCURRENCY,
      async batch => {
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
        try {
          applyBatch(batch, output, byBranch);
        } catch (error: unknown) {
          this.log(`  → batch did not parse: ${errorMessage(error)}`);
          throw error;
        }
        done += batch.length;
        this.onProgress(done, findable.length);
      }
    );
    const failedBatches = batches.filter(
      (_, index) => outcomes[index]?.status === "rejected"
    );
    if (failedBatches.length && failedBatches.length === batches.length) {
      // Every batch failing is indistinguishable from GitHub, or the network, being
      // down — the caller then keeps the previous snapshot rather than reporting an
      // empty answer as the whole fetch.
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected"
      ) as PromiseRejectedResult;
      throw rejected.reason;
    }
    const failedBranches = new Set(
      failedBatches.flatMap(batch => batch.map(branch => branch.name))
    );
    const partialFailure = failedBranches.size
      ? (this.availabilityReason() ?? "A batch of branches failed to fetch.")
      : null;
    this.availability = { usable: true, reason: null };
    // A branch whose batch failed keeps whatever the previous snapshot answered for
    // it, rather than losing its badge because this attempt's answer is only partial.
    const previous = this.cache?.byBranch;
    for (const batch of failedBatches) {
      for (const branch of batch) {
        const stale = previous?.get(branch.name);
        if (stale) {
          byBranch.set(branch.name, stale);
        }
      }
    }
    return { byBranch, failedBranches, partialFailure };
  }

  /**
   * The owner and repository name every query below needs: a structured GraphQL query has
   * no equivalent of `gh pr list` inferring the repository from `cwd`'s remote, so this
   * asks once and the fetch above trusts the cache.
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
    // The query itself travels over `input`, never among these arguments, so every
    // argument here is short enough to log in full.
    const summary = args.join(" ");
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

/**
 * `items.map(run)`, settled like `Promise.allSettled`, but never running more than `limit`
 * calls to `run` at once. A worker picks up the next item as soon as one of its own
 * finishes, rather than waiting for every item in a fixed group to finish together.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const outcomes = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        outcomes[index] = {
          status: "fulfilled",
          value: await run(items[index]!),
        };
      } catch (reason: unknown) {
        outcomes[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return outcomes;
}

/** The fields read off every pull request node, by either lookup below, except its rollup. */
const PULL_REQUEST_SUMMARY_FIELDS = `number state isDraft title url headRefName headRefOid reviewDecision`;

/**
 * `PULL_REQUEST_SUMMARY_FIELDS` plus the pull request's own head commit's rollup.
 *
 * `commits(last: 1)` is the pull request's own head, which is what the rollup has to come
 * from: the branch's local tip is not necessarily what GitHub has run checks against, and
 * an amend or a rebase since the last push moves the local tip away from that head without
 * moving the pull request at all. The by-commit lookup below already names that head
 * directly, so its nodes use `PULL_REQUEST_SUMMARY_FIELDS` and read the rollup once off the
 * commit object instead of asking for it again per pull request.
 */
const PULL_REQUEST_NODE_FIELDS = `${PULL_REQUEST_SUMMARY_FIELDS}
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/**
 * One GraphQL query answering every branch in `batch` at once, two ways: `n{index}` by
 * name, `c{index}` by tip commit. Both are exact, structured lookups, so a branch with no
 * match on either resolves to an empty list or `null` rather than an error — read
 * defensively in `applyBatch` rather than assumed present.
 *
 * `orderBy` is not decoration on either lookup: without it, GitHub lists both a branch
 * name's pull requests and a commit's associated pull requests oldest first, so `first: 3`
 * on a name reused by four closed pull requests and one open one returns the three oldest
 * closed ones and drops the open one — and on a commit a later-created pull request also
 * contains, newest first is what keeps that pull request's own entry inside the page
 * instead of being crowded out by older ones that merely contain the same commit.
 */
function lookupQuery(batch: BranchTip[]): string {
  const aliases = batch
    .map(
      (branch, index) => `
  n${index}: pullRequests(headRefName: ${JSON.stringify(branch.name)}, states: [OPEN, CLOSED, MERGED], orderBy: { field: CREATED_AT, direction: DESC }, first: ${PULL_REQUESTS_PER_BRANCH}) {
    nodes { ${PULL_REQUEST_NODE_FIELDS} }
  }
  c${index}: object(oid: ${JSON.stringify(branch.sha)}) {
    ... on Commit {
      statusCheckRollup { state }
      associatedPullRequests(first: ${PULL_REQUESTS_PER_BRANCH}, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ${PULL_REQUEST_SUMMARY_FIELDS} }
      }
    }
  }`
    )
    .join("");
  return `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {${aliases}\n} }`;
}

/** A pull request node's own head rollup, from its `commits(last: 1)` field. */
function nodeChecks(
  entry: Record<string, unknown>
): PullRequestStatus["checks"] {
  const commits = asArray(asRecord(entry.commits)?.nodes);
  const commit = asRecord(asRecord(commits[0])?.commit);
  return rollupState(commit?.statusCheckRollup);
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
    const byName = asArray(asRecord(repository?.[`n${index}`])?.nodes).map(
      value => {
        const entry = asRecord(value);
        return { entry, checks: entry ? nodeChecks(entry) : null };
      }
    );
    // `associatedPullRequests` answers with every pull request that contains the commit
    // anywhere in its history, not only the one it heads — a lower branch's tip sits inside
    // every pull request stacked on top of it too. Keeping only the node whose own head is
    // this exact commit is what tells the two apart, and that match's rollup is the commit
    // object's own, already read once above rather than per pull request.
    const commitChecks = rollupState(commit?.statusCheckRollup);
    const byCommit = asArray(asRecord(commit?.associatedPullRequests)?.nodes)
      .filter(value => asRecord(value)?.headRefOid === branch.sha)
      .map(value => ({ entry: asRecord(value), checks: commitChecks }));
    for (const { entry, checks } of [...byName, ...byCommit]) {
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
      // A branch can carry several pull requests over time (reopened, or closed then
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
 * to one enum, so reading it costs one enum comparison rather than synthesizing a verdict
 * from every individual check run and status context on the commit.
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

/** Prefer an open pull request, then a draft over nothing, then the newest number. */
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
