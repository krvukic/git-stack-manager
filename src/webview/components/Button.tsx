/**
 * A button.
 *
 * The stylesheet used to reach every button in the app through a bare `button { … }` rule,
 * which is why the previous version had four separate places overriding padding and font
 * size back down for the buttons that sit inside rows. Making the base a component means a
 * variant is chosen rather than undone.
 *
 * `secondary` is the default because most buttons here are: the primary colour marks the one
 * action a panel is *for*, and a panel with two primaries has none.
 */
import { classes } from "../classes";

export type ButtonVariant = "primary" | "secondary";
/**
 * `small` is the size for a button inside a row — the working-copy actions, a drawer's Close,
 * the log's Clear — where a full-size button would out-measure the text beside it.
 *
 * There was a third size, `compact`, which differed from `small` only in being 10px wide rather
 * than 8px. Collapsing the app's two spacing steps onto one made the two identical, which is
 * the answer to what the distinction had been for.
 */
export type ButtonSize = "normal" | "small";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-button text-button-fg",
  secondary: "bg-button-2 text-button-2-fg",
};

/**
 * Every size states its line height, and that is the load-bearing part.
 *
 * Tailwind's own named sizes bundle one — `text-xs` is 12px *and* 16px of leading — so a bare
 * `text-xs` here makes every button a pixel shorter and the whole bar shrinks with it. The
 * project's `--text-*` tokens deliberately have no paired line height for that reason, which
 * leaves `/auto` to say "whatever the browser would have done". A modifier is enough; the
 * utility itself is not off-limits.
 */
const SIZES: Record<ButtonSize, string> = {
  normal: "px-2 py-1 text-body/auto",
  small: "px-2 py-0.5 text-meta/auto",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = "secondary",
  size = "normal",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={classes(
        // `whitespace-nowrap` on every button, not only the top bar's: a label that wraps
        // doubles its row's height, which reads as a rendering fault rather than as a narrow
        // window.
        "cursor-pointer rounded-sm font-[inherit] whitespace-nowrap",
        // Brightness rather than a second colour per state, so a variant needs one token and
        // hover stays correct against any editor theme.
        "not-disabled:hover:brightness-115",
        "disabled:cursor-default disabled:opacity-45",
        // The keyboard's equivalent of the hover brightness above, which it cannot use: about
        // twenty buttons — the whole top bar, every panel action — had no focus indicator at
        // all, so tabbing through them showed nothing. `IconButton` and the splitter already
        // draw this ring; matching it is what makes focus mean one thing across the app.
        "focus-visible:outline focus-visible:outline-accent",
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...rest}
    />
  );
}

/**
 * What an icon button's hover says about the action behind it. `quiet` is every opener — a diff,
 * a file, a drawer — and `danger` marks the one that destroys something, so a pointer resting on
 * *discard* turns the deletion colour rather than the neutral one it shares with the openers.
 */
export type IconTone = "quiet" | "danger";

const ICON_TONES: Record<IconTone, string> = {
  quiet: "text-muted hover:bg-button-2 hover:text-fg",
  danger: "text-muted hover:bg-del/18 hover:text-del",
};

/**
 * `large` is for a row whose icons are its only controls, where a reader aims at them rather than
 * sweeping past them. Its own table rather than a class on top, since two height utilities on one
 * element leave the winner to stylesheet order.
 */
export type IconSize = "small" | "large";

const ICON_SIZES: Record<IconSize, string> = {
  small: "h-4.5 w-5 text-meta/none",
  large: "h-5 w-5.5 text-title/none",
};

export type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: IconTone;
  size?: IconSize;
  /**
   * Keep the glyph on screen when the row is not hovered. Off by default: a row carrying three
   * openers would otherwise be three glyphs of noise per file. An action worth finding without
   * hovering for it sets this.
   */
  alwaysVisible?: boolean;
};

/**
 * A square button carrying one glyph, for actions that sit inside a row.
 *
 * Hidden until the row is hovered or this is focused, unless `alwaysVisible` says otherwise.
 * `visibility` rather than `display`, so the row's width does not change when it appears — a path
 * that reflowed under the pointer would be a moving target. Focus is what makes them reachable by
 * keyboard, where there is no hover to rely on.
 */
export function IconButton({
  tone = "quiet",
  size = "small",
  alwaysVisible = false,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      className={classes(
        // `iconbtn` carries no styling — the utilities below do that — but the end-to-end
        // suite selects these by it, and a class the tests name is part of the contract.
        "iconbtn",
        "flex-none cursor-pointer rounded-sm bg-transparent p-0",
        ICON_SIZES[size],
        !alwaysVisible &&
          "invisible group-hover/file:visible focus-visible:visible",
        ICON_TONES[tone],
        "focus-visible:outline focus-visible:outline-accent",
        className
      )}
      {...rest}
    />
  );
}

/**
 * A row of buttons.
 *
 * Wraps, because the widest set — *Amend message / Amend working changes / Rebase onto trunk*,
 * shown for a HEAD commit with a dirty working copy — does not fit the panel's minimum width,
 * and a second line is a better answer there than a horizontal scrollbar.
 *
 * No margin of its own. It had `mt-2`, and three of the eight callers then fought it — two
 * cancelling it through a `[&>.btnrow]:mt-0!` descendant selector on a wrapper, one overriding
 * with `mt-1.5!`. Four `!important` markers existed to undo one default, and each was load-bearing
 * for a reason no reader of the call site could see: the caller's own utility would otherwise lose
 * to this one on emission order. Spacing belongs to whatever is stacking the rows.
 */
export function ButtonRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={classes("btnrow flex flex-wrap gap-2", className)}>
      {children}
    </div>
  );
}
