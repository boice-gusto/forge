import { type ControlPlaneStack, compileToArtifact } from "@forge/composition";
import type { ApprovalDecision, JsonValue, RunStatus } from "@forge/ports";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { mayDecide, type Principal } from "./identity.js";

/**
 * Control-plane routes.
 *
 * The API is the boundary that establishes who is acting. A decision's
 * principal is taken from the authenticated caller, never from the request
 * body — a body field is not an identity claim (006 §2).
 *
 * **One stack per deployment.** This file used to build a fresh stack for any
 * request that carried a `policy`, which with the durable root would have meant
 * a new Postgres pool and a new Redis connection per run started. Policy now
 * resolves from the company package the process loaded at boot, so there is one
 * runtime, one approval store and one run store to ask — and a run this process
 * did not start is an ordinary run rather than a 404.
 */

interface StartBody {
  readonly workflow?: unknown;
  /**
   * What the run's roles require. Not authority: the evaluator checks each
   * against the policy closure's grants, so naming a capability the company was
   * never granted denies the action rather than conferring it.
   */
  readonly capabilities?: readonly string[];
  readonly changedPaths?: readonly string[];
  /** The run's input, which the workflow's input nodes produce. */
  readonly payload?: JsonValue;
}

interface DecisionBody {
  readonly decision?: "approve" | "reject" | "edit" | "timeout";
  readonly reason?: string;
  readonly patch?: unknown;
}

function toDecision(body: DecisionBody): ApprovalDecision | undefined {
  switch (body.decision) {
    case "approve":
      return { kind: "approve" };
    case "reject":
      return { kind: "reject", reason: body.reason ?? "No reason given." };
    case "edit":
      return { kind: "edit", patch: body.patch };
    case "timeout":
      return { kind: "timeout" };
    default:
      return undefined;
  }
}

const RUN_STATUSES = new Set<string>([
  "PENDING",
  "RUNNING",
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] satisfies readonly RunStatus[]);

export interface RunRoutesOptions {
  /**
   * Resolves the acting principal — subject *and* roles — from the request, at
   * the trusted boundary. A rule's `approvers` names roles rather than people,
   * so membership is settled here and never read from the request (012 §8).
   */
  readonly authenticate: (
    request: FastifyRequest,
  ) => Promise<Principal | undefined>;
  /**
   * The one stack this deployment serves — local or durable, decided at boot.
   * The routes cannot tell which they got, which is the point: everything below
   * reads the store rather than a map of runs this process happens to remember.
   */
  readonly stack: ControlPlaneStack;
}

/**
 * An event's family, from its name. An unrecognised name falls to `other` and
 * is shown raw rather than dropped: silently discarding telemetry is worse.
 */
function eventKind(name: string): RunEventView["kind"] {
  const family = name.split(".")[1];
  switch (family) {
    case "run":
      return "run";
    case "node":
      return "node";
    case "policy":
      return "policy";
    case "approval":
      return "approval";
    case "effect":
      return "effect";
    default:
      return "other";
  }
}

