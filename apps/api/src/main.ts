import { randomUUID } from "node:crypto";

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
  /** Sandbox profiles this deployment can provision. */
  readonly sandboxProfiles?: readonly string[];
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
    ...(options.sandboxProfiles === undefined
      ? {}
      : { sandboxProfiles: options.sandboxProfiles }),
  });

  return app;
}

export async function startApi(
  options: ApiOptions,
  port = 3100,
): Promise<void> {
  await createApiApp(options).listen({ host: "127.0.0.1", port });
}
