import {
  RoleSchema,
  WorkflowEdgeSchema,
  WorkflowNodeSchema,
} from "@forge/types";
import { z } from "zod";

/**
 * Forge IR.
 *
 * The node and edge taxonomy is the shape companies author, so it lives in
 * `@forge/types` where a public authoring package can reach it. What is
 * internal is the compiler's own product: `ForgeIr` is a *compiled* workflow —
 * validated, ordered, and about to be fingerprinted — and nothing outside the
 * application layer constructs one.
 *
 * The IR names are kept as the internal vocabulary so `@forge/compiler`,
 * `@forge/runtime` and the engine adapters keep reading in IR terms.
 */

export {
  type RetryPolicy,
  type Role,
  RoleSchema,
  type WorkflowSource,
  WorkflowSourceSchema,
} from "@forge/types";

export const IrNodeSchema = WorkflowNodeSchema;
export const IrEdgeSchema = WorkflowEdgeSchema;

export type IrNode = z.infer<typeof IrNodeSchema>;
export type IrEdge = z.infer<typeof IrEdgeSchema>;

export const ForgeIrSchema = z
  .object({
    workflowId: z.string().min(1),
    workflowVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    // Every effect the workflow is permitted to cause, declared up front.
    sideEffects: z.array(z.string().min(1)).default([]),
    roles: z.record(z.string().min(1), RoleSchema).default({}),
    /** The capabilities policy grants, so closure is checkable statically. */
    grantedCapabilities: z.array(z.string().min(1)).default([]),
    nodes: z.array(IrNodeSchema).min(2),
    edges: z.array(IrEdgeSchema),
  })
  .strict();

export type ForgeIr = z.infer<typeof ForgeIrSchema>;
