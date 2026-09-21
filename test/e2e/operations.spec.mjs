/**
 * The operations that rewrite history, driven through the UI.
 *
 * Each test photographs the result *and* asserts the resulting git state. The two
 * halves cover different failures: the picture catches a graph that redraws wrong,
 * the git assertions catch a rewrite that lands wrong — and they are what stops a
 * bad picture from being accepted by `just test-e2e-update`. A screenshot alone
 * proves the UI drew something plausible, not that the commits moved.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, reopen, stateOf, test } from "./fixtures/demoRepo.mjs";
import {
  expectLogEntry,
  expectToast,
  selectCommit,
} from "./fixtures/interactions.mjs";

/**
 * The checkbox deciding whether one uncommitted path goes into the next commit.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} path
 */
const pickOf = (page, path) =>
  page.locator("#wc .file", { hasText: path }).locator(".pick");

test("Goto checks out the branch on a commit row", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  const row = smartlog.locator(".row", {
    hasText: "feat(mask): add maskEmail",
  });
  await row.hover();
  await row.locator(".goto-btn").click();
  await expectToast(smartlog, "Checked out mask-utils");

  expect(await demoRepository.git(["symbolic-ref", "--short", "HEAD"])).toBe(
    "mask-utils"
  );
  await snapshot("after-goto-mask-utils");
});

test("Goto on a commit no branch names checks out its sha and reports the detach", async ({
  demoRepository,
  smartlog,
}) => {
  // `feat(case): add camelCase` sits one below the case-utils pill, so no branch reaches it
  // and the sha is the only way there. Reporting the checkout as an ordinary one leaves the
  // reader committing onto a HEAD no branch follows.
  const row = smartlog.locator(".row", {
    hasText: "feat(case): add camelCase",
  });
  await row.hover();
  await expect(row.locator(".goto-btn")).toHaveAttribute(
    "title",
    /leaving HEAD detached$/
  );
  await row.locator(".goto-btn").click();
  await expectToast(smartlog, "HEAD is detached");

  expect(await demoRepository.git(["rev-parse", "HEAD"])).toBe(
    await demoRepository.git(["rev-parse", "case-utils~1"])
  );
  // `--abbrev-ref` answers the literal "HEAD" off a branch, which is the detachment itself.
  expect(await demoRepository.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
    "HEAD"
  );
});

test("Goto refuses a branch another worktree holds, naming the directory", async ({
  demoRepository,
  smartlog,
}) => {
  // Beside the working copy rather than inside it, so the second worktree does not read as
  // an untracked directory and change what the tree draws.
  const held = join(demoRepository.path, "..", "held");
  await demoRepository.git(["worktree", "add", held, "mask-utils"]);
  const before = await demoRepository.git(["rev-parse", "HEAD"]);
  await reopen(smartlog);

  // Git binds a branch to one worktree, so `git switch mask-utils` here fails outright. The
  // row used to let the click through and relay that refusal as a red toast.
  const row = smartlog.locator(".row", {
    hasText: "feat(mask): add maskEmail",
  });
  await row.hover();
  await expect(row.locator(".goto-btn")).toBeDisabled();
  await expect(row.locator(".goto-btn")).toHaveAttribute(
    "title",
    /^mask-utils is checked out in .*held$/
  );

  // Enter runs the same Goto with no button to disable, so the refusal has to be reported.
  await selectCommit(smartlog, "feat(mask): add maskEmail");
  await smartlog.keyboard.press("Enter");
  await expectToast(smartlog, "mask-utils is checked out in");
  expect(await demoRepository.git(["rev-parse", "HEAD"])).toBe(before);
});

/**
 * The invariant the three tests above check one case of each: Goto lands on the commit the
 * row draws, whatever reaches it. Sweeping every row instead of naming them is what makes a
 * new row kind arrive with this covered — the trunk row went a year drawing `origin/main` and
 * checking out a `main` four commits behind it, and no per-case test asked the question of
 * every row.
 *
 * A checkout leaves the graph alone, so the shas read up front stay drawn, and each row is
 * visited once — the row HEAD lands on offers "You are here" instead of a button.
 */
