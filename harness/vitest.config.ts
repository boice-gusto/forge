import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The harness runs on its own config, and on its own file extension.
 *
 * `*.scenario.ts` rather than `*.test.ts` is the whole mechanism that keeps
 * these out of `pnpm test`: the root suite uses Vitest's default `include`,
 * which matches only `.test.` and `.spec.`. A rename here is enough to drag a
 * four-minute container drill into every contributor's inner loop, so the
 * extension is load-bearing.
 *
 * No coverage thresholds. These scenarios exercise `apps/**` and `packages/**`
 * through real processes, which is a different question from whether those
 * files are covered, and the root config already answers that one.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: HERE,
    include: ["test/**/*.scenario.ts"],
    // Containers, child processes and fixed host ports. Two scenario files in
    // parallel would contend for all three.
    fileParallelism: false,
    hookTimeout: 300_000,
    testTimeout: 600_000,
    reporters: ["verbose"],
  },
});
