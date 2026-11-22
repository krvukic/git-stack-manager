/**
 * What the commit panel's Draft toggle shows.
 *
 * The toggle names the state a pull request opens in, so it applies only while Submit would
 * open one. These pin that boundary, and which of the two sources answers inside it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftToggle } from "../src/webview/model/draft.mts";

/** @typedef {import("#ui/renderModel").UIBranch} UIBranch */

/**
 * @param {{ draft?: boolean | null, pullRequest?: { state: string, isDraft: boolean } | null }} fields
 * @returns {UIBranch}
 */
function branch({ draft = null, pullRequest = null }) {
  return /** @type {UIBranch} */ ({
    name: "feature-a",
    sync: null,
    draft,
    pullRequest,
  });
}

test("a branch with no choice and no pull request shows the setting", () => {
  assert.equal(draftToggle(branch({}), true), true);
  assert.equal(draftToggle(branch({}), false), false);
});

test("a stored choice shows before the setting", () => {
  assert.equal(draftToggle(branch({ draft: true }), false), true);
  assert.equal(draftToggle(branch({ draft: false }), true), false);
});

test("a branch with an open pull request gets no toggle, whatever is stored", () => {
  for (const draft of [null, true, false]) {
    const open = branch({
      draft,
      pullRequest: { state: "OPEN", isDraft: false },
    });
    assert.equal(draftToggle(open, true), null);
  }
});

test("a merged or closed pull request leaves the toggle, since submit opens a new one", () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const finished = branch({ pullRequest: { state, isDraft: true } });
    // The old pull request's draft state is not the new one's.
    assert.equal(draftToggle(finished, false), false);
    assert.equal(
      draftToggle(
        branch({ draft: true, pullRequest: { state, isDraft: false } }),
        false
      ),
      true
    );
  }
});
