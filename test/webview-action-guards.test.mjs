/**
 * The predicates a button and a key both read.
 *
 * Absorb and Undo are reachable two ways, so their availability is a property of the model
 * rather than of either surface. The cases below are the four states a reader reaches: clean,
 * dirty, paused mid-rebase, and a checkpoint waiting to be undone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canAbsorb, canUndo } from "../src/webview/model/actionGuards.mts";

/**
 * @param {Partial<import("#ui/renderModel").RenderModel>} fields
 * @returns {import("#ui/renderModel").RenderModel}
 */
const modelWith = fields =>
  /** @type {import("#ui/renderModel").RenderModel} */ ({
    uncommitted: [],
    conflict: null,
    undoLabel: null,
    ...fields,
  });

/** @param {string} path */
const change = path =>
  /** @type {import("#git/snapshot").FileChange} */ ({ path, status: "M" });

/**
 * A rebase stopped part way, with `path` unresolved.
 *
 * @param {string} path
 * @returns {import("#git/snapshot").ConflictState}
 */
const pausedOn = path => ({
  branch: "truncate-words",
  unmergedFiles: [path],
  step: 2,
  totalSteps: 3,
});

test("absorb needs something modified to attribute", () => {
  assert.equal(canAbsorb(modelWith({})), false);
  assert.equal(
    canAbsorb(modelWith({ uncommitted: [change("src/trim.js")] })),
    true
  );
});

/**
 * The unmerged file git left behind is listed as an uncommitted change, so a paused rebase
 * looks dirty. Absorbing there rewrites the commits the rebase is replaying.
 */
test("a paused rebase blocks absorb however dirty the working copy is", () => {
  assert.equal(
    canAbsorb(
      modelWith({
        uncommitted: [change("src/truncate.js")],
        conflict: pausedOn("src/truncate.js"),
      })
    ),
    false
  );
});

/** Undo moves refs and leaves files alone, which is why the conflict does not stop it. */
test("undo follows the checkpoint, in a conflict as much as out of one", () => {
  assert.equal(canUndo(modelWith({})), false);
  assert.equal(canUndo(modelWith({ undoLabel: "Amend message" })), true);
  assert.equal(
    canUndo(
      modelWith({
        undoLabel: "Rebase onto trunk",
        conflict: pausedOn("src/truncate.js"),
      })
    ),
    true
  );
});
