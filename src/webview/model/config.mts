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
  wrapRows: boolean;
  fileClick: FileClick;
  /** Delete a local branch once its pull request merges at the branch's tip. */
  deleteMergedBranches: boolean;
};

/** Named for the drawer's old title, since renaming the key would reset every stored choice. */
export const CONFIG_KEY = "gsm.design";

export const CONFIG_DEFAULTS: Config = {
  pillSide: "left",
  textFont: 13,
  pillFont: 11,
  wrapRows: false,
  fileClick: "file",
  deleteMergedBranches: false,
};

export const TEXT_FONT_RANGE = { min: 10, max: 20 } as const;
export const PILL_FONT_RANGE = { min: 8, max: 18 } as const;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * Adopt a stored config field by field, clamping the numbers.
 *
 * A value from a future version — or a hand-edited one — must not be able to render the
 * tree unusable, so nothing is taken on trust: an unrecognised string leaves the
 * default in place, and a size outside the slider's range is pulled back into it.
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
  return config;
}

/** Badges track the pill size, one pixel down, the ratio the fixed sizes had. */
export function badgeFontFor(pillFont: number): number {
  return Math.max(7, pillFont - 1);
}
