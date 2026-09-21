/**
 * The commit panel: what a selection puts on screen, and the read-only views it opens.
 *
 * Nothing here rewrites history — every mutation the panel's buttons reach is in
 * `operations.spec.mjs`. What these cover is the panel arriving correctly filled, and the
 * two things about it a unit test cannot reach: the diff overlay, and gestures on the
 * description box that the browser also has its own meaning for.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TEAL_PNG } from "../../scripts/git-fixture.mjs";
import { present } from "../present.mjs";
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";
import { boxOf, selectCommit } from "./fixtures/interactions.mjs";

/**
 * The demo commit with a body and a single modified file.
 *
 * Its diff therefore holds both an addition and a removal, and its body is longer than the
 * description box's 110px starting height — so the fit-to-content gesture has something to
 * do and the assertions are about real clipping rather than an arbitrary number.
 */
const COMMIT_WITH_BODY = "wip(case): note small-word handling TODO";

test("selecting a commit opens the sidebar with its message and files", async ({
  smartlog,
  snapshot,
}) => {
  await selectCommit(smartlog, "feat(case): add camelCase");
  await snapshot("sidebar-selected-commit");
});

test("a dirty working copy shows the uncommitted chip and its files", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(
    join(demoRepository.path, "src", "trim.js"),
    "export const collapseWhitespace = (s) => s.replace(/\\s+/g, ' ').trim().normalize();\n"
  );
  await reopen(smartlog);
  // No click first: the rows are on screen as soon as there is a selection to make, and the
  // chip now opens the changes overlay, which `operations.spec.mjs` reads.
  await expect(smartlog.locator("#wc .files .file")).toBeVisible();
  await snapshot("uncommitted-changes");
});

test("keyboard navigation walks commit rows and skips bases", async ({
  smartlog,
  snapshot,
}) => {
  await smartlog.locator("#tree").click();
  for (let step = 0; step < 3; step++) {
    await smartlog.keyboard.press("ArrowDown");
  }
  await smartlog.waitForSelector("#sidebar.open #filelist .file");
  await snapshot("keyboard-third-row");
});

/** @param {import("@playwright/test").Page} page */
async function descriptionHeight(page) {
  return Math.round((await boxOf(page, "#msg-body")).height);
}

/**
 * Double-click the textarea's own resize corner.
 *
 * @param {import("@playwright/test").Page} page
 */
async function dblclickGrip(page) {
  const box = await boxOf(page, "#msg-body");
  await page.mouse.dblclick(box.x + box.width - 5, box.y + box.height - 5);
  await page.waitForTimeout(150);
}

test("double-clicking the description grip fits the box to the message, and back", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_BODY);

  // The body does not fit at the starting height — otherwise this proves nothing.
  expect(await descriptionHeight(smartlog)).toBe(110);
  expect(
    await smartlog
      .locator("#msg-body")
      .evaluate(box => box.scrollHeight > box.clientHeight + 1)
  ).toBe(true);

  await dblclickGrip(smartlog);
  const fitted = await descriptionHeight(smartlog);
  expect(fitted).toBeGreaterThan(110);
  // `scrollHeight` omits the border on a border-box element, so fitting to it exactly
  // left the last line a border's width short — still scrollable. This is that check.
  expect(
    await smartlog
      .locator("#msg-body")
      .evaluate(box => box.scrollHeight > box.clientHeight + 1)
  ).toBe(false);

  // A second double-click returns it, so the gesture toggles rather than only growing.
  await dblclickGrip(smartlog);
  expect(await descriptionHeight(smartlog)).toBe(110);
});

test("double-clicking inside the description still selects a word", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_BODY);

  const box = await boxOf(smartlog, "#msg-body");
  await smartlog.mouse.dblclick(box.x + 40, box.y + 14);
  await smartlog.waitForTimeout(150);

  // Only the corner resizes: stealing word selection across the whole box would be worse
  // than the problem it solves.
  expect(await descriptionHeight(smartlog)).toBe(110);
  expect(
    await smartlog.locator("#msg-body").evaluate(element => {
      const area = /** @type {HTMLTextAreaElement} */ (element);
      return area.value.slice(area.selectionStart, area.selectionEnd).trim()
        .length;
    })
  ).toBeGreaterThan(0);
});

