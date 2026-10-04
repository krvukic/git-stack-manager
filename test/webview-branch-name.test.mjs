/**
 * The branch name the commit form suggests from a summary.
 *
 * The reader sees and can edit every suggestion, and the host validates whatever name it is
 * finally given, so none of these cases is about safety. They are about a suggestion worth
 * accepting. A name repeating the commit type, or running to sixty characters, gets retyped,
 * and a suggestion always retyped is no suggestion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestBranchName } from "../src/webview/model/branchName.mts";

test("a plain summary becomes a dashed slug", () => {
  assert.equal(
    suggestBranchName("Add the missing index"),
    "add-the-missing-index"
  );
});

test("the suggestion drops a conventional-commit prefix", () => {
  // The type and the scope say what the words below already say, and the branch has one
  // line of pill to spend.
  assert.equal(suggestBranchName("feat(case): add camelCase"), "add-camelcase");
  assert.equal(suggestBranchName("fix: stop the crash"), "stop-the-crash");
  assert.equal(
    suggestBranchName("refactor(ui)!: split the drawers"),
    "split-the-drawers"
  );
});

test("only a single word against the colon counts as a commit type", () => {
  // Narrow on purpose. Everything before a colon is not fair game — an issue identifier is
  // the most useful thing a branch name can carry, and a phrase is the summary itself.
  assert.equal(
    suggestBranchName("ENG-1234: fix the thing"),
    "eng-1234-fix-the-thing"
  );
  assert.equal(suggestBranchName("two words: and more"), "two-words-and-more");
});

test("punctuation and case go, and an apostrophe closes up", () => {
  assert.equal(
    suggestBranchName("fix: correct the progress prop's doc"),
    "correct-the-progress-props-doc"
  );
  assert.equal(suggestBranchName("Use `classes()` here"), "use-classes-here");
});

test("the suggestion stops at a word boundary rather than mid-word", () => {
  const suggestion = suggestBranchName(
    "feat: remember the width the diff was last read at, across reloads"
  );
  assert.equal(suggestion, "remember-the-width-the-diff-was");
  assert.ok(suggestion.length <= 32, `${suggestion.length} characters`);
  // Cut between words, so every word in it is a whole one.
  assert.equal(suggestion.endsWith("-"), false);
});

test("the suggestion keeps one over-long word whole", () => {
  // A name of nothing is worse than a name over the limit, and the reader can shorten it.
  assert.equal(
    suggestBranchName("Supercalifragilisticexpialidocious behaviour"),
    "supercalifragilisticexpialidocious"
  );
});

test("a summary with no letters or digits suggests nothing", () => {
  // The form shows its placeholder only once there is something to suggest, so empty is an
  // answer rather than a failure.
  assert.equal(suggestBranchName(""), "");
  assert.equal(suggestBranchName("   "), "");
  assert.equal(suggestBranchName("!!! ---"), "");
});
