/**
 * commit — turn working-copy changes into a new commit, or fold them into one
 * that already exists.
 *
 * Both halves take an explicit path list, because the point of the tree's
 * checkboxes is choosing what goes in. Two of git's behaviours shape the
 * implementation:
 *
 *   1. `git commit -- <paths>` only matches paths git already tracks: an
 *      untracked file fails the whole commit with "pathspec did not match any
 *      file(s) known to git". Every path is therefore `git add`ed first, which
 *      also stages a deletion, so one code path covers modify, add, and delete.
 *   2. A pathspec commit ignores whatever else is staged, and leaves it staged.
 *      That is what lets this run against a dirty index without saving and
 *      restoring it — the files a user did not tick keep their exact index state.
 *
 * Amending is split in two by where the target sits. HEAD takes git's own
 * `commit --amend`, which is one process and keeps the reflog entry a person
 * would expect. A commit deeper in the stack cannot: `--amend` rewrites HEAD's
 * parentage and would orphan every descendant, so the change is committed on top
 * and then folded down through `rebuildStack`, which re-parents the commits above
 * it. `absorb` places hunks by line ownership; this places whole files where the
 * user pointed.
 *
 * A file whose lines were only partly chosen cannot go through a pathspec commit,
 * which takes each path whole from the working tree. When any such file is in the
 * selection, the commit is made from a scratch index instead; `chosenChanges`
 * describes how.
 */
import { GitError, GitRunner } from "#git/runner";
import { RawData } from "#git/snapshot";
import { stageChosenChanges } from "#history/chosenChanges";
import { withScratchIndex } from "#history/objects";
import { LineSelection } from "#history/partialSelection";
import { rebuildStack } from "#history/rewrite";

/** The chosen changes: whole paths, and the lines left out of the partly chosen ones. */
export type ChosenChanges = {
  paths: string[];
  /** One entry per partly chosen file, each also in `paths`. */
  lines?: LineSelection[];
};

export type CommitResult = {
  newSha: string;
  /** Paths that went into the commit, in the order they were given. */
  committed: string[];
};

export type AmendResult = {
  newSha: string;
  committed: string[];
  /** Old sha -> new sha for every commit the amend recreated. */
  rewritten: Map<string, string>;
};

/**
 * Stage `paths` and commit them as a new child of HEAD.
 *
 * The message is passed on stdin rather than as `-m`, so a subject containing
 * quotes or newlines needs no escaping and never reaches a shell.
 */
export async function commitPaths(
  git: GitRunner,
  snapshot: RawData,
  { paths, lines = [], message }: ChosenChanges & { message: string }
): Promise<CommitResult> {
  const selected = requireSelection(snapshot, paths, "commit");
  requireMessage(message, "commit");
  const partial = requireLines(selected, lines, "commit");

  if (partial.length) {
    await commitFromScratchIndex(
      git,
      { paths: selected, lines: partial },
      ["commit", "--file=-"],
      message
    );
  } else {
    await stage(git, selected);
    // `--only` makes the pathspec authoritative even when other paths are staged:
    // without it git commits the whole index whenever a merge is in progress.
    await git.run(["commit", "--only", "--file=-", "--", ...selected], {
      input: message,
    });
  }
  return { newSha: await git.run(["rev-parse", "HEAD"]), committed: selected };
}

/**
 * Commit the chosen changes from a scratch index, then line the real index up with the result.
 *
 * `commitArguments` is either a new commit or an amend of HEAD; both read the scratch index
 * through `GIT_INDEX_FILE`, and both keep git's hooks and reflog. The reset afterwards is what
 * `--only` would have done to the real index: each committed path now matches the new HEAD, so a
 * partly committed file shows its remainder as an unstaged change, and every other path keeps
 * whatever was staged.
 */
async function commitFromScratchIndex(
  git: GitRunner,
  chosen: { paths: string[]; lines: LineSelection[] },
  commitArguments: string[],
  message = ""
): Promise<void> {
  // A merge in progress would make this a merge commit whose tree holds none of the merge.
  // A pathspec commit refuses the same case with "cannot do a partial commit during a merge".
  if (await git.succeeds(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])) {
    throw new GitError(
      "Finish or abort the merge before committing part of a file.",
      "commit"
    );
  }
  await withScratchIndex(git, "gsm-commit-index", async environment => {
    await stageChosenChanges(git, environment, chosen);
    await git.run(commitArguments, { env: environment, input: message });
  });
  await git.run(["reset", "-q", "--", ...chosen.paths]);
}

