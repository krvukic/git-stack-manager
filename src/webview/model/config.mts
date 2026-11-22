/**
 * What the Config drawer sets: where the pills sit, how large the text is, and whether
 * merged branches are deleted.
 *
 * The choice outlives the page — `storage.ts` keeps it — because the tree is rebuilt on
 * every refresh, so a per-session choice would snap back to the default within seconds of
 * being made. Sizes are numbers of pixels rather than names, because the useful range
 * differs per display and a three-step scale would always be wrong for someone.
 */

export type PillSide = "left" | "right";
/** What clicking a filename does: open it as it is now, or open its diff. */
export type FileClick = "file" | "diff";

export type Config = {
  pillSide: PillSide;
  textFont: number;
  pillFont: number;
  /**
   * Characters a branch pill or badge may show before it is clipped, with
   * `PILL_MAX_CHARS_RANGE.max` meaning no limit at all.
   *
   * A count rather than a width, because the limit a reader wants is "about this many
   * letters" whatever the pill slider is set to. `pillMaxWidth` turns it into the CSS value.
   */
  pillMaxChars: number;
  wrapRows: boolean;
  fileClick: FileClick;
  /** Print when each commit was made, beside its hash. `commitDate.mts` owns the wording. */
  showDate: boolean;
  /** Dim a commit whose author email differs from `git config user.email`. */
  dimOtherAuthors: boolean;
  /** Delete a local branch once its pull request merges at the branch's tip. */
  deleteMergedBranches: boolean;
};

/** Named for the drawer's old title, since renaming the key would reset every stored choice. */
export const CONFIG_KEY = "gsm.design";

export const CONFIG_DEFAULTS: Config = {
  pillSide: "left",
  textFont: 13,
  pillFont: 11,
  pillMaxChars: 24,
  wrapRows: false,
  fileClick: "file",
  showDate: false,
  dimOtherAuthors: false,
  deleteMergedBranches: false,
};

export const TEXT_FONT_RANGE = { min: 10, max: 20 } as const;
export const PILL_FONT_RANGE = { min: 8, max: 18 } as const;
/**
 * The cap's range. Twelve characters is about two words, which is the least that distinguishes
 * one branch from another; the ceiling is the off position rather than a wide cap.
 */
export const PILL_MAX_CHARS_RANGE = { min: 12, max: 48 } as const;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * Adopt a stored config field by field, clamping the numbers.
 *
 * A value from a future version — or a hand-edited one — must never render the tree
 * unusable, so `parseConfig` trusts nothing: an unrecognised string leaves the default in
 * place, and `clamp` pulls a size outside the slider's range back into it.
 */
export function parseConfig(stored: unknown): Config {
  const config = { ...CONFIG_DEFAULTS };
  if (typeof stored !== "object" || stored === null) {
    return config;
  }
  const fields = stored as Record<string, unknown>;
  if (fields.pillSide === "left" || fields.pillSide === "right") {
    config.pillSide = fields.pillSide;
  }
  if (typeof fields.wrapRows === "boolean") {
    config.wrapRows = fields.wrapRows;
  }
  if (typeof fields.showDate === "boolean") {
    config.showDate = fields.showDate;
  }
  if (typeof fields.dimOtherAuthors === "boolean") {
    config.dimOtherAuthors = fields.dimOtherAuthors;
  }
  if (typeof fields.deleteMergedBranches === "boolean") {
    config.deleteMergedBranches = fields.deleteMergedBranches;
  }
  if (fields.fileClick === "file" || fields.fileClick === "diff") {
    config.fileClick = fields.fileClick;
  }
  if (Number.isFinite(fields.textFont)) {
    config.textFont = clamp(
      fields.textFont as number,
      TEXT_FONT_RANGE.min,
      TEXT_FONT_RANGE.max
    );
  }
  if (Number.isFinite(fields.pillFont)) {
    config.pillFont = clamp(
      fields.pillFont as number,
      PILL_FONT_RANGE.min,
      PILL_FONT_RANGE.max
    );
  }
  if (Number.isFinite(fields.pillMaxChars)) {
    config.pillMaxChars = clamp(
      fields.pillMaxChars as number,
      PILL_MAX_CHARS_RANGE.min,
      PILL_MAX_CHARS_RANGE.max
    );
  }
  return config;
}

/** Badges track the pill size, one pixel down, the ratio the fixed sizes had. */
export function badgeFontFor(pillFont: number): number {
  return Math.max(7, pillFont - 1);
}

/**
 * The cap as a CSS `max-width`, in characters of whatever font the capsule is in.
 *
 * `ch` rather than pixels because a pill and a badge are set in different fonts at different
 * sizes, and the unit is resolved against the element the property is read on, not the
 * `:root` it is written to — so one value caps each at its own characters.
 */
export function pillMaxWidth(pillMaxChars: number): string {
  return pillMaxChars >= PILL_MAX_CHARS_RANGE.max
    ? "none"
    : `${pillMaxChars}ch`;
}
