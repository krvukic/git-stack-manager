/**
 * Throwaway repositories, and the git reads that check what an operation did to one.
 *
 * Every suite here drives real git against a real repository, so each one needs a
 * directory of its own and a way to read the result back. Both were written per file
 * before this module existed, which is why the same four-line `rev-parse` wrapper
 * appeared under three different names.
 *
 * Cleanup is registered rather than called at the end of a test. A trailing
 * `rmSync(root)` never runs when an assertion above it fails, so every failure used to
 * strand a repository in the temp directory — and a suite debugged by re-running it left
 * one per attempt.
 *
 * `scripts/git-fixture.mjs` holds the primitives the demo generator shares; this file
 * holds what only a test needs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "#app/repository";
import {
  commitFile,
  initRepoWithOrigin,
  ME,
  OTHER,
  run,
} from "../scripts/git-fixture.mjs";

/**
 * Where to register cleanup. A test's own context builds and tears down per test; the
 * `after` hook imported from `node:test`, passed as `{ after }`, does it once for a
 * fixture every test in a file shares.
 *
 * @typedef {{ after(callback: () => void): void }} CleanupScope
 */
/** @typedef {import("../scripts/git-fixture.mjs").CommitIdentity} CommitIdentity */

/**
 * A temporary directory, removed however the tests end.
 *
 * @param {CleanupScope} scope
 * @param {string} prefix
 */
export function scratchRoot(scope, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  removeAfterwards(scope, root, null);
  return root;
}

/**
 * Remove `root` however the tests end, running `inspect` first.
 *
 * The order is the point: a sweep of what the operations left behind has to read the
 * repository while it is still there, and node runs `after` callbacks in the order they were
 * registered. One callback doing both settles that, rather than two whose order a reader has
 * to know.
 *
 * @param {CleanupScope} scope
 * @param {string} root
 * @param {(() => void) | null} inspect
 */
