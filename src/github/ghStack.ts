/**
 * ghStack — read the `gh stack` extension's local state, and drive its commands.
 *
 * GitHub's stacked pull requests (public preview) already model the thing this
 * extension draws: an ordered chain of branches, each based on the one below,
 * submitted as linked PRs. Where `gh stack` has a command, calling it beats
 * reimplementing the behaviour — it owns the server-side stack object, and a
 * hand-rolled equivalent would drift from it.
 *
 * Stack membership is read from `.git/gh-stack` rather than from
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
import { existsSync, readFileSync } from "fs";
import { asArray, asRecord } from "#core/values";

/** The schema of `.git/gh-stack` this reader understands. */
const SUPPORTED_SCHEMA_VERSION = 1;

export type GhStackBranch = {
  branch: string;
  /** Sha the branch is based on — the tip of the layer below, or trunk. */
  base: string;
};

export type GhStackInfo = {
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
 * Read every stack `gh stack` tracks in this repository. Returns an empty list
 * when the extension is not in use, which is the common case.
 */
export function readGhStacks(gitDirectory: string): GhStackInfo[] {
  const statePath = `${gitDirectory}/gh-stack`;
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
    .map(readStack)
    .filter((stack): stack is GhStackInfo => stack !== null);
}

function readStack(value: unknown): GhStackInfo | null {
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
