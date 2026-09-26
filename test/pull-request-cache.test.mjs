/**
 * The pull request cache: what it serves between fetches, and what forcing one means.
 *
 * Both subjects here are timing around `gh`, not parsing of what `gh` said — a fetch that
 * answers late, and a refresh asked for while another is already running. So the stand-in
 * `gh` answers from a script, one reply per `api graphql` call, which is what lets a test
 * make the second answer differ from the first and then check which one the caller got.
 * `repo view` — the one-time owner/name lookup every fetch needs — answers instantly and
 * outside the script, since no test here is about that call.
 *
 * The badge fields themselves are covered by `check-rollup.test.mjs` and
 * `webview-badges.test.mjs`; nothing here asserts a glyph.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PullRequestService } from "#github/pullRequests";
import { present } from "./present.mjs";
import { scratchRoot } from "./repoFixture.mjs";

/** @typedef {import("#github/pullRequests").PullRequestStatus} PullRequestStatus */

/** The branch every test here asks about, and the commit it sits on. */
const TIPS = [{ name: "feature-a", sha: "a".repeat(40) }];

/**
 * `c0`'s answer for `TIPS[0]`'s commit, as GitHub's GraphQL API would shape it: a rollup
 * plus the pull requests associated with that exact commit.
 *
 * @param {Partial<Record<string, unknown>>} [fields]
 */
function commitNode(fields = {}) {
  return {
    statusCheckRollup: { state: "SUCCESS" },
    associatedPullRequests: {
      nodes: [
        {
          number: 7,
          state: "OPEN",
          isDraft: false,
          title: "feat: part A",
          url: "https://github.com/example/example/pull/7",
          headRefName: "feature-a",
          headRefOid: TIPS[0].sha,
          reviewDecision: "APPROVED",
        },
      ],
    },
    ...fields,
  };
}

/** `c0`'s answer when nothing has caught up to this commit yet. */
const NOTHING_FOUND = {
  statusCheckRollup: null,
  associatedPullRequests: { nodes: [] },
};

/**
 * Put a `gh` on PATH that answers `repo view` fixed and instant, and `api graphql` from a
 * script, one reply per call.
 *
 * A reply can sleep before answering, which is how a test holds one fetch open while it
 * asks for another. The call counter is written before the sleep so a concurrent second
 * call still reads the next reply rather than repeating this one. `callCount` counts only
 * `api graphql` calls — `repo view` is a fixed, cached lookup no test here is about.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ output: unknown, sleepMilliseconds?: number }[]} replies
 */
