/**
 * Committing and amending some of a file's lines.
 *
 * Neighbour to `commit.test.mjs`, which covers whole files. What is new here is the remainder:
 * the lines left out have to stay in the working copy, exactly as they were, as an unstaged
 * change, while every file outside the selection keeps its index state. The refusals matter as
 * much as the commits: a file edited after its lines were chosen has to be refused with nothing
 * changed, since committing it would put in lines the reader never saw.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import {
  shaOf,
  stackBranches,
  statusOf,
  trunkRepository,
} from "./repoFixture.mjs";

const NUMBERS = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

/**
 * trunk <- top, with `numbers.txt` committed on trunk so both ends of it can be edited.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function buildFixture(t, prefix) {
  const fixture = trunkRepository(t, prefix, {
    file: "numbers.txt",
    content: NUMBERS,
  });
  stackBranches(fixture.repo, [
    { branch: "top", file: "top.txt", message: "later work" },
  ]);
  return fixture;
}

/**
 * The selection the webview would send for `path` with the lines whose text is in `texts` left
 * out, read from the same diff the overlay shows.
 *
 * @param {import("#app/repository").Repository} repository
 * @param {string} path
 * @param {string[]} texts
 */
async function leaveOut(repository, path, texts) {
  const diff = await repository.diffForWorkingCopy(path);
  const file = present(
    diff.files.find(candidate => candidate.path === path),
    path
  );
  const lines = file.hunks.flatMap(hunk => hunk.lines);
  const excluded = lines.filter(line => texts.includes(line.text));
  assert.equal(excluded.length, texts.length, "each left-out text is changed");
  return {
    path,
    fingerprint: file.fingerprint,
    excludedRemovals: excluded.flatMap(line =>
      line.kind === "del" && line.oldNumber !== null ? [line.oldNumber] : []
    ),
    excludedAdditions: excluded.flatMap(line =>
      line.kind === "add" && line.newNumber !== null ? [line.newNumber] : []
    ),
  };
}

/** @param {string} repo */
const stagedPaths = repo =>
  run(repo, "git", ["diff", "--cached", "--name-only"]);

/** @param {string} repo */
const unstagedPaths = repo => run(repo, "git", ["diff", "--name-only"]);

test("committing chosen lines leaves the rest as an unstaged change", async t => {
  const { repo, repository } = buildFixture(t, "gsm-lines-commit-");
  const edited = NUMBERS.replace("two", "TWO").replace("nine", "NINE");
  writeFileSync(join(repo, "numbers.txt"), edited);
  const lines = await leaveOut(repository, "numbers.txt", ["nine", "NINE"]);

  await repository.commit(["numbers.txt"], "feat: only the top edit", [lines]);

  assert.equal(
    run(repo, "git", ["show", "HEAD:numbers.txt"]),
    NUMBERS.replace("two", "TWO").trim()
  );
  // The working file is untouched, and what was left out is now the only change: unstaged,
  // since the index was brought in line with the new commit.
  assert.equal(readFileSync(join(repo, "numbers.txt"), "utf8"), edited);
  assert.equal(stagedPaths(repo), "");
  assert.equal(unstagedPaths(repo), "numbers.txt");
  assert.deepEqual(
    run(repo, "git", ["diff", "-U0", "--no-color"])
      .split("\n")
      .filter(line => /^[-+][^-+]/.test(line)),
    ["-nine", "+NINE"]
  );
});

test("a new file commits only its chosen lines and keeps the rest", async t => {
  const { repo, repository } = buildFixture(t, "gsm-lines-new-");
  writeFileSync(join(repo, "new.txt"), "first\nsecond\nthird\n");
  const lines = await leaveOut(repository, "new.txt", ["second"]);

  await repository.commit(["new.txt"], "feat: part of a new file", [lines]);

  assert.equal(run(repo, "git", ["show", "HEAD:new.txt"]), "first\nthird");
  assert.equal(
    readFileSync(join(repo, "new.txt"), "utf8"),
    "first\nsecond\nthird\n"
  );
  assert.equal(unstagedPaths(repo), "new.txt");
});

test("whole files and chosen lines go in together, and unselected staging stays", async t => {
  const { repo, repository } = buildFixture(t, "gsm-lines-mixed-");
  writeFileSync(
    join(repo, "numbers.txt"),
    NUMBERS.replace("one", "ONE").replace("ten", "TEN")
  );
  writeFileSync(join(repo, "top.txt"), "top\nwhole\n");
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  run(repo, "git", ["add", "--", "staged.txt"]);
  const lines = await leaveOut(repository, "numbers.txt", ["ten", "TEN"]);

  await repository.commit(["numbers.txt", "top.txt"], "feat: mixed", [lines]);

  assert.equal(
    run(repo, "git", ["show", "--name-only", "--format=", "HEAD"]),
    "numbers.txt\ntop.txt"
  );
  assert.equal(run(repo, "git", ["show", "HEAD:top.txt"]), "top\nwhole");
  // The file staged outside the selection is still staged and still uncommitted.
  assert.equal(stagedPaths(repo), "staged.txt");
  assert.equal(unstagedPaths(repo), "numbers.txt");
});

