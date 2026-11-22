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
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";
import {
  descriptionOf,
  expectToast,
  REBASE_ONTO_TRUNK,
  selectCommit,
} from "./fixtures/interactions.mjs";

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

test("the stack commands that read HEAD wait for a checkout, and offer it", async ({
  smartlog,
}) => {
  const menu = smartlog.locator("#menu");
  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  // HEAD is on `main`, which both demo stacks name as trunk. `gh stack submit` would refuse with
  // `branch "main" belongs to multiple stacks` after the click, so the entry states that before
  // the click, and the checkout above turns the fix into one gesture.
  await expect(menu).toContainText("Push stack — check out a layer first");
  await expect(menu).toContainText(
    "Submit stack (create/update PRs) — check out a layer first"
  );
  await expect(menu).toContainText(
    "Sync stack with remote (prune merged) — check out a layer first"
  );

  await menu.getByText("Checkout trim-utils (top layer)").click();
  await expectToast(smartlog, "Checked out trim-utils ✓");

  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  // The same three, now runnable, so the checkout is what the three needed, and the dimming
  // clears rather than sticking.
  await expect(menu).toContainText("Push stack");
  await expect(menu).not.toContainText("check out a layer first");
  await expect(menu).not.toContainText("Checkout trim-utils");
});

test("the two rebase families say apart what each one moves", async ({
  smartlog,
}) => {
  const menu = smartlog.locator("#menu");
  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  // Two kinds of rebase entry sit on one stacked commit, and only the tooltips separate them: two
  // move recorded layers, the rest move commits. A reader picks between them on that sentence
  // alone, so it is pinned.
  await expect(
    menu.locator(".item", { hasText: "Rebase stack (all layers)" })
  ).toHaveAttribute("title", /every recorded layer/);
  await expect(
    menu.locator(".item", { hasText: "Rebase this layer and above" })
  ).toHaveAttribute("title", /from this layer up/);
  // The panel's own rebase re-records the bases it moves, so no entry leaves a stack recorded
  // against replaced commits. That is the part worth stating where a reader looks.
  for (const label of [
    "onto current commit",
    "onto latest trunk",
    "onto stack base",
  ]) {
    expect(
      await descriptionOf(menu.locator(".item", { hasText: label }))
    ).toContain("Re-records the bases of any gh stack layer it moves");
  }
});

/**
 * The two rebases that take the checked-out commit as one end.
 *
 * The demo opens on `main`, a trunk commit, so each test checks out the commit it needs first.
 * Every one asserts the parent git ends up with: a toast reads the same whichever commit the
 * rebase landed on.
 */
test("a commit rebases onto the checked-out commit, with its branch", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await reopen(smartlog);

  // escape-html is one commit in a stack of its own, so nothing else moves with it.
  await smartlog.getByText("feat: add escapeHtml").click({ button: "right" });
  await smartlog
    .getByText("Rebase this commit and its descendants onto current commit", {
      exact: true,
    })
    .click();
  await expectToast(smartlog, "Rebased escape-html");

  expect(await demoRepository.git(["rev-parse", "escape-html~1"])).toBe(
    await demoRepository.git(["rev-parse", "trim-utils"])
  );
  // The checked-out branch is the destination, so it stays where it was.
  expect(await demoRepository.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
    "trim-utils"
  );
});

test("the checked-out commit rebases onto the clicked commit, and HEAD follows", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "escape-html"]);
  await reopen(smartlog);

  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  await smartlog
    .getByText("Rebase current commit and its descendants onto this commit", {
      exact: true,
    })
    .click();
  await expectToast(smartlog, "Rebased escape-html");

  expect(await demoRepository.git(["rev-parse", "escape-html~1"])).toBe(
    await demoRepository.git(["rev-parse", "pad-utils"])
  );
  expect(await demoRepository.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
    "escape-html"
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
});

test("a rebase that cannot run is dimmed, with the reason", async ({
  demoRepository,
  smartlog,
}) => {
  const menu = smartlog.locator("#menu");
  // The rebases only: a stacked commit's `gh stack` entries are dimmed for a reason of their own.
  const dimmed = menu.locator(".item.text-muted", { hasText: "Rebase" });

  // On `main`, a trunk commit: it can be a destination, and this checkout cannot move it.
  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  await expect(dimmed).toHaveText([
    "Rebase current commit and its descendants onto this commit — the current commit is on trunk",
  ]);
  await smartlog.keyboard.press("Escape");

  await demoRepository.git(["checkout", "trim-utils"]);
  await reopen(smartlog);

  // The commit directly under the checked-out one. Moving it onto the checked-out commit would
  // put it on top of itself, and the checked-out commit is already on it.
  await smartlog
    .getByText("test(trim): cover collapseWhitespace")
    .click({ button: "right" });
  await expect(dimmed).toHaveText([
    "Rebase this commit and its descendants onto current commit — the current commit is one of its descendants",
    "Rebase current commit and its descendants onto this commit — already on this commit",
  ]);
  await smartlog.keyboard.press("Escape");

  // The checked-out commit has no second commit to pair with, so its menu leaves both out.
  await smartlog
    .getByText("test(pad): cover padStart (local, unpushed)")
    .click({ button: "right" });
  await expect(
    menu.locator(".item", { hasText: "current commit" })
  ).toHaveCount(0);
  await expect(
    menu.getByText(REBASE_ONTO_TRUNK, { exact: true })
  ).toBeVisible();
});

