/**
 * repoReader — reads the whole smartlog snapshot in a fixed number of git
 * invocations, independent of how many branches or fork bases exist.
 *
 * The naive shape of this read is one `git show` + one `merge-base` +
 * one `rev-list --count` per fork base, plus separate calls for the repo root,
 * user email, trunk detection, HEAD, and branch tips. On a stack with three
 * bases that is roughly twenty processes for a single refresh. Three batching
 * moves collapse it to five:
 *
 *   1. `for-each-ref` reads HEAD, every local branch tip, and the trunk
 *      candidates (with their subject and date) in one pass. Trunk detection
 *      therefore costs nothing extra — `%(symref)` resolves `origin/HEAD`
 *      without the separate `symbolic-ref` call, and the candidate fallback
 *      becomes a lookup in the result rather than a probe per candidate.
 *   2. `log --boundary` emits the fork bases alongside the local commits, so
 *      each base's subject and date arrive with the history walk instead of a
 *      `git show` per base.
 *   3. One `rev-list --left-right --count` per base answers "is it on trunk?"
 *      and "how far behind the tip?" together — a zero left-count means every
 *      commit reachable from the base is also reachable from trunk, which is
 *      exactly ancestry, so `merge-base --is-ancestor` becomes redundant.
 *
 * `status --porcelain=v2 --branch` then supplies working-copy state (parsed by
 * `#git/statusParser`), and the repo root and user email ride along on
 * `rev-parse`/`config`. The shape of the result lives in `#git/snapshot`.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { FIELD_SEPARATOR, GitRunner, RECORD_SEPARATOR } from "#git/runner";
import {
  BaseInfo,
  BranchSync,
  CommitRef,
  ConflictState,
  RawCommit,
  RawData,
} from "#git/snapshot";
import { parseStatus } from "#git/statusParser";
import { requireSupportedGit } from "#git/version";
import {
  indexStackMembership,
  readGhStacks,
  StackMembership,
} from "#github/ghStack";

/** Trunk candidates, most authoritative first, when `origin/HEAD` is not a symref. */
const TRUNK_CANDIDATES = [
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
];

/**
 * Branches the rebase machinery plants on fork points. They must live under
 * refs/heads for `rebase --update-refs` to track them, so they are filtered out
 * here instead — otherwise they would render as branch pills on the graph.
 */
const INTERNAL_BRANCH_PREFIX = "gsm-rebase/";

type RefRow = {
  refName: string;
  sha: string;
  symref: string;
  subject: string;
  authorDate: string;
  upstream: string;
  /** `%(upstream:track,nobracket)`: "ahead 2", "behind 1, ahead 3", "gone", or "". */
  track: string;
  /** Absolute path of the worktree that has this ref checked out, or "" for none. */
  worktreePath: string;
};

/**
 * One `for-each-ref` covering HEAD, local branches, and trunk candidates.
 *
 * `--include-root-refs` is what makes HEAD visible here. It is also why git 2.45 is
 * the floor: older git rejects the flag and fails the *whole* query, so the graph
 * would come back with no branch pills, no sync badges, and no detected trunk.
 * `requireSupportedGit` catches that as a version error before this runs.
 */
async function readRefs(
  git: GitRunner,
  trunkOverride?: string
): Promise<RefRow[]> {
  const patterns = [
    "HEAD",
    "refs/heads",
    "refs/remotes/origin/HEAD",
    ...TRUNK_CANDIDATES,
    ...(trunkOverride ? [toFullRef(trunkOverride)] : []),
  ];
  const format = [
    "%(refname)",
    "%(objectname)",
    "%(symref)",
    "%(contents:subject)",
    "%(authordate:iso-strict)",
    "%(upstream:short)",
    "%(upstream:track,nobracket)",
    "%(worktreepath)",
  ].join(FIELD_SEPARATOR);
  // Unmatched patterns are silently skipped, so listing candidates that do not
  // exist is free — no per-candidate probe needed.
  const output = await git.tryRun([
    "for-each-ref",
    "--include-root-refs",
    `--format=${format}`,
    ...patterns,
  ]);
  if (output === null) {
    return [];
  }
  return output
    .split("\n")
    .filter(Boolean)
    .map(line => {
      // Defaults rather than assertions: a row truncated mid-format yields empty
      // strings, and an empty `refName` fails every `refs/heads/` test below, so a
      // malformed row drops out instead of arriving as an `undefined` typed `string`.
      const [
        refName = "",
        sha = "",
        symref = "",
        subject = "",
        authorDate = "",
        upstream = "",
        track = "",
        worktreePath = "",
      ] = line.split(FIELD_SEPARATOR);
      return {
        refName,
        sha,
        symref,
        subject,
        authorDate,
        upstream,
        track,
        worktreePath,
      };
    });
}

