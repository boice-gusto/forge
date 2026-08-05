import {
  compileToArtifact,
  createLocalStack,
  type LocalStack,
} from "@forge/composition";
import type { PanelDefinition, Vote } from "@forge/panel";
import type { PolicyRule } from "@forge/policy-memory";
import type { ApprovalDecision } from "@forge/ports";
import type { FastifyInstance } from "fastify";

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
}

interface DecisionBody {
  readonly decision?: "approve" | "reject" | "edit" | "timeout";
  readonly reason?: string;
  readonly patch?: unknown;
}

/** Map the wire shape onto a decision, or nothing if it is unrecognised. */
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
  /** Resolves the acting principal from the request, at the trusted boundary. */
  readonly principalFor: (
    authorization: string | undefined,
  ) => string | undefined;
  /** Overridable so tests and the local stack share one wiring. */
  readonly stack?: LocalStack;
}

export function registerRunRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions,
): LocalStack {
  const stacks = new Map<string, LocalStack>();
  const shared = options.stack ?? createLocalStack();

  app.post("/v1/workflows/compile", async (request, reply) => {
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
    const principal = options.principalFor(request.headers.authorization);
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

    // Policy comes from the request only because there is no policy store yet.
    // When one exists this resolves from the company package, not the caller.
    const stack =
      body.policy === undefined
        ? shared
        : createLocalStack({
            rules: body.policy.rules ?? [],
            grants: body.policy.grants ?? [],
            environment: "production",
            ...(body.panel === undefined ? {} : { panel: body.panel }),
            ...(body.review?.votes === undefined
              ? {}
              : { votesFor: () => body.review?.votes ?? {} }),
            ...(body.branch === undefined
              ? {}
              : { branchFor: (nodeId: string) => body.branch?.[nodeId] }),
          });

    const run = await stack.runtime.start({
      artifact: outcome.artifact,
      capabilities: body.capabilities ?? [],
      changedPaths: body.changedPaths ?? [],
    });
    stacks.set(run.runId, stack);

    return reply.code(201).send(run);
  });

  app.get<{ Params: { runId: string } }>(
    "/v1/runs/:runId",
    async (request, reply) => {
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
      const stack = stacks.get(request.params.runId) ?? shared;
      if (stack.runtime.getRun(request.params.runId) === undefined)
        return reply.code(404).send({ status: "not_found" });
      return reply.send({
        pending: await stack.approvals.getPending(request.params.runId),
      });
    },
  );

  app.post<{ Params: { runId: string; approvalId: string } }>(
    "/v1/runs/:runId/approvals/:approvalId/decision",
    async (request, reply) => {
      const principal = options.principalFor(request.headers.authorization);
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

      try {
        const run = await stack.runtime.decide(
          request.params.approvalId,
          decision,
          principal,
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
