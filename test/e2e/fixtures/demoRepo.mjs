/**
 * Per-test demo repository and web server.
 *
 * Every test gets its own working copy, because the operations under test rewrite
 * history. Generating the fixture from scratch each time costs ~330ms of git
 * subprocesses, so `globalSetup` builds one template and each test copies it —
 * a 1.2MB directory copy, roughly a hundred times cheaper. The copy carries the
 * template's absolute origin URL, so the remote is repointed at the new clone.
 *
 * The server is the same `out/hosts/server.js` that `just web` runs, one per test
 * on its own port. Its environment is pinned so history rewrites produce the same
 * shas on every machine: `GIT_COMMITTER_DATE` and `GIT_AUTHOR_DATE` fix the two
 * fields git would otherwise stamp with the current time, and the neutralised git
 * config keeps a developer's `commit.gpgsign`, `rebase.autosquash`, or custom
 * mergetool out of the result.
 */
import { execFile, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { createSnapshotTaker } from "./snapshot.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

/**
 * Fixed identity and clock for anything the server commits. The demo generator
 * uses the same author identity, so a rewritten commit keeps reading as "mine".
 */
const DETERMINISTIC_GIT_ENVIRONMENT = {
  GIT_COMMITTER_NAME: "Test Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
  GIT_COMMITTER_DATE: "1700009999 +0000",
  /**
   * The author date, pinned for the same reason as the committer date above.
   *
   * A history *rewrite* carries the original author date across, so the two commands that
   * do it need nothing here. A brand-new commit does not: `git commit` stamps the wall
   * clock, which changes both the sha and the date the commit panel prints. The
   * `after-commit` baseline recorded those, so it matched only for as long as the wall
   * clock stayed near the moment it was recorded and then drifted — 900-odd pixels against
   * a ~800-pixel threshold, so it passed or failed on the luck of which sha git produced.
   * A different value from the committer date, so a test that mixes them up shows it.
   */
  GIT_AUTHOR_DATE: "1700009998 +0000",
  // An empty config file, not a missing one: git rejects an unreadable path.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  TZ: "UTC",
};

/** Generate the template the per-test copies come from. Used by `globalSetup`. */
export function buildDemoTemplate() {
  const destination = mkdtempSync(join(tmpdir(), "gsm-e2e-template-"));
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [join(REPOSITORY_ROOT, "scripts", "make-demo-repo.mjs"), destination],
      { env: { ...process.env, ...DETERMINISTIC_GIT_ENVIRONMENT } },
      error => (error ? reject(error) : resolvePromise(destination))
    );
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function execGit(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...DETERMINISTIC_GIT_ENVIRONMENT } },
      (error, stdout) =>
        error ? reject(error) : resolvePromise(stdout.trimEnd())
    );
  });
}

/**
 * Run git in the working copy, retrying while the index is locked.
 *
 * `git status` takes `index.lock` to refresh the index, so a test's own
 * `git checkout` can collide with a read the server started a millisecond
 * earlier — the first paint, or a Refresh the test just clicked. Waiting is what
 * a person would do; failing here would report contention as a product bug.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} [attemptsLeft]
 * @returns {Promise<string>}
 */
async function runGit(cwd, args, attemptsLeft = 40) {
  try {
    return await execGit(cwd, args);
  } catch (error) {
    if (
      attemptsLeft > 0 &&
      /index\.lock/.test(String(/** @type {Error} */ (error).message))
    ) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      return runGit(cwd, args, attemptsLeft - 1);
    }
    throw error;
  }
}

/**
 * Ask the kernel for an unused port, then release it for the server to claim.
 *
 * Inherently racy: between the close and the server's bind, another worker can be
 * handed the same port — which is why `serveRepository` retries on EADDRINUSE
 * rather than treating a lost race as a failure. There is no way to hand a bound
 * socket to a child process here, since the server opens its own listener.
 *
 * @returns {Promise<number>}
 */
function reserveFreePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (
        probe.address()
      );
      probe.close(() => resolvePromise(port));
    });
  });
}

/**
 * Spawn the web host the UI is served from, and resolve once it is listening.
 *
 * Readiness comes from the line the server prints rather than from a fixed sleep,
 * and a premature exit rejects with everything the process wrote — a compile that
 * never ran, or a port that was taken, then reads as itself instead of as a
 * timeout twenty seconds later.
 *
 * @param {string} repository
 * @param {number} port
 * @param {NodeJS.ProcessEnv} [extraEnvironment]
 */