function removeAfterwards(scope, root, inspect) {
  scope.after(() => {
    try {
      inspect?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

/**
 * Fail the test if the operations it drove left scratch state in the repository.
 *
 * Every rewrite plants some: marker refs under `refs/heads/gsm-rebase`, a plan file and a
 * scratch index in the git directory. Each operation removes its own in a `finally`, and each
 * suite checks the result of the operation it drove — so a leak survives as long as the damage
 * it does lands in another test. A marker left on abandoned history sends the next rebase's
 * chains back onto it, and one left on live history draws a branch pill for a branch nobody
 * made. Sweeping every fixture turns all of them into detectors, on shapes no single suite
 * thought to check: forks, sibling stacks, a detached HEAD.
 *
 * A paused rebase keeps its scratch state, because the operation has not finished. Staged
 * files are nobody's business here — `commit` deliberately leaves a file the reader staged
 * alone, and the suites that check that end with one staged.
 *
 * @param {string} repo
 */
function assertNoScratchState(repo) {
  const gitDirectory = join(repo, ".git");
  if (
    existsSync(join(gitDirectory, "rebase-merge")) ||
    existsSync(join(gitDirectory, "rebase-apply"))
  ) {
    return;
  }
  assert.deepEqual(
    {
      markers: markerRefs(repo),
      scratch: readdirSync(gitDirectory).filter(entry =>
        entry.startsWith("gsm-")
      ),
    },
    { markers: "", scratch: [] }
  );
}

/**
 * A repository with a bare origin and one pushed trunk commit.
 *
 * The trunk commit is authored by the teammate identity by default, so it reads as
 * someone else's work — which is what a pushed trunk is, and what several suites
 * distinguish their own commits from.
 *
 * @param {CleanupScope} scope
 * @param {string} prefix
 * @param {{ file?: string, content?: string, message?: string, identity?: CommitIdentity }} [options]
 */
export function trunkRepository(
  scope,
  prefix,
  {
    file = "base.txt",
    content = "base\n",
    message = "initial",
    identity = OTHER,
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const { origin, repo } = initRepoWithOrigin(root);
  removeAfterwards(scope, root, () => assertNoScratchState(repo));
  commitFile(repo, file, content, message, identity);
  run(repo, "git", ["push", "-u", "origin", "main"]);
  return { root, origin, repo, repository: new Repository(repo) };
}

/**
 * Add a branch per commit above the current HEAD, bottom layer first.
 *
 * The shape nearly every operation is tested against: one commit, one branch, stacked.
 * A layer's content defaults to its own branch name, which is enough whenever no
 * assertion reads the file.
 *
 * @param {string} repo
 * @param {{ branch: string, file: string, message: string, content?: string }[]} layers
 * @param {CommitIdentity} [identity]
 */
export function stackBranches(repo, layers, identity = ME) {
  for (const { branch, file, message, content } of layers) {
    run(repo, "git", ["switch", "-qc", branch]);
    commitFile(repo, file, content ?? `${branch}\n`, message, identity);
  }
}

/**
 * The workflow this extension exists for: one commit per branch, three layers deep, with
 * trunk advanced past the fork point by someone else and a fourth branch cut from the
 * newer tip.
 *
 * Building it costs about a second of git, so the suites that use it share one copy per
 * file and pass `{ after }` rather than a test context. The two trunk commits come back
 * named, because `forkPoint` (where the stack was cut) and `newTrunkTip` (three commits
 * later) are what the base and ellipsis assertions are about.
 *
 * @param {CleanupScope} scope
 * @param {string} prefix
 */
export function branchPerCommitStack(scope, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const { origin, repo } = initRepoWithOrigin(root);
  removeAfterwards(scope, root, () => assertNoScratchState(repo));
  commitFile(repo, "README.md", "hello\n", "initial commit", OTHER);
  commitFile(repo, "app.js", "console.log(1)\n", "add app", OTHER);
  run(repo, "git", ["push", "-u", "origin", "main"]);
  const forkPoint = shaOf(repo, "HEAD");

  stackBranches(repo, [
    {
      branch: "feature-a",
      file: "a.txt",
      message: "feat: part A",
      content: "A\n",
    },
    {
      branch: "feature-b",
      file: "b.txt",
      message: "feat: part B\n\nlonger description here",
      content: "B\n",
    },
    {
      branch: "feature-c",
      file: "c.txt",
      message: "feat: part C",
      content: "C\n",
    },
  ]);

  // Trunk moves on by three merged pull requests while the stack sits where it was.
  run(repo, "git", ["switch", "-q", "main"]);
  for (let index = 1; index <= 3; index++) {
    commitFile(
      repo,
      `main${index}.txt`,
      `${index}\n`,
      `other work ${index}`,
      OTHER
    );
  }
  run(repo, "git", ["push", "origin", "main"]);
  const newTrunkTip = shaOf(repo, "HEAD");

  // A second stack cut from the newer tip, so one repository holds both a stale fork
  // point and a current one.
  run(repo, "git", ["switch", "-qc", "hotfix"]);
  commitFile(repo, "hotfix.txt", "fix\n", "fix: urgent thing");
  run(repo, "git", ["switch", "-q", "feature-c"]);

  return {
    root,
    origin,
    repo,
    repository: new Repository(repo),
    forkPoint,
    newTrunkTip,
  };
}

/**
 * Clone `origin` again under `root`, as the teammate.
 *
 * A branch cannot fall behind a remote it is the only one pushing to, so a second clone
 * is what makes `origin/main` the newer ref.
 *
 * @param {string} root
 * @param {string} origin
 * @param {string} [name]
 */
export function teammateClone(root, origin, name = "other") {
  const clone = join(root, name);
  run(root, "git", ["clone", "-q", origin, name]);
  run(clone, "git", ["config", "user.name", OTHER.GIT_AUTHOR_NAME]);
  run(clone, "git", ["config", "user.email", OTHER.GIT_AUTHOR_EMAIL]);
  return clone;
}

/**
 * Commit a file in the teammate's clone and push it to trunk.
 *
 * @param {string} clone
 * @param {string} file
 * @param {string} message
 */
export function pushFromClone(clone, file, message) {
  commitFile(clone, file, `${file}\n`, message, OTHER);
  run(clone, "git", ["push", "-q", "origin", "main"], OTHER);
}

/**
 * @param {string} repo
 * @param {string} ref
 */
export const shaOf = (repo, ref) => run(repo, "git", ["rev-parse", ref]);

/** @param {string} repo */
export const statusOf = repo => run(repo, "git", ["status", "--porcelain"]);

/**
 * The paths a commit changed, sorted so an assertion does not depend on git's order.
 *
 * @param {string} repo
 * @param {string} ref
 */
export const filesIn = (repo, ref) =>
  run(repo, "git", ["show", "--name-only", "--format=", ref])
    .split("\n")
    .filter(Boolean)
    .sort();

/**
 * One path's content at one ref.
 *
 * @param {string} repo
 * @param {string} ref
 * @param {string} path
 */
export const fileAt = (repo, ref, path) =>
  run(repo, "git", ["show", `${ref}:${path}`]);

/**
 * Every local branch and the commit it points at.
 *
 * @param {string} repo
 * @returns {Map<string, string>}
 */
export const branchShas = repo =>
  new Map(
    run(repo, "git", [
      "for-each-ref",
      "--format=%(refname:short) %(objectname)",
      "refs/heads",
    ])
      .split("\n")
      .filter(Boolean)
      .map(line => /** @type {[string, string]} */ (line.split(" ")))
  );

/**
 * The scratch refs a rebase creates, of which a finished one leaves none.
 *
 * Empty is the passing answer. A surviving marker draws a branch pill for a branch
 * nobody made, so every rebase test ends by reading this.
 *
 * @param {string} repo
 */
export const markerRefs = repo =>
  run(repo, "git", [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/gsm-rebase",
  ]);
