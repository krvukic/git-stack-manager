/**
 * Which `gh stack` calls make GitHub link a stack in the order the tree draws it.
 *
 * The rules were found by running `gh stack link` against a real stack: it creates a stack,
 * appends to one that the list starts with, and refuses a list that leaves out a linked pull
 * request or orders them differently. So the plan is the feature: it has to choose an append
 * wherever one works, and dissolve a stack only where nothing else reaches the order.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GitRunner } from "#git/runner";
import { planStackLink, runStackLink } from "#github/stackLink";
import { scratchRoot } from "./repoFixture.mjs";

/** @typedef {import("#github/stackLink").StackLayer} StackLayer */
/** @typedef {import("#github/stackLink").StackLinkPlan} StackLinkPlan */

/**
 * One layer, named by its pull request number. `at` is its place in a stack on GitHub, as
 * `[stack, position, size]`.
 *
 * @param {number | null} number
 * @param {{ at?: [number, number, number], state?: string }} [fields]
 * @returns {StackLayer}
 */
function layer(number, { at, state = "OPEN" } = {}) {
  return {
    branch: `branch-${number ?? "unsubmitted"}`,
    pullRequest:
      number === null
        ? null
        : {
            number,
            state,
            isDraft: false,
            title: "",
            url: "",
            headSha: "",
            reviewDecision: null,
            checks: null,
            stack: at ? { number: at[0], position: at[1], size: at[2] } : null,
          },
  };
}

/**
 * @param {StackLayer[]} layers
 * @param {number} [required]
 * @returns {StackLinkPlan}
 */
function plan(layers, required = layers.length) {
  const planned = planStackLink(layers, required);
  assert.equal(typeof planned, "object", String(planned));
  return /** @type {StackLinkPlan} */ (planned);
}

test("pull requests in no stack are linked as a new one, bottom first", () => {
  assert.deepEqual(plan([layer(16), layer(17), layer(18)]), {
    pullRequests: [16, 17, 18],
    branches: ["branch-16", "branch-17", "branch-18"],
    unstack: [],
    kind: "create",
    stack: null,
  });
});

test("a stack that the list starts with is extended, never dissolved", () => {
  const planned = plan([
    layer(16, { at: [20, 1, 2] }),
    layer(17, { at: [20, 2, 2] }),
    layer(18),
  ]);
  assert.equal(planned.kind, "extend");
  assert.equal(planned.stack, 20);
  assert.deepEqual(planned.unstack, []);
  // The whole list, because `gh stack link` refuses one that leaves a linked pull request out.
  assert.deepEqual(planned.pullRequests, [16, 17, 18]);
});

test("a stack that already links exactly these needs no call", () => {
  const planned = plan([
    layer(16, { at: [20, 1, 2] }),
    layer(17, { at: [20, 2, 2] }),
  ]);
  assert.equal(planned.kind, "current");
  assert.equal(planned.stack, 20);
});

test("a stack that goes on above the list is left alone", () => {
  // The tree forks above the second branch, so the stack read from there ends at two, while
  // GitHub links a third pull request above them. Relinking two would drop the third.
  const planned = plan([
    layer(16, { at: [20, 1, 3] }),
    layer(17, { at: [20, 2, 3] }),
  ]);
  assert.equal(planned.kind, "current");
  assert.deepEqual(planned.unstack, []);
});

test("a stack missing the new bottom is dissolved and linked again", () => {
  // GitHub only appends, so a pull request below the linked ones cannot be added in place.
  const planned = plan([
    layer(16),
    layer(17, { at: [23, 1, 2] }),
    layer(18, { at: [23, 2, 2] }),
  ]);
  assert.equal(planned.kind, "rebuild");
  assert.deepEqual(planned.unstack, [23]);
  assert.deepEqual(planned.pullRequests, [16, 17, 18]);
});

