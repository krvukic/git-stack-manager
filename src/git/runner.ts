/**
 * GitRunner — process spawning and the command log. Pure Node, no vscode
 * imports, so both the VS Code extension and the standalone web server use it.
 */
import { AsyncLocalStorage } from "async_hooks";
import { execFile } from "child_process";
import { lstat, readFile } from "fs/promises";
import { join } from "path";

export const FIELD_SEPARATOR = "\x1f";
export const RECORD_SEPARATOR = "\x1e";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string
  ) {
    super(message);
  }
}

export type GitOptions = {
  /** Bytes for stdin; a Buffer for content that need not be UTF-8, such as a rebuilt blob. */
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  /**
   * Keep the command out of the action log. For probes about git itself rather
   * than the repository: `git version` runs once per session, so it would land in
   * whichever action happened to read first and make that action's log differ
   * between the first refresh and every later one.
   */
  silent?: boolean;
};

export class GitRunner {
  constructor(readonly cwd: string) {}

  /**
   * The buffer collecting commands for the action currently running, so the
   * controller can report exactly what that action executed.
   *
   * Async-local rather than a field or a set of active buffers: the UI polls on a
   * timer while the user acts, so a read and a mutation are routinely in flight
   * together. Recording into every open buffer put the poll's `git log` and
   * `rev-list` calls into the mutation's log, in whatever order the two happened
   * to interleave — a command panel that claimed Restack ran a history walk it
   * never ran. `AsyncLocalStorage` follows the await chain instead, so each
   * command lands only in the log of the action that issued it.
   */
  private readonly activeLog = new AsyncLocalStorage<string[]>();

  /** Run `action`, collecting the git commands it issues. */
  async withLog<T>(
    run: () => Promise<T>
  ): Promise<{ value: T; commands: string[] }> {
    const buffer: string[] = [];
    const value = await this.activeLog.run(buffer, run);
    return { value, commands: buffer };
  }

  /**
   * Add a command to the running action's log.
   *
   * Public because not every command an action runs is a git one: submitting also
   * shells out to `gh`, and the panel should show the whole action rather than only
   * its git half.
   */
  record(command: string): void {
    this.activeLog.getStore()?.push(command);
  }

  run(args: string[], options: GitOptions = {}): Promise<string> {
    // Record the command form only — never `options.input`, so a reword's piped
    // message stays out of the log (the `git commit-tree …` line shows, its
    // stdin does not). Recorded before running so failed commands appear too.
    const command = `git ${args.join(" ")}`;
    if (!options.silent) {
      this.record(command);
    }

    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        {
          cwd: this.cwd,
          maxBuffer: 256 * 1024 * 1024,
          env: { ...process.env, ...options.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new GitError((stderr || error.message).trim(), command));
          } else {
            resolve(stdout.replace(/\n$/, ""));
          }
        }
      );
      if (options.input !== undefined) {
        child.stdin?.write(options.input);
      }
      child.stdin?.end();
    });
  }

  /**
   * Run a command whose output is not text — `cat-file --batch` interleaves
   * headers with raw blob bytes, so decoding as UTF-8 up front would corrupt it.
   */
  runBinary(args: string[], input?: string): Promise<Buffer> {
    const command = `git ${args.join(" ")}`;
    this.record(command);
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        { cwd: this.cwd, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new GitError(String(stderr || error.message).trim(), command)
            );
          } else {
            resolve(stdout);
          }
        }
      );
      if (input !== undefined) {
        child.stdin?.write(input);
      }
      child.stdin?.end();
    });
  }

  async tryRunBinary(args: string[], input?: string): Promise<Buffer | null> {
    try {
      return await this.runBinary(args, input);
    } catch {
      return null;
    }
  }

  /** Read a working-tree file, or null when it is absent. */
  async readWorktreeFile(relativePath: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.cwd, relativePath));
    } catch {
      return null;
    }
  }

  /**
   * The mode `git add` would record for a working-tree path, or null when it is absent.
   *
   * `lstat` rather than `stat`, since a symbolic link is recorded as the link, not as what it
   * points at.
   */
  async worktreeMode(relativePath: string): Promise<string | null> {
    try {
      const stats = await lstat(join(this.cwd, relativePath));
      if (stats.isSymbolicLink()) {
        return "120000";
      }
      return stats.mode & 0o111 ? "100755" : "100644";
    } catch {
      return null;
    }
  }

  /** Run for its exit status only, swallowing output. */
  async succeeds(args: string[]): Promise<boolean> {
    try {
      await this.run(args);
      return true;
    } catch {
      return false;
    }
  }

  /** Run, returning null instead of throwing — for reads whose absence is normal. */
  async tryRun(
    args: string[],
    options: GitOptions = {}
  ): Promise<string | null> {
    try {
      return await this.run(args, options);
    } catch {
      return null;
    }
  }
}
