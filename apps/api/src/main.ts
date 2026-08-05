import { randomUUID } from "node:crypto";

import { type ControlPlaneStack, createLocalStack } from "@forge/composition";
import Fastify, { type FastifyInstance } from "fastify";

import { createRequestAuthenticator, registerAuthRoutes } from "./auth.js";
import {
  type BuildInfo,
  createHealthSnapshot,
  type DependencyStatus,
} from "./health.js";
import {
  createSessionStore,
  type IdentityPort,
  type SessionStore,
} from "./identity.js";
import { registerRunRoutes } from "./runs.js";

export interface ApiOptions {
  readonly build: BuildInfo;
  readonly dependencies: Readonly<Record<string, DependencyStatus>>;
  /**
   * The bound identity provider. There is no default and no fallback: a
   * control plane that cannot tell two callers apart has no boundary, and the
   * previous shared-token comparison was that in all but name — every caller
   * was the same person, holding every role.
   */
  readonly identity: IdentityPort;
  /**
   * The one stack this process serves, built at boot from the company package
   * and the persistence this deployment was configured with. Defaulted to a
   * bare local stack so a contributor with no Docker and no company package
   * still gets a control plane — one that grants nothing and rules on nothing,
   * which is the correct thing for a host that was told nothing.
   */
  readonly stack?: ControlPlaneStack;
  /** Overridable so a suite can age a session out without waiting for one. */
  readonly sessions?: SessionStore;
}

export function createApiApp(options: ApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const sessions = options.sessions ?? createSessionStore();
  const authenticate = createRequestAuthenticator({
    identity: options.identity,
    sessions,
  });
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
    if ((await authenticate(request)) === undefined) {
      return reply.code(401).send({ status: "unauthorized" });
    }
    return reply.send(snapshot());
  });

  registerAuthRoutes(app, { identity: options.identity, sessions });
  registerRunRoutes(app, {
    authenticate,
    stack: options.stack ?? createLocalStack(),
  });

  return app;
}

export async function startApi(
  options: ApiOptions,
  port = 3100,
): Promise<void> {
  await createApiApp(options).listen({ host: "127.0.0.1", port });
}
