/**
 * Which pull request a branch's badge shows.
 *
 * `pull-request-cache.test.mjs` scripts each reply by position. The stand-in `gh` here answers
 * `pr list --search` and `api graphql` from a table of pull requests instead, and reproduces the
 * GitHub behaviour that picks a branch's badge:
 *
 * - A sha matches every pull request that contains the commit, not only the one it heads.
 * - `head:` in a search matches by prefix.
 * - `Repository.pullRequests` lists oldest first unless the query passes `orderBy`.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PullRequestService } from "#github/pullRequests";
import { present } from "./present.mjs";
import { scratchRoot } from "./repoFixture.mjs";

/**
 * A pull request as the stand-in stores it.
 *
 * @typedef {{
 *   number: number,
 *   state: "OPEN" | "CLOSED" | "MERGED",
 *   headRefName: string,
 *   headRefOid: string,
 *   commits: string[],
 *   checks?: "SUCCESS" | "FAILURE" | "PENDING",
 * }} StoredPullRequest
 */

/** @param {string} character */
function sha(character) {
  return character.repeat(40);
}

/**
 * Put a `gh` on PATH that answers `pr list --search` and `api graphql` from `pullRequests`.
 *
 * @param {import("node:test").TestContext} t
 * @param {StoredPullRequest[]} pullRequests
 */
