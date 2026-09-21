/**
 * The top bar and its drawers: descriptions, the version, the shortcut list.
 *
 * These are the controls a reader meets before anything else, and the ones a picture judges
 * least well — a tooltip is a string, a version is four digits, and the shortcut drawer is a
 * list whose contents matter rather than its shape.
 */
import { createRequire } from "node:module";
import { expect, test } from "./fixtures/demoRepo.mjs";
import { selectCommit } from "./fixtures/interactions.mjs";

/** What the extension declares it is, which the top bar has to be showing. */
const { version: MANIFEST_VERSION } = createRequire(import.meta.url)(
  "../../package.json"
);

/**
 * Tooltips.
 *
 * The browser's `title` popup cannot be asserted at all — it is drawn by the chrome, not
 * the page — so the descriptions were unverifiable, and slow and unstyled besides. They
 * are now a real element, which is what makes this test possible.
 */
test("hovering a described control shows its description", async ({
  smartlog,
}) => {
  await smartlog.locator("#btn-pull").hover();
  await expect(smartlog.locator("#tip")).toBeVisible();
  await expect(smartlog.locator("#tip")).toContainText("fast-forward");

  // Moving away hides it, rather than leaving it stranded over the next thing.
  await smartlog.locator("#repo-name").hover();
  await expect(smartlog.locator("#tip")).toBeHidden();

  // The row icons are described too, and they are the controls with no visible label at
  // all — so a missing tooltip there would leave a glyph with nothing to explain it.
  await selectCommit(smartlog, "wip(case): note small-word handling TODO");
  const row = smartlog.locator("#filelist .file").first();
  await row.hover();
  await row.locator(".iconbtn.file").hover();
  await expect(smartlog.locator("#tip")).toContainText("Open the current file");
});

test("every top bar control describes itself", async ({ smartlog }) => {
  // A button whose only label is an icon, or whose label is a verb with no object, needs
  // the description more than the others — so this asserts none is left without one, in
  // either the live attribute or the copy the tooltip layer moves it to.
  const undescribed = await smartlog.evaluate(() =>
    Array.from(
      /** @type {NodeListOf<HTMLButtonElement>} */ (
        document.querySelectorAll("#topbar button")
      )
    )
      .filter(button => {
        const text = button.dataset.tip || button.title || "";
        return text.trim().length < 25;
      })
      .map(button => button.id || button.textContent)
  );
  expect(undescribed).toEqual([]);
});

/**
 * The version the top bar prints.
 *
 * Photographed as well, but a picture cannot say whether the digits are the real ones. The
 * number travels from the manifest to a body data attribute to the bar, and a host that
 * stopped substituting the token would print `v__VERSION__` — on screen, and in every
 * recorded picture, and still nobody would fail a build over it. Comparing against the
 * manifest is what makes that a failure.
 */
test("the top bar prints the version from the manifest", async ({
  smartlog,
}) => {
  await expect(smartlog.locator("#version")).toHaveText(`v${MANIFEST_VERSION}`);
});

test("the shortcuts drawer lists the keys, and ? opens it", async ({
  smartlog,
  snapshot,
}) => {
  await smartlog.keyboard.press("?");
  await expect(smartlog.locator("#keys.open")).toBeVisible();
  // Every key the handler answers appears, which is the drawer's whole purpose. Matched by
  // exact text rather than a built regex: `\?` needs escaping and `\k` is not a valid
  // escape, so constructing the pattern per key is a trap.
  const caps = await smartlog.locator("#keys kbd").allTextContents();
  for (const key of ["k", "j", "Enter", "Escape", "a", "u", "r", "l", "?"]) {
    expect(caps).toContain(key);
  }
  await snapshot("shortcuts", { locator: smartlog.locator("#keys") });

  // Drawers share a strip of screen, so opening another closes this one.
  await smartlog.locator("#btn-legend").click();
  await expect(smartlog.locator("#keys.open")).toBeHidden();
  await expect(smartlog.locator("#legend.open")).toBeVisible();
});
