/**
 * When the panel re-reads, and how often at most.
 *
 * The bug these pin is the one a reader notices first: a file edited while the smartlog sat
 * in another tab stayed off the uncommitted list, because nothing but git's own writes ever
 * asked the panel to re-read. So the cases below are about which signals reach a read —
 * arriving back at the panel above all — and about the two ways a naive fix goes wrong: a
 * read per file of a forty-file save, and reads for a panel nobody is looking at.
 *
 * The clock and the timer are injected, which is what makes a quarter-second window
 * assertable without waiting one out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affectsWorkingCopy,
  REFRESH_WINDOW_MS,
  RefreshCoalescer,
} from "#app/refresh";

/**
 * A coalescer over a clock the test moves by hand, counting its pokes.
 *
 * The scheduler holds one pending task, which is all the coalescer ever asks for, and
 * `advance` runs it when its delay has elapsed — so a test says "a quarter of a second
 * passed" rather than sleeping.
 */
function harness({ windowMs = REFRESH_WINDOW_MS } = {}) {
  let now = 1000;
  let pokes = 0;
  /** @type {{ task: () => void, dueAt: number } | null} */
  let pending = null;
  const coalescer = new RefreshCoalescer(() => pokes++, {
    windowMs,
    now: () => now,
    schedule: (task, delayMs) => {
      pending = { task, dueAt: now + delayMs };
      return () => {
        pending = null;
      };
    },
  });
  return {
    coalescer,
    pokes: () => pokes,
    pending: () => pending !== null,
    /** @param {number} milliseconds */
    advance(milliseconds) {
      now += milliseconds;
      if (pending && pending.dueAt <= now) {
        const due = pending;
        pending = null;
        due.task();
      }
    },
  };
}

test("the first signal pokes immediately, so an edit shows without a wait", () => {
  const { coalescer, pokes } = harness();
  coalescer.signal();
  assert.equal(pokes(), 1);
});

/**
 * One `git commit` writes HEAD, the index, and a ref; one formatter run saves forty files.
 * Each of those is a burst, and a read per event would spawn git processes by the dozen.
 */
test("a burst inside the window costs one further read, at its end", () => {
  const { coalescer, pokes, advance } = harness({ windowMs: 250 });
  coalescer.signal();
  for (let index = 0; index < 40; index++) {
    coalescer.signal();
  }
  assert.equal(pokes(), 1, "the burst itself adds no reads");
  advance(250);
  assert.equal(
    pokes(),
    2,
    "one trailing read lands on the state the burst ended in"
  );
});

/**
 * The trailing read is not an optimisation, it is the correctness half: dropping it would
 * leave the panel showing the repository as it was one write into the burst.
 */
test("a signal during the window is answered even when nothing follows it", () => {
  const { coalescer, pokes, advance } = harness({ windowMs: 250 });
  coalescer.signal();
  advance(10);
  coalescer.signal();
  assert.equal(pokes(), 1);
  advance(240);
  assert.equal(pokes(), 2);
});

test("a signal after the window has passed pokes immediately again", () => {
  const { coalescer, pokes, advance } = harness({ windowMs: 250 });
  coalescer.signal();
  advance(250);
  coalescer.signal();
  assert.equal(pokes(), 2);
});

test("a hidden panel is not read for", () => {
  const { coalescer, pokes, pending } = harness();
  coalescer.observe({ visible: false, active: false });
  coalescer.signal();
  coalescer.signal();
  assert.equal(pokes(), 0);
  assert.equal(pending(), false, "nor is a read left scheduled for it");
});

/** The reported flow, in full: edit a file in another tab, then come back to this one. */
test("coming back into view reads, so an edit made elsewhere is on screen", () => {
  const { coalescer, pokes, advance } = harness();
  coalescer.observe({ visible: false, active: false });
  coalescer.signal();
  assert.equal(pokes(), 0);
  advance(REFRESH_WINDOW_MS);
  coalescer.observe({ visible: true, active: true });
  assert.equal(pokes(), 1);
});