test("Goto lands on the sha its own row draws, for every row that offers it", async ({
  demoRepository,
  smartlog,
}) => {
  // Two pills on one commit, which is the case with nothing to choose between and so detaches
  // instead of checking a branch out. The demo gives every commit at most one branch.
  await demoRepository.git(["branch", "alias", "escape-html"]);
  await reopen(smartlog);

  const offered = await smartlog
    .locator("#tree .row:has(.goto-btn)")
    .evaluateAll(rows =>
      rows.map(row => ({
        sha: row.querySelector(".sha")?.textContent ?? "",
        subject: row.querySelector(".subject")?.textContent ?? "",
      }))
    );
  // A floor rather than a count, since the demo is free to grow rows: nothing else here would
  // notice a locator that stopped matching, and an empty sweep passes every assertion below.
  expect(offered.length).toBeGreaterThan(8);
  expect(offered.map(row => row.sha)).not.toContain("");

  for (const { sha, subject } of offered) {
    const row = smartlog.locator("#tree .row", {
      has: smartlog.locator(`.sha:text-is("${sha}")`),
    });
    await row.hover();
    await row.locator(".goto-btn").click();
    // The tag is the same claim read off the UI, and waiting for it is what makes the git
    // read below land after the checkout rather than during it.
    await expect(row.locator(".youarehere"), subject).toBeVisible();

    const head = await demoRepository.git(["rev-parse", "HEAD"]);
    expect(head.slice(0, sha.length), subject).toBe(sha);
  }
});

test("amending a message rewrites the commit and re-parents its descendants", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  const before = await demoRepository.git(["rev-parse", "trim-utils"]);
  await selectCommit(smartlog, "feat(case): add camelCase");
  await smartlog
    .locator("#msg-subject")
    .fill("feat(case): add camelCase, documented");
  await smartlog.locator("#msg-body").fill("Spell out the casing rules.");
  await smartlog.locator("#btn-amend").click();
  await expectToast(smartlog, "Message amended");

  const subjects = await demoRepository.git([
    "log",
    "--format=%s",
    "-4",
    "trim-utils",
  ]);
  expect(subjects.split("\n")).toEqual([
    "test(pad): cover padStart (local, unpushed)",
    "test(trim): cover collapseWhitespace",
    "feat(trim): add collapseWhitespace",
    "feat(pad): add padStart",
  ]);
  // Every branch above the reworded commit had to move; the whole chain is new.
  expect(await demoRepository.git(["rev-parse", "trim-utils"])).not.toBe(
    before
  );
  expect(
    await demoRepository.git(["log", "--format=%B", "-1", "case-utils~1"])
  ).toContain("Spell out the casing rules.");
  // A message-only rewrite reuses every tree, so the working copy stays clean.
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
  await snapshot("after-amend-message");
});

test("Undo restores the refs the amend moved", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  const before = await demoRepository.git(["rev-parse", "trim-utils"]);
  await selectCommit(smartlog, "feat(case): add camelCase");
  await smartlog
    .locator("#msg-subject")
    .fill("feat(case): add camelCase (undo me)");
  await smartlog.locator("#btn-amend").click();
  await expectToast(smartlog, "Message amended");

  await smartlog.locator("#btn-undo").click();
  await expectToast(smartlog, "Undid Amend message");

  expect(await demoRepository.git(["rev-parse", "trim-utils"])).toBe(before);
  await snapshot("after-undo-amend");
});

test("amending working changes folds them into HEAD", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  await demoRepository.git(["checkout", "escape-html"]);
  await writeFile(
    join(demoRepository.path, "src", "escape.js"),
    "export const escapeHtml = (s) => String(s).replace(/[&<>\"']/g, (c) => c);\n"
  );
  await reopen(smartlog);
  await selectCommit(smartlog, "feat: add escapeHtml");
  await smartlog.locator("#btn-amend-wc").click();
  await expectToast(smartlog, "Working changes amended into HEAD");

  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
  expect(await demoRepository.git(["show", "HEAD:src/escape.js"])).toContain(
    "String(s)"
  );
  await snapshot("after-amend-working-changes");
});

