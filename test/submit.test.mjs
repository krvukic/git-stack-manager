/**
 * Submitting a branch: the push, and the pull request text that has to follow it.
 *
 * The behaviour under test was established against a live pull request. Amending a commit
 * message and force-pushing moved the branch — `headRefOid` changed — while the pull
 * request kept its original `title` and `body`, because GitHub reads the commit only when
 * the PR is created. So the assertion that matters here is not that a push happened, but
 * that a message-only amend still reaches the PR.
 *
 * `gh` is replaced by a script on PATH that records its arguments and stdin, so the exact
 * command sequence is the assertion and no test touches GitHub. The pushes are real,
 * against a local bare repository, because the push flags are half of what is being tested.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Repository } from "#app/repository";
import { baseBranchFor } from "#github/submit";
import { Controller } from "#ui/controller";
import { commitFile, OTHER, run } from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import {
  shaOf,
  stackBranches,
  teammateClone,
  trunkRepository,
} from "./repoFixture.mjs";

/** @typedef {import("#git/snapshot").RawData} RawData */
/** @typedef {import("#ui/renderModel").RenderModel} RenderModel */

/**
 * Put a fake `gh` ahead of the real one on PATH, recording one JSON line per invocation.
 *
 * Which command submit makes next depends on `gh pr list`, so that is the only output a
 * test needs to vary. Pass an object to answer per branch, the way real GitHub does — a
 * stacked branch's recorded base is the point of several of these tests, and one shared
 * answer cannot express it.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} root
 * @param {string | Record<string, string>} prListOutput
 */
