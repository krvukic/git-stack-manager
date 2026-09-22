/**
 * Rebuilding a file from some of its changed lines.
 *
 * Each case diffs two real files with git, so the hunks carry git's own numbering, and then asks
 * for the content a partial commit would store. The invariants worth pinning are the two ends —
 * everything chosen is the working file, nothing chosen is HEAD's — and the byte-level edges a
 * text round trip would lose: a missing final newline, carriage returns, and bytes that are not
 * UTF-8.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseUnifiedDiff } from "#git/diff";
import {
  buildSelectedContent,
  describeWorkingFiles,
  fingerprintOf,
  wholeFileReason,
} from "#history/partialSelection";
import { present } from "./present.mjs";
import { scratchRoot } from "./repoFixture.mjs";

/**
 * The parsed diff git prints between two versions of one file, both given as latin1.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} head
 * @param {string} working
 */
function diffOf(t, head, working) {
  const root = scratchRoot(t, "gsm-partial-");
  writeFileSync(join(root, "head"), head, "latin1");
  writeFileSync(join(root, "working"), working, "latin1");
  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--no-color", "--no-ext-diff", "head", "working"],
    { cwd: root, encoding: "utf8" }
  );
  return present(parseUnifiedDiff(result.stdout)[0], "the file's diff");
}

/**
 * @param {import("#git/diff").FileDiff} file
 * @param {{ removals?: number[], additions?: number[] }} excluded
 */