test("folding a commit into the one below combines both messages", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  await smartlog
    .getByText("feat(case): add snakeCase")
    .click({ button: "right" });
  await smartlog.getByText("Fold into the commit below").click();
  await expectToast(smartlog, "Folded into the commit below");

  // Fold keeps the upper commit's tree and the lower commit's identity, so one
  // commit carries both messages and the branch pill stays on case-utils.
  const message = await demoRepository.git([
    "log",
    "--format=%B",
    "-1",
    "case-utils",
  ]);
  expect(message.trim()).toBe(
    "feat(case): add camelCase\n\nfeat(case): add snakeCase"
  );
  expect(
    await demoRepository.git(["show", "case-utils:src/case.js"])
  ).toContain("snakeCase");
  expect(
    await demoRepository.git(["rev-list", "--count", "origin/main..case-utils"])
  ).toBe("1");
  // The sidebar has to follow the rewrite onto the combined commit. Left on the
  // commit that was folded away, its Amend button acts on a sha that is gone.
  await expect(smartlog.locator("#msg-subject")).toHaveValue(
    "feat(case): add camelCase"
  );
  await snapshot("after-fold");
});

test("splitting a commit produces two, with the chosen hunk in the first", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  const treeBefore = await demoRepository.git([
    "rev-parse",
    "wip-titlecase^{tree}",
  ]);
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
  await smartlog
    .locator("#split-msg1")
    .fill("wip(case): note small-word handling TODO");
  await smartlog.locator("#split-msg2").fill("wip(case): trim the result");
  await smartlog.locator("#split-apply").click();
  await expectToast(smartlog, "Split into two commits");

  expect(
    (
      await demoRepository.git(["log", "--format=%s", "-2", "wip-titlecase"])
    ).split("\n")
  ).toEqual([
    "wip(case): trim the result",
    "wip(case): note small-word handling TODO",
  ]);
  // The pair must end exactly where the single commit did, so the branch tip's
  // tree is unchanged and the working copy stays clean.
  expect(await demoRepository.git(["rev-parse", "wip-titlecase^{tree}"])).toBe(
    treeBefore
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
  // The first commit took only the comment line; the trailing `.trim()` is the
  // hunk left for the second.
  expect(
    await demoRepository.git(["show", "wip-titlecase~1:src/titlecase.js"])
  ).not.toContain(".trim()");
  // Split leaves the sidebar on the upper of the two new commits, not on the
  // original — whose sha no longer resolves.
  await expect(smartlog.locator("#msg-subject")).toHaveValue(
    "wip(case): trim the result"
  );
  await snapshot("after-split");
});

test("absorb previews where each change lands, then folds it in", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  // Edit the line `feat(trim): add collapseWhitespace` introduced, so absorb has
  // exactly one commit to attribute the hunk to.
  await writeFile(
    join(demoRepository.path, "src", "trim.js"),
    "export const collapseWhitespace = (s) => s.replace(/\\s+/gu, ' ').trim();\n"
  );
  await reopen(smartlog);
  await smartlog.locator("#btn-absorb").click();
  await smartlog.waitForSelector("#btn-absorb-apply");
  // The preview panel alone: its whole point is showing which commit each hunk
  // lands in, and a full-page shot would fail on any unrelated change to the graph.
  await snapshot("absorb-preview", { locator: smartlog.locator("#wc") });

  await smartlog.locator("#btn-absorb-apply").click();
  await expectToast(smartlog, "Absorbed 1 change");

  // The change is now in the commit that owns the line, not in the working copy.
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
  expect(
    await demoRepository.git(["show", "trim-utils~2:src/trim.js"])
  ).toContain("/\\s+/gu");
  await snapshot("after-absorb");
});

