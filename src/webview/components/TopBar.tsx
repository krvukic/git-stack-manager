/**
 * Actions on the left, in the order a session uses them: catch up, then rewrite, then
 * re-read. The view controls sit apart on the right, because they change what you see
 * rather than what the repository contains.
 *
 * `Refresh PRs` carries its own freshness note, rather than that note floating beside the
 * repository name where it read as a property of the repository. The two are one thing —
 * a button and the outcome of the last time it ran — so they are one group.
 */
import type { RenderModel } from "#ui/renderModel";
import { useEffect, useState } from "react";
import { classes } from "../classes";
import { canUndo } from "../model/actionGuards.mjs";
import { truncate } from "../model/commits.mjs";
import { describeFreshness } from "../model/freshness.mjs";
import { Button } from "./Button";

/** How often the age is recomputed, so it does not freeze and read as fresh. */
const FRESHNESS_TICK = 15_000;

/**
 * A hairline between groups of actions — catch up, rewrite, re-read — so the row reads as
 * three short lists instead of one long undifferentiated strip. Cheaper than spacing alone,
 * which at this density just looks like an accident.
 */
function Separator() {
  return <span className="mx-0.5 h-4.5 w-px flex-none bg-edge" />;
}

function Freshness({ model }: { model: RenderModel }) {
  // The age is rendered text, so it needs a tick of its own; the model does not change
  // between refreshes but "2m ago" has to become "3m ago".
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), FRESHNESS_TICK);
    return () => clearInterval(timer);
  }, []);
  const note = describeFreshness(model.pullRequestRefresh, now);
  return (
    <span
      // Reports the button's outcome, so a failure that leaves stale badges on screen is
      // visible rather than silent. `empty:hidden` keeps it from claiming the group's gap
      // before the first refresh has run.
      className={classes(
        "flex-none text-meta whitespace-nowrap empty:hidden",
        note.failed ? "text-err" : "text-muted"
      )}
      id="pr-freshness"
      title={note.description}
    >
      {note.text}
    </span>
  );
}

export type TopBarProps = {
  model: RenderModel;
  /** The extension's version. Empty when no host stamped one; see `settings.ts`. */
  version: string;
  logHidden: boolean;
  unseenLogEntries: number;
  openDrawer: string | null;
  pullRequestsLoading: boolean;
  /** How far a fetch in progress has gotten; null when idle or too quick to watch. */
  pullRequestProgress: { done: number; total: number } | null;
  pulling: boolean;
  restacking: boolean;
  onPull: () => void;
  onRestack: () => void;
  onUndo: () => void;
  onRefresh: () => void;
  onRefreshPullRequests: () => void;
  onToggleLog: () => void;
  onToggleDrawer: (name: string) => void;
};

