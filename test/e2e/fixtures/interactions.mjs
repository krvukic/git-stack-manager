/**
 * The waits and gestures more than one spec file needs.
 *
 * Each of these was written two or three times before it moved here: three spellings of
 * "click a commit and wait for its files", two copies of the toast wait, and a resize drag
 * the wrapping tests reach for as well as the resize tests. One copy also means one place
 * for the explanation — `dragHandle` steps the pointer for a reason that a rewrite would
 * otherwise drop.
 */
import { expect } from "@playwright/test";
import { present } from "../../present.mjs";

/**
 * Wait for the toast an action raises when it lands.
 *
 * Toasts are asserted rather than photographed: each one hides itself on a timer, so
 * whether it lands in a frame depends on how long the git work took. The snapshot fixture
 * hides it for that reason, which leaves this as the check that the UI reported the right
 * outcome.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} text
 */
export async function expectToast(page, text) {
  await expect(page.locator("#toast")).toContainText(text, { timeout: 30000 });
}

/**
 * Wait for an action's own response, identified by the entry it adds to the command log.
 *
 * Refresh raises no toast, so there is nothing else to wait on: asserting on the new row
 * alone would pass against whatever the page already showed. The log entry appears only
 * when the action's own response lands.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} title
 */
export async function expectLogEntry(page, title) {
  await expect(
    page.locator("#log-body .log-entry .log-title", { hasText: title })
  ).toBeVisible();
}

/**
 * Click the commit with this subject and wait for its panel to finish loading.
 *
 * The file list is what the wait is on rather than the panel itself: the panel renders
 * from the model already in hand and the files arrive in a second response, so waiting for
 * `#sidebar` alone would race every assertion about a file row. It is also what makes the
 * resize handle appear.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} subject
 */
export async function selectCommit(page, subject) {
  await page.getByText(subject).click();
  await page.waitForSelector("#sidebar.open #filelist .file");
}

/**
 * An element's box, asserted present.
 *
 * `boundingBox()` answers null for an element that is not rendered, and every caller here
 * has already waited for the element — so a null means the selector stopped matching,
 * which is worth naming rather than reading `.width` off nothing.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} selector
 */
export const boxOf = async (page, selector) =>
  present(
    await page.locator(selector).boundingBox(),
    `a bounding box for ${selector}`
  );

/** @param {import("@playwright/test").Page} page */
export const sidebarWidth = async page =>
  boxOf(page, "#sidebar").then(box => box.width);

/** @param {import("@playwright/test").Page} page */
export const changesWidth = async page =>
  boxOf(page, "#changes").then(box => Math.round(box.width));

/**
 * An element's own height in whole pixels, which is what a stored measurement holds.
 *
 * `offsetHeight` rather than a bounding box: the box answers fractions on a scaled display, and
 * a test comparing a dragged height against the restored one would fail on the rounding rather
 * than on the behaviour.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} selector
 */
export const heightOf = async (page, selector) =>
  page
    .locator(selector)
    .evaluate(element => /** @type {HTMLElement} */ (element).offsetHeight);

/**
 * Drag the divider between the tree and the commit panel, and answer the width that resulted.
 *
 * Leftward travel widens the panel one pixel per pixel, unlike the centred overlay below.
 *
 * @param {import("@playwright/test").Page} page
 * @param {number} deltaX
 * @param {number} [steps]
 */
export async function dragHandle(page, deltaX, steps = 5) {
  await dragFrom(page, "#splitter", deltaX, steps);
  return sidebarWidth(page);
}

/**
 * Drag one edge of the changes view by `deltaX` and answer the width that resulted.
 *
 * The view is centred, so each edge carries the far one with it and the width changes by twice
 * the travel. Which edge matters as well as how far: the same leftward drag widens from the
 * left edge and narrows from the right, and an edge wired to the wrong sign still produces a
 * plausible-looking overlay.
 *
 * @param {import("@playwright/test").Page} page
 * @param {"left" | "right"} side
 * @param {number} deltaX
 * @param {number} [steps]
 */
export async function dragChangesEdge(page, side, deltaX, steps = 5) {
  await dragFrom(page, `#changes-edge-${side}`, deltaX, steps);
  return changesWidth(page);
}

/**
 * Drag a textarea's own resize grip down by `deltaY`, and answer the height that resulted.
 *
 * The grip is the browser's, in the bottom-right ~18px of the box, so this presses inside that
 * corner rather than on anything the app draws. Nothing the app listens to fires — the height
 * arrives as an inline style the UA writes, which is what `useStoredHeight` observes.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} selector
 * @param {number} deltaY
 * @param {number} [steps]
 */
export async function dragGrip(page, selector, deltaY, steps = 5) {
  const box = await boxOf(page, selector);
  const x = box.x + box.width - 5;
  const y = box.y + box.height - 5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(x, y + (deltaY * step) / steps);
  }
  await page.mouse.up();
  return heightOf(page, selector);
}

/**
 * Press in the middle of `selector` and travel `deltaX` in several moves.
 *
 * Several intermediate moves, not one: a pointer that jumps straight from press to release
 * gives the handler a single `pointermove` to work from, and a browser can coalesce that away
 * entirely. Steps also match what a hand does, so a handler that only happens to work for one
 * big jump fails here.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} selector
 * @param {number} deltaX
 * @param {number} steps
 */
async function dragFrom(page, selector, deltaX, steps) {
  const handle = await boxOf(page, selector);
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(x + (deltaX * step) / steps, y);
  }
  await page.mouse.up();
}
