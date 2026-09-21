/**
 * Reading a commit's diff.
 *
 * The parse is of git's own unified output, so the tests that matter are the shapes a
 * naive line walk gets wrong: a body line that looks like a diff header, a rename, a
 * binary file, a deletion, and the root commit, which has no parent to diff against.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseUnifiedDiff } from "#git/diff";
import { commitFile, run, TEAL_PNG } from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import { shaOf, trunkRepository } from "./repoFixture.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
const buildFixture = (t, prefix) =>
  trunkRepository(t, prefix, { content: "one\ntwo\nthree\n" });

test("a modification reads as hunks with both line numberings", async t => {
  const { repo, repository } = buildFixture(t, "gsm-diff-mod-");
  commitFile(repo, "base.txt", "one\nTWO\nthree\n", "change the second line");

  const diff = await repository.diffForCommit(shaOf(repo, "HEAD"));

  assert.equal(diff.files.length, 1);
  const file = present(diff.files[0], "the only file in the diff");
  assert.equal(file.path, "base.txt");
  assert.equal(file.status, "M");
  assert.equal(file.added, 1);
  assert.equal(file.removed, 1);
  // Context lines carry both numbers, a removal only the old, an addition only the new —
  // which is what lets a viewer print two gutters.
  const hunk = present(file.hunks[0], "the modification hunk");
  const kinds = hunk.lines.map(line => line.kind);
  assert.deepEqual(kinds, ["context", "del", "add", "context"]);
  const removed = present(
    hunk.lines.find(line => line.kind === "del"),
    "the removed line"
  );
  assert.equal(removed.text, "two");
  assert.equal(removed.newNumber, null);
  assert.equal(removed.oldNumber, 2);
  const added = present(
    hunk.lines.find(line => line.kind === "add"),
    "the added line"
  );
  assert.equal(added.newNumber, 2);
  assert.equal(added.oldNumber, null);
});

test("an added file is reported as added, with every line an addition", async t => {
  const { repo, repository } = buildFixture(t, "gsm-diff-add-");
  commitFile(repo, "new.txt", "alpha\nbeta\n", "add a file");

  const diff = await repository.diffForCommit(shaOf(repo, "HEAD"));

  const file = present(
    diff.files.find(candidate => candidate.path === "new.txt"),
    "new.txt"
  );
  assert.equal(file.status, "A");
  assert.equal(file.added, 2);
  assert.equal(file.removed, 0);
});

test("a deleted file is reported rather than omitted", async t => {
  const { repo, repository } = buildFixture(t, "gsm-diff-del-");
  run(repo, "git", ["rm", "-q", "base.txt"]);
  run(repo, "git", ["commit", "-qm", "remove the file"]);

  const diff = await repository.diffForCommit(shaOf(repo, "HEAD"));

  // A viewer that dropped deletions would be lying about what the commit did, which is
  // why this reader reports every file rather than only the splittable ones.
  const file = present(
    diff.files.find(candidate => candidate.path === "base.txt"),
    "base.txt"
  );
  assert.equal(file.status, "D");
  assert.equal(file.removed, 3);
});

test("a rename reports both paths", async t => {
  const { repo, repository } = buildFixture(t, "gsm-diff-rename-");
  run(repo, "git", ["mv", "base.txt", "moved.txt"]);
  run(repo, "git", ["commit", "-qm", "move the file"]);

  const diff = await repository.diffForCommit(shaOf(repo, "HEAD"));

  const file = present(
    diff.files.find(candidate => candidate.path === "moved.txt"),
    "moved.txt"
  );
  assert.equal(file.status, "R");
  assert.equal(file.oldPath, "base.txt");
  // A pure rename has no hunks, so the note is what stops the viewer saying "no changes"
  // about a file git listed as changed.
  assert.match(present(file.note, "the rename note"), /renamed/i);
});

test("a binary file is noted instead of parsed", async t => {
  const { repo, repository } = buildFixture(t, "gsm-diff-binary-");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 3]));
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "add a binary file"]);

  const diff = await repository.diffForCommit(shaOf(repo, "HEAD"));

  const file = present(
    diff.files.find(candidate => candidate.path === "blob.bin"),
    "blob.bin"
  );
  assert.match(present(file.note, "the binary note"), /binary/i);
  assert.equal(file.hunks.length, 0);
  // Nothing in the viewer draws a `.bin`, so the note is all it has to show.
  assert.equal(file.previewMediaType, null);
});

test("a binary git can draw is typed, so the viewer knows to fetch the blobs", async t => {
  const { repo, repository } = buildFixture(t, "gsm-diff-image-");
  writeFileSync(join(repo, "logo.PNG"), TEAL_PNG);
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "add an image"]);

  const diff = await repository.diffForCommit(shaOf(repo, "HEAD"));

  const file = present(
    diff.files.find(candidate => candidate.path === "logo.PNG"),
    "logo.PNG"
  );
  // The note still reads, because a viewer with no image support falls back to it. The type
  // is what the overlay branches on — and an upper-case extension is still a PNG.
  assert.equal(file.previewMediaType, "image/png");
  assert.match(present(file.note, "the binary note"), /binary/i);
});

test("the root commit diffs against the empty tree instead of reading as empty", async t => {
  const { repo, repository } = buildFixture(t, "gsm-diff-root-");
  const rootSha = run(repo, "git", ["rev-list", "--max-parents=0", "HEAD"]);

  const diff = await repository.diffForCommit(rootSha);

  // `sha^` does not resolve here. Treating that as "no changes" would show the first
  // commit in a repository as having done nothing.
  const file = present(
    diff.files.find(candidate => candidate.path === "base.txt"),
    "base.txt"
  );
  assert.equal(file.status, "A");
  assert.equal(file.added, 3);
});

test("a body line that looks like a diff header does not start a new file", () => {
  // The reason this is a line walk and not a regex sweep: a commit that adds
  // documentation about diffs contains lines beginning "diff --git" and "+++", and only
  // the real boundary may start a file.
  const text = [
    "diff --git a/doc.md b/doc.md",
    "index 111..222 100644",
    "--- a/doc.md",
    "+++ b/doc.md",
    "@@ -1,2 +1,5 @@",
    " intro",
    "+A diff starts like this:",
    "+diff --git a/x b/x",
    "+--- a/x",
    "+++ b/x",
    " outro",
  ].join("\n");

  const files = parseUnifiedDiff(text);

  assert.equal(files.length, 1, "one file, not two");
  const doc = present(files[0], "the single parsed file");
  assert.equal(doc.path, "doc.md");
  assert.equal(doc.added, 4);
  const texts = present(doc.hunks[0], "the documentation hunk")
    .lines.filter(line => line.kind === "add")
    .map(line => line.text);
  // The nested header keeps its own text: stripping one leading character is all that
  // separates "+diff --git …" the content from "diff --git …" the boundary.
  assert.deepEqual(texts, [
    "A diff starts like this:",
    "diff --git a/x b/x",
    "--- a/x",
    "++ b/x",
  ]);
});

test("a no-newline marker annotates rather than counting as a line", () => {
  const text = [
    "diff --git a/f.txt b/f.txt",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
  ].join("\n");

  const files = parseUnifiedDiff(text);

  const file = present(files[0], "the parsed file");
  assert.equal(file.added, 1);
  assert.equal(file.removed, 1);
  assert.equal(present(file.hunks[0], "the single hunk").lines.length, 2);
});

test("several files in one commit are each parsed separately", async t => {
  const { repo, repository } = buildFixture(t, "gsm-diff-many-");
  writeFileSync(join(repo, "base.txt"), "one\ntwo\nCHANGED\n");
  writeFileSync(join(repo, "second.txt"), "new file\n");
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "touch two files"]);

  const diff = await repository.diffForCommit(shaOf(repo, "HEAD"));

  assert.deepEqual(diff.files.map(file => file.path).sort(), [
    "base.txt",
    "second.txt",
  ]);
  const second = present(
    diff.files.find(file => file.path === "second.txt"),
    "second.txt"
  );
  const base = present(
    diff.files.find(file => file.path === "base.txt"),
    "base.txt"
  );
  assert.equal(second.status, "A");
  assert.equal(base.status, "M");
});
