/**
 * ghRunner — the one place the `gh` CLI is spawned.
 *
 * Three kinds of caller share the spawn and want different things from it. Submitting writes
 * to GitHub and must surface its own failure; `gh stack` commands rewrite branches and run
 * for as long as they need; the pull request read in `#github/pullRequests` runs on a timer
 * behind a cache, so it needs a short leash and reports unavailability instead of shouting.
 * They differ only in the timeout and in how a failure is worded, so `spawnGh` owns the
 * process and `classifyGhFailure` owns the detection — one copy of the ENOENT check and the
 * stderr patterns, rather than the three that had already started to drift.
 *
 * Wording stays with the caller on purpose: "pull request status is unavailable" and "this
 * action cannot reach GitHub" answer different questions, and a shared sentence would have to
 * be vague enough to fit both.
 */
import { execFile } from "child_process";
import { errorMessage } from "#core/values";
import { GitRunner } from "#git/runner";

/** Long enough for a push plus a round trip, short enough to not hang the UI. */
const WRITE_TIMEOUT_MILLISECONDS = 180_000;

/** A failed `gh` invocation, keeping what the caller needs to tell failures apart. */
export class GhError extends Error {
  constructor(
    message: string,
    /** `ENOENT` when `gh` is not installed, otherwise the exit status. */
    readonly code: string | number | undefined,
    /** What `gh` printed, trimmed. Empty when it was killed before printing. */
    readonly stderr: string
  ) {
    super(message);
  }
}

/** As much as a `gh` failure can be told apart, for a caller to word its own message. */
export type GhFailureKind =
  "missing" | "unauthenticated" | "no-github-remote" | "unreachable" | "other";

/**
 * Spawn `gh` in `cwd` and resolve its stdout.
 *
 * `input` goes to stdin, which is closed either way: `gh` prompts on a terminal that a
 * spawned process does not have, so an open stdin turns a missing argument into a hang.
 */
export function spawnGh(
  args: string[],
  options: { cwd: string; timeoutMilliseconds: number; input?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      {
        cwd: options.cwd,
        // A `pr list --json` covering a whole stack answers in megabytes, and the default
        // 1 MB cap would turn that into a truncation error rather than data.
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeoutMilliseconds,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout));
          return;
        }
        const printed = String(stderr).trim();
        reject(
          new GhError(printed || errorMessage(error), error.code, printed)
        );
      }
    );
    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
  });
}

/**
 * Sort a `gh` failure into the cases worth handling separately.
 *
 * Every case here is normal rather than broken: this extension works on a plain git repo, so
 * a missing CLI, a repository with no GitHub remote, and an unfinished auth all deserve a
 * sentence saying what to do rather than a stack trace.
 */
export function classifyGhFailure(error: unknown): GhFailureKind {
  const failure = error instanceof GhError ? error : null;
  if (failure?.code === "ENOENT") {
    return "missing";
  }
  const printed = failure?.stderr ?? errorMessage(error);
  if (/none of the git remotes.*point to a known GitHub host/i.test(printed)) {
    return "no-github-remote";
  }
  if (/gh auth login|authentication|not logged/i.test(printed)) {
    return "unauthenticated";
  }
  // GitHub answers a query it cannot finish in time with a 504 rather than an error naming a
  // cause, so this covers both the server giving up and the local timeout firing.
  if (/HTTP 50\d|took too long|timed out/i.test(printed)) {
    return "unreachable";
  }
  return "other";
}

/**
 * What `gh` printed, for a caller with nothing more specific to say. Empty when `gh` printed
 * nothing at all, which is what a timeout kill leaves behind — hence a caller that has to
 * word a sentence around it checks for that instead of pasting the empty string in.
 */
export function ghFailureDetail(error: unknown): string {
  return error instanceof GhError ? error.stderr : "";
}

/**
 * Run `gh` for a command that writes to GitHub, recording it in the active command log.
 *
 * The log is what makes a submit legible: it pushed and edited a pull request, and the panel
 * should show both rather than the git half alone. `input` is written to stdin and left out
 * of the log, matching how a reword's piped message stays out — the log shows
 * `gh pr edit … --body-file -` without pasting the whole body into the panel. `cwd` runs
 * `gh` in another checkout while still logging to this one's action.
 */
export async function runGh(
  git: GitRunner,
  args: string[],
  input?: string,
  cwd: string = git.cwd
): Promise<string> {
  const command = `gh ${args.join(" ")}`;
  git.record(cwd === git.cwd ? command : `(cd ${cwd}) ${command}`);
  try {
    return await spawnGh(args, {
      cwd,
      timeoutMilliseconds: WRITE_TIMEOUT_MILLISECONDS,
      ...(input === undefined ? {} : { input }),
    });
  } catch (error: unknown) {
    throw new Error(describeWriteFailure(error, args), { cause: error });
  }
}

function describeWriteFailure(error: unknown, args: string[]): string {
  switch (classifyGhFailure(error)) {
    case "missing":
      return "The gh CLI is not installed, so this action cannot reach GitHub.";
    case "unauthenticated":
      return "The gh CLI is not authenticated. Run `gh auth login` first.";
    default:
      return (
        ghFailureDetail(error) ||
        `gh ${args.join(" ")} failed: ${errorMessage(error)}`
      );
  }
}
