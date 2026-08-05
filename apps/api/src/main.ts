import { randomUUID } from "node:crypto";

import { ANY_ROLE } from "@forge/ports";
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
  /**
   * Roles that principal holds, used to scope the approval inbox. A policy
   * rule's `approvers` names roles rather than people, so without this the
   * inbox matches on identity alone and shows nothing.
   */
  readonly roles?: readonly string[];
}

/**
 * A single shared admin token is, in effect, every role: there is one operator
 * and no directory to ask. Said out loud rather than left as a matching
 * accident, because it is exactly the assumption an IdP has to replace
 * (012 §8) — at which point the inbox narrows to real membership.
 */
const ALL_ROLES = [ANY_ROLE] as const;

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
    /**
     * One shared admin token means one operator who is, in effect, every role.
     * Stated explicitly rather than left to a matching accident: with a real
     * IdP this resolves actual membership, and the inbox narrows accordingly.
     */
    rolesFor: () => options.roles ?? ALL_ROLES,
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
