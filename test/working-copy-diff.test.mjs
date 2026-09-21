/**
 * Reading the uncommitted changes as a diff.
 *
 * Neighbour to `diff.test.mjs`, which covers the same parse for a commit. What is new here is the
 * half no `git diff` answers: a file git has never seen. So the cases below are about the
 * untracked shapes — a new text file, a picture, something too large to draw, an empty file — and
 * about the tracked ones the reader must not lose on the way, above all a staged change, which
 * `git diff` with no ref omits.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Repository } from "#app/repository";
import { UNTRACKED_DIFF_BYTE_LIMIT } from "#git/diff";
import { run, TEAL_PNG } from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import { scratchRoot, trunkRepository } from "./repoFixture.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
const buildFixture = (t, prefix) =>
  trunkRepository(t, prefix, { content: "one\ntwo\nthree\n" });

/**
 * @param {import("#git/diff").WorkingCopyDiff} diff
 * @param {string} path
 */
const fileIn = (diff, path) =>
  present(
    diff.files.find(candidate => candidate.path === path),
    path
  );

test("an edit to a tracked file reads as hunks with both line numberings", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-mod-");
  writeFileSync(join(repo, "base.txt"), "one\nTWO\nthree\n");

  const diff = await repository.diffForWorkingCopy();

  const file = fileIn(diff, "base.txt");
  assert.equal(file.status, "M");
  assert.equal(file.added, 1);
  assert.equal(file.removed, 1);
  const hunk = present(file.hunks[0], "the modification hunk");
  assert.deepEqual(
    hunk.lines.map(line => line.kind),
    ["context", "del", "add", "context"]
  );
});

/**
 * The reason the read names HEAD instead of running a bare `git diff`: staging a change hides it
 * from the unstaged diff, and the working-copy list still shows the row. Ticking it and reading it
 * have to agree about what is there.
 */
test("a staged change is included, not hidden by the index", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-staged-");
  writeFileSync(join(repo, "base.txt"), "one\ntwo\nthree\nfour\n");
  run(repo, "git", ["add", "base.txt"]);

  const diff = await repository.diffForWorkingCopy();

  const file = fileIn(diff, "base.txt");
  assert.equal(file.added, 1);
});

test("a deletion is reported rather than omitted", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-del-");
  run(repo, "git", ["rm", "-q", "base.txt"]);

  const diff = await repository.diffForWorkingCopy();

  const file = fileIn(diff, "base.txt");
  assert.equal(file.status, "D");
  assert.equal(file.removed, 3);
});

test("a rename reports both paths, so the diff editor knows its left side", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-rename-");
  run(repo, "git", ["mv", "base.txt", "moved.txt"]);

  const diff = await repository.diffForWorkingCopy();

  const file = fileIn(diff, "moved.txt");
  assert.equal(file.status, "R");
  assert.equal(file.oldPath, "base.txt");
});

/**
 * The half `git diff HEAD` says nothing about. Every line is an addition because there is no old
 * side to compare with, and the header has to read the way git's own would, or the overlay's
 * gutters disagree with the ones beside a commit's addition.
 */
test("an untracked file reads as every line added", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-untracked-");
  writeFileSync(join(repo, "fresh.txt"), "alpha\nbeta\n");

  const diff = await repository.diffForWorkingCopy();

  const file = fileIn(diff, "fresh.txt");
  // `?`, the letter the row above shows and the one git's status gives it — not the "A" a
  // staged addition would read as.
  assert.equal(file.status, "?");
  assert.equal(file.added, 2);
  assert.equal(file.removed, 0);
  assert.equal(file.note, null);
  const hunk = present(file.hunks[0], "the addition hunk");
  assert.equal(hunk.header, "@@ -0,0 +1,2 @@");
  assert.equal(hunk.oldStart, 0);
  assert.equal(hunk.newStart, 1);
  assert.deepEqual(
    hunk.lines.map(line => [
      line.kind,
      line.text,
      line.oldNumber,
      line.newNumber,
    ]),
    [
      ["add", "alpha", null, 1],
      ["add", "beta", null, 2],
    ]
  );
});

/** A trailing newline ends the last line rather than starting an empty one after it. */
test("a trailing newline does not add a phantom last line", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-newline-");
  writeFileSync(join(repo, "one.txt"), "only\n");

  const diff = await repository.diffForWorkingCopy();

  assert.equal(fileIn(diff, "one.txt").added, 1);
});

