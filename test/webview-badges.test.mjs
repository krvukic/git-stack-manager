/**
 * What a branch pill's badges say.
 *
 * The end-to-end suite asserts the badges the demo repository happens to produce; these
 * cover the branches of the logic it cannot reach, and the wording, which is the part a
 * reader actually acts on. The precedence rules are the valuable ones: each `if` here
 * shadows the ones below it, so a reordering that looks harmless changes what a diverged
 * branch reports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pullRequestBadge,
  stackBadges,
  syncBadge,
  trunkBehindBadge,
} from "../src/webview/model/badges.mts";
import { present } from "./present.mjs";

/** @typedef {import("#github/pullRequests").PullRequestStatus} PullRequestStatus */

const SYNCED = {
  name: "b",
  upstream: "origin/b",
  ahead: 0,
  behind: 0,
  gone: false,
};

/**
 * @param {Partial<PullRequestStatus>} [fields]
 * @returns {PullRequestStatus}
 */
function pullRequest(fields = {}) {
  return {
    number: 42,
    url: "https://example.test/pull/42",
    title: "Example",
    state: "OPEN",
    isDraft: false,
    checks: null,
    reviewDecision: null,
    ...fields,
  };
}

/**
 * Both badge builders return null only for a null input, and every case below passes a
 * branch or a pull request — so these narrow once here rather than at each assertion. The
 * two "no input, no badge" tests call the real functions directly.
 *
 * @param {Parameters<typeof syncBadge>[0]} sync
 * @param {Parameters<typeof syncBadge>[1]} [pullRequest]
 * @param {Parameters<typeof syncBadge>[2]} [tracksTrunk]
 */
const sync = (sync, pullRequest = null, tracksTrunk = false) =>
  present(syncBadge(sync, pullRequest, tracksTrunk), "a sync badge");

/** @param {Parameters<typeof pullRequestBadge>[0]} pullRequest */
const badgeFor = pullRequest =>
  present(pullRequestBadge(pullRequest), "a pull request badge");

test("a branch with no sync information gets no badge", () => {
  assert.equal(syncBadge(null, null), null);
});

test("a branch in sync says so rather than staying silent", () => {
  const badge = sync(SYNCED);
  assert.equal(badge.variant, "synced");
  assert.equal(badge.label, "submitted");
});

test("a never-pushed branch reads as not submitted", () => {
  const badge = sync({ ...SYNCED, upstream: null });
  assert.equal(badge.variant, "unpushed");
  assert.equal(badge.label, "not submitted");
});

/**
 * The rule that keeps Sapling and `gh stack` branches honest. They push under a
 * server-side name of their own, so no local upstream exists — and "not submitted"
 * beside a merged pull request is simply wrong.
 */
test("a missing upstream reads as no local upstream once the branch has a pull request", () => {
  const badge = sync(
    { ...SYNCED, upstream: null },
    pullRequest({ number: 26403, state: "MERGED" })
  );
  assert.equal(badge.label, "no local upstream");
  assert.match(badge.description, /26403/);
});

test("a deleted remote branch is reported as gone, naming the upstream", () => {
  const badge = sync({ ...SYNCED, gone: true });
  assert.equal(badge.variant, "gone");
  assert.equal(badge.label, "upstream gone");
  assert.match(badge.description, /origin\/b/);
});

/**
 * Divergence is checked before either single-sided case, so a branch that is both ahead
 * and behind reports both counts. Testing `ahead` first would report "3 unsubmitted" and
 * lose the fact that the remote moved too.
 */
test("a diverged branch counts both sides, local first", () => {
  const badge = sync({ ...SYNCED, ahead: 3, behind: 1 });
  assert.equal(badge.variant, "diverged");
  assert.equal(badge.label, "diverged 3↑1↓ vs origin/b");
});

test("ahead and behind each get their own wording", () => {
  assert.equal(
    sync({ ...SYNCED, ahead: 2 }).label,
    "2 unsubmitted to origin/b"
  );
  assert.equal(sync({ ...SYNCED, behind: 5 }).label, "5 behind origin/b");
});

