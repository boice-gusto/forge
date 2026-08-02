import { startWorker } from "./main.js";

startWorker({
  version: process.env.FORGE_VERSION ?? "0.1.0",
  gitSha: process.env.FORGE_GIT_SHA ?? "local",
  buildTime: process.env.FORGE_BUILD_TIME ?? new Date().toISOString(),
});
