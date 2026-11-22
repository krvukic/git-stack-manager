/**
 * The lines each commit added and removed, which the tree prints beside the hash on request.
 *
 * Git diffs a commit to count its lines, so the claim worth protecting is the cost as much as
 * the numbers: one process for any number of commits, and none at all for a commit already
 * counted.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fullShas, parseShortstat } from "#git/lineCounts";
import { commitFile, run } from "../scripts/git-fixture.mjs";
import { commitOn } from "./present.mjs";
import { branchPerCommitStack, shaOf } from "./repoFixture.mjs";

const { repo, repository } = branchPerCommitStack({ after }, "gsm-lines-");

const FIRST = "a".repeat(40);
const SECOND = "b".repeat(40);
const THIRD = "c".repeat(40);

test("a summary line gives each commit its two counts", () => {
  const counts = parseShortstat(
    [
      FIRST,
      "",
      " 2 files changed, 12 insertions(+), 3 deletions(-)",
      SECOND,
      "",
      " 1 file changed, 1 insertion(+), 1 deletion(-)",
      "",
    ].join("\n")
  );
  assert.deepEqual(counts.get(FIRST), { added: 12, removed: 3 });
  // The singular forms, which git prints for a count of one.
  assert.deepEqual(counts.get(SECOND), { added: 1, removed: 1 });
});

test("a clause git leaves out counts as zero", () => {
  const counts = parseShortstat(
    [
      FIRST,
      "",
      " 1 file changed, 4 insertions(+)",
      SECOND,
      "",
      " 1 file changed, 7 deletions(-)",
      // An empty commit prints its sha and nothing under it.
      THIRD,
      "",
    ].join("\n")
  );
  assert.deepEqual(counts.get(FIRST), { added: 4, removed: 0 });
  assert.deepEqual(counts.get(SECOND), { added: 0, removed: 7 });
  assert.deepEqual(counts.get(THIRD), { added: 0, removed: 0 });
});

test("only a full sha is passed on to git", () => {
  assert.deepEqual(
    fullShas([FIRST, "--output=/tmp/owned", "abc123", "HEAD", `${SECOND}\n`]),
    [FIRST]
  );
});

test("each commit reports the lines its own change added and removed", async () => {
  // feature-a adds one line; this commit on top rewrites that line and adds two.
  run(repo, "git", ["switch", "-q", "feature-c"]);
  commitFile(repo, "a.txt", "A, reworded\nB\nC\n", "feat: rewrite part A");
  const rewrite = shaOf(repo, "HEAD");
  const added = commitOn(await repository.read(), "feature-a").sha;

  const counts = await repository.lineCounts([added, rewrite]);
  assert.deepEqual(counts, {
    [added]: { added: 1, removed: 0 },
    [rewrite]: { added: 3, removed: 1 },
  });
});

test("a commit already counted costs no git command, and a new one costs one", async () => {
  const snapshot = await repository.read();
  const known = commitOn(snapshot, "feature-a").sha;
  const fresh = commitOn(snapshot, "feature-b").sha;
  await repository.lineCounts([known]);

  const again = await repository.git.withLog(() =>
    repository.lineCounts([known])
  );
  assert.deepEqual(again.commands, []);
  assert.deepEqual(again.value, { [known]: { added: 1, removed: 0 } });

  // Both asked for, one process, and that process names only the commit not yet counted.
  const mixed = await repository.git.withLog(() =>
    repository.lineCounts([known, fresh])
  );
  assert.equal(mixed.commands.length, 1);
  assert.ok(mixed.commands[0]?.endsWith(fresh));
  assert.ok(!mixed.commands[0]?.includes(known));
  assert.deepEqual(Object.keys(mixed.value).sort(), [known, fresh].sort());
});