test("committing takes the ticked changes and leaves the rest in the working copy", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(join(demoRepository.path, "src", "trim.js"), "// picked\n");
  await writeFile(join(demoRepository.path, "LEFTOVER.md"), "not this one\n");
  await reopen(smartlog);

  // Untick the second file: the point of the checkboxes is that the commit takes a
  // subset, and a test that commits everything would not tell the two apart.
  await pickOf(smartlog, "LEFTOVER.md").click();
  await expect(smartlog.locator("#wc-selcount")).toHaveText("1 of 2 selected");
  await smartlog.locator("#btn-commit").click();
  await smartlog
    .locator("#commit-subject")
    .fill("feat(trim): rewrite collapse");
  await smartlog.locator("#commit-body").fill("Because the old one was wrong.");
  await snapshot("commit-form", { locator: smartlog.locator("#wc") });

  await smartlog.locator("#btn-commit-do").click();
  await expectToast(smartlog, "Committed 1 change");

  // The subject and body land as git's own subject and body, and only the ticked
  // path is in the commit.
  expect(await demoRepository.git(["log", "-1", "--format=%s"])).toBe(
    "feat(trim): rewrite collapse"
  );
  expect(await demoRepository.git(["log", "-1", "--format=%b"])).toContain(
    "Because the old one was wrong."
  );
  expect(
    await demoRepository.git(["show", "--name-only", "--format=", "HEAD"])
  ).toBe("src/trim.js");
  // The unticked file is untouched — still untracked, neither committed nor deleted.
  expect(await demoRepository.git(["status", "--porcelain"])).toBe(
    "?? LEFTOVER.md"
  );
  await snapshot("after-commit");
});

test("Commit stays dead until the summary carries something", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(join(demoRepository.path, "src", "trim.js"), "// picked\n");
  await reopen(smartlog);
  await smartlog.locator("#btn-commit").click();

  // git refuses a commit with no message, so the alternative to a dead button is a red toast
  // for a form the reader has not filled in yet.
  await expect(smartlog.locator("#btn-commit-do")).toBeDisabled();
  // Whitespace is not a summary either: a paste of spaces used to enable the button and then
  // reach git, which rejected it.
  await smartlog.locator("#commit-subject").fill("   ");
  await expect(smartlog.locator("#btn-commit-do")).toBeDisabled();
  await smartlog
    .locator("#commit-subject")
    .fill("feat(trim): rewrite collapse");
  await expect(smartlog.locator("#btn-commit-do")).toBeEnabled();
});

test("discarding one file restores it and leaves the change beside it alone", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  const trimPath = join(demoRepository.path, "src", "trim.js");
  const committed = await readFile(trimPath, "utf8");
  await writeFile(trimPath, "// thrown\n");
  await writeFile(join(demoRepository.path, "KEEP.md"), "not this one\n");
  await reopen(smartlog);

  const row = smartlog.locator("#wc .file", { hasText: "src/trim.js" });
  // Hidden until the pointer is on the row, like the sidebar's openers: an always-visible
  // delete control on every row of a list a reader scans is one slip away from data loss.
  await expect(row.locator(".iconbtn.discard")).toBeHidden();
  await row.hover();
  await row.locator(".iconbtn.discard").click();
  await snapshot("discard-confirm", { locator: smartlog.locator("#wc") });

  // Cancel is the half worth testing first: a confirmation that discards anyway is worse than
  // no confirmation, because the reader trusted it.
  await smartlog.locator("#btn-discard-cancel").click();
  await expect(smartlog.locator("#discard-confirm")).toBeEmpty();
  expect(await readFile(trimPath, "utf8")).toBe("// thrown\n");

  await row.hover();
  await row.locator(".iconbtn.discard").click();
  await smartlog.locator("#btn-discard-do").click();
  await expectToast(smartlog, "Discarded src/trim.js");

  // Back to the committed content, and the untracked file still untracked: a per-file button
  // whose blast radius is the whole working copy is the failure this catches.
  expect(await readFile(trimPath, "utf8")).toBe(committed);
  expect(await demoRepository.git(["status", "--porcelain"])).toBe(
    "?? KEEP.md"
  );
  await snapshot("after-discard");
});

