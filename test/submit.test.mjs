/**
 * Submitting a branch: the push, and the pull request text that has to follow it.
 *
 * The behaviour under test was established against a live pull request. Amending a commit
 * message and force-pushing moved the branch — `headRefOid` changed — while the pull
 * request kept its original `title` and `body`, because GitHub reads the commit only when
 * the pull request is created. So the assertion that matters here is not that a push happened,
 * but that a message-only amend still reaches the pull request.
 *
 * A script on PATH replaces `gh` and records its arguments and stdin, so the exact
 * command sequence is the assertion and no test touches GitHub. The pushes are real,
 * against a local bare repository, because the push flags are half of what is being tested.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Repository } from "#app/repository";
import { baseBranchFor, stackChain } from "#github/submit";
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
 * Which command submit makes next depends on the pull requests GitHub holds under each branch's
 * name, so that is the only answer a test needs to vary. The fake answers Submit's lookup, the
 * `l{index}` aliases that `#github/submit` builds, by reading the branch names back out of the
 * query. Pass an object to answer per branch, the way real GitHub does — a stacked branch's
 * recorded base is the point of several of these tests, and one shared answer cannot express it.
 *
 * Any other query, such as the badge fetch, gets no answer, which is what GitHub's search index
 * gives for a pull request opened a moment ago.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} root
 * @param {string | Record<string, string>} pullRequestsByName A JSON array of pull requests
 */