test("View changes shows every file's diff for the commit, read-only", async ({
  smartlog,
  snapshot,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_BODY);
  await smartlog.locator("#btn-view-changes").click();
  await expect(smartlog.locator("#changes.open")).toBeVisible();

  // The heading names the commit, so it is clear which diff is on screen.
  await expect(smartlog.locator("#changes-title")).toContainText("Changes in");
  await expect(smartlog.locator("#changes .dffile")).toHaveCount(1);
  // Both gutters are populated: a diff without them cannot answer "which line is this in
  // the file now?", the question a reader has before going to edit it.
  const firstContext = smartlog.locator("#changes .dfline.context").first();
  await expect(firstContext.locator(".ln").first()).not.toBeEmpty();
  await expect(firstContext.locator(".ln").nth(1)).not.toBeEmpty();
  // An addition has no old number and a removal no new one, which is what marks a line as
  // existing on only one side.
  await expect(
    smartlog.locator("#changes .dfline.add .ln").first()
  ).toBeEmpty();
  await expect(smartlog.locator("#changes .dfline.del .ln").nth(1)).toBeEmpty();
  await snapshot("changes-overlay", { locator: smartlog.locator("#changes") });

  // Escape closes the diff and leaves the sidebar it was opened from alone.
  await smartlog.keyboard.press("Escape");
  await expect(smartlog.locator("#changes.open")).toBeHidden();
  await expect(smartlog.locator("#sidebar.open")).toBeVisible();
});

test("an image in the overlay is drawn rather than noted as binary", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(join(demoRepository.path, "logo.png"), TEAL_PNG);
  await demoRepository.git(["add", "logo.png"]);
  await demoRepository.git(["commit", "-m", "docs(readme): add the logo"]);
  await reopen(smartlog);

  await selectCommit(smartlog, "docs(readme): add the logo");
  await smartlog.locator("#btn-view-changes").click();
  await expect(smartlog.locator("#changes .dfimage img")).toHaveCount(1);

  // Decoded, not merely present. The overlay's content policy blocks every image source it
  // does not name, and a blocked `data:` URI leaves an `<img>` reporting zero by zero — the
  // one failure a DOM snapshot cannot tell apart from a working preview. The fixture is
  // 64×48, so the numbers say the bytes arrived intact rather than only that something drew.
  await expect
    .poll(() =>
      smartlog
        .locator("#changes .dfimage img")
        .evaluate(image => /** @type {HTMLImageElement} */ (image).naturalWidth)
    )
    .toBe(64);
  // The prose the picture replaces, and the caption that says which side survived: an
  // addition has no parent version, so "Before" would be a placeholder beside the picture.
  await expect(smartlog.locator("#changes")).not.toContainText("Binary file");
  await expect(smartlog.locator("#changes .dfimage figcaption")).toContainText(
    "After — 140 B"
  );
});

test("each file row carries its own actions, revealed on hover", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_BODY);
  const row = smartlog.locator("#filelist .file").first();

  // Hidden until the pointer is on the row, so the list stays a list of paths. They are
  // on the row rather than in the header because a header button acting on a "selected"
  // file meant one click to aim and another to fire — and the aiming click already opened
  // a tab, which is the UX this replaced.
  await expect(row.locator(".iconbtn.diff")).toBeHidden();
  await row.hover();
  await expect(row.locator(".iconbtn.diff")).toBeVisible();
  await expect(row.locator(".iconbtn.file")).toBeVisible();

  // One click opens the diff for that row's file — no selection step.
  await row.locator(".iconbtn.diff").click();
  await expect(smartlog.locator("#changes.open")).toBeVisible();
  // Scoped to the one file, unlike View changes: the title is the path, not the hash.
  await expect(smartlog.locator("#changes-title")).toContainText(
    "src/titlecase.js"
  );
  await expect(smartlog.locator("#changes .dffile")).toHaveCount(1);
});