/**
 * Fold `paths` into an existing commit, keeping its message.
 *
 * `targetSha` defaults to HEAD. A target deeper in the stack is rewritten with
 * `rebuildStack`, so the branches above it follow rather than being stranded on
 * the commits it replaced.
 *
 * The target has to be an ancestor of HEAD. Working-copy content only makes sense
 * in a commit the working copy descends from: grafting it sideways into another
 * branch put the change in two places at once — the commit had it *and* the file
 * was still dirty, because the checkout that clears the working copy reads HEAD,
 * which never received it. Sapling has the same rule; its `amend` only ever
 * targets the commit you are on.
 */
export async function amendPathsInto(
  git: GitRunner,
  snapshot: RawData,
  { paths, lines = [], targetSha }: ChosenChanges & { targetSha?: string }
): Promise<AmendResult> {
  const selected = requireSelection(snapshot, paths, "amend");
  const partial = requireLines(selected, lines, "amend");
  const target = targetSha ?? snapshot.headSha;
  if (target !== snapshot.headSha) {
    if (!snapshot.commits.some(commit => commit.sha === target)) {
      throw new GitError(
        "Commit is not a local-only commit (already on trunk?) — refusing to amend into it.",
        "amend"
      );
    }
    if (
      !(await git.succeeds(["merge-base", "--is-ancestor", target, "HEAD"]))
    ) {
      throw new GitError(
        "That commit is not in the stack you have checked out. Goto it first, then amend.",
        "amend"
      );
    }
  }

  if (target === snapshot.headSha && partial.length) {
    await commitFromScratchIndex(git, { paths: selected, lines: partial }, [
      "commit",
      "--amend",
      "--no-edit",
    ]);
    return {
      newSha: await git.run(["rev-parse", "HEAD"]),
      committed: selected,
      rewritten: new Map(),
    };
  }
  if (partial.length) {
    throw new GitError(
      "Chosen lines can only be amended into HEAD for now.",
      "amend"
    );
  }
  await stage(git, selected);
  if (target === snapshot.headSha) {
    await git.run([
      "commit",
      "--amend",
      "--no-edit",
      "--only",
      "--",
      ...selected,
    ]);
    return {
      newSha: await git.run(["rev-parse", "HEAD"]),
      committed: selected,
      rewritten: new Map(),
    };
  }
  return amendIntoAncestor(git, snapshot, selected, target);
}

/**
 * Amend into a commit below HEAD.
 *
 * `git add` has already put the new content in the index, which is the only place
 * it is needed: the blob is written and its hash recorded, so grafting it onto the
 * target is an object-database operation with no checkout and no chance of
 * conflict.
 *
 * Every descendant needs the graft too, not just the target. `rebuildStack` reuses
 * a commit's original tree unless given a new one, and that tree still holds the
 * pre-amend content — so grafting only the target leaves the very next commit
 * reverting it, showing up as a spurious `M feature.txt` one row up the stack. The
 * exception is a descendant that changes the path itself: its own version wins,
 * because the user edited that content later and the amend must not roll it back.
 *
 * The order matters for safety. Trees and commits are written first and the refs
 * move in one atomic `update-ref` batch inside `rebuildStack`, so a failure
 * anywhere before that leaves the repository — and the working copy — exactly as
 * it was.
 */
async function amendIntoAncestor(
  git: GitRunner,
  snapshot: RawData,
  paths: string[],
  targetSha: string
): Promise<AmendResult> {
  const treeBySha = new Map<string, string>();
  treeBySha.set(targetSha, await graftPaths(git, targetSha, paths));
  for (const sha of descendantsOf(snapshot, targetSha)) {
    const ownEdits = await pathsChangedBy(git, sha);
    const carried = paths.filter(path => !ownEdits.has(path));
    if (!carried.length) {
      continue;
    }
    treeBySha.set(sha, await graftPaths(git, sha, carried));
  }
  const rewritten = await rebuildStack(git, snapshot, { treeBySha });
  const newSha = rewritten.get(targetSha);
  if (!newSha) {
    throw new GitError("Amend produced no new commit for the target.", "amend");
  }

  // The content lives in the target now, so the working copy has to stop showing
  // it as a change. Unstaging first is what makes the checkout a no-op for the
  // index rather than a second staged copy of the same content.
  await git.run(["reset", "-q", "HEAD", "--", ...paths]);
  await git.tryRun(["checkout", "HEAD", "--", ...paths]);
  return { newSha, committed: paths, rewritten };
}