/**
 * Every count names what it was counted against. Without it, the arrows on a branch that
 * tracks trunk read as lost work: `1↑32↓` says nothing about the other side being
 * origin/main until the label does.
 */
test("a count always names the ref it was measured against", () => {
  const labels = [
    sync({ ...SYNCED, ahead: 3, behind: 1 }).label,
    sync({ ...SYNCED, ahead: 2 }).label,
    sync({ ...SYNCED, behind: 5 }).label,
    sync({ ...SYNCED, upstream: "origin/main", behind: 5 }, null, true).label,
  ];
  for (const label of labels) {
    assert.match(label, /origin\//);
  }
});

/**
 * A gone upstream outranks the counts. A merged-and-deleted branch is usually also
 * behind, and "1 behind" would send the reader to pull something that no longer exists.
 */
test("gone outranks a count", () => {
  const badge = sync({ ...SYNCED, gone: true, behind: 4 });
  assert.equal(badge.variant, "gone");
});

/**
 * `git switch -c` off origin/main adopts it as the new branch's upstream, so the counts a
 * later `git fetch` produces describe trunk's movement rather than the branch's own. The
 * counts are real; calling them "diverged" in red is not.
 */
test("a branch tracking trunk is not reported as diverged", () => {
  const badge = sync(
    { ...SYNCED, upstream: "origin/main", ahead: 1, behind: 32 },
    null,
    true
  );
  assert.equal(badge.variant, "trackstrunk");
  assert.equal(badge.label, "1↑32↓ vs origin/main");
  assert.match(badge.description, /rather than a pushed copy of itself/);
});

/** The same counts on a branch tracking its own remote still mean a real divergence. */
test("tracking trunk is what distinguishes it from divergence, not the counts", () => {
  const counts = { ...SYNCED, ahead: 1, behind: 32 };
  assert.equal(sync(counts, null, false).variant, "diverged");
  assert.equal(sync(counts, null, true).variant, "trackstrunk");
});

/**
 * Trunk's own branch is excluded upstream of this function, in the render model, so a
 * `false` flag must keep reporting counts normally however trunk-like the upstream looks.
 */
test("an upstream that merely looks like trunk gets no special treatment", () => {
  const badge = sync({ ...SYNCED, upstream: "origin/main", behind: 3 }, null);
  assert.equal(badge.variant, "diverged");
  assert.equal(badge.label, "3 behind origin/main");
});

/**
 * A branch sitting exactly on trunk's tip has nothing to explain, so it reads as in sync
 * rather than drawing a badge about tracking trunk with two zeroes in it.
 */
test("tracking trunk with no counts reads as in sync", () => {
  const badge = sync({ ...SYNCED, upstream: "origin/main" }, null, true);
  assert.equal(badge.variant, "synced");
});

/** A vanished origin/main is the larger news, so it still outranks the trunk badge. */
test("gone outranks tracking trunk", () => {
  const badge = sync(
    { ...SYNCED, upstream: "origin/main", gone: true, behind: 4 },
    null,
    true
  );
  assert.equal(badge.variant, "gone");
});

/**
 * The trunk row's own badge: the one badge that belongs to a row rather than to a branch
 * pill. A local trunk that has merely not been pulled has no commits of its own, so no
 * other row is available to carry it.
 *
 * @param {Parameters<typeof trunkBehindBadge>} args
 */
const behind = (...args) =>
  present(trunkBehindBadge(...args), "a trunk behind badge");

test("the label names the branch and the gap, since the row shows neither", () => {
  assert.equal(
    behind("main", 42, "origin/main", true).label,
    "main is 42 behind"
  );
});

test("the description says which control closes the gap, from where HEAD is", () => {
  // Pull only ever moves the branch you are on, so a description that said "Pull" from a
  // feature branch sends the reader to a button that would fast-forward the wrong one. This
  // row's Goto is what covers that case, checking the branch out and fast-forwarding it.
  assert.match(
    behind("main", 42, "origin/main", true).description,
    /^Your local main is 42 commits behind origin\/main\. Pull fast-forwards it\.$/
  );
  assert.match(
    behind("main", 42, "origin/main", false).description,
    /Goto this row fast-forwards it and checks it out\.$/
  );
});

test("one commit is not plural", () => {
  assert.match(behind("main", 1, "origin/main", true).description, /1 commit /);
});

/**
 * Two ways to have nothing to report: a trunk that is current, and a trunk row with no
 * local branch at all — a clone whose `main` was deleted, where a count would name a
 * branch the reader does not have.
 */
test("a current branch and an absent one both produce no badge", () => {
  assert.equal(trunkBehindBadge("main", 0, "origin/main", true), null);
  assert.equal(trunkBehindBadge(null, 42, "origin/main", true), null);
});

test("no pull request means no badge", () => {
  assert.equal(pullRequestBadge(null), null);
});

/** GitHub calls a draft OPEN and flags it separately, so the variant is derived. */
test("a draft is its own variant, not open", () => {
  assert.equal(badgeFor(pullRequest({})).variant, "open");
  assert.equal(badgeFor(pullRequest({ isDraft: true })).variant, "draft");
});

test("merged and closed lower-case the state GitHub reports", () => {
  assert.equal(badgeFor(pullRequest({ state: "MERGED" })).variant, "merged");
  assert.equal(badgeFor(pullRequest({ state: "CLOSED" })).variant, "closed");
});

/** A draft that has merged is not a draft any more: the flag only qualifies OPEN. */
test("the draft flag is ignored once the pull request has merged", () => {
  const badge = badgeFor(pullRequest({ state: "MERGED", isDraft: true }));
  assert.equal(badge.variant, "merged");
});

test("each continuous integration state gets its own glyph", () => {
  /** @param {PullRequestStatus["checks"]} checks */
  const glyphFor = checks =>
    present(badgeFor(pullRequest({ checks })).checks, `the ${checks} glyph`)
      .glyph;
  assert.equal(glyphFor("success"), "✓");
  assert.equal(glyphFor("failure"), "✗");
  assert.equal(glyphFor("pending"), "●");
});

/**
 * A cancelled check rolls up to no state at all, and the badge then shows no CI glyph —
 * rather than an empty span that would read as a missing glyph.
 */
test("a rollup with no state produces no checks glyph", () => {
  assert.equal(badgeFor(pullRequest({ checks: null })).checks, null);
});

test("each review decision gets its own glyph, and no decision gets none", () => {
  /** @param {PullRequestStatus["reviewDecision"]} reviewDecision */
  const reviewGlyphFor = reviewDecision =>
    badgeFor(pullRequest({ reviewDecision })).reviewGlyph;
  assert.equal(reviewGlyphFor("APPROVED"), "✓");
  assert.equal(reviewGlyphFor("CHANGES_REQUESTED"), "↻");
  assert.equal(reviewGlyphFor("REVIEW_REQUIRED"), "○");
  assert.equal(badgeFor(pullRequest({})).reviewGlyph, null);
});

test("an unrecognised review decision draws no glyph rather than undefined", () => {
  assert.equal(
    badgeFor(pullRequest({ reviewDecision: "SOMETHING_NEW" })).reviewGlyph,
    null
  );
});

test("the description carries the title, then the state, and how to open it", () => {
  const badge = badgeFor(
    pullRequest({
      title: "feat: add words",
      checks: "failure",
      reviewDecision: "CHANGES_REQUESTED",
    })
  );
  assert.match(badge.description, /^feat: add words\n/);
  assert.match(
    badge.description,
    /open · review: changes requested · checks: failure/
  );
  assert.match(badge.description, /Click to open on GitHub\.$/);
});

test("a branch outside a stack gets no stack badges", () => {
  assert.deepEqual(stackBadges(null), []);
});

test("a stacked branch reports its layer", () => {
  const position = present(
    stackBadges({ position: 2, size: 3, needsRebase: false })[0],
    "the stack position badge"
  );
  assert.equal(position.variant, "stackpos");
  assert.equal(position.label, "2/3");
  assert.match(position.description, /Layer 2 of 3/);
});

test("a lagging layer adds a needs-rebase badge after its position", () => {
  const badges = stackBadges({ position: 2, size: 3, needsRebase: true });
  assert.deepEqual(
    badges.map(badge => badge.variant),
    ["stackpos", "needsrebase"]
  );
});
