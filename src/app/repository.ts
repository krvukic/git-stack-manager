/**
 * Repository — the operations the UI can perform, over one working copy.
 * Pure Node, no vscode imports, so the extension and the web server share it.
 */
import {
  imageMediaType,
  ImagePreview,
  PREVIEW_BYTE_LIMIT,
  toDataUri,
} from "#core/media";
import { uniqueSorted } from "#core/values";
import { CommitDiff, readCommitDiff, readWorkingCopyDiff } from "#git/diff";
import { readRawData } from "#git/reader";
import { GitError, GitRunner } from "#git/runner";
import { FileChange, RawData } from "#git/snapshot";
import { runGh } from "#github/ghRunner";
import {
  ghStackArguments,
  GhStackCommand,
  GhStackInfo,
  indexStackMembership,
  readGhStacks,
  StackMembership,
  stacksHolding,
} from "#github/ghStack";
import { PullRequestService } from "#github/pullRequests";
import { submitBranch, SubmitOutcome, submitStack } from "#github/submit";
import {
  AbsorbPlan,
  AbsorbResult,
  applyAbsorb,
  planAbsorb,
} from "#history/absorb";
import { AdoptOutcome, adoptRemoteStack } from "#history/adoptRemote";
import {
  amendPathsInto,
  AmendResult,
  commitPaths,
  CommitResult,
} from "#history/commit";
import { BranchDeletion, deleteBranch } from "#history/deleteBranch";
import { discardPaths, DiscardResult } from "#history/discard";
import { foldIntoParent, FoldResult } from "#history/fold";
import {
  describeWorkingFiles,
  LineSelection,
  WorkingFileDiff,
} from "#history/partialSelection";
import { deleteMergedBranches, MergedDeletion } from "#history/pruneMerged";
import {
  abortRebase,
  continueRebase,
  launchMergeTool,
  planRebase,
  RebaseDestination,
  RebaseOutcome,
  requireCleanWorkingCopy,
  resolveDestination,
  runRebase,
} from "#history/rebase";
import { rewordCommit, RewordResult } from "#history/rewrite";
import {
  previewSplit,
  splitCommit,
  SplitPreview,
  SplitResult,
} from "#history/split";
import { UndoHistory } from "#history/undo";

export type PullOutcome = {
  branch: string;
  upstream: string;
  /** Commits fast-forwarded in; zero when the branch was already current. */
  commits: number;
};

export type GotoTrunkOutcome = {
  /** Local branch checked out, which is what HEAD ends up on. */
  branch: string;
  trunkRef: string;
  /** Commits the branch moved forward to reach the ref; zero when it was already there. */
  advanced: number;
};

/**
 * Name the files a refusal is about, up to two, then count the rest.
 *
 * A refusal that names nothing sends the reader to `git status` to find out which file
 * it meant; naming all forty fills the toast. Two plus a count fits either way.
 */
function describeFiles(files: FileChange[]): string {
  const named = files.slice(0, 2).map(file => file.path);
  const rest = files.length - named.length;
  return rest ? `${named.join(", ")} and ${rest} more` : named.join(", ");
}

/**
 * Two sides of one image as `data:` URIs, from whichever bytes the caller found.
 *
 * Refuses rather than returning an empty preview, because the reader needs each reason: a
 * format nothing here draws, or bytes too large to send inline. The overlay prints
 * the refusal where the picture would have gone. A missing side is not a refusal — an addition
 * has no before, a deletion no after — and travels as null.
 *
 * Shared by the commit and working-copy readers, which differ only in where the bytes come from.
 */
function buildImagePreview(
  path: string,
  before: Buffer | null,
  after: Buffer | null
): ImagePreview {
  const mediaType = imageMediaType(path);
  if (!mediaType) {
    throw new GitError(
      `No preview for ${path} — open it in an editor instead.`,
      "preview"
    );
  }
  const oversized = [before, after].find(
    blob => blob !== null && blob.length > PREVIEW_BYTE_LIMIT
  );
  if (oversized) {
    throw new GitError(
      `${path} is ${Math.round(oversized.length / 1024)} KB — too large to preview. Open it in an editor instead.`,
      "preview"
    );
  }
  return {
    mediaType,
    before: before && {
      dataUri: toDataUri(mediaType, before),
      bytes: before.length,
    },
    after: after && {
      dataUri: toDataUri(mediaType, after),
      bytes: after.length,
    },
  };
}

