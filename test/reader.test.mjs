/**
 * Reading a repository, in the shapes that are easy to get wrong.
 *
 * `integration.test.mjs` reads through a well-formed stack. These cover the states the
 * reader has explicit handling for but which a normal fixture never reaches: a repository
 * with no commits, one with nothing that looks like a trunk, an explicit `gsm.trunk`
 * override, the rename records that make `status --porcelain=v2` parsing fiddly, and a git
 * older than the floor.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Repository } from "#app/repository";
import { parseStatus } from "#git/statusParser";
import {
  commitFile,
  initRepoWithOrigin,
  run,
} from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import { scratchRoot, shaOf, trunkRepository } from "./repoFixture.mjs";

/**
 * A repository with no origin and no commits yet.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} [initialBranch]
 */
function bareScratch(t, initialBranch = "main") {
  const root = scratchRoot(t, "gsm-reader-");
  run(root, "git", ["init", "-q", "-b", initialBranch, "."]);
  run(root, "git", ["config", "user.email", "reader@example.com"]);
  run(root, "git", ["config", "user.name", "Reader"]);
  return root;
}

/**
 * Put a shell script ahead of git on PATH for the rest of the test.
 *
 * The two version tests need a git that answers `git version` their way and delegates
 * everything else. The script resolves git by absolute path, because resolving by name
 * would re-enter the shim once its own directory is on PATH.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} root
 * @param {string[]} versionBody
 */
function shimGitVersion(t, root, versionBody) {
  const realGit = run(root, "sh", ["-c", "command -v git"]);
  const binDirectory = join(root, "bin");
  mkdirSync(binDirectory);
  const shim = join(binDirectory, "git");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "version" ]; then',
      ...versionBody,
      "fi",
      `exec ${realGit} "$@"`,
    ].join("\n")
  );
  chmodSync(shim, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
}

/**
 * The status letter a path was reported with. Naming the path in the failure is the
 * point: a parser that shifts its fields drops entries, and "no change for added.txt"
 * says that outright.
 *
 * @param {Map<string, import("#git/snapshot").FileChange>} byPath
 * @param {string} path
 */
const changeStatus = (byPath, path) =>
  present(byPath.get(path), `a change for ${path}`).status;

test("an empty repository reads as empty rather than failing", async t => {
  const root = bareScratch(t);
  // `git rev-parse HEAD` fails on an unborn branch, so the reader has to treat a
  // fresh `git init` as a valid state — this is what the user sees before the
  // first commit.
  const snapshot = await new Repository(root).read();
  assert.equal(snapshot.headSha, "");
  assert.deepEqual(snapshot.commits, []);
  assert.deepEqual(snapshot.bases, []);
  assert.equal(snapshot.trunkRef, null);
  assert.equal(snapshot.conflict, null);
});

test("a repository with no trunk-shaped branch still reads its commits", async t => {
  const root = bareScratch(t, "topic");
  writeFileSync(join(root, "f.txt"), "x\n");
  run(root, "git", ["add", "-A"]);
  run(root, "git", ["commit", "-qm", "only commit"]);

  // No origin and no main/master, so trunk detection finds nothing. Without a
  // trunk there is no "local only" range, so every commit is simply listed.
  const snapshot = await new Repository(root).read();
  assert.equal(snapshot.trunkRef, null);
  assert.equal(snapshot.trunkTip, null);
  assert.equal(snapshot.commits.length, 1);
  assert.equal(snapshot.headBranch, "topic");
});

test("an explicit trunk override is honoured over auto-detection", async t => {
  const root = bareScratch(t, "develop");
  writeFileSync(join(root, "f.txt"), "x\n");
  run(root, "git", ["add", "-A"]);
  run(root, "git", ["commit", "-qm", "base"]);
  run(root, "git", ["switch", "-qc", "feature"]);
  commitFile(root, "g.txt", "y\n", "feat");

  // This is the `gsm.trunk` setting: a repository whose trunk is neither `main`
  // nor `master` and has no remote.
  const snapshot = await new Repository(root, "develop").read();
  assert.equal(snapshot.trunkRef, "develop");
  assert.equal(
    snapshot.commits.length,
    1,
    "only the commit above develop counts as local work"
  );
  assert.equal(snapshot.commits[0].subject, "feat");
});

/**
 * Which branches no checkout here can reach.
 *
 * Git binds a branch to one worktree, so `git switch` to a branch a second worktree holds
 * fails outright. Every Goto reads this map to name the directory rather than relaying git's
 * refusal, so it has to carry the branch that is elsewhere and leave out both the branch
 * checked out right here and the ones nothing holds.
 */
test("a branch a second worktree holds is the only one reported as held", async t => {
  const { root, repo, repository } = trunkRepository(t, "gsm-reader-worktree-");
  run(repo, "git", ["switch", "-qc", "here"]);
  run(repo, "git", ["switch", "-qc", "free"]);
  run(repo, "git", ["switch", "-q", "here"]);
  const held = join(root, "elsewhere");
  run(repo, "git", ["worktree", "add", "-q", held, "main"]);

  const snapshot = await repository.read();

  assert.deepEqual(
    [...snapshot.heldBranches.entries()],
    [["main", realpathSync(held)]]
  );
});