test("a stack's bottom commit cannot rebase onto the base it is already on", async ({
  smartlog,
}) => {
  // escape-html forks straight off a trunk commit, which is its stack base.
  await smartlog.getByText("feat: add escapeHtml").click({ button: "right" });
  await expect(
    smartlog.locator("#menu .item", { hasText: "onto stack base" })
  ).toHaveText(
    "Rebase this commit and its descendants onto stack base — already on the stack base"
  );
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

/**
 * Copy commit hash, and what lands on the clipboard.
 *
 * The full forty characters, where the row prints eight. Asserting the clipboard rather than
 * the toast is the point: a toast naming the short sha would read identically whether the
 * write carried the whole thing, the eight characters on screen, or nothing at all.
 *
 * Playwright withholds clipboard access until it is granted, which the real hosts have by
 * default — a VS Code webview and a page served from localhost are both permitted.
 */
test("Copy commit hash puts the whole sha on the clipboard", async ({
  context,
  demoRepository,
  smartlog,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const sha = await demoRepository.git(["rev-parse", "case-utils"]);

  await smartlog
    .getByText("feat(case): add snakeCase")
    .click({ button: "right" });
  await smartlog.getByText("Copy commit hash").click();

  await expectToast(smartlog, `Copied ${sha.slice(0, 8)} ✓`);
  expect(await smartlog.evaluate(() => navigator.clipboard.readText())).toBe(
    sha
  );
  expect(sha).toHaveLength(40);
});

/**
 * Copy branch name, which is one entry per branch the commit carries.
 *
 * Three cases, one per branch count: no branch offers nothing to copy, one leaves the label
 * bare, and two would be identical without their names.
 */
test("Copy branch name offers one entry per branch, and none without", async ({
  context,
  demoRepository,
  smartlog,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const menu = smartlog.locator("#menu");

  // One branch: the label stays clean and the description names it.
  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  await expect(
    menu.locator(".item", { hasText: /^Copy branch name$/ })
  ).toHaveAttribute("title", "Copy pad-utils to the clipboard");
  await menu.getByText("Copy branch name", { exact: true }).click();
  await expectToast(smartlog, "Copied pad-utils ✓");
  expect(await smartlog.evaluate(() => navigator.clipboard.readText())).toBe(
    "pad-utils"
  );

  // No branch: nothing to copy, so no entry — the way Submit treats the same commit.
  await smartlog
    .getByText("feat(case): add camelCase")
    .click({ button: "right" });
  await expect(menu).toContainText("Copy commit hash");
  await expect(menu).not.toContainText("Copy branch name");

  // Two branches on one commit: each entry carries its own name.
  await demoRepository.git(["branch", "second-name", "pad-utils"]);
  await reopen(smartlog);
  await smartlog
    .getByText("feat(pad): add padStart")
    .click({ button: "right" });
  await expect(
    menu.locator(".item", { hasText: /^Copy branch name / })
  ).toHaveText(["Copy branch name pad-utils", "Copy branch name second-name"]);

  await menu.getByText("Copy branch name second-name").click();
  await expectToast(smartlog, "Copied second-name ✓");
  expect(await smartlog.evaluate(() => navigator.clipboard.readText())).toBe(
    "second-name"
  );
});

/**
 * The two rows where the rest of the menu is not what it usually is.
 *
 * The HEAD row offers no Goto, so Copy opens the first section; a separator there instead
 * would put a hairline straight under the heading. Mid-conflict `commitMenuItems` returns one
 * entry plus a refusal naming the conflict, and reading a sha is as safe then as at any other
 * time — which is when a reader most often needs to quote one.
 */
test("Copy commit hash is offered on the HEAD row and mid-conflict", async ({
  demoRepository,
  smartlog,
}) => {
  const menu = smartlog.locator("#menu");
  // A defect this test steps around, and one that predates this entry: the conflict banner
  // shortens the tree, a right-click that opens the commit panel re-clamps the tree's scroll,
  // and `ContextMenu` closes on that scroll. A viewport tall enough never to scroll keeps it
  // out of assertions that are about something else.
  await smartlog.setViewportSize({ width: 1400, height: 1400 });
  await demoRepository.git(["checkout", "case-utils"]);
  await reopen(smartlog);

  await smartlog
    .getByText("feat(case): add snakeCase")
    .click({ button: "right" });
  await expect(
    menu.locator(".item", { hasText: "Copy commit hash" })
  ).toHaveAttribute("title", /Copy the full sha, [0-9a-f]{40},/);
  // Anchored, because `Delete branch case-utils — you have it checked out — Goto another
  // commit first` carries the word too, and a substring match passes on that.
  await expect(menu.locator(".item", { hasText: /^Goto$/ })).toHaveCount(0);
  await smartlog.keyboard.press("Escape");

  // truncate-words and trunk both rewrite the same line of src/truncate.js.
  await smartlog
    .getByText("feat(truncate): break at word boundaries")
    .click({ button: "right" });
  await smartlog.getByText(REBASE_ONTO_TRUNK, { exact: true }).click();
  await smartlog.waitForSelector("#conflict.open");
  // The toast, not just the banner. The banner appears with the model the rebase returned,
  // and the tree re-laying out under an open menu scrolls it — which this menu closes on, by
  // design. Waiting for the action to have fully landed is what stops that racing the click.
  await expectToast(smartlog, "Rebase stopped on a conflict");
  await smartlog
    .getByText("feat(truncate): break at word boundaries")
    .click({ button: "right" });

  // One retrying assertion for both entries rather than two in sequence: a read taken
  // between them can catch the menu either before React has filled it or after something
  // dismissed it, and both were flaky. Anchored labels and a count of two name the pair.
  await expect(
    menu.locator(".item", {
      hasText: /^(Copy commit hash|Rebase — finish the conflict first)$/,
    })
  ).toHaveCount(2);
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
