import { startApi } from "./main.js";

/**
 * `PORT` matters beyond taste: a suite that cannot choose a port cannot run two
 * Forges at once, and a fixed 3100 means a harness will happily adopt whatever
 * is already listening there. That is not hypothetical — a company acceptance
 * run did exactly that and spent twenty assertions failing against another
 * process's half-built server.
 */
const port = Number.parseInt(process.env.PORT ?? "3100", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be a valid port number; got ${process.env.PORT}.`);
}

await startApi(
  {
    build: {
      version: process.env.FORGE_VERSION ?? "0.1.0",
      gitSha: process.env.FORGE_GIT_SHA ?? "local",
      buildTime: process.env.FORGE_BUILD_TIME ?? new Date().toISOString(),
    },
    dependencies: { queue: "healthy", persistence: "healthy" },
    adminToken: process.env.FORGE_ADMIN_TOKEN ?? "local-development-only",
    ...(process.env.FORGE_PRINCIPAL === undefined
      ? {}
      : { principal: process.env.FORGE_PRINCIPAL }),
    // Roles the token holds. Unset keeps the single-operator default of every
    // role; setting it is how a deployment — or a company's acceptance suite —
    // narrows the approval inbox to real membership.
    ...(process.env.FORGE_ROLES === undefined
      ? {}
      : {
          roles: process.env.FORGE_ROLES.split(",")
            .map((role) => role.trim())
            .filter(Boolean),
        }),
  },
  port,
);