function installStandInGitHub(t, pullRequests) {
  const root = scratchRoot(t, "gsm-pr-lookup-");
  const binDirectory = join(root, "fakebin");
  mkdirSync(binDirectory, { recursive: true });
  const worldPath = join(root, "world.json");
  writeFileSync(worldPath, JSON.stringify(pullRequests));
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const [command, subcommand] = args;
const pullRequests = JSON.parse(fs.readFileSync(${JSON.stringify(worldPath)}, "utf8"));
const option = name => args[args.indexOf(name) + 1];
const summary = pullRequest => ({
  number: pullRequest.number,
  state: pullRequest.state,
  isDraft: false,
  title: "pull request " + pullRequest.number,
  url: "https://github.com/example/example/pull/" + pullRequest.number,
  headRefName: pullRequest.headRefName,
  headRefOid: pullRequest.headRefOid,
  reviewDecision: null,
});

if (command === "repo" && subcommand === "view") {
  process.stdout.write(JSON.stringify({ owner: { login: "example" }, name: "example" }));
  process.exit(0);
}

if (command === "pr" && subcommand === "list") {
  const terms = option("--search").split(" OR ");
  const matching = pullRequests
    .filter(pullRequest =>
      terms.some(term =>
        term.startsWith("head:")
          ? pullRequest.headRefName.startsWith(term.slice("head:".length))
          : pullRequest.commits.includes(term)
      )
    )
    .sort((left, right) => right.number - left.number)
    .slice(0, Number(option("--limit")));
  const rows = matching.map(pullRequest => ({
    ...summary(pullRequest),
    statusCheckRollup: pullRequest.checks
      ? [{ __typename: "CheckRun", status: "COMPLETED", conclusion: pullRequest.checks }]
      : [],
  }));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

let query = "";
process.stdin.on("data", chunk => (query += chunk));
process.stdin.on("end", () => {
  const node = pullRequest => ({
    ...summary(pullRequest),
    commits: {
      nodes: [
        {
          commit: {
            oid: pullRequest.headRefOid,
            statusCheckRollup: pullRequest.checks ? { state: pullRequest.checks } : null,
          },
        },
      ],
    },
  });
  const repository = {};
  for (const [, index, name, rest] of query.matchAll(/n(\\d+): pullRequests\\(headRefName: ("[^"]*")([^)]*)\\)/g)) {
    const first = Number(/first: (\\d+)/.exec(rest)?.[1] ?? 100);
    const newestFirst = /direction: DESC/.test(rest);
    const matching = pullRequests
      .filter(pullRequest => pullRequest.headRefName === JSON.parse(name))
      .sort((left, right) => (newestFirst ? right.number - left.number : left.number - right.number))
      .slice(0, first);
    repository["n" + index] = { nodes: matching.map(node) };
  }
  for (const [, index, oid] of query.matchAll(/c(\\d+): object\\(oid: "([0-9a-f]{40})"\\)/g)) {
    const containing = pullRequests.filter(pullRequest => pullRequest.commits.includes(oid));
    const head = containing.find(pullRequest => pullRequest.headRefOid === oid);
    // A commit no pull request contains was never pushed, so GitHub has no object for it.
    repository["c" + index] = containing.length
      ? {
          statusCheckRollup: head?.checks ? { state: head.checks } : null,
          associatedPullRequests: { nodes: containing.map(node) },
        }
      : null;
  }
  process.stdout.write(JSON.stringify({ data: { repository } }));
});
`,
    { mode: 0o755 }
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  return root;
}

test("a branch amended since its push still finds its pull request by name", async t => {
  const cwd = installStandInGitHub(t, [
    {
      number: 7,
      state: "OPEN",
      headRefName: "feature-a",
      headRefOid: sha("a"),
      commits: [sha("a")],
    },
  ]);
  const service = new PullRequestService(cwd);

  await service.refresh([{ name: "feature-a", sha: sha("b") }], true);

  assert.equal(
    present(service.cached().get("feature-a"), "feature-a").number,
    7
  );
});

test("a branch pushed under another name finds its pull request by tip commit", async t => {
  // Sapling and `gh stack` push a local `dev/readme` as a server-side branch such as `pr26403`.
  const cwd = installStandInGitHub(t, [
    {
      number: 26403,
      state: "OPEN",
      headRefName: "pr26403",
      headRefOid: sha("a"),
      commits: [sha("a")],
      checks: "SUCCESS",
    },
  ]);
  const service = new PullRequestService(cwd);

  await service.refresh([{ name: "dev/readme", sha: sha("a") }], true);

  const status = present(service.cached().get("dev/readme"), "dev/readme");
  assert.equal(status.number, 26403);
  assert.equal(status.checks, "success");
});

test("a branch whose tip sits inside a later pull request keeps its own pull request", async t => {
  // The lower branch merged as #10. The upper pull request #11 targets main, so its commits
  // include the lower branch's tip, and GitHub lists #11 for that commit too.
  const cwd = installStandInGitHub(t, [
    {
      number: 10,
      state: "MERGED",
      headRefName: "lower",
      headRefOid: sha("a"),
      commits: [sha("a")],
    },
    {
      number: 11,
      state: "OPEN",
      headRefName: "upper",
      headRefOid: sha("b"),
      commits: [sha("a"), sha("b")],
    },
  ]);
  const service = new PullRequestService(cwd);

  await service.refresh(
    [
      { name: "lower", sha: sha("a") },
      { name: "upper", sha: sha("b") },
    ],
    true
  );

  assert.equal(present(service.cached().get("lower"), "lower").number, 10);
  assert.equal(present(service.cached().get("upper"), "upper").number, 11);
});

test("a branch name reused by more than three pull requests shows the open one", async t => {
  const closed = [1, 2, 3, 4].map(number => ({
    number,
    state: /** @type {const} */ ("CLOSED"),
    headRefName: "fix-typo",
    headRefOid: sha(String(number)),
    commits: [sha(String(number))],
  }));
  const cwd = installStandInGitHub(t, [
    ...closed,
    {
      number: 5,
      state: "OPEN",
      headRefName: "fix-typo",
      headRefOid: sha("5"),
      commits: [sha("5")],
    },
  ]);
  const service = new PullRequestService(cwd);

  await service.refresh([{ name: "fix-typo", sha: sha("f") }], true);

  assert.equal(present(service.cached().get("fix-typo"), "fix-typo").number, 5);
});

test("a branch amended since its push keeps its pull request's CI verdict", async t => {
  const cwd = installStandInGitHub(t, [
    {
      number: 7,
      state: "OPEN",
      headRefName: "feature-a",
      headRefOid: sha("a"),
      commits: [sha("a")],
      checks: "FAILURE",
    },
  ]);
  const service = new PullRequestService(cwd);

  await service.refresh([{ name: "feature-a", sha: sha("b") }], true);

  assert.equal(
    present(service.cached().get("feature-a"), "feature-a").checks,
    "failure"
  );
});

test("a stack of 21 branches gets every badge", async t => {
  const branches = Array.from({ length: 21 }, (_, index) => ({
    name: `branch-${String(index).padStart(2, "0")}`,
    sha: index.toString(16).padStart(40, "0"),
  }));
  const cwd = installStandInGitHub(
    t,
    branches.map((branch, index) => ({
      number: 100 + index,
      state: "OPEN",
      headRefName: branch.name,
      headRefOid: branch.sha,
      commits: [branch.sha],
    }))
  );
  const service = new PullRequestService(cwd);

  await service.refresh(branches, true);

  const cached = service.cached();
  assert.equal(cached.size, 21);
  branches.forEach((branch, index) => {
    assert.equal(
      present(cached.get(branch.name), branch.name).number,
      100 + index
    );
  });
});
