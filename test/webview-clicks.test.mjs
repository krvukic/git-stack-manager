/**
 * The modifier that opens a file behind the panel instead of in front of it.
 *
 * The platform split is the whole content of these: macOS gives Control-click to the
 * secondary menu, so a rule that accepted either modifier everywhere would fire on a
 * right-click there. The user agent is a parameter for exactly this reason — both platforms
 * are reachable from one process.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundModifierName,
  opensInBackground,
} from "../src/webview/model/clicks.mts";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
const PLAIN = { metaKey: false, ctrlKey: false };
const COMMAND = { metaKey: true, ctrlKey: false };
const CONTROL = { metaKey: false, ctrlKey: true };

test("a plain click never asks for a background tab", () => {
  assert.equal(opensInBackground(PLAIN, MAC), false);
  assert.equal(opensInBackground(PLAIN, LINUX), false);
});

test("Command opens a background tab on a Mac, and Control is left to the context menu", () => {
  assert.equal(opensInBackground(COMMAND, MAC), true);
  assert.equal(opensInBackground(CONTROL, MAC), false);
});

test("Control opens a background tab off a Mac, where Command is not a key", () => {
  assert.equal(opensInBackground(CONTROL, LINUX), true);
  assert.equal(opensInBackground(COMMAND, LINUX), false);
});

test("the tooltip names the key the reader's own keyboard prints", () => {
  assert.equal(backgroundModifierName(MAC), "⌘");
  assert.equal(backgroundModifierName(LINUX), "Ctrl");
});