test("discarding an untracked file says it deletes the file, and deletes it", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(join(demoRepository.path, "SCRATCH.md"), "scratch\n");
  await reopen(smartlog);

  const row = smartlog.locator("#wc .file", { hasText: "SCRATCH.md" });
  await row.hover();
  await row.locator(".iconbtn.discard").click();
  // The wording carries the whole difference between the two outcomes, and no commit holds a
  // version of this path to go back to.
  await expect(smartlog.locator("#discard-confirm")).toContainText(
    "The file is deleted"
  );

  await smartlog.locator("#btn-discard-do").click();
  await expectToast(smartlog, "Deleted SCRATCH.md");
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
});

test("amending into a commit below HEAD folds the change in and carries the stack", async ({
  demoRepository,
  smartlog,
}) => {
  // parse-dates sits above parse-utils, so parse-utils is an ancestor of HEAD —
  // the case where folding down is meaningful.
  await demoRepository.git(["checkout", "parse-dates"]);
  const before = await demoRepository.git(["rev-parse", "parse-dates"]);
  await writeFile(
    join(demoRepository.path, "src", "strip.js"),
    "// folded down\n"
  );
  await reopen(smartlog);

  await smartlog.getByText("feat(parse): add parseList").click();
  // The button names its destination, so the click is not a guess.
  await expect(smartlog.locator("#btn-amend-into")).toContainText("add parseL");
  await smartlog.locator("#btn-amend-into").click();
  await expectToast(smartlog, "Amended into");

  // The change is in the target and gone from the working copy — the two halves that
  // together mean it moved rather than being copied.
  expect(await demoRepository.git(["show", "parse-utils:src/strip.js"])).toBe(
    "// folded down"
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
  // The descendant followed the rewrite and sees the folded content. Reusing its old
  // tree here would have reverted the amend one row up.
  expect(await demoRepository.git(["rev-parse", "parse-dates"])).not.toBe(
    before
  );
  expect(await demoRepository.git(["show", "parse-dates:src/strip.js"])).toBe(
    "// folded down"
  );
});

test("amending into a commit off the checked-out stack is refused, changing nothing", async ({
  demoRepository,
  smartlog,
}) => {
  // parse-utils and parse-numbers are siblings: neither is an ancestor of the other.
  // Grafting sideways used to leave the change in the commit *and* in the working
  // copy, so this asserts the refusal rather than the corruption.
  await demoRepository.git(["checkout", "parse-utils"]);
  const before = await demoRepository.git(["rev-parse", "parse-numbers"]);
  await writeFile(
    join(demoRepository.path, "src", "strip.js"),
    "// nowhere to go\n"
  );
  await reopen(smartlog);

  await smartlog.getByText("feat(parse): add parseNumbers").click();
  await smartlog.locator("#btn-amend-into").click();
  await expectToast(smartlog, "not in the stack you have checked out");

  expect(await demoRepository.git(["rev-parse", "parse-numbers"])).toBe(before);
  expect(await demoRepository.git(["status", "--porcelain"])).toBe(
    " M src/strip.js"
  );
});

test("rebasing a stack onto trunk moves every branch in it", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  const trunkTip = await demoRepository.git(["rev-parse", "origin/main"]);
  await smartlog
    .getByText("feat(case): add camelCase")
    .click({ button: "right" });
  // The whole case-utils → pad-utils → trim-utils chain plus the local-experiment
  // fork moves with it, which the menu label counts out.
  await smartlog
    .getByText(/^Rebase this commit \+ 6 above onto origin\/main$/)
    .click();
  await expectToast(smartlog, "Rebased case-utils");

  // One rebase per linear chain, and local-experiment forks off pad-utils — so
  // the fork's marker ref has to land it on the rewritten pad-utils, not the old one.
  expect(await demoRepository.git(["rev-parse", "case-utils~2"])).toBe(
    trunkTip
  );
  expect(await demoRepository.git(["rev-parse", "pad-utils"])).toBe(
    await demoRepository.git(["rev-parse", "local-experiment~1"])
  );
  expect(await demoRepository.git(["rev-parse", "pad-utils"])).toBe(
    await demoRepository.git(["rev-parse", "trim-utils~3"])
  );
  // Markers are scratch refs; leaving one behind would draw a bogus branch pill.
  expect(
    await demoRepository.git([
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/gsm-rebase",
    ])
  ).toBe("");
  await snapshot("after-rebase-stack");
});

