/**
 * submit — push one branch and make its pull request match the commit message.
 *
 * Force-pushing a reworded commit updates the branch on GitHub but leaves the
 * pull request's title and body at whatever they said when the PR was opened.
 * GitHub fills those two fields from the commit only at creation time and never
 * looks at the commit again, so a message amend reaches the branch and stops
 * there. Verified against a live PR: after amending the message and pushing,
 * `headRefOid` moved to the new sha while `title` and `body` kept their original
 * text. Submitting therefore has to write the message across explicitly; the
 * push alone is not enough.
 *
 * The subject becomes the title and everything after the blank line becomes the
 * body, which is the same split `gh pr create --fill` performs. That keeps the
 * commit message the single source of truth: edit it in the sidebar, submit, and
 * the pull request says the same thing.
 */
import { GitRunner } from "#git/runner";
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
   * badge from this outcome. `gh pr list --search`, which the badges normally come from,
   * reads an index that trails a pull request opened a moment ago.
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

/** The commit message, split the way a pull request wants it. */
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
  options: { draft?: boolean } = {}
): Promise<SubmitOutcome> {
  const { remote } = trunkParts(snapshot);
  const base = baseBranchFor(snapshot, branch);
  const message = await readMessage(git, branch);

  await pushBranch(git, remote, branch);

  const existing = await findPullRequest(git, branch);
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
  const opened = await createPullRequest(
    git,
    branch,
    base,
    message,
    options.draft === true
  );
  return {
    branch,
    created: true,
    number: opened.number,
    url: opened.url,
    title: message.title,
    isDraft: options.draft === true,
    base,
    staleBase: await findStaleBase(git, snapshot, remote, branch, base),
  };
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
  // Trunk is maintained by everyone; being behind it is a rebase question, not a
  // submit one, and the rebase and restack actions already cover it.
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
 * this extension fetches on every rebase and restack. Reproduced against a live
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

/**
 * Find the open pull request for `branch`, if any.
 *
 * Only open ones count. A merged or closed pull request must not be reopened by
 * an edit — submitting a branch whose PR merged is a new round of work and wants
 * a new PR, which is also what `gh pr create` does on its own.
 */
async function findPullRequest(
  git: GitRunner,
  branch: string
): Promise<ExistingPullRequest | null> {
  const output = await runGh(git, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number,url,isDraft,baseRefName",
  ]);
  const entries: unknown = JSON.parse(output || "[]");
  if (!Array.isArray(entries) || !entries.length) {
    return null;
  }
  const first = entries[0] as Record<string, unknown>;
  return {
    number: typeof first.number === "number" ? first.number : 0,
    url: typeof first.url === "string" ? first.url : null,
    isDraft: first.isDraft === true,
    baseRefName:
      typeof first.baseRefName === "string" ? first.baseRefName : null,
  };
}

/**
 * Rewrite an existing pull request's title and body.
 *
 * `gh pr edit` leaves every field it is not given alone, so the base branch and
 * reviewers survive — confirmed against a stacked pull request, whose base still
 * pointed at the layer below afterwards. The body goes in over stdin so a message
 * containing backticks or quotes cannot be reinterpreted by a shell; `gh` never
 * sees a shell here anyway, but a temp file or an argument would both cap the
 * length.
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
