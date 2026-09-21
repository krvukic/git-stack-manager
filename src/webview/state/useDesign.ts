/**
 * The design settings, applied to the document.
 *
 * The sizes are custom properties on `:root` so the rules that consume them stay in the
 * stylesheet, rather than every row carrying an inline style the render would have to
 * rewrite. `pillSide` and `wrapRows` are body classes for the same reason: what they
 * change is pure CSS.
 *
 * Setting them from script is allowed under the page's Content Security Policy, which
 * blocks style *attributes* in served markup — not the style property set from a script.
 *
 * Applied in a layout effect rather than an ordinary one, so the properties are in place
 * before the browser paints. An ordinary effect draws the tree at the default size and
 * then resizes it, which flashes on every reload for anyone who changed a size.
 */
import { useCallback, useLayoutEffect, useState } from "react";
import { rowHeightFor } from "../graph/rails.mjs";
import {
  badgeFontFor,
  DESIGN_DEFAULTS,
  type Design,
} from "../model/design.mjs";
import { loadDesign, saveDesign } from "../storage";

export function useDesign() {
  const [design, setDesign] = useState<Design>(loadDesign);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--text-font", `${design.textFont}px`);
    root.style.setProperty("--pill-font", `${design.pillFont}px`);
    root.style.setProperty(
      "--badge-font",
      `${badgeFontFor(design.pillFont)}px`
    );
    // The row has to grow with the text, and the rail SVG is drawn to exactly this
    // height — larger type in a 26px row left the dots above their own subjects and the
    // lines short of the next row. The stylesheet reads the variable; the graph reads
    // `rowHeightFor` directly, so both move together.
    root.style.setProperty(
      "--row-height",
      `${rowHeightFor(design.textFont)}px`
    );
    document.body.classList.toggle("pills-right", design.pillSide === "right");
    document.body.classList.toggle("wrap-rows", design.wrapRows);
  }, [design]);

  const update = useCallback((changes: Partial<Design>) => {
    setDesign(current => {
      const next = { ...current, ...changes };
      saveDesign(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    saveDesign(DESIGN_DEFAULTS);
    setDesign({ ...DESIGN_DEFAULTS });
  }, []);

  return {
    design,
    update,
    reset,
    rowHeight: rowHeightFor(design.textFont),
  };
}
