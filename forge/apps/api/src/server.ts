import { startApi } from "./main.js";

await startApi({
  build: {
    version: process.env.FORGE_VERSION ?? "0.1.0",
    gitSha: process.env.FORGE_GIT_SHA ?? "local",
    buildTime: process.env.FORGE_BUILD_TIME ?? new Date().toISOString(),
  },
  dependencies: { queue: "healthy", persistence: "healthy" },
  adminToken: process.env.FORGE_ADMIN_TOKEN ?? "local-development-only",
});
