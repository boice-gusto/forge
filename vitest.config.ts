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
        // The UI is covered by Playwright in Phase 4 (015). Counting it here
        // would report a number that no test is defending.
        "apps/ui/**",
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
      },
    },
  },
});