interface RunEventView {
  readonly seq: number;
  readonly at: string;
  readonly kind: "run" | "node" | "policy" | "approval" | "effect" | "other";
  readonly name: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export function registerRunRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions,
): void {
  const { stack } = options;

  app.post("/v1/workflows/compile", async (request, reply) => {
    // Authenticated like every sibling route. Compiling reads and writes no
    // run state, which is why this was overlooked — but it is unmetered work
    // on a control plane, and one endpoint that behaves differently from the
    // rest is the one nobody thinks about.
    if ((await options.authenticate(request)) === undefined) {
      return reply.code(401).send({ status: "unauthorized" });
    }

    const body = (request.body ?? {}) as StartBody;
    const outcome = compileToArtifact(body.workflow);
    if (!outcome.ok) {
      return reply.code(422).send({
        status: "invalid",
        code: "WORKFLOW_COMPILE_FAILED",
        diagnostics: outcome.diagnostics,
      });
    }
    return reply.send({
      status: "compiled",
      workflowId: outcome.artifact.workflowId,
      fingerprint: outcome.artifact.fingerprint,
      publicSurface: {
        approvalGates: outcome.artifact.ir.nodes
          .filter((node) => node.kind === "approval")
          .map((node) => node.id),
        declaredEffects: outcome.artifact.ir.sideEffects,
        requiredCapabilities: outcome.artifact.ir.grantedCapabilities,
        roles: Object.keys(outcome.artifact.ir.roles).sort(),
      },
    });
  });

  app.post("/v1/runs", async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === undefined)
      return reply.code(401).send({ status: "unauthorized" });

    const body = (request.body ?? {}) as StartBody;
    const outcome = compileToArtifact(body.workflow);
    if (!outcome.ok) {
      return reply.code(422).send({
        status: "invalid",
        code: "WORKFLOW_COMPILE_FAILED",
        diagnostics: outcome.diagnostics,
      });
    }

    /**
     * The run is walked inline, on this request. 006 §10.1 has the control
     * plane persist and enqueue instead, and it should — but `Runtime.start`
     * walks, and there is no "create and park" for the API to call. Doing it
     * properly is a runtime change, not a routing one; what durability needs
     * is already true either way, because the record and the three ledgers are
     * written to the store as the walk proceeds.
     */
    const run = await stack.runtime.start({
      artifact: outcome.artifact,
      capabilities: body.capabilities ?? [],
      changedPaths: body.changedPaths ?? [],
      // Absent stays absent: an omitted payload must not become an empty one,
      // or a node reading it would proceed on data nobody sent.
      ...(body.payload === undefined ? {} : { payload: body.payload }),
    });

    return reply.code(201).send(run);
  });

  app.get<{ Querystring: { status?: string } }>(
    "/v1/runs",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      const { status } = request.query;
      if (status !== undefined && !RUN_STATUSES.has(status)) {
        // Refused rather than ignored. A misspelt status that quietly listed
        // everything would show an operator runs they asked to exclude.
        return reply.code(422).send({
          status: "invalid",
          code: "RUN_STATUS_UNKNOWN",
          message: `status must be one of ${[...RUN_STATUSES].join(", ")}.`,
        });
      }

      // From the store, most recent first — an operator is looking for what
      // just happened. Read from the store rather than from a map of runs this
      // process started, because after a restart that map is empty while every
      // one of those runs is still in Postgres.
      const runs = await stack.runs.list(
        status === undefined ? {} : { status: status as RunStatus },
      );
      return reply.send({ runs });
    },
  );

  /**
   * The operator inbox. Scoped by the port to gates this principal may decide,
   * so widening the query cannot widen who sees what.
   */
  app.get("/v1/approvals", async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === undefined)
      return reply.code(401).send({ status: "unauthorized" });

    const pending = await stack.approvals.listPendingFor(
      principal.subject,
      principal.roles,
    );
    // Closest to expiry first: an expired gate times out, it is not a slow yes.
    return reply.send({
      pending: [...pending].sort((left, right) =>
        left.expiresAt.localeCompare(right.expiresAt),
      ),
    });
  });

  app.get<{ Params: { runId: string } }>(
    "/v1/runs/:runId",
    async (request, reply) => {
      // A run record names the effects that actually fired. Its two sibling
      // routes check; this one did not, so the whole record was readable
      // unauthenticated. Checked before the lookup, so an anonymous caller
      // cannot tell a missing run from one they may not see.
      if ((await options.authenticate(request)) === undefined) {
        return reply.code(401).send({ status: "unauthorized" });
      }

      const run = await stack.runtime.loadRun(request.params.runId);
      if (run === undefined)
        return reply.code(404).send({ status: "not_found" });
      return reply.send(run);
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/v1/runs/:runId/approvals",
    async (request, reply) => {
      // Authenticated because the reply names who decided each gate.
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      if ((await stack.runtime.loadRun(request.params.runId)) === undefined)
        return reply.code(404).send({ status: "not_found" });
      return reply.send({
        pending: await stack.approvals.getPending(request.params.runId),
        approvals: await stack.approvals.listByRun(request.params.runId),
      });
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/v1/runs/:runId/events",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      if ((await stack.runtime.loadRun(request.params.runId)) === undefined)
        return reply.code(404).send({ status: "not_found" });

      // The runtime's own telemetry, filtered to one run: a second, derived
      // timeline could disagree with the trace. Attributes were redacted when
      // the span was recorded, which is what makes them safe to serve.
      //
      // Only what *this* process recorded. A run started before a restart is
      // readable — its record and its gates are durable — but its events were
      // never durable, and 012 §4.3's stream is what will change that.
      const events: RunEventView[] = stack
        .timeline()
        .filter((entry) => entry.attributes.runId === request.params.runId)
        .map((entry) => ({
          seq: entry.seq,
          at: entry.at,
          kind: eventKind(entry.name),
          name: entry.name,
          attributes: entry.attributes,
        }));
      return reply.send({ events });
    },
  );

  app.post<{ Params: { runId: string; approvalId: string } }>(
    "/v1/runs/:runId/approvals/:approvalId/decision",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      if (principal === undefined)
        return reply.code(401).send({ status: "unauthorized" });

      const body = (request.body ?? {}) as DecisionBody;

      const decision = toDecision(body);
      if (decision === undefined) {
        return reply.code(422).send({
          status: "invalid",
          code: "DECISION_INVALID",
          message: "decision must be approve, reject, edit or timeout.",
        });
      }

      /**
       * Authority, checked here because the runtime cannot: it is handed a
       * principal and has no directory to ask whether that principal is one of
       * the gate's approvers (006 §6.4 step 6). Without this the inbox was
       * merely a filtered view — anyone authenticated could decide any gate by
       * naming its id, which is not a boundary.
       */
      const approval = await stack.approvals.get(request.params.approvalId);
      if (approval !== undefined && !mayDecide(principal, approval.approvers)) {
        return reply.code(403).send({
          status: "forbidden",
          code: "DECISION_FORBIDDEN",
          message: `This gate is decided by ${approval.approvers.join(", ")}.`,
        });
      }

      try {
        const run = await stack.runtime.decide(
          request.params.approvalId,
          decision,
          principal.subject,
        );
        return reply.send(run);
      } catch (error) {
        return reply.code(409).send({
          status: "conflict",
          code: "DECISION_REFUSED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