/** Expand a user-supplied ref (`origin/main`, `main`) into candidate full refs. */
function toFullRef(ref: string): string {
  if (ref.startsWith("refs/")) {
    return ref;
  }
  return ref.includes("/") ? `refs/remotes/${ref}` : `refs/heads/${ref}`;
}

/**
 * Read the ahead/behind counts out of `%(upstream:track,nobracket)`, whose forms
 * are "", "gone", "ahead 3", "behind 1", or "ahead 3, behind 1".
 */
function parseTrack(name: string, upstream: string, track: string): BranchSync {
  const gone = track === "gone";
  const ahead = /ahead (\d+)/.exec(track)?.[1];
  const behind = /behind (\d+)/.exec(track)?.[1];
  return {
    name,
    upstream: upstream || null,
    ahead: ahead ? parseInt(ahead, 10) : 0,
    behind: behind ? parseInt(behind, 10) : 0,
    gone,
  };
}

/** Strip the ref namespace for display: refs/remotes/origin/main -> origin/main. */
function toShortRef(refName: string): string {
  return refName.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
}

function resolveTrunk(refs: RefRow[], trunkOverride?: string): RefRow | null {
  const byRefName = new Map(refs.map(ref => [ref.refName, ref]));
  if (trunkOverride) {
    return byRefName.get(toFullRef(trunkOverride)) ?? null;
  }

  // origin/HEAD is a symref to the default branch — follow it when present.
  const originHead = byRefName.get("refs/remotes/origin/HEAD");
  if (originHead?.symref) {
    const target = byRefName.get(originHead.symref);
    if (target) {
      return target;
    }
    // The symref points somewhere we did not request (a non-main default).
    // Report it from the symref itself; the tip metadata comes from origin/HEAD.
    return { ...originHead, refName: originHead.symref };
  }
  for (const candidate of TRUNK_CANDIDATES) {
    const ref = byRefName.get(candidate);
    if (ref) {
      return ref;
    }
  }
  return null;
}

type TrunkBranch = {
  name: string;
  /** How it compares to what it tracks, which for trunk is how far behind it has fallen. */
  sync: BranchSync;
};

/**
 * The local branch that reaches trunk, for the trunk row's Goto.
 *
 * Trunk is normally a remote ref, and `git switch origin/main` detaches HEAD rather
 * than putting you on main — so the row needs the local branch instead. A trunk that is
 * already a local ref is its own answer.
 *
 * Tracking identifies trunk only while exactly one branch tracks it. `git switch -c` off
 * a remote ref inherits that ref as upstream, so every feature branch cut from
 * `origin/main` also tracks `origin/main`; once a second one exists, tracking says
 * nothing about which branch is trunk. Taking the first tracker there picked whichever
 * branch sorted first — `dev/feature` ahead of `main` — so Goto on the `origin/main` row
 * checked out an unrelated feature branch. The name match handles that case, and it is
 * also what a fresh clone looks like before its first push.
 *
 * The branch's own sync comes back with it, because the trunk row is the only place that
 * can report it: a trunk branch left behind its remote has no local commits, so it never
 * reaches the graph as a row of its own.
 *
 * Whether another worktree holds the branch is not decided here: `heldBranches` answers that
 * for every branch, so the trunk row and the commit rows read the same map.
 *
 * Costs no extra git command; `%(upstream:short)` and `%(upstream:track)` already ride along
 * on every ref row.
 */
