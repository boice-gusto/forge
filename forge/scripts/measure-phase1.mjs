import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

function percentile(samples, percentileValue) {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * percentileValue) - 1,
  );
  return sorted[index];
}

function measure(command, args, samples = 3) {
  const values = Array.from({ length: samples }, () => {
    const startedAt = performance.now();
    execFileSync(command, args, { encoding: "utf8", stdio: "pipe" });
    return Number((performance.now() - startedAt).toFixed(3));
  });
  return {
    samplesMs: values,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

const baseline = {
  schemaVersion: 1,
  phase: 1,
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  measurements: {
    cliStartup: measure("pnpm", [
      "--filter",
      "@forge/cli",
      "exec",
      "tsx",
      "src/main.ts",
      "providers",
      "doctor",
      "--json",
    ]),
    emptyCompile: measure("pnpm", ["--filter", "@forge/types", "typecheck"]),
    apiHealthSerialization: measure("pnpm", [
      "--filter",
      "@forge/api",
      "exec",
      "tsx",
      "src/measure-health.ts",
    ]),
    uiFirstRenderModel: measure("pnpm", [
      "--filter",
      "@forge/ui",
      "exec",
      "tsx",
      "src/measure-render.tsx",
    ]),
  },
};

process.stdout.write(`${JSON.stringify(baseline)}\n`);
