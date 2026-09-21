/**
 * The keys, and the two states where a key must do nothing.
 *
 * `shortcuts.mts` maps keys to actions and `actionGuards.mts` decides whether an action may
 * run; both are unit-tested. What is left is the wiring only a browser has — a real focus
 * target and a real modifier flag — and those two guards are the whole of what stands between
 * writing a commit message and rewriting history. Every letter the table binds appears in
 * ordinary prose, and the newline between two paragraphs is the Goto key.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, reopen, stateOf, test } from "./fixtures/demoRepo.mjs";
import { expectToast, selectCommit } from "./fixtures/interactions.mjs";

/** Every key the table binds to a letter, in something a reader would plausibly write. */
const SUMMARY = "fix(trim): rework the absorb junk, and log a real error?";
/** Two paragraphs, so the Enter between them is pressed rather than described. */
const DESCRIPTION = "Absorb ate the line.\nUndo, refresh and log misread it.";

/**
 * A dirty working copy on trim-utils, which is what makes Absorb live rather than guarded
 * away — and the commit form reachable at all.
 *
 * The edit lands on the line `feat(trim): add collapseWhitespace` introduced, so absorb has
 * exactly one commit to attribute it to.
 *
 * @param {import("./fixtures/demoRepo.mjs").DemoRepository} demoRepository
 * @param {import("@playwright/test").Page} smartlog
 */
async function dirtyWorkingCopy(demoRepository, smartlog) {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(
    join(demoRepository.path, "src", "trim.js"),
    "export const collapseWhitespace = (s) => s.replace(/\\s+/gu, ' ').trim();\n"
  );
  await reopen(smartlog);
}

/**
 * Press a key with nothing focused, which is where a reader's keystroke lands.
 *
 * The button that ran an action unmounts under the pointer, and a key pressed while
 * `activeElement` is a removed node reaches no handler. Blurring first puts the document back
 * in the path, so what the test drives is the shortcut rather than the browser's recovery.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} key
 */
async function pressGlobally(page, key) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press(key);
}

test("a shortcut key typed into a message stays text", async ({
  demoRepository,
  smartlog,
}) => {
  await dirtyWorkingCopy(demoRepository, smartlog);
  // A commit selected, and not the one HEAD is on: Enter checks the selection out, and j and
  // k move the selection off it, so both keys have something to break.
  await selectCommit(smartlog, "feat(case): add camelCase");
  const before = await stateOf(demoRepository);
  const showing = await smartlog.locator("#sidebar h3").textContent();
  await smartlog.locator("#btn-commit").click();

  await smartlog.locator("#commit-subject").pressSequentially(SUMMARY);
  await smartlog.locator("#commit-body").pressSequentially(DESCRIPTION);

  await expect(smartlog.locator("#commit-subject")).toHaveValue(SUMMARY);
  await expect(smartlog.locator("#commit-body")).toHaveValue(DESCRIPTION);
  // Each key named by what it would have left on screen: `a` opens the absorb preview, `j`
  // and `k` move the selection, `l` collapses the command log, `?` opens the shortcuts list.
  await expect(smartlog.locator("#btn-absorb-apply")).toHaveCount(0);
  await expect(smartlog.locator("#sidebar h3")).toHaveText(String(showing));
  await expect(smartlog.locator("#btn-log")).toHaveText("Hide log");
  await expect(smartlog.locator("#keys.open")).toBeHidden();
  // `u` and the newline are the two that reach git — an undo of whatever the session last
  // did, and a checkout of the selected commit.
  expect(await stateOf(demoRepository)).toEqual(before);
});

test("a modifier held down leaves the shortcuts alone", async ({
  demoRepository,
  smartlog,
}) => {
  await dirtyWorkingCopy(demoRepository, smartlog);

  // Pressed on the document rather than in an input, so the focus guard cannot be what stops
  // them: Control+A selects the page's text, and a reader who reaches for it must not absorb
  // their working copy into history instead.
  for (const chord of ["Control+a", "Alt+a", "Alt+l"]) {
    await pressGlobally(smartlog, chord);
  }

  // Both actions are available in this state — the working copy is dirty and the log is
  // showing — so a guard that only checked the key would fire twice here.
  await expect(smartlog.locator("#btn-absorb")).toBeEnabled();
  await expect(smartlog.locator("#btn-absorb-apply")).toHaveCount(0);
  await expect(smartlog.locator("#btn-log")).toHaveText("Hide log");
});

test("Absorb and Undo run from their keys, as they do from their buttons", async ({
  demoRepository,
  smartlog,
}) => {
  await dirtyWorkingCopy(demoRepository, smartlog);
  const before = await demoRepository.git(["rev-parse", "trim-utils"]);

  await pressGlobally(smartlog, "a");
  await smartlog.locator("#btn-absorb-apply").click();
  await expectToast(smartlog, "Absorbed 1 change");
  expect(await demoRepository.git(["rev-parse", "trim-utils"])).not.toBe(
    before
  );

  await pressGlobally(smartlog, "u");
  await expectToast(smartlog, "Undid Absorb");

  expect(await demoRepository.git(["rev-parse", "trim-utils"])).toBe(before);
  // Undo restores refs and never the working copy, so the change absorb folded into the
  // commit is back where it started: modified, and nothing staged.
  expect(await demoRepository.git(["status", "--porcelain"])).toBe(
    " M src/trim.js"
  );
});
