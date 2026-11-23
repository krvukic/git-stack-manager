/**
 * absorb — fold working-copy changes into the stack commits they belong to.
 *
 * `absorbAnalysis` decides *where* each hunk goes; this module gets the data in
 * and the result out. Three jobs:
 *
 *   1. Read each changed file's content at every stack commit, in one
 *      `cat-file --batch` rather than a `git show` per revision.
 *   2. Run the attribution, then materialise each commit's new content, including
 *      every commit above the stack that the rebuild moves.
 *   3. Rebuild the stack with `commit-tree` and move the refs atomically.
 *
 * Step 3 cannot conflict, which is the whole point. Because the new content is
 * computed per commit rather than replayed as a patch, rewriting an ancestor is a
 * pure object-graph operation — no checkout, no merge, no rebase. Ports that emit
 * `fixup!` commits and defer to `rebase --autosquash` give this up: a
 * misattributed hunk becomes a rebase conflict instead of a wrong-but-clean
 * result the user can inspect and undo. The one merge absorb does, carrying a
 * change up through commits above the stack, runs in step 2, so absorb declines
 * a file it cannot carry cleanly before it writes anything.
 *
 * Nothing writes the working copy. Hunks that absorb could not place stay exactly
 * where they are, and the tally reports them, so a re-run is safe.
 */
import { diffLines } from "#git/lineDiff";
import { GitError, GitRunner } from "#git/runner";
import { RawCommit, RawData } from "#git/snapshot";
import {
  analyse,
  applyFixups,
  buildOwnerMap,
  carryChange,
  Fixup,
} from "#history/absorbPlacement";
import {
  fileMode,
  readObjects,
  stageBlob,
  withScratchIndex,
  writeBlob,
} from "#history/objects";
import { rebuildStack } from "#history/rewrite";

/** What absorb did to one file, for the report the UI shows. */
export type FileOutcome = {
  path: string;
  applied: number;
  /** Hunks left in the working copy, with why. */
  skipped: Array<{ reason: string }>;
};

export type AbsorbPlan = {
  /** New blob content per commit sha, per path. */
  contentByCommit: Map<string, Map<string, string>>;
  outcomes: FileOutcome[];
  /** Commit subjects that will change, oldest first, for the confirmation. */
  affected: Array<{ sha: string; subject: string; hunks: number }>;
};

export type AbsorbResult = {
  outcomes: FileOutcome[];
  /** Old sha -> new sha for every rebuilt commit. Empty when nothing applied. */
  rewritten: Map<string, string>;
  appliedHunks: number;
  skippedHunks: number;
};

/**
 * Work out where every uncommitted change belongs, without touching anything.
 *
 * Only tracked, modified, text files take part. Additions, deletions, renames,
 * binaries, and symlinks are skipped — absorb operates on line ownership, which
 * none of those have in a useful form. Absorb proper skips them too.
 */
