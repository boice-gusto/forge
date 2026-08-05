import { z } from "zod";

/**
 * The workflow authoring shape (004 §"Package map", 007 §3, §5).
 *
 * This lives in a public package because companies author it. `@forge/manifest`
 * needs it to type `defineWorkflow`, and a public package may import public
 * packages only — so the alternative was a second definition of a workflow
 * inside the manifest package, which is exactly the drift the compiler exists
 * to prevent.
 *
 * What stays internal is what the compiler *produces*: `ForgeIr` in
 * `@forge/ir`, built on this taxonomy, plus every analysis over it. Authors
 * declare the graph; only the compiler decides whether it may run.
 */

const NodeIdSchema = z.string().min(1);
const SchemaRefSchema = z.string().min(1);

const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    backoff: z.enum(["fixed", "exponential"]).default("fixed"),
    retryableErrors: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** What a judge can conclude (007 §10). Mirrors `JudgeVerdict` in ports. */
const JudgeVerdictSchema = z.enum(["pass", "fail", "review"]);

export const WorkflowNodeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("input"),
      schemaRef: SchemaRefSchema,
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("output"),
      schemaRef: SchemaRefSchema,
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("agent"),
      promptRef: z.string().min(1),
      role: z.string().min(1).optional(),
      retry: RetryPolicySchema.optional(),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("judge"),
      judgeRef: z.string().min(1),
      // Verdict arms (007 §10). Each declared verdict must be carried by an
      // outgoing edge labelled with it, and every outgoing edge must carry one
      // of them. Omitting the field keeps the fail-closed default: only `pass`
      // continues. A verdict with no arm stops the run either way — it never
      // falls through onto the pass path.
      verdicts: z.array(JudgeVerdictSchema).min(1).optional(),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("tool"),
      skillRef: z.string().min(1),
      role: z.string().min(1).optional(),
      retry: RetryPolicySchema.optional(),
      // Naming an effect makes this node a side-effect carrier, which the
      // compiler then requires an approval gate for.
      effect: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("approval"),
      gateSchemaRef: SchemaRefSchema,
      // The node ids this approval authorises. An approval never authorises
      // an effect it does not name, mirroring the runtime rule that a
      // decision binds to a specific action.
      gates: z.array(NodeIdSchema).default([]),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("transform"),
      transformRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("branch"),
      // Every outgoing edge must carry one of these, and every one of these
      // must be carried by an outgoing edge (007 §11 WF_UNTYPED_EDGE).
      conditionIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("parallel"),
      branches: z.array(NodeIdSchema).min(2),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("policy_check"),
      // Asserted against the policy closure before a privileged step.
      capability: z.string().min(1),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("sandbox"),
      profile: z.string().min(1),
    })
    .strict(),
]);

/**
 * A role is a versioned asset with up to three faces (ADR-009): it produces
 * artifacts, it reviews through a lens, and it may map to a human approver
 * group. Core owns this contract and nothing more — the roster that fills it
 * is a company concern and lives in a company package.
 */
export const RoleSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    capabilities: z
      .object({
        requires: z.array(z.string().min(1)).default([]),
        forbids: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ requires: [], forbids: [] }),
    review: z
      .object({
        weight: z.number().positive().default(1),
        blocking: z.boolean().default(false),
      })
      .strict()
      .optional(),
    /** Specialty roles join a panel only when their predicate matches. */
    summon: z
      .object({ anyPathMatches: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const WorkflowEdgeSchema = z
  .object({
    from: NodeIdSchema,
    to: NodeIdSchema,
    conditionId: z.string().min(1).optional(),
  })
  .strict();

export const WorkflowSourceSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sideEffects: z.array(z.string().min(1)).default([]),
    roles: z.record(z.string().min(1), RoleSchema).default({}),
    /** The capabilities policy grants, so closure is checkable statically. */
    grantedCapabilities: z.array(z.string().min(1)).default([]),
    nodes: z.array(WorkflowNodeSchema).min(2),
    edges: z.array(WorkflowEdgeSchema),
  })
  .strict();

export type Role = z.infer<typeof RoleSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowSource = z.infer<typeof WorkflowSourceSchema>;

/**
 * The authoring view. A schema `.default()` makes a field required on the
 * output type, which forces an author to write `sideEffects: []` to say
 * nothing. `z.input` is the shape you may write; `WorkflowSource` is the shape
 * you get back once the defaults have been applied.
 */
export type WorkflowSourceInput = z.input<typeof WorkflowSourceSchema>;
export type WorkflowNodeInput = z.input<typeof WorkflowNodeSchema>;
export type WorkflowEdgeInput = z.input<typeof WorkflowEdgeSchema>;
export type RoleInput = z.input<typeof RoleSchema>;
