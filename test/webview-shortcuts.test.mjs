/**
 * The keyboard shortcut table, and the dispatch built from it.
 *
 * An earlier version kept the handler's `switch` and the help drawer's list side by side and
 * claimed in a comment that they matched. Nothing enforced it, and they drifted. Dispatch is
 * now derived from the table, so the tests below check the derivation instead of comparing
 * two hand-written copies.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shortcutActionsByKey,
  SHORTCUTS,
} from "../src/webview/model/shortcuts.mts";

test("every listed shortcut maps to exactly one action", () => {
  const byKey = shortcutActionsByKey();
  const listed = SHORTCUTS.flatMap(group => group.keys);
  for (const shortcut of listed) {
    for (const key of shortcut.eventKeys ?? shortcut.keys) {
      assert.equal(
        byKey.get(key),
        shortcut.action,
        `${key} should run ${shortcut.action}`
      );
    }
  }
});

test("the keys the browser reports are the ones dispatch is keyed by", () => {
  const byKey = shortcutActionsByKey();
  // The drawer shows arrows as glyphs; `event.key` never says "↑".
  assert.equal(byKey.get("ArrowUp"), "selectAbove");
  assert.equal(byKey.get("ArrowDown"), "selectBelow");
  assert.equal(byKey.get("k"), "selectAbove");
  assert.equal(byKey.get("j"), "selectBelow");
  assert.equal(byKey.has("↑"), false, "a glyph is display-only");
});

test("no key is bound to two actions", () => {
  const seen = new Set();
  for (const group of SHORTCUTS) {
    for (const shortcut of group.keys) {
      for (const key of shortcut.eventKeys ?? shortcut.keys) {
        assert.ok(!seen.has(key), `${key} is bound twice`);
        seen.add(key);
      }
    }
  }
});

test("every group has a heading, and every row has keys to show", () => {
  for (const group of SHORTCUTS) {
    assert.ok(group.heading.length > 0);
    for (const row of group.rows ?? group.keys) {
      assert.ok(row.keys.length > 0, `${row.what} lists no keys`);
      assert.ok(row.what.length > 0);
    }
  }
});

/**
 * The two resize groups. Each element handles these keys while it holds focus, so they never
 * reach the document handler and carry no action — which is exactly why they need listing: a
 * reader looking for "how do I resize this" looks in the drawer, and the drawer draws `rows`.
 */
test("the resize groups are listed with rows and no dispatched action", () => {
  const displayOnly = SHORTCUTS.filter(group => !group.keys.length);
  assert.equal(displayOnly.length, 2);
  for (const group of displayOnly) {
    assert.ok((group.rows?.length ?? 0) >= 3, `${group.heading} shows no rows`);
  }
});
