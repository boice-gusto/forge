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
  /** Work waiting for a subscriber. Work already handled is not waiting. */
  depth(): Promise<number>;
  health(): Promise<{ readonly available: boolean }>;
  /**
   * Releases the transport. A queue with a live connection keeps a process
   * alive after its work is done, so shutting one down has to be expressible
   * at the port rather than only on the adapter that happens to need it.
   */
  close(): Promise<void>;
}
