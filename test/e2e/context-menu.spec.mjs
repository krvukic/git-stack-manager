/**
 * The commit context menu, and the split panel it opens.
 *
 * The menu used to close only on one of its own entries or on Escape, so it sat through a
 * whole sequence of clicks elsewhere — selecting rows, opening diffs — while going on
 * naming the commit it was opened over. Every other menu on the platform closes when you
 * click past it, so the dismissal tests pin each way out.
 *
 * The split panel is here because the menu is the only way in. These cover the choosing;
 * applying a split, and the two commits it leaves behind, is in `operations.spec.mjs`.
 */
import { expect, test } from "./fixtures/demoRepo.mjs";
import { selectCommit } from "./fixtures/interactions.mjs";

test("right-clicking a stacked commit lists its rebase destinations", async ({
  smartlog,
  snapshot,
}) => {
  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  await expect(smartlog.locator("#menu.open")).toBeVisible();
  // The menu alone. Its head line names the commit the entries act on, which is
  // most of what makes the picture checkable — masking it would leave a list of
  // labels with nothing to tie them to.
  await snapshot("commit-context-menu", { locator: smartlog.locator("#menu") });
});

test("clicking outside dismisses the menu, and the row clicked still responds", async ({
  smartlog,
}) => {
  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  await expect(smartlog.locator("#menu.open")).toBeVisible();

  await smartlog.getByText("feat(case): add camelCase").click();

  await expect(smartlog.locator("#menu.open")).toBeHidden();
  // The dismissal must not swallow the click that caused it: the row it landed on selects
  // as usual, which is what makes closing on `pointerdown` rather than `click` matter.
  await smartlog.waitForSelector("#sidebar.open #filelist .file");
});

test("right-clicking another commit moves the menu instead of dismissing it", async ({
  smartlog,
}) => {
  // A right-click starts with a pointerdown too, so the same handler that closes the menu
  // fires on the gesture that opens the next one. Both writes land in one render, and the
  // new menu is what survives — a menu that vanished on every second right-click would be
  // the obvious way to break this.
  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  await expect(smartlog.locator("#menu")).toContainText(
    "feat(pad): add padStart"
  );

  await smartlog
    .getByText("feat(case): add camelCase")
    .click({ button: "right" });

  await expect(smartlog.locator("#menu.open")).toBeVisible();
  await expect(smartlog.locator("#menu")).toContainText(
    "feat(case): add camelCase"
  );
});

test("Escape closes the menu before the panel underneath it", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, "feat(case): add camelCase");
  await smartlog
    .getByText("feat(case): add camelCase")
    .click({ button: "right" });
  await expect(smartlog.locator("#menu.open")).toBeVisible();

  await smartlog.keyboard.press("Escape");

  await expect(smartlog.locator("#menu.open")).toBeHidden();
  await expect(smartlog.locator("#sidebar.open")).toBeVisible();

  // Only once the menu is gone does Escape reach the selection it was covering.
  await smartlog.keyboard.press("Escape");
  await expect(smartlog.locator("#sidebar.open")).toBeHidden();
});

test("the split panel lists a commit's changes as selectable hunks", async ({
  smartlog,
  snapshot,
}) => {
  // wip-titlecase's tip edits two regions of one file, so it is the fixture's
  // only commit with more than one hunk to choose between.
  await smartlog
    .getByText("wip(case): note small-word handling TODO")
    .click({ button: "right" });
  await smartlog.getByText("Split into two commits…").click();
  await smartlog.waitForSelector("#split-panel .hunk");
  await smartlog
    .locator("#split-panel .hunk")
    .first()
    .locator(".hunk-head")
    .click();
  await snapshot("split-panel-one-hunk-chosen", {
    locator: smartlog.locator("#split-panel"),
  });
});

test("selecting every hunk blocks the split, since the second commit would be empty", async ({
  smartlog,
  snapshot,
}) => {
  await smartlog
    .getByText("wip(case): note small-word handling TODO")
    .click({ button: "right" });
  await smartlog.getByText("Split into two commits…").click();
  await smartlog.waitForSelector("#split-panel .hunk");
  for (const hunk of await smartlog
    .locator("#split-panel .hunk .hunk-head")
    .all()) {
    await hunk.click();
  }
  await expect(smartlog.locator("#split-apply")).toBeDisabled();
  await snapshot("split-panel-all-hunks-chosen", {
    locator: smartlog.locator("#split-panel"),
  });
});
