/**
 * Visual snapshots of the smartlog.
 *
 * A picture is what a reviewer can actually judge: a serialised DOM tells you a
 * badge's class changed, a screenshot tells you the badge now overlaps the branch
 * pill. The graph is the product here — lanes, fork curves, the head halo — and
 * none of that is reviewable as text.
 *
 * Comparison goes through odiff rather than Playwright's built-in comparator. odiff
 * ships a native binary, where the built-in comparator diffs in JavaScript, and every
 * picture here is a full 1400x1000 page that the whole suite re-diffs on each run.
 *
 * The header's pull request freshness indicator is masked by default, being the one
 * true wall clock on screen: it counts from the moment the fetch landed, so it reads
 * "PRs just now" on a fast machine and "PRs 20s ago" on a loaded one. It sits in the
 * topbar, so it appears in every full-page picture — masking it once here beats
 * repeating the mask in every test. Freezing it instead would assert a constant that
 * can never be wrong, and the age is the whole point of the element.
 *
 * Nothing else is masked, which is unusual enough to justify. The remaining reasons to
 * mask — a random id, a live avatar — do not apply here: the demo repository is
 * generated from a fixed epoch with a pinned committer identity, and the config pins
 * the browser's locale and zone, so every sha and date on screen is reproducible.
 * Masking them would grey out a quarter of the graph to prevent churn that cannot
 * happen. Editing the fixture re-records every picture either way, since the rows
 * themselves move. Callers still pass `mask` for a region one test makes volatile.
 *
 * The measurements behind that, taken on the sidebar picture, in case the claim is
 * ever doubted again. Two full runs produced byte-identical pictures, and two
 * separate `--update-snapshots` passes reproduced all 22 baselines byte for byte.
 * A mask over the tree's own shas alone covers 22 elements and 17,428 pixels; the
 * sidebar's identity block is one element holding author, date and full sha
 * together, so masking the date costs the author too. Worst of all is the command
 * log: a sha there sits mid-line inside `git commit-tree 58d0a692…^{tree} -p …`,
 * so hiding it means hiding 7 of 12 whole command lines and 118,524 pixels — 55%
 * of the panel that exists to show what ran.
 *
 * Masking would also delete an assertion the suite currently makes. A wrong sha
 * printed beside a commit — the row showing its parent's abbreviation, a stale sha
 * surviving a rewrite — is a real defect in a tool whose whole job is rewriting
 * history, and these pictures catch it today.
 *
 * What does vary is the machine, not the run. The fixture pins `GIT_CONFIG_GLOBAL`
 * and `GIT_CONFIG_SYSTEM`, which is enough to make a developer's own git config
 * irrelevant; verified by generating the demo twice with a `~/.gitconfig` setting
 * `init.defaultObjectFormat = sha256` and `core.abbrev = 4`, once with the pin and
 * once without. The pinned pair matched, the unpinned run produced 64-character
 * shas. `core.abbrev` cannot reach the screen at all: the reader asks for `%H` and
 * `shorten` in renderModel.ts slices to eight, so git never does the abbreviating.
 * `GIT_DEFAULT_HASH=sha256` in the *environment* does slip past the config pin and
 * changes every sha; nobody sets it by accident, and the whole suite would fail
 * loudly rather than subtly. Font rasterisation remains the known cross-platform
 * difference, which `CONTRIBUTING.md` and the config already accept.
 *
 * ── Re-recording ──
 *
 * `just test-e2e-update` rewrites every picture without asking, so the review of the
 * resulting diff is the only thing standing between a UI change and a baseline that
 * asserts a bug. Read each changed PNG and name the cause before committing it.
 * Three traps found the hard way:
 *
 * The recipe passes `--update-snapshots=all`, which photographs afresh rather than
 * rewriting only what failed. `=changed`, which is what the bare flag means, returns
 * early on any picture that compares within the tolerance — so a drift small enough
 * to pass is also a drift the flag will not correct, and the baseline stays wrong
 * for as long as it keeps passing. That is how the missing button above survived.
 * Recording all of them takes nine seconds and reproduces byte for byte, so there is
 * nothing to weigh against it.
 *
 * A failing snapshot aborts its test, so the later snapshots in that same test are
 * never compared and never reported as failures — yet `--update-snapshots` rewrites
 * them too. Nine baselines changed the last time eight tests failed, because
 * `rebase-conflict` and `after-rebase-abort` share one test. Count the changed
 * files, not the failures.
 *
 * A picture also holds hover state, because the mouse stays wherever the last click
 * left it and `.row:hover .goto-btn` paints a Goto under it. Growing a context menu
 * moves the pointer's resting place, so a menu item added far away can shift a Goto
 * button to a different row several hundred pixels off — which looks like a graph
 * bug and is not one.
 */
import { expect } from "@playwright/test";
import { toHaveScreenshotOdiff } from "playwright-odiff";

expect.extend({ toHaveScreenshotOdiff });

/**
 * Allowed fraction of differing pixels.
 *
 * Not zero: font rasterisation differs by a pixel or two between machines, and a
 * suite that fails on that gets ignored. At 1400x1000 this is 140 pixels, about one
 * short word — a tenth of what a button costs.
 *
 * It was 0.0005 and that was too much to notice a change by. Every full-page
 * baseline photographed a sidebar with no *Open all files* button in it, several
 * versions after the button shipped, and the suite went on passing: the page is
 * 1.6 million pixels, so 0.0005 bought a 800-pixel budget, and a button is 1,500
 * pixels of which the comparison below was discounting most.
 */
