import { describe, expect, test } from "vitest";

import { createApiApp } from "./main.js";

describe("Forge API health endpoints", () => {
  test("keeps liveness independent of degraded dependencies and attaches build headers", async () => {
    const app = createApiApp({
      build: {
        version: "0.1.0",
        gitSha: "testsha",
        buildTime: "2026-08-02T00:00:00.000Z",
      },
      dependencies: { queue: "unavailable" },
      adminToken: "test-token",
    });

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-forge-version"]).toBe("0.1.0");
    expect(response.headers["x-forge-git-sha"]).toBe("testsha");
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  test("fails readiness when dependencies cannot safely accept work", async () => {
    const app = createApiApp({
      build: {
        version: "0.1.0",
        gitSha: "testsha",
        buildTime: "2026-08-02T00:00:00.000Z",
      },
      dependencies: { queue: "unavailable" },
      adminToken: "test-token",
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "unready" });
  });

  test("protects detailed health with an admin bearer token", async () => {
    const app = createApiApp({
      build: {
        version: "0.1.0",
        gitSha: "testsha",
        buildTime: "2026-08-02T00:00:00.000Z",
      },
      dependencies: { queue: "healthy" },
      adminToken: "test-token",
    });

    const denied = await app.inject({ method: "GET", url: "/health" });
    const accepted = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer test-token" },
    });

    expect(denied.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      status: "healthy",
      service: "forge-api",
    });
  });
});