function resolveTrunkBranch(
  refs: RefRow[],
  trunk: RefRow | null
): TrunkBranch | null {
  if (!trunk) {
    return null;
  }
  const resolved = (ref: RefRow): TrunkBranch => ({
    name: toShortRef(ref.refName),
    sync: parseTrack(toShortRef(ref.refName), ref.upstream, ref.track),
  });
  if (trunk.refName.startsWith("refs/heads/")) {
    return resolved(trunk);
  }
  const trunkShort = toShortRef(trunk.refName);
  const locals = refs.filter(ref => ref.refName.startsWith("refs/heads/"));
  const tracking = locals.filter(ref => ref.upstream === trunkShort);
  if (tracking.length === 1) {
    return resolved(tracking[0]!);
  }
  const tail = trunkShort.split("/").slice(1).join("/");
  const named = locals.find(ref => toShortRef(ref.refName) === tail);
  return named ? resolved(named) : null;
}

type HeadState = {
  sha: string;
  branch: string | null;
};

async function readHead(git: GitRunner, refs: RefRow[]): Promise<HeadState> {
  const headRow = refs.find(ref => ref.refName === "HEAD");
  if (headRow) {
    return {
      sha: headRow.sha,
      branch: headRow.symref ? toShortRef(headRow.symref) : null,
    };
  }
  // An unborn HEAD points at a branch with no commit, so no ref row exists for it.
  const sha = (await git.tryRun(["rev-parse", "HEAD"])) ?? "";
  if (!sha) {
    return { sha: "", branch: null };
  }
  const branch = await git.tryRun(["symbolic-ref", "--short", "-q", "HEAD"]);
  return { sha, branch: branch || null };
}

const COMMIT_FORMAT =
  ["%H", "%P", "%an", "%ae", "%aI", "%s", "%B"].join(FIELD_SEPARATOR) +
  RECORD_SEPARATOR;

type BoundaryWalk = {
  commits: RawCommit[];
  /** Fork bases, keyed by sha — the boundary rows of the same walk. */
  boundaries: Map<string, CommitRef>;
};

/**
 * Walk local-only history. `--boundary` appends the excluded parents (the fork
 * bases) to the same output, so their subject and date need no follow-up call.
 * `%m` marks each row: ">" for a commit in the range, "-" for a boundary.
 */
async function walkLocalCommits(
  git: GitRunner,
  trunkRef: string | null,
  branchesAtSha: Map<string, string[]>,
  syncsAtSha: Map<string, BranchSync[]>
): Promise<BoundaryWalk> {
  // --author-date-order, not --topo-order: both keep parents after children, but
  // topo order tiebreaks siblings by committer date. A reword rebuilds the commit
  // with commit-tree, which preserves the author date yet stamps a fresh committer
  // date of "now" — under topo order that floats the edited branch above siblings
  // it forked alongside. Author date is preserved across the rewrite, so siblings
  // keep their relative order.
  const output = await git.tryRun([
    "log",
    "--author-date-order",
    "--boundary",
    `--format=%m${FIELD_SEPARATOR}${COMMIT_FORMAT}`,
    "--branches",
    "HEAD",
    ...(trunkRef ? ["--not", trunkRef] : []),
  ]);

  const commits: RawCommit[] = [];
  const boundaries = new Map<string, CommitRef>();
  if (output === null) {
    return { commits, boundaries };
  }

  for (const record of output.split(RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\n/, "");
    if (!trimmed.trim()) {
      continue;
    }
    const [
      marker,
      sha = "",
      parents = "",
      authorName = "",
      authorEmail = "",
      authorDate = "",
      subject = "",
      body,
    ] = trimmed.split(FIELD_SEPARATOR);
    // Every map downstream keys on the sha, so a record that lost it is unusable.
    if (!sha) {
      continue;
    }
    if (marker === "-") {
      boundaries.set(sha, { sha, subject, authorDate });
      continue;
    }
    commits.push({
      sha,
      parents: parents ? parents.split(" ") : [],
      authorName,
      authorEmail,
      authorDate,
      subject,
      body: (body ?? "").replace(/\n+$/, ""),
      branches: branchesAtSha.get(sha) ?? [],
      branchSyncs: syncsAtSha.get(sha) ?? [],
    });
  }
  return { commits, boundaries };
}