test("amending chosen lines into HEAD keeps its message and parent", async t => {
  const { repo, repository } = buildFixture(t, "gsm-lines-amend-");
  const parent = shaOf(repo, "HEAD^");
  writeFileSync(join(repo, "top.txt"), "top\nkept\nleft\n");
  const lines = await leaveOut(repository, "top.txt", ["left"]);

  const result = await repository.amendInto(["top.txt"], undefined, [lines]);

  assert.equal(shaOf(repo, "HEAD"), result.newSha);
  assert.equal(shaOf(repo, "HEAD^"), parent);
  assert.equal(run(repo, "git", ["log", "-1", "--format=%s"]), "later work");
  assert.equal(run(repo, "git", ["show", "HEAD:top.txt"]), "top\nkept");
  assert.equal(unstagedPaths(repo), "top.txt");
});

test("amending chosen lines into a commit below HEAD leaves the rest unstaged", async t => {
  const { repo, repository } = trunkRepository(t, "gsm-lines-ancestor-", {
    file: "numbers.txt",
    content: NUMBERS,
  });
  stackBranches(repo, [
    { branch: "middle", file: "middle.txt", message: "middle work" },
    { branch: "top", file: "top.txt", message: "later work" },
  ]);
  const middle = shaOf(repo, "middle");
  writeFileSync(join(repo, "middle.txt"), "middle\nkept\nleft\n");
  const lines = await leaveOut(repository, "middle.txt", ["left"]);

  const result = await repository.amendInto(["middle.txt"], middle, [lines]);

  assert.equal(shaOf(repo, "middle"), result.newSha);
  assert.equal(
    run(repo, "git", ["log", "-1", "--format=%s", result.newSha]),
    "middle work"
  );
  assert.equal(
    run(repo, "git", ["show", `${result.newSha}:middle.txt`]),
    "middle\nkept"
  );
  assert.equal(run(repo, "git", ["show", "top:middle.txt"]), "middle\nkept");
  assert.equal(shaOf(repo, "top^"), result.newSha);
  assert.equal(
    readFileSync(join(repo, "middle.txt"), "utf8"),
    "middle\nkept\nleft\n"
  );
  assert.equal(stagedPaths(repo), "");
  assert.equal(unstagedPaths(repo), "middle.txt");
});

test("a file edited after its lines were chosen is refused with nothing changed", async t => {
  const { repo, repository } = buildFixture(t, "gsm-lines-stale-");
  const before = shaOf(repo, "HEAD");
  writeFileSync(join(repo, "numbers.txt"), NUMBERS.replace("two", "TWO"));
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  run(repo, "git", ["add", "--", "staged.txt"]);
  const lines = await leaveOut(repository, "numbers.txt", ["two"]);
  writeFileSync(join(repo, "numbers.txt"), NUMBERS.replace("two", "2"));

  await assert.rejects(
    () => repository.commit(["numbers.txt"], "feat: stale", [lines]),
    /numbers\.txt changed after its lines were chosen/
  );
  await assert.rejects(
    () => repository.amendInto(["numbers.txt"], undefined, [lines]),
    /numbers\.txt changed after its lines were chosen/
  );
  assert.equal(shaOf(repo, "HEAD"), before);
  assert.equal(stagedPaths(repo), "staged.txt");
  assert.equal(unstagedPaths(repo), "numbers.txt");
});

test("a rejecting hook leaves the index as it was", async t => {
  const { repo, repository } = buildFixture(t, "gsm-lines-hook-");
  const before = shaOf(repo, "HEAD");
  writeFileSync(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  writeFileSync(
    join(repo, "numbers.txt"),
    NUMBERS.replace("one", "ONE").replace("ten", "TEN")
  );
  const lines = await leaveOut(repository, "numbers.txt", ["ten", "TEN"]);

  await assert.rejects(() =>
    repository.commit(["numbers.txt"], "feat: blocked", [lines])
  );

  assert.equal(shaOf(repo, "HEAD"), before);
  assert.equal(stagedPaths(repo), "");
  assert.equal(statusOf(repo), "M numbers.txt");
});

test("chosen lines are refused while a merge is in progress", async t => {
  // A commit from a scratch index would record the merge's second parent over a tree that
  // holds none of the merge.
  const { repo, repository } = buildFixture(t, "gsm-lines-merge-");
  writeFileSync(
    join(repo, "numbers.txt"),
    NUMBERS.replace("one", "ONE").replace("ten", "TEN")
  );
  const lines = await leaveOut(repository, "numbers.txt", ["ten", "TEN"]);
  writeFileSync(join(repo, ".git/MERGE_HEAD"), `${shaOf(repo, "main")}\n`);

  await assert.rejects(
    () => repository.commit(["numbers.txt"], "feat: mid-merge", [lines]),
    /finish or abort the merge/i
  );
});

test("chosen lines for a file outside the selection are refused", async t => {
  const { repo, repository } = buildFixture(t, "gsm-lines-unselected-");
  writeFileSync(join(repo, "numbers.txt"), NUMBERS.replace("two", "TWO"));
  writeFileSync(join(repo, "top.txt"), "top\nmore\n");
  const lines = await leaveOut(repository, "numbers.txt", ["two"]);

  await assert.rejects(
    () => repository.commit(["top.txt"], "feat: mismatch", [lines]),
    /do not match the selection: numbers\.txt/
  );
});
