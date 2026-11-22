/**
 * What the toast says after a stack's pull requests are linked on GitHub.
 *
 * The four kinds are four different things that happened on GitHub, and a reader who clicked
 * Link stack has no other place to learn which one it was.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  linkReport,
  submittedLinkNote,
} from "../src/webview/model/stackLink.mts";

test("each kind of link gets its own sentence, naming the pull requests in order", () => {
  const pullRequests = [16, 17, 18];
  assert.equal(
    linkReport({ kind: "create", pullRequests, stack: null }),
    "Linked #16, #17 and #18 as a stack ✓"
  );
  assert.equal(
    linkReport({ kind: "extend", pullRequests, stack: 20 }),
    "Stack #20 now links #16, #17 and #18 ✓"
  );
  assert.equal(
    linkReport({ kind: "rebuild", pullRequests, stack: null }),
    "Relinked #16, #17 and #18 as a stack, in the tree's order ✓"
  );
  assert.equal(
    linkReport({ kind: "current", pullRequests: [16, 17], stack: 20 }),
    "GitHub already links #16 and #17, as stack #20"
  );
});

test("a submit adds a clause only for a link that changed something, or failed", () => {
  assert.deepEqual(submittedLinkNote(null), { text: "", warn: false });
  assert.deepEqual(
    submittedLinkNote({ kind: "current", pullRequests: [16, 17], stack: 20 }),
    { text: "", warn: false }
  );
  assert.deepEqual(
    submittedLinkNote({ kind: "create", pullRequests: [16, 17], stack: null }),
    { text: ", and linked them as a stack", warn: false }
  );
  // The branches reached GitHub, so the failure is a warning beside the success.
  assert.deepEqual(submittedLinkNote({ error: "gh said no" }), {
    text: " — but linking the stack failed: gh said no",
    warn: true,
  });
});
