/**
 * Submitting, driven through the button.
 *
 * The unit tests already pin the command sequence; what these add is that the
 * button reaches it. A submit path can be perfectly correct and still be unreachable
 * — wired to a stale commit object, or hidden on the branch that needed it — and
 * only clicking finds that out.
 *
 * `gh` is a recording stand-in (see the `fakeGitHub` fixture) so no test touches
 * GitHub, while the pushes are real against the copy's own bare origin.
 */
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";
import {
  expectToast,
  REBASE_ONTO_TRUNK,
  selectCommit,
} from "./fixtures/interactions.mjs";

test("submitting a never-pushed branch opens a pull request from the commit message", async ({
  demoRepository,
  smartlog,
  fakeGitHub,
}) => {
  // escape-html is a single-commit branch off the trunk tip that the demo never
  // pushes, so this is the create path.
  await selectCommit(smartlog, "feat: add escapeHtml");
  await expect(smartlog.locator("#btn-submit")).toHaveText(
    "Submit as pull request"
  );
  await smartlog.locator("#btn-submit").click();
  await expectToast(smartlog, "Opened #101");

  // The branch really reached the remote, and tracks it — otherwise the pill would
  // still read "not submitted" straight after a successful submit.
  expect(await demoRepository.git(["rev-parse", "origin/escape-html"])).toBe(
    await demoRepository.git(["rev-parse", "escape-html"])
  );
  expect(
    await demoRepository.git([
      "for-each-ref",
      "--format=%(upstream:short)",
      "refs/heads/escape-html",
    ])
  ).toBe("origin/escape-html");

  const create = fakeGitHub.calls().find(call => call.args[1] === "create");
  expect(create.args).toEqual([
    "pr",
    "create",
    "--head",
    "escape-html",
    "--base",
    "main",
    "--title",
    "feat: add escapeHtml",
    "--body-file",
    "-",
  ]);
});

test("the button names the pull request it just opened, before GitHub indexes it", async ({
  smartlog,
}) => {
  // The stand-in `gh` answers `pr list` from a fixed set that never mentions escape-html,
  // which is also what GitHub does for a pull request opened a second ago: `pr create`
  // reports #101 while the search index the badges come from still finds nothing. So the
  // label has to come from the submit's own answer. Observed against a live repository
  // before this held: the button offered to open a pull request that already existed, and
  // kept offering for a minute, because the refresh fired after the submit cached the
  // empty search result.
  await selectCommit(smartlog, "feat: add escapeHtml");
  await smartlog.locator("#btn-submit").click();
  await expectToast(smartlog, "Opened #101");
  await expect(smartlog.locator("#btn-submit")).toHaveText("Submit → #101");
});

test("amending a message then submitting carries the new text to the pull request", async ({
  demoRepository,
  smartlog,
  fakeGitHub,
}) => {
  // The flow the feature exists for: reword, submit, and the pull request should
  // not be left describing the old message.
  await selectCommit(smartlog, "feat: add escapeHtml");
  await smartlog
    .locator("#msg-subject")
    .fill("feat: add escapeHtml, with tests");
  await smartlog.locator("#msg-body").fill("Covers the ampersand case.");
  await smartlog.locator("#btn-amend").click();
  await expectToast(smartlog, "Message amended");

  await smartlog.locator("#btn-submit").click();
  await expectToast(smartlog, "Opened #101");

  const create = fakeGitHub.calls().find(call => call.args[1] === "create");
  expect(create.args[create.args.indexOf("--title") + 1]).toBe(
    "feat: add escapeHtml, with tests"
  );
  expect(create.stdin.trim()).toBe("Covers the ampersand case.");
  // And the amended commit is what got pushed, not the pre-amend one.
  expect(
    await demoRepository.git(["log", "-1", "--format=%s", "origin/escape-html"])
  ).toBe("feat: add escapeHtml, with tests");
});

test("a stacked branch whose base was never pushed is refused before the push", async ({
  smartlog,
  fakeGitHub,
  demoRepository,
}) => {
  // redact-utils sits on mask-utils, and neither is pushed. GitHub cannot base a pull
  // request on a branch it does not have, so Submit names Submit stack instead.
  await selectCommit(smartlog, "feat(redact): add redactEmails on top of mask");
  await smartlog.locator("#btn-submit").click();
  await expectToast(smartlog, "Submit the stack instead");

  expect(fakeGitHub.calls().filter(call => call.args[1] === "create")).toEqual(
    []
  );
  expect(
    await demoRepository.git(["branch", "-r", "--list", "origin/redact-utils"])
  ).toBe("");
});

