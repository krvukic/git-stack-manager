/**
 * amendIntoAncestor — fold chosen working-copy changes into a commit below HEAD.
 *
 * The chosen changes are staged into a scratch index built from HEAD, exactly as a commit takes
 * them, which gives what HEAD should hold afterwards. Each commit from the target up then gets its
 * own copy of every changed file, so the target carries the change and each later commit keeps
 * only what it changed itself:
 *
 * - A file no later commit touched is one blob in all of them, so each takes the new entry.
 * - A text file a later commit edited goes line by line through `amendPlacement`, which refuses a
 *   change to a later commit's lines.
 * - Any other file a later commit touched has no lines to place, and is refused.
 *
 * Only blobs, trees, and commits are written before `rebuildStack` moves every ref in one
 * transaction, so a refusal leaves the repository as it was. The working tree is never written:
 * HEAD ends up holding the chosen changes, so resetting the index for those paths leaves only what
 * was left out showing as a change.
 */
import { diffLines } from "#git/lineDiff";
import { GitError, GitRunner } from "#git/runner";
import { RawCommit, RawData } from "#git/snapshot";
import { applyFixups, buildOwnerMap, OwnerMap } from "#history/absorbPlacement";
import { carryOnto, placeInTarget, Placement } from "#history/amendPlacement";
import { stageChosenChanges } from "#history/chosenChanges";
import { readObjects, withScratchIndex, writeBlob } from "#history/objects";
import { LineSelection, splitKeepingEnds } from "#history/partialSelection";
import { rebuildStack } from "#history/rewrite";

type TreeEntry = { mode: string; blob: string };

/** A file's entry in one commit, null where the commit does not have it. */
type Entry = TreeEntry | null;

/** The target, the commits from it up to HEAD, and every other commit above it. */
type Stack = {
  target: RawCommit;
  /** Target first, HEAD last. */
  headPath: RawCommit[];
  /** Commits above the target off the path to HEAD, each after its parent. */
  branches: Array<{ commit: RawCommit; parent: string }>;
};

/** A text file a later commit edited, with the first commit above the target that did. */
type EditedFile = { path: string; toucher: RawCommit; wanted: TreeEntry };

export async function amendIntoAncestor(
  git: GitRunner,
  snapshot: RawData,
  chosen: { paths: string[]; lines: LineSelection[] },
  targetSha: string
): Promise<{ newSha: string; rewritten: Map<string, string> }> {
  const stack = stackAbove(snapshot, targetSha);
  const wanted = await withScratchIndex(
    git,
    "gsm-amend-index",
    async environment => {
      await stageChosenChanges(git, environment, chosen);
      return listEntries(
        git,
        ["ls-files", "--stage", "-z", "--", ...chosen.paths],
        chosen.paths,
        environment
      );
    }
  );
  const head = await listTree(git, snapshot.headSha, chosen.paths);
  const files = [...new Set([...wanted.keys(), ...head.keys()])].filter(
    path => !sameEntry(wanted.get(path) ?? null, head.get(path) ?? null)
  );
  if (!files.length) {
    throw new GitError("HEAD already holds the chosen changes.", "amend");
  }

  const commits = [
    ...stack.headPath,
    ...stack.branches.map(({ commit }) => commit),
  ];
  const trees = new Map<string, Map<string, TreeEntry>>();
  for (const commit of commits) {
    trees.set(commit.sha, await listTree(git, commit.sha, files));
  }
  const entryAt = (sha: string, path: string): Entry =>
    trees.get(sha)?.get(path) ?? null;

  const changes = new Map<string, Map<string, Entry>>();
  const record = (sha: string, path: string, entry: Entry) => {
    if (!sameEntry(entry, entryAt(sha, path))) {
      const perPath = changes.get(sha) ?? new Map<string, Entry>();
      perPath.set(path, entry);
      changes.set(sha, perPath);
    }
  };

  const edited: EditedFile[] = [];
  for (const path of files) {
    const original = entryAt(targetSha, path);
    const toucher = commits.find(
      commit => !sameEntry(entryAt(commit.sha, path), original)
    );
    const wantedEntry = wanted.get(path) ?? null;
    if (!toucher) {
      for (const commit of commits) {
        record(commit.sha, path, wantedEntry);
      }
      continue;
    }
    const reason = unplaceableReason({
      original,
      wanted: wantedEntry,
      head: head.get(path) ?? null,
      all: commits.map(commit => entryAt(commit.sha, path)),
    });
    if (reason) {
      throw refusal(stack, path, toucher, reason);
    }
    edited.push({ path, toucher, wanted: present(wantedEntry) });
  }

  if (edited.length) {
    const contentOf = await readContents(git, [
      ...edited.map(file => file.wanted.blob),
      ...edited.flatMap(({ path }) =>
        commits.flatMap(commit => entryAt(commit.sha, path)?.blob ?? [])
      ),
    ]);
    for (const { path, toucher, wanted: wantedEntry } of edited) {
      const read = (sha: string): string | null => {
        const entry = entryAt(sha, path);
        return entry ? (contentOf.get(entry.blob) ?? "") : null;
      };
      const wantedContent = contentOf.get(wantedEntry.blob) ?? "";
      const versions = [
        wantedContent,
        ...commits.map(commit => read(commit.sha)),
      ];
      if (versions.some(content => content !== null && isBinary(content))) {
        throw refusal(stack, path, toucher, "changed it, and it is not text");
      }
      const rebuilt = rebuildEdited(stack, {
        path,
        read,
        wanted: wantedContent,
      });
      for (const [sha, content] of rebuilt) {
        const entry = entryAt(sha, path);
        if (entry && content !== read(sha)) {
          const blob = await writeBlob(git, Buffer.from(content, "latin1"));
          record(sha, path, { mode: entry.mode, blob });
        }
      }
    }
  }

  const treeBySha = await withScratchIndex(
    git,
    "gsm-amend-index",
    async environment => {
      const built = new Map<string, string>();
      for (const [sha, perPath] of changes) {
        built.set(sha, await writeTree(git, environment, sha, perPath));
      }
      return built;
    }
  );
  const rewritten = await rebuildStack(git, snapshot, { treeBySha });
  const newSha = rewritten.get(targetSha);
  if (!newSha) {
    throw new GitError("Amend produced no new commit for the target.", "amend");
  }
  await git.run(["reset", "-q", "HEAD", "--", ...chosen.paths]);
  return { newSha, rewritten };
}

