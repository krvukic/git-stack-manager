/**
 * statusParser — read `git status --porcelain=v2 --branch -z`.
 *
 * Kept separate because it is pure string handling with a format quirk worth
 * isolating: a rename is a "2" record carrying two NUL-separated paths, so a parse
 * that mishandles it silently shifts every following entry. Being pure, it is
 * directly testable without a repository.
 *
 * Format reference: https://git-scm.com/docs/git-status#_porcelain_format_version_2
 */
import { FileChange } from "#git/snapshot";

export type StatusResult = {
  uncommitted: FileChange[];
  headSha: string | null;
  headBranch: string | null;
  hasUnmerged: boolean;
};

/**
 * Parse `status --porcelain=v2 --branch -z`. Beyond the file list this reports
 * HEAD's sha and branch, and unmerged ("u") entries flag a conflicted merge or
 * rebase. Record types: "1" ordinary, "2" rename/copy (path then origPath),
 * "u" unmerged, "?" untracked, "!" ignored.
 */
export function parseStatus(output: string): StatusResult {
  const uncommitted: FileChange[] = [];
  let headSha: string | null = null;
  let headBranch: string | null = null;
  let hasUnmerged = false;

  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const kind = entry[0];

    if (kind === "#") {
      const [, key, value = ""] = entry.split(" ");
      if (key === "branch.oid") {
        headSha = value === "(initial)" ? null : value;
      } else if (key === "branch.head") {
        headBranch = value === "(detached)" ? null : value;
      }
      continue;
    }
    if (kind === "?") {
      uncommitted.push({ status: "?", path: entry.slice(2) });
      continue;
    }
    if (kind === "!") {
      continue;
    }
    if (kind === "u") {
      hasUnmerged = true;
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      uncommitted.push({ status: "U", path: fieldsAfter(entry, 10) });
      continue;
    }
    if (kind === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      uncommitted.push({
        status: primaryStatus(entry.slice(2, 4)),
        path: fieldsAfter(entry, 8),
      });
      continue;
    }
    if (kind === "2") {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      uncommitted.push({
        status: primaryStatus(entry.slice(2, 4)),
        path: fieldsAfter(entry, 9),
        oldPath: entries[++index] ?? "",
      });
    }
  }
  return { uncommitted, headSha, headBranch, hasUnmerged };
}

/** Return everything after the first `count` space-separated fields. */
function fieldsAfter(entry: string, count: number): string {
  let position = 0;
  for (let field = 0; field < count; field++) {
    const nextSpace = entry.indexOf(" ", position);
    if (nextSpace < 0) {
      return "";
    }
    position = nextSpace + 1;
  }
  return entry.slice(position);
}

/** Collapse a two-letter XY status into the single letter the UI colours by. */
function primaryStatus(xy: string): string {
  const staged = xy[0];
  return staged && staged !== "." ? staged : (xy[1] ?? "");
}
