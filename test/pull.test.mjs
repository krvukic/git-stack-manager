/**
 * Pull.
 *
 * The happy path is one assertion. The value is in the refusals: pull is the one action
 * here that brings in someone else's work, and every way it can go wrong either loses
 * local commits or overwrites uncommitted files. Each test therefore asserts that the
 * refusal left the repository exactly as it was, not merely that it threw.
 *
 * Which local branch the trunk row offers, and how far behind it runs, live in
 * `trunk.test.mjs`.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitFile, run } from "../scripts/git-fixture.mjs";
import {
  pushFromClone,
  shaOf,
  statusOf,
  teammateClone,
  trunkRepository,
} from "./repoFixture.mjs";

/**
 * A repository plus a teammate's clone, so a push from the clone is what leaves the
 * first one behind.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function buildFixture(t, prefix) {
  const fixture = trunkRepository(t, prefix);
  return { ...fixture, other: teammateClone(fixture.root, fixture.origin) };
}

test("pulling fast-forwards the branch and reports how many commits arrived", async t => {
  const { repo, other, repository } = buildFixture(t, "gsm-pull-");
  pushFromClone(other, "theirs.txt", "their work");
  pushFromClone(other, "theirs2.txt", "more of their work");

  const outcome = await repository.pull();

  assert.equal(outcome.branch, "main");
  assert.equal(outcome.upstream, "origin/main");
  assert.equal(outcome.commits, 2);
  assert.equal(shaOf(repo, "main"), shaOf(repo, "origin/main"));
  assert.equal(
    run(repo, "git", ["log", "-1", "--format=%s"]),
    "more of their work"
  );
});

test("pulling an already-current branch reports zero rather than failing", async t => {
  const { repo, repository } = buildFixture(t, "gsm-pull-current-");
  const before = shaOf(repo, "main");

  const outcome = await repository.pull();

  // Zero is a real answer, not an error: the button ran a fetch, and the UI says so.
  assert.equal(outcome.commits, 0);
  assert.equal(shaOf(repo, "main"), before);
});

test("a diverged branch is refused, keeping the local commit", async t => {
  const { repo, other, repository } = buildFixture(t, "gsm-pull-diverged-");
  pushFromClone(other, "theirs.txt", "their work");
  commitFile(repo, "mine.txt", "mine\n", "my work");
  const before = shaOf(repo, "main");

  // Fast-forward only, always. A merge commit or a silent rebase of the local commit is
  // a history decision the user did not ask a Pull button to make.
  await assert.rejects(() => repository.pull(), /cannot fast-forward/i);

  assert.equal(shaOf(repo, "main"), before, "the local commit is still there");
  assert.equal(run(repo, "git", ["log", "-1", "--format=%s"]), "my work");
});

test("a dirty working copy is refused before anything is fetched into it", async t => {
  const { repo, other, repository } = buildFixture(t, "gsm-pull-dirty-");
  pushFromClone(other, "theirs.txt", "their work");
  writeFileSync(join(repo, "base.txt"), "base\nedited\n");
  const before = shaOf(repo, "main");

  await assert.rejects(() => repository.pull(), /before pulling/i);

  assert.equal(shaOf(repo, "main"), before);
  assert.equal(statusOf(repo), "M base.txt", "the edit is untouched");
});

test("the refusal names the files it is about", async t => {
  const { repo, repository } = buildFixture(t, "gsm-pull-names-");
  const files = ["a.txt", "b.txt", "c.txt", "d.txt"];
  for (const name of files) {
    writeFileSync(join(repo, name), "committed\n");
  }
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-qm", "add four files"]);
  for (const name of files) {
    writeFileSync(join(repo, name), "edited\n");
  }

  // The guard runs before the fetch, so what the branch is doing does not enter into it.
  // Sending the reader to `git status` to learn which file the toast meant is a round trip
  // the message can spare them; forty names would fill the toast instead.
  await assert.rejects(() => repository.pull(), /a\.txt, b\.txt and 2 more/);
});

test("an untracked file does not stand between a branch and its remote", async t => {
  const { repo, other, repository } = buildFixture(
    t,
    "gsm-pull-untracked-file-"
  );
  pushFromClone(other, "theirs.txt", "their work");
  // The bug this pins: one scratch file in the working copy — a log, an editor's
  // leftover — and Pull refused outright, so a branch behind stayed behind with no way
  // through the button. Nothing a fast-forward writes can touch a path git is not
  // tracking, and the one case that would, an incoming commit adding that same path,
  // `merge --ff-only` refuses itself, naming the file.
  writeFileSync(join(repo, "scratch.log"), "noise\n");

  const outcome = await repository.pull();

  assert.equal(outcome.commits, 1);
  assert.equal(shaOf(repo, "main"), shaOf(repo, "origin/main"));
  assert.equal(
    statusOf(repo),
    "?? scratch.log",
    "the file is left where it was"
  );
});

test("a detached HEAD is refused with what to do about it", async t => {
  const { repo, repository } = buildFixture(t, "gsm-pull-detached-");
  run(repo, "git", ["switch", "-q", "--detach", "HEAD"]);

  await assert.rejects(() => repository.pull(), /detached/i);
});

test("a branch tracking nothing is refused rather than guessing a remote", async t => {
  const { repo, repository } = buildFixture(t, "gsm-pull-untracked-");
  run(repo, "git", ["switch", "-qc", "solo"]);
  commitFile(repo, "solo.txt", "solo\n", "solo work");

  await assert.rejects(() => repository.pull(), /tracks no remote branch/i);
});
