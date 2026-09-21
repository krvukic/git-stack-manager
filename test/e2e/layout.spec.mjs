/**
 * Geometry: the sidebar's width, the row heights under it, and the design choices that
 * move both.
 *
 * Measured rather than photographed, for two reasons. A resize is a number, and a
 * screenshot of a 480px panel and a 500px one differ by nothing a reviewer would trust
 * themselves to spot. More importantly the sign is the bug worth guarding: the panel sits on
 * the right, so leftward travel must WIDEN it, and an inverted subtract still produces a
 * plausible-looking panel. Every drag here asserts a direction, not just a change.
 *
 * The pictures that remain are of layouts a number cannot describe — every subject on one
 * left edge, or a wrapped row that has grown instead of overprinting its neighbour.
 */
import { present } from "../present.mjs";
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";
import {
  boxOf,
  dragHandle,
  selectCommit,
  sidebarWidth,
} from "./fixtures/interactions.mjs";

/**
 * The bounds under test, declared in `media/app.html`, whose comment records how each was
 * measured.
 *
 * Repeating the numbers here would let the two drift; the tests assert the behaviour at each
 * end instead — pinned, since a clamp is exactly the kind of value that gets loosened by
 * accident.
 */
const SIDEBAR_MIN_WIDTH = 340;
const SIDEBAR_MAX_WIDTH = 640;
const SIDEBAR_DEFAULT_WIDTH = 380;

/** A commit with files, which is what makes the panel and its resize handle appear. */
const COMMIT_WITH_FILES = "feat(case): add camelCase";

test("the resize handle appears with the sidebar and leaves with it", async ({
  smartlog,
}) => {
  await expect(smartlog.locator("#splitter")).toBeHidden();
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  await expect(smartlog.locator("#splitter")).toBeVisible();
  await smartlog.locator("#tree").click();
  await smartlog.keyboard.press("Escape");
  await expect(smartlog.locator("#sidebar.open")).toBeHidden();
  await expect(smartlog.locator("#splitter")).toBeHidden();
});

test("dragging the handle left widens the sidebar and right narrows it", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  const opened = await sidebarWidth(smartlog);
  expect(opened).toBe(SIDEBAR_DEFAULT_WIDTH);

  // Left by 120 must land within a pixel of 120 wider. An inverted sign would give
  // 260 — outside this window in the correct direction, so the assertion catches it
  // rather than merely noticing that something moved.
  const widened = await dragHandle(smartlog, -120);
  expect(widened).toBeGreaterThan(opened);
  expect(Math.abs(widened - (opened + 120))).toBeLessThanOrEqual(1);

  const narrowed = await dragHandle(smartlog, 70);
  expect(narrowed).toBeLessThan(widened);
  expect(Math.abs(narrowed - (widened - 70))).toBeLessThanOrEqual(1);
});

test("dragging far past either bound stops at the clamp", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  // 1400px wide viewport, so the viewport term of the clamp is not the binding one
  // here; a narrow window is covered below.
  expect(await dragHandle(smartlog, -1200, 8)).toBe(SIDEBAR_MAX_WIDTH);
  expect(await dragHandle(smartlog, 1200, 8)).toBe(SIDEBAR_MIN_WIDTH);
});

test("a narrow window clamps the sidebar so the tree keeps room", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  await dragHandle(smartlog, -1200, 8);
  expect(await sidebarWidth(smartlog)).toBe(SIDEBAR_MAX_WIDTH);

  // 800px cannot hold a 640px panel and a readable tree, so the ceiling has to
  // follow the window down — and the tree must keep its own floor. Polled, not read
  // once: the renderer dispatches `resize` after the protocol call returns, so a
  // single read races the handler and passes or fails by timing.
  await smartlog.setViewportSize({ width: 800, height: 1000 });
  await expect
    .poll(() => sidebarWidth(smartlog))
    .toBeLessThan(SIDEBAR_MAX_WIDTH);
  expect((await boxOf(smartlog, "#tree")).width).toBeGreaterThan(300);

  // Widening again restores the choice: the narrow window clamped the applied
  // width without overwriting what was asked for.
  await smartlog.setViewportSize({ width: 1400, height: 1000 });
  await expect.poll(() => sidebarWidth(smartlog)).toBe(SIDEBAR_MAX_WIDTH);
});

test("the sidebar width survives a reload", async ({ smartlog }) => {
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  const dragged = await dragHandle(smartlog, -140);
  expect(dragged).toBeGreaterThan(SIDEBAR_DEFAULT_WIDTH);

  await reopen(smartlog);
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  expect(await sidebarWidth(smartlog)).toBe(dragged);
});

test("selecting another commit keeps the width the drag set", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  const dragged = await dragHandle(smartlog, -100);

  // `select()` rewrites `sidebar.innerHTML`, which replaces the children and leaves
  // the element's own inline width alone. Asserted rather than assumed, because a
  // future rewrite that replaced the element instead would silently reset it.
  await selectCommit(smartlog, "feat(pad): add padStart");
  expect(await sidebarWidth(smartlog)).toBe(dragged);
});

