/**
 * Discarding one working-copy change.
 *
 * One case per status letter git can report, because the implementation deliberately does not
 * switch on the letter: it asks HEAD whether the path exists and picks restore or delete from
 * the answer. These tests are what says that answer is right for a deletion, a rename and a
 * staged addition, which are the three shapes where "restore the file" and "delete the file"
 * come apart.
 *
 * Every case also checks what the discard left alone. A per-file button whose blast radius is
 * the whole working copy is the failure worth catching, and `statusOf` shows it in one line.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Controller } from "#ui/controller";
import { run } from "../scripts/git-fixture.mjs";
import {
  shaOf,
  stackBranches,
  statusOf,
  trunkRepository,
} from "./repoFixture.mjs";

/**
 * trunk <- feature, with `keep.txt` tracked so every case has a second change to leave alone.
 *
 * @param {import("node:test").TestContext} t
 */
function buildFixture(t) {
  const fixture = trunkRepository(t, "gsm-discard-");
  stackBranches(fixture.repo, [
    { branch: "feature", file: "feature.txt", message: "add feature" },
  ]);
  writeFileSync(join(fixture.repo, "keep.txt"), "keep\n");
  run(fixture.repo, "git", ["add", "keep.txt"]);
  run(fixture.repo, "git", ["commit", "-qm", "add keep"]);
  return { ...fixture, controller: new Controller(fixture.repository) };
}

/**
 * @param {string} repo
 * @param {string} path
 */
const contentOf = (repo, path) => readFileSync(join(repo, path), "utf8");

test("a modified file goes back to HEAD, and the change beside it stays", async t => {
  const { repo, repository } = buildFixture(t);
  writeFileSync(join(repo, "feature.txt"), "edited\n");
  writeFileSync(join(repo, "keep.txt"), "also edited\n");

  const result = await repository.discard(["feature.txt"]);

  assert.deepEqual(result, { restored: ["feature.txt"], removed: [] });
  assert.equal(contentOf(repo, "feature.txt"), "feature\n");
  assert.equal(statusOf(repo), "M keep.txt");
});

test("a staged modification loses the staged copy as well as the working one", async t => {
  const { repo, repository } = buildFixture(t);
  writeFileSync(join(repo, "feature.txt"), "staged\n");
  run(repo, "git", ["add", "feature.txt"]);
  writeFileSync(join(repo, "feature.txt"), "staged then edited again\n");

  await repository.discard(["feature.txt"]);

  // Both halves, or the panel would redraw the file as still changed on the next refresh.
  assert.equal(contentOf(repo, "feature.txt"), "feature\n");
  assert.equal(statusOf(repo), "");
});

test("a deleted file comes back", async t => {
  const { repo, repository } = buildFixture(t);
  run(repo, "git", ["rm", "-q", "feature.txt"]);

  const result = await repository.discard(["feature.txt"]);

  assert.deepEqual(result, { restored: ["feature.txt"], removed: [] });
  assert.equal(contentOf(repo, "feature.txt"), "feature\n");
  assert.equal(statusOf(repo), "");
});

test("an untracked file is deleted, and an untracked directory with it", async t => {
  const { repo, repository } = buildFixture(t);
  writeFileSync(join(repo, "scratch.txt"), "scratch\n");
  mkdirSync(join(repo, "notes"));
  writeFileSync(join(repo, "notes", "deep.txt"), "deep\n");

  // `status` collapses an untracked directory into one entry, so that trailing slash is the
  // path the panel shows and the path a click sends back.
  const result = await repository.discard(["scratch.txt", "notes/"]);

  assert.deepEqual(result, {
    restored: [],
    removed: ["notes/", "scratch.txt"],
  });
  assert.equal(existsSync(join(repo, "scratch.txt")), false);
  assert.equal(existsSync(join(repo, "notes")), false);
  assert.equal(statusOf(repo), "");
});

test("a staged addition leaves the index and the working tree", async t => {
  const { repo, repository } = buildFixture(t);
  writeFileSync(join(repo, "added.txt"), "added\n");
  run(repo, "git", ["add", "added.txt"]);

  const result = await repository.discard(["added.txt"]);

  assert.deepEqual(result, { restored: [], removed: ["added.txt"] });
  assert.equal(existsSync(join(repo, "added.txt")), false);
  assert.equal(statusOf(repo), "");
});

test("a rename is reversed on both sides", async t => {
  const { repo, repository } = buildFixture(t);
  run(repo, "git", ["mv", "feature.txt", "renamed.txt"]);

  // git reports the rename against the new path; HEAD only knows the old one, so a discard
  // that took the click's path alone would delete the file and restore nothing.
  const result = await repository.discard(["renamed.txt"]);

  assert.deepEqual(result, {
    restored: ["feature.txt"],
    removed: ["renamed.txt"],
  });
  assert.equal(contentOf(repo, "feature.txt"), "feature\n");
  assert.equal(existsSync(join(repo, "renamed.txt")), false);
  assert.equal(statusOf(repo), "");
});

test("discarding leaves history alone and reports the command it ran", async t => {
  const { repo, controller } = buildFixture(t);
  const head = shaOf(repo, "HEAD");
  writeFileSync(join(repo, "feature.txt"), "edited\n");

  const result = await controller.handle("discard", { paths: ["feature.txt"] });

  assert.equal(result.ok, true);
  assert.equal(result.log?.title, "Discard feature.txt");
  assert.ok(
    result.log?.commands.some(command =>
      command.startsWith("git checkout HEAD -- feature.txt")
    ),
    `expected a checkout in ${JSON.stringify(result.log?.commands)}`
  );
  // No ref moves, so Undo must not offer to reverse a discard: it restores refs, and the
  // content a discard destroyed was never in one.
  assert.equal(shaOf(repo, "HEAD"), head);
  const { model } =
    /** @type {{ model: import("#ui/renderModel").RenderModel }} */ (
      result.data
    );
  assert.equal(model.undoLabel, null);
});

test("several paths at once, mixing restore and delete", async t => {
  const { repo, repository } = buildFixture(t);
  writeFileSync(join(repo, "feature.txt"), "edited\n");
  writeFileSync(join(repo, "fresh.txt"), "fresh\n");
  writeFileSync(join(repo, "keep.txt"), "untouched by the discard\n");

  const result = await repository.discard(["feature.txt", "fresh.txt"]);

  assert.deepEqual(result, {
    restored: ["feature.txt"],
    removed: ["fresh.txt"],
  });
  assert.equal(contentOf(repo, "feature.txt"), "feature\n");
  assert.equal(existsSync(join(repo, "fresh.txt")), false);
  assert.equal(statusOf(repo), "M keep.txt");
});
