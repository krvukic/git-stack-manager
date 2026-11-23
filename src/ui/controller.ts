/**
 * Controller — one dispatcher for UI actions, shared by the VS Code extension
 * (webview messages) and the web server (HTTP endpoints).
 *
 * Actions live in a table rather than a switch so each one stays small enough to
 * read on its own, and so adding one cannot accidentally fall through into a
 * neighbour. Host-specific actions ("openFile", "openUrl") are handled by each host
 * before it reaches here.
 */
import { branchTips, Repository } from "#app/repository";
import { errorMessage, shortSha } from "#core/values";
import { RawData } from "#git/snapshot";
import { RebaseDestination } from "#history/rebase";
import {
  ActionPayload,
  optionalString,
  readFlag,
  readLineSelections,
  readStringList,
  requireString,
  toActionPayload,
} from "#ui/actionPayload";
import { buildModel, RenderModel } from "#ui/renderModel";

/**
 * A `log` entry rides alongside every result so the UI's command panel can show
 * exactly what an action executed. `title` labels the action (Goto, Refresh…);
 * `commands` are the terminal-form git invocations, in order. The model rebuild
 * that follows a mutation is deliberately NOT captured — only the mutation's own
 * commands, so the log reads like what a user would type by hand.
 */
export type CommandLog = {
  title: string;
  commands: string[];
};

export type ActionResult =
  | { ok: true; data?: unknown; log?: CommandLog }
  | { ok: false; error: string; log?: CommandLog };

/** One entry in the action table. */
type ActionHandler = (
  controller: Controller,
  payload: ActionPayload
) => Promise<ActionResult>;

export class Controller {
  constructor(readonly repository: Repository) {}

  /**
   * The render model. Pull request badges come from the cache only — fetching is
   * a separate action, so a ~1s `gh` round trip never delays a paint.
   */
  async model(): Promise<RenderModel> {
    return this.buildFrom(await this.repository.read());
  }

  buildFrom(snapshot: RawData): RenderModel {
    return buildModel(
      snapshot,
      this.repository.pullRequests.cached(),
      this.repository.pullRequests.availabilityReason(),
      this.repository.undoHistory.nextLabel(),
      this.repository.pullRequests.refreshState()
    );
  }

  /** Record the git commands `run` executes, tagged with `title`. */
  async logged<T>(
    title: string,
    run: () => Promise<T>
  ): Promise<{ value: T; log: CommandLog }> {
    const { value, commands } = await this.repository.git.withLog(run);
    return { value, log: { title, commands } };
  }

  /**
   * Run a history edit under both the command log and an undo checkpoint, then
   * return the fresh model alongside whatever the edit produced. Every mutating
   * action shares this shape.
   */
  async edit<T>(
    title: string,
    run: () => Promise<T>
  ): Promise<{ value: T; log: CommandLog; model: RenderModel }> {
    const { value, log } = await this.logged(title, () =>
      this.repository.undoable(title, run)
    );
    return { value, log, model: await this.model() };
  }