const MAX_DIFF_PIXEL_RATIO = 0.0001;

/**
 * How odiff decides two pixels differ.
 *
 * Both of these are stricter than `playwright-odiff`'s defaults, which are
 * `threshold: 0.2` with `antialiasing: true` — and those defaults are what let the
 * missing button above go unseen. Antialiasing detection discounts any pixel it can
 * read as a softened edge, which is most of the pixels in a grey label on a grey
 * chip, and 0.2 of colour distance covers the rest. Together they made a picture of
 * the wrong UI compare equal to one of the right UI.
 *
 * `threshold: 0.1` is odiff's own default, and the antialiasing pass is off because
 * the alternative to catching softened edges here is catching nothing. Text is what
 * these pictures are mostly made of.
 */
const ODIFF_STRICT = { threshold: 0.1, antialiasing: false };

/**
 * Take the toast and the tooltip out of frame.
 *
 * A timer governs both, rather than the state under test. A toast hides itself after three
 * seconds for a success and eight for an error, so whether it lands in a frame depends
 * on how long the git work before it took. A tooltip appears 350ms after the pointer
 * arrives, and the pointer stays wherever the last click left it — then growing the
 * viewport to fit the tree re-runs the hover, so a shutter that opens late catches the
 * description of whichever button the test happened to press. Both are asserted as
 * text elsewhere, by `expectToast` and by the tooltip tests, which is the right tool
 * for a string.
 *
 * The obvious fix, Playwright's `style` screenshot option, does not work here: the
 * page ships a Content Security Policy with no `unsafe-inline`, so an injected
 * stylesheet is refused and both stay in the picture. Setting the property the app
 * itself sets is what survives that.
 *
 * @param {import("@playwright/test").Page} page
 */
async function hideTimedLayers(page) {
  await page.evaluate(() => {
    // A page that raised neither has nothing to hide, which is not a failure: the
    // picture is already clear of them.
    for (const id of ["toast", "tip"]) {
      const element = document.getElementById(id);
      if (element) {
        element.style.display = "none";
      }
    }
  });
}

/**
 * Grow the viewport until the commit tree fits, so no row is cropped.
 *
 * `fullPage` does not help: the tree is an inner scroll container, so the page
 * itself is exactly one viewport tall and the overflow is simply cut off. The
 * conflict states are where this bites — the banner pushes the tree down by more
 * than the slack at the bottom, and the first recording of those pictures ended
 * mid-row with nothing to say it had. Enlarging the window is what reveals them.
 *
 * The height is derived, not a bigger constant, so a fixture that grows a stack
 * still photographs whole. Only ever grows: shrinking back would make the picture
 * depend on which test ran before it.
 *
 * @param {import("@playwright/test").Page} page
 */
async function fitViewportToTree(page) {
  const overflow = await page.evaluate(() => {
    const tree = document.getElementById("tree");
    return tree ? tree.scrollHeight - tree.clientHeight : 0;
  });
  const viewport = page.viewportSize();
  // No overflow, or no viewport to grow — a browser launched headless without one.
  if (overflow <= 0 || !viewport) {
    return;
  }
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height + overflow,
  });
}

/**
 * Build the `snapshot` fixture: `await snapshot("initial-tree")` captures the page,
 * or an element when `locator` is given.
 *
 * Prefer a locator when the state under test is one panel. A full-page shot of a
 * split panel also carries the whole graph behind it, so an unrelated change to a
 * branch pill would fail the split test too.
 *
 * `mask` paints locators over before the shutter, for a region one test genuinely
 * cannot pin — a wall-clock elapsed time, a path under the operating system's temp
 * directory, an avatar fetched from the network:
 *
 *     await snapshot("after-push", { mask: [page.locator("#push-duration")] });
 *
 * Reach for it per test, never as a default; the header explains why no sha or date
 * qualifies. The pull request freshness indicator is always added to whatever the
 * caller passes, for the reason the header gives.
 *
 * @param {import("@playwright/test").Page} page
 */
export function createSnapshotTaker(page) {
  return async (
    /** @type {string} */ name,
    /**
     * @type {{
     *   locator?: import("@playwright/test").Locator,
     *   mask?: import("@playwright/test").Locator[],
     * }}
     */
    { locator, mask = [] } = {}
  ) => {
    if (!locator) {
      await fitViewportToTree(page);
    }
    // After the resize, which re-runs the hover under a stationary pointer and so can
    // start a tooltip that was not there a moment ago.
    await hideTimedLayers(page);
    const target = locator ?? page;
    await expect(target).toHaveScreenshotOdiff(`${name}.png`, {
      ...ODIFF_STRICT,
      mask: [...mask, page.locator("#pr-freshness")],
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
      // The app has no CSS transitions, so this only guards against one being
      // added later without the snapshots being re-recorded.
      animations: "disabled",
      // A caret blinking in the sidebar's message editor would otherwise differ
      // between identical runs.
      caret: "hide",
      fullPage: !locator,
    });
  };
}
