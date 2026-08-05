import { defineConfig } from "vitest/config";

/**
 * Coverage thresholds are floors set just under what the suite currently
 * achieves, per package rather than only globally. A single global number lets
 * a well-tested package carry an untested one; a package-level floor makes a
 * regression visible where it happened.
 *
 * The floors are highest on the packages that carry the safety invariants —
 * the compiler decides what may run, and the runtime decides what actually
 * does.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        // Barrels re-export; there is nothing to assert.
        "**/index.ts",
        // Process and browser entry points are wiring, exercised by running
        // the thing rather than by a unit test.
        "**/src/main.ts",
        "**/src/server.ts",
        "**/src/browser.tsx",
        "**/src/measure-*.ts",
        "**/src/measure-*.tsx",
      ],
      thresholds: {
        lines: 94,
        functions: 96,
        branches: 80,
        statements: 94,

        "packages/compiler/src/**": {
          lines: 98,
          functions: 100,
          branches: 85,
          statements: 97,
        },
        "packages/runtime/src/**": {
          lines: 100,
          functions: 100,
          branches: 90,
          statements: 97,
        },
        "packages/panel/src/**": {
          lines: 94,
          functions: 100,
          branches: 93,
          statements: 95,
        },
        "packages/policy-memory/src/**": {
          lines: 100,
          functions: 100,
          branches: 93,
          statements: 100,
        },
        "packages/approval-memory/src/**": {
          lines: 100,
          functions: 100,
          branches: 90,
          statements: 100,
        },
        "packages/engine-memory/src/**": {
          lines: 96,
          functions: 100,
          branches: 73,
          statements: 95,
        },
        "packages/sdk/src/**": {
          lines: 100,
          functions: 100,
          branches: 88,
          statements: 100,
        },
        "apps/api/src/**": {
          lines: 100,
          functions: 100,
          branches: 81,
          statements: 100,
        },
        // The extension surface. Everything a company contributes passes
        // through here, so the floor is the full 100 on every metric.
        "packages/plugin-sdk/src/**": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // A conformance suite proves both provider adapters, so nothing in
        // either is unexercised.
        "packages/provider-mock/src/**": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        "packages/provider-replay/src/**": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        "packages/provider-conformance/src/**": {
          lines: 99,
          functions: 100,
          branches: 85,
          statements: 99,
        },
        // The UI is tested with Vitest rather than deferred to a Playwright
        // suite that does not exist, so it is measured like everything else.
        "apps/ui/src/**": {
          lines: 98,
          functions: 95,
          branches: 93,
          statements: 97,
        },
        // The loader decides what a company package is allowed to become.
        "packages/company/src/**": {
          lines: 100,
          functions: 100,
          branches: 96,
          statements: 100,
        },
      },
    },
  },
});
