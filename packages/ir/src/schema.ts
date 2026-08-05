import {
  RoleSchema,
  WorkflowEdgeSchema,
  WorkflowNodeSchema,
} from "@forge/types";
import { z } from "zod";

/**
 * Forge IR: the compiler's own product. `ForgeIr` is a *compiled* workflow —
 * validated, ordered, and about to be fingerprinted.
 *
 * The node and edge taxonomy is the shape companies author, so it lives in
 * `@forge/types` where a public authoring package can reach it, and this
 * package uses those schemas directly. It used to re-export them as `IrNode`
 * and `IrEdge`; two names for one type is drift waiting to happen, so the
 * authored names are the only ones, and this package exports only what it
 * actually owns.
 */

export const ForgeIrSchema = z
  .object({
    workflowId: z.string().min(1),
    workflowVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    // Every effect the workflow is permitted to cause, declared up front.
    sideEffects: z.array(z.string().min(1)).default([]),
    roles: z.record(z.string().min(1), RoleSchema).default({}),
    /** The capabilities policy grants, so closure is checkable statically. */
    grantedCapabilities: z.array(z.string().min(1)).default([]),
    nodes: z.array(WorkflowNodeSchema).min(2),
    edges: z.array(WorkflowEdgeSchema),
  })
  .strict();

export type ForgeIr = z.infer<typeof ForgeIrSchema>;