/**
 * Nothing tells the panel a script rewrote files, so returning to it cannot depend on a
 * signal having arrived first.
 */
test("coming back into view reads even when no signal arrived while away", () => {
  const { coalescer, pokes, advance } = harness();
  coalescer.observe({ visible: false, active: false });
  advance(REFRESH_WINDOW_MS);
  coalescer.observe({ visible: true, active: true });
  assert.equal(pokes(), 1);
});

/**
 * Visibility and focus flip together in one event when a tab is clicked, and the panel that
 * was already on screen must not be read twice for the same arrival.
 */
test("becoming visible and focused at once reads once", () => {
  const { coalescer, pokes, pending } = harness();
  coalescer.observe({ visible: false, active: false });
  coalescer.observe({ visible: true, active: true });
  assert.equal(pokes(), 1);
  assert.equal(pending(), false);
});

/**
 * The panel stays visible while the integrated terminal has focus, so focus returning is the
 * only event that says "you were typing somewhere else".
 */
test("focus returning to a panel that stayed visible reads", () => {
  const { coalescer, pokes, advance } = harness();
  coalescer.observe({ visible: true, active: false });
  advance(REFRESH_WINDOW_MS);
  coalescer.observe({ visible: true, active: true });
  assert.equal(pokes(), 1);
});

test("a panel that only loses focus is not read for again", () => {
  const { coalescer, pokes } = harness();
  coalescer.observe({ visible: true, active: false });
  assert.equal(pokes(), 0);
});

test("hiding the panel drops a read that was already scheduled", () => {
  const { coalescer, pokes, pending, advance } = harness({ windowMs: 250 });
  coalescer.signal();
  coalescer.signal();
  assert.equal(pending(), true);
  coalescer.observe({ visible: false, active: false });
  assert.equal(pending(), false);
  advance(250);
  assert.equal(pokes(), 1);
});

test("disposing cancels the read it had scheduled", () => {
  const { coalescer, pokes, advance } = harness({ windowMs: 250 });
  coalescer.signal();
  coalescer.signal();
  coalescer.dispose();
  advance(250);
  assert.equal(pokes(), 1);
});

const REPOSITORY = "/home/dev/project";

test("a file in the working copy affects it", () => {
  assert.equal(
    affectsWorkingCopy(REPOSITORY, `${REPOSITORY}/src/app.ts`),
    true
  );
  assert.equal(affectsWorkingCopy(REPOSITORY, `${REPOSITORY}/README.md`), true);
});

/**
 * A workspace holds files the repository knows nothing about — an editor setting, a scratch
 * note in the home directory — and saving one is not repository news.
 */
test("a file outside the repository does not", () => {
  assert.equal(affectsWorkingCopy(REPOSITORY, "/home/dev/notes.md"), false);
  assert.equal(
    affectsWorkingCopy(REPOSITORY, "/home/dev/project-two/a.ts"),
    false
  );
  assert.equal(affectsWorkingCopy(REPOSITORY, REPOSITORY), false);
});

/**
 * Source Control saves `.git/COMMIT_EDITMSG` while a message is being typed, and git writes
 * the index on every read it is asked to do. The ref watcher covers what matters under
 * `.git`; following the rest would be a read per keystroke-save.
 */
test("a path under .git does not, whatever it is", () => {
  assert.equal(
    affectsWorkingCopy(REPOSITORY, `${REPOSITORY}/.git/COMMIT_EDITMSG`),
    false
  );
  assert.equal(
    affectsWorkingCopy(REPOSITORY, `${REPOSITORY}/.git/index`),
    false
  );
  // A file whose name merely starts with the same letters is not inside it.
  assert.equal(
    affectsWorkingCopy(REPOSITORY, `${REPOSITORY}/.gitignore`),
    true
  );
});