export class Repository {
  readonly git: GitRunner;
  readonly pullRequests: PullRequestService;
  readonly undoHistory: UndoHistory;

  constructor(
    cwd: string,
    private readonly trunkOverride?: string,
    pullRequestReporting?: {
      /** Where a pull request fetch's duration and outcome go. See `PullRequestService`. */
      log?: (line: string) => void;
      /** How many of a pull request fetch's branches are answered, and the total. */
      progress?: (done: number, total: number) => void;
    }
  ) {
    this.git = new GitRunner(cwd);
    this.pullRequests = new PullRequestService(
      cwd,
      pullRequestReporting?.log,
      pullRequestReporting?.progress
    );
    this.undoHistory = new UndoHistory(this.git);
  }

  /**
   * Run a history edit with an undo checkpoint around it. The checkpoint is
   * dropped when the edit throws, so the undo stack only ever offers to reverse
   * changes that actually landed.
   */
  async undoable<T>(label: string, run: () => Promise<T>): Promise<T> {
    const checkpoint = await this.undoHistory.capture(label);
    const value = await run();
    // Sealed only on success, and only when refs actually moved, so Undo never
    // offers to reverse a failed or no-op action.
    await this.undoHistory.seal(checkpoint);
    return value;
  }

  read(): Promise<RawData> {
    return readRawData(this.git, this.trunkOverride);
  }

  async filesForCommit(sha: string): Promise<FileChange[]> {
    const output = await this.git.run([
      "show",
      "--name-status",
      "--format=",
      "-z",
      sha,
    ]);
    const parts = output.split("\0").filter(Boolean);
    const files: FileChange[] = [];
    for (let index = 0; index < parts.length; index++) {
      const status = parts[index] ?? "";
      const letter = status[0] ?? "";
      // A rename or copy carries a similarity score and two paths.
      if (/^[RC]\d*$/.test(status)) {
        const oldPath = parts[++index] ?? "";
        files.push({ status: letter, oldPath, path: parts[++index] ?? "" });
      } else {
        files.push({ status: letter, path: parts[++index] ?? "" });
      }
    }
    return files;
  }

  async showFile(sha: string, path: string): Promise<string> {
    return this.git.run(["show", `${sha}:${path}`]);
  }

  /**
   * A file's bytes at a ref, or null when that ref has no such file.
   *
   * Bytes rather than the decoded string `showFile` returns, because an image survives
   * neither UTF-8 decoding nor the replacement characters it leaves behind. Absence is a
   * normal answer: the caller asks both sides of a diff without first working out which
   * side an addition or a deletion is missing.
   */
  showFileBytes(ref: string, path: string): Promise<Buffer | null> {
    return this.git.tryRunBinary(["show", `${ref}:${path}`]);
  }

  /**
   * Both versions of an image in a commit, as `data:` URIs the viewer can draw.
   *
   * A rename's `before` is read under the old path, or the read would look for a file that
   * did not exist under this name yet and the preview would show the addition of something
   * that merely moved. `buildImagePreview` owns the two refusals.
   */
  async imagePreview(
    sha: string,
    path: string,
    oldPath?: string
  ): Promise<ImagePreview> {
    const [before, after] = await Promise.all([
      this.showFileBytes(`${sha}^`, oldPath ?? path),
      this.showFileBytes(sha, path),
    ]);
    return buildImagePreview(path, before, after);
  }