test("a stack in another order, or two stacks, are dissolved first", () => {
  const reordered = plan([
    layer(17, { at: [20, 2, 2] }),
    layer(16, { at: [20, 1, 2] }),
  ]);
  assert.equal(reordered.kind, "rebuild");
  assert.deepEqual(reordered.unstack, [20]);

  const split = plan([
    layer(16, { at: [20, 1, 1] }),
    layer(17, { at: [30, 1, 1] }),
  ]);
  assert.equal(split.kind, "rebuild");
  assert.deepEqual(split.unstack, [20, 30]);
});

test("a stack holding a pull request from outside the list is dissolved first", () => {
  // Stack 20 has three entries, and only two of them are layers here. Appending would be
  // refused, since the list leaves the third out.
  const planned = plan([
    layer(16, { at: [20, 1, 3] }),
    layer(17, { at: [20, 2, 3] }),
    layer(18),
  ]);
  assert.equal(planned.kind, "rebuild");
  assert.deepEqual(planned.unstack, [20]);
});

test("a layer up to the clicked one with no open pull request refuses the link by name", () => {
  assert.equal(
    planStackLink([layer(16), layer(null), layer(18)], 3),
    "branch-unsubmitted has no open pull request. Submit the stack first."
  );
});

test("Link stack refuses a closed pull request and says what to do instead, since Submit stack stops at it", () => {
  assert.equal(
    planStackLink([layer(16), layer(17, { state: "CLOSED" })], 2),
    "branch-17's pull request #17 is closed. Reopen it on GitHub, or right-click branch-17's commit and choose Submit as new pull request."
  );
});

test("a layer above the clicked one joins while it has a pull request, and ends the list when not", () => {
  const upToSecond = plan([layer(16), layer(17), layer(18), layer(null)], 2);
  assert.deepEqual(upToSecond.pullRequests, [16, 17, 18]);

  const cutShort = plan([layer(16), layer(17), layer(null), layer(19)], 2);
  assert.deepEqual(cutShort.pullRequests, [16, 17]);
});

test("a merged pull request at the bottom is left out of the link", () => {
  const planned = plan([layer(15, { state: "MERGED" }), layer(16), layer(17)]);
  assert.deepEqual(planned.pullRequests, [16, 17]);
});

test("fewer than two open pull requests is nothing to link", () => {
  assert.equal(
    planStackLink([layer(16)], 1),
    "A stack needs at least two open pull requests."
  );
  assert.equal(
    planStackLink([layer(15, { state: "MERGED" }), layer(16)], 2),
    "A stack needs at least two open pull requests."
  );
});

/**
 * A `gh` on PATH that records its arguments, one line per call.
 *
 * @param {import("node:test").TestContext} t
 */
function recordingGh(t) {
  const root = scratchRoot(t, "gsm-stack-link-");
  const binDirectory = join(root, "bin");
  const logPath = join(root, "calls.jsonl");
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(logPath, "");
  writeFileSync(
    join(binDirectory, "gh"),
    `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    { mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  return {
    git: new GitRunner(root),
    calls: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => /** @type {string[]} */ (JSON.parse(line))),
  };
}

test("a link passes pull request numbers, which is what keeps it from pushing", async t => {
  const { git, calls } = recordingGh(t);
  await runStackLink(git, plan([layer(16), layer(17), layer(18)]));
  // A branch name here would make `gh stack link` push that branch first.
  assert.deepEqual(calls(), [["stack", "link", "16", "17", "18"]]);
});

test("a rebuild dissolves each old stack before the one link", async t => {
  const { git, calls } = recordingGh(t);
  await runStackLink(
    git,
    plan([
      layer(16),
      layer(17, { at: [23, 1, 2] }),
      layer(18, { at: [23, 2, 2] }),
    ])
  );
  assert.deepEqual(calls(), [
    ["stack", "unstack", "23"],
    ["stack", "link", "16", "17", "18"],
  ]);
});

test("a stack that GitHub already links makes no call at all", async t => {
  const { git, calls } = recordingGh(t);
  const current = plan([
    layer(16, { at: [20, 1, 2] }),
    layer(17, { at: [20, 2, 2] }),
  ]);
  await runStackLink(git, current);
  assert.deepEqual(calls(), []);
  assert.equal(current.stack, 20);
});