function installFakeGh(t, root, prListOutput) {
  const prListByBranch = typeof prListOutput === "string" ? null : prListOutput;
  const binDirectory = join(root, "fakebin");
  const logPath = join(root, "gh-calls.jsonl");
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args[0] === "pr" && args[1] === "list") {
    const byBranch = ${JSON.stringify(prListByBranch)};
    if (byBranch) {
      const branch = args[args.indexOf("--head") + 1];
      process.stdout.write(byBranch[branch] || "[]");
    } else {
      process.stdout.write(${JSON.stringify(typeof prListOutput === "string" ? prListOutput : "[]")});
    }
  } else if (args[0] === "pr" && args[1] === "create") {
    process.stdout.write("https://github.com/example/example/pull/7\\n");
  }
});
`,
    { mode: 0o755 }
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  return { logPath, binDirectory };
}

/**
 * A two-branch stack on a pushed trunk, plus the fake `gh`.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ prListOutput?: string | Record<string, string> }} [options]
 */
function scratchRepository(t, { prListOutput = "[]" } = {}) {
  const fixture = trunkRepository(t, "gsm-submit-", {
    file: "README.md",
    content: "hello\n",
    message: "initial commit",
  });
  stackBranches(fixture.repo, [
    {
      branch: "feature-a",
      file: "a.txt",
      message: "feat: part A\n\nBody of A.",
      content: "A\n",
    },
    {
      branch: "feature-b",
      file: "b.txt",
      message: "feat: part B\n\nBody of B.",
      content: "B\n",
    },
  ]);
  return { ...fixture, ...installFakeGh(t, fixture.root, prListOutput) };
}

/**
 * The `gh` invocations recorded so far, in order.
 *
 * @param {string} logPath
 * @returns {Array<{ args: string[]; stdin: string }>}
 */
function ghCalls(logPath) {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test("submitting a branch with no pull request opens one from the commit message", async t => {
  const { repo, logPath, repository } = scratchRepository(t);

  const outcome = await repository.submit("feature-a");
  assert.equal(outcome.created, true);
  assert.equal(outcome.number, 7);
  assert.equal(outcome.branch, "feature-a");
  // Bottom of the stack, so it targets trunk rather than another branch.
  assert.equal(outcome.base, "main");

  // The branch reached the remote, and tracks it — without an upstream the tree
  // would keep reading "not submitted" right after a successful push.
  assert.equal(shaOf(repo, "origin/feature-a"), shaOf(repo, "feature-a"));
  assert.equal(
    run(repo, "git", [
      "for-each-ref",
      "--format=%(upstream:short)",
      "refs/heads/feature-a",
    ]),
    "origin/feature-a"
  );

  const calls = ghCalls(logPath);
  assert.deepEqual(calls[0].args, [
    "pr",
    "list",
    "--head",
    "feature-a",
    "--state",
    "open",
    "--json",
    "number,url,isDraft,baseRefName",
  ]);
  const create = calls[1].args;
  assert.equal(create[1], "create");
  // The subject becomes the title; the body arrives on stdin so a message with
  // quotes or backticks cannot be reinterpreted, and has no length cap.
  assert.deepEqual(create.slice(2), [
    "--head",
    "feature-a",
    "--base",
    "main",
    "--title",
    "feat: part A",
    "--body-file",
    "-",
  ]);
  assert.equal(calls[1].stdin.trim(), "Body of A.");
});

test("a message-only amend still reaches the pull request", async t => {
  // The whole point of the feature. Force-pushing an amended commit updates the
  // branch but leaves the PR's title and body stale, so submit must write them.
  const { repo, logPath, repository } = scratchRepository(t, {
    prListOutput:
      '[{"number":42,"url":"https://github.com/example/example/pull/42","baseRefName":"main"}]',
  });

  await repository.submit("feature-a");
  const pushedFirst = shaOf(repo, "origin/feature-a");

  // Reword only: same tree, new sha — exactly the case that silently desynced.
  const snapshot = await repository.read();
  const partA = present(
    snapshot.commits.find(commit => commit.subject === "feat: part A"),
    "the part A commit"
  );
  await repository.reword(
    snapshot,
    partA.sha,
    "feat: part A, reworded\n\nRewritten body."
  );

  const outcome = await repository.submit("feature-a");
  assert.equal(
    outcome.created,
    false,
    "an existing pull request is updated, not duplicated"
  );
  assert.equal(outcome.number, 42);

  const pushedAfter = shaOf(repo, "origin/feature-a");
  assert.notEqual(
    pushedAfter,
    pushedFirst,
    "the reworded commit reached the remote"
  );
  assert.equal(
    run(repo, "git", ["log", "-1", "--format=%s", "origin/feature-a"]),
    "feat: part A, reworded"
  );

  const edits = ghCalls(logPath).filter(call => call.args[1] === "edit");
  // One edit per submit: the first carried the original message, the second the
  // reworded one. The second is the assertion — it is the push that used to leave
  // the pull request stale.
  assert.equal(edits.length, 2);
  assert.deepEqual(edits[1].args, [
    "pr",
    "edit",
    "feature-a",
    "--title",
    "feat: part A, reworded",
    "--body-file",
    "-",
  ]);
  assert.equal(
    edits[1].stdin.trim(),
    "Rewritten body.",
    "the amended body is what the PR gets"
  );
  // No create when one already exists — that would fail against real GitHub.
  assert.equal(
    ghCalls(logPath).some(call => call.args[1] === "create"),
    false
  );
});

test("a stacked branch targets the layer below, not trunk", async t => {
  const { logPath, repository } = scratchRepository(t);
  // feature-b sits on feature-a. Targeting trunk would show A's commit as part of
  // B's pull request.
  await repository.submit("feature-a");
  const outcome = await repository.submit("feature-b");
  assert.equal(outcome.base, "feature-a");
  const create = present(
    ghCalls(logPath).find(
      call => call.args[1] === "create" && call.args[3] === "feature-b"
    ),
    "a `gh pr create` call for feature-b"
  );
  assert.deepEqual(create.args.slice(2, 6), [
    "--head",
    "feature-b",
    "--base",
    "feature-a",
  ]);
});

/**
 * GitHub answers `gh pr create --base` onto a branch it does not have with "Base ref must be
 * a branch", verified against a live repository: submitting the top of a new stack failed
 * while every layer below it was unsubmitted.
 */
test("opening a pull request onto a base that was never pushed is refused before the push", async t => {
  const { origin, logPath, repository } = scratchRepository(t);
  await assert.rejects(
    repository.submit("feature-b"),
    /feature-b is stacked on feature-a, which has not been submitted.*Submit the stack/
  );
  assert.equal(
    run(origin, "git", ["branch", "--list", "feature-b"]),
    "",
    "nothing was pushed"
  );
  assert.deepEqual(
    ghCalls(logPath).map(call => call.args.slice(0, 2)),
    [["pr", "list"]],
    "no pull request was opened"
  );
});

test("submitting the stack pushes and opens every layer from the bottom up", async t => {
  const { repo, origin, logPath, repository } = scratchRepository(t);
  const outcomes = await repository.submitStack("feature-b");
  assert.deepEqual(
    outcomes.map(outcome => [outcome.branch, outcome.base, outcome.staleBase]),
    [
      ["feature-a", "main", null],
      ["feature-b", "feature-a", null],
    ]
  );
  const creates = ghCalls(logPath)
    .filter(call => call.args[1] === "create")
    .map(call => call.args.slice(2, 6));
  assert.deepEqual(creates, [
    ["--head", "feature-a", "--base", "main"],
    ["--head", "feature-b", "--base", "feature-a"],
  ]);
  assert.equal(
    run(origin, "git", ["rev-parse", "feature-b"]),
    run(repo, "git", ["rev-parse", "feature-b"]),
    "the top layer reached the remote"
  );
});

test("submitting a base with local work past its remote reports the inflated diff", async t => {
  // GitHub diffs against the base as pushed. Observed with a real stacked pull
  // request: while the base branch lagged, the PR listed the parent branch's file
  // next to its own, and that file dropped out once the base was submitted.
  const { repository } = scratchRepository(t);
  await repository.submit("feature-a");
  const afterBasePushed = await repository.submit("feature-b");
  assert.equal(afterBasePushed.staleBase, null);

  // Rewording the lower layer desyncs it again, which is the everyday version of
  // this. Reword rather than a bare `commit --amend`: it re-parents the layer
  // above, so feature-b is still stacked on feature-a afterwards. A bare amend
  // would instead strand feature-b on the abandoned commit, which is the separate
  // "needs rebase" state.
  const snapshot = await repository.read();
  const partA = present(
    snapshot.commits.find(commit => commit.subject === "feat: part A"),
    "the part A commit"
  );
  await repository.reword(snapshot, partA.sha, "feat: part A, reworded");
  const afterBaseReword = await repository.submit("feature-b");
  assert.equal(
    afterBaseReword.base,
    "feature-a",
    "still stacked on the lower layer"
  );
  assert.deepEqual(afterBaseReword.staleBase, {
    branch: "feature-a",
    reason: "unsubmitted",
  });
});

test("a base that is current but rewritten out from under the branch still warns", async t => {
  // The case a "is the base behind its own remote?" check misses. Here the base is
  // in sync with its remote, yet the branch still points at the base's old commit,
  // so GitHub's merge base falls below the base tip and the diff stays inflated.
  // Seen exactly this way: a stacked pull request whose base reported 0/0 against
  // its remote while the diff still listed the parent branch's file.
  // feature-b's pull request targets feature-a on the server, which is the fact the
  // check has to consult: once feature-a is rewritten alone, local shape no longer
  // shows it as feature-b's parent at all.
  const { repo, repository } = scratchRepository(t, {
    prListOutput: {
      "feature-a":
        '[{"number":1,"url":"https://example.com/1","baseRefName":"main"}]',
      "feature-b":
        '[{"number":2,"url":"https://example.com/2","baseRefName":"feature-a"}]',
    },
  });
  await repository.submit("feature-a");
  await repository.submit("feature-b");

  // Rewrite feature-a without carrying feature-b along, then push it. A plain
  // `commit --amend` on the lower layer is what leaves the upper one behind.
  run(repo, "git", ["switch", "-q", "feature-a"]);
  run(repo, "git", [
    "commit",
    "-q",
    "--amend",
    "-m",
    "feat: part A, rewritten alone",
  ]);
  await repository.submit("feature-a");
  run(repo, "git", ["switch", "-q", "feature-b"]);

  // The base now matches its own remote exactly...
  assert.equal(
    run(repo, "git", [
      "rev-list",
      "--left-right",
      "--count",
      "feature-a...origin/feature-a",
    ]),
    "0\t0"
  );
  // ...and feature-b still has to be told its diff is wrong.
  const outcome = await repository.submit("feature-b");
  assert.equal(
    outcome.base,
    "feature-a",
    "the base GitHub records, not the one local shape implies"
  );
  // Fully pushed but moved: rebasing this branch is the fix, not submitting the base.
  assert.deepEqual(outcome.staleBase, {
    branch: "feature-a",
    reason: "rewritten",
  });
});

test("a branch based on trunk never reports a stale base", async t => {
  // Being behind trunk is a rebase question, which restack already answers; it is
  // not something submitting should complain about.
  const { repo, repository } = scratchRepository(t);
  commitFile(repo, "later.txt", "later\n", "trunk moved on", OTHER);
  run(repo, "git", ["switch", "-q", "main"]);
  run(repo, "git", ["push", "-q", "origin", "main"]);
  run(repo, "git", ["switch", "-q", "feature-a"]);

  const outcome = await repository.submit("feature-a");
  assert.equal(outcome.base, "main");
  assert.equal(outcome.staleBase, null);
});

test("the push refuses to clobber a commit this checkout has never seen", async t => {
  // `--force-with-lease` alone is not enough here: it compares against the
  // remote-tracking ref, which this extension's own fetch (every rebase and
  // restack does one) has already advanced past the teammate's commit. Reproduced
  // against a live remote, that push reported "forced update" and destroyed the
  // commit. `--force-if-includes` is what rejects it.
  const { root, repo, origin, repository } = scratchRepository(t);
  await repository.submit("feature-a");

  // A teammate pushes to the same branch, via a second clone of the bare origin.
  const otherRepo = teammateClone(root, origin, "clone");
  run(otherRepo, "git", ["switch", "-q", "-c", "theirs", "origin/feature-a"]);
  commitFile(otherRepo, "theirs.txt", "theirs\n", "teammate work", OTHER);
  run(otherRepo, "git", ["push", "-q", "origin", "theirs:feature-a"]);
  const theirCommit = shaOf(otherRepo, "HEAD");

  // Locally: amend, and fetch — which is what defeats a bare lease.
  run(repo, "git", ["switch", "-q", "feature-a"]);
  writeFileSync(join(repo, "a.txt"), "A amended\n");
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-q", "--amend", "--no-edit"]);
  run(repo, "git", ["fetch", "-q", "origin"]);

  await assert.rejects(
    () => repository.submit("feature-a"),
    /reject|stale|fetch first|force-if-includes/i
  );
  // Their commit is still the remote tip.
  assert.equal(shaOf(repo, "origin/feature-a"), theirCommit);
});

test("a commit with no body clears the pull request body rather than leaving it stale", async t => {
  const { repo, logPath, repository } = scratchRepository(t, {
    prListOutput:
      '[{"number":9,"url":"https://github.com/example/example/pull/9","baseRefName":"main"}]',
  });
  run(repo, "git", ["switch", "-q", "feature-a"]);
  run(repo, "git", [
    "commit",
    "-q",
    "--amend",
    "-m",
    "feat: part A, subject only",
  ]);

  await repository.submit("feature-a");
  const edit = present(
    ghCalls(logPath).find(call => call.args[1] === "edit"),
    "a `gh pr edit` call"
  );
  assert.equal(edit.args[4], "feat: part A, subject only");
  // Sending an empty body is deliberate: leaving the old text behind would keep
  // describing a body the commit no longer has.
  assert.equal(edit.stdin, "");
});

/**
 * The pull request badge the model draws beside a branch pill.
 *
 * @param {RenderModel} model
 * @param {string} branch
 */
function pullRequestOn(model, branch) {
  return present(
    model.rows
      .filter(row => row.type === "commit")
      .flatMap(row => row.commit.branchDetails ?? [])
      .find(detail => detail.name === branch)?.pullRequest,
    `a pull request badge on ${branch}`
  );
}

test("a submitted branch carries its pull request before the search index reports one", async t => {
  // The fake `gh` answers every `pr list` with nothing, which is what GitHub's search
  // index does for a pull request opened a second ago — so the badge can only come from
  // what the submit itself read. Without it the button goes on saying "Submit as pull
  // request" about a pull request that already exists.
  const { repository } = scratchRepository(t);
  const controller = new Controller(repository);

  const submitted = await controller.handle("submit", { branch: "feature-a" });
  assert.equal(submitted.ok, true);
  const { model } = /** @type {{ model: RenderModel }} */ (submitted.data);
  const badge = pullRequestOn(model, "feature-a");
  assert.equal(badge.number, 7);
  assert.equal(badge.state, "OPEN");
  assert.equal(badge.title, "feat: part A");

  // The refresh the UI fires next must not take the badge away again. The search answers
  // nothing here, which is the whole reason the submit had to supply it.
  const refreshed = await controller.handle("pullRequests", { force: true });
  assert.equal(refreshed.ok, true);
  assert.equal(
    pullRequestOn(/** @type {RenderModel} */ (refreshed.data), "feature-a")
      .number,
    7
  );
});

test("submit reports through the controller with its commands logged", async t => {
  const { logPath, repo } = scratchRepository(t);
  const controller = new Controller(new Repository(repo));

  const result = await controller.handle("submit", { branch: "feature-a" });
  assert.equal(result.ok, true);
  assert.equal(/** @type {{ created: boolean }} */ (result.data).created, true);
  const log = present(result.log, "the command log");
  assert.equal(log.title, "Submit feature-a");
  // The panel should show the `gh` half of the action too, not just the push.
  assert.ok(log.commands.some(command => command.startsWith("git push")));
  assert.ok(log.commands.some(command => command.startsWith("gh pr create")));
  // The piped body stays out of the log, the way a reword's message does.
  assert.equal(
    log.commands.some(command => command.includes("Body of A")),
    false
  );
  // A fresh model rides along so the branch's sync badge updates without a
  // second read.
  const { model } = /** @type {{ model: RenderModel }} */ (result.data);
  assert.ok(Array.isArray(model.rows));
  assert.ok(ghCalls(logPath).length >= 2);

  const missing = await controller.handle("submit", {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /"branch"/);
});

test("a failing gh reports its message instead of claiming success", async t => {
  const { repo, binDirectory } = scratchRepository(t);
  // Overwrite the fake with one that fails the way an unauthenticated gh does.
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("gh auth login required\\n");
  process.exit(1);
});
`,
    { mode: 0o755 }
  );
  const repository = new Repository(repo);
  await assert.rejects(() => repository.submit("feature-a"), /gh auth login/);
});

test("base resolution walks past a commit that carries no branch", () => {
  // Only branch tips anchor a pull request base. A mid-stack commit without a
  // branch must not become one, so the walk continues to the next branch down.
  const snapshot = /** @type {RawData} */ ({
    trunkRef: "origin/main",
    commits: [
      { sha: "c", parents: ["b"], branches: ["top"] },
      { sha: "b", parents: ["a"], branches: [] },
      { sha: "a", parents: ["trunk"], branches: ["bottom"] },
    ],
  });
  assert.equal(baseBranchFor(snapshot, "top"), "bottom");
  assert.equal(baseBranchFor(snapshot, "bottom"), "main");
  // A branch that is not in the snapshot at all still gets a usable base.
  assert.equal(baseBranchFor(snapshot, "unknown"), "main");
  // A local trunk has no remote prefix to strip.
  assert.equal(
    baseBranchFor(
      /** @type {RawData} */ (
        /** @type {unknown} */ ({ trunkRef: "master", commits: [] })
      ),
      "x"
    ),
    "master"
  );
});
