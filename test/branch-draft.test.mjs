/**
 * A branch's stored choice between a draft pull request and one ready for review.
 *
 * Git config stores the choice, so these read it back through the same repository read the
 * tree uses, and check the two claims that picking git config rests on: a renamed branch keeps
 * its choice, and a deleted one takes its choice with it.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { parseConfigEntries } from "#git/branchDraft";
import { ME, run } from "../scripts/git-fixture.mjs";
import { branchPerCommitStack } from "./repoFixture.mjs";

const { repo, repository } = branchPerCommitStack({ after }, "gsm-draft-");

/** `git config -z --get-regexp` output for these entries: `key\nvalue\0` each. */
function entries(/** @type {Array<[string, string]>} */ pairs) {
  return pairs.map(([key, value]) => `${key}\n${value}\0`).join("");
}

test("the email and each branch's choice come out of one listing", () => {
  const config = parseConfigEntries(
    entries([
      ["user.email", "dev@example.com"],
      ["branch.feature-a.gsm-draft", "true"],
      ["branch.kres/XYZ-123.gsm-draft", "false"],
    ])
  );
  assert.equal(config.userEmail, "dev@example.com");
  assert.deepEqual(
    [...config.branchDrafts],
    [
      ["feature-a", true],
      // A slash, a capital, and a dot inside the name all belong to the branch.
      ["kres/XYZ-123", false],
    ]
  );
});

test("a key set in two scopes takes the later one, as git config itself answers", () => {
  const config = parseConfigEntries(
    entries([
      ["user.email", "global@example.com"],
      ["user.email", "local@example.com"],
    ])
  );
  assert.equal(config.userEmail, "local@example.com");
});

test("no matching key at all leaves the email empty and no branch chosen", () => {
  assert.deepEqual(parseConfigEntries(""), {
    userEmail: "",
    branchDrafts: new Map(),
  });
});

test("a repository read includes the stored choices, and still reads the email", async () => {
  assert.deepEqual([...(await repository.read()).branchDrafts], []);

  await repository.setBranchDraft("feature-a", true);
  await repository.setBranchDraft("feature-b", false);

  const snapshot = await repository.read();
  assert.deepEqual([...snapshot.branchDrafts].sort(), [
    ["feature-a", true],
    ["feature-b", false],
  ]);
  // The email shares the config read, so a change to that read could silently drop it.
  assert.equal(snapshot.userEmail, ME.GIT_AUTHOR_EMAIL);
});

test("flipping the choice replaces it rather than adding a second value", async () => {
  await repository.setBranchDraft("feature-a", false);
  assert.equal(
    run(repo, "git", ["config", "--get-all", "branch.feature-a.gsm-draft"]),
    "false"
  );
  assert.equal((await repository.read()).branchDrafts.get("feature-a"), false);
});

test("a choice for a branch that does not exist is refused, and writes nothing", async () => {
  await assert.rejects(
    () => repository.setBranchDraft("no-such-branch", true),
    /no-such-branch is not a local branch/
  );
  assert.equal(
    (await repository.read()).branchDrafts.has("no-such-branch"),
    false
  );
});

test("a renamed branch keeps its choice, and a deleted branch takes it along", async () => {
  await repository.setBranchDraft("feature-c", true);
  run(repo, "git", ["branch", "-m", "feature-c", "feature-renamed"]);
  const renamed = (await repository.read()).branchDrafts;
  assert.equal(renamed.get("feature-renamed"), true);
  assert.equal(renamed.has("feature-c"), false);

  run(repo, "git", ["switch", "-q", "main"]);
  run(repo, "git", ["branch", "-D", "feature-renamed"]);
  assert.equal(
    (await repository.read()).branchDrafts.has("feature-renamed"),
    false
  );
});