function installFakeGh(t, root, pullRequestsByName) {
  const byBranch =
    typeof pullRequestsByName === "string" ? null : pullRequestsByName;
  const shared =
    typeof pullRequestsByName === "string" ? pullRequestsByName : "[]";
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
  const aliases = [...stdin.matchAll(/(l\\d+): pullRequests\\(headRefName: "([^"]*)"/g)];
  if (args[0] === "api" && args[1] === "graphql" && aliases.length) {
    const byBranch = ${JSON.stringify(byBranch)};
    const repository = {};
    for (const [, alias, branch] of aliases) {
      repository[alias] = {
        nodes: JSON.parse(byBranch ? byBranch[branch] || "[]" : ${JSON.stringify(shared)}),
      };
    }
    process.stdout.write(JSON.stringify({ data: { repository } }));
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
 * @param {{ pullRequestsByName?: string | Record<string, string> }} [options]
 */
function scratchRepository(t, { pullRequestsByName = "[]" } = {}) {
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
  return { ...fixture, ...installFakeGh(t, fixture.root, pullRequestsByName) };
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
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    "query=@-",
  ]);
  assert.match(
    calls[0].stdin,
    /l0: pullRequests\(headRefName: "feature-a", states: \[OPEN, CLOSED, MERGED\]/
  );
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
  // branch but leaves the pull request's title and body stale, so submit must write them.
  const { repo, logPath, repository } = scratchRepository(t, {
    pullRequestsByName:
      '[{"number":42,"url":"https://github.com/example/example/pull/42","baseRefName":"main","state":"OPEN"}]',
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
    [["api", "graphql"]],
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

test("Submit stack looks every layer up in one query, before it opens anything", async t => {
  // One lookup per layer would cost a round trip of about half a second each, one after another.
  const { logPath, repository } = scratchRepository(t, {
    pullRequestsByName: { "feature-b": pullRequestsInStates([[42, "OPEN"]]) },
  });
  const outcomes = await repository.submitStack("feature-b");
  assert.deepEqual(
    outcomes.map(outcome => [outcome.branch, outcome.created]),
    [
      ["feature-a", true],
      ["feature-b", false],
    ],
    "each layer acted on its own answer from the shared query"
  );
  const calls = ghCalls(logPath);
  assert.deepEqual(
    calls.map(call => call.args.slice(0, 2)),
    [
      ["api", "graphql"],
      ["pr", "create"],
      ["pr", "edit"],
    ]
  );
  assert.match(
    present(calls[0], "the lookup").stdin,
    /l0: pullRequests\(headRefName: "feature-a".*\n.*l1: pullRequests\(headRefName: "feature-b"/
  );
});

test("submitting a base with local work past its remote reports the inflated diff", async t => {
  // GitHub diffs against the base as pushed. Observed with a real stacked pull
  // request: while the base branch lagged, the pull request listed the parent branch's file
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
    pullRequestsByName: {
      "feature-a":
        '[{"number":1,"url":"https://example.com/1","baseRefName":"main","state":"OPEN"}]',
      "feature-b":
        '[{"number":2,"url":"https://example.com/2","baseRefName":"feature-a","state":"OPEN"}]',
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
  // Being behind trunk is a rebase question, which a rebase onto trunk already answers; it is
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
  // remote-tracking ref, which this extension's own fetch (every rebase onto
  // trunk does one) has already advanced past the teammate's commit. Reproduced
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
    pullRequestsByName:
      '[{"number":9,"url":"https://github.com/example/example/pull/9","baseRefName":"main","state":"OPEN"}]',
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
  // The fake `gh` answers the badge fetch with nothing, which is what GitHub's search
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

/**
 * The draft choice, which applies to the pull request a submit opens and to no other.
 *
 * Two sources name the state, in this order: the branch's stored choice, and the *New pull
 * requests* setting the webview sends as `draftByDefault`. Each test reads the `gh` calls that
 * result, because the toast reads the same whichever state the pull request opened in.
 */

/**
 * The pull requests under `feature-a`'s name: one open pull request.
 *
 * @param {boolean} isDraft
 */
function openPullRequest(isDraft) {
  return JSON.stringify([
    {
      number: 42,
      url: "https://github.com/example/example/pull/42",
      isDraft,
      baseRefName: "main",
      state: "OPEN",
    },
  ]);
}

/** @param {string} logPath */
function readyCalls(logPath) {
  return ghCalls(logPath)
    .map(call => call.args)
    .filter(args => args[1] === "ready");
}

/** @param {string} logPath */
function createCalls(logPath) {
  return ghCalls(logPath)
    .map(call => call.args)
    .filter(args => args[1] === "create");
}

test("a branch chosen as a draft opens its pull request as one", async t => {
  const { logPath, repository } = scratchRepository(t);
  await repository.setBranchDraft("feature-a", true);

  const outcome = await repository.submit("feature-a");

  assert.equal(outcome.isDraft, true);
  assert.equal(createCalls(logPath)[0]?.at(-1), "--draft");
});

test("a branch with no choice opens its pull request in the setting's state", async t => {
  const { logPath, repository } = scratchRepository(t);

  const outcome = await repository.submit("feature-a", {
    draftByDefault: true,
  });

  assert.equal(outcome.isDraft, true);
  assert.equal(createCalls(logPath)[0]?.at(-1), "--draft");
});

test("a stored choice is used before the setting", async t => {
  const { logPath, repository } = scratchRepository(t);
  await repository.setBranchDraft("feature-a", false);

  const outcome = await repository.submit("feature-a", {
    draftByDefault: true,
  });

  assert.equal(outcome.isDraft, false);
  assert.ok(!createCalls(logPath)[0]?.includes("--draft"));
});

test("a pull request that is already open keeps its state, whatever the choice", async t => {
  // The choice names the state a pull request opens in. Converting an open one would undo
  // whatever a reviewer or the author did on GitHub since.
  for (const [onGitHub, chosen] of [
    [false, true],
    [true, false],
  ]) {
    const { logPath, repository } = scratchRepository(t, {
      pullRequestsByName: openPullRequest(onGitHub),
    });
    await repository.setBranchDraft("feature-a", chosen);

    const outcome = await repository.submit("feature-a", {
      draftByDefault: chosen,
    });

    assert.equal(outcome.created, false);
    assert.equal(outcome.isDraft, onGitHub);
    assert.deepEqual(readyCalls(logPath), []);
  }
});

test("submitting a stack applies each branch's own choice", async t => {
  const { logPath, repository } = scratchRepository(t);
  await repository.setBranchDraft("feature-a", true);
  await repository.setBranchDraft("feature-b", false);

  const outcomes = await repository.submitStack("feature-b", {
    draftByDefault: true,
  });

  assert.deepEqual(
    outcomes.map(outcome => [outcome.branch, outcome.isDraft]),
    [
      ["feature-a", true],
      ["feature-b", false],
    ]
  );
  assert.deepEqual(
    createCalls(logPath).map(args => args.includes("--draft")),
    [true, false]
  );
});

/**
 * A pull request someone closed on GitHub, which Submit leaves closed.
 *
 * `gh pr create` checks only for an open pull request on the branch, so without the refusal a
 * submit would force-push the branch and open a second pull request beside the closed one.
 */

/**
 * The pull requests under one branch's name, one entry per `[number, state]`.
 *
 * @param {Array<[number, string]>} pullRequests
 */
function pullRequestsInStates(pullRequests) {
  return JSON.stringify(
    pullRequests.map(([number, state]) => ({
      number,
      url: `https://github.com/example/example/pull/${number}`,
      isDraft: false,
      baseRefName: "main",
      state,
    }))
  );
}

test("a branch whose newest pull request is closed is refused before the push", async t => {
  const { origin, logPath, repository } = scratchRepository(t, {
    pullRequestsByName: pullRequestsInStates([[12, "CLOSED"]]),
  });
  await assert.rejects(
    repository.submit("feature-a"),
    /Pull request #12 for feature-a is closed, so Submit pushed nothing\. Reopen it on GitHub, or right-click feature-a's commit and choose Submit as new pull request\.$/
  );
  assert.equal(
    run(origin, "git", ["branch", "--list", "feature-a"]),
    "",
    "nothing was pushed, which keeps the branch on GitHub as it was when it closed"
  );
  assert.deepEqual(
    ghCalls(logPath).map(call => call.args.slice(0, 2)),
    [["api", "graphql"]],
    "no pull request was opened or edited"
  );
});

test("Submit as new pull request opens one beside the closed one", async t => {
  const { repo, logPath, repository } = scratchRepository(t, {
    pullRequestsByName: pullRequestsInStates([[12, "CLOSED"]]),
  });
  const outcome = await repository.submit("feature-a", { besideClosed: true });
  assert.equal(outcome.created, true);
  assert.equal(outcome.number, 7);
  assert.equal(shaOf(repo, "origin/feature-a"), shaOf(repo, "feature-a"));
  assert.equal(createCalls(logPath).length, 1);
});

test("only the newest pull request counts: an open one is updated, and a merged one is replaced", async t => {
  // An open pull request is the one to update, however many closed ones carry the name.
  const beside = scratchRepository(t, {
    pullRequestsByName: pullRequestsInStates([
      [15, "CLOSED"],
      [10, "OPEN"],
    ]),
  });
  const updated = await beside.repository.submit("feature-a");
  assert.equal(updated.created, false);
  assert.equal(updated.number, 10);

  // A merge after the close is a new round of work, which gets a new pull request.
  const merged = scratchRepository(t, {
    pullRequestsByName: pullRequestsInStates([
      [12, "CLOSED"],
      [20, "MERGED"],
    ]),
  });
  const opened = await merged.repository.submit("feature-a");
  assert.equal(opened.created, true);
  assert.equal(createCalls(merged.logPath).length, 1);
});

test("Submit stack submits the branches below a closed pull request and stops there", async t => {
  const { repo, origin, logPath, repository } = scratchRepository(t, {
    pullRequestsByName: {
      "feature-a": "[]",
      "feature-b": pullRequestsInStates([[12, "CLOSED"]]),
    },
  });
  const controller = new Controller(repository);
  const result = await controller.handle("submitStack", {
    branch: "feature-b",
    // A choice about one branch, which no layer of a stack inherits.
    besideClosed: true,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.error,
    "Pull request #12 for feature-b is closed, so Submit stack submitted only feature-a. Reopen it on GitHub, or right-click feature-b's commit and choose Submit as new pull request."
  );
  assert.equal(shaOf(repo, "origin/feature-a"), shaOf(repo, "feature-a"));
  assert.equal(run(origin, "git", ["branch", "--list", "feature-b"]), "");
  assert.deepEqual(
    createCalls(logPath).map(args => args[3]),
    ["feature-a"]
  );

  // feature-a's pull request opened a moment ago, so the search index does not list it yet.
  // Submit stack still hands the pull request it opened to the badges.
  const refreshed = await controller.handle("pullRequests", { force: true });
  assert.equal(refreshed.ok, true);
  assert.equal(
    pullRequestOn(/** @type {RenderModel} */ (refreshed.data), "feature-a")
      .number,
    7
  );
});

test("Submit stack pushes nothing when its bottom pull request is closed", async t => {
  const { origin, logPath, repository } = scratchRepository(t, {
    pullRequestsByName: { "feature-a": pullRequestsInStates([[12, "CLOSED"]]) },
  });
  await assert.rejects(
    repository.submitStack("feature-b"),
    /Pull request #12 for feature-a is closed, so Submit stack pushed nothing\./
  );
  assert.equal(run(origin, "git", ["branch", "--list", "feature-*"]), "");
  assert.deepEqual(createCalls(logPath), []);
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

/**
 * The branches that make up one stack, read off the graph.
 *
 *   top → mid (no branch) → bottom → trunk, with `side` forking off `bottom`
 */
test("a stack runs from its bottom branch to its top, whichever branch is asked about", () => {
  const snapshot = /** @type {RawData} */ ({
    trunkRef: "origin/main",
    commits: [
      { sha: "d", parents: ["c"], branches: ["top"] },
      { sha: "c", parents: ["b"], branches: ["middle"] },
      { sha: "b", parents: ["a"], branches: [] },
      { sha: "a", parents: ["trunk"], branches: ["bottom"] },
    ],
  });
  for (const branch of ["bottom", "middle", "top"]) {
    assert.deepEqual(stackChain(snapshot, branch), ["bottom", "middle", "top"]);
  }
});

test("a stack that forks ends at the fork when asked from below it", () => {
  const snapshot = /** @type {RawData} */ ({
    trunkRef: "origin/main",
    commits: [
      { sha: "c", parents: ["a"], branches: ["left"] },
      { sha: "b", parents: ["a"], branches: ["right"] },
      { sha: "a", parents: ["trunk"], branches: ["bottom"] },
    ],
  });
  // Two lines share the bottom, and nothing says which one a click on it meant.
  assert.deepEqual(stackChain(snapshot, "bottom"), ["bottom"]);
  // Asked from one line, the stack is that line down to the shared bottom.
  assert.deepEqual(stackChain(snapshot, "left"), ["bottom", "left"]);
  assert.deepEqual(stackChain(snapshot, "right"), ["bottom", "right"]);
});