export async function planAbsorb(
  git: GitRunner,
  snapshot: RawData,
  targetSha?: string
): Promise<AbsorbPlan> {
  const stack = stackFor(snapshot, targetSha);
  if (!stack.length) {
    // Almost always trunk is checked out: absorb walks down from HEAD, so no local
    // commit lies beneath it. Name the branch to switch to.
    const candidates = snapshot.commits
      .flatMap(commit => commit.branches)
      .slice(0, 3);
    throw new GitError(
      candidates.length
        ? `No local commits below ${snapshot.headBranch ?? "HEAD"} to absorb into. ` +
            `Check out a stack branch first (for example ${candidates.join(", ")}).`
        : "No local commits to absorb into — everything here is already on trunk.",
      "absorb"
    );
  }

  const paths = snapshot.uncommitted
    .filter(change => change.status === "M")
    .map(change => change.path);
  if (!paths.length) {
    throw new GitError(
      "No modified tracked files to absorb. Added, deleted, and renamed files are not absorbed.",
      "absorb"
    );
  }

  const contentByCommit = new Map<string, Map<string, string>>();
  const outcomes: FileOutcome[] = [];
  const hunksPerCommit = new Map<string, number>();
  const above = commitsAbove(snapshot, stack);

  for (const path of paths) {
    const file = await readFileHistory(git, stack, above, path);
    if (!file) {
      continue;
    } // untouched by the stack, or binary

    const map = buildOwnerMap(file.revisions, diffLines);
    const working = await readWorkingCopy(git, path);
    if (working === null) {
      continue;
    }

    const hunks = diffLines(file.revisions.at(-1)!, working);
    const { fixups, rejected } = analyse(map, hunks);
    const skipped = rejected.map(entry => ({ reason: entry.reason }));
    if (!fixups.length) {
      outcomes.push({ path, applied: 0, skipped });
      continue;
    }

    const contents = applyFixups(map, fixups, file.revisions.length - 1);
    const carried = carryAbove(file, contents, above);
    if (!(carried instanceof Map)) {
      // Every placed hunk stays in the working copy with the reason, as an unplaced one does.
      const placed = hunks.length - rejected.length;
      outcomes.push({
        path,
        applied: 0,
        skipped: [
          ...skipped,
          ...Array.from({ length: placed }, () => ({ reason: carried.reason })),
        ],
      });
      continue;
    }
    outcomes.push({ path, applied: fixups.length, skipped });
    recordContents(
      contentByCommit,
      hunksPerCommit,
      file,
      contents,
      fixups,
      path
    );
    for (const [sha, content] of carried) {
      const perPath = contentByCommit.get(sha) ?? new Map<string, string>();
      perPath.set(path, content);
      contentByCommit.set(sha, perPath);
    }
  }

  const affected = stack
    .filter(commit => hunksPerCommit.has(commit.sha))
    .map(commit => ({
      sha: commit.sha,
      subject: commit.subject,
      hunks: hunksPerCommit.get(commit.sha) ?? 0,
    }));
  return { contentByCommit, outcomes, affected };
}

/** Store each commit's new content for one file, and tally hunks per commit. */
function recordContents(
  contentByCommit: Map<string, Map<string, string>>,
  hunksPerCommit: Map<string, number>,
  file: FileHistory,
  contents: string[][],
  fixups: Fixup[],
  path: string
): void {
  // Index 0 is the immutable base; only stack commits are rewritten.
  file.owners.forEach((sha, index) => {
    const owner = index + 1;
    const targeted = fixups.filter(fixup => fixup.owner === owner).length;
    if (!targeted) {
      return;
    }
    hunksPerCommit.set(sha, (hunksPerCommit.get(sha) ?? 0) + targeted);
    // Rewriting a commit changes every descendant's content too, so each one from the
    // owner up to the tip gets its rebuilt copy. Both lookups stay in range: `commit`
    // indexes `owners` one below itself, and `contents` holds one entry per revision.
    for (let commit = owner; commit <= file.owners.length; commit++) {
      const descendant = file.owners[commit - 1];
      const rebuilt = contents[commit];
      if (descendant === undefined || rebuilt === undefined) {
        continue;
      }
      const perPath =
        contentByCommit.get(descendant) ?? new Map<string, string>();
      perPath.set(path, join(rebuilt));
      contentByCommit.set(descendant, perPath);
    }
  });
}

/** A commit above the stack, and the stack commit its first parents lead down to. */
type CommitAbove = {
  commit: RawCommit;
  fork: string;
};

/**
 * Every local commit outside the stack that `rebuildStack` moves when it rewrites the stack: the
 * commits above HEAD, and those on branches that fork off the stack.
 *
 * `rebuildStack` recreates each of them on its rewritten parent, and keeps its old tree unless
 * absorb hands it a new one. A kept old tree would put the absorbed lines back as they were, so the
 * change would reach the commit it was absorbed into and be undone one commit up.
 */