/**
 * New content for each commit whose copy of an edited text file has one, keyed by sha.
 *
 * The path to HEAD is placed as one owner map, so a new line beside a later commit's line keeps
 * the order HEAD shows. A commit on another branch has no such tip to read the order from, so its
 * parent's change is carried onto it on its own, strictly.
 */
function rebuildEdited(
  stack: Stack,
  file: { path: string; read: (sha: string) => string | null; wanted: string }
): Map<string, string> {
  const { path, read } = file;
  const next = new Map<string, string>();
  const revisions = stack.headPath.map(commit =>
    splitKeepingEnds(read(commit.sha) ?? "")
  );
  const pathMap = buildOwnerMap(revisions, diffLines);
  const placed = placeInTarget(
    pathMap,
    diffLines(revisions.at(-1) ?? [], splitKeepingEnds(file.wanted))
  );
  const contents = applyPlacement(
    pathMap,
    placed,
    revisions.length - 1,
    blockedBy =>
      refusal(
        stack,
        path,
        present(stack.headPath[blockedBy]),
        "changed the same lines"
      )
  );
  if (contents.at(-1) !== file.wanted) {
    throw new GitError(
      `${path}: the amend would not leave HEAD as chosen.`,
      "amend"
    );
  }
  stack.headPath.forEach((commit, index) => {
    const content = contents[index];
    // A commit without the file keeps it absent. `unplaceableReason` has ruled out HEAD being
    // one, so any line placed in such a commit is gone again by the tip.
    if (content !== undefined && read(commit.sha) !== null) {
      next.set(commit.sha, content);
    }
  });

  for (const { commit, parent } of stack.branches) {
    const before = read(parent);
    const after = next.get(parent);
    const own = read(commit.sha);
    if (
      before === null ||
      after === undefined ||
      after === before ||
      own === null
    ) {
      continue;
    }
    const map = buildOwnerMap(
      [splitKeepingEnds(before), splitKeepingEnds(own)],
      diffLines
    );
    const carried = carryOnto(
      map,
      diffLines(splitKeepingEnds(before), splitKeepingEnds(after))
    );
    const [, content] = applyPlacement(map, carried, 1, () =>
      refusal(stack, path, commit, "changed the same lines")
    );
    if (content !== undefined) {
      next.set(commit.sha, content);
    }
  }
  return next;
}

/** Each commit's rebuilt content, or the error `refuse` makes of the commit in the way. */
function applyPlacement(
  map: OwnerMap,
  placement: Placement,
  stackSize: number,
  refuse: (blockedBy: number) => GitError
): string[] {
  if ("blockedBy" in placement) {
    throw refuse(placement.blockedBy);
  }
  return applyFixups(map, placement.fixups, stackSize).map(lines =>
    lines.join("")
  );
}

/**
 * Why a file some later commit touched cannot be placed line by line, or null when it can.
 * `all` holds the file in every commit from the target up.
 */
function unplaceableReason(file: {
  original: Entry;
  wanted: Entry;
  head: Entry;
  all: Entry[];
}): string | null {
  if (!file.original) {
    return "added it after the target";
  }
  if (!file.wanted) {
    return "changed it, so it cannot be deleted below that";
  }
  if (!file.head) {
    return "changed it, and HEAD no longer has it";
  }
  const entries = [file.original, file.wanted, ...file.all];
  if (!entries.every(entry => !entry || isRegularFile(entry.mode))) {
    return "changed it, and it is not a regular file";
  }
  if (file.head.mode !== file.wanted.mode) {
    return "changed it, so its mode cannot change below that";
  }
  return null;
}

/**
 * Name the later commit that keeps `path` out of the target. Amending into that commit is the
 * way out when it leads to HEAD; a commit on another branch is not one HEAD can amend into.
 */
