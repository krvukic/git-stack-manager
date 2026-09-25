/**
 * `gh stack` state reading.
 *
 * `.git/gh-stack` is an implementation detail of a public-preview extension, so these
 * tests pin the two things that protect against it changing: the schema version check, and
 * that the derived "needs rebase" verdict matches what `gh stack view --json` reports. The
 * comparison against the real CLI is skipped when `gh stack` is not installed, so the suite
 * still runs anywhere.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Repository } from "#app/repository";
import { GitRunner } from "#git/runner";
import {
  ghStackArguments,
  indexStackMembership,
  readGhStacks,
  runGhStackCommand,
} from "#github/ghStack";
import {
  commitFile,
  initRepoWithOrigin,
  run,
  writeGhStackState,
} from "../scripts/git-fixture.mjs";
import { branchShas, scratchRoot } from "./repoFixture.mjs";

/**
 * A repository with one commit and no stack state, so `.git` is somewhere to write one.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} [prefix]
 */
function scratchRepository(t, prefix = "gsm-ghstack-") {
  const root = scratchRoot(t, prefix);
  const { repo } = initRepoWithOrigin(root);
  commitFile(repo, "f.txt", "base\n", "initial");
  return { repo, gitDirectory: join(repo, ".git") };
}

/**
 * Write a `.git/gh-stack` state file with the given contents.
 *
 * @param {string} gitDirectory
 * @param {unknown} state
 */
function writeState(gitDirectory, state) {
  writeFileSync(join(gitDirectory, "gh-stack"), JSON.stringify(state));
}

