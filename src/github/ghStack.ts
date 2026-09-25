/**
 * ghStack — read the `gh stack` extension's local state, and drive its commands.
 *
 * GitHub's stacked pull requests (public preview) already model the thing this
 * extension draws: an ordered chain of branches, each based on the one below,
 * submitted as linked PRs. Where `gh stack` has a command, calling it beats
 * reimplementing the behaviour — it owns the server-side stack object, and a
 * hand-rolled equivalent would drift from it.
 *
 * Stack membership is read from the `gh-stack` state file rather than from
 * `gh stack view --json`. The file is the extension's own state, carries an
 * explicit `schemaVersion`, and reading it costs nothing; shelling out to `gh`
 * costs ~0.5s and would put a subprocess in the render path for information
 * already sitting on disk. The commands themselves still go through `gh`.
 *
 * ## The on-disk format is not a public API
 *
 * `.git/gh-stack` is an implementation detail of a **public-preview** extension,
 * so unlike `gh stack view --json` it carries no compatibility promise. Two things
 * guard against a format change: the `schemaVersion` check below bails out rather
 * than guessing, and `needsRebase` is derived here but verified against
 * `gh stack view --json` in the tests, so a divergence shows up as a test failure
 * rather than a wrong badge.
 *
 * **Keeping in sync:** when `gh stack` releases a new version, run
 * `gh stack view --json` against a repository with a stack and compare it to what
 * this module reports. If the schema version has moved, read the new file and
 * decide whether the extra fields are worth adopting; if the badges silently
 * disappear, that is the version check doing its job.
 *
 * - Feature docs: https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests
 * - CLI reference: https://cli.github.com/manual/gh_stack
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { asArray, asRecord } from "#core/values";
import { GitError, GitRunner } from "#git/runner";
import { runGh } from "#github/ghRunner";

/** The schema of `.git/gh-stack` this reader understands. */
const SUPPORTED_SCHEMA_VERSION = 1;

export type GhStackBranch = {
  branch: string;
  /** Sha the branch is based on — the tip of the layer below, or trunk. */
  base: string;
};

export type GhStackInfo = {
  /**
   * The checkout whose git directory holds this stack's state. `gh stack` finds a stack
   * only from there, and only through the branch checked out there.
   */
  workingDirectory: string;
  trunkBranch: string;
  trunkHead: string;
  /** Branches bottom-to-top, the order `gh stack` replays them in. */
  branches: GhStackBranch[];
};

/** Per-branch stack placement, for annotating the graph. */
export type StackMembership = {
  /** 1-based position from the bottom of the stack. */
  position: number;
  size: number;
  /** The branch's recorded base no longer matches its parent — needs a rebase. */
  needsRebase: boolean;
};

/**
 * Read every stack `gh stack` tracks in this repository, in any of its worktrees. Returns
 * an empty list when the extension is not in use, which is the common case.
 *
 * `gh stack` keeps its state per worktree, in `git rev-parse --git-dir`, not in the common
 * directory: `gh stack init` run in a linked worktree writes `.git/worktrees/<name>/gh-stack`,
 * and the main checkout's `gh stack view` then reports "not part of a stack". Branches are
 * shared across worktrees, so every worktree's stacks describe branches this checkout draws.
 * `ownGitDirectory` goes first, so a branch tracked in two worktrees takes this one's stack.
 */
export function readGhStacks(
  commonDirectory: string,
  ownGitDirectory: string = commonDirectory
): GhStackInfo[] {
  const worktreesDirectory = join(commonDirectory, "worktrees");
  const linked = existsSync(worktreesDirectory)
    ? readdirSync(worktreesDirectory).map(name =>
        join(worktreesDirectory, name)
      )
    : [];
  const gitDirectories = [commonDirectory, ...linked].sort(
    (left, right) =>
      Number(right === ownGitDirectory) - Number(left === ownGitDirectory)
  );
  return gitDirectories.flatMap(gitDirectory => {
    const workingDirectory = workingDirectoryOf(commonDirectory, gitDirectory);
    return workingDirectory
      ? readStateFile(join(gitDirectory, "gh-stack"), workingDirectory)
      : [];
  });
}