test("Restack all stacks onto trunk lands every local stack on the trunk tip", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  // truncate-words is built to conflict with trunk, which is the next test.
  // Dropping it here isolates the all-clean path.
  await demoRepository.git(["branch", "-D", "truncate-words"]);
  const trunkTip = await demoRepository.git(["rev-parse", "origin/main"]);
  await reopen(smartlog);
  await smartlog.locator("#btn-restack").click();
  await expectToast(smartlog, "Restacked:");

  // Every stack bottom now sits directly on the tip, so nothing is hidden between
  // the trunk row and the stacks above it.
  for (const bottom of [
    "case-utils~1",
    "mask-utils",
    "parse-utils",
    "escape-html",
    "wip-titlecase~1",
    "fix-slugify-unicode~1",
  ]) {
    expect(await demoRepository.git(["rev-parse", `${bottom}^`])).toBe(
      trunkTip
    );
  }
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
  await snapshot("after-restack");
});

test("Restack stops on the branch that conflicts with trunk", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  await smartlog.locator("#btn-restack").click();
  await smartlog.waitForSelector("#conflict.open");
  await expectToast(smartlog, "Restack stopped on a conflict");

  expect(await demoRepository.git(["status", "--porcelain"])).toContain(
    "UU src/truncate.js"
  );
  await snapshot("restack-conflict");
});

test("a conflicting rebase stops with the banner, and aborting restores the commits", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  const before = await demoRepository.git(["rev-parse", "truncate-words"]);
  // truncate-words and trunk both rewrite the same line of src/truncate.js.
  await smartlog
    .getByText("feat(truncate): break at word boundaries")
    .click({ button: "right" });
  await smartlog.getByText(/^Rebase this commit onto origin\/main$/).click();
  await smartlog.waitForSelector("#conflict.open");
  expect(await demoRepository.git(["status", "--porcelain"])).toContain(
    "UU src/truncate.js"
  );
  await snapshot("rebase-conflict");

  await smartlog.locator("#btn-abort").click();
  await expectToast(smartlog, "Rebase aborted");

  expect(await demoRepository.git(["rev-parse", "truncate-words"])).toBe(
    before
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
  await snapshot("after-rebase-abort");
});

test("resolving a conflict and continuing finishes the rebase", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  const trunkTip = await demoRepository.git(["rev-parse", "origin/main"]);
  await smartlog
    .getByText("feat(truncate): break at word boundaries")
    .click({ button: "right" });
  await smartlog.getByText(/^Rebase this commit onto origin\/main$/).click();
  await smartlog.waitForSelector("#conflict.open");

  await writeFile(
    join(demoRepository.path, "src", "truncate.js"),
    "export const truncate = (s, n, suffix = '…') => s.length > n ? s.slice(0, s.lastIndexOf(' ', n)) + suffix : s;\n"
  );
  await smartlog.locator("#btn-continue").click();
  await expectToast(smartlog, "Rebase finished");

  expect(await demoRepository.git(["rev-parse", "truncate-words^"])).toBe(
    trunkTip
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
  await snapshot("after-rebase-continue");
});

