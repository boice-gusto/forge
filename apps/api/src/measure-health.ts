import { createDevelopmentIdentity } from "./identity-development.js";
import { createApiApp } from "./main.js";

const app = createApiApp({
  build: {
    version: "0.1.0",
    gitSha: "measure",
    buildTime: "2026-08-02T00:00:00.000Z",
  },
  dependencies: { queue: "healthy" },
  identity: createDevelopmentIdentity([
    { subject: "measure", secret: "measure", roles: [] },
  ]),
});
await app.inject({ method: "GET", url: "/health/live" });
await app.close();