test("submit stack opens every layer from the bottom up, each against the one below", async ({
  smartlog,
  fakeGitHub,
}) => {
  await selectCommit(smartlog, "feat(redact): add redactEmails on top of mask");
  await smartlog.locator("#btn-submit-stack").click();
  await expectToast(smartlog, "Submitted 2 branches — 2 opened, 0 updated");

  const creates = fakeGitHub
    .calls()
    .filter(call => call.args[1] === "create")
    .map(call => call.args.slice(2, 6));
  expect(creates).toEqual([
    ["--head", "mask-utils", "--base", "main"],
    ["--head", "redact-utils", "--base", "mask-utils"],
  ]);
});

test("a commit with no branch offers no submit button", async ({
  smartlog,
}) => {
  // Nothing to push: a pull request is per branch, so the sidebar says why instead
  // of showing a button that cannot work.
  await selectCommit(smartlog, "feat(trim): add collapseWhitespace");
  await expect(smartlog.locator("#btn-submit")).toHaveCount(0);
  await expect(smartlog.locator("#sidebar")).toContainText(
    "Give this commit a branch to submit it"
  );
});

test("submit stays disabled while a conflict is unresolved", async ({
  smartlog,
}) => {
  // Pushing mid-rebase would publish a half-replayed stack, so the button is out of
  // action until the conflict is settled — the same rule the rebase button follows.
  // truncate-words and trunk both rewrite the same line, so this conflict is the
  // fixture's design rather than a race.
  await smartlog
    .getByText("feat(truncate): break at word boundaries")
    .click({ button: "right" });
  await smartlog.getByText(REBASE_ONTO_TRUNK, { exact: true }).click();
  await smartlog.waitForSelector("#conflict.open");

  await selectCommit(smartlog, "feat(redact): add redactEmails on top of mask");
  await expect(smartlog.locator("#btn-submit")).toBeDisabled();
});

test("a conflict that starts with the sidebar open disables submit too", async ({
  smartlog,
  fakeGitHub,
}) => {
  // The order matters, and the test above cannot catch this one: selecting first
  // means the conflict arrives while the panel already stands open, and `render()`
  // rebuilds only the tree. The guard used to live in `select()` alone, so Submit
  // kept whatever state the last selection gave it — clicking it mid-conflict really
  // pushed the branch and opened a pull request while a path was still unmerged.
  await selectCommit(smartlog, "feat(redact): add redactEmails on top of mask");
  await expect(smartlog.locator("#btn-submit")).toBeEnabled();

  await smartlog
    .getByText("feat(truncate): break at word boundaries")
    .click({ button: "right" });
  await smartlog.getByText(REBASE_ONTO_TRUNK, { exact: true }).click();
  await smartlog.waitForSelector("#conflict.open");

  await expect(smartlog.locator("#btn-submit")).toBeDisabled();
  // The push is what a stale guard actually costs, so assert that nothing reached
  // `gh` rather than only that the button looks dimmed.
  expect(fakeGitHub.calls().filter(call => call.args[1] === "create")).toEqual(
    []
  );
});

/**
 * The Draft toggle, which names the state Submit opens a pull request in.
 *
 * Each test reads the choice back out of git config and the call out of the stand-in `gh`,
 * because the toggle's tick alone would look right with neither behind it.
 */
const DRAFT_TOGGLE = "#sidebar input[type=checkbox]";

test("ticking Draft stores the choice, and Submit opens a draft", async ({
  demoRepository,
  smartlog,
  fakeGitHub,
}) => {
  await selectCommit(smartlog, "feat: add escapeHtml");
  // Never pushed and never chosen, so the toggle shows the setting: ready for review.
  await expect(smartlog.locator(DRAFT_TOGGLE)).not.toBeChecked();

  await smartlog.locator(DRAFT_TOGGLE).click();
  await expectToast(
    smartlog,
    "Submit will open escape-html's pull request as a draft"
  );
  await expect(smartlog.locator(DRAFT_TOGGLE)).toBeChecked();
  expect(
    await demoRepository.git(["config", "branch.escape-html.gsm-draft"])
  ).toBe("true");
  // The toggle only records. Nothing has reached GitHub yet.
  expect(fakeGitHub.calls().filter(call => call.args[0] === "pr")).toEqual([]);

  await smartlog.locator("#btn-submit").click();
  await expectToast(smartlog, "Opened #101");
  const create = fakeGitHub.calls().find(call => call.args[1] === "create");
  expect(create.args.at(-1)).toBe("--draft");
});

