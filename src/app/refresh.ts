/**
 * When the panel re-reads the repository, and how often at most.
 *
 * The smartlog draws the working copy, and saving a file changes nothing under `.git` — so
 * the ref watcher that catches a commit, a checkout, or a rebase never fires for an edit.
 * A file changed while the panel sat in another tab therefore stayed off the uncommitted
 * list until some action happened to rebuild the model, which made the panel look like it
 * had missed the edit entirely.
 *
 * Two decisions live here, because both are worth testing without a VS Code window:
 * whether a changed path can affect the working copy at all, and how a burst of signals
 * becomes a bounded number of reads. `hosts/extension.ts` owns the other half — which VS
 * Code events count as signals.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";

/** Run `task` after `delayMs`, returning the function that cancels it. */
export type Scheduler = (task: () => void, delayMs: number) => () => void;

/** Milliseconds since an arbitrary origin; only differences matter. */
export type Clock = () => number;

/**
 * Shortest gap between two reads of the repository.
 *
 * A read spawns several git processes, and the signals arrive in bursts: one `git commit`
 * writes `HEAD`, the index, and a ref, and a formatter run saves forty files. Quarter of a
 * second is below what a reader perceives as a delay, and it collapses each of those bursts
 * into two reads rather than forty.
 */
export const REFRESH_WINDOW_MS = 250;

export const systemScheduler: Scheduler = (task, delayMs) => {
  const timer = setTimeout(task, delayMs);
  return () => clearTimeout(timer);
};

/**
 * Whether a change to `filePath` can alter what the smartlog draws.
 *
 * Paths outside the repository are ignored: a workspace holds settings files and scratch
 * notes elsewhere, and saving one is not repository news. Everything under `.git` is ignored
 * too — the ref watcher covers what matters there, and the rest is churn the panel must not
 * follow. `.git/COMMIT_EDITMSG` is the one that made this necessary: Source Control saves it
 * while a commit message is being typed, which would have re-read the repository per save.
 */
export function affectsWorkingCopy(
  repositoryPath: string,
  filePath: string
): boolean {
  const inside = relative(repositoryPath, filePath);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
    return false;
  }
  // Both separators, because `relative` answers in the host's own and a URI's path arrives
  // with forward slashes even on Windows.
  return inside.split(/[\\/]/)[0] !== ".git";
}

/**
 * The git directories whose writes the panel follows, found without spawning git.
 *
 * In a linked worktree `.git` is a file naming `.git/worktrees/<name>`, so a watcher on
 * `<checkout>/.git/refs/**` matched nothing and a commit made there never refreshed the
 * tree. `gitDirectory` holds this checkout's `HEAD`, index, and `gh stack` state;
 * `commonDirectory` holds the refs and every worktree's `gh stack` state. The two are the
 * same directory in the main checkout.
 */
export function gitDirectoriesOf(repositoryPath: string): {
  gitDirectory: string;
  commonDirectory: string;
} {
  const dotGit = join(repositoryPath, ".git");
  try {
    if (statSync(dotGit).isDirectory()) {
      return { gitDirectory: dotGit, commonDirectory: dotGit };
    }
    const pointer = readFileSync(dotGit, "utf8").match(
      /^gitdir:\s*(.+)$/m
    )?.[1];
    if (!pointer) {
      return { gitDirectory: dotGit, commonDirectory: dotGit };
    }
    const gitDirectory = resolve(repositoryPath, pointer.trim());
    const commonPath = join(gitDirectory, "commondir");
    const commonDirectory = existsSync(commonPath)
      ? resolve(gitDirectory, readFileSync(commonPath, "utf8").trim())
      : gitDirectory;
    return { gitDirectory, commonDirectory };
  } catch {
    // No repository yet; the watcher then waits on the conventional location.
    return { gitDirectory: dotGit, commonDirectory: dotGit };
  }
}

export type CoalescerOptions = {
  windowMs?: number;
  schedule?: Scheduler;
  now?: Clock;
};

/**
 * Turns "something changed" into "re-read, at most this often, and only while on screen".
 *
 * Leading edge first: the first signal of a burst pokes immediately, so an edit shows up
 * without waiting out a window. Signals during the window that follows are answered once,
 * at its end — the trailing read is what makes the panel land on the final state of a burst
 * rather than on the state one process into it.
 *
 * A hidden panel is not read for at all. The reader cannot see a stale tree, and the
 * alternative — re-reading a repository for a tab nobody is looking at — is what makes an
 * editor feel heavy during a rebase. Coming back is itself a signal, so the tree is current
 * by the time it is on screen again.
 */
export class RefreshCoalescer {
  private readonly windowMs: number;
  private readonly schedule: Scheduler;
  private readonly now: Clock;
  private visible = true;
  private active = true;
  private lastPokeAt: number | null = null;
  private cancelPending: (() => void) | null = null;

  constructor(
    private readonly poke: () => void,
    options: CoalescerOptions = {}
  ) {
    this.windowMs = options.windowMs ?? REFRESH_WINDOW_MS;
    this.schedule = options.schedule ?? systemScheduler;
    this.now = options.now ?? Date.now;
  }

  /** Something changed. Pokes now, later, or not at all, per the rules above. */
  signal(): void {
    if (!this.visible || this.cancelPending) {
      return;
    }
    const elapsed =
      this.lastPokeAt === null ? Infinity : this.now() - this.lastPokeAt;
    if (elapsed >= this.windowMs) {
      this.fire();
      return;
    }
    this.cancelPending = this.schedule(() => {
      this.cancelPending = null;
      this.fire();
    }, this.windowMs - elapsed);
  }

  /**
   * Adopt the panel's view state, and treat arriving on screen as a signal.
   *
   * Both flags matter, and for different absences. `visible` catches the reported case —
   * an edit made while the smartlog sat behind another editor tab. `active` catches the one
   * VS Code reports no other way: the panel stays visible while the integrated terminal has
   * focus, so a script that rewrote files there leaves a tree that only looks current, and
   * clicking back into the webview is the moment to fix it.
   *
   * One event carries both flags flipping, which is why `arrived` is computed before either
   * is stored: a visible-and-focused panel must signal once, not twice.
   */
  observe(state: { visible: boolean; active: boolean }): void {
    const arrived =
      (state.visible && !this.visible) || (state.active && !this.active);
    this.visible = state.visible;
    this.active = state.active;
    if (!state.visible) {
      // A scheduled read would land in a hidden panel, and returning signals again anyway.
      this.cancel();
      return;
    }
    if (arrived) {
      this.signal();
    }
  }

  dispose(): void {
    this.cancel();
  }

  private fire(): void {
    this.lastPokeAt = this.now();
    this.poke();
  }

  private cancel(): void {
    this.cancelPending?.();
    this.cancelPending = null;
  }
}
