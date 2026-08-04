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
    nodes: z.array(IrNodeSchema).min(2),
    edges: z.array(IrEdgeSchema),
  })
  .strict();

export const WorkflowSourceSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    nodes: z.array(IrNodeSchema).min(2),
    edges: z.array(IrEdgeSchema),
  })
  .strict();

export type IrNode = z.infer<typeof IrNodeSchema>;
export type IrEdge = z.infer<typeof IrEdgeSchema>;
export type ForgeIr = z.infer<typeof ForgeIrSchema>;
export type WorkflowSource = z.infer<typeof WorkflowSourceSchema>;
