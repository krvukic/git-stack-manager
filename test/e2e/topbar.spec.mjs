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
 * No assertion can reach the browser's `title` popup — the browser chrome draws it, not
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

/**
 * The browser's own popup, which no assertion can reach, so the `title` it reads is asserted
 * instead.
 *
 * Dispatched inside the page rather than with `hover()`, because the claim is about one task:
 * the `title` has to be gone by the time the `mouseover` handlers return, which is when the
 * browser reads it. A real hover resolves some milliseconds later, and would pass against a
 * `title` removed at any point before the read.
 */
test("a hovered control gives up its title before the tooltip's delay", async ({
  smartlog,
}) => {
  const state = await smartlog.locator("#btn-pull").evaluate(button => {
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return {
      title: button.getAttribute("title"),
      description: button.dataset.tip ?? "",
      shown: document.querySelector("#tip.open") !== null,
    };
  });

  expect(state.title).toBeNull();
  expect(state.description).toContain("fast-forward");
  // The tooltip still waits out its delay, so the move is what happened early, not the show.
  expect(state.shown).toBe(false);
});

test("pressing the right mouse button hides the tooltip", async ({
  smartlog,
}) => {
  // A top bar button rather than a commit: a commit's right-click opens the menu under the
  // pointer, and the pointer leaving the commit for the menu hides the tooltip by itself.
  await smartlog.locator("#btn-pull").hover();
  await expect(smartlog.locator("#tip")).toBeVisible();

  await smartlog.mouse.down({ button: "right" });

  await expect(smartlog.locator("#tip")).toBeHidden();
  await smartlog.mouse.up({ button: "right" });
});

test("a button pressed during the tooltip's delay cancels the tooltip", async ({
  smartlog,
}) => {
  await smartlog.locator("#btn-pull").evaluate(button => {
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    button.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 2 })
    );
  });

  // Longer than the delay, which is the only way to assert that nothing arrives after it.
  await smartlog.waitForTimeout(600);
  await expect(smartlog.locator("#tip")).toBeHidden();
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
 * The only assertion on the number: every picture prints a placeholder in its place. The
 * number travels from the manifest to a body data attribute to the bar, and a host that
 * stopped substituting the token would print `v__VERSION__`. Comparing against the manifest
 * is what makes that a failure.
 */
test("the top bar prints the version from the manifest", async ({
  smartlog,
}) => {
  await expect(smartlog.locator("#version")).toHaveText(`v${MANIFEST_VERSION}`);
});

test("the help drawer lists the keys, and ? opens it", async ({ smartlog }) => {
  await smartlog.keyboard.press("?");
  await expect(smartlog.locator("#help.open")).toBeVisible();
  // Every key the handler answers appears, which is the drawer's whole purpose. Matched by
  // exact text rather than a built regex: `\?` needs escaping and `\k` is not a valid
  // escape, so constructing the pattern per key is a trap.
  const caps = await smartlog.locator("#keys-body kbd").allTextContents();
  for (const key of ["k", "j", "Enter", "Escape", "a", "u", "r", "l", "?"]) {
    expect(caps).toContain(key);
  }

  // The legend shares the drawer, so the one key answers both questions.
  await expect(smartlog.locator("#legend-body")).toBeVisible();
  // Drawers share a strip of screen, so opening another closes this one.
  await smartlog.locator("#btn-config").click();
  await expect(smartlog.locator("#help.open")).toBeHidden();
  await expect(smartlog.locator("#config.open")).toBeVisible();
});
