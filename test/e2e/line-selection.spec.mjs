/**
 * Choosing some lines of an uncommitted file, and what the choice becomes.
 *
 * Each rewrite asserts the git state as well as the screen, as `operations.spec.mjs` does: the
 * overlay can show the right boxes ticked while the host writes the wrong lines, and only the
 * blobs tell the two apart.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";
import { expectLogEntry, expectToast } from "./fixtures/interactions.mjs";

/**
 * Replaces the one committed line and adds two, so the diff has a removal and three additions:
 * `-1`, `+1`, `+2`, `+3`.
 */
const TRIM_AFTER = [
  "export const collapseWhitespace = (s) => s.trim();",
  "export const kept = 1;",
  "export const leftOut = 2;",
  "",
].join("\n");

/**
 * The box beside the changed line whose text contains `text`.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} text
 */
const lineBoxOf = (page, text) =>
  page.locator("#changes .dfline", { hasText: text }).locator(".pickline");

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} path
 */
const rowOf = (page, path) => page.locator("#wc .file", { hasText: path });

/**
 * Whether a checkbox shows "some", which only the DOM property records.
 *
 * @param {import("@playwright/test").Locator} box
 */
const isIndeterminate = box =>
  box.evaluate(
    element => /** @type {HTMLInputElement} */ (element).indeterminate
  );

/** @param {import("@playwright/test").Page} page */
async function openTrimLines(page) {
  await rowOf(page, "src/trim.js").locator(".chooselines").click();
  await expect(page.locator("#changes-title")).toContainText(
    "src/trim.js — uncommitted"
  );
  await expect(page.locator("#changes .pickline")).toHaveCount(4);
}

test("leaving one line out commits the rest and keeps it in the working copy", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(join(demoRepository.path, "src", "trim.js"), TRIM_AFTER);
  await reopen(smartlog);

  await openTrimLines(smartlog);
  await lineBoxOf(smartlog, "leftOut").click();
  await expect(smartlog.locator("#changes-count")).toHaveText(
    "1 of 1 file, 3 of 4 lines chosen"
  );
  await expect(smartlog.locator("#changes .dfline.excluded")).toHaveCount(1);
  expect(await isIndeterminate(smartlog.locator("#changes .pickfile"))).toBe(
    true
  );
  await snapshot("changes-lines-chosen", {
    locator: smartlog.locator("#changes"),
  });

  // The form sits under the list the overlay covers, so Commit… hands over to it.
  await smartlog.locator("#btn-changes-commit").click();
  await expect(smartlog.locator("#changes.open")).toBeHidden();
  await expect(smartlog.locator("#commit-form")).toBeVisible();
  // The choice outlives the overlay: the row says how much of the file goes in.
  await expect(rowOf(smartlog, "src/trim.js").locator(".linecount")).toHaveText(
    "3 of 4 lines"
  );
  await expect(smartlog.locator("#wc-selcount")).toHaveText(
    "1 of 1 selected, 1 in part"
  );
  await snapshot("working-copy-partly-chosen", {
    locator: smartlog.locator("#wc"),
  });

  await smartlog.locator("#commit-subject").fill("feat(trim): simplify");
  await smartlog.locator("#btn-commit-do").click();
  await expectToast(smartlog, "Committed 1 change");

  expect(await demoRepository.git(["show", "HEAD:src/trim.js"])).toBe(
    "export const collapseWhitespace = (s) => s.trim();\nexport const kept = 1;"
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe(
    " M src/trim.js"
  );
  expect(
    await demoRepository.git(["diff", "--unified=0", "--no-color", "HEAD"])
  ).toContain("\n+export const leftOut = 2;");
  // The committed lines are gone from the working copy, so their choice is too.
  await expect(
    rowOf(smartlog, "src/trim.js").locator(".linecount")
  ).toHaveCount(0);
});

