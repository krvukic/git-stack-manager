/**
 * What the discard confirmation promises, per status letter.
 *
 * The letters that delete the file are the content of these tests, because getting one wrong
 * promises the reader a restore and then removes the file. `A` is the letter to watch: it reads
 * as "added" and sits with untracked rather than with modified, since a staged addition has no
 * committed version to go back to either.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discardConsequence,
  discardDeletesFile,
} from "../src/webview/model/discard.mts";

test("an untracked file and a staged addition are deleted", () => {
  assert.equal(discardDeletesFile("?"), true);
  assert.equal(discardDeletesFile("A"), true);
});

test("every letter with a committed version behind it restores instead", () => {
  // A rename restores too: HEAD holds the file under its old name, which is where it goes back.
  for (const status of ["M", "D", "R", "C", "T"]) {
    assert.equal(discardDeletesFile(status), false, status);
  }
});

test("the wording says which of the two is about to happen", () => {
  assert.match(discardConsequence("?"), /deleted/);
  assert.match(discardConsequence("M"), /goes back/);
});
