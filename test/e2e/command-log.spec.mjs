/**
 * The command log: the toggle, the count it keeps while hidden, and what an action records.
 *
 * The panel is the one part of the UI a picture cannot cover — it scrolls, so a frame holds
 * about half the commands an operation runs. It is also plain text, which is what an
 * assertion reads well.
 */
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";
import { expectLogEntry, expectToast } from "./fixtures/interactions.mjs";

/**
 * The command log toggle.
 *
 * Both refresh buttons keep their resting label across a click — `loadPullRequests`
 * rewrites *Refresh PRs* to "Loading PRs…" and back, and a mismatch there renames the
 * button permanently on first use — so these assert the label as well as the panel.
 */
test("hiding the command log gives the tree its height back, and showing it returns", async ({
  smartlog,
}) => {
  const log = smartlog.locator("#log");
  const toggle = smartlog.locator("#btn-log");
  const treeHeight = () =>
    smartlog.locator("#tree").evaluate(tree => tree.clientHeight);

  await expect(log).toBeVisible();
  const shortTree = await treeHeight();

  await toggle.click();
  await expect(log).toBeHidden();
  await expect(toggle).toHaveText("Show log");
  // The log is `height: 25%` of a flex column whose tree is `flex: 1`, so removing
  // it is what grows the tree — the assertion that the space actually moved.
  expect(await treeHeight()).toBeGreaterThan(shortTree);

  await toggle.click();
  await expect(log).toBeVisible();
  await expect(toggle).toHaveText("Hide log");
  expect(await treeHeight()).toBe(shortTree);
});

test("the command log stays hidden across a reload", async ({ smartlog }) => {
  await smartlog.locator("#btn-log").click();
  await expect(smartlog.locator("#log")).toBeHidden();

  await reopen(smartlog);
  await expect(smartlog.locator("#log")).toBeHidden();
  await expect(smartlog.locator("#btn-log")).toHaveText("Show log");

  // And the reverse, so a persisted "hidden" is not simply the default.
  await smartlog.locator("#btn-log").click();
  await reopen(smartlog);
  await expect(smartlog.locator("#log")).toBeVisible();
});

/**
 * A hidden log is a deliberate, persisted choice, so an action that logs does not
 * reopen the panel — a refresh mid-review would yank a quarter of the tree away. The
 * count on the button is what replaces the reveal: a failed action leaves a toast that
 * times out in eight seconds and carries no commands, so the button has to say that
 * something is there to look at.
 */
test("an action that logs while the log is hidden counts the entry instead of revealing it", async ({
  smartlog,
}) => {
  await smartlog.locator("#btn-log").click();
  await expect(smartlog.locator("#log")).toBeHidden();

  // The count reaching one is itself the wait for the refresh's response: nothing
  // else changes on screen, and the log entry it appended cannot be asserted as
  // visible while the panel is hidden.
  await smartlog.locator("#btn-refresh").click();
  await expect(smartlog.locator("#btn-log")).toHaveText("Show log (1)");
  await expect(smartlog.locator("#log")).toBeHidden();

  // Showing the log clears the count and lands the newest entry in view. A hidden
  // panel measures zero, so the scroll each append performed moved nothing.
  await smartlog.locator("#btn-log").click();
  await expect(smartlog.locator("#btn-log")).toHaveText("Hide log");
  await expectLogEntry(smartlog, "Refresh repository");
  const scrolledToBottom = await smartlog
    .locator("#log-body")
    .evaluate(
      body => body.scrollHeight - body.scrollTop - body.clientHeight <= 1
    );
  expect(scrolledToBottom).toBe(true);
});

test("Clear resets the count the hidden log accumulated", async ({
  smartlog,
}) => {
  await smartlog.locator("#btn-log").click();
  await smartlog.locator("#btn-refresh").click();
  await expect(smartlog.locator("#btn-log")).toHaveText("Show log (1)");

  // Clear is inside the hidden panel, so click it through the DOM rather than as a
  // user would — the point is that the count and the body cannot disagree.
  await smartlog.locator("#btn-log-clear").dispatchEvent("click");
  await expect(smartlog.locator("#btn-log")).toHaveText("Show log");
});

/**
 * This guards a bug that a screenshot would never show. The log used to record into
 * every open buffer, so a background read's history walk appeared inside a mutation's
 * entry — a fold's entry listed `git log --boundary`, which a fold never runs.
 * Asserting the exact command list is what catches that coming back.
 */
test("the command panel records exactly what the action ran", async ({
  smartlog,
}) => {
  await smartlog
    .getByText("feat(case): add snakeCase")
    .click({ button: "right" });
  await smartlog.getByText("Fold into the commit below").click();
  await expectToast(smartlog, "Folded into the commit below");

  const entries = await smartlog.locator("#log-body .log-entry").all();
  expect(entries).toHaveLength(1);
  const commands = (await entries[0].locator(".log-cmd").allTextContents()).map(
    command =>
      // Strip the `$ ` prompt and collapse each `--format` down to its flag: the
      // format strings carry git's field separators and say nothing about the fold.
      command.replace(/^\$\s*/, "").replace(/--format=\S*/, "--format=…")
  );
  expect(await entries[0].locator(".log-title").textContent()).toBe(
    "Fold into commit below"
  );
  // Shas differ per run only in that they are shas; the shape is what matters.
  expect(
    commands.map(command => command.replace(/\b[0-9a-f]{40}\b/g, "<sha>"))
  ).toEqual([
    "git for-each-ref --format=… refs/heads",
    "git symbolic-ref --short -q HEAD",
    "git rev-parse HEAD",
    "git rev-parse --show-toplevel",
    "git config user.email",
    "git for-each-ref --include-root-refs --format=… HEAD refs/heads refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master",
    "git status --porcelain=v2 --branch -z",
    "git rev-parse --path-format=absolute --git-common-dir",
    "git log --author-date-order --boundary --format=… --branches HEAD --not origin/main",
    "git rev-list --left-right --count <sha>...origin/main",
    "git rev-list --left-right --count <sha>...origin/main",
    "git rev-list --left-right --count <sha>...origin/main",
    "git commit-tree <sha>^{tree} -p <sha>",
    "git commit-tree <sha>^{tree} -p <sha>",
    "git commit-tree <sha>^{tree} -p <sha>",
    "git commit-tree <sha>^{tree} -p <sha>",
    "git commit-tree <sha>^{tree} -p <sha>",
    "git commit-tree <sha>^{tree} -p <sha>",
    "git update-ref --stdin -z",
    "git for-each-ref --format=… refs/heads",
  ]);
});