  /**
   * Both versions of an image whose change is not committed: HEAD's on the left, the bytes on
   * disk on the right.
   *
   * The right-hand side is read from the working tree, which is the whole difference from
   * `imagePreview` — an uncommitted change has no blob for `git show` to name. Either side can
   * be absent, as above: an untracked image has no version in HEAD, a deleted one has no file.
   */
  async workingCopyImagePreview(
    path: string,
    oldPath?: string
  ): Promise<ImagePreview> {
    const [before, after] = await Promise.all([
      this.showFileBytes("HEAD", oldPath ?? path),
      this.git.readWorktreeFile(path),
    ]);
    return buildImagePreview(path, before, after);
  }

  /**
   * Every change in a commit, as parsed hunks.
   *
   * One read serves the whole-commit changes overlay and the per-file diff, which is why
   * it is not scoped to a path: the overlay needs all files, and a second call per file
   * would be a process each.
   */
  diffForCommit(sha: string): Promise<CommitDiff> {
    return readCommitDiff(this.git, sha);
  }

  /**
   * Every uncommitted change, as parsed hunks, or one row's worth when `path` names one.
   *
   * Scoped where `diffForCommit` is not, because the two cost differently: a commit is one
   * `git show` however many files it holds, while each untracked file here is a read of its own.
   */
  async diffForWorkingCopy(
    path?: string
  ): Promise<{ files: WorkingFileDiff[] }> {
    const diff = await readWorkingCopyDiff(this.git, path ? [path] : []);
    return { files: describeWorkingFiles(diff.files) };
  }

  /**
   * The current fingerprint of each path whose lines can be chosen, so the webview can drop a
   * line selection once its file changes on disk. A path left out of the answer no longer has a
   * diff whose lines can be chosen.
   *
   * Scoped to the paths asked about, which are the few with lines left out, so the poll that
   * asks costs a diff of those files and not of the whole working copy.
   */
  async workingCopyFingerprints(
    paths: string[]
  ): Promise<Record<string, string>> {
    if (!paths.length) {
      return {};
    }
    const diff = await readWorkingCopyDiff(this.git, paths);
    const fingerprints: Record<string, string> = {};
    for (const file of describeWorkingFiles(diff.files)) {
      if (!file.wholeFileReason) {
        fingerprints[file.path] = file.fingerprint;
      }
    }
    return fingerprints;
  }

  async checkout(ref: string, detach = false): Promise<void> {
    await this.git.run(detach ? ["switch", "--detach", ref] : ["switch", ref]);
  }

  /**
   * Land on the commit the trunk row draws, which takes two commands rather than a checkout.
   *
   * The row draws a remote ref, and `git switch origin/main` detaches HEAD, so only the
   * local branch behind it can be checked out. That branch alone is not the destination: a
   * repository fetched but never pulled leaves `main` a few commits below `origin/main`, so
   * Goto on the `origin/main` row landed three rows down and put "You are here" on a commit
   * the row never named. The fast-forward is what makes the row and the destination one
   * commit.
   *
   * Only a branch that is purely behind moves. One with commits of its own already has a
   * row of its own to Goto, and `--ff-only` would refuse there anyway; one whose upstream is
   * gone has nothing left to measure against. Neither case needs a message — the checkout is
   * the whole of what the row offered.
   *
   * This method re-reads the snapshot rather than taking it from the click, because the ref to
   * fast-forward onto determines where HEAD ends up, and the webview's copy can be a poll old.
   */
  async gotoTrunk(): Promise<GotoTrunkOutcome> {
    const snapshot = await this.read();
    const branch = snapshot.trunkBranch;
    if (!branch || !snapshot.trunkRef) {
      throw new GitError(
        "No local branch reaches trunk, so Goto has no branch to check out. Create one from the remote ref first.",
        "goto trunk"
      );
    }
    await this.git.run(["switch", branch]);
    const sync = snapshot.trunkBranchSync;
    const behind = sync && !sync.gone && !sync.ahead ? sync.behind : 0;
    if (behind) {
      await this.git.run(["merge", "--ff-only", snapshot.trunkRef]);
    }
    return { branch, trunkRef: snapshot.trunkRef, advanced: behind };
  }

