import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Research prototypes under docs/ are Phase 0 artifacts with their own
    // runner (`node --test`). They are evidence for ADRs, not product code,
    // and must not be collected into the product suite.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/docs/research/prototypes/**",
    ],
  },
});
