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

/**
 * Drag the resize handle by `deltaX` and answer the width that resulted.
 *
 * Several intermediate moves, not one: a pointer that jumps straight from press to release
 * gives the handler a single `pointermove` to work from, and a browser can coalesce that
 * away entirely. Steps also match what a hand does, so a handler that only happens to work
 * for one big jump fails here.
 *
 * @param {import("@playwright/test").Page} page
 * @param {number} deltaX
 * @param {number} [steps]
 */
export async function dragHandle(page, deltaX, steps = 5) {
  const handle = await boxOf(page, "#splitter");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(x + (deltaX * step) / steps, y);
  }
  await page.mouse.up();
  return sidebarWidth(page);
}