  /**
   * Fast-forward the checked-out branch to its upstream.
   *
   * `--ff-only`, never a merge or a rebase: this button exists to collect work that
   * already happened elsewhere, and a merge commit or a silent rebase of local commits
   * is a history decision the user did not ask for. When the branch has diverged, git
   * refuses and changes nothing — the message says to rebase, which the tree already
   * does properly, carrying every branch in the stack.
   *
   * The refusals are checked here rather than left to git so they read as sentences
   * about the repository instead of porcelain hints, and because the dirty-tree case
   * is the one git reports late — after deciding it would need to overwrite a file.
   *
   * Only *tracked* changes refuse. A single untracked file used to block the button
   * outright — one scratch note in the working copy and a branch 42 commits behind
   * stayed behind, with a message about overwriting changes that git would never have
   * touched. An untracked file is only ever in the way when an incoming commit adds
   * that same path, which `merge --ff-only` reports itself, naming the file.
   */
  async pull(): Promise<PullOutcome> {
    const snapshot = await this.read();
    if (!snapshot.headBranch) {
      throw new GitError(
        "HEAD is detached, so Pull has no branch to fast-forward. Goto a branch first.",
        "pull"
      );
    }
    const sync = snapshot.commits
      .flatMap(commit => commit.branchSyncs)
      .find(candidate => candidate.name === snapshot.headBranch);
    // A branch whose tip is trunk itself has no local commits, so it never appears in
    // the walk above; its upstream still has to be checked, hence the ref read here.
    const upstream =
      sync?.upstream ??
      (await this.git.tryRun([
        "rev-parse",
        "--abbrev-ref",
        `${snapshot.headBranch}@{upstream}`,
      ]));
    if (!upstream) {
      throw new GitError(
        `"${snapshot.headBranch}" tracks no remote branch, so Pull has nothing to fetch. Submit it first.`,
        "pull"
      );
    }
    const dirty = snapshot.uncommitted.filter(file => file.status !== "?");
    if (dirty.length) {
      throw new GitError(
        `Commit, amend, or absorb your changes before pulling — a fast-forward would overwrite them (${describeFiles(dirty)}).`,
        "pull"
      );
    }

    // `split` on a non-empty string always yields a first field, so the fallback is
    // unreachable; it stands in for the check the compiler cannot derive.
    const remote = upstream.split("/")[0] ?? upstream;
    await this.git.run(["fetch", remote]);
    // Read the counts after fetching: before it, "behind" is whatever the last fetch
    // left behind and an up-to-date branch would look like it had work waiting.
    const counts = await this.git.tryRun([
      "rev-list",
      "--left-right",
      "--count",
      `${snapshot.headBranch}...${upstream}`,
    ]);
    const [ahead, behind] = (counts ?? "0\t0")
      .split(/\s+/)
      .map(value => parseInt(value, 10) || 0);
    if (ahead && behind) {
      throw new GitError(
        `"${snapshot.headBranch}" and ${upstream} have both moved (${ahead} local, ${behind} remote), so it cannot fast-forward. Rebase onto trunk instead — that carries the whole stack.`,
        "pull"
      );
    }
    if (!behind) {
      return { branch: snapshot.headBranch, upstream, commits: 0 };
    }
    await this.git.run(["merge", "--ff-only", upstream]);
    return { branch: snapshot.headBranch, upstream, commits: behind };
  }

  /**
   * Rewrite a commit's message without touching the working tree. Reuses the
   * snapshot the caller already read instead of walking history again.
   */
  reword(
    snapshot: RawData,
    sha: string,
    message: string
  ): Promise<RewordResult> {
    return rewordCommit(this.git, snapshot, sha, message);
  }

  /** Fold every working-copy change into HEAD, keeping its message. */
  async amendChangesIntoHead(): Promise<void> {
    await this.git.run(["add", "-A"]);
    await this.git.run(["commit", "--amend", "--no-edit"]);
  }

  /**
   * Commit the selected working-copy paths as a new commit on top of HEAD. `lines` names the
   * lines left out of the partly chosen files, which stay uncommitted.
   */
  async commit(
    paths: string[],
    message: string,
    lines: LineSelection[] = []
  ): Promise<CommitResult> {
    return commitPaths(this.git, await this.read(), { paths, lines, message });
  }

