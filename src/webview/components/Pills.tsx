/**
 * A branch pill and the badges that ride beside it.
 *
 * These are the smallest reusable pieces in the UI, and the legend depends on that: it renders
 * `BranchPills` from synthetic branch details, so a badge whose colour, glyph, or wording
 * changes cannot go on being explained the old way there.
 *
 * The pill and its badges are flat siblings rather than nested in a wrapper. That is what the
 * end-to-end suite reads to pair a branch with its own badge — a branch owns every badge
 * between its pill and the next one — so a row carrying two branches stays unambiguous. A
 * wrapper per branch would be tidier and would break that.
 *
 * Every capsule here shares one shape: a 10px radius, `line-height: 1`, and `flex-none`. The
 * line-height is load-bearing rather than decorative — the row aligns its four font sizes on a
 * shared baseline, and at anything other than 1 a capsule's padding grows around the leading
 * instead of around its own text, which shifts that baseline by a pixel or two per size.
 */
import type { UIBranch } from "#ui/renderModel";
import { classes } from "../classes";
import { pullRequestBadge, stackBadges, syncBadge } from "../model/badges.mjs";

/** The shape every pill and badge shares. `sizeClass` is what varies. */
const CAPSULE = "flex-none rounded-capsule leading-none whitespace-nowrap";

export function Pill({
  label,
  variant = "plain",
}: {
  label: string;
  variant?: "plain" | "trunk";
}) {
  return (
    <span
      className={classes(
        // `pill` and `trunkpill` carry no styling; the end-to-end suite reads the tree
        // through them, so they stay.
        "pill",
        CAPSULE,
        "px-2 py-0.5 font-[monospace] text-(length:--text-pill)",
        variant === "trunk"
          ? "trunkpill bg-button text-button-fg"
          : "bg-pill text-pill-fg"
      )}
    >
      {label}
    </span>
  );
}

/**
 * How a branch compares to its remote, and where it sits in a `gh stack`.
 *
 * Each variant is a wash of its own colour rather than a solid fill: these sit next to a
 * branch pill that is already solid, and two solids side by side read as two pills. The
 * percentages differ per colour because they are matched by eye against the editor's
 * background, not derived — red at 18% reads as loud as green at 22%.
 */
const BADGE_VARIANTS: Record<string, string> = {
  unpushed: "bg-mod/22 text-mod",
  ahead: "bg-accent/22 text-accent",
  diverged: "bg-err/20 text-err",
  // Grey, not red: a branch measured against trunk moves both ways as a matter of course,
  // and painting that like a rewritten push is what sends a reader hunting for lost work.
  trackstrunk: "bg-muted/26 text-muted",
  // Amber, like `unpushed`: something to do — Pull — rather than something wrong.
  trunkbehind: "bg-mod/22 text-mod",
  gone: "bg-err/20 text-err",
  synced: "bg-add/18 text-add",
  stackpos: "bg-accent/16 font-[monospace] text-muted",
  needsrebase: "bg-mod/24 text-mod",
};

export function Badge({
  variant,
  label,
  description,
}: {
  variant: string;
  label: string;
  description: string;
}) {
  return (
    <span
      className={classes(
        "badge",
        CAPSULE,
        "px-1.75 py-0.5 text-badge font-semibold",
        BADGE_VARIANTS[variant]
      )}
      data-badge={variant}
      title={description}
    >
      {label}
    </span>
  );
}

/** Purple for merged, which no editor theme provides — see `--color-merged`. */
const PULL_REQUEST_VARIANTS: Record<string, string> = {
  open: "bg-add/20 text-add",
  draft: "bg-muted/26 text-muted",
  merged: "bg-merged/26 text-merged-fg",
  closed: "bg-err/18 text-err",
};

const CHECK_COLOURS: Record<string, string> = {
  success: "text-add",
  failure: "text-err",
  pending: "text-mod",
};

/**
 * The pull request badge: its number, then the continuous integration glyph, then the review
 * one — so two ticks mean tests green and approved.
 *
 * Clickable through to GitHub. The click is stopped from reaching the row, which would
 * otherwise select the commit as well as opening a browser.
 */
function PullRequestBadge({
  branch,
  onOpenUrl,
}: {
  branch: UIBranch;
  onOpenUrl: (url: string) => void;
}) {
  const badge = pullRequestBadge(branch.pullRequest);
  if (!badge) {
    return null;
  }
  return (
    <span
      className={classes(
        "prbadge",
        CAPSULE,
        "inline-flex cursor-pointer items-center gap-1 px-1.75 py-0.5",
        "font-[monospace] text-badge font-semibold",
        "hover:brightness-125",
        PULL_REQUEST_VARIANTS[badge.variant]
      )}
      data-pr-url={badge.url}
      // The state as data rather than as a class. It used to be read off the class list —
      // "whatever is not `prbadge`" — which only held while that list was hand-written; the
      // styling utilities now sit there too. An attribute says it outright.
      data-pr-state={badge.variant}
      title={badge.description}
      onClick={event => {
        event.stopPropagation();
        if (badge.url) {
          onOpenUrl(badge.url);
        }
      }}
    >
      {/*
        A space before each glyph. The badge is `inline-flex` with its own gap, so this is
        invisible on screen — but it separates the number from the glyphs in `textContent`,
        which is how a reader copying the badge and the end-to-end suite both read it. Without
        it the badge reads `#206✓✓` rather than `#206 ✓ ✓`.
      */}
      {`#${badge.number}`}
      {badge.checks ? (
        <>
          {" "}
          <span
            className={classes("ci", CHECK_COLOURS[badge.checks.state])}
            data-ci-state={badge.checks.state}
          >
            {badge.checks.glyph}
          </span>
        </>
      ) : null}
      {badge.reviewGlyph ? (
        <>
          {" "}
          <span className="review opacity-90">{badge.reviewGlyph}</span>
        </>
      ) : null}
    </span>
  );
}

/** One branch: its pill, its stack position, how it compares to its remote, its PR. */
export function BranchPills({
  branch,
  onOpenUrl,
}: {
  branch: UIBranch;
  onOpenUrl: (url: string) => void;
}) {
  const sync = syncBadge(branch.sync, branch.pullRequest, branch.tracksTrunk);
  return (
    <>
      <Pill label={branch.name} />
      {stackBadges(branch.stack).map(badge => (
        <Badge key={badge.variant} {...badge} />
      ))}
      {sync ? <Badge {...sync} /> : null}
      <PullRequestBadge branch={branch} onOpenUrl={onOpenUrl} />
    </>
  );
}

/** Marks the commit HEAD is on. Solid accent, because it is the one row you are at. */
export function YouAreHere() {
  return (
    <span
      className={classes(
        "youarehere",
        CAPSULE,
        "bg-accent px-2 py-0.5 text-badge font-semibold text-white"
      )}
    >
      You are here
    </span>
  );
}