function commitsAbove(snapshot: RawData, stack: RawCommit[]): CommitAbove[] {
  const onStack = new Set(stack.map(commit => commit.sha));
  const bySha = new Map(snapshot.commits.map(commit => [commit.sha, commit]));
  // Memoised, so each commit's first parents are walked once however many branches share them.
  const forkOf = new Map<string, string | null>();
  const findFork = (start: RawCommit): string | null => {
    const walked: string[] = [];
    let fork: string | null = null;
    for (let current: RawCommit | undefined = start; current;) {
      if (onStack.has(current.sha)) {
        fork = current.sha;
        break;
      }
      const known = forkOf.get(current.sha);
      if (known !== undefined) {
        fork = known;
        break;
      }
      walked.push(current.sha);
      const parent: string | undefined = current.parents[0];
      current = parent === undefined ? undefined : bySha.get(parent);
    }
    walked.forEach(sha => forkOf.set(sha, fork));
    return fork;
  };
  return snapshot.commits.flatMap(commit => {
    if (onStack.has(commit.sha)) {
      return [];
    }
    const fork = findFork(commit);
    return fork === null ? [] : [{ commit, fork }];
  });
}

/**
 * The new copy of one file for each commit above the stack, or why the absorbed change cannot
 * reach one of them.
 *
 * `carryChange` merges the change made to each commit's fork commit into that commit's own copy of
 * the file. A commit whose fork commit did not change gets no new copy.
 */
function carryAbove(
  file: FileHistory,
  contents: string[][],
  above: CommitAbove[]
): Map<string, string> | { reason: string } {
  // Revision 0 is the base, so a stack commit's revision sits one past its position.
  const revisionOf = new Map(file.owners.map((sha, index) => [sha, index + 1]));
  const carried = new Map<string, string>();
  for (const { commit, fork } of above) {
    const revision = revisionOf.get(fork) ?? 0;
    const before = file.revisions[revision] ?? [];
    const after = contents[revision] ?? before;
    if (sameLines(before, after)) {
      continue;
    }
    const descendant = file.copiesAbove.get(commit.sha) ?? null;
    if (descendant === null) {
      return {
        reason: `"${commit.subject}", further up the stack, deletes this file or makes it binary, so the change cannot carry through it`,
      };
    }
    const merged = carryChange(before, after, descendant, diffLines);
    if (!merged) {
      return {
        reason: `"${commit.subject}", further up the stack, changes the same lines, so the change cannot carry through it`,
      };
    }
    carried.set(commit.sha, join(merged));
  }
  return carried;
}

function sameLines(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((line, index) => line === second[index])
  );
}

/** Apply a plan: rebuild the affected commits and move the refs. */
export async function applyAbsorb(
  git: GitRunner,
  snapshot: RawData,
  plan: AbsorbPlan
): Promise<AbsorbResult> {
  const appliedHunks = plan.outcomes.reduce(
    (total, outcome) => total + outcome.applied,
    0
  );
  const skippedHunks = plan.outcomes.reduce(
    (total, outcome) => total + outcome.skipped.length,
    0
  );
  if (!plan.contentByCommit.size) {
    return {
      outcomes: plan.outcomes,
      rewritten: new Map(),
      appliedHunks,
      skippedHunks,
    };
  }

  // Build the new trees first: writing blobs and trees touches only the object
  // database, so a failure here leaves the repository exactly as it was.
  const treeBySha = await withScratchIndex(
    git,
    "gsm-absorb-index",
    async environment => {
      const trees = new Map<string, string>();
      for (const [sha, perPath] of plan.contentByCommit) {
        trees.set(sha, await writeTree(git, environment, sha, perPath));
      }
      return trees;
    }
  );
  const rewritten = await rebuildStack(git, snapshot, { treeBySha });

  // Drop the absorbed changes from the working copy by checking out the new
  // content for the touched paths. Their content now lives in the commits, so
  // leaving them modified would show the same change twice.
  await refreshAbsorbedPaths(git, plan);

  return { outcomes: plan.outcomes, rewritten, appliedHunks, skippedHunks };
}

/** Replace a commit's tree with new content for some paths. */
async function writeTree(
  git: GitRunner,
  environment: NodeJS.ProcessEnv,
  sha: string,
  perPath: Map<string, string>
): Promise<string> {
  await git.run(["read-tree", sha], { env: environment });
  for (const [path, content] of perPath) {
    const blob = await writeBlob(git, content);
    // Keep the existing mode so an executable bit survives absorb.
    await stageBlob(git, environment, {
      path,
      mode: await fileMode(git, sha, path),
      blob,
    });
  }
  return git.run(["write-tree"], { env: environment });
}