function installScriptedGh(t, replies) {
  const root = scratchRoot(t, "gsm-pr-cache-");
  const binDirectory = join(root, "fakebin");
  const repliesPath = join(root, "replies.json");
  const counterPath = join(root, "calls");
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(repliesPath, JSON.stringify(replies));
  writeFileSync(counterPath, "0");
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "repo" && process.argv[3] === "view") {
  process.stdout.write(JSON.stringify({ owner: { login: "example" }, name: "example" }));
  process.exit(0);
}
const replies = JSON.parse(fs.readFileSync(${JSON.stringify(repliesPath)}, "utf8"));
const called = Number(fs.readFileSync(${JSON.stringify(counterPath)}, "utf8"));
fs.writeFileSync(${JSON.stringify(counterPath)}, String(called + 1));
const reply = replies[Math.min(called, replies.length - 1)];
process.stdin.resume();
process.stdin.on("end", () => {
  setTimeout(
    () =>
      process.stdout.write(
        JSON.stringify({
          data: { repository: { n0: { nodes: [] }, c0: reply.output } },
        })
      ),
    reply.sleepMilliseconds || 0
  );
});
`,
    { mode: 0o755 }
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  return {
    cwd: root,
    callCount: () => Number(readFileSync(counterPath, "utf8")),
  };
}

/**
 * What submit knows about a pull request it just opened: a number and the text it wrote,
 * and nothing about checks, which have not run against the new head yet.
 *
 * @returns {PullRequestStatus}
 */
function statusFromSubmit() {
  return {
    number: 7,
    state: "OPEN",
    isDraft: false,
    title: "feat: part A",
    url: "https://github.com/example/example/pull/7",
    headSha: "",
    reviewDecision: null,
    checks: null,
  };
}

test("a pull request recorded at submit time fills in until the fetch has it", async t => {
  // GitHub has not finished associating a just-opened pull request with its commit, so the
  // first fetch finds nothing for a branch whose pull request already exists — the state
  // right after a submit.
  const gh = installScriptedGh(t, [
    { output: NOTHING_FOUND },
    { output: commitNode() },
    { output: NOTHING_FOUND },
  ]);
  const service = new PullRequestService(gh.cwd);

  await service.refresh(TIPS, true);
  assert.equal(service.cached().get("feature-a"), undefined);

  service.remember("feature-a", statusFromSubmit());
  const recorded = present(
    service.cached().get("feature-a"),
    "the recorded pull request for feature-a"
  );
  assert.equal(recorded.number, 7);
  // Nothing is invented: the record says only what submit read.
  assert.equal(recorded.checks, null);
  assert.equal(recorded.reviewDecision, null);

  // The fetch caught up. Its copy carries the checks and review decision a record taken
  // at submit time cannot, so it has to win.
  await service.refresh(TIPS, true);
  const fetched = present(
    service.cached().get("feature-a"),
    "the fetched pull request for feature-a"
  );
  assert.equal(fetched.checks, "success");
  assert.equal(fetched.reviewDecision, "APPROVED");

  // And the record is gone rather than lingering behind the fetch: a branch whose pull
  // request the fetch stops reporting has to stop showing one.
  await service.refresh(TIPS, true);
  assert.equal(service.cached().get("feature-a"), undefined);
});

test("a forced refresh runs its own fetch instead of adopting one already in flight", async t => {
  const gh = installScriptedGh(t, [
    { output: NOTHING_FOUND, sleepMilliseconds: 300 },
    { output: commitNode() },
  ]);
  const service = new PullRequestService(gh.cwd);

  // The first paint's fetch, still running when the second caller arrives — which is the
  // submit case: the answer in flight predates the pull request being asked about.
  const background = service.refresh(TIPS);
  const forced = await service.refresh(TIPS, true);
  await background;

  assert.equal(
    present(
      forced.get("feature-a"),
      "the pull request the forced refresh returned"
    ).number,
    7
  );
  assert.equal(gh.callCount(), 2);
});

test("two refreshes that are not forced share one gh invocation", async t => {
  const gh = installScriptedGh(t, [
    { output: commitNode(), sleepMilliseconds: 200 },
  ]);
  const service = new PullRequestService(gh.cwd);

  const [first, second] = await Promise.all([
    service.refresh(TIPS),
    service.refresh(TIPS),
  ]);

  assert.equal(present(first.get("feature-a"), "the first result").number, 7);
  assert.equal(present(second.get("feature-a"), "the second result").number, 7);
  // The file watcher and the first paint can ask at the same moment; one `gh` per refresh
  // is what keeps that from doubling the network cost.
  assert.equal(gh.callCount(), 1);
});

test("a fetch's duration and outcome go to the log, not to any command panel", async t => {
  // The command log only ever sees an action's own git and gh calls; the fetch behind a
  // badge runs on a timer with no action to attribute it to, so it needs a home of its own.
  const gh = installScriptedGh(t, [{ output: commitNode() }]);
  /** @type {string[]} */
  const lines = [];
  const service = new PullRequestService(gh.cwd, line => lines.push(line));

  await service.refresh(TIPS, true);

  assert.ok(lines.some(line => line.startsWith("gh repo view")));
  assert.ok(lines.some(line => line.startsWith("gh api graphql")));
  assert.ok(lines.filter(line => /→ ok in \d+ms/.test(line)).length >= 2);
});

test("a failed fetch logs why, since the badge's own sentence cannot say", async t => {
  // "GitHub did not answer in time" reads the same whether gh was killed, GitHub 504'd, or
  // the query itself took too long — the log is where that difference has to show up. Every
  // call this fake `gh` receives fails the same way, so this also covers the `repo view`
  // lookup a fetch makes before it ever reaches the batch that would 504.
  const root = scratchRoot(t, "gsm-pr-log-");
  const binDirectory = join(root, "fakebin");
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("GraphQL: the query took too long to execute.\\n");
  process.exit(1);
});
`,
    { mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  /** @type {string[]} */
  const lines = [];
  const service = new PullRequestService(root, line => lines.push(line));

  await service.refresh(TIPS, true);

  assert.equal(
    service.availabilityReason(),
    "GitHub did not answer the pull request query in time. Try again in a moment."
  );
  assert.ok(
    lines.some(
      line => line.includes("failed after") && line.includes("unreachable")
    )
  );
});

test("a fetch reports progress once per batch, not once per branch", async t => {
  const gh = installScriptedGh(t, [{ output: commitNode() }]);
  /** @type {[number, number][]} */
  const progress = [];
  const service = new PullRequestService(
    gh.cwd,
    () => {},
    (done, total) => progress.push([done, total])
  );

  await service.refresh(TIPS, true);

  // One branch is one batch, so progress fires exactly once, already at completion.
  assert.deepEqual(progress, [[1, 1]]);
});