test("arrow keys nudge the width while the handle has focus, and Home restores it", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  await smartlog.locator("#splitter").focus();
  const start = await sidebarWidth(smartlog);

  await smartlog.keyboard.press("ArrowLeft");
  const afterLeft = await sidebarWidth(smartlog);
  expect(afterLeft).toBeGreaterThan(start);

  await smartlog.keyboard.press("ArrowRight");
  expect(await sidebarWidth(smartlog)).toBe(start);

  await smartlog.keyboard.press("ArrowLeft");
  await smartlog.keyboard.press("Home");
  expect(await sidebarWidth(smartlog)).toBe(SIDEBAR_DEFAULT_WIDTH);

  // The same arrows still walk commit rows once focus is elsewhere: the handle's
  // handler stops the event, so it must not be reachable from the tree.
  const beforeNavigation = present(
    await smartlog.locator("#sidebar h3").textContent(),
    "the sidebar heading before navigating"
  );
  await smartlog.locator("#tree").click();
  await smartlog.keyboard.press("ArrowDown");
  await expect(smartlog.locator("#sidebar h3")).not.toHaveText(
    beforeNavigation
  );
  expect(await sidebarWidth(smartlog)).toBe(SIDEBAR_DEFAULT_WIDTH);
});

test("dragging across the tree resizes without selecting commit text", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_FILES);
  const handle = await boxOf(smartlog, "#splitter");
  const y = handle.y + handle.height / 2;
  await smartlog.mouse.move(handle.x + handle.width / 2, y);
  await smartlog.mouse.down();
  // Well past the handle and over the commit rows, which is where a missing
  // `user-select` shows up as highlighted subjects.
  for (const step of [80, 180, 280, 380]) {
    await smartlog.mouse.move(handle.x - step, y);
  }
  // The capture keeps the drag alive off the handle; without it the width would
  // have stopped following the pointer by now.
  expect(await sidebarWidth(smartlog)).toBeGreaterThan(SIDEBAR_DEFAULT_WIDTH);
  await smartlog.mouse.up();

  expect(await smartlog.evaluate(() => String(window.getSelection()))).toBe("");
});

/**
 * Design settings and the legend, driven through the real UI.
 *
 * The unit tests already assert the custom properties and the body class. What only a
 * browser can show is that the choices survive a reload and that the layout they produce is
 * legible — hence a picture of each, and a measurement that the pills-right mode really does
 * put every subject on one left edge, which is the point of it.
 */
test("the legend explains the badges the tree is drawing", async ({
  smartlog,
  snapshot,
}) => {
  await smartlog.locator("#btn-legend").click();
  await expect(smartlog.locator("#legend")).toHaveClass(/open/);
  await snapshot("legend", { locator: smartlog.locator("#legend") });

  // Opening the design panel has to close this one: both drop from the same edge.
  await smartlog.locator("#btn-design").click();
  await expect(smartlog.locator("#legend")).not.toHaveClass(/open/);
  await expect(smartlog.locator("#design")).toHaveClass(/open/);
});

test("pills after the subject line every commit message up on one edge", async ({
  smartlog,
  snapshot,
}) => {
  const subjectLeftEdges = () =>
    smartlog.evaluate(() => [
      ...new Set(
        Array.from(
          document.querySelectorAll(".row.clickable .subject"),
          subject => Math.round(subject.getBoundingClientRect().left)
        )
      ),
    ]);

  // By default each row is indented to hug its own dot, so the subjects start at as
  // many offsets as the graph has lanes. That is the thing this mode removes.
  expect((await subjectLeftEdges()).length).toBeGreaterThan(1);

  await smartlog.locator("#btn-design").click();
  await smartlog.locator('#seg-pillside button[data-side="right"]').click();
  await smartlog.locator("#btn-design-close").click();

  expect(await subjectLeftEdges()).toHaveLength(1);
  await snapshot("pills-after-subject");
});

test("a design choice survives a reload", async ({ smartlog }) => {
  await smartlog.locator("#btn-design").click();
  await smartlog.locator('#seg-pillside button[data-side="right"]').click();
  await smartlog.locator("#rng-text").fill("17");
  await expect(smartlog.locator("body")).toHaveClass(/pills-right/);

  await smartlog.reload();
  await smartlog.waitForSelector(".row");

  // localStorage is the one store both hosts share, and the tree is rebuilt on every
  // refresh — a per-session choice would be gone within seconds of being made.
  await expect(smartlog.locator("body")).toHaveClass(/pills-right/);
  expect(
    await smartlog.evaluate(() =>
      document.documentElement.style.getPropertyValue("--text-font")
    )
  ).toBe("17px");
  // The row grew with the text: the rail SVG is drawn to exactly this height.
  expect(
    await smartlog.evaluate(() =>
      document.documentElement.style.getPropertyValue("--row-height")
    )
  ).toBe("34px");
});

