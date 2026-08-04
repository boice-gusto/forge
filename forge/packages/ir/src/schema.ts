import { z } from "zod";

const NodeIdSchema = z.string().min(1);
const SchemaRefSchema = z.string().min(1);

export const IrNodeSchema = z.discriminatedUnion("kind", [
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
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("judge"),
      judgeRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      id: NodeIdSchema,
      kind: z.literal("tool"),
      skillRef: z.string().min(1),
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
]);

export const IrEdgeSchema = z
  .object({
    from: NodeIdSchema,
    to: NodeIdSchema,
    conditionId: z.string().min(1).optional(),
  })
  .strict();

export const ForgeIrSchema = z
  .object({
    workflowId: z.string().min(1),
    workflowVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    // Every effect the workflow is permitted to cause, declared up front.
    sideEffects: z.array(z.string().min(1)).default([]),
    nodes: z.array(IrNodeSchema).min(2),
    edges: z.array(IrEdgeSchema),
  })
  .strict();

export const WorkflowSourceSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sideEffects: z.array(z.string().min(1)).default([]),
    nodes: z.array(IrNodeSchema).min(2),
    edges: z.array(IrEdgeSchema),
  })
  .strict();

export type IrNode = z.infer<typeof IrNodeSchema>;
export type IrEdge = z.infer<typeof IrEdgeSchema>;
export type ForgeIr = z.infer<typeof ForgeIrSchema>;
export type WorkflowSource = z.infer<typeof WorkflowSourceSchema>;
