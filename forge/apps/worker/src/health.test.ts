import { describe, expect, test } from "vitest";

import { createWorkerHealth } from "./health.js";

describe("worker health", () => {
  test("reports unready when queue connectivity is unavailable", () => {
    expect(
      createWorkerHealth(
        {
          version: "0.1.0",
          gitSha: "testsha",
          buildTime: "2026-08-02T00:00:00.000Z",
        },
        { queue: "unavailable" },
      ),
    ).toMatchObject({ status: "unready", service: "forge-worker" });
  });
});
