/**
 * Which two sides the host hands VS Code's diff editor.
 *
 * The overlay's own rendering is tested through the readers; what only this host decides is the
 * pair of URIs, and each shape gets one wrong in its own way. A commit reads two blobs, except the
 * checked-out one, whose right side is the file on disk, in the diff editor and the multi-file
 * one alike. An uncommitted change reads HEAD on the
 * left and the *file itself* on the right, so a typo spotted while reading it is fixed where it is
 * rather than in a read-only copy. A file the working tree no longer holds has no right-hand file
 * to name, and pointing at the absent path made the editor report a missing file where the
 * deletion should have been.
 *
 * Driven through the webview's own message channel, because the dispatcher is closed over inside
 * the panel's listener and there is no other way in.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitFile, run, TEAL_PNG } from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import { shaOf, trunkRepository } from "./repoFixture.mjs";
import { openHostPanel } from "./vscodeStub.mjs";

/**
 * A host whose panel is open on a real repository with one commit.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function openOnRepository(t, prefix) {
  const { repo } = trunkRepository(t, prefix, { content: "one\ntwo\nthree\n" });
  return { repo, ...openHostPanel({ repositoryPath: repo }) };
}

/**
 * The arguments of the one `vscode.diff` the host executed.
 *
 * @param {{ executed: { command: string, args: unknown[] }[] }} host
 */
function diffCall(host) {
  const calls = host.executed.filter(call => call.command === "vscode.diff");
  assert.equal(calls.length, 1, "one diff editor was opened");
  const [left, right, title, options] = present(calls[0], "the diff call").args;
  return {
    left: /** @type {{ scheme: string, fsPath: string }} */ (left),
    right: /** @type {{ scheme: string, fsPath: string }} */ (right),
    title: /** @type {string} */ (title),
    options: /** @type {{ preview: boolean, preserveFocus: boolean }} */ (
      options
    ),
  };
}

test("a commit below HEAD diffs its parent's blob against its own", async t => {
  const host = openOnRepository(t, "gsm-host-diff-commit-");
  commitFile(host.repo, "base.txt", "one\nTWO\nthree\n", "change a line");
  const sha = shaOf(host.repo, "HEAD");
  commitFile(host.repo, "later.txt", "later\n", "a later commit");

  const result = await host.call("openDiff", { sha, path: "base.txt" });

  assert.equal(result.ok, true);
  const { left, right, title } = diffCall(host);
  assert.match(
    left.fsPath,
    /sha=.*%5E/,
    "the parent's blob, by its own reference"
  );
  assert.match(right.fsPath, new RegExp(`sha=${sha}`));
  assert.match(title, /base\.txt — .* against its parent/);
});

/**
 * The checked-out commit is what the disk holds, so its diff gets the file itself on the right and
 * stays editable. An abbreviated sha has to count as HEAD too, which is why the host compares
 * resolved commits rather than text.
 */
