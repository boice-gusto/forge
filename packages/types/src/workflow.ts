import { z } from "zod";

/**
 * The workflow authoring shape (004 §"Package map", 007 §3, §5).
 *
 * Public because companies author it: `@forge/manifest` needs it to type
 * `defineWorkflow`, and a public package may import public packages only — the
 * alternative was a second definition of a workflow, which is exactly the drift
 * the compiler exists to prevent.
 *
 * Authors declare the graph; only the compiler decides whether it may run.
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

/**
 * Where a node gets its input: the value another node produced, optionally
 * narrowed to a property path inside it.
 *
 * Data flow is **declared**, not inferred from the edge list. An edge says what
 * may run next; it does not say what a node may read, and conflating the two
 * would make every predecessor's output implicitly visible to every successor.
 * Declaring it means the compiler can check the reference and the runtime can
 * refuse an undeclared read — a node with no `reads` is simply not part of the
 * data plane.
 */
const DataRefSchema = z
  .object({
    node: NodeIdSchema,
    /** Property path into that node's value. Empty means the whole value. */
    path: z.array(z.string().min(1)).default([]),
  })
  .strict();

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
      /** The value that becomes the run's result. */
      reads: DataRefSchema.optional(),
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
      // Verdict arms (007 §10): each must be carried by an outgoing edge
      // labelled with it, and vice versa. Omitting the field keeps the
      // fail-closed default — only `pass` continues.
      verdicts: z.array(JudgeVerdictSchema).min(1).optional(),
      // Votes keyed by role, read from run state. The panel still resolves the
      // verdict: run data supplies the ballots, never the outcome.
      reads: DataRefSchema.optional(),
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
      /** The value handed to the skill. Reading it never skips the gate. */
      reads: DataRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("approval"),
      gateSchemaRef: SchemaRefSchema,
      // The node ids this approval authorises, and no others — the compile-time
      // half of the runtime rule that a decision binds to one action.
      gates: z.array(NodeIdSchema).default([]),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("transform"),
      transformRef: z.string().min(1),
      /** What the transform is applied to. Without it, it computes nothing. */
      reads: DataRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("branch"),
      // Every outgoing edge must carry one of these, and every one of these
      // must be carried by an outgoing edge (007 §11 WF_UNTYPED_EDGE).
      conditionIds: z.array(z.string().min(1)).min(1),
      // A value that names the arm to take. Gate analysis is condition-
      // agnostic, so an arm chosen this way reaches nothing an arm chosen any
      // other way could not.
      reads: DataRefSchema.optional(),
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
 * group. Core owns the contract; the roster that fills it is a company concern.
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

export type DataRef = z.infer<typeof DataRefSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowSource = z.infer<typeof WorkflowSourceSchema>;

/**
 * The authoring view. A `.default()` makes a field required on the output type,
 * which would force an author to write `sideEffects: []` to say nothing:
 * `z.input` is the shape you may write, `WorkflowSource` what you get back.
 */
export type WorkflowSourceInput = z.input<typeof WorkflowSourceSchema>;
export type WorkflowNodeInput = z.input<typeof WorkflowNodeSchema>;
export type WorkflowEdgeInput = z.input<typeof WorkflowEdgeSchema>;
export type RoleInput = z.input<typeof RoleSchema>;