/**
 * Rows that overlap their neighbour, or whose content spills out of their own box.
 *
 * The bug behind this measurement is invisible to a unit test and easy to miss in a
 * screenshot: with the row height pinned, a wrapped second line rendered *outside* its own
 * box and printed straight over the row below, so pills crossed the next subject and both
 * became illegible. Hence a geometric assertion — no row may extend past its own box, and no
 * row may start before the previous one ends.
 *
 * @param {import("@playwright/test").Page} page
 */
async function rowGeometry(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#tree .row"), row => {
      const box = row.getBoundingClientRect();
      // A row always carries a `.content`; an empty rect fails the overlap assertions
      // below rather than the property read, which keeps the failure legible.
      const content = (
        row.querySelector(".content") ?? row
      ).getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
        spills: Math.round(content.bottom) > Math.round(box.bottom) + 1,
      };
    });
    let overlaps = 0;
    for (let index = 1; index < rows.length; index++) {
      if (rows[index].top < rows[index - 1].bottom - 1) {
        overlaps++;
      }
    }
    return { rows, overlaps, spilling: rows.filter(row => row.spills).length };
  });
}

/**
 * Squeeze the tree by dragging the divider as far left as it will go.
 *
 * @param {import("@playwright/test").Page} page
 */
async function starveTree(page) {
  await selectCommit(page, COMMIT_WITH_FILES);
  await dragHandle(page, -400, 12);
  // The clamp keeps the tree at 440px, so this is the narrowest the tree ever gets.
  await page.waitForTimeout(200);
}

test("a starved tree keeps one row per line by default", async ({
  smartlog,
}) => {
  await starveTree(smartlog);

  const { rows, overlaps, spilling } = await rowGeometry(smartlog);
  expect(overlaps).toBe(0);
  expect(spilling).toBe(0);
  // Every row is the same height, which is what makes the column scannable: a subject
  // that will not fit is truncated rather than reflowing the graph.
  expect(new Set(rows.map(row => row.height)).size).toBe(1);

  // Height alone does not prove it: a row can hold a fixed height while its children wrap
  // *inside* it and draw over the row below, which is exactly the bug. So this checks that
  // every laid-out item shares one line.
  //
  // Items are compared against each other rather than against the row's top edge. The row
  // centres them, so each one sits at its own offset from that edge — a smaller box further
  // down — and a fixed tolerance from the top would have to be as large as the tallest item
  // to pass, by which point it no longer detects a second line. Against each other the
  // spread is the leading difference alone, a couple of pixels, while a wrapped row puts a
  // whole row-height between the two lines.
  //
  // `.pillgroup` is skipped because it is `display: contents` in this mode — it has no box
  // of its own, and the union of its children reads as a second line whether or not one
  // exists. Measuring it was the trap here; its children are measured instead. An *empty*
  // group contributes nothing either way, and has to be dropped rather than flattened: a
  // box of zero height at the origin otherwise reads as an item hundreds of pixels above
  // the row, which is a spread no threshold can tell from a real second line.
  const belowFirstLine = await smartlog.evaluate(
    () =>
      Array.from(document.querySelectorAll("#tree .row .content")).filter(
        content => {
          const items = Array.from(content.children)
            .flatMap(child =>
              getComputedStyle(child).display === "contents"
                ? Array.from(child.children)
                : [child]
            )
            .map(item => item.getBoundingClientRect())
            .filter(box => box.height > 0);
          const centres = items.map(box => box.top + box.height / 2);
          return Math.max(...centres) - Math.min(...centres) > 4;
        }
      ).length
  );
  expect(belowFirstLine).toBe(0);

  // And the tree really is too narrow for its content, or none of the above means anything:
  // at least one subject has to be truncated.
  const truncated = await smartlog.evaluate(
    () =>
      Array.from(document.querySelectorAll("#tree .row .subject")).filter(
        subject => subject.scrollWidth > subject.clientWidth + 1
      ).length
  );
  expect(truncated).toBeGreaterThan(0);
});

test("wrapping a starved tree grows the rows instead of overprinting the next one", async ({
  smartlog,
  snapshot,
}) => {
  await starveTree(smartlog);
  await smartlog.locator("#btn-design").click();
  await smartlog.locator('#seg-wraprows button[data-wrap="on"]').click();
  await smartlog.locator("#btn-design-close").click();
  await smartlog.waitForTimeout(200);

  const { rows, overlaps, spilling } = await rowGeometry(smartlog);
  // The whole point: content stays inside its own row, and rows still stack in order.
  expect(spilling).toBe(0);
  expect(overlaps).toBe(0);
  // At least one row took a second line — otherwise this proves nothing about wrapping.
  expect(new Set(rows.map(row => row.height)).size).toBeGreaterThan(1);
  await snapshot("wrapped-rows");
});

test("the wrap choice survives a reload", async ({ smartlog }) => {
  await smartlog.locator("#btn-design").click();
  await smartlog.locator('#seg-wraprows button[data-wrap="on"]').click();
  await expect(smartlog.locator("body")).toHaveClass(/wrap-rows/);

  await smartlog.reload();
  await smartlog.waitForSelector(".row");

  await expect(smartlog.locator("body")).toHaveClass(/wrap-rows/);
});
