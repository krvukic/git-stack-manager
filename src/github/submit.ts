/**
 * submit — push one branch and make its pull request match the commit message.
 *
 * Force-pushing a reworded commit updates the branch on GitHub but leaves the
 * pull request's title and body at whatever they said when it was opened.
 * GitHub fills those two fields from the commit only at creation time and never
 * looks at the commit again, so a message amend reaches the branch and stops
 * there. Verified against a live pull request: after amending the message and pushing,
 * `headRefOid` moved to the new sha while `title` and `body` kept their original
 * text. Submitting therefore has to write the message across explicitly; the
 * push alone is not enough.
 *
 * The subject becomes the title and everything after the blank line becomes the
 * body, which is the same split `gh pr create --fill` performs. That keeps the
 * commit message the single source of truth: edit it in the sidebar, submit, and
 * the pull request says the same thing.
 */
import { asArray, asRecord } from "#core/values";
import { GitError, GitRunner } from "#git/runner";
import { RawCommit, RawData } from "#git/snapshot";
import { runGh } from "#github/ghRunner";

export type SubmitOutcome = {
  branch: string;
  /** Whether the pull request was opened now or already existed and was updated. */
  created: boolean;
  /** Pull request number, when `gh` reported one. */
  number: number | null;
  url: string | null;
  /**
   * Title and draft state as the pull request now holds them, so a caller can draw the
   * badge from this outcome. The commit lookup the badges normally come from can trail a
   * pull request opened a moment ago.
   */
  title: string;
  isDraft: boolean;
  /** Base branch the pull request targets. */
  base: string;
  /**
   * Set when the base branch as pushed is not an ancestor of this branch, which
   * inflates the pull request's diff with the layer below's changes. Null when the
   * base is fine, or when it is trunk.
   */
  staleBase: StaleBase | null;
};

/**
 * A base that would make this pull request's diff too wide, and which of the two
 * causes it is — they need opposite fixes, so the UI has to tell them apart.
 */
export type StaleBase = {
  branch: string;
  /**
   * `unsubmitted` — the base has local commits it has never pushed, so submitting
   * the base fixes it. `rewritten` — the base was pushed but has since moved out
   * from under this branch, so this branch needs rebasing onto it instead.
   */
  reason: "unsubmitted" | "rewritten";
};

export type SubmitOptions = {
  /**
   * Whether a new pull request opens as a draft when its branch has no stored choice: the
   * Config drawer's *New pull requests*.
   */
  draftByDefault?: boolean;
  /**
   * Whether a branch whose newest pull request is closed gets a new pull request beside it:
   * **Submit as new pull request**. Without it, `ClosedPullRequestError` refuses the branch.
   */
  besideClosed?: boolean;
};

/**
 * Submit's refusal of a branch whose newest pull request someone closed on GitHub.
 *
 * Closing a pull request is a decision about its branch. Without this refusal, Submit would find
 * no open pull request, force-push the branch, and open a second pull request beside the closed
 * one, because `gh pr create` checks only for an open one. So the refusal comes before the push,
 * and it names what to do instead: reopen the pull request, or ask for a new one.
 */
export class ClosedPullRequestError extends GitError {
  constructor(
    readonly branch: string,
    readonly number: number,
    /** What a Submit stack submitted below `branch` before it stopped, bottom first. */
    readonly submitted: SubmitOutcome[],
    consequence: string
  ) {
    super(
      `Pull request #${number} for ${branch} is closed, so ${consequence}. Reopen it on GitHub, or right-click ${branch}'s commit and choose Submit as new pull request.`,
      "submit"
    );
  }
}

/** The commit message, split into the title and body a pull request takes. */
type Message = {
  title: string;
  body: string;
};

/**
 * Push `branch` and reconcile its pull request with the commit message.
 *
 * The push and the message write are one action deliberately. Splitting them
 * into "push code" and "push message" buttons would leave the two able to
 * disagree, which is the state this whole function exists to prevent.
 */
export async function submitBranch(
  git: GitRunner,
  snapshot: RawData,
  branch: string,
  options: SubmitOptions = {}
): Promise<SubmitOutcome> {
  const found = await findPullRequests(git, [branch]);
  return submitAfterLookup(git, snapshot, branch, found.get(branch), options);
}

/**
 * `submitBranch` after `findPullRequests` has answered for `branch`. The answer has to come
 * before the push, so that a refusal leaves nothing half-submitted.
 */
