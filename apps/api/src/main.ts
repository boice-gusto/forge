import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import {
  type BuildInfo,
  createHealthSnapshot,
  type DependencyStatus,
} from "./health.js";
import { registerRunRoutes } from "./runs.js";

export interface ApiOptions {
  readonly build: BuildInfo;
  readonly dependencies: Readonly<Record<string, DependencyStatus>>;
  readonly adminToken: string;
  /** Principal attributed to an authenticated caller. */
  readonly principal?: string;
}

export function createApiApp(options: ApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const snapshot = () =>
    createHealthSnapshot("forge-api", options.build, options.dependencies);

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("X-Forge-Version", options.build.version);
    reply.header("X-Forge-Git-SHA", options.build.gitSha);
    reply.header("X-Forge-Service", "forge-api");
    reply.header("X-Request-ID", randomUUID());
  });

  app.get("/health/live", async () => ({
    status: "alive",
    service: "forge-api",
  }));
  app.get("/health/ready", async (_request, reply) => {
    const health = snapshot();
    return reply.code(health.status === "healthy" ? 200 : 503).send(health);
  });
  app.get("/health", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${options.adminToken}`) {
      return reply.code(401).send({ status: "unauthorized" });
    }
    return reply.send(snapshot());
  });

  registerRunRoutes(app, {
    // The boundary decides who is acting. A body field never does.
    principalFor: (authorization) =>
      authorization === `Bearer ${options.adminToken}`
        ? (options.principal ?? "local-operator")
        : undefined,
  });

  return app;
}

export async function startApi(
  options: ApiOptions,
  port = 3100,
): Promise<void> {
  await createApiApp(options).listen({ host: "127.0.0.1", port });
}
