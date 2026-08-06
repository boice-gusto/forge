import { defineConfig, devices } from "@playwright/test";

/**
 * Browser acceptance for the operator UI.
 *
 * Deliberately outside the default `pnpm test` path: these tests start a real
 * control plane and a real dev server, and a suite that slow in the inner loop
 * is a suite people stop running. Vitest's default glob is
 * `**\/*.{test,spec}.*`, so the files are named `*.e2e.ts` — that, rather than
 * an exclusion in `vitest.config.ts`, is what keeps the two suites apart, and
 * it cannot be undone by editing a config somewhere else.
 *
 * No `webServer`: both processes bind ephemeral ports chosen at run time and
 * the UI has to be told the API's, which a static config cannot express. They
 * are started and torn down by the worker fixture in `e2e/processes.ts`.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // One control plane, one UI server, one browser. The suite is small and its
  // subject is a shared inbox; running files against one another's gates would
  // buy seconds and cost the assertions their meaning.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  // A browser test that only passes on the second attempt is a browser test
  // that failed. Nothing here is timing-dependent by design.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  // `.tmp` is already ignored repository-wide, so a failed run leaves no
  // untracked artefacts behind.
  outputDir: ".tmp/playwright",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
