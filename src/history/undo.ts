/**
 * undo — restore the refs a mutation moved.
 *
 * Every history edit in this extension ends the same way: branches (and possibly
 * a detached HEAD) move in one atomic `update-ref --stdin` batch. Recording the
 * ref state just before that batch therefore captures everything needed to put
 * the repository back, and the rewritten commits stay reachable from the reflog
 * until git prunes them, so nothing has to be recreated.
 *
 * That makes undo a *ref* operation, not an inverse of each command: reword,
 * rebase, absorb, and fold all restore the same way, and a command added later
 * gets undo for free by recording a checkpoint.
 *
 * Two deliberate limits:
 *
 *   - Undo never touches the working copy. A rebase that changed files leaves
 *     them changed; restoring the refs is enough to recover the history, and
 *     silently reverting someone's edits to get there would be worse than the
 *     problem. The one exception is HEAD's *attachment*, restored with
 *     `symbolic-ref`, which rewrites `.git/HEAD` without reading the index. The
 *     index does need one correction, which `unstageMutatedPaths` explains.
 *   - Checkpoints live in memory, so they last for the session. Persisting them
 *     would invite undoing across an external `git rebase` the extension never
 *     saw, where the recorded "before" no longer describes reality.
 */
import { errorMessage } from "#core/values";
import { FIELD_SEPARATOR, GitError, GitRunner } from "#git/runner";
import { isRebaseInProgress } from "#history/rebase";

/** One ref's value at checkpoint time. A null sha means the ref did not exist. */
export type RefSnapshot = {
  refName: string;
  sha: string | null;
};

export type Checkpoint = {
  /** Action label, shown on the undo button: "Amend message", "Absorb"… */
  label: string;
  /** Ref values before the mutation — what undo restores. */
  refs: RefSnapshot[];
  /**
   * Ref values immediately after the mutation. Undo asserts these, so an edit
   * made outside the extension in between aborts the restore instead of being
   * silently discarded.
   */
  expected: RefSnapshot[];
  /** Branch HEAD pointed at, or null when it was detached. */
  headBranch: string | null;
  /** HEAD's commit, used to restore a detached HEAD. */
  headSha: string;
};

/** How many checkpoints to keep. Deep enough to back out of a bad session. */
const HISTORY_LIMIT = 20;

export class UndoHistory {
  private readonly checkpoints: Checkpoint[] = [];

  constructor(private readonly git: GitRunner) {}

  /** The action a call to `undo` would reverse, or null when there is nothing. */
  nextLabel(): string | null {
    return this.checkpoints.at(-1)?.label ?? null;
  }

  /**
   * Record the current ref state before a mutation runs.
   *
   * Captures every local branch rather than only the ones a command expects to
   * touch: a rebase moves refs the caller did not enumerate, and a checkpoint
   * that misses one would restore an inconsistent stack.
   */
  async capture(label: string): Promise<Checkpoint> {
    const refs = await this.readRefSnapshots();
    const headBranch = await this.git.tryRun([
      "symbolic-ref",
      "--short",
      "-q",
      "HEAD",
    ]);
    const headSha = (await this.git.tryRun(["rev-parse", "HEAD"])) ?? "";
    // `expected` is filled in by `seal` once the mutation has run.
    return {
      label,
      refs,
      expected: [],
      headBranch: headBranch || null,
      headSha,
    };
  }

  /**
   * Record where the mutation left the refs, and add the checkpoint to the undo
   * stack. Splitting this from `capture` is what makes the staleness check real:
   * undo asserts the post-mutation values, so an external edit in between is
   * detected rather than quietly thrown away.
   */
  async seal(checkpoint: Checkpoint): Promise<void> {
    checkpoint.expected = await this.readRefSnapshots();
    // A mutation that moved nothing leaves nothing to undo.
    if (sameRefs(checkpoint.refs, checkpoint.expected)) {
      return;
    }
    this.checkpoints.push(checkpoint);
    if (this.checkpoints.length > HISTORY_LIMIT) {
      this.checkpoints.shift();
    }
  }

  /** Restore the newest checkpoint. Returns the label of the undone action. */
  async undo(): Promise<string> {
    const checkpoint = this.checkpoints.pop();
    if (!checkpoint) {
      throw new GitError("Nothing to undo.", "undo");
    }

    // Refuse if anything the mutation touched has moved since. Restoring over
    // an outside edit would destroy work this extension never saw.
    const current = await this.readBranches();
    const expectedBySha = new Map(
      checkpoint.expected.map(ref => [ref.refName, ref.sha])
    );
    const drifted = [...expectedBySha]
      .filter(([refName, sha]) => (current.get(refName) ?? null) !== sha)
      .map(([refName]) => refName.replace("refs/heads/", ""));
    if (drifted.length) {
      this.checkpoints.push(checkpoint);
      throw new GitError(
        `Cannot undo ${checkpoint.label}: ${drifted.join(", ")} changed outside this extension. ` +
          "Nothing was restored.",
        "undo"
      );
    }

    // The commit the mutation produced, read while HEAD still points at it.
    // `unstageMutatedPaths` needs it to tell the mutation's own staging apart
    // from staging the user did by hand.
    const mutatedHead = await this.git.tryRun(["rev-parse", "HEAD"]);

    const updates: string[] = [];
    const recorded = new Set<string>();

    for (const ref of checkpoint.refs) {
      recorded.add(ref.refName);
      const now = current.get(ref.refName);
      if (!ref.sha || now === ref.sha) {
        continue;
      }
      if (now === undefined) {
        // The mutation deleted this branch; recreate it at its old value.
        updates.push(`create ${ref.refName}\0${ref.sha}\0`);
      } else {
        updates.push(`update ${ref.refName}\0${ref.sha}\0${now}\0`);
      }
    }
    // Branches the mutation created did not exist at checkpoint time.
    for (const [refName, sha] of current) {
      if (!recorded.has(refName)) {
        updates.push(`delete ${refName}\0${sha}\0`);
      }
    }

    if (updates.length) {
      try {
        await this.git.run(["update-ref", "--stdin", "-z"], {
          input: updates.join(""),
        });
      } catch (error: unknown) {
        // The batch is atomic, so nothing moved. Put the checkpoint back so the
        // user can retry after sorting out whatever changed underneath.
        this.checkpoints.push(checkpoint);
        throw new GitError(
          `Could not undo ${checkpoint.label}: ${errorMessage(error)}. Nothing was restored.`,
          "undo"
        );
      }
    }
    await this.restoreHead(checkpoint);
    await this.unstageMutatedPaths(mutatedHead);
    return checkpoint.label;
  }

