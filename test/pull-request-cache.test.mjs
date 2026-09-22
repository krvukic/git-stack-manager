/**
 * The pull request cache: what it serves between fetches, and what forcing one means.
 *
 * Both subjects here are timing around `gh`, not parsing of what `gh` said — a search
 * index that answers late, and a refresh asked for while another is already running. So
 * the stand-in `gh` answers from a script, one reply per call, which is what lets a test
 * make the second answer differ from the first and then check which one the caller got.
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
 * One entry of a `gh pr list --json` response, as GitHub would return it.
 *
 * @param {Partial<Record<string, unknown>>} [fields]
 */
function pullRequestJson(fields = {}) {
  return {
    number: 7,
    state: "OPEN",
    isDraft: false,
    title: "feat: part A",
    url: "https://github.com/example/example/pull/7",
    headRefName: "feature-a",
    headRefOid: TIPS[0].sha,
    reviewDecision: "APPROVED",
    statusCheckRollup: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
    ...fields,
  };
}

/**
 * Put a `gh` on PATH that answers `pr list` from a script, one reply per call.
 *
 * A reply can sleep before answering, which is how a test holds one fetch open while it
 * asks for another. The call counter is written before the sleep so a concurrent second
 * call still reads the next reply rather than repeating this one.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ output: unknown[], sleepMilliseconds?: number }[]} replies
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
const replies = JSON.parse(fs.readFileSync(${JSON.stringify(repliesPath)}, "utf8"));
const called = Number(fs.readFileSync(${JSON.stringify(counterPath)}, "utf8"));
fs.writeFileSync(${JSON.stringify(counterPath)}, String(called + 1));
const reply = replies[Math.min(called, replies.length - 1)];
setTimeout(
  () => process.stdout.write(JSON.stringify(reply.output)),
  reply.sleepMilliseconds || 0
);
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

test("a pull request recorded at submit time fills in until the search index has it", async t => {
  // GitHub indexes a new pull request asynchronously, so the first search finds nothing
  // for a branch whose pull request already exists — the state right after a submit.
  const gh = installScriptedGh(t, [
    { output: [] },
    { output: [pullRequestJson()] },
    { output: [] },
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

  // The index caught up. Its copy carries the checks and review decision a record taken
  // at submit time cannot, so it has to win.
  await service.refresh(TIPS, true);
  const fetched = present(
    service.cached().get("feature-a"),
    "the fetched pull request for feature-a"
  );
  assert.equal(fetched.checks, "success");
  assert.equal(fetched.reviewDecision, "APPROVED");

  // And the record is gone rather than lingering behind the fetch: a branch whose pull
  // request the search stops reporting has to stop showing one.
  await service.refresh(TIPS, true);
  assert.equal(service.cached().get("feature-a"), undefined);
});

test("a forced refresh runs its own fetch instead of adopting one already in flight", async t => {
  const gh = installScriptedGh(t, [
    { output: [], sleepMilliseconds: 300 },
    { output: [pullRequestJson()] },
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
    { output: [pullRequestJson()], sleepMilliseconds: 200 },
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