/**
 * Locate each fork base relative to trunk with one command per base.
 * `rev-list --left-right --count base...trunk` yields "ahead<TAB>behind":
 * a zero ahead-count means the base is an ancestor of trunk, and the
 * behind-count is the distance to the tip. That single number pair replaces
 * the `merge-base --is-ancestor` + `rev-list --count` pair per base.
 */
async function describeBases(
  git: GitRunner,
  commits: RawCommit[],
  boundaries: Map<string, CommitRef>,
  trunkRef: string | null
): Promise<BaseInfo[]> {
  const localShas = new Set(commits.map(commit => commit.sha));
  const baseShas = new Set<string>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (!localShas.has(parent)) {
        baseShas.add(parent);
      }
    }
  }

  return Promise.all(
    [...baseShas].map(async sha => {
      const known = boundaries.get(sha);
      // A boundary row covers every base of a normal walk. Fall back only when
      // the walk was skipped (no trunk) and the base never appeared.
      const meta = known ?? (await readCommitRef(git, sha));
      if (!trunkRef) {
        return { ...meta, onTrunk: false, distanceToTrunkTip: -1 };
      }
      const counts = await git.tryRun([
        "rev-list",
        "--left-right",
        "--count",
        `${sha}...${trunkRef}`,
      ]);
      if (counts === null) {
        return { ...meta, onTrunk: false, distanceToTrunkTip: -1 };
      }
      // `-1` is this function's own "unknown", the same value the two failure paths
      // above return, so a short count reads as an unlocatable base rather than a
      // base at distance zero.
      const [ahead = -1, behind = -1] = counts
        .split(/\s+/)
        .map(value => parseInt(value, 10));
      const onTrunk = ahead === 0;
      return { ...meta, onTrunk, distanceToTrunkTip: onTrunk ? behind : -1 };
    })
  );
}

async function readCommitRef(git: GitRunner, sha: string): Promise<CommitRef> {
  const output = await git.tryRun([
    "show",
    "-s",
    `--format=%s${FIELD_SEPARATOR}%aI`,
    sha,
  ]);
  const [subject, authorDate] = (output ?? "").split(FIELD_SEPARATOR);
  return { sha, subject: subject ?? "", authorDate: authorDate ?? "" };
}

/**
 * Describe an interrupted rebase. Only called when `status` reported unmerged
 * entries, so the clean case costs nothing.
 *
 * The rebase state lives in files under the `rebase-merge` directory rather
 * than in any queryable ref, so this reads them directly. `git rev-parse
 * --git-path` resolves the directory correctly inside a linked worktree, where
 * it is not `.git/rebase-merge`.
 */
async function readConflictState(
  git: GitRunner,
  unmergedFiles: string[]
): Promise<ConflictState | null> {
  const stateDirectory = await git.tryRun([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "rebase-merge",
  ]);
  // Unmerged files with no rebase in flight means a plain `git merge` conflict,
  // which this extension does not drive.
  if (!stateDirectory || !existsSync(stateDirectory)) {
    return null;
  }

  const readState = (name: string): string | null => {
    try {
      return readFileSync(join(stateDirectory, name), "utf8").trim();
    } catch {
      return null;
    }
  };
  const headName = readState("head-name");
  return {
    branch:
      headName && headName !== "detached HEAD" ? toShortRef(headName) : null,
    unmergedFiles,
    step: parseInt(readState("msgnum") ?? "0", 10) || 0,
    totalSteps: parseInt(readState("end") ?? "0", 10) || 0,
  };
}