async function submitAfterLookup(
  git: GitRunner,
  snapshot: RawData,
  branch: string,
  found: NamedPullRequests | undefined,
  options: SubmitOptions
): Promise<SubmitOutcome> {
  const { remote } = trunkParts(snapshot);
  const base = baseBranchFor(snapshot, branch);
  const message = await readMessage(git, branch);
  const existing = found?.open ?? null;
  const closed = found?.closed ?? null;
  if (closed !== null && !options.besideClosed) {
    throw new ClosedPullRequestError(
      branch,
      closed,
      [],
      "Submit pushed nothing"
    );
  }
  if (!existing) {
    await requirePublishedBase(git, snapshot, remote, branch, base);
  }

  await pushBranch(git, remote, branch);

  if (existing) {
    await editPullRequest(git, branch, message);
    // The base to check is the one the pull request actually targets, not the one
    // derived from local shape. An edit does not move the base, and a rewritten
    // lower layer stops looking like this branch's parent locally while GitHub
    // still diffs against it.
    const effectiveBase = existing.baseRefName ?? base;
    return {
      branch,
      created: false,
      number: existing.number,
      url: existing.url,
      title: message.title,
      // The draft choice applies to a pull request that submit opens. One that is already open
      // keeps the state it has, as Sapling's submit leaves it.
      isDraft: existing.isDraft,
      base: effectiveBase,
      staleBase: await findStaleBase(
        git,
        snapshot,
        remote,
        branch,
        effectiveBase
      ),
    };
  }
  const draft =
    snapshot.branchDrafts.get(branch) ?? options.draftByDefault === true;
  const opened = await createPullRequest(git, branch, base, message, draft);
  return {
    branch,
    created: true,
    number: opened.number,
    url: opened.url,
    title: message.title,
    isDraft: draft,
    base,
    staleBase: await findStaleBase(git, snapshot, remote, branch, base),
  };
}

/**
 * Push every branch from the bottom of the stack up to `branch`, and open or update each
 * one's pull request, bottom first.
 *
 * The order is the point. A pull request can only target a branch GitHub already has, so
 * submitting the top of an unsubmitted stack on its own failed with GitHub's "Base ref must
 * be a branch", and the stack had to be submitted one layer at a time from the bottom. A
 * failure stops the walk: the layers above would target the one that just failed. So does a
 * layer whose pull request is closed, because the layers above it target that branch.
 *
 * `besideClosed` never reaches a layer. It is a choice about one branch, which
 * **Submit as new pull request** makes.
 *
 * `findPullRequests` looks up every layer in one query before the first push. Each answer holds
 * when its layer's turn comes: what the walk pushes and opens below a layer changes nothing that
 * GitHub holds under that layer's name.
 */
export async function submitStack(
  git: GitRunner,
  snapshot: RawData,
  branch: string,
  options: SubmitOptions = {}
): Promise<SubmitOutcome[]> {
  const layerOptions = { ...options, besideClosed: false };
  const layers = stackBranchesUpTo(snapshot, branch);
  const found = await findPullRequests(git, layers);
  const outcomes: SubmitOutcome[] = [];
  for (const layer of layers) {
    try {
      outcomes.push(
        await submitAfterLookup(
          git,
          snapshot,
          layer,
          found.get(layer),
          layerOptions
        )
      );
    } catch (error: unknown) {
      if (!(error instanceof ClosedPullRequestError)) {
        throw error;
      }
      throw new ClosedPullRequestError(
        layer,
        error.number,
        outcomes,
        outcomes.length
          ? `Submit stack submitted only ${joinNames(outcomes.map(outcome => outcome.branch))}`
          : "Submit stack pushed nothing"
      );
    }
  }
  return outcomes;
}

