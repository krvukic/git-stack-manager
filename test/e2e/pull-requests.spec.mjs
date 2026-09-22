/**
 * Pull request badges: asserted, never photographed.
 *
 * A badge is four independent facts crammed into eleven pixels of monospace — number,
 * state, CI rollup, review decision — and a picture proves only that something small and
 * coloured appeared. The colour is the whole signal: a green tick where a red cross belongs
 * is the defect these guard, and it is a class name, not a shape.
 *
 * The data behind them is the stand-in `gh` in the `fakeGitHub` fixture, whose comment
 * records why each pull request looks the way it does. Read the two together: the fixture
 * records what GitHub answered, these record what the tree drew.
 */
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";
import { expectToast, selectCommit } from "./fixtures/interactions.mjs";

/**
 * @typedef {object} PullRequestBadge
 * @property {string} number
 * @property {string} state
 * @property {string | null} checks
 * @property {string | null} checksGlyph
 * @property {string | null} reviewGlyph
 * @property {string} url
 * @property {string} title
 */

/**
 * Map each branch pill in the tree to the pull request badge beside it.
 *
 * `branchHtml` emits a pill and its badges as flat siblings, so a branch owns every
 * badge between its own pill and the next one — which is how a row carrying two
 * branches stays unambiguous. Read in one page call rather than as locators because
 * every assertion below is about a class or a glyph, and going back over the
 * protocol for each would turn one read into thirty.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} [root]
 * @returns {Promise<Record<string, PullRequestBadge>>}
 */
async function pullRequestBadges(page, root = "#tree") {
  return page.evaluate(selector => {
    /** @type {Record<string, PullRequestBadge>} */
    const found = {};
    for (const pill of Array.from(
      document.querySelectorAll(selector + " .pill")
    )) {
      /** @type {HTMLElement | null} */
      let badge = null;
      for (
        let sibling = pill.nextElementSibling;
        sibling && !sibling.classList.contains("pill");
        sibling = sibling.nextElementSibling
      ) {
        if (sibling.classList.contains("prbadge")) {
          badge = /** @type {HTMLElement} */ (sibling);
        }
      }
      if (!badge) {
        continue;
      }
      const checks = /** @type {HTMLElement} */ (badge.querySelector(".ci"));
      const review = /** @type {HTMLElement} */ (
        badge.querySelector(".review")
      );
      // Empty strings for the `data-` reads: a badge that rendered without one is a
      // real failure, and `""` fails the assertion that names the expected value,
      // where `undefined` would fail the property read instead.
      found[pill.textContent ?? ""] = {
        // The number leads the badge's text, and the glyphs follow it.
        number: (badge.textContent ?? "").trim().split(/\s+/)[0] ?? "",
        // Read from `data-`, not from the class list. The state used to be inferred as
        // "whichever class is not `prbadge`", which stopped meaning anything once the
        // styling moved into utility classes on the same element.
        state: badge.dataset.prState ?? "",
        checks: checks ? (checks.dataset.ciState ?? null) : null,
        checksGlyph: checks ? checks.textContent : null,
        reviewGlyph: review ? review.textContent : null,
        url: badge.dataset.prUrl ?? "",
        title: badge.title,
      };
    }
    return found;
  }, root);
}

/**
 * The badge beside `branch`, failing with the branches that do have one.
 *
 * A missing entry has two causes that need opposite responses: the badge did not
 * render, or the demo generator no longer produces that branch. Reading the key
 * directly reports both as "cannot read property of undefined", and the generator is
 * edited far more often than the badge code is — so listing what was drawn turns a
 * renamed branch into a one-line diagnosis.
 *
 * @param {Record<string, PullRequestBadge>} badges
 * @param {string} branch
 */
function badgeFor(badges, branch) {
  const badge = badges[branch];
  if (!badge) {
    throw new Error(
      `No pull request badge beside a "${branch}" pill. Branches drawn with one: ` +
        `${Object.keys(badges).join(", ") || "none"}. If the demo generator no longer ` +
        `creates ${branch}, retarget this assertion — the canned pull requests in ` +
        `fixtures/demoRepo.mjs are keyed by branch name.`
    );
  }
  return badge;
}

