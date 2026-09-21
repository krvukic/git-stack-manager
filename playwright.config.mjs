/**
 * Playwright configuration for the smartlog end-to-end suite.
 *
 * The suite drives the real web host (`out/hosts/server.js`) against a generated
 * demo repository, so `just build` must have run first — `just test-e2e` does it.
 * Each test spawns its own server on its own copy of the repository, so there is
 * no shared `webServer` here and full parallelism is safe.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/globalSetup.mjs",
  // One flat directory of PNGs named for the state they show, so the whole set
  // reads as a gallery in a file browser or a pull request. No {platform} segment:
  // font rasterisation differs enough between Linux and macOS that a per-platform
  // baseline is really a per-developer baseline, and nobody would keep both
  // current. The suite is recorded on Linux; see the README on running it
  // elsewhere.
  snapshotPathTemplate: "{testDir}/snapshots/{arg}{ext}",
  fullyParallel: true,
  // A stray `test.only` must fail the run rather than silently skip the suite.
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // Wide enough that no branch pill or badge is clipped out of the DOM read.
    viewport: { width: 1400, height: 1000 },
    // The sidebar formats a commit date with `toLocaleString`, so the browser's
    // locale and zone decide what the snapshot holds. Pinning both keeps the
    // recorded timestamp identical wherever the suite runs.
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
});