/**
 * The checkout a git directory belongs to. A linked worktree's `gitdir` file names its
 * `.git` file; the main checkout is the common directory's parent. Null for a worktree
 * whose checkout was deleted without `git worktree prune`, where `gh stack` cannot run.
 */
function workingDirectoryOf(
  commonDirectory: string,
  gitDirectory: string
): string | null {
  if (gitDirectory === commonDirectory) {
    return dirname(commonDirectory);
  }
  try {
    const dotGit = readFileSync(join(gitDirectory, "gitdir"), "utf8").trim();
    return existsSync(dotGit) ? dirname(dotGit) : null;
  } catch {
    return null;
  }
}

function readStateFile(
  statePath: string,
  workingDirectory: string
): GhStackInfo[] {
  if (!existsSync(statePath)) {
    return [];
  }
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return []; // truncated or hand-edited state
  }
  const root = asRecord(state);
  // An unknown schema means `gh stack` changed its format. Ignoring it loses
  // badges; guessing at it would show wrong ones.
  if (root?.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return [];
  }

  return asArray(root.stacks)
    .map(stack => readStack(stack, workingDirectory))
    .filter((stack): stack is GhStackInfo => stack !== null);
}

function readStack(
  value: unknown,
  workingDirectory: string
): GhStackInfo | null {
  const stack = asRecord(value);
  if (!stack) {
    return null;
  }
  const trunk = asRecord(stack.trunk);
  const branches = asArray(stack.branches)
    .map(asRecord)
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry?.branch === "string"
    )
    .map(entry => ({
      branch: String(entry.branch),
      base: typeof entry.base === "string" ? entry.base : "",
    }));
  if (!branches.length) {
    return null;
  }
  return {
    workingDirectory,
    trunkBranch: typeof trunk?.branch === "string" ? trunk.branch : "",
    trunkHead: typeof trunk?.head === "string" ? trunk.head : "",
    branches,
  };
}

/**
 * Map each stacked branch to its position, and flag branches whose recorded
 * base has drifted from where the branch actually sits.
 *
 * `gh stack` records the base *sha* per branch, so comparing it to the current
 * tip of the layer below detects the "needs rebase" state that GitHub's own UI
 * shows — without asking `gh`.
 */
export function indexStackMembership(
  stacks: GhStackInfo[],
  shaOfBranch: Map<string, string>
): Map<string, StackMembership> {
  const membership = new Map<string, StackMembership>();
  for (const stack of stacks) {
    stack.branches.forEach((entry, index) => {
      // The first stack read wins, which `readGhStacks` orders to be this checkout's own.
      if (membership.has(entry.branch)) {
        return;
      }
      const below =
        index === 0
          ? stack.trunkBranch
          : (stack.branches[index - 1]?.branch ?? stack.trunkBranch);
      const expectedBase =
        index === 0 ? stack.trunkHead : shaOfBranch.get(below);
      const actualBase = shaOfBranch.get(below) ?? expectedBase;
      membership.set(entry.branch, {
        position: index + 1,
        size: stack.branches.length,
        // A recorded base that no longer matches the layer below means the lower
        // branch moved (amended or rebased) and this one still points at the old
        // commit — exactly GitHub's "needs rebase".
        needsRebase: Boolean(
          entry.base && actualBase && entry.base !== actualBase
        ),
      });
    });
  }
  return membership;
}

/** Commands this extension delegates to `gh stack`, with what each one means. */
export type GhStackCommand =
  | { kind: "submit" }
  | { kind: "sync"; prune: boolean }
  | { kind: "push" }
  | { kind: "rebase"; scope: "all" | "downstack" | "upstack" };