export async function readRawData(
  git: GitRunner,
  trunkOverride?: string
): Promise<RawData> {
  // Independent reads run concurrently; each is one process either way. The version
  // check joins them rather than gating them, so it costs no round trip — and when it
  // does reject, its message wins over the empty ref read an old git would produce.
  const [, repoRoot, userEmail, refs, statusOutput, gitDirectory] =
    await Promise.all([
      requireSupportedGit(git),
      git.run(["rev-parse", "--show-toplevel"]),
      git.tryRun(["config", "user.email"]).then(email => email ?? ""),
      readRefs(git, trunkOverride),
      git
        .tryRun(["status", "--porcelain=v2", "--branch", "-z"])
        .then(output => output ?? ""),
      // `gh stack` keeps its state in the common git directory, so a linked
      // worktree still sees the repository's stacks.
      git.tryRun(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);

  const status = parseStatus(statusOutput);
  const trunk = resolveTrunk(refs, trunkOverride);
  const trunkRef = trunk ? toShortRef(trunk.refName) : null;
  const trunkTip = trunk
    ? { sha: trunk.sha, subject: trunk.subject, authorDate: trunk.authorDate }
    : null;
  const trunkBranch = resolveTrunkBranch(refs, trunk);

  const head = status.headSha
    ? { sha: status.headSha, branch: status.headBranch }
    : await readHead(git, refs);

  const branchesAtSha = new Map<string, string[]>();
  const syncsAtSha = new Map<string, BranchSync[]>();
  const heldBranches = new Map<string, string>();
  for (const ref of refs) {
    if (!ref.refName.startsWith("refs/heads/")) {
      continue;
    }
    const branch = toShortRef(ref.refName);
    if (branch.startsWith(INTERNAL_BRANCH_PREFIX)) {
      continue;
    }
    // A branch checked out here is reachable by definition; only another worktree blocks it.
    if (ref.worktreePath && ref.worktreePath !== repoRoot) {
      heldBranches.set(branch, ref.worktreePath);
    }
    const names = branchesAtSha.get(ref.sha);
    if (names) {
      names.push(branch);
    } else {
      branchesAtSha.set(ref.sha, [branch]);
    }
    const sync = parseTrack(branch, ref.upstream, ref.track);
    const syncs = syncsAtSha.get(ref.sha);
    if (syncs) {
      syncs.push(sync);
    } else {
      syncsAtSha.set(ref.sha, [sync]);
    }
  }

  // Reading `.git/gh-stack` is a file read, not a subprocess, so stack badges
  // cost nothing per refresh.
  const shaOfBranch = new Map<string, string>();
  for (const ref of refs) {
    if (ref.refName.startsWith("refs/heads/")) {
      shaOfBranch.set(toShortRef(ref.refName), ref.sha);
    }
  }
  const stackMembership = gitDirectory
    ? indexStackMembership(readGhStacks(gitDirectory), shaOfBranch)
    : new Map<string, StackMembership>();

  // Everything the repository-wide reads answer, which an empty repository has as much of
  // as any other. Only the history walk below distinguishes the two.
  const common = {
    repoRoot,
    stackMembership,
    repoName: repoRoot.split("/").filter(Boolean).pop() ?? repoRoot,
    userEmail,
    trunkRef,
    trunkTip,
    trunkBranch: trunkBranch?.name ?? null,
    heldBranches,
    trunkBranchSync: trunkBranch?.sync ?? null,
    headBranch: head.branch,
    uncommitted: status.uncommitted,
  };
  if (!head.sha) {
    return { ...common, headSha: "", commits: [], bases: [], conflict: null };
  }

  const { commits, boundaries } = await walkLocalCommits(
    git,
    trunkRef,
    branchesAtSha,
    syncsAtSha
  );
  const [bases, conflict] = await Promise.all([
    describeBases(git, commits, boundaries, trunkRef),
    status.hasUnmerged
      ? readConflictState(
          git,
          status.uncommitted
            .filter(file => file.status === "U")
            .map(file => file.path)
        )
      : Promise.resolve(null),
  ]);

  return { ...common, headSha: head.sha, commits, bases, conflict };
}