function startServer(repository, port, extraEnvironment = {}) {
  const child = spawn(
    process.execPath,
    [
      join(REPOSITORY_ROOT, "out", "hosts", "server.js"),
      repository,
      "--port",
      String(port),
      "--no-open",
    ],
    {
      env: {
        ...process.env,
        ...DETERMINISTIC_GIT_ENVIRONMENT,
        ...extraEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  /** @type {string[]} */
  const output = [];
  const ready = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Server did not start within 20s:\n${output.join("")}`)
        ),
      20000
    );
    const settle = (/** @type {(value?: unknown) => void} */ act) => {
      clearTimeout(timer);
      act();
    };
    const collect = (/** @type {string | Buffer} */ chunk) => {
      output.push(String(chunk));
      if (output.join("").includes("Git Stack Manager web UI:")) {
        settle(resolvePromise);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    // Only an exit *before* readiness is a failure; the kill below is expected.
    child.on("exit", code =>
      settle(() =>
        reject(
          new Error(`Server exited with code ${code}:\n${output.join("")}`)
        )
      )
    );
  });
  return { child, ready };
}

/**
 * Serve `repository`, retrying on a lost port race.
 *
 * Workers run in parallel, so two can be handed the same just-freed port and the
 * loser exits with EADDRINUSE. Asking for another port is the fix; without it a
 * clean suite fails a random test every few runs.
 *
 * Exported for `scripts/screenshot.mjs`, which frames the README picture against
 * this same fixture so the picture cannot show a state the product stopped
 * producing.
 *
 * @param {string} repository
 * @param {NodeJS.ProcessEnv} [environment]
 * @param {number} [attemptsLeft]
 */
export async function serveRepository(
  repository,
  environment = {},
  attemptsLeft = 5
) {
  const port = await reserveFreePort();
  const server = startServer(repository, port, environment);
  try {
    await server.ready;
    return { ...server, port };
  } catch (error) {
    server.child.kill("SIGKILL");
    if (
      attemptsLeft > 0 &&
      /EADDRINUSE/.test(String(/** @type {Error} */ (error).message))
    ) {
      return serveRepository(repository, environment, attemptsLeft - 1);
    }
    throw error;
  }
}

/**
 * Wait until the page has finished painting and will not re-render on its own.
 *
 * Loading takes two renders, not one: the first paints the model, then the pull
 * request fetch lands and `render()` rebuilds the tree from scratch. Every row and
 * button is a fresh element afterwards, so clicking one located before that second
 * render dispatches the event into a detached node and nothing happens — which
 * showed up as the absorb preview silently staying empty in roughly one run in
 * eight. `#tree .row` alone does not distinguish the two paints; the button the
 * fetch re-enables does.
 *
 * @param {import("@playwright/test").Page} page
 */
async function settle(page) {
  await page.waitForSelector("#tree .row");
  await page.waitForSelector("#btn-prs:not([disabled])");
}

/**
 * What the page is showing about work in flight, read while it is still open.
 *
 * A gerund label — "Continuing…", "Committing…" — is a button whose busy flag is still set,
 * so a set of them is the whole of "some action never finished". Reading them here rather
 * than in `assertNothingLeftBehind` is what lets the server be stopped before git is asked
 * anything, so no read of the extension's can race the checks.
 *
 * @param {import("@playwright/test").Page} page
 */
async function readWorkInFlight(page) {
  const labels = await page.locator("button").allInnerTexts();
  return {
    inProgress: labels.filter(label => /ing…$/.test(label.trim())),
    bannerOpen: (await page.locator("#conflict.open").count()) > 0,
  };
}

/**
 * What no test may leave behind, whatever it drove.
 *
 * Each operation plants scratch state — marker refs under `refs/heads/gsm-rebase`, a plan
 * file and scratch index files in the git directory — and removes it in a `finally`. Every
 * suite drives its own operation and checks its own result, so a leak survives as long as the
 * failure it causes is in *another* test: a marker left on abandoned history sends the next
 * rebase's chains back onto it. Sweeping here turns all of them into detectors.
 *
 * A rebase stopped on a conflict is the one state that keeps its scratch state, because the
 * operation is still running — and the UI has to be showing that, which is what pairs the
 * banner with git's own view.
 *
 * @param {DemoRepository} repository
 * @param {Awaited<ReturnType<typeof readWorkInFlight>>} shown
 */
async function assertNothingLeftBehind(repository, shown) {
  expect(shown.inProgress, "buttons still reporting work in flight").toEqual(
    []
  );

  const gitDirectory = join(repository.path, ".git");
  const paused =
    existsSync(join(gitDirectory, "rebase-merge")) ||
    existsSync(join(gitDirectory, "rebase-apply"));
  expect(paused, "git and the conflict banner disagree").toBe(shown.bannerOpen);
  if (paused) {
    return;
  }
  expect({
    markers: await repository.git([
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/gsm-rebase",
    ]),
    scratch: readdirSync(gitDirectory).filter(entry =>
      entry.startsWith("gsm-")
    ),
    // Every rewrite stages into a scratch index, and the one command that stages for real —
    // commit — commits in the same breath. No test stages anything, so an entry here is an
    // operation that stopped between `git add` and its commit and left the reader's index
    // holding changes they never staged.
    staged: await repository.git(["diff", "--cached", "--name-only"]),
  }).toEqual({ markers: "", scratch: [], staged: "" });
}

/**
 * Everything an interaction could change, in one value.
 *
 * Read before and after a gesture that must change nothing: refs and HEAD cover a rewrite or
 * a checkout, the branch name covers a detach that moved no commit, and the porcelain status
 * covers the working copy. One value rather than four assertions, so a difference reports
 * itself — `toEqual` prints which field moved.
 *
 * @param {DemoRepository} repository
 */
export async function stateOf(repository) {
  return {
    refs: await repository.git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/tags",
      "refs/stash",
    ]),
    head: await repository.git(["rev-parse", "HEAD"]),
    branch: await repository.git(["rev-parse", "--abbrev-ref", "HEAD"]),
    status: await repository.git(["status", "--porcelain"]),
  };
}

/**
 * Canned pull request statuses, one record per pull request, newest first.
 *
 * The demo repository's origin is a local bare repository, so nothing here can come
 * from GitHub — which is why every `.prbadge` variant renders in this demo and nowhere
 * else. `checksState` is GitHub's own rollup enum (`SUCCESS` | `FAILURE` | `PENDING`, or
 * absent when nothing ran) — the same shape `Commit.statusCheckRollup.state` answers with
 * in the real API, which `#github/pullRequests` reads directly.
 *
 * Branch name is the only key, so the demo generator stays free to add and remove
 * branches: a record whose branch is gone is never looked up, and a branch with no
 * record keeps a bare sync badge. #189 below names a branch the demo has never
 * produced, so that tolerance is asserted rather than assumed. escape-html,
 * mask-utils and redact-utils are absent on purpose — `submit.spec.mjs` drives those
 * down the "open a new pull request" path, and an open record would send them to
 * `gh pr edit` instead.
 *
 * The order pins `preferPullRequest`, which resolves a branch that has carried
 * several pull requests over time. case-utils lists its closed #204 before its open
 * #198, so taking the first match shows the wrong one; fix-slugify-unicode lists its
 * merged #142 before its closed #118, so taking the last match does too.
 *
 * The demo pushes only four branches, and the variants outnumber them, so the two
 * closed records sit on branches that have no upstream. That pairing is not a
 * contrived one: closing a pull request and pruning the remote branch leaves exactly
 * a local branch with no upstream and a closed pull request still bearing its name.
 */
/**
 * Stands for the commit origin holds for the record's branch, which the stand-in `gh` reads
 * when it answers. A literal sha would pin the demo generator's output, and resolving it per
 * call lets a test move the branch to what was pushed.
 */
const PUSHED_TIP = "<pushed tip>";

const CANNED_PULL_REQUESTS = [
  {
    number: 206,
    state: "OPEN",
    isDraft: false,
    title: "feat(trim): add collapseWhitespace",
    url: "https://github.com/example/strkit/pull/206",
    headRefName: "trim-utils",
    baseRefName: "pad-utils",
    reviewDecision: "APPROVED",
    checksState: "SUCCESS",
  },
  {
    number: 205,
    state: "OPEN",
    isDraft: true,
    title: "feat(pad): add padStart",
    url: "https://github.com/example/strkit/pull/205",
    headRefName: "pad-utils",
    baseRefName: "case-utils",
    reviewDecision: "REVIEW_REQUIRED",
    checksState: "PENDING",
  },
  {
    number: 204,
    state: "CLOSED",
    isDraft: false,
    title: "feat(case): camelCase, first attempt",
    url: "https://github.com/example/strkit/pull/204",
    headRefName: "case-utils",
    baseRefName: "main",
    reviewDecision: null,
    checksState: null,
  },
  {
    number: 198,
    state: "OPEN",
    isDraft: false,
    title: "feat(case): add camelCase and snakeCase",
    url: "https://github.com/example/strkit/pull/198",
    headRefName: "case-utils",
    baseRefName: "main",
    reviewDecision: "CHANGES_REQUESTED",
    checksState: "FAILURE",
  },
  {
    number: 191,
    state: "CLOSED",
    isDraft: false,
    title: "feat(parse): add parseDates",
    url: "https://github.com/example/strkit/pull/191",
    headRefName: "parse-dates",
    baseRefName: "parse-utils",
    reviewDecision: null,
    checksState: "FAILURE",
  },
  {
    number: 173,
    state: "CLOSED",
    isDraft: false,
    title: "experiment(pad): add repeat helper",
    url: "https://github.com/example/strkit/pull/173",
    headRefName: "local-experiment",
    baseRefName: "pad-utils",
    reviewDecision: null,
    // No non-cancelled check ran, so the rollup holds nothing and the badge shows no
    // CI glyph at all.
    checksState: null,
  },
  {
    number: 189,
    state: "MERGED",
    isDraft: false,
    title: "feat: add words",
    url: "https://github.com/example/strkit/pull/189",
    // Deleted after merging, which is the ordinary end of a pull request's life and
    // the state a stale record has to survive.
    headRefName: "add-words",
    baseRefName: "main",
    reviewDecision: "APPROVED",
    checksState: null,
  },
  {
    number: 142,
    state: "MERGED",
    isDraft: false,
    title: "fix(slugify): strip diacritics so accented input slugifies",
    url: "https://github.com/example/strkit/pull/142",
    headRefName: "fix-slugify-unicode",
    // The commit that was pushed and merged. The branch was amended after the push, so
    // its local tip differs and deleting merged branches keeps it.
    headRefOid: PUSHED_TIP,
    baseRefName: "main",
    reviewDecision: "APPROVED",
    checksState: null,
  },
  {
    number: 118,
    state: "CLOSED",
    isDraft: false,
    title: "fix(slugify): normalize before slugifying",
    url: "https://github.com/example/strkit/pull/118",
    headRefName: "fix-slugify-unicode",
    baseRefName: "main",
    reviewDecision: null,
    checksState: null,
  },
];

/**
 * Install a stand-in `gh` in `directory` and answer how to reach it.
 *
 * Exported so `just demo` can install the same stand-in it does here: the demo's
 * origin is a local bare repository, so a real `gh pr list` there reports "no GitHub
 * remote" and a person clicking through the demo never sees a pull request badge.
 * Putting this directory first on PATH is the whole of that fix, and it needs no
 * production code — nothing in `src/` refers to a stand-in, and a shim that only a
 * recipe's own process can see cannot reach a real repository.
 *
 * Three different questions each need their own answer. Submit passes `--head` to
 * `gh pr list` to find one branch's open pull request. The badge fetch resolves the
 * owner and name through `gh repo view`, then asks `gh api graphql` for every branch
 * twice over — by name and by tip commit, aliased `n{index}`/`c{index}` — in one query
 * per batch. `#github/pullRequests` builds and parses that query, so this reads the
 * same one back with a regex rather than a GraphQL parser.
 *
 * Every canned record's `headRefOid` is resolved here, against the demo repository's
 * actual local branch tips, rather than hardcoded: a literal sha would drift the moment
 * the demo generator changed anything upstream of that commit. `PUSHED_TIP` is the one
 * exception, resolved against the *remote* branch instead, for the record whose local
 * tip has since diverged from what was pushed — found only by the name lookup, since a
 * lookup by commit cannot find a pull request at a commit the branch has moved past.
 *
 * @param {string} directory
 */
export function writeStandInGitHub(directory) {
  // Each invocation is its own `gh` process, and a fetch's batches — or a submit
  // running alongside a background refresh — can have two invocations writing at
  // once. One file per call, rather than one shared file appended by many
  // processes, needs no atomic-append guarantee from the filesystem underneath.
  const logDirectory = join(directory, "calls");
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(
    join(directory, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const PULL_REQUESTS = ${JSON.stringify(CANNED_PULL_REQUESTS)}.map((pullRequest) => ({
  ...pullRequest,
  headRefOid:
    pullRequest.headRefOid === ${JSON.stringify(PUSHED_TIP)}
      ? tipOf("refs/remotes/origin/" + pullRequest.headRefName)
      : tipOf("refs/heads/" + pullRequest.headRefName),
}));
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  const callPath = path.join(
    ${JSON.stringify(logDirectory)},
    \`\${Date.now()}-\${process.pid}-\${crypto.randomUUID()}.json\`
  );
  fs.writeFileSync(callPath, JSON.stringify({ args, stdin }));
  process.stdout.write(answer());
});

function answer() {
  if (args[0] === "pr" && args[1] === "create") {
    return "https://github.com/example/example/pull/101\\n";
  }
  if (args[0] === "pr" && args[1] === "list") {
    return JSON.stringify(listPullRequests());
  }
  if (args[0] === "repo" && args[1] === "view") {
    return JSON.stringify({ owner: { login: "example" }, name: "strkit" });
  }
  if (args[0] === "api" && args[1] === "graphql") {
    return answerGraphql();
  }
  // Everything else — \`pr edit\` among them — reports success and says nothing,
  // which is what the callers of those commands read.
  return "[]";
}

function tipOf(ref) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "-q", ref], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function listPullRequests() {
  const head = option("--head");
  // gh defaults to open when --state is absent, and treats a draft as open.
  const state = (option("--state") || "open").toUpperCase();
  const limit = Number(option("--limit") || 30);
  const fields = (option("--json") || "").split(",").filter(Boolean);
  const matching = PULL_REQUESTS.filter(
    (pullRequest) =>
      (!head || pullRequest.headRefName === head) &&
      (state === "ALL" || pullRequest.state === state),
  ).slice(0, limit);
  if (!fields.length) {
    return matching;
  }
  // gh emits only the fields --json names, so a reader depending on an unrequested
  // one fails against this the way it would against the real CLI.
  return matching.map((pullRequest) =>
    Object.fromEntries(fields.map((field) => [field, pullRequest[field]])),
  );
}

// Prefer an open pull request, then the highest number — the newest. Mirrors
// \`preferPullRequest\` in #github/pullRequests, which is what decides among the several
// nodes this can return for one commit once the real caller has them.
function betterPullRequest(candidate, existing) {
  const openness = (pullRequest) => (pullRequest.state === "OPEN" ? 1 : 0);
  if (openness(candidate) !== openness(existing)) {
    return openness(candidate) > openness(existing);
  }
  return candidate.number > existing.number;
}

function nodeFrom(pullRequest) {
  return {
    number: pullRequest.number,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    title: pullRequest.title,
    url: pullRequest.url,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid,
    reviewDecision: pullRequest.reviewDecision,
  };
}

function answerGraphql() {
  const repository = {};
  const namePattern = /n(\\d+): pullRequests\\(headRefName: "([^"]*)"/g;
  let nameMatch;
  while ((nameMatch = namePattern.exec(stdin))) {
    const [, index, name] = nameMatch;
    const matching = PULL_REQUESTS.filter(
      (pullRequest) => pullRequest.headRefName === name,
    );
    repository["n" + index] = { nodes: matching.map(nodeFrom) };
  }
  const commitPattern = /c(\\d+): object\\(oid: "([0-9a-f]{40})"\\)/g;
  let commitMatch;
  while ((commitMatch = commitPattern.exec(stdin))) {
    const [, index, sha] = commitMatch;
    const matching = PULL_REQUESTS.filter(
      (pullRequest) => pullRequest.headRefOid && pullRequest.headRefOid === sha,
    );
    if (!matching.length) {
      repository["c" + index] = null;
      continue;
    }
    const commitRecord = matching.reduce((best, pullRequest) =>
      betterPullRequest(pullRequest, best) ? pullRequest : best,
    );
    repository["c" + index] = {
      statusCheckRollup: commitRecord.checksState
        ? { state: commitRecord.checksState }
        : null,
      associatedPullRequests: { nodes: matching.map(nodeFrom) },
    };
  }
  return JSON.stringify({ data: { repository } });
}
`,
    { mode: 0o755 }
  );
  return {
    environment: { PATH: `${directory}:${process.env.PATH}` },
    calls: () =>
      readdirSync(logDirectory)
        .sort()
        .map(name =>
          JSON.parse(readFileSync(join(logDirectory, name), "utf8"))
        ),
  };
}

/**
 * @typedef {object} DemoRepository
 * @property {string} path Working copy, for setting up state git owns.
 * @property {(args: string[]) => Promise<string>} git Runs git in that working copy.
 */

/**
 * @typedef {object} Fixtures
 * @property {DemoRepository} demoRepository
 * @property {ReturnType<typeof writeStandInGitHub>} fakeGitHub
 * @property {import("@playwright/test").Page} smartlog
 * @property {ReturnType<typeof createSnapshotTaker>} snapshot
 */

/**
 * `demoRepository` exposes the working copy so a test can set up state git owns
 * (a dirty file, a checked-out branch) before driving the UI, and `smartlog`
 * opens the served page. `reopen` re-enters after changing something git owns.
 *
 * The `Fixtures` annotation is what lets a spec destructure these names. Playwright
 * infers nothing from the object literal, so without it every `{ smartlog }` reads
 * as a property missing from `PlaywrightTestArgs` — 124 errors across the suite from
 * this one call.
 *
 * @type {import("@playwright/test").TestType<
 *   import("@playwright/test").PlaywrightTestArgs &
 *     import("@playwright/test").PlaywrightTestOptions &
 *     Fixtures,
 *   import("@playwright/test").PlaywrightWorkerArgs &
 *     import("@playwright/test").PlaywrightWorkerOptions
 * >}
 */
export const test = base.extend({
  demoRepository: async ({}, use, testInfo) => {
    const template = process.env.GSM_DEMO_TEMPLATE;
    if (!template) {
      throw new Error("GSM_DEMO_TEMPLATE is unset — globalSetup did not run.");
    }
    const root = join(testInfo.outputDir, "demo");
    cpSync(template, root, { recursive: true });
    const work = join(root, "work");
    // The copy inherited the template's origin path; point it at this copy's own
    // bare remote so pushes and fetches stay inside the test's directory.
    await runGit(work, [
      "remote",
      "set-url",
      "origin",
      join(root, "origin.git"),
    ]);
    await use({ path: work, git: args => runGit(work, args) });
    rmSync(root, { recursive: true, force: true });
  },

  /**
   * A stand-in `gh` on the server's PATH, recording every call.
   *
   * Submitting is the one action that reaches GitHub, so driving it end to end needs
   * a `gh` that answers without a network or an account. The pushes stay real — they
   * go to the copy's own bare origin — because the push is half of what submit does;
   * only the pull request side is faked.
   *
   * Installed for every test, not just the submit ones. The alternative is the real
   * `gh`, whose answer here depends on whether the developer happens to be logged
   * in: it reports no pull requests for the demo repository either way, but by two
   * different paths, and one of them spends a network round trip on every page load.
   *
   * `writeStandInGitHub` above holds the canned answers and explains what they cover.
   */
  fakeGitHub: async ({}, use, testInfo) => {
    await use(writeStandInGitHub(join(testInfo.outputDir, "fake-gh")));
  },

  smartlog: async ({ demoRepository, fakeGitHub, page }, use) => {
    const server = await serveRepository(
      demoRepository.path,
      fakeGitHub.environment
    );
    // Stop the browser-mode background poll before any page script runs.
    //
    // Every five seconds the UI re-reads the model, which can land between an
    // action's result and a snapshot read and overwrite it. Worse, the reader
    // spends several git processes per snapshot, so a poll straddling a
    // concurrent commit can render a commit before the branch tip carrying it —
    // a torn read the next poll corrects, but which a snapshot would capture as
    // a wrong graph. The poll picks up external edits; it is not what these
    // tests drive, and Refresh exercises the same `loadModel` path explicitly.
    await page.addInitScript(() => {
      // Through `unknown`, because the Node types intersect an overload returning a
      // `Timeout` object into this signature and no number-returning stub overlaps it.
      window.setInterval = /** @type {typeof window.setInterval} */ (
        /** @type {unknown} */ (() => 0)
      );
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await settle(page);
    await use(page);
    const shown = await readWorkInFlight(page);
    server.child.kill("SIGKILL");
    await assertNothingLeftBehind(demoRepository, shown);
  },

  snapshot: async ({ smartlog }, use) => {
    await use(createSnapshotTaker(smartlog));
  },
});

/**
 * Re-read the page after changing something git owns.
 *
 * The UI's own poll is disabled above, and Refresh is itself under test, so a
 * reload is the neutral way to re-enter with the new repository state.
 *
 * @param {import("@playwright/test").Page} page
 */
export async function reopen(page) {
  await page.reload();
  await settle(page);
}

export { expect } from "@playwright/test";
