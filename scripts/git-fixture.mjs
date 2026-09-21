/**
 * Shared git-fixture primitives. Both the integration test and the demo
 * generator build a bare "origin" plus a work clone from these; keeping the
 * primitives here lets the demo grow a richer topology without touching the
 * test's deterministic assertions.
 */
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The schema of `.git/gh-stack` that `gh stack` v0.1.0 writes. */
const GH_STACK_SCHEMA_VERSION = 1;

/**
 * @typedef {object} CommitIdentity
 * @property {string} GIT_AUTHOR_NAME
 * @property {string} GIT_AUTHOR_EMAIL
 * @property {string} [GIT_COMMITTER_DATE]
 */

/**
 * The two identities a fixture commits under.
 *
 * `ME` is what `gsm.onlyMyCommits` compares against, so the pair has to differ in the
 * email rather than only in the name. Both use `example.com`, which RFC 2606 reserves,
 * so no fixture can address mail to a real person.
 */
export const ME = {
  GIT_AUTHOR_NAME: "Test Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
};
export const OTHER = {
  GIT_AUTHOR_NAME: "Other Dev",
  GIT_AUTHOR_EMAIL: "other@example.com",
};

/**
 * Two images, for the paths no text fixture reaches: a viewer that draws a commit's blobs
 * instead of diffing them, and the note that stands in when it cannot draw them.
 *
 * Base64 constants rather than a generator, because a PNG encoder in a fixture is more code
 * than the two files it produces. 64×48 and solid, so a snapshot shows at a glance which
 * version is on which side, and two different colours so a preview cannot pass by drawing
 * the same blob twice.
 */
export const TEAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAAAU0lEQVR42u3QMQEAAAQAMGmU1U4herBjBRZZPZ+FAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQcM8CAcQZw4GTDHQAAAAASUVORK5CYII=",
  "base64"
);
export const AMBER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAAAU0lEQVR42u3QMQEAAAQAMI1klUsoerBjBRZdOZ+FAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQcM8CGjt5w+3i898AAAAASUVORK5CYII=",
  "base64"
);

// A monotonic clock for commit timestamps. Real branches are authored seconds
// apart, so the smartlog orders siblings by author date; committing a whole
// fixture within one wall-clock second would tie every date and let a later
// reword (which bumps the committer date) reshuffle the tree. Distinct, rising
// timestamps keep sibling order stable and the build reproducible. Fixed epoch
// start, one minute per commit.
let commitClock = 1_700_000_000;
function nextCommitDate() {
  commitClock += 60;
  return `${commitClock} +0000`;
}

/**
 * Run a command with a fixed author/committer identity so history is reproducible.
 *
 * @param {string} cwd
 * @param {string} command
 * @param {string[]} args
 * @param {CommitIdentity} [identity]
 * @returns {string}
 */
export function run(cwd, command, args, identity = ME) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...identity,
      GIT_COMMITTER_NAME: identity.GIT_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: identity.GIT_AUTHOR_EMAIL,
    },
  }).trim();
}

/**
 * Write a file (creating parent dirs) and commit it as `identity`.
 *
 * Both dates come from the rising clock rather than the wall clock, including the
 * committer's. `git commit` stamps that one itself, which would give the same fixture a
 * different sha on every run.
 *
 * @param {string} repo
 * @param {string} name
 * @param {string | Uint8Array} content Bytes, for the image fixtures — a PNG is not text.
 * @param {string} message
 * @param {CommitIdentity} identity
 * @param {string[]} extraArgs
 */
function writeAndCommit(repo, name, content, message, identity, extraArgs) {
  const fullPath = join(repo, name);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  run(repo, "git", ["add", "-A"], identity);
  const date = nextCommitDate();
  run(repo, "git", ["commit", ...extraArgs, "-m", message, `--date=${date}`], {
    ...identity,
    GIT_COMMITTER_DATE: date,
  });
}

/**
 * @param {string} repo
 * @param {string} name
 * @param {string | Uint8Array} content
 * @param {string} message
 * @param {CommitIdentity} [identity]
 */
export function commitFile(repo, name, content, message, identity = ME) {
  writeAndCommit(repo, name, content, message, identity, []);
}

/**
 * Rewrite the tip commit in place. Its fresh date is the next one on the same clock, so the
 * amended commit still sorts after the commits made before it and sibling order stays put.
 *
 * @param {string} repo
 * @param {string} name
 * @param {string} content
 * @param {string} message
 * @param {CommitIdentity} [identity]
 */
export function amendFile(repo, name, content, message, identity = ME) {
  writeAndCommit(repo, name, content, message, identity, ["--amend"]);
}

/**
 * Write the `.git/gh-stack` state file describing `stacks`, where each stack is
 * `{ trunk, branches }` and every branch names the layer it sits on.
 *
 * The file is written rather than produced by `gh stack init`, because a fixture
 * every machine must be able to build cannot depend on a preview `gh` extension
 * being installed. Verified byte-identical to what `gh stack init` v0.1.0 writes
 * for the demo's own topology, apart from the `repository` field.
 *
 * A layer still sitting on the tip below it therefore records that tip, while a
 * bottom layer whose trunk has since moved on records the older fork point — which
 * is the drift `indexStackMembership` reports as "needs rebase".
 *
 * @param {string} repo
 * @param {{ trunk: string, branches: string[] }[]} stacks
 */
export function writeGhStackState(repo, stacks) {
  const state = {
    schemaVersion: GH_STACK_SCHEMA_VERSION,
    // `gh stack init` leaves this empty for a non-GitHub remote, which a local
    // bare origin is. Nothing reads it.
    repository: "",
    stacks: stacks.map(({ trunk, branches }) => ({
      trunk: { branch: trunk, head: run(repo, "git", ["rev-parse", trunk]) },
      branches: branches.map((branch, index) => ({
        branch,
        // The fork point, which is what `gh stack init` records: for an intact
        // layer it equals the tip of the layer below, and for a bottom layer
        // whose trunk has moved on it stays at the older commit — the drift the
        // "needs rebase" badge reports.
        base: run(repo, "git", [
          "merge-base",
          index === 0 ? trunk : branches[index - 1],
          branch,
        ]),
      })),
    })),
  };
  writeFileSync(
    join(repo, ".git", "gh-stack"),
    `${JSON.stringify(state, null, 2)}\n`
  );
}

/**
 * Initialize a bare "origin.git" and a work clone under `root`, wiring the
 * remote and the committer identity. Returns their absolute paths.
 *
 * @param {string} root
 * @param {{ workName?: string, identity?: CommitIdentity }} [options]
 */
export function initRepoWithOrigin(
  root,
  { workName = "work", identity = ME } = {}
) {
  const origin = join(root, "origin.git");
  const repo = join(root, workName);
  run(root, "git", ["init", "--bare", "-b", "main", "origin.git"]);
  run(root, "git", ["init", "-b", "main", workName]);
  run(repo, "git", ["config", "user.name", identity.GIT_AUTHOR_NAME]);
  run(repo, "git", ["config", "user.email", identity.GIT_AUTHOR_EMAIL]);
  run(repo, "git", ["remote", "add", "origin", origin]);
  return { origin, repo };
}