test("renames are read with both paths, committed and uncommitted", async t => {
  const root = scratchRoot(t, "gsm-reader-rename-");
  const { repo } = initRepoWithOrigin(root);
  commitFile(repo, "old.txt", "content\nline two\n", "add old.txt");
  run(repo, "git", ["push", "-u", "origin", "main"]);
  run(repo, "git", ["switch", "-qc", "feature"]);
  run(repo, "git", ["mv", "old.txt", "new.txt"]);
  run(repo, "git", ["commit", "-qm", "rename old.txt"]);

  const repository = new Repository(repo);
  const files = await repository.filesForCommit(shaOf(repo, "HEAD"));
  assert.deepEqual(files, [
    { status: "R", oldPath: "old.txt", path: "new.txt" },
  ]);

  // A rename in `status --porcelain=v2` is a "2" record carrying two
  // NUL-separated paths, which is the one entry type that can desynchronise the
  // parse and shift every following file.
  run(repo, "git", ["mv", "new.txt", "renamed-again.txt"]);
  writeFileSync(join(repo, "added.txt"), "new file\n");
  run(repo, "git", ["add", "added.txt"]);
  writeFileSync(join(repo, "untracked.txt"), "loose\n");

  const snapshot = await repository.read();
  const byPath = new Map(
    snapshot.uncommitted.map(change => [change.path, change])
  );
  assert.deepEqual(byPath.get("renamed-again.txt"), {
    status: "R",
    path: "renamed-again.txt",
    oldPath: "new.txt",
  });
  assert.equal(
    changeStatus(byPath, "added.txt"),
    "A",
    "the entry after a rename is still aligned"
  );
  assert.equal(changeStatus(byPath, "untracked.txt"), "?");
});

test("the status parser handles each porcelain v2 record type", () => {
  // Built by hand so the awkward records can be checked without contriving a
  // repository for each: a rename carries two NUL-separated paths, and getting its
  // field count wrong shifts every entry after it.
  const output = [
    "# branch.oid abc123",
    "# branch.head feature",
    "1 .M N... 100644 100644 100644 aaa bbb modified.txt",
    "1 A. N... 000000 100644 100644 000 ccc staged-add.txt",
    "2 RM N... 100644 100644 100644 ddd eee R100 renamed.txt\0was.txt",
    "u UU N... 100644 100644 100644 100644 fff ggg hhh conflicted.txt",
    "? untracked.txt",
    "! ignored.txt",
  ].join("\0");

  const result = parseStatus(output);
  assert.equal(result.headSha, "abc123");
  assert.equal(result.headBranch, "feature");
  assert.equal(
    result.hasUnmerged,
    true,
    "a 'u' record signals an interrupted rebase"
  );

  const byPath = new Map(
    result.uncommitted.map(change => [change.path, change])
  );
  assert.equal(changeStatus(byPath, "modified.txt"), "M");
  assert.equal(changeStatus(byPath, "staged-add.txt"), "A");
  assert.deepEqual(byPath.get("renamed.txt"), {
    status: "R",
    path: "renamed.txt",
    oldPath: "was.txt",
  });
  assert.equal(changeStatus(byPath, "conflicted.txt"), "U");
  assert.equal(changeStatus(byPath, "untracked.txt"), "?");
  assert.equal(
    byPath.has("ignored.txt"),
    false,
    "ignored files are not changes"
  );
});

test("the status parser reads an unborn branch and a detached HEAD", () => {
  // `(initial)` before the first commit and `(detached)` off a branch are the two
  // placeholder values git substitutes for a real sha or name.
  const unborn = parseStatus(
    ["# branch.oid (initial)", "# branch.head main"].join("\0")
  );
  assert.equal(unborn.headSha, null);
  assert.equal(unborn.headBranch, "main");

  const detached = parseStatus(
    ["# branch.oid abc123", "# branch.head (detached)"].join("\0")
  );
  assert.equal(detached.headSha, "abc123");
  assert.equal(detached.headBranch, null);
});

test("git below the floor is reported as a version error, not an empty graph", async t => {
  // Git 2.45 is the floor because `for-each-ref --include-root-refs` fails the whole
  // ref query on anything older. Left unchecked, that reads as an empty repository:
  // no branch pills, no sync badges, no trunk.
  const { root, repo } = trunkRepository(t, "gsm-oldgit-", { file: "f.txt" });
  shimGitVersion(t, root, ['  echo "git version 2.44.0"', "  exit 0"]);

  await assert.rejects(
    () => new Repository(repo).read(),
    // The found version belongs in the message: "needs 2.45" alone leaves the user
    // guessing which git of theirs is on PATH.
    /needs git 2\.45 or newer .*2\.44\.0/
  );
});

test("the version probe runs once per repository, not once per read", async t => {
  // The UI polls on a timer and the file watcher refreshes on every ref change, so a
  // per-read probe would spawn a process per refresh forever to re-answer a question
  // whose answer cannot change while the panel is open.
  const { root, repo } = trunkRepository(t, "gsm-version-", { file: "f.txt" });
  const countFile = join(root, "version-calls");
  shimGitVersion(t, root, [`  echo x >>"${countFile}"`]);

  const repository = new Repository(repo);
  await repository.read();
  await repository.read();
  await repository.read();
  assert.equal(readFileSync(countFile, "utf8").trim().split("\n").length, 1);
});