test("a continue git refuses re-arms the button for a second attempt", async ({
  demoRepository,
  smartlog,
}) => {
  const trunkTip = await demoRepository.git(["rev-parse", "origin/main"]);
  await smartlog
    .getByText("feat(truncate): break at word boundaries")
    .click({ button: "right" });
  await smartlog.getByText(/^Rebase this commit onto origin\/main$/).click();
  await smartlog.waitForSelector("#conflict.open");

  // Continue with the markers git wrote still in the file, which is what pressing the button
  // too early does. The banner used to latch "Continuing…" on the first press, so a reload
  // was the only way to reach a second attempt.
  await smartlog.locator("#btn-continue").click();
  await expectToast(smartlog, "Conflict markers still in src/truncate.js");
  await expect(smartlog.locator("#btn-continue")).toBeEnabled();

  await writeFile(
    join(demoRepository.path, "src", "truncate.js"),
    "export const truncate = (s, n, suffix = '…') => s.length > n ? s.slice(0, s.lastIndexOf(' ', n)) + suffix : s;\n"
  );
  await smartlog.locator("#btn-continue").click();
  await expectToast(smartlog, "Rebase finished");

  expect(await demoRepository.git(["rev-parse", "truncate-words^"])).toBe(
    trunkTip
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe("");
});

test("every working-copy action is dead while a conflict is unresolved", async ({
  demoRepository,
  smartlog,
}) => {
  await smartlog
    .getByText("feat(truncate): break at word boundaries")
    .click({ button: "right" });
  await smartlog.getByText(/^Rebase this commit onto origin\/main$/).click();
  await smartlog.waitForSelector("#conflict.open");

  // The unmerged file is listed as an uncommitted change, so the working-copy actions are
  // live buttons pointed at a half-applied rebase. Absorb was the one still enabled: it
  // rewrites the commits the rebase is in the middle of replaying.
  await expect(smartlog.locator("#wc .file")).toContainText("src/truncate.js");
  for (const button of ["#btn-absorb", "#btn-commit", "#btn-amend-into"]) {
    await expect(smartlog.locator(button)).toBeDisabled();
  }
  expect(await demoRepository.git(["status", "--porcelain"])).toContain(
    "UU src/truncate.js"
  );
});

test("Refresh repository re-reads local git state and logs the commands it ran", async ({
  demoRepository,
  smartlog,
  snapshot,
}) => {
  // Committed outside the UI, so a refresh is what brings the new row in.
  await demoRepository.git(["checkout", "escape-html"]);
  await demoRepository.git([
    "commit",
    "--allow-empty",
    "-m",
    "chore: added behind the UI's back",
  ]);
  await smartlog.locator("#btn-refresh").click();
  await expectLogEntry(smartlog, "Refresh repository");
  await expect(
    smartlog.getByText("chore: added behind the UI's back")
  ).toBeVisible();
  await snapshot("after-refresh");
});

/**
 * What a re-read must not destroy.
 *
 * Refresh runs the same `loadModel` the browser host's five-second poll runs, so this is that
 * poll landing mid-sentence — the case the suite otherwise cannot reach, since the fixture
 * stubs `setInterval` out. Three separate pieces of state ride through it: the commit form's
 * draft, the panel editor's draft in a component the parent keys on the sha, and the ticks
 * `syncSelection` reconciles against what git now reports. Each was destroyed by a poll at
 * some point, and the commit was then refused for having no summary.
 */
test("a re-read keeps a half-typed message and the ticks the reader set", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(join(demoRepository.path, "src", "trim.js"), "// edited\n");
  await writeFile(join(demoRepository.path, "KEEP.md"), "not this one\n");
  await reopen(smartlog);

  // Untick one of the two, so the reconcile has a choice to preserve rather than a default to
  // land on.
  await pickOf(smartlog, "KEEP.md").click();
  await smartlog.locator("#btn-commit").click();
  await smartlog.locator("#commit-subject").fill("fix(trim): halfway through");
  await smartlog.locator("#commit-body").fill("Still writing this.");
  await selectCommit(smartlog, "feat(trim): add collapseWhitespace");
  await smartlog.locator("#msg-subject").fill("feat(trim): renamed, not saved");

  // A third file, dirty since the last read: a path git reports for the first time arrives
  // ticked, which is the other half of the same reconcile.
  await writeFile(join(demoRepository.path, "NEW.md"), "arrived late\n");
  await smartlog.locator("#btn-refresh").click();
  await expectLogEntry(smartlog, "Refresh repository");
  await expect(smartlog.locator("#wc .file")).toHaveCount(3);

  await expect(smartlog.locator("#commit-subject")).toHaveValue(
    "fix(trim): halfway through"
  );
  await expect(smartlog.locator("#commit-body")).toHaveValue(
    "Still writing this."
  );
  await expect(smartlog.locator("#msg-subject")).toHaveValue(
    "feat(trim): renamed, not saved"
  );
  await expect(pickOf(smartlog, "KEEP.md")).not.toBeChecked();
  await expect(pickOf(smartlog, "src/trim.js")).toBeChecked();
  await expect(pickOf(smartlog, "NEW.md")).toBeChecked();
});

