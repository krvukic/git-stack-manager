/**
 * The Pull button.
 *
 * Each test moves `main` back and reopens, which the demo repository makes cheap: its origin
 * is a local bare clone, so the fetch is real and costs nothing. Three of the four are
 * refusals, because Pull only ever fast-forwards — what matters there is that it names a
 * cause the reader can act on rather than failing quietly.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, reopen, test } from "./fixtures/demoRepo.mjs";
import { expectToast } from "./fixtures/interactions.mjs";

test("Pull fast-forwards the branch and reports how many commits arrived", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "main"]);
  await demoRepository.git(["reset", "--hard", "origin/main~2"]);
  await reopen(smartlog);

  await smartlog.locator("#btn-pull").click();
  await expectToast(smartlog, "Pulled 2 commits into main");

  expect(await demoRepository.git(["rev-parse", "main"])).toBe(
    await demoRepository.git(["rev-parse", "origin/main"])
  );

  // A second pull has nothing to do, and reports that rather than erroring: the button
  // ran a fetch either way, so silence would leave that ambiguous.
  await smartlog.locator("#btn-pull").click();
  await expectToast(smartlog, "already up to date");
});

test("Pull ignores an untracked file, which no fast-forward can overwrite", async ({
  demoRepository,
  smartlog,
}) => {
  // The reported bug, end to end: a single scratch file in the working copy — a log, an
  // editor's leftover — and the button refused, so a branch four commits behind stayed
  // behind with nothing on screen offering a way through.
  await demoRepository.git(["checkout", "main"]);
  await demoRepository.git(["reset", "--hard", "origin/main~2"]);
  await writeFile(join(demoRepository.path, "scratch.log"), "noise\n");
  await reopen(smartlog);

  await smartlog.locator("#btn-pull").click();
  await expectToast(smartlog, "Pulled 2 commits into main");

  expect(await demoRepository.git(["rev-parse", "main"])).toBe(
    await demoRepository.git(["rev-parse", "origin/main"])
  );
  expect(await demoRepository.git(["status", "--porcelain"])).toBe(
    "?? scratch.log"
  );
});

test("Pull refuses a tracked edit and names the file in the way", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "main"]);
  await demoRepository.git(["reset", "--hard", "origin/main~2"]);
  await writeFile(
    join(demoRepository.path, "src", "slugify.js"),
    "// half-finished edit\n"
  );
  await reopen(smartlog);

  await smartlog.locator("#btn-pull").click();
  // Naming the path is the difference between a refusal a reader can act on and a trip to
  // `git status` to find out which file the toast meant.
  await expectToast(smartlog, "src/slugify.js");
});

test("Pull refuses a diverged branch and changes nothing", async ({
  demoRepository,
  smartlog,
}) => {
  await demoRepository.git(["checkout", "main"]);
  await demoRepository.git(["reset", "--hard", "origin/main~2"]);
  await demoRepository.git(["commit", "--allow-empty", "-m", "my local work"]);
  const before = await demoRepository.git(["rev-parse", "main"]);
  await reopen(smartlog);

  await smartlog.locator("#btn-pull").click();
  // Fast-forward only: a merge commit or a silent rebase is a history decision a Pull
  // button should not make, so it names the counts and points at Rebase instead.
  await expectToast(smartlog, "cannot fast-forward");

  expect(await demoRepository.git(["rev-parse", "main"])).toBe(before);
});