  /**
   * Drop index entries that only match the commit undo just abandoned.
   *
   * Absorb ends with `git checkout HEAD -- <paths>`, so once the refs move back
   * the index still holds the blob the absorbed commit carried. Git then reports
   * the file as staged, and a `git commit` in a terminal would fold the reversed
   * change straight back in — the one way a ref-only undo can lose work.
   *
   * The reset is path-limited, so it rewrites index entries and never the
   * working copy: the file returns to plain modified, which is where absorb
   * found it. A path the user staged themselves matches neither commit, so it
   * keeps its staging; `commit` deliberately preserves such a path, and undo
   * must not be the thing that discards it.
   *
   * @param mutatedHead HEAD's commit before the restore, or null when unreadable.
   */
  private async unstageMutatedPaths(mutatedHead: string | null): Promise<void> {
    if (!mutatedHead) {
      return;
    }
    // A reword reuses every tree, so the index already agrees with the restored
    // commit. Leaving on that answer keeps the common undo down to one extra
    // read, and its command log down to one extra line.
    const stale = await this.stagedAgainst("HEAD");
    if (!stale.length) {
      return;
    }
    // A paused rebase stages the user's own conflict resolutions, and unstaging
    // one would throw away work git cannot redo.
    if (await isRebaseInProgress(this.git)) {
      return;
    }
    const stagedByUser = new Set(await this.stagedAgainst(mutatedHead));
    const paths = stale.filter(path => !stagedByUser.has(path));
    if (paths.length) {
      await this.git.tryRun(["reset", "-q", "HEAD", "--", ...paths]);
    }
  }

  /** Paths whose index entry differs from `ref`. */
  private async stagedAgainst(ref: string): Promise<string[]> {
    const output = await this.git.tryRun([
      "diff-index",
      "--cached",
      "--name-only",
      "-z",
      ref,
    ]);
    return output ? output.split("\0").filter(Boolean) : [];
  }

  private async readRefSnapshots(): Promise<RefSnapshot[]> {
    const branches = await this.readBranches();
    return [...branches].map(([refName, sha]) => ({ refName, sha }));
  }

  private async readBranches(): Promise<Map<string, string>> {
    const output = await this.git.run([
      "for-each-ref",
      `--format=%(refname)${FIELD_SEPARATOR}%(objectname)`,
      "refs/heads",
    ]);
    return new Map(
      output
        .split("\n")
        .filter(Boolean)
        .map(line => {
          const [refName, sha] = line.split(FIELD_SEPARATOR);
          return [refName, sha] as [string, string];
        })
    );
  }

  /**
   * Put HEAD back where it was.
   *
   * `symbolic-ref` re-attaches HEAD to a branch without reading the index, so a
   * dirty working copy survives. Restoring a *detached* HEAD needs the commit
   * itself; `switch --detach` would update files, so this uses `update-ref
   * --no-deref` — which is only safe precisely because HEAD was already
   * detached. On an attached HEAD, `--no-deref` silently detaches it.
   */
  private async restoreHead(checkpoint: Checkpoint): Promise<void> {
    if (checkpoint.headBranch) {
      const currentBranch = await this.git.tryRun([
        "symbolic-ref",
        "--short",
        "-q",
        "HEAD",
      ]);
      if (currentBranch !== checkpoint.headBranch) {
        await this.git.tryRun([
          "symbolic-ref",
          "HEAD",
          `refs/heads/${checkpoint.headBranch}`,
        ]);
      }
      return;
    }
    if (!checkpoint.headSha) {
      return;
    }
    // Re-detach by writing the sha into HEAD directly. `symbolic-ref --detach`
    // does not exist and `checkout --detach` would update files, so point HEAD
    // at the commit with --no-deref, which is safe here only because the target
    // state is detached.
    await this.git.tryRun([
      "update-ref",
      "--no-deref",
      "HEAD",
      checkpoint.headSha,
    ]);
  }
}

/** Whether two ref snapshots describe the same set of branch values. */
function sameRefs(before: RefSnapshot[], after: RefSnapshot[]): boolean {
  if (before.length !== after.length) {
    return false;
  }
  const beforeBySha = new Map(before.map(ref => [ref.refName, ref.sha]));
  return after.every(ref => beforeBySha.get(ref.refName) === ref.sha);
}