test("clicking a file name opens its diff once the design panel asks for one", async ({
  smartlog,
}) => {
  await selectCommit(smartlog, COMMIT_WITH_BODY);

  // Default: the click opens the file, which in web mode hands off to the system and
  // leaves no overlay behind.
  await smartlog.locator("#filelist .file .fp").first().click();
  await expect(smartlog.locator("#changes.open")).toBeHidden();

  await smartlog.locator("#btn-design").click();
  await smartlog
    .locator('#seg-fileclick button[data-fileclick="diff"]')
    .click();
  await smartlog.locator("#btn-design-close").click();
  await selectCommit(smartlog, COMMIT_WITH_BODY);
  await smartlog.locator("#filelist .file .fp").first().click();
  await expect(smartlog.locator("#changes.open")).toBeVisible();
});

/**
 * Whether the editor takes focus is the host's decision, so the request carrying that choice
 * is what a browser can check. Both hosts are stubbed here for a second reason: the web host
 * answers `openFile` by handing the path to the desktop's own opener, and a test that let it
 * through would launch whatever the machine associates with `.js`.
 */
test("holding the accelerator asks for a tab that leaves focus in the panel", async ({
  smartlog,
}) => {
  /** @type {{ path: string, sha: string, background: boolean }[]} */
  const asked = [];
  await smartlog.route("**/api/openFile", async route => {
    asked.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await selectCommit(smartlog, COMMIT_WITH_BODY);
  const row = smartlog.locator("#filelist .file").first();

  await row.click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0].background).toBe(false);

  // `ControlOrMeta` is Command on a Mac and Control everywhere else, which is the same split
  // the click handler reads — so this exercises the modifier this machine's reader would use.
  await row.click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => asked.length).toBe(2);
  expect(asked[1].background).toBe(true);
});

/**
 * One request carrying every path, rather than one request per file: the host opens them in
 * sequence, and tabs land in the order the editors opened. Sending them separately would let
 * the responses race and scramble the strip against the list that was clicked.
 */
test("Open all files sends every path the list shows, in the order it shows them", async ({
  demoRepository,
  smartlog,
}) => {
  /** @type {{ paths: string[], sha: string } | undefined} */
  let sent;
  await smartlog.route("**/api/openFiles", async route => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  // Every commit the demo repository ships touches one file, and a list of one says nothing
  // about order or about a count. The commit is made here rather than in the fixture because a
  // new row there would rewrite every snapshot baseline in the suite.
  await demoRepository.git(["checkout", "case-utils"]);
  await writeFile(
    join(demoRepository.path, "src", "zip.js"),
    "export const zip = (left, right) => left.map((x, i) => [x, right[i]]);\n"
  );
  await writeFile(
    join(demoRepository.path, "src", "apex.js"),
    "export const apex = (values) => Math.max(...values);\n"
  );
  await demoRepository.git(["add", "-A"]);
  await demoRepository.git(["commit", "-m", "feat(seq): zip and apex"]);
  await reopen(smartlog);

  await selectCommit(smartlog, "feat(seq): zip and apex");
  // `[data-path]` picks the rows alone: a row's own file icon carries the class `file` too, so
  // the bare selector counts each row twice and the extra matches have no path.
  const shown = await smartlog
    .locator("#filelist .file[data-path]")
    .evaluateAll(rows => rows.map(row => row.dataset.path));
  expect(shown).toEqual(["src/apex.js", "src/zip.js"]);

  // The count is in the tooltip rather than the label, so the button's width does not move
  // between commits — and a wrong count would mean the button and the list disagree.
  await expect(smartlog.locator("#btn-open-all-files")).toHaveAttribute(
    "title",
    `Open all ${shown.length} files in tabs, leaving focus here.`
  );
  await smartlog.locator("#btn-open-all-files").click();
  await expect.poll(() => sent).not.toBeUndefined();
  expect(present(sent, "an openFiles request").paths).toEqual(shown);
});
