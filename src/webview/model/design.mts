/**
 * Where the pills sit and how large the text is.
 *
 * The choice outlives the page — `storage.ts` keeps it — because the tree is rebuilt on
 * every refresh, so a per-session choice would snap back to the default within seconds of
 * being made. Sizes are numbers of pixels rather than names, because the useful range
 * differs per display and a three-step scale would always be wrong for someone.
 */

export type PillSide = "left" | "right";
/** What clicking a filename does: open it as it is now, or open its diff. */
export type FileClick = "file" | "diff";

export type Design = {
  pillSide: PillSide;
  textFont: number;
  pillFont: number;
  wrapRows: boolean;
  fileClick: FileClick;
};

export const DESIGN_KEY = "gsm.design";

export const DESIGN_DEFAULTS: Design = {
  pillSide: "left",
  textFont: 13,
  pillFont: 11,
  wrapRows: false,
  fileClick: "file",
};

export const TEXT_FONT_RANGE = { min: 10, max: 20 } as const;
export const PILL_FONT_RANGE = { min: 8, max: 18 } as const;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * Adopt a stored design field by field, clamping the numbers.
 *
 * A value from a future version — or a hand-edited one — must not be able to render the
 * tree unusable, so nothing is taken on trust: an unrecognised string leaves the
 * default in place, and a size outside the slider's range is pulled back into it.
 */
export function parseDesign(stored: unknown): Design {
  const design = { ...DESIGN_DEFAULTS };
  if (typeof stored !== "object" || stored === null) {
    return design;
  }
  const fields = stored as Record<string, unknown>;
  if (fields.pillSide === "left" || fields.pillSide === "right") {
    design.pillSide = fields.pillSide;
  }
  if (typeof fields.wrapRows === "boolean") {
    design.wrapRows = fields.wrapRows;
  }
  if (fields.fileClick === "file" || fields.fileClick === "diff") {
    design.fileClick = fields.fileClick;
  }
  if (Number.isFinite(fields.textFont)) {
    design.textFont = clamp(
      fields.textFont as number,
      TEXT_FONT_RANGE.min,
      TEXT_FONT_RANGE.max
    );
  }
  if (Number.isFinite(fields.pillFont)) {
    design.pillFont = clamp(
      fields.pillFont as number,
      PILL_FONT_RANGE.min,
      PILL_FONT_RANGE.max
    );
  }
  return design;
}

/** Badges track the pill size, one pixel down, the ratio the fixed sizes had. */
export function badgeFontFor(pillFont: number): number {
  return Math.max(7, pillFont - 1);
}
