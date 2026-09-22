/**
 * Everything the UI reads back at startup: the config settings, and the three measurements a
 * reader can drag — the sidebar's width, the changes overlay's width, and a message box's
 * height.
 *
 * All of them come out of persisted state, so all of them can arrive as a value another
 * version wrote, a hand-edited one, or nothing at all. Every case below is a value a person
 * could plausibly leave behind, because a bad one here does not throw — it renders a tree
 * nobody can use, or a diff in a 40-pixel column.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGES_MIN_WIDTH,
  CHANGES_SIDE_MARGIN,
  clampChangesWidth,
  defaultChangesWidth,
  maxChangesWidth,
} from "../src/webview/model/changesWidth.mts";
import {
  badgeFontFor,
  clamp,
  CONFIG_DEFAULTS,
  parseConfig,
} from "../src/webview/model/config.mts";
import {
  clampMessageHeight,
  COMMIT_BODY_MIN_HEIGHT,
  DESCRIPTION_MIN_HEIGHT,
  MESSAGE_BOX_MARGIN,
} from "../src/webview/model/messageHeight.mts";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  TREE_MIN_WIDTH,
} from "../src/webview/model/sidebarWidth.mts";

test("an absent stored config leaves every default in place", () => {
  assert.deepEqual(parseConfig({}), CONFIG_DEFAULTS);
  assert.deepEqual(parseConfig(null), CONFIG_DEFAULTS);
  assert.deepEqual(parseConfig("nonsense"), CONFIG_DEFAULTS);
});

test("a stored config is adopted field by field", () => {
  const config = parseConfig({
    pillSide: "right",
    wrapRows: true,
    fileClick: "diff",
    textFont: 16,
    pillFont: 14,
    deleteMergedBranches: true,
  });
  assert.deepEqual(config, {
    pillSide: "right",
    wrapRows: true,
    fileClick: "diff",
    textFont: 16,
    pillFont: 14,
    deleteMergedBranches: true,
  });
});

/**
 * The reason the parser reads field by field rather than spreading. A value from a future
 * version — or a hand-edited one — must not be able to render the tree unusable.
 */
test("an unrecognised choice falls back rather than being adopted", () => {
  const config = parseConfig({ pillSide: "middle", fileClick: "terminal" });
  assert.equal(config.pillSide, CONFIG_DEFAULTS.pillSide);
  assert.equal(config.fileClick, CONFIG_DEFAULTS.fileClick);
});

test("only a stored true turns on deleting merged branches", () => {
  // The one setting that deletes something, so a hand-edited "true" string or a 1 left by
  // another tool must not count as consent.
  assert.equal(CONFIG_DEFAULTS.deleteMergedBranches, false);
  assert.equal(
    parseConfig({ deleteMergedBranches: "true" }).deleteMergedBranches,
    false
  );
  assert.equal(
    parseConfig({ deleteMergedBranches: 1 }).deleteMergedBranches,
    false
  );
});

test("a stored size outside the slider's range is pulled back into it", () => {
  assert.equal(parseConfig({ textFont: 400 }).textFont, 20);
  assert.equal(parseConfig({ textFont: 1 }).textFont, 10);
  assert.equal(parseConfig({ pillFont: 0 }).pillFont, 8);
  assert.equal(parseConfig({ pillFont: 99 }).pillFont, 18);
});

test("a size that is not a number is ignored, including NaN", () => {
  assert.equal(
    parseConfig({ textFont: "16" }).textFont,
    CONFIG_DEFAULTS.textFont
  );
  assert.equal(
    parseConfig({ textFont: NaN }).textFont,
    CONFIG_DEFAULTS.textFont
  );
  assert.equal(
    parseConfig({ textFont: Infinity }).textFont,
    CONFIG_DEFAULTS.textFont
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

/**
 * The overlay's default is the geometry it had while its width was fixed: a 12% inset on each
 * side, so 76% of the window. Pinned, because a reader who never drags an edge must see no
 * change at all — and because every full-page snapshot photographs this number.
 */
test("the changes overlay opens at the width its fixed inset gave it", () => {
  assert.equal(defaultChangesWidth(1400), 1064);
  assert.equal(defaultChangesWidth(1000), 760);
});

test("a changes width outside the bounds stops at them", () => {
  assert.equal(clampChangesWidth(80, 1400), CHANGES_MIN_WIDTH);
  assert.equal(clampChangesWidth(9000, 1400), 1400 - 2 * CHANGES_SIDE_MARGIN);
});

/**
 * The margin is the whole reason the overlay is inset rather than full-screen: the tree behind
 * it is what says this is a step in a flow and not a new place.
 */
test("the widest changes view still leaves the tree visible on both sides", () => {
  assert.equal(maxChangesWidth(1400), 1304);
  assert.ok(1400 - maxChangesWidth(1400) >= 2 * CHANGES_SIDE_MARGIN);
});

/**
 * The floor wins over the margin on a narrow window, the same trade the sidebar makes: a diff
 * narrower than its own lines wraps more than it shows, which is worse than covering the tree.
 */
test("a window too narrow for the margin keeps the changes view readable", () => {
  assert.equal(maxChangesWidth(560), CHANGES_MIN_WIDTH);
  assert.equal(clampChangesWidth(540, 560), CHANGES_MIN_WIDTH);
  assert.equal(defaultChangesWidth(400), CHANGES_MIN_WIDTH);
});

test("a message height inside the bounds is kept, whichever box asked", () => {
  assert.equal(clampMessageHeight(300, DESCRIPTION_MIN_HEIGHT, 1000), 300);
  assert.equal(clampMessageHeight(300, COMMIT_BODY_MIN_HEIGHT, 1000), 300);
});

/**
 * Each box has its own floor, matching the `min-height` in its own markup: the commit panel's
 * description starts at 110px, and the working copy's draft body at 64px, since a draft body is
 * often left empty.
 */
test("a message height below a box's own floor stops at that floor", () => {
  assert.equal(
    clampMessageHeight(10, DESCRIPTION_MIN_HEIGHT, 1000),
    DESCRIPTION_MIN_HEIGHT
  );
  assert.equal(
    clampMessageHeight(10, COMMIT_BODY_MIN_HEIGHT, 1000),
    COMMIT_BODY_MIN_HEIGHT
  );
});

/**
 * The ceiling keeps room for the heading above the box and the buttons below it, so a height
 * stored on a tall monitor cannot hide the controls on a short one.
 */
test("a height stored on a taller window is cut to fit this one", () => {
  assert.equal(
    clampMessageHeight(2000, DESCRIPTION_MIN_HEIGHT, 900),
    900 - MESSAGE_BOX_MARGIN
  );
  // And the floor still wins on a window too short to honour even the margin.
  assert.equal(
    clampMessageHeight(2000, DESCRIPTION_MIN_HEIGHT, 150),
    DESCRIPTION_MIN_HEIGHT
  );
});

test("a fractional dragged measurement reaches CSS as whole pixels", () => {
  // A drag reports fractional coordinates on a scaled display, and half a pixel of height
  // would round differently in each browser.
  assert.equal(clampMessageHeight(220.4, DESCRIPTION_MIN_HEIGHT, 1000), 220);
  assert.equal(clampChangesWidth(900.6, 1400), 901);
});