test("each pull request state gets its own badge", async ({ smartlog }) => {
  const badges = await pullRequestBadges(smartlog);

  // The state class is what paints the badge, and `draft` is the one that is not a
  // GitHub state at all: GitHub calls a draft OPEN and flags it separately, so a
  // badge reading `open` for pad-utils would be losing the flag rather than mixing
  // up two colours.
  expect(badgeFor(badges, "trim-utils")).toMatchObject({
    number: "#206",
    state: "open",
  });
  expect(badgeFor(badges, "pad-utils")).toMatchObject({
    number: "#205",
    state: "draft",
  });
  expect(badgeFor(badges, "case-utils")).toMatchObject({
    number: "#198",
    state: "open",
  });
  expect(badgeFor(badges, "local-experiment")).toMatchObject({
    number: "#173",
    state: "closed",
  });
  expect(badgeFor(badges, "fix-slugify-unicode")).toMatchObject({
    number: "#142",
    state: "merged",
  });

  // The tooltip is where the state is spelled out, and the only place a draft says
  // so in words.
  expect(badgeFor(badges, "pad-utils").title).toContain("open (draft)");
  expect(badgeFor(badges, "fix-slugify-unicode").title).toContain("merged");
  expect(badgeFor(badges, "fix-slugify-unicode").title).toContain(
    "fix(slugify): strip diacritics so accented input slugifies"
  );
});

test("the CI rollup lets the worst check decide the badge", async ({
  smartlog,
}) => {
  const badges = await pullRequestBadges(smartlog);

  // One red job among two green ones. A rollup that took the majority, the first
  // entry, or the last would all read green here.
  expect(badgeFor(badges, "case-utils")).toMatchObject({
    checks: "failure",
    checksGlyph: "✗",
  });
  expect(badgeFor(badges, "case-utils").title).toContain("checks: failure");

  // Same red badge by the other route through the collapsing logic: a legacy commit
  // status carries `state`, not `conclusion`, and calls a broken run ERROR.
  expect(badgeFor(badges, "parse-dates")).toMatchObject({
    number: "#191",
    checks: "failure",
  });

  // A queued job beside a green one is not yet a pass, so pending outranks success.
  expect(badgeFor(badges, "pad-utils")).toMatchObject({
    checks: "pending",
    checksGlyph: "●",
  });
  expect(badgeFor(badges, "pad-utils").title).toContain("checks: pending");

  // Green, despite a skipped job: a mostly-skipped workflow must not read as
  // perpetually pending.
  expect(badgeFor(badges, "trim-utils")).toMatchObject({
    checks: "success",
    checksGlyph: "✓",
  });

  // A cancelled check is the whole rollup here, and it counts as neither outcome —
  // so the badge shows no CI glyph rather than inventing one.
  expect(badgeFor(badges, "local-experiment").checks).toBeNull();
  expect(badgeFor(badges, "local-experiment").title).not.toContain("checks:");
  // And a pull request GitHub ran no checks for at all.
  expect(badgeFor(badges, "fix-slugify-unicode").checks).toBeNull();
});

test("the review decision shows beside the checks", async ({ smartlog }) => {
  const badges = await pullRequestBadges(smartlog);

  // Approved and passing both draw a tick, in two elements: `.review` and `.ci`. The
  // pair is why the glyph alone cannot be trusted as an assertion.
  expect(badgeFor(badges, "trim-utils").reviewGlyph).toBe("✓");
  expect(badgeFor(badges, "trim-utils").title).toContain("review: approved");

  // A distinct glyph, in the same `.review` span as the tick above — so a badge that
  // hard-coded one symbol per span would pass the approved case and fail here.
  expect(badgeFor(badges, "case-utils").reviewGlyph).toBe("↻");
  expect(badgeFor(badges, "case-utils").title).toContain(
    "review: changes requested"
  );

  expect(badgeFor(badges, "pad-utils").reviewGlyph).toBe("○");
  expect(badgeFor(badges, "pad-utils").title).toContain(
    "review: review required"
  );

  // No decision recorded, so no glyph and no tooltip clause — not an empty span.
  expect(badgeFor(badges, "local-experiment").reviewGlyph).toBeNull();
  expect(badgeFor(badges, "local-experiment").title).not.toContain("review:");
});

test("a branch that has carried several pull requests badges the one that still counts", async ({
  smartlog,
}) => {
  const badges = await pullRequestBadges(smartlog);

  // case-utils has a closed #204 and an open #198, and GitHub lists the closed one
  // first. fix-slugify-unicode has no open pull request, so the newest of its two
  // closed-or-merged ones wins — and GitHub lists that one first. Taking whichever
  // entry arrived first satisfies one of these and fails the other; so does taking
  // the last.
  expect(badgeFor(badges, "case-utils").number).toBe("#198");
  expect(badgeFor(badges, "case-utils").url).toContain("/pull/198");
  expect(badgeFor(badges, "fix-slugify-unicode").number).toBe("#142");
});