/** Every local commit reachable *from* a descendant down to `sha`, `sha` excluded. */
function descendantsOf(snapshot: RawData, sha: string): string[] {
  const bySha = new Map(snapshot.commits.map(commit => [commit.sha, commit]));
  const above: string[] = [];
  // Oldest first, so a commit is considered after the ancestor that puts it in the
  // set — one pass is enough, no fixpoint needed.
  for (const commit of [...snapshot.commits].reverse()) {
    if (
      commit.parents.some(parent => parent === sha || above.includes(parent))
    ) {
      above.push(commit.sha);
    }
  }
  return above.filter(candidate => bySha.has(candidate));
}

/**
 * The paths `sha` changes relative to its parent.
 *
 * Read per descendant rather than carried on the snapshot: the render never needs
 * this, and an amend touches a handful of commits, so one `show --name-only` each
 * beats widening every refresh.
 */
async function pathsChangedBy(
  git: GitRunner,
  sha: string
): Promise<Set<string>> {
  const output = await git.tryRun([
    "show",
    "--name-only",
    "--format=",
    "-z",
    sha,
  ]);
  return new Set((output ?? "").split("\0").filter(Boolean));
}

/** Build a tree from `baseSha` carrying the index's content for `paths`. */
async function graftPaths(
  git: GitRunner,
  baseSha: string,
  paths: string[]
): Promise<string> {
  return withScratchIndex(git, "gsm-amend-index", async environment => {
    await git.run(["read-tree", baseSha], { env: environment });
    for (const path of paths) {
      // `ls-files --stage` reports the real index's entry for the path, which is
      // the content just staged. A path missing from it was deleted, so the graft
      // removes it from the target too.
      const entry = await git.tryRun(["ls-files", "--stage", "--", path]);
      if (!entry) {
        await git.tryRun(["update-index", "--force-remove", "--", path], {
          env: environment,
        });
        continue;
      }
      // `<mode> <sha> <stage>\t<path>`, so the tab always precedes the path and the
      // fields before it always parse.
      const [mode, blob] = (entry.split("\t")[0] ?? "").split(/\s+/);
      await git.run(
        ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`],
        { env: environment }
      );
    }
    return git.run(["write-tree"], { env: environment });
  });
}

/** Stage each path, so an untracked file and a deletion both become committable. */
async function stage(git: GitRunner, paths: string[]): Promise<void> {
  // `--all` covers the deletion case: without it, a removed file is not staged and
  // the pathspec commit would leave it in the tree.
  await git.run(["add", "--all", "--", ...paths]);
}

/**
 * Reject a selection that is empty or names something git does not report as
 * changed. Committing an unchanged path would otherwise produce an empty commit,
 * and a typo'd path would silently commit nothing.
 */
function requireSelection(
  snapshot: RawData,
  paths: string[],
  action: string
): string[] {
  const selected = paths.filter(path => path.length > 0);
  if (!selected.length) {
    throw new GitError(`Select at least one change to ${action}.`, action);
  }
  const changed = new Set(snapshot.uncommitted.map(file => file.path));
  const unknown = selected.filter(path => !changed.has(path));
  if (unknown.length) {
    throw new GitError(
      `Not an uncommitted change: ${unknown.join(", ")}`,
      action
    );
  }
  return selected;
}

/**
 * Check each partly chosen file against the selection, keeping those with a line left out.
 *
 * A file with nothing left out is taken whole, which the pathspec commit already does. A file with
 * chosen lines that is not itself selected would have its lines silently dropped, and one listed
 * twice would leave it unclear which choice applies, so both are refused.
 */
function requireLines(
  selected: string[],
  lines: LineSelection[],
  action: string
): LineSelection[] {
  const paths = new Set(selected);
  const seen = new Set<string>();
  for (const selection of lines) {
    if (!paths.has(selection.path) || seen.has(selection.path)) {
      throw new GitError(
        `Chosen lines do not match the selection: ${selection.path}`,
        action
      );
    }
    seen.add(selection.path);
  }
  return lines.filter(
    selection =>
      selection.excludedRemovals.length || selection.excludedAdditions.length
  );
}

function requireMessage(message: string, action: string): void {
  if (!message.trim()) {
    throw new GitError("A commit needs a message.", action);
  }
}