/** "a", "a and b", or "a, b and c". */
function joinNames(names: string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The branches `submitStack` submits, bottom first, ending with `branch`. */
export function stackBranchesUpTo(snapshot: RawData, branch: string): string[] {
  const trunk = trunkParts(snapshot).branch;
  const layers = [branch];
  for (
    let below = baseBranchFor(snapshot, branch);
    below !== trunk && !layers.includes(below);
    below = baseBranchFor(snapshot, below)
  ) {
    layers.unshift(below);
  }
  return layers;
}

/**
 * Every branch of the stack that holds `branch`, bottom first: the branches below it, then
 * the ones above it for as long as the stack does not fork.
 *
 * Read off the graph, because nothing else records a stack: a branch belongs with the one its
 * commits are on. A stack that forks above `branch` ends at the fork, since the two lines
 * above it are two stacks that share a bottom, and no rule says which one a click meant.
 */
export function stackChain(snapshot: RawData, branch: string): string[] {
  const layers = stackBranchesUpTo(snapshot, branch);
  const childrenOf = new Map<string, RawCommit[]>();
  for (const commit of snapshot.commits) {
    const parent = commit.parents[0];
    if (parent !== undefined) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), commit]);
    }
  }
  let current = snapshot.commits.find(commit =>
    commit.branches.includes(branch)
  );
  while (current) {
    const children: RawCommit[] = childrenOf.get(current.sha) ?? [];
    current = children.length === 1 ? children[0] : undefined;
    const above = current?.branches.find(name => !layers.includes(name));
    if (above) {
      layers.push(above);
    }
  }
  return layers;
}

/**
 * Refuse to open a pull request onto a base GitHub does not have yet, naming the fix.
 * GitHub's own answer is "Base ref must be a branch", which reads like a bug.
 */
async function requirePublishedBase(
  git: GitRunner,
  snapshot: RawData,
  remote: string,
  branch: string,
  base: string
): Promise<void> {
  if (base === trunkParts(snapshot).branch) {
    return;
  }
  if (
    await git.succeeds([
      "rev-parse",
      "--verify",
      "--quiet",
      `${remote}/${base}`,
    ])
  ) {
    return;
  }
  throw new GitError(
    `${branch} is stacked on ${base}, which has not been submitted, so its pull request has no base on GitHub yet. Submit the stack instead, which pushes every layer from the bottom up.`,
    "submit"
  );
}

/**
 * Report a base branch whose pushed tip is not an ancestor of this branch.
 *
 * GitHub computes a pull request's diff from the merge base of the two *pushed*
 * refs, so whenever the base tip on the server is not an ancestor of what was
 * just pushed, the diff also carries the layer below's changes. Two different
 * states produce that, and asking about ancestry catches both: a base that was
 * never submitted, and a base that was submitted but has since been rewritten out
 * from under this branch. Checking only whether the base was behind its own remote
 * missed the second — observed with a stacked pull request whose base was fully in
 * sync while its diff still showed the parent branch's file, because this branch
 * still pointed at the base's pre-rewrite commit.
 *
 * Only reported, never repaired: the fix is either submitting the base or rebasing
 * onto it, and both are the user's call rather than something to do behind a
 * button they pressed for one branch.
 */
async function findStaleBase(
  git: GitRunner,
  snapshot: RawData,
  remote: string,
  branch: string,
  base: string
): Promise<StaleBase | null> {
  // Everyone maintains trunk, so trailing it is a rebase question rather than a submit
  // one, and the rebase actions already cover it.
  if (base === trunkParts(snapshot).branch) {
    return null;
  }
  const remoteBase = `${remote}/${base}`;
  // No remote-tracking ref means the base has never been pushed, so its own pull
  // request does not exist yet either.
  if (!(await git.succeeds(["rev-parse", "--verify", "--quiet", remoteBase]))) {
    return { branch: base, reason: "unsubmitted" };
  }
  if (await git.succeeds(["merge-base", "--is-ancestor", remoteBase, branch])) {
    return null;
  }
  // Which fix applies depends on whether the base still has unpushed work. If it
  // does, submitting it is what closes the gap; if it is already fully pushed, the
  // base moved and this branch is the one that has to move.
  const counts = await git.tryRun([
    "rev-list",
    "--left-right",
    "--count",
    `${base}...${remoteBase}`,
  ]);
  const baseAhead = Number(counts?.split(/\s+/)[0] ?? 0);
  return { branch: base, reason: baseAhead > 0 ? "unsubmitted" : "rewritten" };
}

/**
 * Push with both leases. `--force-with-lease` on its own compares against the
 * remote-tracking ref, which any earlier `git fetch` has already advanced — and
 * this extension fetches on every rebase onto trunk. Reproduced against a live
 * remote: a teammate pushed, a local rebase fetched, and the next
 * `--force-with-lease` reported "forced update" and destroyed their commit.
 * `--force-if-includes` additionally requires that the commits being replaced are
 * ones this checkout has actually seen, which rejected the same push.
 *
 * The refspec is explicit and `-u` is set because the branch being submitted is
 * usually not the checked-out one — the user clicks a row in the tree. Without
 * `-u` an explicit refspec leaves the branch with no upstream, and the tree would
 * keep reading "not submitted" straight after a successful push.
 */
