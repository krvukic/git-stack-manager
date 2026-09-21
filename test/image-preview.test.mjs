/**
 * Reading an image out of a commit — or out of the working copy — for the overlay to draw.
 *
 * `git diff` says only "Binary files … differ" about a PNG, so the preview reads the blobs
 * instead — which puts every case the diff never had to answer here: a side that does not
 * exist, a path whose bytes went through no UTF-8 decode, and a format the viewer refuses.
 * Both refusals are asserted as carefully as the successes, because the overlay prints them
 * where the picture would have gone.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PREVIEW_BYTE_LIMIT } from "#core/media";
import {
  AMBER_PNG,
  commitFile,
  run,
  TEAL_PNG,
} from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import { shaOf, trunkRepository } from "./repoFixture.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
const buildFixture = (t, prefix) => trunkRepository(t, prefix);

/**
 * The bytes a `data:` URI carries, so a test can compare them with what it committed.
 *
 * @param {string} dataUri
 */
const bytesOf = dataUri =>
  Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");

test("a modified image reads as both versions, byte for byte", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-mod-");
  commitFile(repo, "art/logo.png", TEAL_PNG, "add the logo");
  commitFile(repo, "art/logo.png", AMBER_PNG, "recolour the logo");

  const preview = await repository.imagePreview(
    shaOf(repo, "HEAD"),
    "art/logo.png"
  );

  assert.equal(preview.mediaType, "image/png");
  // Byte-for-byte, because the whole point is that these bytes never went through the UTF-8
  // decode `showFile` applies — a PNG does not survive one, and a preview built from the
  // decoded string drew a broken image.
  assert.deepEqual(
    bytesOf(present(preview.before, "the parent's version").dataUri),
    TEAL_PNG
  );
  assert.deepEqual(
    bytesOf(present(preview.after, "this commit's version").dataUri),
    AMBER_PNG
  );
  assert.equal(
    present(preview.after, "this commit's version").bytes,
    AMBER_PNG.length
  );
});

test("an added image has no parent version, and says so with a null side", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-add-");
  commitFile(repo, "logo.png", TEAL_PNG, "add the logo");

  const preview = await repository.imagePreview(
    shaOf(repo, "HEAD"),
    "logo.png"
  );

  // Null rather than an empty side: the overlay draws one picture under "After" instead of
  // one picture beside a broken element.
  assert.equal(preview.before, null);
  assert.deepEqual(
    bytesOf(present(preview.after, "this commit's version").dataUri),
    TEAL_PNG
  );
});

test("a deleted image keeps the version the parent held", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-delete-");
  commitFile(repo, "logo.png", TEAL_PNG, "add the logo");
  run(repo, "git", ["rm", "-q", "logo.png"]);
  run(repo, "git", ["commit", "-qm", "remove the logo"]);

  const preview = await repository.imagePreview(
    shaOf(repo, "HEAD"),
    "logo.png"
  );

  assert.deepEqual(
    bytesOf(present(preview.before, "the parent's version").dataUri),
    TEAL_PNG
  );
  assert.equal(preview.after, null);
});

test("a renamed image reads its parent version under the old path", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-rename-");
  commitFile(repo, "old.png", TEAL_PNG, "add the logo");
  run(repo, "git", ["mv", "old.png", "new.png"]);
  run(repo, "git", ["commit", "-qm", "rename the logo"]);

  const preview = await repository.imagePreview(
    shaOf(repo, "HEAD"),
    "new.png",
    "old.png"
  );

  // Reading the parent under the new path would find nothing there, and a rename would draw
  // as the addition of something that only moved.
  assert.deepEqual(
    bytesOf(present(preview.before, "the parent's version").dataUri),
    TEAL_PNG
  );
  assert.deepEqual(
    bytesOf(present(preview.after, "this commit's version").dataUri),
    TEAL_PNG
  );
});

test("a format the viewer cannot draw is refused by name", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-refuse-");
  commitFile(repo, "blob.bin", Buffer.from([0, 1, 2, 0, 255]), "add a blob");

  await assert.rejects(
    () => repository.imagePreview(shaOf(repo, "HEAD"), "blob.bin"),
    /blob\.bin/
  );
});

/**
 * The working copy's version of the same read. Its after side is the file on disk rather than any
 * commit's blob, which is the whole difference — and the case that breaks if the two are confused
 * is this one: the bytes on screen must be the edit, not the version HEAD still holds.
 */
test("an edited image reads HEAD's version before and the file on disk after", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-wc-mod-");
  commitFile(repo, "art/logo.png", TEAL_PNG, "add the logo");
  writeFileSync(join(repo, "art/logo.png"), AMBER_PNG);

  const preview = await repository.workingCopyImagePreview("art/logo.png");

  assert.deepEqual(
    bytesOf(present(preview.before, "HEAD's version").dataUri),
    TEAL_PNG
  );
  assert.deepEqual(
    bytesOf(present(preview.after, "the file on disk").dataUri),
    AMBER_PNG
  );
});

test("an untracked image has no version at HEAD, and says so with a null side", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-wc-new-");
  writeFileSync(join(repo, "fresh.png"), TEAL_PNG);

  const preview = await repository.workingCopyImagePreview("fresh.png");

  assert.equal(preview.before, null);
  assert.deepEqual(
    bytesOf(present(preview.after, "the file on disk").dataUri),
    TEAL_PNG
  );
});

test("an image deleted from the working copy keeps the version HEAD holds", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-wc-del-");
  commitFile(repo, "logo.png", TEAL_PNG, "add the logo");
  rmSync(join(repo, "logo.png"));

  const preview = await repository.workingCopyImagePreview("logo.png");

  assert.deepEqual(
    bytesOf(present(preview.before, "HEAD's version").dataUri),
    TEAL_PNG
  );
  assert.equal(preview.after, null);
});

test("an image past the byte limit is refused with its size, not sent to the webview", async t => {
  const { repo, repository } = buildFixture(t, "gsm-preview-oversize-");
  // Zeros, so git stores four megabytes as a few hundred compressed bytes. The content is
  // not a PNG at all, which costs nothing: the limit is checked before anything decodes it,
  // and the extension is all that routes a path to this branch.
  commitFile(
    repo,
    "huge.png",
    Buffer.alloc(PREVIEW_BYTE_LIMIT + 1),
    "add an oversized image"
  );

  // The size is in the message because the refusal has to justify itself — a base64 `data:`
  // URI costs a third again on top, and the webview has no other way to say how large it was.
  await assert.rejects(
    () => repository.imagePreview(shaOf(repo, "HEAD"), "huge.png"),
    /huge\.png is 4096 KB — too large to preview/
  );
});
