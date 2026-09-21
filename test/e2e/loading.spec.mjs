/**
 * Loading, and what happens when a read goes wrong.
 *
 * These came from unit tests that drove the old imperative renderer through a hand-written
 * DOM shim. They live here rather than in a new harness because each is about a *response*
 * the UI has to survive, and forging one needs a transport — which the browser gives for free
 * through `page.route`. Nothing else in the suite covers them: the fixture always answers
 * well-formed, so the degraded paths would otherwise ship untested.
 */
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";

/**
 * Pull request status costs a ~1s `gh` round trip, so the first paint uses whatever is cached
 * and the fetch happens once, out of band, afterwards. A second one doubles the cost of
 * opening the panel.
 *
 * Counted at the endpoint rather than by the stand-in `gh`'s own call log, which cannot see
 * this: the server caches the result for a minute, so a duplicate request is served from that
 * cache and spawns no subprocess. Counting `gh` reported one call either way — it measures the
 * cache, not the UI.
 */
test("pull request status is fetched once, and a repository re-read does not re-fetch it", async ({
  smartlog,
}) => {
  let fetches = 0;
  smartlog.on("request", request => {
    if (request.url().endsWith("/api/pullRequests")) {
      fetches++;
    }
  });
  await reopen(smartlog);
  // The poll is stubbed out by the fixture, so nothing else can drive a fetch; give the
  // out-of-band one time to land before counting.
  await smartlog.waitForTimeout(500);
  expect(fetches).toBe(1);

  // The load-bearing half. *Refresh local state* re-reads local git state, which adopts a new
  // model — and a fetch hung off model adoption rather than off the first one fires again
  // here, spending a network round trip on every refresh. Counting only the first load
  // cannot see that: there is one load either way.
  await smartlog.locator("#btn-refresh").click();
  await expect(smartlog.locator("#tree .row").first()).toBeVisible();
  await smartlog.waitForTimeout(500);
  expect(fetches).toBe(1);
});

/**
 * Pull request status is an enrichment, so a malformed response has to leave what is on
 * screen alone. Adopting it unchecked blanks the tree — every row replaced by nothing,
 * seconds after a correct first paint, with no error to explain it.
 */
test("a malformed pull request response leaves the rendered tree intact", async ({
  smartlog,
}) => {
  const rowsBefore = await smartlog.locator("#tree .row").count();
  expect(rowsBefore).toBeGreaterThan(0);

  await smartlog.route("**/api/pullRequests", async route => {
    await route.fulfill({
      contentType: "application/json",
      // Only `rows` is wrong. `uncommitted` has to be a real array: the selection
      // reconcile reads it *before* the model is adopted, so a payload missing it throws
      // there and the tree survives for the wrong reason — which is what this asserted at
      // first, passing with the guard deleted.
      body: JSON.stringify({
        ok: true,
        data: { uncommitted: [], rows: "not an array" },
      }),
    });
  });
  await smartlog.locator("#btn-prs").click();
  await expect(smartlog.locator("#btn-prs")).toBeEnabled();

  expect(await smartlog.locator("#tree .row").count()).toBe(rowsBefore);
});

/**
 * A first-load failure has to explain itself where the rows would be. The placeholder says
 * "Loading…", so a silent failure is indistinguishable from a read that is merely slow —
 * and the reader waits instead of fixing the cause the message would have named.
 */
test("a failed first load reports the error instead of staying on Loading…", async ({
  smartlog,
}) => {
  await smartlog.route("**/api/model", async route => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: "fatal: not a git repository",
      }),
    });
  });
  await smartlog.reload();

  await expect(smartlog.locator("#empty")).toContainText(
    "fatal: not a git repository"
  );
  await expect(smartlog.locator("#empty")).not.toContainText("Loading");
});