/**
 * Bring the working copy in line for fully absorbed files.
 *
 * A file whose every hunk was absorbed now matches its commit, so checking it out
 * clears the modification. A file with leftovers is left alone — overwriting it
 * would discard the changes absorb declined to place.
 */
async function refreshAbsorbedPaths(
  git: GitRunner,
  plan: AbsorbPlan
): Promise<void> {
  const clean = plan.outcomes
    .filter(outcome => outcome.applied > 0 && outcome.skipped.length === 0)
    .map(outcome => outcome.path);
  if (!clean.length) {
    return;
  }
  await git.tryRun(["checkout", "HEAD", "--", ...clean]);
}

type FileHistory = {
  /** Content per revision: index 0 is the base, then one per stack commit. */
  revisions: string[][];
  /** Stack commit shas, aligned with `revisions[1..]`. */
  owners: string[];
  /** The file at each commit above the stack, by sha; null where it is absent or binary. */
  copiesAbove: Map<string, string[] | null>;
};

/**
 * Read one file at the base and at every stack commit.
 *
 * `cat-file --batch` streams every blob through a single process; a `git show`
 * per revision would dominate the runtime on a deep stack.
 */
async function readFileHistory(
  git: GitRunner,
  stack: RawCommit[],
  above: CommitAbove[],
  path: string
): Promise<FileHistory | null> {
  // The caller returns early on an empty stack, and the bottom commit's first parent
  // is the base the stack forked from. An empty spec resolves to nothing, so a root
  // commit yields a null blob and the file drops out rather than throwing.
  const baseSha = stack[0]?.parents[0] ?? "";
  const specs = [
    baseSha,
    ...stack.map(commit => commit.sha),
    ...above.map(({ commit }) => commit.sha),
  ].map(sha => `${sha}:${path}`);
  const blobs = (await readObjects(git, specs)).map(
    blob => blob?.toString("utf8") ?? null
  );
  const history = blobs.slice(0, stack.length + 1);
  if (history.some(blob => blob !== null && isBinary(blob))) {
    return null;
  }

  const revisions = history.map(blob => splitLines(blob ?? ""));
  const copiesAbove = new Map(
    above.map(({ commit }, index) => {
      const blob = blobs[stack.length + 1 + index] ?? null;
      return [
        commit.sha,
        blob === null || isBinary(blob) ? null : splitLines(blob),
      ];
    })
  );
  return {
    revisions,
    owners: stack.map(commit => commit.sha),
    copiesAbove,
  };
}

/** The file as it is on disk — absorb folds in what the user actually has. */
async function readWorkingCopy(
  git: GitRunner,
  path: string
): Promise<string[] | null> {
  const onDisk = await git.readWorktreeFile(path);
  if (onDisk === null || isBinary(onDisk)) {
    return null;
  }
  return splitLines(onDisk.toString("utf8"));
}

/** Git's own heuristic: a NUL in the first 8000 bytes means binary. */
function isBinary(content: string | Buffer): boolean {
  const text =
    typeof content === "string" ? content : content.toString("latin1");
  return text.slice(0, 8000).includes("\0");
}

/**
 * Split content into lines, keeping the information needed to rejoin exactly.
 * A trailing newline becomes a final empty element, so `join` restores it.
 */
function splitLines(content: string): string[] {
  if (content === "") {
    return [];
  }
  return content.split("\n");
}

function join(lines: string[]): string {
  return lines.join("\n");
}

/**
 * The commits absorb may rewrite: the local stack, oldest first.
 *
 * With no target this is everything reachable from HEAD that is not on trunk —
 * the same set the graph draws. With a target, only that commit and its
 * ancestors within the stack, so "absorb into this commit and below" is possible.
 */
function stackFor(snapshot: RawData, targetSha?: string): RawCommit[] {
  const bySha = new Map(snapshot.commits.map(commit => [commit.sha, commit]));
  const headChain: RawCommit[] = [];
  let current = bySha.get(targetSha ?? snapshot.headSha);
  while (current) {
    headChain.push(current);
    // A root commit has no parents, which ends the walk — the same outcome as a
    // parent outside the stack, since neither is in the map.
    const parent = current.parents[0];
    current = parent === undefined ? undefined : bySha.get(parent);
  }
  return headChain.reverse();
}
