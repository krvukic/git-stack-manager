/**
 * Record the README picture from the demo repository.
 *
 * The picture is the README's main claim, so it is taken from the same web host `just web`
 * runs, against the same generated repository the end-to-end suite photographs. Reusing
 * that fixture is what stops the picture from showing a layout the product no longer
 * produces: a stale hand-cropped image is the one part of a README nothing checks.
 *
 * The frame differs from a test baseline in three ways, all on purpose. It runs at a
 * device scale factor of 2, because a README image is displayed at half its pixel width
 * and a 1x capture reads blurred there. It opens the commit panel on one commit, because
 * a closed panel spends a third of the width on an empty column. And it closes the
 * command log, which starts empty and would otherwise spend a third of the height saying
 * so.
 *
 * Usage: just screenshot
 */
import { cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  buildDemoTemplate,
  serveRepository,
  writeStandInGitHub,
} from "../test/e2e/fixtures/demoRepo.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(repositoryRoot, "media", "screenshot.png");

/**
 * Matches `playwright.config.mjs`, so the picture is framed like every recorded
 * baseline and a layout change shows up in both places at once.
 */
const VIEWPORT = { width: 1400, height: 1000 };

/**
 * The commit the panel opens on: mid-chain in the three-branch `case-utils` stack, so the
 * frame shows a branch pill, a sync badge, and a pull request badge above and below it.
 */
const SUBJECT = "feat(case): add camelCase";

/**
 * Shrink the window to the height the two panels actually fill.
 *
 * At the test viewport this demo leaves a fifth of the frame as empty tree, which a README
 * image renders as dead space above the fold. The measurement is the last child of each
 * panel rather than the panel's own `scrollHeight`: both panels are flex children sized to
 * the window, so a container that does not overflow reports exactly the height being
 * trimmed. The taller of the two wins, since trimming to the tree alone would crop the
 * commit panel on a fixture with fewer rows.
 *
 * @param {import("@playwright/test").Page} page
 */
async function trimViewportToContent(page) {
  const height = await page.evaluate(() => {
    const contentBottom = (/** @type {string} */ id) => {
      const last = document.getElementById(id)?.lastElementChild;
      return last ? last.getBoundingClientRect().bottom : 0;
    };
    const padding = 16;
    return Math.ceil(
      Math.max(contentBottom("tree"), contentBottom("sidebar")) + padding
    );
  });
  if (height > 0 && height < VIEWPORT.height) {
    await page.setViewportSize({ width: VIEWPORT.width, height });
  }
}

async function main() {
  const template = await buildDemoTemplate();
  const gitHub = writeStandInGitHub(join(template, "fake-gh"));
  // The top bar names the served directory, and the fixture calls its checkout "work".
  // Copying it under the demo repository's own name is what puts "strkit" on screen, so
  // the picture and the text describing it agree. The copy keeps the template's origin
  // URL, which still resolves, so every sync badge stays as recorded.
  const checkout = join(template, "strkit");
  cpSync(join(template, "work"), checkout, { recursive: true });
  const server = await serveRepository(checkout, gitHub.environment);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      // The sidebar formats the commit date through `toLocaleString`, so both pins
      // decide what the picture says. Same reason the Playwright config sets them.
      locale: "en-US",
      timezoneId: "UTC",
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    // Two paints, not one: the model first, then the pull request badges the `gh` call
    // fills in. Shooting after the first leaves every badge blank.
    await page.waitForSelector("#tree .row");
    await page.waitForSelector("#btn-prs:not([disabled])");
    await page.getByText(SUBJECT).click();
    await page.waitForSelector("#sidebar.open #filelist .file");
    await page.getByRole("button", { name: "Hide log" }).click();
    // The freshness indicator counts from the moment the fetch landed, so it would put a
    // wall clock in a committed file.
    await page.evaluate(() => {
      const freshness = document.getElementById("pr-freshness");
      if (freshness) {
        freshness.style.visibility = "hidden";
      }
    });
    await trimViewportToContent(page);
    await page.screenshot({ path: output, animations: "disabled" });
  } finally {
    await browser.close();
    server.child.kill("SIGKILL");
    rmSync(template, { recursive: true, force: true });
  }
  console.log(`Wrote ${output}`);
}

await main();
