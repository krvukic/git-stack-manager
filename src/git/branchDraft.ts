/**
 * branchDraft — a branch's stored choice for the pull request Submit opens: a draft, or ready
 * for review.
 *
 * The repository's git config stores the choice, as `branch.<name>.gsm-draft`. Both hosts
 * then read the same value, `git branch -m` moves the section to the new name, and
 * `git branch -D` removes it with the branch.
 *
 * The read shares one process with `user.email`, which every repository read already asks for,
 * so knowing each branch's choice adds no git command to a refresh.
 */
import { GitRunner } from "#git/runner";

const DRAFT_KEY = /^branch\.(.+)\.gsm-draft$/;

export type RepositoryConfig = {
  /** `user.email` as git resolves it, or "" when it is unset. */
  userEmail: string;
  /** Each branch's stored choice. A branch absent here has none. */
  branchDrafts: Map<string, boolean>;
};

/**
 * Read `git config -z --get-regexp` output, where each entry is `key\nvalue\0`.
 *
 * Git lists a key once per scope that sets it, in rising precedence, so a later entry replaces
 * an earlier one, as `git config <key>` itself answers.
 */
export function parseConfigEntries(output: string): RepositoryConfig {
  const config: RepositoryConfig = { userEmail: "", branchDrafts: new Map() };
  for (const entry of output.split("\0")) {
    const separator = entry.indexOf("\n");
    if (separator === -1) {
      continue;
    }
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (key === "user.email") {
      config.userEmail = value;
      continue;
    }
    const branch = DRAFT_KEY.exec(key)?.[1];
    if (branch !== undefined) {
      config.branchDrafts.set(branch, value === "true");
    }
  }
  return config;
}

/** Read `user.email` and every branch's draft choice in one git process. */
export async function readRepositoryConfig(
  git: GitRunner
): Promise<RepositoryConfig> {
  // Exits non-zero when nothing matches, which is the common case of no email and no choice.
  const output = await git.tryRun([
    "config",
    "-z",
    "--get-regexp",
    "^(user\\.email|branch\\..*\\.gsm-draft)$",
  ]);
  return parseConfigEntries(output ?? "");
}

/** Store `branch`'s choice, replacing any earlier one. */
export async function writeBranchDraft(
  git: GitRunner,
  branch: string,
  draft: boolean
): Promise<void> {
  await git.run(["config", `branch.${branch}.gsm-draft`, String(draft)]);
}