/** Whether the `gh stack` extension is available to compare against. */
function ghStackAvailable() {
  try {
    execFileSync("gh", ["stack", "--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("an unknown schema version yields no stacks rather than a guess", t => {
  const { gitDirectory } = scratchRepository(t);
  // A future `gh stack` may reshape the file. Reporting nothing loses badges;
  // guessing at the new shape would show wrong ones.
  writeState(gitDirectory, {
    schemaVersion: 99,
    stacks: [
      {
        trunk: { branch: "main", head: "a" },
        branches: [{ branch: "x", base: "a" }],
      },
    ],
  });
  assert.deepEqual(readGhStacks(gitDirectory), []);
});

test("malformed state is ignored instead of throwing", t => {
  const { gitDirectory } = scratchRepository(t);
  writeFileSync(join(gitDirectory, "gh-stack"), "{ truncated");
  assert.deepEqual(readGhStacks(gitDirectory), []);

  // A stack with no usable branches carries no information.
  writeState(gitDirectory, {
    schemaVersion: 1,
    stacks: [{ branches: [{ nope: true }] }],
  });
  assert.deepEqual(readGhStacks(gitDirectory), []);
});

test("no state file at all is the common case, not an error", t => {
  const { gitDirectory } = scratchRepository(t);
  assert.deepEqual(readGhStacks(gitDirectory), []);
});

test("membership reports each branch's layer and flags a drifted base", () => {
  const stacks = [
    {
      workingDirectory: "/repo",
      trunkBranch: "main",
      trunkHead: "trunk-sha",
      branches: [
        { branch: "lower", base: "trunk-sha" },
        { branch: "upper", base: "lower-old-sha" },
      ],
    },
  ];
  // `lower` has moved since `upper` recorded its base, which is what an amend or
  // rebase of the lower layer looks like.
  const membership = indexStackMembership(
    stacks,
    new Map([
      ["lower", "lower-new-sha"],
      ["upper", "upper-sha"],
    ])
  );
  assert.deepEqual(membership.get("lower"), {
    position: 1,
    size: 2,
    needsRebase: false,
  });
  assert.deepEqual(membership.get("upper"), {
    position: 2,
    size: 2,
    needsRebase: true,
  });
});

test("command arguments match the documented gh stack flags", () => {
  assert.deepEqual(ghStackArguments({ kind: "submit" }), ["stack", "submit"]);
  assert.deepEqual(ghStackArguments({ kind: "push" }), ["stack", "push"]);
  assert.deepEqual(ghStackArguments({ kind: "sync", prune: true }), [
    "stack",
    "sync",
    "--prune",
  ]);
  assert.deepEqual(ghStackArguments({ kind: "sync", prune: false }), [
    "stack",
    "sync",
  ]);
  assert.deepEqual(ghStackArguments({ kind: "rebase", scope: "all" }), [
    "stack",
    "rebase",
  ]);
  assert.deepEqual(ghStackArguments({ kind: "rebase", scope: "upstack" }), [
    "stack",
    "rebase",
    "--upstack",
  ]);
});

test(
  "the derived needsRebase verdict agrees with `gh stack view --json`",
  { skip: ghStackAvailable() ? false : "gh stack extension not installed" },
  t => {
    const { repo } = scratchRepository(t, "gsm-ghstack-live-");
    // `gh stack init` needs a GitHub remote to name the stack after; the URL is
    // never contacted.
    run(repo, "git", [
      "remote",
      "set-url",
      "origin",
      "https://github.com/example/example.git",
    ]);
    run(repo, "git", ["switch", "-qc", "lower"]);
    commitFile(repo, "lower.txt", "lower\n", "lower work");
    run(repo, "git", ["switch", "-qc", "upper"]);
    commitFile(repo, "upper.txt", "upper\n", "upper work");
    execFileSync("gh", ["stack", "init", "lower", "upper"], {
      cwd: repo,
      stdio: "ignore",
    });

    // Amending the lower layer is what makes the upper one stale.
    run(repo, "git", ["switch", "-q", "lower"]);
    run(repo, "git", [
      "commit",
      "-q",
      "--amend",
      "--no-edit",
      "-m",
      "lower work, amended",
    ]);

    const reported = JSON.parse(
      execFileSync("gh", ["stack", "view", "--json"], {
        cwd: repo,
        encoding: "utf8",
      })
    );
    const derived = indexStackMembership(
      readGhStacks(join(repo, ".git")),
      branchShas(repo)
    );

    for (const branch of reported.branches) {
      assert.equal(
        derived.get(branch.name)?.needsRebase,
        branch.needsRebase,
        `needsRebase for ${branch.name} must match gh stack's own verdict`
      );
    }
  }
);

/**
 * A two-layer stack whose `gh stack` state lives in a linked worktree, which is where
 * `gh stack init` puts it when run there. The worktree is detached at the top layer's tip,
 * the way a worktree looks once its branch has been freed for checking out elsewhere.
 *
 * @param {import("node:test").TestContext} t
 */
function stackInLinkedWorktree(t) {
  const { repo } = scratchRepository(t, "gsm-ghstack-worktree-");
  run(repo, "git", ["switch", "-qc", "lower"]);
  commitFile(repo, "lower.txt", "lower\n", "lower work");
  run(repo, "git", ["switch", "-qc", "upper"]);
  commitFile(repo, "upper.txt", "upper\n", "upper work");
  run(repo, "git", ["switch", "-q", "main"]);
  const worktree = join(repo, "..", "feature");
  run(repo, "git", ["worktree", "add", "-q", "--detach", worktree, "upper"]);
  writeGhStackState(repo, [{ trunk: "main", branches: ["lower", "upper"] }]);
  renameSync(
    join(repo, ".git", "gh-stack"),
    join(repo, ".git", "worktrees", "feature", "gh-stack")
  );
  return { repo, worktree };
}

/**
 * Put a fake `gh` on PATH that records where it ran and which branch was checked out there,
 * since `gh stack` finds its stack from exactly those two.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} root
 */
function recordingGh(t, root) {
  const binDirectory = join(root, "fakebin");
  const logPath = join(root, "gh-calls.jsonl");
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/usr/bin/env node
const { execFileSync } = require("child_process");
let head = null;
try {
  head = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {}
require("fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), head }) + "\\n");
`,
    { mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  return () =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line))
      : [];
}

/**
 * The reported case: `gh stack init` ran in a linked worktree, and the main checkout's
 * panel showed no stack at all, because it read only the common `.git/gh-stack`.
 */
test("a stack recorded in a linked worktree shows from the main checkout", async t => {
  const { repo, worktree } = stackInLinkedWorktree(t);
  const snapshot = await new Repository(repo).read();
  assert.deepEqual(snapshot.stackMembership.get("upper"), {
    position: 2,
    size: 2,
    needsRebase: false,
  });
  assert.equal(
    readGhStacks(join(repo, ".git"))[0]?.workingDirectory,
    worktree,
    "commands for this stack have to run in the worktree that owns it"
  );
});

test("a branch tracked in two worktrees takes the reading checkout's own stack", t => {
  const { repo, worktree } = stackInLinkedWorktree(t);
  // The main checkout's own stack holds `upper` alone, so its size tells the two apart.
  writeGhStackState(repo, [{ trunk: "lower", branches: ["upper"] }]);
  const commonDirectory = join(repo, ".git");
  const fromMain = indexStackMembership(
    readGhStacks(commonDirectory),
    branchShas(repo)
  );
  const fromWorktree = indexStackMembership(
    readGhStacks(
      commonDirectory,
      join(commonDirectory, "worktrees", "feature")
    ),
    branchShas(worktree)
  );
  assert.equal(fromMain.get("upper")?.size, 1);
  assert.equal(fromWorktree.get("upper")?.size, 2);
});

test("a gh stack command runs in the owning worktree, attached only while it runs", async t => {
  const { repo, worktree } = stackInLinkedWorktree(t);
  const calls = recordingGh(t, join(repo, ".."));
  await runGhStackCommand(new GitRunner(repo), { kind: "push" }, "lower");
  assert.deepEqual(calls(), [
    { args: ["stack", "push"], cwd: worktree, head: "upper" },
  ]);
  assert.equal(
    run(worktree, "git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    "HEAD",
    "the worktree is detached again, so `upper` stays free to check out"
  );
});

test("a gh stack command refuses an owner checked out on another branch", async t => {
  const { repo, worktree } = stackInLinkedWorktree(t);
  const calls = recordingGh(t, join(repo, ".."));
  run(worktree, "git", ["switch", "-qc", "elsewhere", "main"]);
  await assert.rejects(
    runGhStackCommand(new GitRunner(repo), { kind: "push" }, "upper"),
    /has elsewhere checked out\. Check out one of lower, upper there first\./
  );
  assert.deepEqual(calls(), [], "gh never ran on the wrong stack");
  assert.equal(
    run(worktree, "git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    "elsewhere",
    "the worktree was left where it was"
  );
});

/**
 * Pins the per-worktree location against the real CLI: if a later `gh stack` moves its
 * state to the common directory, this still passes, and if it moves it anywhere else, the
 * badge would vanish again and this fails.
 */
test(
  "`gh stack init` in a linked worktree is read from the main checkout",
  { skip: ghStackAvailable() ? false : "gh stack extension not installed" },
  async t => {
    const { repo } = scratchRepository(t, "gsm-ghstack-live-worktree-");
    run(repo, "git", [
      "remote",
      "set-url",
      "origin",
      "https://github.com/example/example.git",
    ]);
    run(repo, "git", ["switch", "-qc", "lower"]);
    commitFile(repo, "lower.txt", "lower\n", "lower work");
    run(repo, "git", ["switch", "-q", "main"]);
    const worktree = join(repo, "..", "feature");
    run(repo, "git", ["worktree", "add", "-q", worktree, "lower"]);
    execFileSync("gh", ["stack", "init", "lower"], {
      cwd: worktree,
      stdio: "ignore",
    });

    const snapshot = await new Repository(repo).read();
    assert.equal(snapshot.stackMembership.get("lower")?.size, 1);
  }
);