/**
 * Every way out of an action, and what none of them may leave behind.
 *
 * A cancel is the one path with no result to check, so each was written and then never
 * exercised — and the failure it hides is the shape the conflict banner's own latch had: a
 * flag set on the way in and cleared nowhere, which leaves the action's button dead for the
 * rest of the session. Absorb is the case worth naming: its preview has already run git to
 * build the plan, so cancelling it is a claim about a command that did run.
 */
test("cancelling an action closes its panel and leaves the repository alone", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "trim-utils"]);
  await writeFile(
    join(demoRepository.path, "src", "trim.js"),
    "export const collapseWhitespace = (s) => s.replace(/\\s+/gu, ' ').trim();\n"
  );
  await reopen(smartlog);
  const before = await stateOf(demoRepository);

  await smartlog.locator("#btn-absorb").click();
  await smartlog.waitForSelector("#btn-absorb-apply");
  await smartlog.locator("#btn-absorb-cancel").click();
  await expect(smartlog.locator("#btn-absorb-apply")).toHaveCount(0);
  await expect(smartlog.locator("#btn-absorb")).toBeEnabled();

  await smartlog.locator("#btn-commit").click();
  await smartlog.locator("#commit-subject").fill("fix(trim): not this time");
  await smartlog.locator("#btn-commit-cancel").click();
  await expect(smartlog.locator("#commit-form")).toBeHidden();
  await expect(smartlog.locator("#btn-commit")).toBeEnabled();

  await smartlog
    .getByText("wip(case): note small-word handling TODO")
    .click({ button: "right" });
  await smartlog.getByText("Split into two commits…").click();
  await smartlog.waitForSelector("#split-panel .hunk");
  await smartlog.locator("#split-cancel").click();
  await expect(smartlog.locator("#split-cancel")).toHaveCount(0);

  // The read-only overlay closes by Escape in `sidebar.spec.mjs`; this is its button.
  await selectCommit(smartlog, "wip(case): note small-word handling TODO");
  await smartlog.locator("#btn-view-changes").click();
  await expect(smartlog.locator("#changes.open")).toBeVisible();
  await smartlog.locator("#btn-changes-close").click();
  await expect(smartlog.locator("#changes.open")).toBeHidden();
  await expect(smartlog.locator("#sidebar.open")).toBeVisible();

  expect(await stateOf(demoRepository)).toEqual(before);
});

test("Goto on the trunk row lands on the commit it draws, by way of the local branch", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "parse-utils"]);
  const trunkTip = await demoRepository.git(["rev-parse", "origin/main"]);
  await reopen(smartlog);

  // The row displays `origin/main`, and switching to that would detach HEAD — which is not
  // what "go to main" means, so the button carries the local branch tracking it. The demo's
  // `main` is four commits behind that ref, and checking it out alone put the reader on a
  // commit this row never named: "You are here" four rows down, on a fork base.
  const trunkRow = smartlog.locator(".row", {
    has: smartlog.locator(".trunkpill"),
  });
  await trunkRow.hover();
  await trunkRow.locator(".goto-btn").click();
  await expectToast(smartlog, "Checked out main, 4 commits forward");

  expect(await demoRepository.git(["rev-parse", "HEAD"])).toBe(trunkTip);
  // `symbolic-ref` fails on a detached HEAD, so this is what proves the fast-forward moved
  // the branch rather than parking HEAD on the ref.
  expect(await demoRepository.git(["symbolic-ref", "--short", "HEAD"])).toBe(
    "main"
  );
  await expect(trunkRow.locator(".youarehere")).toBeVisible();
});