  /**
   * Fold the selected paths into an existing commit, keeping its message.
   *
   * `targetSha` defaults to HEAD. Anything deeper in the stack is rewritten with
   * its descendants re-parented, which is why this reads a fresh snapshot: the
   * rewrite needs the current shas of every commit above the target.
   */
  async amendInto(
    paths: string[],
    targetSha?: string,
    lines: LineSelection[] = []
  ): Promise<AmendResult> {
    return amendPathsInto(this.git, await this.read(), {
      paths,
      lines,
      ...(targetSha === undefined ? {} : { targetSha }),
    });
  }

  /**
   * Throw the selected paths' changes away, keeping every other change.
   *
   * A fresh snapshot, because it is what the refusals are checked against and the panel's copy
   * can be five seconds old on the browser host. A rename is the case that needs it: the pair
   * of paths comes from the snapshot, and reading a stale one would restore the wrong half.
   */
  async discard(paths: string[]): Promise<DiscardResult> {
    return discardPaths(this.git, await this.read(), paths);
  }

  /**
   * Fetch the remote holding trunk and return a snapshot taken afterwards, so
   * a rebase lands on current upstream work. A local trunk needs no fetch, and
   * then the snapshot passed in is already current.
   */
  private async fetchTrunk(snapshot: RawData): Promise<RawData> {
    if (!snapshot.trunkRef?.includes("/")) {
      return snapshot;
    }
    const remote = snapshot.trunkRef.split("/")[0] ?? snapshot.trunkRef;
    await this.git.run(["fetch", remote]);
    return this.read();
  }

