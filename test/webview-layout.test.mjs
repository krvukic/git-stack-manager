/**
 * The two stored measurements the UI reads back at startup: the design settings and the
 * sidebar width.
 *
 * Both come out of persisted state, so both can arrive as a value another version wrote, a
 * hand-edited one, or nothing at all. Every case below is a value a person could plausibly
 * leave behind, because a bad one here does not throw — it renders a tree nobody can use.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badgeFontFor,
  clamp,
  DESIGN_DEFAULTS,
  parseDesign,
} from "../src/webview/model/design.mts";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  TREE_MIN_WIDTH,
} from "../src/webview/model/sidebarWidth.mts";

test("an absent stored design leaves every default in place", () => {
  assert.deepEqual(parseDesign({}), DESIGN_DEFAULTS);
  assert.deepEqual(parseDesign(null), DESIGN_DEFAULTS);
  assert.deepEqual(parseDesign("nonsense"), DESIGN_DEFAULTS);
});

test("a stored design is adopted field by field", () => {
  const design = parseDesign({
    pillSide: "right",
    wrapRows: true,
    fileClick: "diff",
    textFont: 16,
    pillFont: 14,
  });
  assert.deepEqual(design, {
    pillSide: "right",
    wrapRows: true,
    fileClick: "diff",
    textFont: 16,
    pillFont: 14,
  });
});

/**
 * The reason the parser reads field by field rather than spreading. A value from a future
 * version — or a hand-edited one — must not be able to render the tree unusable.
 */
test("an unrecognised choice falls back rather than being adopted", () => {
  const design = parseDesign({ pillSide: "middle", fileClick: "terminal" });
  assert.equal(design.pillSide, DESIGN_DEFAULTS.pillSide);
  assert.equal(design.fileClick, DESIGN_DEFAULTS.fileClick);
});

test("a stored size outside the slider's range is pulled back into it", () => {
  assert.equal(parseDesign({ textFont: 400 }).textFont, 20);
  assert.equal(parseDesign({ textFont: 1 }).textFont, 10);
  assert.equal(parseDesign({ pillFont: 0 }).pillFont, 8);
  assert.equal(parseDesign({ pillFont: 99 }).pillFont, 18);
});

test("a size that is not a number is ignored, including NaN", () => {
  assert.equal(
    parseDesign({ textFont: "16" }).textFont,
    DESIGN_DEFAULTS.textFont
  );
  assert.equal(
    parseDesign({ textFont: NaN }).textFont,
    DESIGN_DEFAULTS.textFont
  );
  assert.equal(
    parseDesign({ textFont: Infinity }).textFont,
    DESIGN_DEFAULTS.textFont
  );
});

test("a fractional size is rounded, not merely bounded", () => {
  // A font size reaches CSS as whole pixels, so half a pixel of slider travel would
  // otherwise round differently in each browser.
  assert.equal(clamp(13.6, 10, 20), 14);
  assert.equal(clamp(-5, 10, 20), 10);
});

test("badge text tracks the pill size, with a floor of its own", () => {
  assert.equal(badgeFontFor(11), 10, "the ratio the fixed sizes had");
  assert.equal(badgeFontFor(8), 7);
});

test("a sidebar width inside the bounds is kept", () => {
  assert.equal(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, 1400), 380);
});

test("a sidebar width outside the bounds stops at them", () => {
  assert.equal(clampSidebarWidth(10, 1400), SIDEBAR_MIN_WIDTH);
  assert.equal(clampSidebarWidth(5000, 1400), SIDEBAR_MAX_WIDTH);
});

/**
 * The viewport term. Both measured bounds assume a wide window, so a narrow one has to
 * override the ceiling — otherwise restoring a 640px panel into a 900px window leaves the
 * tree with 260px, well under the 440px its own furniture needs.
 */
test("a narrow window lowers the ceiling so the tree keeps its minimum", () => {
  const applied = clampSidebarWidth(SIDEBAR_MAX_WIDTH, 900);
  assert.equal(applied, 900 - TREE_MIN_WIDTH);
  assert.ok(applied < SIDEBAR_MAX_WIDTH);
});

/**
 * The floor wins over the viewport clamp. A window so narrow that even the minimum will
 * not fit has to leave the panel usable rather than collapse it to nothing — the panel
 * holds the message editor, and a zero-width one cannot be typed into.
 */
test("a window too narrow for either bound keeps the panel at its floor", () => {
  assert.equal(clampSidebarWidth(500, 400), SIDEBAR_MIN_WIDTH);
});
