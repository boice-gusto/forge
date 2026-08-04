/**
 * Transport and worker scheduling (006 §6.2, ADR-004). Not the workflow
 * engine: the queue moves work between processes and nothing more. A vendor
 * job object must never appear above this port.
 */
export type ForgeJob =
  | {
      readonly type: "workflow.execute";
      readonly runId: string;
      readonly workflowVersionId: string;
      readonly attempt: number;
    }
  | {
      readonly type: "workflow.resume";
      readonly runId: string;
      readonly approvalId: string;
      readonly attempt: number;
    }
  | { readonly type: "workflow.cancel"; readonly runId: string };

/** Stable per intended operation, so at-least-once delivery is safe. */
export function operationKey(job: ForgeJob): string {
  if (job.type === "workflow.cancel") return `cancel:${job.runId}`;
  if (job.type === "workflow.resume")
    return `resume:${job.runId}:${job.approvalId}`;
  return `execute:${job.runId}:${job.attempt}`;
}

export interface QueuePort {
  enqueue(job: ForgeJob): Promise<string>;
  /** Delivers each distinct operation at most once to the handler. */
  subscribe(handler: (job: ForgeJob) => Promise<void>): Promise<void>;
  depth(): Promise<number>;
  health(): Promise<{ readonly available: boolean }>;
}