  /**
   * The `gh stack` record and the commit each local branch points at.
   *
   * A full read walks the history a rebase just rewrote. Re-recording the bases needs none of it,
   * so this costs two git commands and a file read — the budget for a check that runs after every
   * rebase.
   */
  private async readStackState(): Promise<{
    stacks: GhStackInfo[];
    membership: Map<string, StackMembership>;
  }> {
    const [gitDirectory, refs] = await Promise.all([
      // The common directory, so a linked worktree sees the repository's stacks.
      this.git.tryRun([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      this.git.run([
        "for-each-ref",
        "--format=%(refname:short) %(objectname)",
        "refs/heads",
      ]),
    ]);
    const shaOfBranch = new Map<string, string>();
    for (const line of refs.split("\n").filter(Boolean)) {
      const [branch, sha] = line.split(" ");
      if (branch && sha) {
        shaOfBranch.set(branch, sha);
      }
    }
    const stacks = gitDirectory ? readGhStacks(gitDirectory) : [];
    return { stacks, membership: indexStackMembership(stacks, shaOfBranch) };
  }

  /**
   * Bring the `gh stack` record of every stack this rebase moved back in line with where its
   * branches now sit.
   *
   * A rebase with `--update-refs` moves each layer and leaves `.git/gh-stack` naming the commits
   * it replaced, with nothing on screen to show it. The graph then drew "needs rebase" on the
   * stack just rebased, and `gh stack submit` would have opened its pull requests against
   * abandoned shas. `gh stack rebase <bottom> --no-trunk` replays each layer onto the one below —
   * already where the rebase put them — and writes the new bases.
   *
   * This reports a failure rather than throwing one. The commits have already moved, so turning a
   * finished rebase into an error would tell the reader the opposite of what happened. `gh stack`
   * exits 0 even when it prints `✗` and rebases nothing, so the verdict comes from re-reading the
   * record rather than from the exit status.
   */
  private async recordStackBases(
    outcome: RebaseOutcome
  ): Promise<RebaseOutcome> {
    if (outcome.conflict || !outcome.moved.length) {
      return outcome;
    }
    // A rebase never writes the record, so it still names the same stacks it did before the
    // commits moved.
    const stacks = stacksHolding(
      (await this.readStackState()).stacks,
      outcome.moved
    );
    if (!stacks.length) {
      return outcome;
    }
    const bottoms: string[] = [];
    for (const stack of stacks) {
      const bottom = stack.branches[0]?.branch;
      if (!bottom) {
        continue;
      }
      bottoms.push(bottom);
      try {
        await runGh(
          this.git,
          ghStackArguments({
            kind: "rebase",
            scope: "all",
            branch: bottom,
            noTrunk: true,
          })
        );
      } catch {
        // Nothing to do here: the check below reports every stack still stale, whether `gh`
        // failed outright or printed a cross and carried on.
      }
    }
    // The bottom layer counts like any other. `gh stack` records its base as the tip of the trunk
    // *branch* rather than the commit the layer sits on, and `indexStackMembership` compares
    // against that same value, so a stack rebased past a trailing local `main` reads clean.
    const after = await this.readStackState();
    const staleStacks = stacksHolding(after.stacks, bottoms)
      .filter(stack =>
        stack.branches.some(
          entry => after.membership.get(entry.branch)?.recordedBaseStale
        )
      )
      .flatMap(stack => (stack.branches[0] ? [stack.branches[0].branch] : []));
    return staleStacks.length ? { ...outcome, staleStacks } : outcome;
  }

  /**
   * Move `sha` and its descendants onto `destination`.
   *
   * Returns `conflict: true` with git's rebase state intact when a step stops,
   * so the caller can offer resolve / continue / abort.
   */
  async rebase(
    sha: string,
    destination: RebaseDestination
  ): Promise<RebaseOutcome> {
    let snapshot = await this.read();
    // Only a trunk landing needs upstream refreshed; the other destinations are
    // commits already in this snapshot.
    if (destination.kind === "trunk") {
      snapshot = await this.fetchTrunk(snapshot);
    }
    const destinationSha = resolveDestination(snapshot, sha, destination);
    const plan = planRebase(snapshot, sha, destinationSha);
    const outcome = await runRebase(this.git, snapshot, plan);
    return this.recordStackBases(outcome);
  }

  /**
   * Rebase every local stack onto the current trunk tip — the bulk form of
   * `rebase`, applied to each stack bottom in turn.
   */
  async restackAll(): Promise<RebaseOutcome> {
    // Check the working copy before fetching: a dirty tree blocks every rebase
    // below, so reporting it up front beats a network round trip first.
    const initial = await this.read();
    requireCleanWorkingCopy(initial, "restack");
    const snapshot = await this.fetchTrunk(initial);
    if (!snapshot.trunkTip) {
      throw new GitError("No trunk detected — cannot restack.", "restack");
    }
    const trunkTip = snapshot.trunkTip.sha;

    // Stack bottoms are the local commits whose parent is not local. Rebasing a
    // bottom carries its whole stack, so these are the only roots needed.
    const localShas = new Set(snapshot.commits.map(commit => commit.sha));
    const bottoms = snapshot.commits.filter(
      commit =>
        !commit.parents.some(parent => localShas.has(parent)) &&
        commit.parents[0] !== trunkTip
    );
    if (!bottoms.length) {
      return { moved: [], conflict: false };
    }

    const moved: string[] = [];
    let current = snapshot;
    for (const [index, bottom] of bottoms.entries()) {
      // Each rebase rewrites shas, so every stack after the first needs a fresh
      // snapshot; the first reuses the one taken above.
      if (index > 0) {
        current = await this.read();
      }
      if (!current.commits.some(commit => commit.sha === bottom.sha)) {
        continue;
      }
      const plan = planRebase(current, bottom.sha, trunkTip);
      const outcome = await runRebase(this.git, current, plan);
      moved.push(...outcome.moved);
      if (outcome.conflict) {
        return { moved: uniqueSorted(moved), conflict: true };
      }
    }
    return this.recordStackBases({
      moved: uniqueSorted(moved),
      conflict: false,
    });
  }

  /**
   * Move every layer of the stack that holds `branch` onto the commit that its remote holds.
   *
   * The layers come from the `gh stack` record rather than from the graph that the tree drew. The
   * record names the stack that GitHub restacked, and `buildModel` draws no row beside the others
   * for a layer whose local branch was left behind two rebases ago.
   *
   * Re-records the bases afterwards for the same reason that a rebase does: every layer now
   * points at the commit that its remote parent holds, so the record names a replaced base for
   * every layer.
   */
  async adoptRemoteStack(branch: string): Promise<AdoptOutcome> {
    const snapshot = await this.read();
    const stack = stacksHolding((await this.readStackState()).stacks, [
      branch,
    ])[0];
    if (!stack) {
      throw new GitError(
        `${branch} belongs to no gh stack, so this action finds no layers to move.`,
        "adopt remote"
      );
    }
    const branches = stack.branches.map(entry => entry.branch);
    // Only the checked-out layer's files move, so only that layer can catch an edit mid-move. An
    // untracked file never blocks the move, because nothing here writes a path that git does not
    // track.
    const dirty = snapshot.uncommitted.filter(file => file.status !== "?");
    if (
      dirty.length &&
      snapshot.headBranch &&
      branches.includes(snapshot.headBranch)
    ) {
      throw new GitError(
        `Commit, amend, or stash your changes before moving the stack — ${snapshot.headBranch} is checked out, and its files move with it (${describeFiles(dirty)}).`,
        "adopt remote"
      );
    }
    const outcome = await adoptRemoteStack(
      this.git,
      branches,
      snapshot.trunkRef,
      snapshot.headBranch
    );
    const recorded = await this.recordStackBases({
      moved: outcome.moved,
      conflict: false,
    });
    return recorded.staleStacks
      ? { ...outcome, staleStacks: recorded.staleStacks }
      : outcome;
  }

  /**
   * Check out the layer a scoped rebase starts from.
   *
   * `gh stack rebase --upstack lower` takes its starting layer from the *checked-out* branch; the
   * branch on the command line only selects the stack. Run with HEAD on the top layer, it printed
   * `starting from upper to upper`, counted every upstack branch as rebased, and left the middle
   * layer on the commit the bottom one had abandoned — a wrong result with no error. Checking the
   * layer out first makes the menu label and the outcome agree.
   *
   * HEAD stays on that layer afterwards, as it does after any `gh stack rebase`.
   */
  private async checkoutRebasePivot(command: GhStackCommand): Promise<void> {
    if (
      command.kind !== "rebase" ||
      command.scope === "all" ||
      !command.branch
    ) {
      return;
    }
    const snapshot = await this.read();
    if (snapshot.headBranch === command.branch) {
      return;
    }
    requireCleanWorkingCopy(snapshot, `gh stack rebase --${command.scope}`);
    await this.git.run(["switch", command.branch]);
  }

  /**
   * Delegate to the `gh stack` extension. It owns the server-side stack object
   * and force-pushes with --force-with-lease, so reimplementing submit/sync here
   * would only drift from GitHub's own view of the stack.
   */
  async runGhStack(command: GhStackCommand): Promise<string> {
    await this.checkoutRebasePivot(command);
    return runGh(this.git, ghStackArguments(command));
  }

  /**
   * Push one branch and make its pull request match the commit message.
   *
   * Reads a fresh snapshot rather than taking one from the caller: the base branch
   * is derived from the current stack shape, and submitting straight after an
   * amend or a rebase would otherwise compute it from pre-rewrite shas.
   */
  async submit(
    branch: string,
    options: { draft?: boolean } = {}
  ): Promise<SubmitOutcome> {
    const outcome = await submitBranch(
      this.git,
      await this.read(),
      branch,
      options
    );
    this.rememberSubmitted(outcome);
    return outcome;
  }

  /** Submit every branch from the bottom of the stack up to `branch`, bottom first. */
  async submitStack(
    branch: string,
    options: { draft?: boolean } = {}
  ): Promise<SubmitOutcome[]> {
    const outcomes = await submitStack(
      this.git,
      await this.read(),
      branch,
      options
    );
    outcomes.forEach(outcome => this.rememberSubmitted(outcome));
    return outcomes;
  }

  /**
   * Badges come from a search query, and GitHub indexes a pull request opened seconds ago
   * asynchronously — so the refresh the UI fires next can miss what a submit just opened,
   * and the button goes on offering to open it. Submit's own reads bypass the index, so
   * hand that answer straight to the cache. Checks and review decision stay empty rather
   * than being carried over from the previous read: the push moved the head commit, so
   * what was known about the old one no longer describes this pull request.
   */
  private rememberSubmitted(outcome: SubmitOutcome): void {
    const { branch } = outcome;
    if (outcome.number) {
      this.pullRequests.remember(branch, {
        number: outcome.number,
        state: "OPEN",
        isDraft: outcome.isDraft,
        title: outcome.title,
        url: outcome.url ?? "",
        // Unread rather than guessed. Only a merged pull request's head is ever compared,
        // and this record is open by construction.
        headSha: "",
        reviewDecision: null,
        checks: null,
      });
    }
  }

  /**
   * Delete the branches whose pull request merged at their current tip, and answer what stayed.
   *
   * Reads a fresh snapshot rather than trusting the webview's: the tip each deletion is
   * checked against has to be the one on disk now, not the one a poll ago. That same read is
   * what makes the kept branches worth reporting — they are the repository's state now.
   *
   * Null takes every branch that qualifies, for a sweep the reader asked for outright.
   */
  async deleteMergedBranches(
    branches: string[] | null
  ): Promise<MergedDeletion> {
    return deleteMergedBranches(
      this.git,
      await this.read(),
      this.pullRequests.cached(),
      branches
    );
  }

  /**
   * Delete one local branch, merged or not.
   *
   * This reads a fresh snapshot for the same reason that the merged sweep does: the refusals depend
   * on where HEAD and the worktrees sit now, not on where they sat one poll ago.
   */
  async deleteBranch(branch: string): Promise<BranchDeletion> {
    return deleteBranch(this.git, await this.read(), branch);
  }

  /** Work out where the working-copy changes belong, without applying anything. */
  planAbsorb(snapshot: RawData, targetSha?: string): Promise<AbsorbPlan> {
    return planAbsorb(this.git, snapshot, targetSha);
  }

  /**
   * Fold the working-copy changes into the commits that own those lines.
   *
   * Planning and applying are separate so the UI can preview the placement — the
   * point of absorb is that you can see where each hunk landed before committing
   * to it.
   */
  async absorb(targetSha?: string): Promise<AbsorbResult> {
    const snapshot = await this.read();
    const plan = await planAbsorb(this.git, snapshot, targetSha);
    return applyAbsorb(this.git, snapshot, plan);
  }

  /** Combine a commit with the one below it, keeping both messages. */
  async fold(sha: string): Promise<FoldResult> {
    const snapshot = await this.read();
    return foldIntoParent(this.git, snapshot, sha);
  }

  /** List a commit's changes as selectable hunks, without modifying anything. */
  async previewSplit(sha: string): Promise<SplitPreview> {
    return previewSplit(this.git, await this.read(), sha);
  }

  /** Separate a commit into two, with the selected hunks going to the first. */
  async split(
    sha: string,
    selectedIds: string[],
    firstMessage?: string,
    secondMessage?: string
  ): Promise<SplitResult> {
    const snapshot = await this.read();
    return splitCommit(
      this.git,
      snapshot,
      sha,
      selectedIds,
      firstMessage,
      secondMessage
    );
  }

  /** Reverse the most recent history edit by restoring the refs it moved. */
  undo(): Promise<string> {
    return this.undoHistory.undo();
  }

  /**
   * Finish the rebase the user resolved, then record where the stacks landed — a rebase that
   * stopped on a conflict moves the same branches as one that did not.
   */
  async continueRebase(): Promise<RebaseOutcome> {
    return this.recordStackBases(await continueRebase(this.git));
  }

  abortRebase(): Promise<void> {
    return abortRebase(this.git);
  }

  launchMergeTool(file?: string): Promise<void> {
    return launchMergeTool(this.git, file);
  }
}
