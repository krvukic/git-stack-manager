/**
 * Absorb over a real repository. The decision table lives in `absorb-placement.test.mjs`;
 * these cover what only a repository can show — that the rewrite is conflict-free, that
 * unplaceable changes survive, and that a file with no line ownership is left alone.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../scripts/git-fixture.mjs";
import { fileAt, shaOf, statusOf, trunkRepository } from "./repoFixture.mjs";

/**
 * A stack where each commit owns one region of `f.txt`, so a change to a region has
 * exactly one right home.
 *
 * @param {import("node:test").TestContext} t
 */
function buildFixture(t) {
  const fixture = trunkRepository(t, "gsm-absorb-", { file: "f.txt" });
  const { repo } = fixture;
  /** @param {string} content */
  const write = content => writeFileSync(join(repo, "f.txt"), content);

  run(repo, "git", ["switch", "-qc", "layer-a"]);
  write("base\nA\n");
  run(repo, "git", ["commit", "-qam", "add A"]);
  run(repo, "git", ["switch", "-qc", "layer-b"]);
  write("base\nA\nB\n");
  run(repo, "git", ["commit", "-qam", "add B"]);
  return { ...fixture, write };
}

/**
 * @param {string} repo
 * @param {string} ref
 */
const contentAt = (repo, ref) => fileAt(repo, ref, "f.txt");

/**
 * Staged and unstaged paths, separately.
 *
 * `statusOf` reports both in one two-letter column, and the leading space that marks
 * "unstaged only" does not survive the trim `run` applies — so an assertion on it reads as
 * its own opposite.
 *
 * @param {string} repo
 */
const stagedIn = repo => run(repo, "git", ["diff", "--cached", "--name-only"]);
/** @param {string} repo */
const modifiedIn = repo => run(repo, "git", ["diff", "--name-only"]);

test("each edit lands in the commit that introduced the line", async t => {
  const { repo, write, repository } = buildFixture(t);
  write("base\nA-fixed\nB-fixed\n");

  const result = await repository.absorb();
  assert.equal(result.appliedHunks, 2);
  assert.equal(result.skippedHunks, 0);

  assert.equal(contentAt(repo, "layer-a"), "base\nA-fixed");
  assert.equal(contentAt(repo, "layer-b"), "base\nA-fixed\nB-fixed");
  // The base is published, so its line is untouched everywhere.
  assert.match(contentAt(repo, "layer-a"), /^base/);
  // Nothing was left behind: the changes now live in the commits.
  assert.equal(statusOf(repo), "");
});

test("absorb rewrites ancestors without a checkout or a conflict", async t => {
  const { repo, write, repository } = buildFixture(t);
  // A second file left dirty proves absorb does not check anything out: a real
  // checkout of layer-a would have to reconcile this.
  writeFileSync(join(repo, "untracked.txt"), "scratch\n");
  write("base\nA-fixed\nB\n");

  const before = shaOf(repo, "HEAD");
  await repository.absorb();

  assert.notEqual(shaOf(repo, "HEAD"), before, "the stack was rebuilt");
  assert.equal(contentAt(repo, "layer-a"), "base\nA-fixed");
  assert.equal(
    readFileSync(join(repo, "untracked.txt"), "utf8"),
    "scratch\n",
    "untouched"
  );
  assert.equal(
    run(repo, "git", ["symbolic-ref", "--short", "HEAD"]),
    "layer-b"
  );
});

test("a change that cannot be placed stays in the working copy", async t => {
  const { repo, write, repository } = buildFixture(t);
  // Replacing the whole file with a different line count spans all three owners
  // and is not 1:1, so absorb declines it.
  write("one\ntwo\nthree\nfour\nfive\n");

  const result = await repository.absorb();
  assert.equal(result.appliedHunks, 0);
  assert.equal(result.skippedHunks, 1);
  assert.equal(contentAt(repo, "layer-b"), "base\nA\nB", "commits untouched");
  // The user's edit must survive, since absorb is meant to be re-runnable.
  assert.equal(
    readFileSync(join(repo, "f.txt"), "utf8"),
    "one\ntwo\nthree\nfour\nfive\n"
  );
  assert.match(result.outcomes[0].skipped[0].reason, /several commits|1:1/);
});

test("undo restores the stack after an absorb", async t => {
  const { repo, write, repository } = buildFixture(t);
  const before = {
    a: shaOf(repo, "layer-a"),
    b: shaOf(repo, "layer-b"),
  };
  write("base\nA-fixed\nB\n");
  await repository.undoable("Absorb", () => repository.absorb());
  assert.notEqual(shaOf(repo, "layer-a"), before.a);

  await repository.undo();
  assert.equal(shaOf(repo, "layer-a"), before.a);
  assert.equal(shaOf(repo, "layer-b"), before.b);
  // Absorb finishes with `git checkout HEAD -- f.txt`, so the index still holds the
  // absorbed line once the refs move back. Left staged, a `git commit` in a terminal
  // would fold the reversed edit straight back in.
  assert.equal(stagedIn(repo), "", "nothing staged");
  assert.equal(
    modifiedIn(repo),
    "f.txt",
    "the edit is back in the working copy"
  );
});

test("undo keeps a file the user staged by hand, and unstages only what absorb wrote", async t => {
  const { repo, write, repository } = buildFixture(t);
  writeFileSync(join(repo, "staged.txt"), "mine\n");
  run(repo, "git", ["add", "staged.txt"]);
  write("base\nA-fixed\nB\n");

  await repository.undoable("Absorb", () => repository.absorb());
  await repository.undo();

  // `staged.txt` matches neither the abandoned commit nor the restored one, which is
  // what marks it as the user's own staging. Unstaging it wholesale — what `git reset
  // --mixed` would do — costs work the extension never made.
  assert.equal(stagedIn(repo), "staged.txt");
  assert.equal(modifiedIn(repo), "f.txt");
});

test("an added file has no line ownership, so absorb refuses rather than guessing", async t => {
  const { repo, repository } = buildFixture(t);
  // A new file has no line ownership anywhere in the stack.
  writeFileSync(join(repo, "added.txt"), "brand new\n");
  run(repo, "git", ["add", "added.txt"]);

  await assert.rejects(() => repository.absorb(), /No modified tracked files/);
  assert.equal(readFileSync(join(repo, "added.txt"), "utf8"), "brand new\n");
});

test("planning reports the placement without changing anything", async t => {
  const { repo, write, repository } = buildFixture(t);
  write("base\nA-fixed\nB-fixed\n");
  const before = shaOf(repo, "layer-b");

  const snapshot = await repository.read();
  const plan = await repository.planAbsorb(snapshot);
  assert.deepEqual(
    plan.affected.map(target => target.subject),
    ["add A", "add B"],
    "oldest first, so the preview reads bottom-up like the stack"
  );
  assert.equal(shaOf(repo, "layer-b"), before, "a plan is a dry run");
  assert.match(statusOf(repo), /f\.txt/);
});
