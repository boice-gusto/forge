import {
  compileToArtifact,
  createLocalStack,
  type LocalStack,
} from "@forge/composition";
import type { PanelDefinition, Vote } from "@forge/panel";
import type { PolicyRule } from "@forge/policy-memory";
import type { ApprovalDecision, JsonValue } from "@forge/ports";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { mayDecide, type Principal } from "./identity.js";

/**
 * Control-plane routes.
 *
 * The API is the boundary that establishes who is acting. A decision's
 * principal is taken from the authenticated caller, never from the request
 * body — a body field is not an identity claim (006 §2).
 */

interface StartBody {
  readonly workflow?: unknown;
  readonly capabilities?: readonly string[];
  readonly policy?: {
    readonly rules?: readonly PolicyRule[];
    readonly grants?: readonly string[];
  };
  readonly panel?: PanelDefinition;
  readonly review?: { readonly votes?: Readonly<Record<string, Vote>> };
  /** Which arm each branch takes, keyed by node id. */
  readonly branch?: Readonly<Record<string, string>>;
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

export interface RunRoutesOptions {
  /** Sandbox profiles this deployment can provision. */
  readonly sandboxProfiles?: readonly string[];
  /**
   * Resolves the acting principal — subject *and* roles — from the request, at
   * the trusted boundary. A rule's `approvers` names roles rather than people,
   * so membership is settled here and never read from the request (012 §8).
   */
  readonly authenticate: (
    request: FastifyRequest,
  ) => Promise<Principal | undefined>;
  /** Overridable so tests and the local stack share one wiring. */
  readonly stack?: LocalStack;
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

/**
 * A stack of this run's own, because it brought its own policy. Policy comes
 * from the request only because there is no policy store yet; when one exists
 * this resolves from the company package, not the caller.
 *
 * Optional fields are spread only when present, so an absent one keeps the
 * stack's own default rather than overwriting it with `undefined`.
 */
function stackFor(
  body: StartBody,
  shared: LocalStack,
  sandboxProfiles: readonly string[] | undefined,
): LocalStack {
  return createLocalStack({
    rules: body.policy?.rules ?? [],
    grants: body.policy?.grants ?? [],
    environment: "production",
    ...(sandboxProfiles === undefined ? {} : { sandboxProfiles }),
    // One id source across every stack. Without it each per-policy stack mints
    // `run_1`, and the second run displaces the first in the run index.
    ids: shared.ids,
    ...(body.panel === undefined ? {} : { panel: body.panel }),
    ...(body.review?.votes === undefined
      ? {}
      : { votesFor: () => body.review?.votes ?? {} }),
    ...(body.branch === undefined
      ? {}
      : { branchFor: (nodeId: string) => body.branch?.[nodeId] }),
  });
}

export function registerRunRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions,
): LocalStack {
  /**
   * Every run, in the order accepted, and the stack that owns it. A run with
   * its own policy gets its own stack, so there is no single runtime to ask.
   */
  const stacks = new Map<string, LocalStack>();
  const shared =
    options.stack ??
    createLocalStack(
      options.sandboxProfiles === undefined
        ? {}
        : { sandboxProfiles: options.sandboxProfiles },
    );

  /** Each approval store exactly once, however many runs share it. */
  const stores = (): readonly LocalStack[] => [
    ...new Set<LocalStack>([shared, ...stacks.values()]),
  ];

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

    const stack =
      body.policy === undefined
        ? shared
        : stackFor(body, shared, options.sandboxProfiles);

    const run = await stack.runtime.start({
      artifact: outcome.artifact,
      capabilities: body.capabilities ?? [],
      changedPaths: body.changedPaths ?? [],
      // Absent stays absent: an omitted payload must not become an empty one,
      // or a node reading it would proceed on data nobody sent.
      ...(body.payload === undefined ? {} : { payload: body.payload }),
    });
    stacks.set(run.runId, stack);

    return reply.code(201).send(run);
  });

  app.get("/v1/runs", async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === undefined)
      return reply.code(401).send({ status: "unauthorized" });

    // Most recent first: an operator is looking for what just happened.
    const runs = [...stacks]
      .reverse()
      .map(([runId, stack]) => stack.runtime.getRun(runId))
      .filter((run) => run !== undefined);
    return reply.send({ runs });
  });

  /**
   * The operator inbox. Scoped by the port to gates this principal may decide,
   * so widening the query cannot widen who sees what.
   */
  app.get("/v1/approvals", async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === undefined)
      return reply.code(401).send({ status: "unauthorized" });

    const perStore = await Promise.all(
      stores().map((stack) =>
        stack.approvals.listPendingFor(principal.subject, principal.roles),
      ),
    );
    // Closest to expiry first: an expired gate times out, it is not a slow yes.
    const pending = perStore
      .flat()
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt));
    return reply.send({ pending });
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

      const stack = stacks.get(request.params.runId) ?? shared;
      const run = stack.runtime.getRun(request.params.runId);
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

      const stack = stacks.get(request.params.runId) ?? shared;
      if (stack.runtime.getRun(request.params.runId) === undefined)
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

      const stack = stacks.get(request.params.runId) ?? shared;
      if (stack.runtime.getRun(request.params.runId) === undefined)
        return reply.code(404).send({ status: "not_found" });

      // The runtime's own telemetry, filtered to one run: a second, derived
      // timeline could disagree with the trace. Attributes were redacted when
      // the span was recorded, which is what makes them safe to serve.
      const events: RunEventView[] = stack.observability.timeline
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

      const stack = stacks.get(request.params.runId) ?? shared;
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

  return shared;
}