test("shift-click sets a range, and a hunk's box takes every line back", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(join(demoRepository.path, "src", "trim.js"), TRIM_AFTER);
  await reopen(smartlog);
  await openTrimLines(smartlog);

  await lineBoxOf(smartlog, "s.trim();").click();
  await lineBoxOf(smartlog, "leftOut").click({ modifiers: ["Shift"] });
  await expect(smartlog.locator("#changes .dfline.excluded")).toHaveCount(3);
  await expect(smartlog.locator("#changes-count")).toHaveText(
    "1 of 1 file, 1 of 4 lines chosen"
  );
  // The removal is the one line the range skipped, so it is the one still chosen.
  await expect(lineBoxOf(smartlog, "replace(")).toBeChecked();
  expect(await isIndeterminate(smartlog.locator("#changes .pickhunk"))).toBe(
    true
  );

  await smartlog.locator("#changes .pickhunk").click();
  await expect(smartlog.locator("#changes .dfline.excluded")).toHaveCount(0);
  await expect(smartlog.locator("#changes .pickfile")).toBeChecked();
  await expect(
    rowOf(smartlog, "src/trim.js").locator(".linecount")
  ).toHaveCount(0);

  // Leaving every line out is unticking the file, which the sidebar's box shows.
  await smartlog.locator("#changes .pickhunk").click();
  await expect(smartlog.locator("#changes-count")).toHaveText(
    "0 of 1 file, 0 of 4 lines chosen"
  );
  await expect(smartlog.locator("#btn-changes-commit")).toBeDisabled();
  await expect(
    rowOf(smartlog, "src/trim.js").locator(".pick")
  ).not.toBeChecked();
});

test("amending chosen lines into a commit below HEAD from the overlay's picker", async ({
  demoRepository,
  smartlog,
}) => {
  // parse-dates sits above parse-utils, so parse-utils is one of the commits HEAD stands on.
  await demoRepository.git(["checkout", "parse-dates"]);
  const stripPath = join(demoRepository.path, "src", "strip.js");
  const committed = await demoRepository.git(["show", "HEAD:src/strip.js"]);
  await writeFile(stripPath, `${committed}\n// stays\n// folded down\n`);
  await reopen(smartlog);

  await rowOf(smartlog, "src/strip.js").locator(".chooselines").click();
  await expect(smartlog.locator("#changes .pickline")).toHaveCount(2);
  await lineBoxOf(smartlog, "// stays").click();

  // HEAD and each commit under it, and nothing from a sibling stack.
  const picker = smartlog.locator("#changes-amend-target");
  await expect(picker.locator("option").first()).toContainText("HEAD");
  const target = picker.locator("option", { hasText: "add parseList" });
  await expect(target).toHaveCount(1);
  await expect(
    picker.locator("option", { hasText: "add parseNumbers" })
  ).toHaveCount(0);
  await picker.selectOption(
    await target.evaluate(
      option => /** @type {HTMLOptionElement} */ (option).value
    )
  );
  await smartlog.locator("#btn-changes-amend").click();
  await expectToast(smartlog, "Amended into");
  await expect(smartlog.locator("#changes.open")).toBeHidden();

  expect(await demoRepository.git(["show", "parse-utils:src/strip.js"])).toBe(
    `${committed}\n// folded down`
  );
  // The descendant carries the folded line, and the line left out is still only on disk.
  expect(await demoRepository.git(["show", "parse-dates:src/strip.js"])).toBe(
    `${committed}\n// folded down`
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe(
    " M src/strip.js"
  );
  expect(
    await demoRepository.git(["diff", "--unified=0", "--no-color", "HEAD"])
  ).toContain("\n+// stays");
});

test("a file changed on disk after its lines were chosen goes back to whole", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  const trimPath = join(demoRepository.path, "src", "trim.js");
  await writeFile(trimPath, TRIM_AFTER);
  await reopen(smartlog);
  await openTrimLines(smartlog);
  await lineBoxOf(smartlog, "leftOut").click();
  await smartlog.locator("#btn-changes-close").click();
  await expect(rowOf(smartlog, "src/trim.js").locator(".linecount")).toHaveText(
    "3 of 4 lines"
  );

  // An edit shifts the numbers the choice names, so keeping it would leave out another line.
  await writeFile(trimPath, `// a new first line\n${TRIM_AFTER}`);
  await smartlog.locator("#btn-refresh").click();
  await expectLogEntry(smartlog, "Refresh local state");
  await expectToast(
    smartlog,
    "src/trim.js changed on disk, so every line of it is chosen again."
  );
  await expect(
    rowOf(smartlog, "src/trim.js").locator(".linecount")
  ).toHaveCount(0);
  await expect(rowOf(smartlog, "src/trim.js").locator(".pick")).toBeChecked();
});
