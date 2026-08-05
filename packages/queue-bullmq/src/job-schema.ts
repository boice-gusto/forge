import type { ForgeJob } from "@forge/ports";
import { z } from "zod";

/**
 * The transport is the only place a `ForgeJob` arrives as untrusted bytes, so
 * it is the only place the DTO needs validating (ADR-004). Everything above
 * this port receives a `ForgeJob` that has already been parsed, which is why
 * `@forge/ports` stays dependency-free.
 */
const jobSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workflow.execute"),
    runId: z.string().min(1),
    workflowVersionId: z.string().min(1),
    attempt: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("workflow.resume"),
    runId: z.string().min(1),
    approvalId: z.string().min(1),
    attempt: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("workflow.cancel"),
    runId: z.string().min(1),
  }),
]);

/**
 * Fails closed: a payload this does not recognise is not coerced into the
 * nearest job it resembles. Acting on a half-understood instruction is how a
 * cancel becomes an execute.
 */
export function parseForgeJob(payload: unknown): ForgeJob {
  const parsed = jobSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `FORGE_QUEUE_INVALID_JOB: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