test("the New pull requests setting ticks Draft on a branch with no choice of its own", async ({
  smartlog,
  fakeGitHub,
}) => {
  await smartlog.locator("#btn-config").click();
  await smartlog
    .locator('#seg-draftdefault button[data-draftdefault="on"]')
    .click();
  await smartlog.locator("#btn-config-close").click();

  await selectCommit(smartlog, "feat: add escapeHtml");
  await expect(smartlog.locator(DRAFT_TOGGLE)).toBeChecked();

  await smartlog.locator("#btn-submit").click();
  await expectToast(smartlog, "Opened #101");
  const create = fakeGitHub.calls().find(call => call.args[1] === "create");
  expect(create.args.at(-1)).toBe("--draft");
});

test("a branch with an open pull request offers no Draft toggle, and Submit leaves its state alone", async ({
  demoRepository,
  smartlog,
  fakeGitHub,
}) => {
  // #206 on trim-utils is open and ready for review. A choice of draft is stored for the
  // branch, which is the case a submit that enforced the choice would act on.
  await demoRepository.git(["config", "branch.trim-utils.gsm-draft", "true"]);
  await reopen(smartlog);

  await selectCommit(smartlog, "test(pad): cover padStart (local, unpushed)");
  await expect(smartlog.locator("#btn-submit")).toHaveText("Submit → #206");
  await expect(smartlog.locator(DRAFT_TOGGLE)).toHaveCount(0);

  await smartlog.locator("#btn-submit").click();
  await expectToast(smartlog, "Updated #206");
  expect(
    fakeGitHub
      .calls()
      .map(call => call.args)
      .filter(args => args[1] === "ready")
  ).toEqual([]);
});

/**
 * A pull request someone closed on GitHub. local-experiment's #173 is closed, and its base,
 * pad-utils, is pushed, so only the closed pull request makes Submit refuse.
 */
const CLOSED_SUBJECT = "experiment(pad): add repeat helper (local only)";

test("Submit is off beside a closed pull request, and Submit as new pull request opens one beside it", async ({
  smartlog,
  fakeGitHub,
  demoRepository,
}) => {
  await selectCommit(smartlog, CLOSED_SUBJECT);
  await expect(smartlog.locator("#btn-submit")).toBeDisabled();
  await expect(smartlog.locator("#submit-note")).toHaveText(
    "#173 is closed, and Submit leaves it closed. Reopen it on GitHub, or right-click this commit and choose Submit as new pull request."
  );
  // `stackStatus` reports the stop too, since Submit stack would otherwise look like the fix.
  await expect(smartlog.locator("#stack-status")).toHaveText(
    "local-experiment's pull request #173 is closed, so Submit stack stops there. Reopen it on GitHub, or right-click local-experiment's commit and choose Submit as new pull request."
  );
  expect(
    await demoRepository.git([
      "branch",
      "-r",
      "--list",
      "origin/local-experiment",
    ])
  ).toBe("");

  await smartlog.getByText(CLOSED_SUBJECT).click({ button: "right" });
  await smartlog
    .locator("#menu .item", {
      hasText: "Submit local-experiment as new pull request",
    })
    .click();
  await expectToast(smartlog, "Opened #101 onto pad-utils");

  const creates = fakeGitHub
    .calls()
    .filter(call => call.args[1] === "create")
    .map(call => call.args.slice(2, 6));
  expect(creates).toEqual([
    ["--head", "local-experiment", "--base", "pad-utils"],
  ]);
  expect(
    await demoRepository.git(["rev-parse", "origin/local-experiment"])
  ).toBe(await demoRepository.git(["rev-parse", "local-experiment"]));
});

test("submit stack updates the branches below a closed pull request and stops there", async ({
  smartlog,
  fakeGitHub,
  demoRepository,
}) => {
  await selectCommit(smartlog, CLOSED_SUBJECT);
  await smartlog.locator("#btn-submit-stack").click();
  await expectToast(
    smartlog,
    "Pull request #173 for local-experiment is closed, so Submit stack submitted only case-utils and pad-utils."
  );

  const prCommands = fakeGitHub
    .calls()
    .map(call => call.args)
    .filter(args => args[1] === "edit" || args[1] === "create")
    .map(args => args.slice(1, 3));
  expect(prCommands).toEqual([
    ["edit", "case-utils"],
    ["edit", "pad-utils"],
  ]);
  expect(
    await demoRepository.git([
      "branch",
      "-r",
      "--list",
      "origin/local-experiment",
    ])
  ).toBe("");
});
