import { describe, expect, test } from "vitest";

import { createWorkerHealth } from "./health.js";
import { createWorkerApp } from "./main.js";

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

  test("serves worker readiness independently of the API process", async () => {
    const app = createWorkerApp(
      {
        version: "0.1.0",
        gitSha: "testsha",
        buildTime: "2026-08-02T00:00:00.000Z",
      },
      { queue: "healthy" },
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "forge-worker",
      status: "healthy",
    });
  });
});