function refusal(
  stack: Stack,
  path: string,
  later: RawCommit,
  reason: string
): GitError {
  const onPath = stack.headPath.includes(later);
  const where = onPath ? "" : ", on another branch,";
  const hint = onPath
    ? `Amend into "${later.subject}" instead, or leave those changes out.`
    : "Leave those changes out, or amend into a commit above the fork.";
  return new GitError(
    `${path} cannot be amended into "${stack.target.subject}": ` +
      `"${later.subject}"${where} ${reason}. ${hint}`,
    "amend"
  );
}

/**
 * The commits an amend into `targetSha` rewrites, split by whether they lead to HEAD.
 *
 * The caller has checked that the target is a local ancestor of HEAD, and every commit above a
 * local commit is local too, so both walks stay inside the snapshot.
 */
function stackAbove(snapshot: RawData, targetSha: string): Stack {
  const bySha = new Map(snapshot.commits.map(commit => [commit.sha, commit]));
  const above = new Set<string>();
  const parentOf = new Map<string, string>();
  // Oldest first, so a commit's parent is in the set before the commit is considered.
  for (const commit of [...snapshot.commits].reverse()) {
    const parent = commit.parents.find(
      sha => sha === targetSha || above.has(sha)
    );
    if (parent !== undefined) {
      above.add(commit.sha);
      parentOf.set(commit.sha, parent);
    }
  }

  const headPath = [present(bySha.get(snapshot.headSha))];
  while (headPath[0]?.sha !== targetSha) {
    const parent = parentOf.get(present(headPath[0]).sha);
    headPath.unshift(
      present(parent === undefined ? undefined : bySha.get(parent))
    );
  }
  const onPath = new Set(headPath.map(commit => commit.sha));
  const branches = [...snapshot.commits]
    .reverse()
    .filter(commit => above.has(commit.sha) && !onPath.has(commit.sha))
    .map(commit => ({ commit, parent: present(parentOf.get(commit.sha)) }));
  return { target: present(headPath[0]), headPath, branches };
}

/** Every blob's content, read in one `cat-file --batch` and decoded byte for byte. */
async function readContents(
  git: GitRunner,
  blobs: string[]
): Promise<Map<string, string>> {
  const names = [...new Set(blobs)];
  const contents = await readObjects(git, names);
  return new Map(
    names.map((name, index) => [
      name,
      contents[index]?.toString("latin1") ?? "",
    ])
  );
}

function listTree(
  git: GitRunner,
  sha: string,
  paths: string[]
): Promise<Map<string, TreeEntry>> {
  return listEntries(git, ["ls-tree", "-r", "-z", sha, "--", ...paths], paths);
}

/**
 * Parse `ls-tree` or `ls-files --stage` records for `paths`. Both put the mode first and the path
 * after a tab; the blob is the third field in `ls-tree` and the second in `ls-files`.
 */
async function listEntries(
  git: GitRunner,
  command: string[],
  paths: string[],
  environment?: NodeJS.ProcessEnv
): Promise<Map<string, TreeEntry>> {
  const output = await git.run(
    command,
    environment ? { env: environment } : {}
  );
  const blobField = command[0] === "ls-tree" ? 2 : 1;
  const entries = new Map<string, TreeEntry>();
  for (const record of output.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const path = record.slice(tab + 1);
    const fields = record.slice(0, tab).split(" ");
    const mode = fields[0];
    const blob = fields[blobField];
    if (mode && blob && covers(paths, path)) {
      entries.set(path, { mode, blob });
    }
  }
  return entries;
}

/** Replace some paths in `sha`'s tree in one `update-index`, a null entry removing its path. */
async function writeTree(
  git: GitRunner,
  environment: NodeJS.ProcessEnv,
  sha: string,
  perPath: Map<string, Entry>
): Promise<string> {
  await git.run(["read-tree", sha], { env: environment });
  const records = [...perPath].map(([path, entry]) =>
    entry
      ? `${entry.mode} ${entry.blob}\t${path}\0`
      : `0 ${"0".repeat(sha.length)}\t${path}\0`
  );
  await git.run(["update-index", "-z", "--index-info"], {
    env: environment,
    input: records.join(""),
  });
  return git.run(["write-tree"], { env: environment });
}

/**
 * Whether `path` is one of `paths`, or inside a directory row among them. Git reads the arguments
 * as patterns, so a name holding a wildcard can list files nobody chose.
 */
function covers(paths: string[], path: string): boolean {
  return paths.some(
    chosen =>
      chosen === path || (chosen.endsWith("/") && path.startsWith(chosen))
  );
}

function sameEntry(left: Entry, right: Entry): boolean {
  return left?.mode === right?.mode && left?.blob === right?.blob;
}

/** A regular file, executable or not; symbolic links and submodules have no lines. */
function isRegularFile(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

/** Git's own heuristic: a NUL in the first 8000 bytes means binary. */
function isBinary(content: string): boolean {
  return content.slice(0, 8000).includes("\0");
}

function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new GitError(
      "Amend lost track of a commit or file it had read.",
      "amend"
    );
  }
  return value;
}