test("a branch with no pull request stays unannotated", async ({
  smartlog,
}) => {
  const badges = await pullRequestBadges(smartlog);

  // Never-submitted branches, whose sync badge already says so; a pull request badge
  // here would be claiming something GitHub never reported. Read straight off the map
  // rather than through `badgeFor`, whose whole job is to fail on a missing entry.
  for (const branch of [
    "escape-html",
    "mask-utils",
    "redact-utils",
    "wip-titlecase",
  ]) {
    expect(badges[branch]).toBeUndefined();
  }
  // And the stale record: the stand-in answers with a merged pull request for a
  // branch this repository does not have, which must not surface anywhere.
  const rendered = await smartlog.locator("#tree").innerHTML();
  expect(rendered).not.toContain("/pull/189");
  expect(rendered).not.toContain("add-words");
});

test("clicking a badge opens that pull request, and the sidebar's badge does too", async ({
  smartlog,
}) => {
  // Intercepted rather than allowed through: the server's `openUrl` hands the URL to
  // `xdg-open`, so an unrouted click would launch a real browser on the machine
  // running the suite.
  /** @type {string[]} */
  const opened = [];
  await smartlog.route("**/api/openUrl", async route => {
    opened.push(JSON.parse(route.request().postData() ?? "{}").url);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  const badges = await pullRequestBadges(smartlog);
  // Clicked by the URL the badge beside the case-utils pill carries, so the
  // assertion covers the association as well as the click: a badge wired to the
  // neighbouring branch's pull request would open #206 or #205 here.
  await smartlog
    .locator(
      `#tree .prbadge[data-pr-url="${badgeFor(badges, "case-utils").url}"]`
    )
    .click();
  await expect
    .poll(() => opened)
    .toEqual(["https://github.com/example/strkit/pull/198"]);

  // The sidebar renders the same badges through a second call to
  // `wirePullRequestLinks`, so a click there has to reach the same place.
  await selectCommit(smartlog, "feat(case): add snakeCase");
  const sidebarBadges = await pullRequestBadges(smartlog, "#sidebar");
  expect(badgeFor(sidebarBadges, "case-utils")).toMatchObject({
    number: "#198",
    state: "open",
  });
  await smartlog.locator("#sidebar .prbadge").click();
  await expect.poll(() => opened).toHaveLength(2);
  expect(opened[1]).toBe("https://github.com/example/strkit/pull/198");
});

test("Submit offers to update the pull request a branch already has", async ({
  smartlog,
}) => {
  // The label and tooltip that only exist once a branch has a pull request. Reachable
  // for the first time here; the create-path wording is covered in `submit.spec.mjs`.
  // Nothing is clicked — this is the sidebar's reading of cached status, not a push.
  await selectCommit(smartlog, "feat(case): add snakeCase");
  await expect(smartlog.locator("#btn-submit")).toHaveText("Submit → #198");
  await expect(smartlog.locator("#btn-submit")).toHaveAttribute(
    "title",
    /Push case-utils and update pull request #198/
  );
});

test("deleting merged branches takes only a branch still at the merged commit, and Undo keeps it back", async ({
  smartlog,
  demoRepository,
}) => {
  const pill = smartlog.locator("#tree .pill", {
    hasText: /^fix-slugify-unicode$/,
  });
  const exists = async () =>
    (
      await demoRepository.git([
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/fix-slugify-unicode",
      ])
    ).trim() !== "";

  await smartlog.locator("#btn-config").click();
  await smartlog
    .locator('#seg-deletemerged button[data-deletemerged="on"]')
    .click();
  await smartlog.locator("#btn-config-close").click();

  // #142 merged the commit that was pushed, and the branch was amended afterwards, so it
  // holds work the pull request never had.
  await reopen(smartlog);
  await expect(pill).toHaveCount(1);
  expect(await exists()).toBe(true);

  // Dropping the amend leaves the branch at exactly what merged.
  await demoRepository.git([
    "branch",
    "-f",
    "fix-slugify-unicode",
    "origin/fix-slugify-unicode",
  ]);
  await reopen(smartlog);
  await expectToast(smartlog, "Deleted merged branch fix-slugify-unicode");
  await expect(pill).toHaveCount(0);
  expect(await exists()).toBe(false);
  await expect(smartlog.locator("#btn-undo")).toHaveAttribute(
    "title",
    /Delete merged branches/
  );

  await smartlog.locator("#btn-undo").click();
  await expect(pill).toHaveCount(1);
  // The setting is still on, and a reload starts the page afresh, yet the branch Undo
  // restored stays.
  await reopen(smartlog);
  await expect(pill).toHaveCount(1);
  expect(await exists()).toBe(true);
});