export function TopBar({
  model,
  version,
  logHidden,
  unseenLogEntries,
  openDrawer,
  pullRequestsLoading,
  pullRequestProgress,
  pulling,
  restacking,
  onPull,
  onRestack,
  onUndo,
  onRefresh,
  onRefreshPullRequests,
  onToggleLog,
  onToggleDrawer,
}: TopBarProps) {
  const conflicted = Boolean(model.conflict);
  return (
    <div
      id="topbar"
      // The bar scrolls sideways rather than wrapping. A narrow window used to break
      // "Restack all stacks onto trunk" across two lines and double the bar's height, which
      // reads as a rendering fault; scrolling keeps every label on one line.
      className="flex flex-none items-center gap-2 overflow-x-auto overflow-y-hidden border-b border-b-edge px-3.5 py-2"
    >
      {/* Which build you are looking at, first thing on the row — the question a bug report
          starts with. Rendered only when a host stamped a version, so a bare `v` never
          appears. Unmasked in the recorded screenshots, unlike the freshness note beside
          Refresh PRs: this is deterministic per commit, and a release re-recording them is
          the same mechanical churn as editing the demo fixture. */}
      {version ? (
        <span
          className="flex-none font-[monospace] text-meta whitespace-nowrap text-muted"
          id="version"
          title={`Git Stack Manager ${version}`}
        >
          v{version}
        </span>
      ) : null}
      {/* The repository name and trunk ref give up their space first — they are context, not
          controls, and the buttons are what a narrow window must keep reachable. */}
      <span
        className="flex-none font-semibold whitespace-nowrap"
        id="repo-name"
      >
        {model.repoName || "repo"}
      </span>
      <span
        className="flex-none font-[monospace] text-body/auto whitespace-nowrap text-muted"
        id="trunk-name"
      >
        {model.trunkRef ? `trunk: ${model.trunkRef}` : "no trunk detected"}
      </span>
      <Separator />
      <Button
        id="btn-pull"
        // Pulling mid-rebase would move the branch git is replaying onto.
        disabled={conflicted || pulling}
        title="Fetch and fast-forward the branch you are on. Never merges or rebases, so a diverged branch is refused rather than quietly rewritten."
        onClick={onPull}
      >
        {pulling ? "Pulling…" : "Pull"}
      </Button>
      <Button
        id="btn-restack"
        disabled={conflicted || restacking}
        title="Fetch trunk, then rebase every local stack onto its tip. One rebase per stack, carrying all the branches in it."
        onClick={onRestack}
      >
        {restacking ? "Restacking…" : "Restack all stacks onto trunk"}
      </Button>
      <Button
        id="btn-undo"
        // `canUndo` is shared with the `u` shortcut, and explains why a conflict leaves this
        // one alone while Pull and Restack above are dead.
        disabled={!canUndo(model)}
        title={
          model.undoLabel
            ? `Restore the refs that '${model.undoLabel}' moved. Your files are left alone.`
            : "Reverse the last history edit by restoring the refs it moved. Nothing to undo yet."
        }
        onClick={onUndo}
      >
        {model.undoLabel ? `Undo ${truncate(model.undoLabel, 22)}` : "Undo"}
      </Button>
      <Separator />
      <Button
        id="btn-refresh"
        title="Re-read local git state: branches, commits, working copy. A handful of local git commands, so it is cheap and always current. Pull request status is not part of it — that is Refresh PRs."
        onClick={onRefresh}
      >
        Refresh local state
      </Button>
      {/* Refresh PRs and its freshness note are one unit: a button plus the outcome of the
          last time it ran. The gap is tighter than the bar's own, so the pair groups visually
          before the eye reaches the next button. */}
      <span className="inline-flex items-center gap-1.5">
        <Button
          id="btn-prs"
          disabled={pullRequestsLoading}
          title="Re-read pull request status through the gh CLI. One network call, roughly a second, then cached for a minute — this button bypasses that cache. Local git state comes from Refresh local state instead."
          onClick={onRefreshPullRequests}
        >
          {pullRequestsLoading
            ? pullRequestProgress
              ? `Loading PRs… ${pullRequestProgress.done}/${pullRequestProgress.total}`
              : "Loading PRs…"
            : "Refresh PRs"}
        </Button>
        <Freshness model={model} />
      </span>
      {/* Pushes the view controls to the right; everything before it stays left. */}
      <span className="flex-1" />
      <Button
        id="btn-log"
        title={
          logHidden
            ? "Show the command log — the git commands each action ran" +
              (unseenLogEntries
                ? `, ${unseenLogEntries} of them logged while it was hidden`
                : "")
            : "Hide the command log and give the tree its space back"
        }
        onClick={onToggleLog}
      >
        {logHidden
          ? `Show log${unseenLogEntries ? ` (${unseenLogEntries})` : ""}`
          : "Hide log"}
      </Button>
      <Button
        id="btn-legend"
        title="Show or hide the legend: every pill and badge the tree can draw, with a live sample and what it means."
        onClick={() => onToggleDrawer("legend")}
      >
        {openDrawer === "legend" ? "Hide legend" : "Show legend"}
      </Button>
      <Button
        id="btn-keys"
        title="Show or hide the list of keyboard shortcuts this view responds to."
        onClick={() => onToggleDrawer("keys")}
      >
        Shortcuts
      </Button>
      <Button
        id="btn-config"
        title="Choose which side the branch pills sit on, and scale the text and pill sizes. Choices are remembered."
        onClick={() => onToggleDrawer("config")}
      >
        Config
      </Button>
    </div>
  );
}