test("the checked-out commit diffs its parent against the file on disk", async t => {
  const host = openOnRepository(t, "gsm-host-diff-head-");
  commitFile(host.repo, "base.txt", "one\nTWO\nthree\n", "change a line");
  const sha = shaOf(host.repo, "HEAD");

  const result = await host.call("openDiff", {
    sha: sha.slice(0, 10),
    path: "base.txt",
  });

  assert.equal(result.ok, true);
  const { left, right, title } = diffCall(host);
  assert.match(left.fsPath, /sha=.*%5E/);
  assert.equal(right.scheme, "file");
  assert.equal(right.fsPath, join(host.repo, "base.txt"));
  assert.match(title, /base\.txt — working copy against .*'s parent/);
});

/** No file on disk to edit, so the commit's blob stays the right side. */
test("the checked-out commit keeps its blob for a file deleted since", async t => {
  const host = openOnRepository(t, "gsm-host-diff-head-deleted-");
  commitFile(host.repo, "base.txt", "one\nTWO\nthree\n", "change a line");
  const sha = shaOf(host.repo, "HEAD");
  rmSync(join(host.repo, "base.txt"));

  const result = await host.call("openDiff", { sha, path: "base.txt" });

  assert.equal(result.ok, true);
  const { right } = diffCall(host);
  assert.equal(right.scheme, "gsm-blob");
  assert.match(right.fsPath, new RegExp(`sha=${sha}`));
});

test("an uncommitted change diffs HEAD against the file on disk", async t => {
  const host = openOnRepository(t, "gsm-host-diff-wc-");
  writeFileSync(join(host.repo, "base.txt"), "one\nEDITED\nthree\n");

  const result = await host.call("openDiff", { path: "base.txt" });

  assert.equal(result.ok, true);
  const { left, right, title, options } = diffCall(host);
  assert.match(left.fsPath, /sha=HEAD/);
  // The working file itself, so the right-hand side stays editable — the reason a blob is not
  // used here even though one would render the same.
  assert.equal(right.scheme, "file");
  assert.equal(right.fsPath, join(host.repo, "base.txt"));
  assert.match(title, /base\.txt — working copy against HEAD/);
  assert.equal(options.preview, false);
  assert.equal(options.preserveFocus, false);
});

test("an untracked file diffs an empty left side against itself", async t => {
  const host = openOnRepository(t, "gsm-host-diff-new-");
  writeFileSync(join(host.repo, "fresh.txt"), "alpha\n");

  const result = await host.call("openDiff", { path: "fresh.txt" });

  assert.equal(result.ok, true);
  const { left, right } = diffCall(host);
  // HEAD holds nothing under this path, and `blobReader` answers with no bytes — which is what
  // makes every line read as added rather than the editor reporting a missing file.
  assert.match(left.fsPath, /fresh\.txt\?sha=HEAD/);
  assert.equal(right.fsPath, join(host.repo, "fresh.txt"));
});

test("a deleted file gets an empty right side, so the diff reads as removed", async t => {
  const host = openOnRepository(t, "gsm-host-diff-deleted-");
  rmSync(join(host.repo, "base.txt"));

  const result = await host.call("openDiff", { path: "base.txt" });

  assert.equal(result.ok, true);
  const { right } = diffCall(host);
  // No sha and no path in the query, which is the reference `blobReader` answers with no bytes.
  assert.equal(right.scheme, "gsm-blob");
  assert.doesNotMatch(right.fsPath, /sha=/);
  assert.match(right.fsPath, /deleted/);
});

test("a rename's left side is the path the file had at HEAD", async t => {
  const host = openOnRepository(t, "gsm-host-diff-rename-");
  run(host.repo, "git", ["mv", "base.txt", "moved.txt"]);

  const result = await host.call("openDiff", {
    path: "moved.txt",
    oldPath: "base.txt",
  });

  assert.equal(result.ok, true);
  const { left, right } = diffCall(host);
  // Reading HEAD under the new path would find nothing, and the move would draw as an addition.
  assert.match(left.fsPath, /base\.txt\?sha=HEAD/);
  assert.equal(right.fsPath, join(host.repo, "moved.txt"));
});

test("a background open leaves focus where it was", async t => {
  const host = openOnRepository(t, "gsm-host-diff-background-");
  writeFileSync(join(host.repo, "base.txt"), "one\nEDITED\nthree\n");

  await host.call("openDiff", { path: "base.txt", background: true });

  assert.equal(diffCall(host).options.preserveFocus, true);
});

/**
 * `git status` collapses a folder of new files into `dir/`, and the working-copy list shows that
 * row as it comes. The diff editor takes one file, so the refusal is what sends the reader to the
 * overlay, which draws every file under the folder.
 */
test("a folder of new files is refused rather than opened as one file", async t => {
  const host = openOnRepository(t, "gsm-host-diff-folder-");

  const result = await host.call("openDiff", { path: "batch/" });

  assert.equal(result.ok, false);
  assert.match(present(result.error, "the refusal"), /folder of new files/);
  assert.equal(
    host.executed.filter(call => call.command === "vscode.diff").length,
    0
  );
});

/** The diff editor hosts text editors only, so a picture on each side drew as a placeholder. */
test("an uncommitted image is refused, as a commit's is", async t => {
  const host = openOnRepository(t, "gsm-host-diff-image-");
  writeFileSync(join(host.repo, "logo.png"), TEAL_PNG);

  const result = await host.call("openDiff", { path: "logo.png" });

  assert.equal(result.ok, false);
  assert.match(present(result.error, "the refusal"), /cannot show an image/);
});

test("a request with no path is refused", async t => {
  const host = openOnRepository(t, "gsm-host-diff-nopath-");

  const result = await host.call("openDiff", {});

  assert.equal(result.ok, false);
  assert.match(present(result.error, "the refusal"), /No file to diff/);
});

/**
 * The read behind the overlay, through the host rather than the repository: the action has to be
 * reachable by name, or the chip opens a refusal.
 */
test("the working-copy diff is readable as an action", async t => {
  const host = openOnRepository(t, "gsm-host-diff-action-");
  writeFileSync(join(host.repo, "base.txt"), "one\nEDITED\nthree\n");
  writeFileSync(join(host.repo, "blob.bin"), Buffer.from([0, 1, 0, 2]));

  const result = await host.call("workingCopyDiff", {});

  assert.equal(result.ok, true);
  const diff = /** @type {import("#git/diff").WorkingCopyDiff} */ (result.data);
  assert.deepEqual(
    diff.files.map(file => file.path),
    ["base.txt", "blob.bin"]
  );
});

/**
 * The arguments of the one `vscode.changes` the host executed.
 *
 * @param {{ executed: { command: string, args: unknown[] }[] }} host
 */
function changesCall(host) {
  const calls = host.executed.filter(call => call.command === "vscode.changes");
  assert.equal(calls.length, 1, "one multi-diff editor was opened");
  const [title, resources] = present(calls[0], "the changes call").args;
  return {
    title: /** @type {string} */ (title),
    resources: /** @type {{ scheme: string, fsPath: string }[][]} */ (
      resources
    ),
  };
}

/**
 * The whole checked-out commit in one editor, each file on disk on the right so it stays
 * editable. A file the commit deleted has nothing on disk, so its blob stands in and the deletion
 * still reads as every line removed.
 */
test("the checked-out commit's changes open with the files on disk on the right", async t => {
  const host = openOnRepository(t, "gsm-host-changes-head-");
  commitFile(host.repo, "gone.txt", "gone\n", "a file to delete");
  writeFileSync(join(host.repo, "base.txt"), "one\nTWO\nthree\n");
  run(host.repo, "git", ["rm", "-q", "gone.txt"]);
  run(host.repo, "git", ["commit", "-q", "-am", "edit one, delete one"]);
  const sha = shaOf(host.repo, "HEAD");

  const result = await host.call("openCommitChanges", { sha });

  assert.equal(result.ok, true);
  const { title, resources } = changesCall(host);
  assert.match(title, /working copy against its parent/);
  const sides = new Map(
    resources.map(([resource, left, right]) => [
      present(resource, "the resource").fsPath,
      { left: present(left, "left"), right: present(right, "right") },
    ])
  );
  const edited = present(sides.get(join(host.repo, "base.txt")), "base.txt");
  assert.match(edited.left.fsPath, /sha=.*%5E/);
  assert.equal(edited.right.scheme, "file");
  assert.equal(edited.right.fsPath, join(host.repo, "base.txt"));
  const deleted = present(sides.get(join(host.repo, "gone.txt")), "gone.txt");
  assert.equal(deleted.right.scheme, "gsm-blob");
});

/** A commit below HEAD has no files on disk to edit, so the overlay keeps it. */
test("a commit below HEAD is refused, so the overlay shows it", async t => {
  const host = openOnRepository(t, "gsm-host-changes-below-");
  commitFile(host.repo, "base.txt", "one\nTWO\nthree\n", "change a line");
  const sha = shaOf(host.repo, "HEAD");
  commitFile(host.repo, "later.txt", "later\n", "a later commit");

  const result = await host.call("openCommitChanges", { sha });

  assert.equal(result.ok, false);
  assert.equal(
    host.executed.filter(call => call.command === "vscode.changes").length,
    0
  );
});

/** An empty multi-diff editor shows nothing; the overlay says the commit changes no files. */
test("an empty checked-out commit is refused, so the overlay shows it", async t => {
  const host = openOnRepository(t, "gsm-host-changes-empty-");
  run(host.repo, "git", ["commit", "-q", "--allow-empty", "-m", "empty"]);

  const result = await host.call("openCommitChanges", {
    sha: shaOf(host.repo, "HEAD"),
  });

  assert.equal(result.ok, false);
  assert.match(present(result.error, "the refusal"), /no files/);
});