/** The `gh` invocation for a command, run through `#github/ghRunner` like any other. */
export function ghStackArguments(command: GhStackCommand): string[] {
  switch (command.kind) {
    case "submit":
      return ["stack", "submit"];
    case "sync":
      // --prune drops local branches whose PRs merged, which is the state this
      // extension otherwise renders as "upstream gone".
      return command.prune ? ["stack", "sync", "--prune"] : ["stack", "sync"];
    case "push":
      // gh stack push uses --force-with-lease, so an amended stack updates
      // safely instead of needing a manual force push.
      return ["stack", "push"];
    case "rebase":
      if (command.scope === "downstack") {
        return ["stack", "rebase", "--downstack"];
      }
      if (command.scope === "upstack") {
        return ["stack", "rebase", "--upstack"];
      }
      return ["stack", "rebase"];
  }
}

/**
 * Run a `gh stack` command on the stack holding `branch`, from wherever that stack lives.
 *
 * `gh stack` picks its stack from the branch checked out, in the worktree whose git
 * directory holds the state, and refuses anything else: `not part of a stack` from any
 * other checkout, `not on any branch` from a detached HEAD. Running it in this panel's
 * checkout therefore failed for every stack initialised in a linked worktree.
 *
 * A detached owner at the tip of one of the stack's branches gets that branch attached
 * for the command and detached again afterwards. Switching between a sha and the branch
 * pointing at it touches no file, and detaching again frees the branch for checking out
 * elsewhere. A checkout on some other branch or commit is refused rather than moved,
 * because moving it would rewrite files someone may be editing.
 */
export async function runGhStackCommand(
  git: GitRunner,
  command: GhStackCommand,
  branch: string
): Promise<string> {
  const [commonDirectory = "", ownGitDirectory] = (
    await git.run([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--git-dir",
    ])
  )
    .trim()
    .split("\n");
  const stack = readGhStacks(commonDirectory, ownGitDirectory).find(entry =>
    entry.branches.some(layer => layer.branch === branch)
  );
  if (!stack) {
    throw new GitError(`${branch} is not in a gh stack.`, "gh stack");
  }
  const directory = stack.workingDirectory;
  const attached = await attachToStack(git, directory, stack);
  try {
    return await runGh(git, ghStackArguments(command), undefined, directory);
  } finally {
    // A rebase stopped on a conflict needs the branch until `gh stack rebase --continue`.
    if (attached && !(await rebaseInProgress(git, directory))) {
      await git.tryRun(["-C", directory, "switch", "--quiet", "--detach"]);
    }
  }
}

function rebaseInProgress(git: GitRunner, directory: string): Promise<boolean> {
  return git.succeeds([
    "-C",
    directory,
    "rev-parse",
    "--verify",
    "--quiet",
    "REBASE_HEAD",
  ]);
}

/** Put `directory` on one of the stack's branches, returning whether it had to attach one. */
async function attachToStack(
  git: GitRunner,
  directory: string,
  stack: GhStackInfo
): Promise<boolean> {
  const names = stack.branches.map(layer => layer.branch);
  const current = (
    await git.tryRun([
      "-C",
      directory,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ])
  )?.trim();
  if (current && names.includes(current)) {
    return false;
  }
  const choices = `Check out one of ${names.join(", ")} there first.`;
  if (current) {
    throw new GitError(
      `gh stack acts on the checked-out branch, and ${directory} has ${current} checked out. ${choices}`,
      "gh stack"
    );
  }
  const head = (await git.run(["-C", directory, "rev-parse", "HEAD"])).trim();
  const tips = await git.run([
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(worktreepath)",
    ...names.map(name => `refs/heads/${name}`),
  ]);
  // A branch another worktree holds cannot be checked out here.
  const atHead = tips
    .split("\n")
    .map(line => line.split("\0"))
    .find(([, sha, worktree]) => sha === head && !worktree)?.[0];
  if (!atHead) {
    throw new GitError(
      `gh stack acts on the checked-out branch, and ${directory} is detached at ${head.slice(0, 7)}. ${choices}`,
      "gh stack"
    );
  }
  await git.run(["-C", directory, "switch", "--quiet", atHead]);
  return true;
}