  async handle(action: string, rawPayload: unknown): Promise<ActionResult> {
    const handler = ACTIONS[action];
    if (!handler) {
      return { ok: false, error: `Unknown action: ${action}` };
    }
    try {
      return await handler(this, toActionPayload(rawPayload));
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

/**
 * The action table. Reads come first, then history edits, then the `gh`
 * delegations — the same order the UI presents them.
 */
const ACTIONS: Record<string, ActionHandler> = {
  /**
   * Polling and the refresh signals also call this; only an explicit *Refresh* sets `log`,
   * so the command panel is not flooded by background reads. The entry's title repeats the
   * button's own label, so a reader can trace an entry back to what they pressed.
   */
  async model(controller, payload) {
    if (!readFlag(payload, "log")) {
      return { ok: true, data: await controller.model() };
    }
    const { value, log } = await controller.logged("Refresh", () =>
      controller.repository.read()
    );
    return { ok: true, data: controller.buildFrom(value), log };
  },

  /**
   * Requested by the UI after first paint, and on demand from the toolbar.
   * `force` bypasses the cache age for a manual refresh.
   *
   * The snapshot is read first so the query can name the branches on screen. Those
   * are the only ones that can carry a badge, and scoping the query to them is what
   * keeps it inside GitHub's time budget.
   */
  async pullRequests(controller, payload) {
    const snapshot = await controller.repository.read();
    await controller.repository.pullRequests.refresh(
      branchTips(snapshot),
      readFlag(payload, "force")
    );
    return { ok: true, data: controller.buildFrom(snapshot) };
  },

  async files(controller, payload) {
    const files = await controller.repository.filesForCommit(
      requireString(payload, "sha")
    );
    return { ok: true, data: files };
  },

  /**
   * Asked for only while the Config drawer's *Lines changed* is on, and only for commits the
   * webview has no count for yet.
   */
  async lineCounts(controller, payload) {
    return {
      ok: true,
      data: await controller.repository.lineCounts(
        readStringList(payload, "shas")
      ),
    };
  },

  /** A dry run, so the placement can be inspected before anything is rewritten. */
  async absorbPlan(controller, payload) {
    const snapshot = await controller.repository.read();
    const plan = await controller.repository.planAbsorb(
      snapshot,
      optionalString(payload, "sha")
    );
    return {
      ok: true,
      data: { affected: plan.affected, outcomes: plan.outcomes },
    };
  },

  /**
   * Every change in a commit, for the changes overlay and the per-file diff. A read, so
   * no log entry and no undo checkpoint.
   */
  async commitDiff(controller, payload) {
    const diff = await controller.repository.diffForCommit(
      requireString(payload, "sha")
    );
    return { ok: true, data: diff };
  },

  /**
   * The same read for changes no commit holds: the working copy against HEAD, staged changes
   * included. `path` narrows it to one row of the working-copy list, since reading every
   * untracked file to show one of them is waste the commit reader never has to consider.
   */
  async workingCopyDiff(controller, payload) {
    const diff = await controller.repository.diffForWorkingCopy(
      optionalString(payload, "path")
    );
    return { ok: true, data: diff };
  },

  /**
   * The current fingerprint of each partly chosen file, which the webview compares with the one
   * its lines were chosen from after every refresh. A read, like the diff it is taken from.
   */
  async workingCopyFingerprints(controller, payload) {
    const fingerprints = await controller.repository.workingCopyFingerprints(
      readStringList(payload, "paths")
    );
    return { ok: true, data: fingerprints };
  },

  /**
   * Both versions of one image, which neither diff can carry. `sha` names the commit; without
   * one the subject is the working copy, where the right-hand side is the file on disk.
   *
   * Separate from the diff readers and asked for per file, because a commit that adds forty
   * icons would otherwise put forty base64 blobs into one reply the overlay needs before it
   * can draw a single line of text. The overlay asks only for the file a reader has scrolled
   * to, so a preview costs its own read and nothing else does.
   */
  async imagePreview(controller, payload) {
    const path = requireString(payload, "path");
    const oldPath = optionalString(payload, "oldPath");
    const sha = optionalString(payload, "sha");
    const preview = sha
      ? await controller.repository.imagePreview(sha, path, oldPath)
      : await controller.repository.workingCopyImagePreview(path, oldPath);
    return { ok: true, data: preview };
  },

  async splitPreview(controller, payload) {
    const preview = await controller.repository.previewSplit(
      requireString(payload, "sha")
    );
    return { ok: true, data: preview };
  },

  /**
   * Fast-forward the checked-out branch. Not wrapped in `edit`: an undo checkpoint
   * restores refs, and reversing a pull would put the branch back behind its remote —
   * which is a `git reset`, not an undo of anything the user did here.
   */
  async pull(controller) {
    const { value, log } = await controller.logged("Pull", () =>
      controller.repository.pull()
    );
    return {
      ok: true,
      data: { ...value, model: await controller.model() },
      log,
    };
  },

  async checkout(controller, payload) {
    const ref = requireString(payload, "ref");
    const { log } = await controller.logged(`Goto ${ref}`, () =>
      controller.repository.checkout(ref, readFlag(payload, "detach"))
    );
    return { ok: true, data: await controller.model(), log };
  },

  /**
   * The trunk row's own Goto, which takes no payload: the row draws one ref, and the branch
   * that reaches it is the reader's answer rather than the click's. Not wrapped in `edit`,
   * for the reason Pull is not — the fast-forward only collects commits that already exist
   * upstream, and reversing it is a `git reset`.
   */
  async gotoTrunk(controller) {
    const { value, log } = await controller.logged("Goto trunk", () =>
      controller.repository.gotoTrunk()
    );
    return {
      ok: true,
      data: { ...value, model: await controller.model() },
      log,
    };
  },

  async amendMessage(controller, payload) {
    const sha = requireString(payload, "sha");
    const message = requireString(payload, "message");
    // Read once and hand the snapshot to the reword, so the rewrite does not walk
    // the history the render already covered.
    const snapshot = await controller.repository.read();
    const { value, log, model } = await controller.edit("Amend message", () =>
      controller.repository.reword(snapshot, sha, message)
    );
    return { ok: true, data: { newSha: value.newSha, model }, log };
  },

  async amendChanges(controller) {
    const { log, model } = await controller.edit("Amend working changes", () =>
      controller.repository.amendChangesIntoHead()
    );
    return { ok: true, data: model, log };
  },

  /**
   * `lines` names what was left out of each partly chosen file; absent, every path goes whole.
   * `branch` starts a branch for the commit, which trunk and a detached HEAD require.
   */
  async commit(controller, payload) {
    const paths = readStringList(payload, "paths");
    const message = requireString(payload, "message");
    const lines = readLineSelections(payload, "lines");
    const branch = optionalString(payload, "branch");
    const { value, log, model } = await controller.edit("Commit", () =>
      controller.repository.commit(paths, message, lines, branch)
    );
    return {
      ok: true,
      data: {
        newSha: value.newSha,
        committed: value.committed,
        branch: value.branch,
        model,
      },
      log,
    };
  },

  /**
   * Fold the selected changes into a commit that already exists. `sha` is optional
   * and defaults to HEAD, so the common case needs no argument; passing one deeper
   * in the stack rewrites its descendants.
   */
  async amendIntoCommit(controller, payload) {
    const paths = readStringList(payload, "paths");
    const target = optionalString(payload, "sha");
    const lines = readLineSelections(payload, "lines");
    const { value, log, model } = await controller.edit(
      "Amend into commit",
      () => controller.repository.amendInto(paths, target, lines)
    );
    return {
      ok: true,
      data: { newSha: value.newSha, committed: value.committed, model },
      log,
    };
  },

  /**
   * Throw working-copy changes away. Not wrapped in `edit`, and not because it is harmless:
   * undo restores refs, a discard moves none, and no checkpoint can bring back content that
   * only ever existed in the working tree. The UI confirms instead.
   */
  async discard(controller, payload) {
    const paths = readStringList(payload, "paths");
    const { value, log } = await controller.logged(discardTitle(paths), () =>
      controller.repository.discard(paths)
    );
    return {
      ok: true,
      data: { ...value, model: await controller.model() },
      log,
    };
  },

  async absorb(controller, payload) {
    const target = optionalString(payload, "sha");
    const { value, log, model } = await controller.edit("Absorb", () =>
      controller.repository.absorb(target)
    );
    return {
      ok: true,
      data: {
        outcomes: value.outcomes,
        appliedHunks: value.appliedHunks,
        skippedHunks: value.skippedHunks,
        model,
      },
      log,
    };
  },

  async fold(controller, payload) {
    const sha = requireString(payload, "sha");
    const { value, log, model } = await controller.edit(
      "Fold into commit below",
      () => controller.repository.fold(sha)
    );
    return { ok: true, data: { ...value, model }, log };
  },

  async split(controller, payload) {
    const sha = requireString(payload, "sha");
    const selected = readStringList(payload, "selected");
    const firstMessage = optionalString(payload, "firstMessage");
    const secondMessage = optionalString(payload, "secondMessage");
    const { value, log, model } = await controller.edit("Split commit", () =>
      controller.repository.split(sha, selected, firstMessage, secondMessage)
    );
    return { ok: true, data: { ...value, model }, log };
  },

  async rebase(controller, payload) {
    const sha = requireString(payload, "sha");
    const destination = parseDestination(payload);
    const title = rebaseTitle(destination);
    const { value, log, model } = await controller.edit(title, () =>
      controller.repository.rebase(sha, destination)
    );
    return { ok: true, data: { ...value, model }, log };
  },

  async deleteBranch(controller, payload) {
    const branch = requireString(payload, "branch");
    const { value, log, model } = await controller.edit(
      `Delete ${branch}`,
      () => controller.repository.deleteBranch(branch)
    );
    return { ok: true, data: { ...value, model }, log };
  },

  async adoptRemoteStack(controller, payload) {
    const branch = requireString(payload, "branch");
    const { value, log, model } = await controller.edit(
      "Take GitHub's version",
      () => controller.repository.adoptRemoteStack(branch)
    );
    return { ok: true, data: { ...value, model }, log };
  },

  /**
   * Continue and abort are not undoable: git owns the in-progress rebase state,
   * and a checkpoint taken mid-rebase would describe a half-applied stack.
   */
  async rebaseContinue(controller) {
    const { value, log } = await controller.logged("Continue rebase", () =>
      controller.repository.continueRebase()
    );
    return {
      ok: true,
      data: { ...value, model: await controller.model() },
      log,
    };
  },

  async rebaseAbort(controller) {
    const { log } = await controller.logged("Abort rebase", () =>
      controller.repository.abortRebase()
    );
    return { ok: true, data: await controller.model(), log };
  },

  async mergetool(controller, payload) {
    const { log } = await controller.logged("Launch merge tool", () =>
      controller.repository.launchMergeTool(optionalString(payload, "path"))
    );
    return { ok: true, data: await controller.model(), log };
  },

  /**
   * Sent by the webview while the setting is on and the model lists a deletable merged branch.
   * Undoable, like any edit that moves refs: the deleted branch comes back at the commit it
   * held.
   */
  async deleteMergedBranches(controller, payload) {
    const branches = readStringList(payload, "branches");
    const { value, log, model } = await controller.edit(
      "Delete merged branches",
      () => controller.repository.deleteMergedBranches(branches)
    );
    return { ok: true, data: { ...value, model }, log };
  },

  async undo(controller) {
    const { value, log } = await controller.logged("Undo", () =>
      controller.repository.undo()
    );
    return {
      ok: true,
      data: { undone: value, model: await controller.model() },
      log,
    };
  },

  /**
   * Push a branch and reconcile its pull request with the commit message.
   *
   * Not undoable, like the `gh stack` actions below: the refs it moves are on the
   * server, and an undo that reversed the local side only would leave the two
   * disagreeing.
   */
  async submit(controller, payload) {
    const branch = requireString(payload, "branch");
    const { value, log } = await controller.logged(`Submit ${branch}`, () =>
      controller.repository.submit(branch, {
        draftByDefault: readFlag(payload, "draftByDefault"),
        besideClosed: readFlag(payload, "besideClosed"),
      })
    );
    // The push changes what the branch's sync badge should say, so the caller gets
    // a model read after it rather than the one from before.
    return {
      ok: true,
      data: { ...value, model: await controller.model() },
      log,
    };
  },

  /**
   * The commit panel's Draft toggle. It touches only the repository's git config, so nothing
   * reaches GitHub until Submit opens the pull request, and no history moves for Undo to
   * restore.
   */
  async setDraft(controller, payload) {
    const branch = requireString(payload, "branch");
    const draft = readFlag(payload, "draft");
    const { log } = await controller.logged(
      `${draft ? "Draft" : "Ready for review"}: ${branch}`,
      () => controller.repository.setBranchDraft(branch, draft)
    );
    return { ok: true, data: await controller.model(), log };
  },

  /**
   * Submit every branch from the bottom of the stack up to `branch`, like `submit` per layer,
   * then link the stack's pull requests on GitHub.
   */
  async submitStack(controller, payload) {
    const branch = requireString(payload, "branch");
    const { value, log } = await controller.logged(
      `Submit stack up to ${branch}`,
      async () => {
        const outcomes = await controller.repository.submitStack(branch, {
          draftByDefault: readFlag(payload, "draftByDefault"),
        });
        return {
          outcomes,
          link: await controller.repository.linkSubmittedStack(
            branch,
            outcomes
          ),
        };
      }
    );
    return {
      ok: true,
      data: { ...value, model: await controller.model() },
      log,
    };
  },

  /**
   * The two `gh stack` entries. Neither is undoable: both change GitHub alone, and no local ref
   * moves for Undo to restore.
   */
  async linkStack(controller, payload) {
    const branch = requireString(payload, "branch");
    const { value, log } = await controller.logged(
      `Link stack at ${branch}`,
      () => controller.repository.linkStack(branch)
    );
    return {
      ok: true,
      data: { link: value, model: await controller.model() },
      log,
    };
  },

  async unstack(controller, payload) {
    const branch = requireString(payload, "branch");
    const { value, log } = await controller.logged(`Unstack ${branch}`, () =>
      controller.repository.unstack(branch)
    );
    return {
      ok: true,
      data: { stack: value, model: await controller.model() },
      log,
    };
  },
};

/**
 * Name the discarded path in the command log when there is one, since that is what the reader
 * will want to recognise afterwards; a count carries a bulk discard, which no single path can.
 */
function discardTitle(paths: string[]): string {
  return paths.length === 1
    ? `Discard ${paths[0]}`
    : `Discard ${paths.length} changes`;
}

/**
 * The destinations the menu offers: trunk, the stack base, and a named commit, which is how a
 * rebase onto or from the checked-out commit arrives.
 */
function parseDestination(payload: ActionPayload): RebaseDestination {
  const destination = payload.destination;
  switch (destination) {
    case "trunk":
      return { kind: "trunk" };
    case "base":
      return { kind: "base" };
    case "commit":
      return { kind: "commit", sha: requireString(payload, "destinationSha") };
    default:
      throw new Error(`Unknown rebase destination: ${String(destination)}`);
  }
}

function rebaseTitle(destination: RebaseDestination): string {
  switch (destination.kind) {
    case "trunk":
      return "Rebase onto trunk";
    case "base":
      return "Rebase onto stack base";
    case "commit":
      return `Rebase onto ${shortSha(destination.sha)}`;
  }
}