async function pushBranch(
  git: GitRunner,
  remote: string,
  branch: string
): Promise<void> {
  await git.run([
    "push",
    "--force-with-lease",
    "--force-if-includes",
    "-u",
    remote,
    `${branch}:${branch}`,
  ]);
}

/** Read the message from the branch tip, whether or not it is checked out. */
async function readMessage(git: GitRunner, branch: string): Promise<Message> {
  // %s and %b rather than one read of the whole message: git already knows where
  // the subject ends, and splitting on the first blank line here would disagree
  // with it on a message whose subject wraps.
  const title = (await git.run(["log", "-1", "--format=%s", branch])).trim();
  const body = await git.run(["log", "-1", "--format=%b", branch]);
  return { title, body: body.trim() ? body : "" };
}

type ExistingPullRequest = {
  number: number;
  url: string | null;
  isDraft: boolean;
  /** The base recorded on GitHub, which an edit leaves alone. */
  baseRefName: string | null;
};

/** What GitHub holds under one branch's name, as the two facts Submit acts on. */
type NamedPullRequests = {
  /** The pull request Submit updates. */
  open: ExistingPullRequest | null;
  /**
   * The newest pull request's number while no open one exists and the newest was closed without
   * merging, which Submit refuses to replace on its own. A merged newest one leaves this null: a
   * submit of a branch whose pull request merged is a new round of work, and it belongs in a new
   * pull request.
   */
  closed: number | null;
};

/**
 * Pull requests read per branch name, newest first: as many as `gh pr list` reads by default. An
 * open pull request older than that many others under the same name goes unseen.
 */
const PULL_REQUESTS_PER_NAME = 30;

/**
 * The pull requests named after each of `branches`, in one GraphQL query however many there are.
 *
 * `gh pr list --head` asks GitHub the same `pullRequests(headRefName:)` question, but for one
 * branch per process. Asked that way, Submit stack pays a round trip of about half a second per
 * layer, one after another, measured against a live repository; one query pays a single round
 * trip. `{owner}` and `{repo}` are `gh api` placeholders that `gh` fills in from the remote, so the
 * query needs no `gh repo view` first.
 */
async function findPullRequests(
  git: GitRunner,
  branches: string[]
): Promise<Map<string, NamedPullRequests>> {
  const output = await runGh(
    git,
    [
      "api",
      "graphql",
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      "query=@-",
    ],
    lookupQuery(branches)
  );
  const repository = asRecord(
    asRecord(asRecord(JSON.parse(output || "{}"))?.data)?.repository
  );
  // Read as "no pull request", a missing answer would make Submit open a second one.
  if (!repository) {
    throw new GitError(
      "GitHub answered the pull request lookup without a repository, so Submit pushed nothing. Check that `gh repo view` shows this repository, then submit again.",
      "submit"
    );
  }
  return new Map(
    branches.map((branch, index) => [
      branch,
      namedPullRequests(asArray(asRecord(repository[`l${index}`])?.nodes)),
    ])
  );
}

/** One alias per branch, `l{index}`, in the order `branches` lists them. */
function lookupQuery(branches: string[]): string {
  const aliases = branches
    .map(
      (branch, index) =>
        `  l${index}: pullRequests(headRefName: ${JSON.stringify(branch)}, states: [OPEN, CLOSED, MERGED], orderBy: { field: CREATED_AT, direction: DESC }, first: ${PULL_REQUESTS_PER_NAME}) { nodes { number url isDraft baseRefName state } }`
    )
    .join("\n");
  return `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {\n${aliases}\n} }`;
}

/** Read one alias's nodes into the two facts Submit acts on. */
function namedPullRequests(nodes: unknown[]): NamedPullRequests {
  const entries = nodes.flatMap(node => {
    const record = asRecord(node);
    return record ? [record] : [];
  });
  const numberOf = (entry: Record<string, unknown>) =>
    typeof entry.number === "number" ? entry.number : 0;
  const open = entries.find(entry => entry.state === "OPEN");
  if (open) {
    return {
      open: {
        number: numberOf(open),
        url: typeof open.url === "string" ? open.url : null,
        isDraft: open.isDraft === true,
        baseRefName:
          typeof open.baseRefName === "string" ? open.baseRefName : null,
      },
      closed: null,
    };
  }
  // The highest number is the newest, whatever order the answer lists them in.
  const newest = entries.reduce<Record<string, unknown> | null>(
    (best, entry) => (best && numberOf(best) >= numberOf(entry) ? best : entry),
    null
  );
  return {
    open: null,
    closed: newest?.state === "CLOSED" ? numberOf(newest) : null,
  };
}