test("a file with no trailing newline keeps its last line", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-nonewline-");
  writeFileSync(join(repo, "bare.txt"), "alpha\nbeta");

  const diff = await repository.diffForWorkingCopy();

  assert.equal(fileIn(diff, "bare.txt").added, 2);
});

test("a new and empty file says so instead of reading as no changes", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-empty-");
  writeFileSync(join(repo, "blank.txt"), "");

  const diff = await repository.diffForWorkingCopy();

  const file = fileIn(diff, "blank.txt");
  assert.equal(file.hunks.length, 0);
  assert.match(present(file.note, "the empty-file note"), /empty/i);
});

test("an untracked binary is noted instead of parsed", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-binary-");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 3]));

  const diff = await repository.diffForWorkingCopy();

  const file = fileIn(diff, "blob.bin");
  assert.match(present(file.note, "the binary note"), /binary/i);
  assert.equal(file.hunks.length, 0);
  // Nothing in the viewer draws a `.bin`, so the note is all it has to show.
  assert.equal(file.previewMediaType, null);
});

test("an untracked image is typed, so the overlay fetches it instead", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-image-");
  writeFileSync(join(repo, "logo.png"), TEAL_PNG);

  const diff = await repository.diffForWorkingCopy();

  assert.equal(fileIn(diff, "logo.png").previewMediaType, "image/png");
});

/**
 * A log or a bundle an ignore rule has not caught. Every drawn line costs the webview a row, and
 * the cap is what keeps one stray artefact from being a hundred thousand of them.
 */
test("an untracked file past the byte cap is noted rather than drawn", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-large-");
  const lines = "x\n".repeat(UNTRACKED_DIFF_BYTE_LIMIT);
  writeFileSync(join(repo, "huge.log"), lines);

  const diff = await repository.diffForWorkingCopy();

  const file = fileIn(diff, "huge.log");
  assert.equal(file.hunks.length, 0);
  assert.match(present(file.note, "the size note"), /too large/i);
});

/**
 * The scope a per-row diff asks for. A row can name a whole folder — `git status` collapses a
 * directory of new files into `dir/` — so the pathspec has to accept one, and it must not drag in
 * the neighbours.
 */
test("a pathspec narrows the read to one path, directories included", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-scope-");
  writeFileSync(join(repo, "base.txt"), "one\nEDITED\nthree\n");
  writeFileSync(join(repo, "loose.txt"), "loose\n");
  mkdirSync(join(repo, "batch"));
  writeFileSync(join(repo, "batch", "first.txt"), "first\n");
  writeFileSync(join(repo, "batch", "second.txt"), "second\n");

  const scoped = await repository.diffForWorkingCopy("batch/");

  assert.deepEqual(
    scoped.files.map(file => file.path),
    ["batch/first.txt", "batch/second.txt"]
  );
  const tracked = await repository.diffForWorkingCopy("base.txt");
  assert.deepEqual(
    tracked.files.map(file => file.path),
    ["base.txt"]
  );
});

/** Tracked before untracked, the order the working-copy list draws its own rows in. */
test("tracked changes come before untracked ones", async t => {
  const { repo, repository } = buildFixture(t, "gsm-wc-diff-order-");
  writeFileSync(join(repo, "a-fresh.txt"), "fresh\n");
  writeFileSync(join(repo, "base.txt"), "one\nEDITED\nthree\n");

  const diff = await repository.diffForWorkingCopy();

  assert.deepEqual(
    diff.files.map(file => file.path),
    ["base.txt", "a-fresh.txt"]
  );
});

test("a clean working copy reads as no files at all", async t => {
  const { repository } = buildFixture(t, "gsm-wc-diff-clean-");

  const diff = await repository.diffForWorkingCopy();

  assert.deepEqual(diff.files, []);
});

/**
 * A repository whose first commit has not happened yet has no HEAD to name. The empty tree stands
 * in for it, so the files already staged read as additions rather than the read failing outright.
 */
test("a repository with no commit yet still reports its staged files", async t => {
  const root = scratchRoot(t, "gsm-wc-diff-nohead-");
  run(root, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "first.txt"), "alpha\n");
  run(root, "git", ["add", "first.txt"]);

  const diff = await new Repository(root).diffForWorkingCopy();

  const file = fileIn(diff, "first.txt");
  assert.equal(file.status, "A");
  assert.equal(file.added, 1);
});