function selectionFor(file, excluded = {}) {
  return {
    path: file.path,
    fingerprint: fingerprintOf(file),
    excludedRemovals: excluded.removals ?? [],
    excludedAdditions: excluded.additions ?? [],
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {string} head
 * @param {string} working
 * @param {{ removals?: number[], additions?: number[] }} excluded
 */
function rebuild(t, head, working, excluded = {}) {
  const file = diffOf(t, head, working);
  return buildSelectedContent({
    file,
    head,
    working,
    selection: selectionFor(file, excluded),
  });
}

/** @param {import("#git/diff").FileDiff} file */
function changedNumbers(file) {
  const lines = file.hunks.flatMap(hunk => hunk.lines);
  return {
    removals: lines.flatMap(line =>
      line.kind === "del" && line.oldNumber !== null ? [line.oldNumber] : []
    ),
    additions: lines.flatMap(line =>
      line.kind === "add" && line.newNumber !== null ? [line.newNumber] : []
    ),
  };
}

const HEAD = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

test("with every line chosen the result is the working file", t => {
  const working =
    "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n";

  assert.equal(rebuild(t, HEAD, working), working);
});

test("with every line left out the result is HEAD's file", t => {
  const working = "zero\none\nTWO\nthree\nfour\nfive\nsix\nseven\nnine\nten\n";
  const file = diffOf(t, HEAD, working);

  const content = buildSelectedContent({
    file,
    head: HEAD,
    working,
    selection: selectionFor(file, changedNumbers(file)),
  });

  assert.equal(content, HEAD);
});

test("one hunk out of two goes in and the other stays behind", t => {
  // Far enough apart for git to print two hunks: one near the top, one at the end.
  const working = "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n";
  const file = diffOf(t, HEAD, working);
  assert.equal(file.hunks.length, 2);

  const content = buildSelectedContent({
    file,
    head: HEAD,
    working,
    selection: selectionFor(file, { removals: [10], additions: [10] }),
  });

  assert.equal(
    content,
    "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
  );
});

test("a replacement can take its new line and keep its old one", t => {
  // Leaving the removal out while taking the addition keeps both, old first, as they sit in
  // the diff.
  assert.equal(
    rebuild(t, "a\nb\nc\n", "a\nB\nc\n", { removals: [2] }),
    "a\nb\nB\nc\n"
  );
  assert.equal(
    rebuild(t, "a\nb\nc\n", "a\nB\nc\n", { additions: [2] }),
    "a\nc\n"
  );
});

test("an addition lands after the line it follows, not before the hunk's context", t => {
  // A pure insertion's header names the line it follows, where any other hunk names its first
  // line; reading them alike put the new lines one line early.
  const head = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n";
  const working = "1\n2\n3\n4\n5\n6\nnew\nlater\n7\n8\n9\n10\n11\n12\n";

  assert.equal(
    rebuild(t, head, working, { additions: [8] }),
    "1\n2\n3\n4\n5\n6\nnew\n7\n8\n9\n10\n11\n12\n"
  );
});

test("the missing final newline follows whichever last line is kept", t => {
  const head = "a\nb";
  const working = "a\nb\nc\n";
  // Taking only the new "b" and not "c" ends on the working file's "b\n".
  assert.equal(rebuild(t, head, working, { additions: [3] }), "a\nb\n");
  // Keeping HEAD's unterminated "b" and taking "c" puts a newline between them rather than
  // fusing them into "bc".
  assert.equal(
    rebuild(t, head, working, { removals: [2], additions: [2] }),
    "a\nb\nc\n"
  );
  assert.equal(rebuild(t, "a\nb\n", "a\nb\nc", { additions: [] }), "a\nb\nc");
});

test("a new file takes only its chosen lines", t => {
  assert.equal(
    rebuild(t, "", "first\nsecond\nthird\n", { additions: [2] }),
    "first\nthird\n"
  );
});

test("carriage returns and bytes that are not UTF-8 come out unchanged", t => {
  const head = "caf\xe9\r\nline\r\n";
  const working = "caf\xe9\r\nline\r\nadded \xff\r\nmore\r\n";

  assert.equal(
    rebuild(t, head, working, { additions: [4] }),
    "caf\xe9\r\nline\r\nadded \xff\r\n"
  );
});

test("a diff that no longer matches the blobs is refused", t => {
  const file = diffOf(t, "a\nb\nc\n", "a\nB\nc\n");
  const selection = selectionFor(file);

  // The file on disk moved on after the diff was read.
  assert.throws(
    () =>
      buildSelectedContent({
        file,
        head: "a\nb\nc\n",
        working: "a\nX\nc\n",
        selection,
      }),
    /changed after its lines were chosen/
  );
  // A left-out line the diff never changed belongs to some other diff.
  assert.throws(
    () =>
      buildSelectedContent({
        file,
        head: "a\nb\nc\n",
        working: "a\nB\nc\n",
        selection: { ...selection, excludedAdditions: [3] },
      }),
    /changed after its lines were chosen/
  );
});

test("the fingerprint moves with any change a selection depends on", t => {
  const base = fingerprintOf(diffOf(t, "a\nb\n", "a\nB\n"));

  assert.equal(fingerprintOf(diffOf(t, "a\nb\n", "a\nB\n")), base);
  assert.notEqual(fingerprintOf(diffOf(t, "a\nb\n", "a\nC\n")), base);
  // Only the final newline differs, which changes what a partial commit writes.
  assert.notEqual(fingerprintOf(diffOf(t, "a\nb\n", "a\nB")), base);
});

test("only a file whose change is a list of lines can be chosen from", () => {
  /** @param {Partial<import("#git/diff").FileDiff>} overrides */
  const fileWith = overrides => ({
    path: "f",
    status: "M",
    mode: "100644",
    hunks: [{ header: "@@", oldStart: 1, newStart: 1, lines: [] }],
    previewMediaType: null,
    note: null,
    added: 0,
    removed: 0,
    ...overrides,
  });
  const reasons = [
    fileWith({}),
    fileWith({ status: "?" }),
    fileWith({ status: "D" }),
    fileWith({ status: "R", oldPath: "old" }),
    fileWith({ mode: "120000" }),
    fileWith({ mode: "160000" }),
    fileWith({ hunks: [], note: "Binary file — no text to show." }),
  ].map(wholeFileReason);

  assert.deepEqual(reasons, [
    null,
    null,
    "Deleted, so it goes in whole.",
    "Renamed, so it goes in whole.",
    "A symbolic link, so it goes in whole.",
    "A submodule, so it goes in whole.",
    "No lines to choose, so it goes in whole.",
  ]);

  // A file that became a symbolic link diffs as a deletion plus an addition of one path.
  const typeChange = describeWorkingFiles([
    fileWith({ status: "D" }),
    fileWith({ status: "A", mode: "120000" }),
    fileWith({ path: "other" }),
  ]).map(file => file.wholeFileReason);
  assert.deepEqual(typeChange, [
    "Changed type, so it goes in whole.",
    "Changed type, so it goes in whole.",
    null,
  ]);
});