/**
 * Rewrite an existing pull request's title and body.
 *
 * `gh pr edit` leaves every field it is not given alone, so the base branch and
 * reviewers survive — confirmed against a stacked pull request, whose base still
 * pointed at the layer below afterwards. The body goes in over stdin, because a temp
 * file and an argument would both cap the length. Backticks and quotes in a message
 * survive either way — `gh` never sees a shell here.
 */
async function editPullRequest(
  git: GitRunner,
  branch: string,
  message: Message
): Promise<void> {
  await runGh(
    git,
    ["pr", "edit", branch, "--title", message.title, "--body-file", "-"],
    message.body
  );
}

/**
 * Set `branch`'s pull request title and body from its commit message, pushing nothing.
 *
 * What Link stack runs for each pull request it links: the code on GitHub is whatever was last
 * pushed, and the text is the half a link can bring up to date without a push.
 */
export async function syncPullRequestMessage(
  git: GitRunner,
  branch: string
): Promise<void> {
  await editPullRequest(git, branch, await readMessage(git, branch));
}

/**
 * Open a pull request for a branch that does not have one yet. The base is not
 * echoed back: the caller passed it in, and it is authoritative here in a way it
 * is not for a pull request that already existed.
 */
async function createPullRequest(
  git: GitRunner,
  branch: string,
  base: string,
  message: Message,
  draft: boolean
): Promise<{ number: number; url: string | null }> {
  // --head names the branch so this works from any checkout, not just when the
  // submitted branch happens to be the current one.
  const args = [
    "pr",
    "create",
    "--head",
    branch,
    "--base",
    base,
    "--title",
    message.title,
    "--body-file",
    "-",
  ];
  if (draft) {
    args.push("--draft");
  }
  const output = await runGh(git, args, message.body);
  const url =
    output
      .trim()
      .split("\n")
      .find(line => line.startsWith("http")) ?? null;
  const matched = url?.match(/\/pull\/(\d+)/)?.[1];
  return { number: matched ? Number(matched) : 0, url };
}

/**
 * Trunk split into the remote that holds it — the one a branch is submitted to — and its
 * branch name on the server. Only a slash-qualified ref names a remote, so a bare trunk name
 * falls back to the conventional one.
 */
function trunkParts(snapshot: RawData): { remote: string; branch: string } {
  const trunkRef = snapshot.trunkRef ?? "main";
  const slash = trunkRef.indexOf("/");
  return slash > 0
    ? { remote: trunkRef.slice(0, slash), branch: trunkRef.slice(slash + 1) }
    : { remote: "origin", branch: trunkRef };
}

/**
 * The branch a pull request for `branch` should target.
 *
 * In the one-commit-one-branch model this extension draws, a stacked branch must
 * target the branch below it rather than trunk, or its pull request would show
 * every commit underneath it as part of the change. So walk first parents down
 * from the branch tip and take the first local commit that carries a branch;
 * reaching trunk without finding one means this branch sits at the bottom.
 */
export function baseBranchFor(snapshot: RawData, branch: string): string {
  const bySha = new Map(snapshot.commits.map(commit => [commit.sha, commit]));
  const tip = snapshot.commits.find(commit => commit.branches.includes(branch));
  if (!tip) {
    return trunkParts(snapshot).branch;
  }
  // A root commit and a parent outside the walk both end it, so the two absent cases
  // collapse into the same lookup miss.
  const firstParentOf = (commit: RawCommit): RawCommit | undefined => {
    const parentSha = commit.parents[0];
    return parentSha === undefined ? undefined : bySha.get(parentSha);
  };
  let parent = firstParentOf(tip);
  while (parent) {
    // A branch other than the one being submitted marks the layer below. The tip
    // can share its commit with several branches, so skip `branch` itself.
    const below = parent.branches.find(name => name !== branch);
    if (below) {
      return below;
    }
    parent = firstParentOf(parent);
  }
  return trunkParts(snapshot).branch;
}
