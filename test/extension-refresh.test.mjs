/**
 * The extension host's freshness wiring: which editor events make the panel re-read.
 *
 * The bug: a file saved in VS Code did not reach the smartlog. The host watched `.git` and
 * nothing else, so a commit or a rebase refreshed the tree while an edit did not — and
 * switching to the panel's tab showed whatever the working-copy list had held when some
 * action last rebuilt the model. So these tests are about the signals themselves, which is
 * the half no test could see before: `refresh.test.mjs` covers what the coalescer does with
 * them once they arrive.
 *
 * Each test opens its own host, because the open panel is module state.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { REFRESH_WINDOW_MS } from "#app/refresh";
import { scratchRoot } from "./repoFixture.mjs";
import { openHostPanel } from "./vscodeStub.mjs";

/**
 * A host whose panel is open on a scratch directory.
 *
 * No repository is created in it: every assertion here is about a signal reaching the
 * webview, and the host reads git only when the webview asks it to.
 *
 * @param {import("node:test").TestContext} t
 */
function openPanel(t) {
  const repositoryPath = scratchRoot(t, "gsm-host-");
  return { repositoryPath, ...openHostPanel({ repositoryPath }) };
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

test("saving a file in the working copy asks the panel to re-read", t => {
  const panel = openPanel(t);
  panel.fire.save(join(panel.repositoryPath, "src/app.ts"));
  assert.equal(panel.refreshes().length, 1);
});

test("saving a file outside the repository asks for nothing", t => {
  const panel = openPanel(t);
  panel.fire.save("/tmp/notes-elsewhere.md");
  assert.equal(panel.refreshes().length, 0);
});

/**
 * Source Control writes the commit message it is editing into the repository's own git
 * directory, and following that would re-read on every save of a message being typed.
 */
test("saving a file under .git asks for nothing", t => {
  const panel = openPanel(t);
  panel.fire.save(join(panel.repositoryPath, ".git/COMMIT_EDITMSG"));
  assert.equal(panel.refreshes().length, 0);
});

test("creating, deleting, and renaming files each ask for a re-read", async t => {
  const panel = openPanel(t);
  const inside = (/** @type {string} */ name) =>
    join(panel.repositoryPath, name);
  panel.fire.created([inside("added.ts")]);
  assert.equal(
    panel.refreshes().length,
    1,
    "a new file is a new uncommitted change"
  );
  // Past the window each time, so the three arrivals are not coalesced into one another.
  await sleep(REFRESH_WINDOW_MS + 50);
  panel.fire.deleted([inside("gone.ts")]);
  assert.equal(panel.refreshes().length, 2);
  await sleep(REFRESH_WINDOW_MS + 50);
  panel.fire.renamed(inside("old.ts"), inside("new.ts"));
  assert.equal(panel.refreshes().length, 3);
});

/** The signal that was already there, kept: a commit, a checkout, a rebase. */
test("a change under .git's refs asks the panel to re-read", t => {
  const panel = openPanel(t);
  const [watcher] = panel.watchers;
  assert.ok(watcher, "the host created no file system watcher");
  assert.match(
    String(/** @type {{ pattern?: unknown }} */ (watcher.pattern).pattern),
    /^\.git\//,
    "the watcher should be scoped to the git directory"
  );
  watcher.fireChange(panel.uriFor(join(panel.repositoryPath, ".git/HEAD")));
  assert.equal(panel.refreshes().length, 1);
});

/**
 * The reported flow, end to end: the panel sits in another tab while a file is edited, and
 * clicking back to it must show the change.
 */
test("an edit made while the panel was hidden shows when it comes back", t => {
  const panel = openPanel(t);
  panel.fire.viewState({ visible: false, active: false });
  panel.fire.save(join(panel.repositoryPath, "src/app.ts"));
  assert.equal(
    panel.refreshes().length,
    0,
    "a hidden panel is not worth reading a repository for"
  );
  panel.fire.viewState({ visible: true, active: true });
  assert.equal(panel.refreshes().length, 1);
});

/**
 * A script run in the integrated terminal leaves the panel visible and unfocused, so
 * clicking into the webview is the only event that says the reader is looking again.
 */
test("focus returning to a panel that stayed visible asks for a re-read", async t => {
  const panel = openPanel(t);
  panel.fire.viewState({ visible: true, active: false });
  assert.equal(panel.refreshes().length, 0, "losing focus is not news");
  await sleep(REFRESH_WINDOW_MS + 50);
  panel.fire.viewState({ visible: true, active: true });
  assert.equal(panel.refreshes().length, 1);
});

test("a command finishing in a terminal asks for a re-read", t => {
  const panel = openPanel(t);
  panel.fire.terminalCommandEnded();
  assert.equal(panel.refreshes().length, 1);
});

test("the window regaining focus asks for a re-read, and losing it does not", async t => {
  const panel = openPanel(t);
  panel.fire.windowFocus(false);
  assert.equal(panel.refreshes().length, 0);
  panel.fire.windowFocus(true);
  assert.equal(panel.refreshes().length, 1);
  await sleep(REFRESH_WINDOW_MS + 50);
});

/**
 * One formatter run saves every file it touched. Each save is its own event, and a read per
 * event would spawn git processes by the dozen — so the burst has to arrive as two reads:
 * one now, one on the state it ended in.
 */
test("a burst of saves costs two reads, not one per file", async t => {
  const panel = openPanel(t);
  for (let index = 0; index < 20; index++) {
    panel.fire.save(join(panel.repositoryPath, `src/file-${index}.ts`));
  }
  assert.equal(panel.refreshes().length, 1, "the burst itself adds no reads");
  await sleep(REFRESH_WINDOW_MS + 50);
  assert.equal(
    panel.refreshes().length,
    2,
    "one trailing read lands on the state the burst ended in"
  );
});

/**
 * The subscriptions belong to the panel, not to the extension: a closed panel that went on
 * watching would leave one set behind per open, each reading a repository for a webview that
 * no longer exists.
 */
test("closing the panel stops the signals", t => {
  const panel = openPanel(t);
  panel.fire.save(join(panel.repositoryPath, "src/app.ts"));
  assert.equal(panel.refreshes().length, 1);
  panel.fire.panelDisposed();
  panel.fire.save(join(panel.repositoryPath, "src/app.ts"));
  panel.fire.terminalCommandEnded();
  panel.fire.windowFocus(true);
  assert.equal(panel.refreshes().length, 1);
});
