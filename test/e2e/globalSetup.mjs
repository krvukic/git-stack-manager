/**
 * Build the demo repository once, up front, and remove it when the run ends.
 *
 * Each test copies the template rather than regenerating it: the generator spends
 * ~330ms in git subprocesses, a copy of the 1.2MB result takes single-digit
 * milliseconds. Returning the teardown function is how Playwright asks for the
 * template to be cleaned up, so a run leaves nothing behind in the temp
 * directory.
 */
import { rmSync } from "node:fs";
import { buildDemoTemplate } from "./fixtures/demoRepo.mjs";

export default async function globalSetup() {
  const template = await buildDemoTemplate();
  process.env.GSM_DEMO_TEMPLATE = template;
  return () => rmSync(template, { recursive: true, force: true });
}
